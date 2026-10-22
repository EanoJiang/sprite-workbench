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
const demoSelectionCount = Math.ceil(builtInExample.frames.length / 2);
const demoHeight = builtInExample.frames[0].height;
const mobileOnly = process.argv.includes('--mobile-only');
const artifacts = path.join(root, 'test-results');
const temp = path.join(root, '.tmp', `compression-browser-${Date.now()}`);
const fixtureDir = path.join(artifacts, 'compression-fixtures');
await Promise.all([fs.mkdir(artifacts, { recursive: true }), fs.mkdir(temp, { recursive: true }), fs.mkdir(fixtureDir, { recursive: true })]);
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
const report = { started: new Date().toISOString(), checks: [], pageErrors: [], consoleErrors: [], networkFailures: [], expectedApiFailures: [], artifacts: [] };
const compressionRequests = [];
let expectingApiFailure = false;
let tunerTransfer = null;
let priorTunerActive = '';
const record = async (name, operation) => {
  try { const detail = await operation(); report.checks.push({ name, passed: true, detail }); console.log(`PASS ${name}: ${JSON.stringify(detail || {})}`); return detail; }
  catch (error) { report.checks.push({ name, passed: false, error: error?.stack || String(error) }); console.error(`FAIL ${name}: ${error?.stack || error}`); throw error; }
};
const context = await chromium.launchPersistentContext(path.join(temp, 'user-data'), {
  ...browserLaunchOptions(), headless: true,
  viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
  downloadsPath: path.join(artifacts, 'downloads'),
  args: [`--disk-cache-dir=${path.join(temp, 'disk-cache')}`, '--disable-crash-reporter', '--disable-features=msEdgeSidebarV2', '--no-first-run'],
  env: process.env,
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(25000);
page.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
page.on('console', message => { if (message.type() === 'error' && !(expectingApiFailure && message.text().includes('503'))) report.consoleErrors.push(message.text()); });
page.on('response', response => {
  if (response.status() >= 400) {
    const failure = { url: response.url(), status: response.status() };
    if (expectingApiFailure && response.status() === 503 && new URL(response.url()).pathname === '/api/compression/frame') report.expectedApiFailures.push(failure);
    else report.networkFailures.push(failure);
  }
  if (new URL(response.url()).pathname === '/api/compression/frame') compressionRequests.push({ status: response.status(), headers: response.headers() });
});
page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') report.networkFailures.push({ url: request.url(), failure: request.failure()?.errorText }); });
page.on('dialog', dialog => dialog.accept());
const panel = page.locator('#step-7');
const generate = () => panel.getByRole('button', { name: /^生成对比/ });
const metric = () => panel.locator('.compression-metrics');
const output = () => panel.locator('.compression-output-image');
const screenshot = async (filename, locator = panel) => {
  const outputPath = path.join(artifacts, filename);
  await locator.scrollIntoViewIfNeeded(); await locator.screenshot({ path: outputPath, animations: 'disabled' });
  report.artifacts.push(outputPath);
};
const download = async (button, filename) => {
  const wait = page.waitForEvent('download', { timeout: 90000 }); await button.click();
  const item = await wait; const outputPath = path.join(artifacts, filename); await item.saveAs(outputPath); report.artifacts.push(outputPath);
  return { bytes: await fs.readFile(outputPath), path: outputPath, filename: item.suggestedFilename() };
};
const runCompression = async (frameCount = 6) => {
  const start = compressionRequests.length;
  await generate().click();
  await expect(generate()).toBeEnabled({ timeout: 90000 });
  await expect(output()).toBeVisible();
  await expect(panel.locator('.compression-ready')).toBeVisible();
  const requests = compressionRequests.slice(start);
  expect(requests).toHaveLength(frameCount);
  for (const request of requests) expect(request.status).toBe(200);
  await pause();
  // Inspect the actual Blob displayed by the application, independent of CDP
  // response-body retention for rapidly repeated requests to the same URL.
  const measured = [];
  for (const [index, request] of requests.entries()) {
    await panel.locator('.compression-thumbnail').nth(index).click();
    await expect(panel.locator('.compression-image-stage').first()).toHaveAttribute('data-frame-index', String(index));
    const bytes = await output().evaluate(async image => [...new Uint8Array(await fetch(image.src).then(response => response.arrayBuffer()))]);
    measured.push({ ...request, body: Buffer.from(bytes) });
  }
  return measured;
};
const pause = async () => {
  const button = panel.getByRole('button', { name: '暂停压缩对比动画', exact: true });
  if (await button.count()) await button.click();
};
const python = (code, ...args) => {
  const result = spawnSync(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-c', code, ...args], { encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(result.stderr || result.error || `Python exited ${result.status}`);
  return JSON.parse(result.stdout);
};
const pngStats = bytes => {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
};

try {
  await page.goto(process.env.FRAMECRAFT_URL || 'http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  if (mobileOnly) {
    await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length, { timeout: 90000 });
    await page.getByRole('button', { name: '奇数帧', exact: true }).click();
    await panel.getByRole('button', { name: /使用已选帧/ }).click();
    await expect(metric()).toHaveAttribute('data-frame-count', String(demoSelectionCount));
    await page.setViewportSize({ width: 390, height: 844 });
    await record('empty mobile savings and the four scale presets remain correctly laid out', async () => {
      await expect(metric().locator(':scope > div:last-child > strong')).toHaveText('—');
      const geometry = await panel.locator('.compression-scale-presets').evaluate(element => {
        const style = getComputedStyle(element);
        const field = element.closest('.compression-field').getBoundingClientRect();
        return { display: style.display, columns: style.gridTemplateColumns.split(' ').filter(Boolean).length, field: { left: field.left, right: field.right }, buttons: [...element.querySelectorAll('button')].map(button => { const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; }) };
      });
      expect(geometry.display).toBe('grid'); expect(geometry.columns).toBe(2); expect(geometry.buttons).toHaveLength(4);
      for (const button of geometry.buttons) { expect(button.left).toBeGreaterThanOrEqual(geometry.field.left - 1); expect(button.right).toBeLessThanOrEqual(geometry.field.right + 1); expect(button.width).toBeGreaterThan(20); }
      await screenshot('compression-mobile-empty-390.png');
      return geometry;
    });
    await record('final mobile character comparison shows real compressed previews without overflow', async () => {
      await runCompression(demoSelectionCount); await pause();
      await expect(output()).toHaveJSProperty('naturalHeight', Math.round(demoHeight * 0.5));
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      expect(geometry.scrollWidth).toBe(390);
      await screenshot('compression-mobile-390.png');
      await screenshot('compression-demo-mobile-390.png');
      expect(report.pageErrors).toEqual([]); expect(report.consoleErrors).toEqual([]); expect(report.networkFailures).toEqual([]);
      return { ...geometry, frames: demoSelectionCount, outputHeight: Math.round(demoHeight * 0.5) };
    });
  } else {
  await record('seventh workflow step automatically loads selected demonstration frames', async () => {
    await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length, { timeout: 90000 });
    await expect(page.locator('.workflow-nav .step')).toHaveCount(7);
    await page.getByRole('button', { name: '奇数帧', exact: true }).click();
    await expect(panel.locator('.compression-source-copy > strong')).toHaveText(`${demoSelectionCount} 帧已载入`);
    await expect(metric()).toHaveAttribute('data-frame-count', String(demoSelectionCount));
    await expect(panel.locator('.compression-original-image')).toHaveJSProperty('naturalHeight', demoHeight);
    await expect(page.locator('.frame-card input:checked')).toHaveCount(demoSelectionCount);
    await runCompression(demoSelectionCount); await pause();
    await screenshot('compression-demo-desktop.png');
    return { workbenchFrames: builtInExample.frames.length, selectedFrames: demoSelectionCount, snapshotFrames: demoSelectionCount, demoLanczosScale: 0.5 };
  });

  const fixtureData = await page.evaluate(() => Array.from({ length: 6 }, (_, index) => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ed2844'; context.fillRect(30 + index * 5, 55, 64, 125);
    const gradient = context.createLinearGradient(130, 50, 280, 180); gradient.addColorStop(0, '#4264e8'); gradient.addColorStop(.55, '#efb845'); gradient.addColorStop(1, '#7ec5dc');
    context.fillStyle = gradient; context.fillRect(130, 50, 150, 130);
    context.fillStyle = 'rgba(220,40,60,.08)'; context.fillRect(3, 3, 8, 8);
    context.fillStyle = 'rgba(250,190,210,.45)'; context.fillRect(70, 190, 120, 15);
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  const fixtures = fixtureData.map((encoded, index) => ({ name: `precision_${String(index + 1).padStart(3, '0')}.png`, mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') }));
  for (const fixture of fixtures) await fs.writeFile(path.join(fixtureDir, fixture.name), fixture.buffer);
  const inputBytes = fixtures.reduce((sum, fixture) => sum + fixture.buffer.length, 0);

  await record('local transparent frame import sorts names and reports actual encoded source bytes', async () => {
    await panel.locator('.compression-file-input').setInputFiles([...fixtures].reverse());
    await expect(metric()).toHaveAttribute('data-frame-count', '6');
    await expect(metric()).toHaveAttribute('data-input-bytes', String(inputBytes));
    await expect(panel.locator('.compression-original-image')).toHaveJSProperty('naturalWidth', 320);
    expect(await panel.locator('.compression-thumbnail').evaluateAll(items => items.map(item => item.title))).toEqual(fixtures.map(fixture => fixture.name));
    await page.locator('#animation-name').fill('precision_qa');
    await panel.locator('#compression-fps').fill('18');
    await panel.locator('#compression-scale-value').fill('0.5');
    return { frames: 6, inputBytes, dimensions: [320, 240], fps: 18 };
  });

  await record('Lanczos produces real half-size RGBA PNGs with clean transparency and retained red subject pixels', async () => {
    await panel.locator('#compression-algorithm').selectOption('lanczos');
    const responses = await runCompression(); await pause();
    const total = responses.reduce((sum, response) => sum + response.body.length, 0);
    await expect(metric()).toHaveAttribute('data-output-bytes', String(total));
    for (const response of responses) {
      expect(pngStats(response.body)).toEqual({ width: 160, height: 120, colorType: 6 });
      expect(Number(response.headers['x-compression-output-bytes'])).toBe(response.body.length);
      expect(response.headers['x-compression-algorithm']).toBe('lanczos');
    }
    const pixels = await output().evaluate(async image => {
      await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let transparent = 0, partial = 0, red = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] === 0) transparent++;
        if (data[index + 3] > 0 && data[index + 3] < 255) partial++;
        if (data[index] > 150 && data[index + 1] < 90 && data[index + 2] < 120 && data[index + 3] > 200) red++;
      }
      return { cornerAlpha: data[3], transparent, partial, red };
    });
    expect(pixels.cornerAlpha).toBe(0); expect(pixels.transparent).toBeGreaterThan(8000); expect(pixels.partial).toBeGreaterThan(0); expect(pixels.red).toBeGreaterThan(1000);
    const savings = (1 - total / inputBytes) * 100;
    await expect(metric()).toContainText(`${Math.abs(savings).toFixed(1)}%`);
    await screenshot('compression-lanczos.png');
    return { frames: 6, inputBytes, outputBytes: total, savingsPercent: savings, ...pixels };
  });

  await record('both preview panes share frame index, pause, frame rate, zoom and pixel display controls', async () => {
    const stages = panel.locator('.compression-image-stage');
    await panel.getByRole('button', { name: '压缩对比下一帧', exact: true }).click();
    const indices = await stages.evaluateAll(items => items.map(item => Number(item.dataset.frameIndex)));
    expect(indices[0]).toBe(indices[1]);
    await page.waitForTimeout(200);
    expect(await stages.evaluateAll(items => items.map(item => Number(item.dataset.frameIndex)))).toEqual(indices);
    await panel.getByRole('button', { name: '对比图放大', exact: true }).click();
    const transforms = await panel.locator('.compression-preview-pane img').evaluateAll(images => images.map(image => image.style.transform));
    expect(transforms[0]).toBe(transforms[1]); expect(transforms[0]).toContain('scale(1.25)');
    await panel.getByRole('button', { name: '1:1 像素', exact: true }).click();
    expect(await panel.locator('.compression-preview-pane img').evaluateAll(images => images.map(image => getComputedStyle(image).width))).toEqual(['320px', '160px']);
    await panel.getByRole('button', { name: '同尺寸对比', exact: true }).click();
    await panel.getByRole('button', { name: '播放压缩对比动画', exact: true }).click();
    await expect.poll(() => stages.first().getAttribute('data-frame-index')).not.toBe(String(indices[0]));
    const playingIndices = await stages.evaluateAll(items => items.map(item => item.dataset.frameIndex));
    expect(playingIndices[0]).toBe(playingIndices[1]);
    await pause(); await expect(panel.locator('.compression-fps-label')).toHaveText('18 FPS');
    return { pausedIndex: indices[0], synchronizedZoom: 125, pixelWidths: [320, 160], fps: 18 };
  });

  let paletteResponses;
  await record('palette mode generates genuinely indexed PNG results with at most 128 colors', async () => {
    await panel.locator('#compression-algorithm').selectOption('palette');
    await expect(panel.locator('.compression-dirty')).toBeVisible();
    paletteResponses = await runCompression(); await pause();
    for (const response of paletteResponses) expect(pngStats(response.body)).toEqual({ width: 160, height: 120, colorType: 3 });
    const example = path.join(artifacts, 'compression-palette-inspected.png'); await fs.writeFile(example, paletteResponses[0].body); report.artifacts.push(example);
    const inspect = python("import json,sys; from PIL import Image; im=Image.open(sys.argv[1]); rgba=im.convert('RGBA'); print(json.dumps({'mode':im.mode,'size':im.size,'colors':len(im.getcolors(257) or []),'cornerAlpha':rgba.getpixel((0,0))[3]}))", example);
    expect(inspect.mode).toBe('P'); expect(inspect.colors).toBeGreaterThan(0); expect(inspect.colors).toBeLessThanOrEqual(128); expect(inspect.cornerAlpha).toBe(0);
    await screenshot('compression-palette.png');
    return { ...inspect, outputBytes: paletteResponses.reduce((sum, item) => sum + item.body.length, 0) };
  });

  await record('cancellation and an API failure retain the last complete result, then unlock successful regeneration', async () => {
    const originalUrl = await output().getAttribute('src');
    const originalBytes = await metric().getAttribute('data-output-bytes');
    await panel.locator('#compression-algorithm').selectOption('nearest');
    let entered;
    const routeEntered = new Promise(resolve => { entered = resolve; });
    const delayed = async route => {
      entered(); await new Promise(resolve => setTimeout(resolve, 750));
      await route.continue().catch(() => {});
    };
    await page.route('**/api/compression/frame', delayed);
    await generate().click(); await routeEntered;
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    await expect(generate()).toBeEnabled();
    await expect(output()).toHaveAttribute('src', originalUrl);
    await expect(metric()).toHaveAttribute('data-output-bytes', originalBytes);
    await page.waitForTimeout(800); await page.unroute('**/api/compression/frame', delayed);
    const failed = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'QA 模拟压缩服务暂时不可用' }) });
    expectingApiFailure = true;
    await page.route('**/api/compression/frame', failed);
    await generate().click();
    await expect(panel.locator('.compression-error')).toContainText('QA 模拟压缩服务暂时不可用');
    await expect(generate()).toBeEnabled();
    await expect(output()).toHaveAttribute('src', originalUrl);
    await expect(metric()).toHaveAttribute('data-output-bytes', originalBytes);
    expect(await output().evaluate(async image => (await fetch(image.src)).ok)).toBe(true);
    await page.unroute('**/api/compression/frame', failed); await page.waitForTimeout(100); expectingApiFailure = false;
    await panel.locator('#compression-algorithm').selectOption('palette');
    paletteResponses = await runCompression();
    await expect(output()).not.toHaveAttribute('src', originalUrl);
    await expect(panel.locator('.compression-error')).toHaveCount(0);
    return { cancelledResultRetained: true, failedResultRetained: true, simulatedStatus: 503, regeneratedFrames: paletteResponses.length };
  });

  let compressedZip;
  let workbenchFrameWidth = 0;
  await record('compressed PNG sequence export retains each processed PNG and metadata', async () => {
    const sequenceDownload = await download(await openPreviewExport(page, 'processed', 'frames'), 'compression-sequence.zip');
    const sequenceZip = await JSZip.loadAsync(sequenceDownload.bytes);
    const manifest = JSON.parse(await sequenceZip.file('manifest.json').async('string'));
    expect(sequenceDownload.filename).toBe(`${manifest.name}.zip`);
    expect(manifest.format).toBe('framecraft-compression-v1'); expect(manifest.fps).toBe(18); expect(manifest.frameCount).toBe(6);
    expect(manifest.settings).toMatchObject({ algorithm: 'palette', scale: 0.5, colors: 128 });
    expect(Object.keys(sequenceZip.files).filter(name => name.endsWith('.png'))).toHaveLength(6);
    for (const [index, item] of manifest.frames.entries()) {
      const bytes = await sequenceZip.file(item.filename).async('nodebuffer');
      expect(bytes.equals(paletteResponses[index].body)).toBe(true);
      expect(item).toMatchObject({ width: 160, height: 120, bytes: bytes.length });
    }
    return { entries: Object.keys(sequenceZip.files), frameCount: manifest.frameCount, fps: manifest.fps };
  });

  await record('sprite sheet export uses the animation name and includes atlas and truthful metadata', async () => {
    const zipDownload = await download(await openPreviewExport(page, 'processed', 'sprite_sheet'), 'compression-output.zip');
    compressedZip = await JSZip.loadAsync(zipDownload.bytes);
    const manifest = JSON.parse(await compressedZip.file('manifest.json').async('string'));
    expect(zipDownload.filename).toBe(`${manifest.name}.zip`);
    expect(manifest.format).toBe('framecraft-compression-v1'); expect(manifest.fps).toBe(18); expect(manifest.frameCount).toBe(6);
    expect(manifest.settings).toMatchObject({ algorithm: 'palette', scale: 0.5, colors: 128 });
    expect(manifest.inputBytes).toBe(inputBytes);
    expect(manifest.outputBytes).toBe(paletteResponses.reduce((sum, item) => sum + item.body.length, 0));
    expect(manifest.frames.map(item => item.sourceName)).toEqual(fixtures.map(fixture => fixture.name));
    expect(Object.keys(compressedZip.files).sort()).toEqual(['atlas.json', 'manifest.json', `${manifest.name}.png`].sort());
    const atlas = JSON.parse(await compressedZip.file('atlas.json').async('string'));
    expect(atlas.meta.image).toBe(`${manifest.name}.png`);
    expect(atlas.meta.columns).toBe(6);
    expect(atlas.meta.size).toEqual({ w: 960, h: 120 });
    expect(Object.keys(atlas.frames)).toHaveLength(6);
    const sheet = await compressedZip.file(`${manifest.name}.png`).async('nodebuffer');
    expect(pngStats(sheet)).toEqual({ width: 960, height: 120, colorType: 6 });
    return { fps: manifest.fps, inputBytes: manifest.inputBytes, outputBytes: manifest.outputBytes, entries: Object.keys(compressedZip.files), sheet: pngStats(sheet) };
  });

  await record('compressed sprite sheet export follows the step 05 grid layout without a separate strip image', async () => {
    await page.locator('#sheet-columns').selectOption('2');
    const zipDownload = await download(await openPreviewExport(page, 'processed', 'sprite_sheet'), 'compression-output-grid.zip');
    const gridZip = await JSZip.loadAsync(zipDownload.bytes);
    const manifest = JSON.parse(await gridZip.file('manifest.json').async('string'));
    const atlas = JSON.parse(await gridZip.file('atlas.json').async('string'));
    expect(atlas.meta.image).toBe(`${manifest.name}.png`);
    expect(atlas.meta.columns).toBe(2);
    expect(atlas.meta.size).toEqual({ w: 320, h: 360 });
    expect(Object.keys(gridZip.files).sort()).toEqual(['atlas.json', 'manifest.json', `${manifest.name}.png`].sort());
    const sheet = await gridZip.file(`${manifest.name}.png`).async('nodebuffer');
    expect(pngStats(sheet)).toEqual({ width: 320, height: 360, colorType: 6 });
    return { columns: atlas.meta.columns, rows: 3, sheet: pngStats(sheet), entries: Object.keys(gridZip.files) };
  });

  await record('compression no longer exposes TAR or workbench replacement actions', async () => {
    await expect(panel.getByRole('button', { name: '使用压缩结果', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'TAR', exact: true })).toHaveCount(0);
    return { applyButton: false, tarButton: false };
  });

  await record('published compressed frames can open in the real XSXB Lite editor', async () => {
    const registry = path.join(root, 'backend', 'vendor', 'XSXB-Frame-Tuner', 'data', 'lite', 'projects.json');
    try { priorTunerActive = JSON.parse(await fs.readFile(registry, 'utf8')).activeProjectId || ''; } catch { /* Empty registry is valid. */ }
    const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tuner/import' && response.request().method() === 'POST', { timeout: 90000 });
    await page.getByRole('button', { name: /发送到 XSXB 调参/ }).click();
    const response = await waiting; expect(response.ok()).toBe(true); const transfer = await response.json(); tunerTransfer = transfer;
    expect(transfer.frameCount).toBe(6);
    const iframe = page.locator('iframe:visible').last(); await expect(iframe).toBeVisible({ timeout: 60000 });
    const frame = await (await iframe.elementHandle()).contentFrame();
    await frame.waitForFunction(() => window.XsxbFrameTunerLite?.current().ready, undefined, { timeout: 60000 });
    const current = await frame.evaluate(() => window.XsxbFrameTunerLite.current()); expect(current.frameCount).toBe(6);
    workbenchFrameWidth = await page.locator('.frame-card img').first().evaluate(image => image.naturalWidth);
    expect(await frame.locator('.thumb img').first().evaluate(image => image.naturalWidth)).toBe(workbenchFrameWidth);
    await page.locator('#tab-workbench').click();
    return { project: transfer.project, frames: current.frameCount, width: workbenchFrameWidth };
  });

  await record('folder import replaces the comparison snapshot while published workbench Blob URLs remain valid', async () => {
    await panel.locator('.compression-folder-input').setInputFiles(fixtureDir);
    await expect(metric()).toHaveAttribute('data-frame-count', '6');
    await expect(metric()).toHaveAttribute('data-output-bytes', '0');
    await expect.poll(() => page.locator('.frame-card img').first().evaluate(image => image.naturalWidth)).toBe(workbenchFrameWidth);
    const healthy = await page.locator('.frame-card img').evaluateAll((images, width) => Promise.all(images.map(async image => {
      await image.decode(); return image.naturalWidth === width && (await fetch(image.src)).ok;
    })), workbenchFrameWidth);
    expect(healthy.every(Boolean)).toBe(true);
    return { folderFrames: 6, publishedFramesStillReadable: true };
  });

  await record('mobile compression layout stays within 390 pixels and no browser requests fail', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await panel.scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport + 1);
    await screenshot('compression-mobile-390.png');
    expect(report.pageErrors).toEqual([]); expect(report.consoleErrors).toEqual([]); expect(report.networkFailures).toEqual([]);
    return { ...geometry, pageErrors: 0, consoleErrors: 0, networkFailures: 0 };
  });
  }
} catch {
  process.exitCode = 1; await screenshot('compression-failure.png').catch(() => {});
} finally {
  // Remove only the UUID returned for this test's own import. Preserve current
  // registry entries/data from every other project and leave the Node service up.
  if (tunerTransfer) {
    try {
      const id = tunerTransfer.project;
      if (!/^framecraft_[a-f0-9]{12}$/.test(id)) throw new Error('Unexpected QA project identity; cleanup skipped');
      const liteRoot = path.resolve(root, 'backend', 'vendor', 'XSXB-Frame-Tuner', 'data', 'lite');
      const registryPath = path.join(liteRoot, 'projects.json');
      const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
      const entry = registry.projects.find(item => item.id === id);
      if (entry && entry.dataDir !== `data/lite/projects/${id}`) throw new Error('QA project data path does not match its identity');
      registry.projects = registry.projects.filter(item => item.id !== id);
      if (registry.activeProjectId === id) registry.activeProjectId = registry.projects.some(item => item.id === priorTunerActive) ? priorTunerActive : registry.projects[0]?.id || '';
      const temporary = `${registryPath}.${id}.qa.tmp`;
      await fs.writeFile(temporary, JSON.stringify(registry, null, 2) + '\n'); await fs.rename(temporary, registryPath);
      const cleanup = { project: id, removedFromRegistry: true, retainedData: path.join(liteRoot, 'projects', id), priorActiveProjectRestored: registry.activeProjectId === priorTunerActive };
      await fs.writeFile(path.join(artifacts, 'compression-tuner-project.json'), JSON.stringify(cleanup, null, 2));
      report.checks.push({ name: 'QA-created tuner project is safely removed from the registry without stopping the service', passed: true, detail: cleanup });
    } catch (error) {
      report.checks.push({ name: 'QA tuner project cleanup', passed: false, error: error?.stack || String(error) }); process.exitCode = 1;
    }
  }
  report.finished = new Date().toISOString();
  await fs.writeFile(path.join(artifacts, mobileOnly ? 'compression-mobile-report.json' : 'compression-browser-report.json'), JSON.stringify(report, null, 2));
  await context.close();
}
