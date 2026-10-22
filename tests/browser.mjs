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
const artifacts = path.join(root, 'test-results');
const temp = path.join(root, '.tmp', `browser-${Date.now()}`);
const reportFile = path.join(artifacts, process.argv.includes('--screenshots-only') ? 'screenshots-report.json' : 'browser-report.json');
await fs.mkdir(artifacts, { recursive: true });
await fs.mkdir(temp, { recursive: true });
for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = temp;

const report = { started: new Date().toISOString(), checks: [], consoleErrors: [], pageErrors: [], networkFailures: [], artifacts: [] };
const record = async (name, operation) => {
  try { const detail = await operation(); report.checks.push({ name, passed: true, detail }); console.log(`PASS ${name}${detail ? `: ${JSON.stringify(detail)}` : ''}`); return detail; }
  catch (error) { const message = error?.stack || String(error); report.checks.push({ name, passed: false, error: message }); console.error(`FAIL ${name}: ${message}`); return null; }
};
const shot = async (page, filename, locator) => {
  const output = path.join(artifacts, filename);
  if (locator) { await locator.scrollIntoViewIfNeeded(); await locator.screenshot({ path: output, animations: 'disabled' }); }
  else await page.screenshot({ path: output, animations: 'disabled' });
  report.artifacts.push(output);
  return output;
};
const pngSize = buffer => {
  expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};
const fixture = path.join(artifacts, 'green-moving-box.mp4');
const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x32CD32:s=320x240:r=12:d=2', '-f', 'lavfi', '-i', 'color=c=0xD84B45:s=48x96:r=12:d=2', '-filter_complex', '[0:v][1:v]overlay=x=20+80*t:y=80:shortest=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', fixture], { encoding: 'utf8', env: process.env });
if (ffmpeg.status !== 0) throw new Error(`Video fixture failed: ${ffmpeg.stderr || ffmpeg.error}`);
report.artifacts.push(fixture);

const context = await chromium.launchPersistentContext(path.join(temp, 'user-data'), {
  ...browserLaunchOptions(), headless: true,
  viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
  downloadsPath: path.join(artifacts, 'downloads'),
  args: [`--disk-cache-dir=${path.join(temp, 'disk-cache')}`, '--disable-crash-reporter', '--disable-features=msEdgeSidebarV2', '--no-first-run'],
  env: process.env,
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(20000);
context.on('page', attachErrors);
function attachErrors(target) {
  target.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ text: message.text(), location: message.location() }); });
  target.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
  target.on('response', response => { if (response.status() >= 400) report.networkFailures.push({ status: response.status(), url: response.url() }); });
  target.on('requestfailed', request => report.networkFailures.push({ url: request.url(), failure: request.failure()?.errorText }));
}
attachErrors(page);

try {
  await page.goto(process.env.FRAMECRAFT_URL || 'http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await record('initial demonstration loads the fixed selectable frames and source media', async () => {
    await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length, { timeout: 90000 });
    const videoSource = builtInExample.source?.type.startsWith('video/');
    const media = page.locator(videoSource ? '.media-stage video' : '.media-stage img');
    await expect(media).toBeVisible();
    await expect.poll(() => media.evaluate(element => element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth)).toBeGreaterThan(0);
    return { frames: await page.locator('.frame-card').count(), heading: await page.locator('#workbench-panel h1').innerText(), comparisonImages: await page.locator('.image-content').evaluateAll(images => images.map(image => ({ natural: [image.naturalWidth, image.naturalHeight], image: [image.getBoundingClientRect().width, image.getBoundingClientRect().height], viewport: [image.parentElement.clientWidth, image.parentElement.clientHeight], fit: getComputedStyle(image).objectFit, transform: getComputedStyle(image).transform }))) };
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(350);
  await shot(page, 'initial-desktop.png');
  await shot(page, 'cleanup-demo.png', page.locator('#step-4'));
  await shot(page, 'review-demo.png', page.locator('#step-3'));
  await shot(page, 'animation-demo.png', page.locator('#step-5'));
  await record('comparison preview fits image at default 100 percent zoom', async () => {
    const sizes = await page.locator('.image-content').evaluateAll(images => images.map(image => ({ imageHeight: image.getBoundingClientRect().height, viewportHeight: image.parentElement.clientHeight, imageWidth: image.getBoundingClientRect().width, viewportWidth: image.parentElement.clientWidth })));
    for (const size of sizes) { expect(size.imageHeight).toBeLessThanOrEqual(size.viewportHeight + 2); expect(size.imageWidth).toBeLessThanOrEqual(size.viewportWidth + 2); }
    return sizes;
  });

  if (!process.argv.includes('--screenshots-only')) {
  await record('local video import and frame-rate calibration', async () => {
    await page.locator('#workbench-media-input').setInputFiles(fixture);
    await expect(page.locator('.file-details strong')).toContainText('green-moving-box.mp4');
    await page.getByRole('dialog', { name: '为动画片段命名', exact: true }).getByRole('button', { name: '使用原文件名', exact: true }).click();
    await page.getByRole('spinbutton', { name: '源素材帧率', exact: true }).fill('12');
    await page.getByRole('spinbutton', { name: '源素材帧率', exact: true }).blur();
    await expect(page.locator('#end-frame')).toHaveValue('24');
    await expect(page.locator('.frame-card')).toHaveCount(0);
    await expect(page.locator('.media-stage video')).toHaveJSProperty('videoWidth', 320);
    return { endFrame: await page.locator('#end-frame').inputValue(), videoWidth: await page.locator('.media-stage video').evaluate(video => video.videoWidth) };
  });
  await record('range and extraction settings update output estimate', async () => {
    await page.locator('#start-frame').fill('3');
    await page.locator('#end-frame').fill('20');
    await page.locator('#stride').fill('3');
    await page.locator('#target-height').fill('160');
    await page.locator('#padding').fill('0');
    await page.locator('#key-color').fill('#32cd32');
    await page.locator('#canvas-layout').selectOption('original');
    await expect(page.locator('#start-frame')).toHaveValue('3');
    await expect(page.locator('#end-frame')).toHaveValue('20');
    await expect(page.locator('.extraction-flow')).toContainText('6 张 PNG');
    await expect(page.locator('.range-summary')).toContainText('18');
    return { range: '3–20', stride: 3, expectedFrames: 6, targetHeight: 160 };
  });
  await record('extract real video frames and remove green background', async () => {
    const mode = page.locator('#matting-mode');
    if (await mode.count()) {
      const chromaValue = await mode.locator('option').evaluateAll(options => options.find(option => /色度|纯色/.test(option.textContent))?.value);
      if (chromaValue) await mode.selectOption(chromaValue);
    }
    await page.getByRole('button', { name: /^开始抽帧/ }).click();
    await expect(page.locator('.frame-card')).toHaveCount(6, { timeout: 90000 });
    await expect(page.locator('.frame-card input:checked')).toHaveCount(6);
    await expect(page.locator('.frame-card').first().locator('img')).toHaveJSProperty('naturalHeight', 160);
    const pixels = await page.locator('.frame-card img').first().evaluate(async image => {
      await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0, transparent = 0, xTotal = 0;
      for (let i = 0; i < data.length; i += 4) { if (data[i + 3] === 0) transparent++; if (data[i + 3] > 200) { opaque++; xTotal += (i / 4) % canvas.width; } }
      return { width: canvas.width, height: canvas.height, cornerAlpha: data[3], opaque, transparent, centroidX: xTotal / opaque };
    });
    expect(pixels.cornerAlpha).toBe(0); expect(pixels.opaque).toBeGreaterThan(500); expect(pixels.transparent).toBeGreaterThan(10000);
    const lastCentroid = await page.locator('.frame-card img').last().evaluate(async image => {
      await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0, count = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) { sum += i / 4 % canvas.width; count++; } return sum / count;
    });
    expect(lastCentroid).toBeGreaterThan(pixels.centroidX + 30);
    await shot(page, 'review-video.png', page.locator('#step-3'));
    return { frames: 6, ...pixels, lastCentroid };
  });
  await record('all, none, odd, even, invert frame selection', async () => {
    const select = async (name, count) => { await page.getByRole('button', { name, exact: true }).click(); await expect(page.locator('.frame-card input:checked')).toHaveCount(count); };
    await select('全不选', 0); await select('全选', 6); await select('奇数帧', 3);
    expect(await page.locator('.frame-card input').evaluateAll(inputs => inputs.map(input => input.checked))).toEqual([true, false, true, false, true, false]);
    await select('反选', 3);
    expect(await page.locator('.frame-card input').evaluateAll(inputs => inputs.map(input => input.checked))).toEqual([false, true, false, true, false, true]);
    await select('偶数帧', 3); await select('全选', 6);
    return { count: 6, modes: ['none', 'all', 'odd', 'invert', 'even'] };
  });

  const download = async (button, filename) => {
    const waiting = page.waitForEvent('download', { timeout: 90000 }); await button.click(); const item = await waiting;
    const output = path.join(artifacts, filename); await item.saveAs(output); report.artifacts.push(output); return fs.readFile(output);
  };
  let firstFrameFile;
  await record('transparent PNG sequence ZIP export', async () => {
    const bytes = await download(await openPreviewExport(page, 'original', 'frames'), 'sequence-export.zip');
    const zip = await JSZip.loadAsync(bytes); const names = Object.keys(zip.files); expect(names.filter(name => /\.png$/.test(name))).toHaveLength(6);
    const manifest = JSON.parse(await zip.file('manifest.json').async('string')); expect(manifest.frameCount).toBe(6); expect(manifest.fps).toBe(12);
    expect(manifest.frames.map(frame => frame.sourceFrame)).toEqual([3, 6, 9, 12, 15, 18]);
    const png = await zip.file('frame_001.png').async('nodebuffer'); const size = pngSize(png); expect(size.height).toBe(160);
    expect(names.filter(name => /\.png$/.test(name))).toEqual(Array.from({ length: 6 }, (_, index) => `frame_${String(index + 1).padStart(3, '0')}.png`));
    firstFrameFile = path.join(artifacts, 'import-frame_001.png'); await fs.writeFile(firstFrameFile, png); report.artifacts.push(firstFrameFile);
    return { entries: names, frameCount: manifest.frameCount, sourceFrames: manifest.frames.map(frame => frame.sourceFrame), png: size };
  });
  await record('sprite sheet PNG plus atlas metadata export', async () => {
    await page.locator('#sheet-columns').selectOption('auto');
    const bytes = await download(await openPreviewExport(page, 'original', 'sprite_sheet'), 'spritesheet-export.zip');
    const zip = await JSZip.loadAsync(bytes); const atlas = JSON.parse(await zip.file('atlas.json').async('string')); const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    const size = pngSize(await zip.file(atlas.meta.image).async('nodebuffer'));
    expect(Object.keys(atlas.frames)).toHaveLength(6); expect(atlas.meta.columns).toBe(6); expect(atlas.meta.image).toBe(`${manifest.name}.png`); expect(size).toEqual({ width: atlas.meta.size.w, height: atlas.meta.size.h });
    expect(zip.file(`${manifest.name}_strip.png`)).toBeNull();
    expect(atlas.frames['frame_005.png'].frame.y).toBe(0);
    return { entries: Object.keys(zip.files), size, columns: atlas.meta.columns, frameCount: Object.keys(atlas.frames).length };
  });
  await record('GIF export has valid header, frame count, and dimensions', async () => {
    const bytes = await download(await openPreviewExport(page, 'original', 'gif'), 'animation-export.gif');
    expect(bytes.subarray(0, 6).toString()).toBe('GIF89a'); expect(bytes.at(-1)).toBe(0x3b);
    const graphicsControls = Array.from(bytes).reduce((count, value, i) => count + (value === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04 ? 1 : 0), 0);
    expect(graphicsControls).toBe(6); expect(bytes.readUInt16LE(8)).toBe(160);
    return { bytes: bytes.length, width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), frames: graphicsControls };
  });
  await record('animation pause, FPS, loop mode, and frame inspection', async () => {
    await page.locator('#animation-name').fill('fixture_walk');
    await page.locator('#loop-mode').selectOption('pingpong');
    await page.getByRole('button', { name: '24 FPS', exact: true }).click();
    await expect(page.locator('.animation-stage-stats')).toContainText('24 FPS');
    const playing = page.getByRole('button', { name: '暂停大图动画预览', exact: true }); if (await playing.count()) await playing.click();
    await expect(page.getByRole('button', { name: '播放大图动画预览', exact: true })).toBeVisible();
    await page.locator('.frame-thumb').first().dblclick(); await expect(page.getByRole('dialog', { name: /frame_001/ })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('.inspect-modal')).toHaveCount(0);
    await shot(page, 'animation-video.png', page.locator('#step-5'));
    return { fps: 24, loopMode: 'pingpong', inspected: true };
  });
  await record('local transparent PNG sequence import', async () => {
    if (!firstFrameFile) throw new Error('PNG fixture unavailable because sequence export failed');
    const copy = path.join(artifacts, 'import-frame_002.png'); await fs.copyFile(firstFrameFile, copy);
    await page.locator('#workbench-frames-input').setInputFiles([copy, firstFrameFile]);
    await expect(page.locator('.frame-card')).toHaveCount(2); await expect(page.locator('.frame-card input:checked')).toHaveCount(2);
    await expect(page.locator('.frame-card').first().locator('.frame-meta')).toContainText('import-frame_001.png');
    return { frames: 2, sortedNumerically: true };
  });
  await record('390px mobile layout stays inside viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(350);
    const layout = await page.evaluate(() => {
      const width = window.innerWidth; const offenders = Array.from(document.querySelectorAll('body *')).filter(element => { const bounds = element.getBoundingClientRect(); const style = getComputedStyle(element); return bounds.width > 0 && style.position !== 'fixed' && (bounds.right > width + 1 || bounds.left < -1) && !element.closest('.workflow-nav, .sequence-strip'); }).map(element => ({ tag: element.tagName, className: element.className, left: Math.round(element.getBoundingClientRect().left), right: Math.round(element.getBoundingClientRect().right) }));
      return { viewport: width, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, offenders: offenders.slice(0, 25) };
    });
    await shot(page, 'mobile-390.png'); await shot(page, 'mobile-cleanup.png', page.locator('#step-4')); await shot(page, 'mobile-review.png', page.locator('#step-3'));
    expect(layout.document).toBeLessThanOrEqual(391); expect(layout.body).toBeLessThanOrEqual(391); return layout;
  });
  await record('no browser console or runtime errors', async () => { expect(report.pageErrors).toEqual([]); expect(report.consoleErrors).toEqual([]); return { consoleErrors: report.consoleErrors.length, runtimeErrors: report.pageErrors.length }; });
  }
} finally {
  report.finished = new Date().toISOString(); report.passed = report.checks.filter(check => check.passed).length; report.failed = report.checks.filter(check => !check.passed).length;
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  await context.close();
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, report: reportFile, screenshots: report.artifacts.filter(file => file.endsWith('.png')) }, null, 2));
  if (report.failed) process.exitCode = 1;
}
