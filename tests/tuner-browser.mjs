import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';
import builtInExample from './built-in-example.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oddFrameCount = Math.ceil(builtInExample.frames.length / 2);
const evenFrameCount = Math.floor(builtInExample.frames.length / 2);
const artifacts = path.join(root, 'test-results');
const temp = path.join(root, '.tmp', `tuner-browser-${Date.now()}`);
await fs.mkdir(temp, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
const base = process.env.FRAMECRAFT_URL || 'http://127.0.0.1:5173';
const report = { started: new Date().toISOString(), checks: [], consoleErrors: [], pageErrors: [], networkFailures: [], artifacts: [], transfers: [] };
const resources = [];
const tunerControlRequests = [];
const record = async (name, operation) => {
  try {
    const detail = await operation();
    report.checks.push({ name, passed: true, detail });
    console.log(`PASS ${name}: ${JSON.stringify(detail || {})}`);
    return detail;
  } catch (error) {
    report.checks.push({ name, passed: false, error: error?.stack || String(error) });
    console.error(`FAIL ${name}: ${error?.stack || error}`);
    throw error;
  }
};

const context = await chromium.launchPersistentContext(path.join(temp, 'user-data'), {
  ...browserLaunchOptions(),
  headless: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 },
  downloadsPath: path.join(artifacts, 'downloads'),
  args: [`--disk-cache-dir=${path.join(temp, 'disk-cache')}`, '--disable-crash-reporter', '--disable-features=msEdgeSidebarV2', '--no-first-run'],
  env: process.env,
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(25000);
page.on('console', event => { if (event.type() === 'error') report.consoleErrors.push(event.text()); });
page.on('pageerror', event => report.pageErrors.push(event.stack || event.message));
page.on('response', response => {
  const url = response.url();
  if (/\/(?:app\.js|lite\.js|style\.css|lite\.css)(?:\?|$)/.test(url)) resources.push({ url, status: response.status(), type: response.headers()['content-type'] });
  if (response.status() >= 400) report.networkFailures.push({ url, status: response.status() });
});
page.on('requestfailed', request => {
  const error = request.failure()?.errorText;
  if (error !== 'net::ERR_ABORTED') report.networkFailures.push({ url: request.url(), error });
});
page.on('dialog', dialog => dialog.accept());
page.on('request', request => {
  if (/\/api\/tuner\/(status|start)$/.test(new URL(request.url()).pathname)) tunerControlRequests.push({ url: request.url(), method: request.method() });
});

const workbenchTab = () => page.getByRole('tab', { name: /素材工作台|抽帧工作台|帧素材工作台/ });
const tunerTab = () => page.getByRole('tab', { name: /XSXB|帧调试/ });
const transferButton = () => page.getByRole('button', { name: '发送到 XSXB 调参', exact: true });
const visibleEditor = async () => {
  const iframe = page.locator('iframe').filter({ visible: true }).last();
  await expect(iframe).toBeVisible({ timeout: 60000 });
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('Editor iframe has no browsing context');
  await expect(frame.locator('#save')).toBeVisible({ timeout: 60000 });
  await frame.waitForFunction(() => Boolean(window.XsxbFrameTunerLite), undefined, { timeout: 60000 });
  return frame;
};
const configFor = async (transfer) => {
  const origin = new URL(transfer.url || transfer.editorUrl).origin;
  const response = await context.request.get(`${origin}/api/config?project=${encodeURIComponent(transfer.project)}`);
  expect(response.ok()).toBe(true);
  return response.json();
};
const currentGroup = config => config.groups.find(group => group.profileId === report.transfers.at(-1)?.profile && group.name === report.transfers.at(-1)?.animation);
const manifestFor = transfer => path.join(root, 'backend', 'vendor', 'XSXB-Frame-Tuner', 'data', 'lite', 'projects', transfer.project, 'animation_manifest.json');
const tuningFor = transfer => path.join(path.dirname(manifestFor(transfer)), 'animation_tuning.json');
const screenshot = async (name, fullPage = false) => {
  const output = path.join(artifacts, name);
  await page.screenshot({ path: output, animations: 'disabled', fullPage });
  report.artifacts.push(output);
};
const imagePixelHashes = images => Promise.all(images.map(async image => {
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}));
const sendSelection = async () => {
  const responsePromise = page.waitForResponse(response => /\/api\/tuner\/import$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout: 90000 });
  await workbenchTab().click();
  await transferButton().click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const transfer = await response.json();
  report.transfers.push(transfer);
  const frame = await visibleEditor();
  await frame.waitForFunction(animation => window.XsxbFrameTunerLite?.current().ready && window.XsxbFrameTunerLite.current().animationId === animation, transfer.animation, { timeout: 60000 });
  return { transfer, frame };
};
const saveEditor = async frame => {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/save' && response.request().method() === 'POST', { timeout: 60000 });
  await frame.locator('#save').click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(frame.locator('body')).not.toHaveClass(/hasUnsavedChanges/);
  return response.json();
};

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await record('workbench starts with selected demonstration frames and no mounted tuner iframe', async () => {
    await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length, { timeout: 90000 });
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(tunerControlRequests).toEqual([]);
    await page.getByRole('button', { name: '奇数帧', exact: true }).click();
    await expect(page.locator('.frame-card input:checked')).toHaveCount(oddFrameCount);
    await page.getByRole('spinbutton', { name: '动画预览帧率', exact: true }).fill('18');
    await page.locator('#animation-name').fill(`tuner_qa_${Date.now()}`);
    return { frames: builtInExample.frames.length, selected: oddFrameCount, fps: 18, tunerRequestsBeforeOpeningTab: 0 };
  });
  const sourceNames = await page.locator('.frame-card.selected .frame-meta span').allTextContents();
  const sourceHashes = await page.locator('.frame-card.selected img').evaluateAll(imagePixelHashes);

  await record('new tuner tab connects lazily and renders the official Lite application', async () => {
    await tunerTab().click();
    // The panel may expose an explicit reconnect button on a fresh service.
    const connect = page.getByRole('button', { name: /连接.*编辑器|启动.*编辑器|连接 XSXB/ });
    if (await connect.count() && await connect.first().isVisible()) await connect.first().click();
    const frame = await visibleEditor();
    await expect(frame.locator('body')).toHaveClass(/frameTunerLite/);
    await expect(frame.locator('#stage')).toBeVisible();
    for (const filename of ['app.js', 'lite.js', 'style.css', 'lite.css']) {
      expect(resources.some(resource => new URL(resource.url).pathname === `/${filename}` && resource.status === 200)).toBe(true);
    }
    return { url: frame.url(), resources };
  });

  let first;
  await record('selected transparent PNGs, original frame names and FPS arrive in a unique Lite project', async () => {
    first = await sendSelection();
    const { transfer, frame } = first;
    expect(transfer.frameCount).toBe(oddFrameCount);
    const config = await configFor(transfer);
    const group = currentGroup(config);
    expect(group).toBeTruthy();
    expect(group.speed).toBe(18);
    expect(group.frames.map(item => item.name)).toEqual(sourceNames);
    expect(config.projectKind).toBe('frame_lite');
    expect(config.warnings).toEqual([]);
    await expect(frame.locator('.thumb img')).toHaveCount(oddFrameCount);
    await expect.poll(() => frame.locator('.thumb img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
    expect(await frame.locator('.thumb img').evaluateAll(imagePixelHashes)).toEqual(sourceHashes);
    const cameraFit = await frame.evaluate(() => {
      const bounds = window.currentFrameRect();
      const canvas = document.querySelector('#stage');
      return { bounds, canvas: { width: canvas.width, height: canvas.height } };
    });
    expect(cameraFit.bounds.x).toBeGreaterThanOrEqual(-1);
    expect(cameraFit.bounds.y).toBeGreaterThanOrEqual(-1);
    expect(cameraFit.bounds.x + cameraFit.bounds.width).toBeLessThanOrEqual(cameraFit.canvas.width + 1);
    expect(cameraFit.bounds.y + cameraFit.bounds.height).toBeLessThanOrEqual(cameraFit.canvas.height + 1);
    const manifest = JSON.parse(await fs.readFile(manifestFor(transfer), 'utf8'));
    const animation = manifest.profiles.find(profile => profile.id === transfer.profile).animations.find(item => item.id === transfer.animation);
    expect(animation.frames).toHaveLength(oddFrameCount);
    expect(animation.fps).toBe(18);
    expect(animation.frames.map(item => item.name)).toEqual(sourceNames);
    expect(animation.frames.every(item => item.width > 0 && item.height > 0)).toBe(true);
    await screenshot('tuner-frames-imported.png', true);
    return { ...transfer, names: group.frames.map(item => item.name), fps: group.speed, rgbaPixelsUnchanged: true, cameraFit, manifest: manifestFor(transfer) };
  });

  let savedOffset;
  await record('unsaved official group offset survives switching to workbench and back', async () => {
    const { frame } = first;
    await frame.locator('#adjustGroup').check();
    const initialOffset = Number(await frame.locator('#baseX').inputValue());
    const increment = frame.locator('button.numberStep[data-step-target="baseX"][data-step-dir="1"]');
    for (let index = 0; index < 3; index++) await increment.click();
    savedOffset = initialOffset + 3;
    await expect(frame.locator('#baseX')).toHaveValue(String(savedOffset));
    await expect(frame.locator('body')).toHaveClass(/hasUnsavedChanges/);
    const before = await frame.evaluate(() => window.XsxbFrameTunerLite.current());
    await workbenchTab().click();
    await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length);
    await expect(page.locator('.frame-card input:checked')).toHaveCount(oddFrameCount);
    await tunerTab().click();
    const after = await frame.evaluate(() => window.XsxbFrameTunerLite.current());
    expect(after).toEqual(before);
    await expect(frame.locator('#baseX')).toHaveValue(String(savedOffset));
    await expect(frame.locator('body')).toHaveClass(/hasUnsavedChanges/);
    return { offsetX: savedOffset, project: before.projectId, iframeRetained: !frame.isDetached() };
  });

  await record('official Save persists tuning to disk and iframe reload restores it', async () => {
    const { frame, transfer } = first;
    const saved = await saveEditor(frame);
    const config = await configFor(transfer);
    const group = config.groups.find(item => item.name === transfer.animation);
    expect(group.baseOffset.x).toBe(savedOffset);
    const tuning = JSON.parse(await fs.readFile(tuningFor(transfer), 'utf8'));
    expect(tuning.values[group.offset].x).toBe(savedOffset);
    await frame.goto(frame.url(), { waitUntil: 'networkidle' });
    await frame.waitForFunction(() => window.XsxbFrameTunerLite?.current().ready);
    await frame.locator('#adjustGroup').check();
    await expect(frame.locator('#baseX')).toHaveValue(String(savedOffset));
    await expect(frame.locator('body')).not.toHaveClass(/hasUnsavedChanges/);
    await screenshot('tuner-offset-saved.png', true);
    return { response: saved, offsetX: savedOffset, tuning: tuningFor(transfer) };
  });

  let second;
  await record('a second transfer creates a separate project and keeps the first clip and edits intact', async () => {
    await workbenchTab().click();
    await page.getByRole('button', { name: '偶数帧', exact: true }).click();
    await page.getByRole('spinbutton', { name: '动画预览帧率', exact: true }).fill('24');
    await tunerTab().click();
    second = await sendSelection();
    expect(second.transfer.project).not.toBe(first.transfer.project);
    expect(second.transfer.animation).not.toBe(first.transfer.animation);
    const config = await configFor(second.transfer);
    expect(currentGroup(config).speed).toBe(24);
    expect(currentGroup(config).frames).toHaveLength(evenFrameCount);
    const oldConfig = await configFor(first.transfer);
    const oldGroup = oldConfig.groups.find(item => item.name === first.transfer.animation);
    expect(oldGroup.frames).toHaveLength(oddFrameCount);
    expect(oldGroup.baseOffset.x).toBe(savedOffset);
    return { firstProject: first.transfer.project, secondProject: second.transfer.project, oldOffsetX: oldGroup.baseOffset.x };
  });

  await record('the earlier editor remains editable and saves successfully after a new transfer', async () => {
    const controls = `tuner-session-${`${first.transfer.project}/${first.transfer.animation}`.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    await page.locator(`[role="tab"][aria-controls="${controls}"]`).click();
    const oldFrame = first.frame;
    await expect(oldFrame.locator('#baseX')).toBeVisible();
    await oldFrame.locator('button.numberStep[data-step-target="baseX"][data-step-dir="1"]').click();
    await saveEditor(oldFrame);
    const config = await configFor(first.transfer);
    const oldGroup = config.groups.find(item => item.name === first.transfer.animation);
    expect(oldGroup.baseOffset.x).toBe(savedOffset + 1);
    return { project: first.transfer.project, offsetX: oldGroup.baseOffset.x, status: 200 };
  });

  await record('mobile tabs and editor stay inside the viewport while preserving workbench selection', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const tunerSize = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, iframeWidths: [...document.querySelectorAll('iframe')].filter(item => item.getBoundingClientRect().width > 0).map(item => item.getBoundingClientRect().width) }));
    expect(tunerSize.scrollWidth).toBeLessThanOrEqual(tunerSize.width + 1);
    for (const width of tunerSize.iframeWidths) expect(width).toBeLessThanOrEqual(tunerSize.width);
    await screenshot('tuner-mobile-390.png');
    await workbenchTab().click();
    await expect(page.locator('.frame-card input:checked')).toHaveCount(evenFrameCount);
    const workbenchSize = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(workbenchSize.scrollWidth).toBeLessThanOrEqual(workbenchSize.width + 1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshot('tuner-workbench-mobile-390.png');
    return { tuner: tunerSize, workbench: workbenchSize, selectedFrames: evenFrameCount };
  });

  await record('no browser exceptions or failed upstream resources', async () => {
    expect(report.pageErrors).toEqual([]);
    expect(report.networkFailures).toEqual([]);
    expect(report.consoleErrors).toEqual([]);
    return { pageErrors: 0, networkFailures: 0, consoleErrors: 0 };
  });
} catch (error) {
  process.exitCode = 1;
  await screenshot('tuner-failure.png').catch(() => {});
} finally {
  report.finished = new Date().toISOString();
  await fs.writeFile(path.join(artifacts, 'tuner-browser-report.json'), JSON.stringify(report, null, 2));
  await context.close();
}
