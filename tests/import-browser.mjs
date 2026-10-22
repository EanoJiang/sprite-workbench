import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';
import builtInExample from './built-in-example.mjs';
import JSZip from 'jszip';
import { openPreviewExport } from './preview-export-controls.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.FRAMECRAFT_URL || 'http://127.0.0.1:8765';
const artifacts = path.join(root, 'test-results');
const temp = path.join(root, '.tmp', `import-browser-${Date.now()}`);
await Promise.all([fs.mkdir(artifacts, { recursive: true }), fs.mkdir(temp, { recursive: true })]);
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
const report = { started: new Date().toISOString(), url: base, checks: [], pageErrors: [], consoleErrors: [], networkFailures: [], artifacts: [] };
const record = async (name, operation) => {
  try {
    const detail = await operation();
    report.checks.push({ name, passed: true, detail });
    console.log(`PASS ${name}: ${JSON.stringify(detail || {})}`);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error?.stack || String(error) });
    console.error(`FAIL ${name}: ${error?.stack || error}`);
    throw error;
  }
};
const context = await chromium.launchPersistentContext(path.join(temp, 'user-data'), {
  ...browserLaunchOptions(), headless: true,
  viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
  args: [`--disk-cache-dir=${path.join(temp, 'disk-cache')}`, '--disable-crash-reporter', '--disable-features=msEdgeSidebarV2', '--no-first-run'],
  env: process.env,
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(25000);
page.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
page.on('response', response => { if (response.status() >= 400) report.networkFailures.push({ url: response.url(), status: response.status() }); });
page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') report.networkFailures.push({ url: request.url(), failure: request.failure()?.errorText }); });

// Keep clipboard-isolation coverage independent of the real XSXB service and its projects.
let tunerStarts = 0;
await page.route('**/api/tuner/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ installed: false, running: false }) }));
await page.route('**/api/tuner/start', route => {
  tunerStarts++;
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ installed: false, running: false, error: 'QA: editor startup intercepted' }) });
});

const trigger = () => page.locator('#media-import-trigger');
const namingDialog = () => page.locator('dialog.animation-name-dialog');
const sourceName = () => page.locator('.source-header-file dd').innerText();
const frameNames = () => page.locator('#step-3 .frame-meta span').allTextContents();
const shot = async (filename, locator = page.locator('.hero')) => {
  const filenamePath = path.join(artifacts, filename);
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  // Capture enough padding to show the full drag outline outside the hero box.
  await page.screenshot({ path: filenamePath, animations: 'disabled' });
  report.artifacts.push(filenamePath);
};
const dispatch = async (selector, kind, files = [], text = '') => page.evaluate(({ selector, kind, files, text }) => {
  const target = document.querySelector(selector);
  if (!target) throw new Error(`Missing event target: ${selector}`);
  const transfer = new DataTransfer();
  for (const file of files) {
    const binary = atob(file.base64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    transfer.items.add(new File([bytes], file.name, { type: file.type }));
  }
  if (text) transfer.setData('text/plain', text);
  const event = kind === 'paste'
    ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
    : new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer });
  target.dispatchEvent(event);
  return { defaultPrevented: event.defaultPrevented, types: [...transfer.types] };
}, { selector, kind, files, text });
const waitSource = async (name, width, height, awaitingName = false) => {
  await expect(page.locator('.file-details strong')).toHaveText(name);
  if (awaitingName) await expect(trigger()).toBeDisabled();
  else await expect(trigger()).toBeEnabled();
  await expect(page.locator('.file-details > span')).toContainText(`${width} × ${height}`);
  await expect(page.locator('#step-3 .frame-card')).toHaveCount(0);
};
const blur = () => page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await expect(page.locator('#step-3 .frame-card')).toHaveCount(builtInExample.frames.length, { timeout: 90000 });
  await expect(trigger()).toBeVisible();
  await expect(namingDialog()).toHaveCount(0);

  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const painter = canvas.getContext('2d'); painter.fillStyle = '#32cd32'; painter.fillRect(0, 0, 96, 64);
    painter.fillStyle = '#da443e'; painter.fillRect(30, 16, 24, 40);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const image = name => ({ name, type: 'image/png', base64: png });
  const fixture = path.join(artifacts, 'import-video-fixture.mp4');
  const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x32CD32:s=160x96:r=12:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', fixture], { encoding: 'utf8', env: process.env });
  if (ffmpeg.status !== 0) throw new Error(`Video fixture failed: ${ffmpeg.stderr || ffmpeg.error}`);
  const video = { name: 'button-dropped-video.mp4', type: 'video/mp4', base64: (await fs.readFile(fixture)).toString('base64') };
  report.artifacts.push(fixture);

  await record('import button retains native file chooser', async () => {
    const wait = page.waitForEvent('filechooser'); await trigger().click();
    const chooser = await wait;
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles([]);
    return { input: await chooser.element().getAttribute('id') };
  });

  await record('button accepts an image drop with local hover feedback', async () => {
    const hover = await dispatch('#media-import-trigger', 'dragover', [image('button-dropped-image.png')]);
    expect(hover.defaultPrevented).toBe(true);
    await shot('import-hero-drag-desktop.png');
    const result = await dispatch('#media-import-trigger', 'drop', [image('button-dropped-image.png')]);
    expect(result.defaultPrevented).toBe(true);
    await waitSource('button-dropped-image.png', 96, 64, true);
    await expect(page.locator('.drop-overlay')).toHaveCount(0);
    await expect(namingDialog()).toBeVisible();
    await namingDialog().getByRole('button', { name: '确认名称', exact: true }).click();
    return { source: await sourceName(), width: 96, height: 64 };
  });

  const clipName = '骑士奔跑片段';
  await record('video drop opens a focused naming dialog and applies the Chinese clip name', async () => {
    await dispatch('#media-import-trigger', 'dragover', [video]);
    await dispatch('#media-import-trigger', 'drop', [video]);
    await waitSource(video.name, 160, 96, true);
    await expect(page.locator('.media-stage video')).toHaveJSProperty('videoWidth', 160);
    const dialog = namingDialog();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveJSProperty('open', true);
    const input = dialog.getByRole('textbox', { name: /^(动画片段名|项目名)$/ });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('button-dropped-video');
    const confirm = dialog.getByRole('button', { name: '确认名称', exact: true });
    await input.fill('   ');
    await expect(confirm).toBeDisabled();
    await input.fill(`  ${clipName}  `);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger()).toBeEnabled();
    await expect(page.locator('#animation-name')).toHaveValue(clipName);
    await expect(page.getByRole('textbox', { name: '导出文件名', exact: true })).toHaveCount(0);
    return { source: await sourceName(), clipName, duration: await page.locator('.media-stage video').evaluate(element => element.duration) };
  });

  await record('video clip name becomes both ZIP download names and animation metadata', async () => {
    await page.getByRole('spinbutton', { name: '源素材帧率', exact: true }).fill('12');
    await page.getByRole('spinbutton', { name: '源素材帧率', exact: true }).blur();
    await page.locator('#start-frame').fill('1');
    await page.locator('#end-frame').fill('1');
    await page.locator('#stride').fill('1');
    await page.locator('#target-height').fill('64');
    await page.locator('.cleanup-controls input[role="switch"]').first().uncheck();
    await page.getByRole('button', { name: /^开始抽帧/ }).click();
    await expect(page.locator('#step-3 .frame-card')).toHaveCount(1, { timeout: 90000 });
    const downloads = [];
    for (const [format, mode] of [
      ['sequence', 'frames'],
      ['sheet', 'sprite_sheet'],
    ]) {
      const button = await openPreviewExport(page, 'original', mode);
      const waiting = page.waitForEvent('download', { timeout: 90000 });
      await button.click();
      const item = await waiting;
      expect(item.suggestedFilename()).toBe(`${clipName}.zip`);
      const output = path.join(artifacts, `import-named-${format}.zip`);
      await item.saveAs(output);
      report.artifacts.push(output);
      const zip = await JSZip.loadAsync(await fs.readFile(output));
      const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
      expect(manifest.name).toBe(clipName);
      downloads.push({ format, filename: item.suggestedFilename(), manifestName: manifest.name });
    }
    return downloads;
  });

  await record('pasted video opens naming and can explicitly keep the original filename', async () => {
    await blur();
    const pasted = { ...video, name: 'pasted-video.mp4' };
    const result = await dispatch('body', 'paste', [pasted]);
    expect(result.defaultPrevented).toBe(true);
    await waitSource(pasted.name, 160, 96, true);
    const dialog = namingDialog();
    const input = dialog.getByRole('textbox', { name: /^(动画片段名|项目名)$/ });
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('pasted-video');
    await input.fill('不采用的临时名称');
    await dialog.getByRole('button', { name: '使用原文件名', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger()).toBeEnabled();
    await expect(page.locator('#animation-name')).toHaveValue('pasted-video');
    return { ...result, source: await sourceName(), clipName: await page.locator('#animation-name').inputValue() };
  });

  await record('focused import button accepts pasted PNG', async () => {
    await trigger().focus();
    const result = await dispatch('#media-import-trigger', 'paste', [image('button-pasted-image.png')]);
    expect(result.defaultPrevented).toBe(true);
    await waitSource('button-pasted-image.png', 96, 64);
    await expect(namingDialog()).toHaveCount(0);
    return result;
  });

  await record('workbench background accepts pasted PNG', async () => {
    await blur();
    const result = await dispatch('body', 'paste', [image('background-pasted-image.png')]);
    expect(result.defaultPrevented).toBe(true);
    await waitSource('background-pasted-image.png', 96, 64);
    return result;
  });

  await record('multiple pasted images become naturally sorted selected frames', async () => {
    await blur();
    const result = await dispatch('body', 'paste', [image('frame_10.png'), image('frame_2.png')]);
    expect(result.defaultPrevented).toBe(true);
    await expect(page.locator('#step-3 .frame-card')).toHaveCount(2);
    await expect(page.locator('#step-3 .frame-card input:checked')).toHaveCount(2);
    await expect(trigger()).toBeEnabled();
    expect(await frameNames()).toEqual(['frame_2.png', 'frame_10.png']);
    return { names: await frameNames(), selected: 2 };
  });

  await record('unsupported file leaves current source and frames intact', async () => {
    const priorSource = await sourceName(); const priorFrames = await frameNames();
    const invalid = { name: 'unsupported.txt', type: 'text/plain', base64: Buffer.from('not media').toString('base64') };
    const result = await dispatch('#media-import-trigger', 'drop', [invalid]);
    expect(result.defaultPrevented).toBe(true);
    await expect(page.locator('.toast')).toBeVisible();
    await expect(page.locator('.toast')).toContainText(/视频|图片|支持|素材/);
    await expect(trigger()).toBeEnabled();
    expect(await sourceName()).toBe(priorSource); expect(await frameNames()).toEqual(priorFrames);
    return { priorSource, priorFrames, notice: await page.locator('.toast').innerText() };
  });

  await record('text and image pastes in editable controls remain native', async () => {
    const priorSource = await sourceName(); const priorFrames = await frameNames();
    const name = page.locator('#animation-name'); await name.fill('typing_test'); await name.focus();
    const textResult = await dispatch('#animation-name', 'paste', [], '普通粘贴文本');
    const fileResult = await dispatch('#animation-name', 'paste', [image('should-not-import.png')]);
    expect(textResult.defaultPrevented).toBe(false); expect(fileResult.defaultPrevented).toBe(false);
    await page.keyboard.insertText('_edited');
    await expect(name).toHaveValue('typing_test_edited');
    await page.evaluate(() => { const edit = document.createElement('div'); edit.id = 'qa-contenteditable'; edit.contentEditable = 'true'; document.body.append(edit); edit.focus(); });
    const editableResult = await dispatch('#qa-contenteditable', 'paste', [image('should-not-import-editable.png')]);
    expect(editableResult.defaultPrevented).toBe(false);
    await page.locator('#qa-contenteditable').evaluate(element => element.remove());
    expect(await sourceName()).toBe(priorSource); expect(await frameNames()).toEqual(priorFrames);
    return { textDefaultPrevented: textResult.defaultPrevented, inputImageDefaultPrevented: fileResult.defaultPrevented, editableDefaultPrevented: editableResult.defaultPrevented };
  });

  await record('dialogs ignore pasted media', async () => {
    const priorSource = await sourceName(); const priorFrames = await frameNames();
    await page.getByRole('button', { name: '使用指南' }).click();
    const result = await dispatch('[role="dialog"]', 'paste', [image('should-not-import-dialog.png')]);
    expect(result.defaultPrevented).toBe(false);
    await page.getByRole('button', { name: '关闭使用指南' }).click();
    expect(await sourceName()).toBe(priorSource); expect(await frameNames()).toEqual(priorFrames);
    return result;
  });

  await record('non-file drag retains frame ordering interactions', async () => {
    const before = await frameNames();
    const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.setData('text/plain', 'qa-frame-order'); return data; });
    await page.locator('.sequence-frame').first().dispatchEvent('dragstart', { dataTransfer: transfer });
    await page.locator('.sequence-frame').last().dispatchEvent('dragover', { dataTransfer: transfer });
    await page.locator('.sequence-frame').last().dispatchEvent('drop', { dataTransfer: transfer });
    await page.locator('.sequence-frame').first().dispatchEvent('dragend', { dataTransfer: transfer });
    await transfer.dispose();
    expect(await frameNames()).toEqual([...before].reverse());
    const priorSource = await sourceName();
    const result = await dispatch('body', 'drop', [], 'text-only drag');
    expect(result.defaultPrevented).toBe(false);
    expect(await sourceName()).toBe(priorSource);
    await expect(page.locator('.drop-overlay')).toHaveCount(0);
    return { reordered: await frameNames(), textDropPrevented: result.defaultPrevented };
  });

  await record('XSXB tab leaves clipboard untouched and blocks file navigation without importing', async () => {
    const priorSource = await sourceName(); const priorFrames = await frameNames();
    await page.locator('#tab-tuner').click();
    await expect(page.locator('#tuner-panel')).toBeVisible();
    const paste = await dispatch('#tuner-panel', 'paste', [image('should-not-import-tuner.png')]);
    const drop = await dispatch('#tuner-panel', 'drop', [image('should-not-drop-tuner.png')]);
    expect(paste.defaultPrevented).toBe(false);
    // The outer shell blocks browser navigation for files, while the editor iframe
    // has its own document and never bubbles clipboard/drop events into this shell.
    expect(drop.defaultPrevented).toBe(true);
    expect(await sourceName()).toBe(priorSource); expect(await frameNames()).toEqual(priorFrames);
    await page.locator('#tab-workbench').click();
    await expect(trigger()).toBeEnabled();
    return { pasteDefaultPrevented: paste.defaultPrevented, dropDefaultPrevented: drop.defaultPrevented, realEditorStarted: false, interceptedStartCalls: tunerStarts };
  });

  await record('desktop and mobile import zone stays visible and usable', async () => {
    await shot('import-hero-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await trigger().scrollIntoViewIfNeeded();
    await expect(trigger()).toBeVisible();
    const box = await trigger().boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
    const result = await dispatch('#media-import-trigger', 'paste', [image('mobile-pasted-image.png')]);
    expect(result.defaultPrevented).toBe(true); await waitSource('mobile-pasted-image.png', 96, 64);
    await shot('import-hero-mobile.png');
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(horizontalOverflow).toBe(false);
    return { triggerWidth: box.width, viewportWidth: 390, horizontalOverflow };
  });

  await record('no runtime, console, or network failures', async () => {
    expect(report.pageErrors).toEqual([]); expect(report.consoleErrors).toEqual([]); expect(report.networkFailures).toEqual([]);
    return { pageErrors: 0, consoleErrors: 0, networkFailures: 0 };
  });
} finally {
  report.finished = new Date().toISOString();
  report.passed = report.checks.filter(check => check.passed).length;
  report.failed = report.checks.filter(check => !check.passed).length;
  const reportPath = path.join(artifacts, 'import-browser-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await context.close();
  console.log(`REPORT ${reportPath}: ${report.passed} passed, ${report.failed} failed`);
}
