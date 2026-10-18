import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';
import builtInExample from './built-in-example.mjs';
import JSZip from 'jszip';
import { openPreviewExport, previewExportToggle } from './preview-export-controls.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-results');
const temp = path.join(root, '.tmp', `loop-browser-${Date.now()}`);
const fixtureDir = path.join(artifacts, 'loop-fixtures');
await Promise.all([fs.mkdir(artifacts, { recursive: true }), fs.mkdir(temp, { recursive: true }), fs.mkdir(fixtureDir, { recursive: true })]);
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
const report = { started: new Date().toISOString(), checks: [], pageErrors: [], consoleErrors: [], networkFailures: [], artifacts: [] };
const record = async (name, operation) => {
  try { const detail = await operation(); report.checks.push({ name, passed: true, detail }); console.log(`PASS ${name}: ${JSON.stringify(detail || {})}`); return detail; }
  catch (error) { report.checks.push({ name, passed: false, error: error?.stack || String(error) }); console.error(`FAIL ${name}: ${error?.stack || error}`); throw error; }
};
const python = (code, ...args) => {
  const result = spawnSync(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-c', code, ...args], { encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(result.stderr || result.error || `Python exited ${result.status}`);
  return result.stdout;
};
const context = await chromium.launchPersistentContext(path.join(temp, 'user-data'), {
  ...browserLaunchOptions(), headless: true,
  viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
  downloadsPath: path.join(artifacts, 'downloads'),
  args: [`--disk-cache-dir=${path.join(temp, 'disk-cache')}`, '--disable-crash-reporter', '--disable-features=msEdgeSidebarV2', '--no-first-run'], env: process.env,
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(30000);
page.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
page.on('response', response => { if (response.status() >= 400) report.networkFailures.push({ url: response.url(), status: response.status() }); });
page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') report.networkFailures.push({ url: request.url(), failure: request.failure()?.errorText }); });
const correction = page.locator('#step-4');
const enabled = page.locator('#loop-correction-enabled');
const exportButton = () => previewExportToggle(page, 'original');
const shot = async (filename, locator) => { const output = path.join(artifacts, filename); await locator.scrollIntoViewIfNeeded(); await locator.screenshot({ path: output, animations: 'disabled' }); report.artifacts.push(output); };
const download = async (button, name) => {
  await expect(button).toBeEnabled({ timeout: 90000 }); const waiting = page.waitForEvent('download', { timeout: 90000 }); await button.click();
  const item = await waiting; const output = path.join(artifacts, name); await item.saveAs(output); report.artifacts.push(output); return fs.readFile(output);
};
const exportSequence = async name => {
  const bytes = await download(await openPreviewExport(page, 'original', 'frames'), name); const zip = await JSZip.loadAsync(bytes); const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  const pngs = await Promise.all(manifest.frames.map(frame => zip.file(frame.filename).async('nodebuffer')));
  return { bytes, zip, manifest, pngs };
};
const pixelStats = buffer => JSON.parse(python(`import io,json,sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGBA'); a=im.getchannel('A'); values=list(a.getdata()); print(json.dumps({'width':im.width,'height':im.height,'cornerAlpha':im.getpixel((0,0))[3],'transparent':sum(v==0 for v in values),'partial':sum(0<v<255 for v in values),'opaque':sum(v==255 for v in values)}))`, buffer));
const savePngStats = async (bytes, name) => { const output = path.join(fixtureDir, name); await fs.writeFile(output, bytes); return pixelStats(output); };
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  await page.goto(process.env.FRAMECRAFT_URL || 'http://127.0.0.1:8765', { waitUntil: 'networkidle' });
  await record('eight-step workflow keeps optional endpoint correction and removes automatic cycle detection', async () => {
    await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length, { timeout: 90000 });
    await expect(page.locator('.workflow-nav .step')).toHaveCount(8);
    await expect(correction.getByRole('heading', { name: /首尾帧修正/ })).toBeVisible();
    await expect(correction).toContainText(/建议.*循环|循环.*建议/);
    await expect(page.locator('#loop-animation, #loop-range-status, .loop-range-controls')).toHaveCount(0);
    await expect(enabled).not.toBeChecked();
    await shot('manual-range-desktop.png', page.locator('#step-1'));
    return { steps: 8, correctionOptional: true, automaticDetectionRemoved: true };
  });
  const transparent = await page.evaluate(() => Array.from({ length: 6 }, (_, i) => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128; const ctx = canvas.getContext('2d');
    ctx.fillStyle = ['#f54259','#e98d28','#416ce4','#692cc9','#1f98ac','#ce458c'][i]; ctx.fillRect(15 + i * 9, 30, 30, 68);
    ctx.fillStyle='rgba(225,115,195,.45)'; ctx.beginPath();ctx.arc(82,29+i*3,15,0,Math.PI*2);ctx.fill();
    return { name: `seam_${String(i + 1).padStart(3,'0')}.png`, mimeType: 'image/png', encoded: canvas.toDataURL('image/png').split(',')[1] };
  }));
  const pngFixtures = transparent.map(({ encoded, ...fixture }) => ({ ...fixture, buffer: Buffer.from(encoded, 'base64') }));
  await record('uncorrected transparent input exports its original distinct endpoints', async () => {
    if (await enabled.isChecked()) await enabled.uncheck();
    await page.locator('#workbench-frames-input').setInputFiles(pngFixtures); await expect(page.locator('.frame-card')).toHaveCount(6);
    const exported = await exportSequence('loop-uncorrected.zip'); expect(exported.pngs[0].equals(pngFixtures[0].buffer)).toBe(true); expect(exported.pngs[5].equals(pngFixtures[5].buffer)).toBe(true); expect(exported.pngs[0].equals(exported.pngs[5])).toBe(false);
    return { frames: 6, first: fingerprint(exported.pngs[0]), last: fingerprint(exported.pngs[5]) };
  });
  await record('exact endpoint correction exports identical PNG bytes while preserving transparency and intermediate frames', async () => {
    await enabled.check(); const exported = await exportSequence('loop-corrected.zip'); expect(exported.manifest.frameCount).toBe(6);
    expect(exported.pngs[0].equals(exported.pngs[5])).toBe(true); expect(exported.pngs[0].equals(pngFixtures[0].buffer)).toBe(true); expect(exported.pngs[2].equals(pngFixtures[2].buffer)).toBe(true);
    const stats = await savePngStats(exported.pngs[5], 'loop-corrected-last.png'); expect(stats.cornerAlpha).toBe(0); expect(stats.transparent).toBeGreaterThan(1000); expect(stats.partial).toBeGreaterThan(100);
    const previewFrames = await page.locator('.sequence-frame img').evaluateAll(async images => Promise.all([images[0],images.at(-1)].map(async image => Array.from(new Uint8Array(await fetch(image.src).then(response => response.arrayBuffer()))))));
    expect(Buffer.from(previewFrames[0]).equals(Buffer.from(previewFrames[1]))).toBe(true);
    await shot('loop-correction-desktop.png', correction); return { frames: 6, exactPngBytes: true, unchangedMiddle: true, animationPreviewMatches: true, stats };
  });
  await record('GIF and sprite-sheet exports also use the corrected endpoints', async () => {
    const gif = await download(await openPreviewExport(page, 'original', 'gif'), 'loop-corrected.gif');
    const gifPath = path.join(artifacts, 'loop-corrected.gif');
    const gifInfo = JSON.parse(python(`import json,sys
from PIL import Image,ImageChops
im=Image.open(sys.argv[1]); first=im.convert('RGBA'); count=im.n_frames; im.seek(count-1); last=im.convert('RGBA'); print(json.dumps({'frames':count,'sameEndpoints':first.tobytes()==last.tobytes(),'size':list(first.size)}))`, gifPath));
    expect(gif.subarray(0,6).toString()).toBe('GIF89a'); expect(gifInfo.frames).toBe(6); expect(gifInfo.sameEndpoints).toBe(true);
    const sheetBytes = await download(await openPreviewExport(page, 'original', 'sprite_sheet'), 'loop-corrected-sheet.zip');
    const zip = await JSZip.loadAsync(sheetBytes); const atlas = JSON.parse(await zip.file('atlas.json').async('string'));
    const sheetPath = path.join(fixtureDir,'loop-corrected-sheet.png'); await fs.writeFile(sheetPath,await zip.file(atlas.meta.image).async('nodebuffer'));
    const cells = [atlas.frames['frame_001.png'].frame,atlas.frames['frame_006.png'].frame];
    const sameSheet = JSON.parse(python(`import json,sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGBA'); cells=json.loads(sys.argv[2]); crops=[im.crop((c['x'],c['y'],c['x']+c['w'],c['y']+c['h'])) for c in cells]; print(json.dumps({'sameEndpoints':crops[0].tobytes()==crops[1].tobytes()}))`,sheetPath,JSON.stringify(cells)));
    expect(sameSheet.sameEndpoints).toBe(true); return { gif:gifInfo,sheet:sameSheet };
  });
  await record('changing correction parameters blocks stale exports until regeneration completes', async () => {
    await page.getByRole('combobox', { name: '首尾修正方式', exact: true }).selectOption('blend');
    await expect(page.locator('#loop-correction-status')).toHaveAttribute('data-state', 'pending');
    await expect(exportButton()).toBeDisabled();
    await expect(page.getByRole('button', { name: /发送到 XSXB 调参/ })).toBeDisabled();
    await expect(page.locator('#step-8').getByRole('button', { name: /使用已选帧/ })).toBeDisabled();
    await page.getByRole('spinbutton', { name: '首尾过渡帧数', exact: true }).fill('2');
    await page.locator('#loop-correction-generate').click();
    const exported = await exportSequence('loop-corrected-blend.zip');
    expect(exported.pngs[0].equals(exported.pngs.at(-1))).toBe(true); expect(exported.pngs[4].equals(pngFixtures[4].buffer)).toBe(false);
    await page.getByRole('combobox', { name: '首尾修正方式', exact: true }).selectOption('match');
    await expect(exportButton()).toBeDisabled(); await page.locator('#loop-correction-generate').click();
    await expect(page.locator('#loop-correction-status')).toHaveAttribute('data-state', 'ready');
    return { staleExportsBlocked: true, transitionFrames: 2, blendedPenultimateFrame: true, restoredMatchMode: true };
  });
  await record('disabling correction restores the original final frame without altering source frames', async () => {
    await enabled.uncheck(); const exported = await exportSequence('loop-restored.zip'); expect(exported.pngs[5].equals(pngFixtures[5].buffer)).toBe(true); expect(exported.pngs[0].equals(exported.pngs[5])).toBe(false); await enabled.check();
    await expect(exportButton()).toBeEnabled({ timeout: 90000 }); return { restoredExactBytes: true };
  });
  await record('selecting a new first endpoint regenerates corrected output for the selected sequence', async () => {
    await page.locator('.frame-card input').first().uncheck(); const exported = await exportSequence('loop-corrected-selection.zip'); expect(exported.manifest.frameCount).toBe(5);
    expect(exported.manifest.frames[0].sourceFrame).toBe(2); expect(exported.pngs[0].equals(pngFixtures[1].buffer)).toBe(true); expect(exported.pngs[0].equals(exported.pngs.at(-1))).toBe(true);
    return { frames: 5, selectedFirstSource: 2, exactPngBytes: true };
  });
  await record('reversing frame order regenerates endpoints and preserves the chosen source metadata', async () => {
    await page.getByRole('button', { name: '反转顺序', exact: true }).click(); const exported = await exportSequence('loop-corrected-reversed.zip');
    expect(exported.manifest.frames.map(frame => frame.sourceFrame)).toEqual([6, 5, 4, 3, 2]); expect(exported.pngs[0].equals(pngFixtures[5].buffer)).toBe(true); expect(exported.pngs[0].equals(exported.pngs.at(-1))).toBe(true);
    return { sourceFrames: exported.manifest.frames.map(frame => frame.sourceFrame), exactPngBytes: true };
  });
  await record('compression snapshots use the effective corrected sequence rather than stale raw endpoints', async () => {
    const panel = page.locator('#step-8'); await panel.getByRole('button', { name: /使用已选帧/ }).click(); await expect(panel.locator('.compression-metrics')).toHaveAttribute('data-frame-count', '5');
    const values = [];
    for (const index of [0,4]) { await panel.locator('.compression-thumbnail').nth(index).click(); const image = panel.locator('.compression-original-image'); await expect(image).toBeVisible(); values.push(await image.evaluate(async element => Array.from(new Uint8Array(await fetch(element.src).then(response => response.arrayBuffer()))))); }
    expect(Buffer.from(values[0]).equals(Buffer.from(values[1]))).toBe(true); expect(Buffer.from(values[0]).equals(pngFixtures[5].buffer)).toBe(true);
    return { snapshotFrames: 5, exactPngBytes: true };
  });
  await record('active compression protects corrected source URLs from selection and order changes', async () => {
    const panel = page.locator('#step-8'); const pattern = '**/api/compression/frame';
    let resume; let observed;
    const released = new Promise(resolve => { resume = resolve; });
    const requestStarted = new Promise(resolve => { observed = resolve; });
    await page.route(pattern, async route => { observed(); await released; await route.continue(); });
    const generate = panel.getByRole('button', { name: /^生成对比/ });
    try {
      await generate.click(); await requestStarted;
      expect(await page.locator('.frame-card input:disabled').count()).toBe(6);
      await expect(page.getByRole('button', { name: '反转顺序', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: '恢复顺序', exact: true })).toBeDisabled();
      await expect(enabled).toBeDisabled();
    } finally { resume(); }
    await expect(generate).toBeEnabled({ timeout: 90000 }); await expect(panel.locator('.compression-ready')).toBeVisible();
    await page.unroute(pattern);
    await expect(panel.locator('.compression-output-image')).toHaveJSProperty('naturalWidth', 64);
    await expect(page.locator('.frame-card input').first()).toBeEnabled(); await expect(enabled).toBeEnabled();
    return { protectedFrameCheckboxes: 6, protectedOrderControls: true, completedCompressedWidth: 64 };
  });
  await record('390px manual range controls and retained correction preview stay within the viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await correction.scrollIntoViewIfNeeded();
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth })); expect(dimensions.document).toBeLessThanOrEqual(391); expect(dimensions.body).toBeLessThanOrEqual(391);
    await expect(page.locator('#loop-animation, #loop-range-status, .loop-range-controls')).toHaveCount(0);
    await shot('loop-correction-mobile-390.png', correction); await shot('manual-range-mobile-390.png', page.locator('#step-1')); return dimensions;
  });
  await record('no browser console, runtime, or failed network requests', async () => { expect(report.pageErrors).toEqual([]); expect(report.consoleErrors).toEqual([]); expect(report.networkFailures).toEqual([]); return { pageErrors: 0, consoleErrors: 0, networkFailures: 0 }; });
} finally {
  report.finished = new Date().toISOString(); report.passed = report.checks.filter(check => check.passed).length; report.failed = report.checks.filter(check => !check.passed).length;
  const reportPath = path.join(artifacts, 'loop-browser-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); await context.close();
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, report: reportPath }, null, 2)); if (report.failed) process.exitCode = 1;
}
