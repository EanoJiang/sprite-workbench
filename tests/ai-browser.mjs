import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';
import builtInExample from './built-in-example.mjs';

// UI-only by default. Pass --infer only after reserving the local model/GPU slot.
const runInference = process.argv.includes('--infer');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-results');
const temp = path.join(root, '.tmp', `ai-browser-${Date.now()}`);
await fs.mkdir(artifacts, { recursive: true }); await fs.mkdir(temp, { recursive: true });
for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = temp;
const report = { started: new Date().toISOString(), inferenceAuthorizedByFlag: runInference, checks: [], consoleErrors: [], pageErrors: [], networkFailures: [], canceledRequests: [], modelRequests: [], artifacts: [] };
const check = async (name, operation) => {
  try { const detail = await operation(); report.checks.push({ name, passed: true, detail }); console.log(`PASS ${name}: ${JSON.stringify(detail)}`); return detail; }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack || String(error) }); console.error(`FAIL ${name}: ${error.stack || error}`); return null; }
};
const context = await chromium.launchPersistentContext(path.join(temp, 'user-data'), {
  ...browserLaunchOptions(), headless: true, viewport: { width: 1440, height: 1000 },
  args: [`--disk-cache-dir=${path.join(temp, 'disk-cache')}`, '--disable-crash-reporter', '--no-first-run'], env: process.env,
});
await context.addInitScript(() => {
  const nativeFetch = window.fetch.bind(window); window.__framecraftMatteLog = [];
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (!/\/api\/matte$/.test(url)) return nativeFetch(input, init);
    const fields = init?.body instanceof FormData ? Object.fromEntries(['mode', 'device', 'resolution', 'birefnet_variant'].map(key => [key, init.body.get(key)])) : {};
    const entry = { url, ...fields, started: Date.now() }; window.__framecraftMatteLog.push(entry);
    try {
      const response = await nativeFetch(input, init); entry.status = response.status; entry.headers = Object.fromEntries(response.headers.entries());
      entry.bytes = Array.from(new Uint8Array(await response.clone().arrayBuffer())); entry.finished = Date.now(); return response;
    } catch (error) { entry.error = String(error); entry.finished = Date.now(); throw error; }
  };
});
const page = context.pages()[0] || await context.newPage(); page.setDefaultTimeout(20000);
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ text: message.text(), location: message.location() }); });
page.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
page.on('request', request => {
  if (/\/api\/(matte|models\/prepare)$/.test(request.url())) report.modelRequests.push({ method: request.method(), url: request.url(), post: request.postData()?.slice(-2500) });
});
page.on('response', response => { if (response.status() >= 400) report.networkFailures.push({ status: response.status(), url: response.url() }); });
page.on('requestfailed', request => {
  const failure = { url: request.url(), failure: request.failure()?.errorText };
  // React StrictMode cancels the first development-only health effect on cleanup.
  if (request.method() === 'GET' && /\/api\/health$/.test(request.url()) && failure.failure === 'net::ERR_ABORTED') report.canceledRequests.push(failure);
  else report.networkFailures.push(failure);
});
const engines = [
  { mode: 'chroma', index: 0, name: '纯色抠图' },
  { mode: 'birefnet', index: 1, name: 'BiRefNet' },
  { mode: 'corridorkey', index: 2, name: 'CorridorKey' },
  { mode: 'hybrid', index: 3, name: 'BiRefNet + CorridorKey' },
];
const screenshot = async filename => {
  const output = path.join(artifacts, filename); await page.locator('#step-4').screenshot({ path: output, animations: 'disabled' }); report.artifacts.push(output);
};

try {
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length, { timeout: 90000 });
  await check('AI service is reachable through the frontend proxy', async () => {
    const response = await page.request.get('http://127.0.0.1:5173/api/health'); expect(response.status()).toBe(200);
    const health = await response.json(); expect(health.status).toBe('ok'); await expect(page.locator('.ai-panel-heading button')).toContainText('已连接');
    return health;
  });
  await check('engine controls configure correctly without automatic model calls', async () => {
    const before = report.modelRequests.length;
    for (const engine of engines) {
      await page.locator('.engine-option').nth(engine.index).click();
      await expect(page.locator('.engine-option.active strong')).toHaveText(engine.name);
      if (engine.mode !== 'chroma') {
        await expect(page.getByRole('combobox', { name: 'AI 推理分辨率', exact: true })).toBeVisible();
        await page.getByRole('combobox', { name: 'AI 推理分辨率', exact: true }).selectOption('512');
        await page.getByRole('combobox', { name: 'AI 推理设备', exact: true }).selectOption('auto');
        if (engine.mode === 'corridorkey') await expect(page.getByRole('combobox', { name: 'BiRefNet 模型', exact: true })).toBeDisabled();
        else await page.getByRole('combobox', { name: 'BiRefNet 模型', exact: true }).selectOption('standard');
        await expect(page.locator('#tolerance')).toBeDisabled();
      }
    }
    await page.waitForTimeout(500); expect(report.modelRequests.length).toBe(before);
    await screenshot('ai-controls-desktop.png');
    return { engines: engines.map(engine => engine.mode), resolution: 512, variant: 'standard', automaticModelCalls: 0 };
  });

  if (runInference) {
    await page.locator('#target-height').fill('480'); await page.locator('#padding').fill('0');
    for (const engine of engines.filter(engine => ['birefnet', 'hybrid'].includes(engine.mode))) {
      await check(`${engine.name} produces a real transparent PNG from manual preview`, async () => {
        const health = await page.request.get('http://127.0.0.1:5173/api/health').then(response => response.json());
        expect(health.busy, 'Reserve the model slot before running this test').toBe(false);
        await page.locator('.engine-option').nth(engine.index).click();
        await page.getByRole('combobox', { name: 'AI 推理分辨率', exact: true }).selectOption('512');
        await page.getByRole('combobox', { name: 'BiRefNet 模型', exact: true }).selectOption('standard');
        await page.getByRole('combobox', { name: 'AI 推理设备', exact: true }).selectOption('auto');
        await page.waitForTimeout(350);
        const before = report.modelRequests.length; const started = Date.now();
        const responsePromise = page.waitForResponse(response => /\/api\/matte$/.test(response.url()) && response.request().method() === 'POST', { timeout: 900000 });
        await page.getByRole('button', { name: '预览当前帧', exact: true }).click();
        const response = await responsePromise; expect(response.status()).toBe(200); expect(response.headers()['content-type']).toContain('image/png'); expect(response.headers()['x-matte-mode']).toBe(engine.mode);
        expect(report.modelRequests.length).toBe(before + 1);
        await expect.poll(() => page.evaluate(mode => window.__framecraftMatteLog.filter(entry => entry.mode === mode && entry.finished).length, engine.mode), { timeout: 30000 }).toBeGreaterThan(0);
        const captured = await page.evaluate(mode => window.__framecraftMatteLog.filter(entry => entry.mode === mode && entry.finished).at(-1), engine.mode);
        expect(captured.status).toBe(200); expect(captured.resolution).toBe('512'); expect(captured.birefnet_variant).toBe('standard');
        const body = Buffer.from(captured.bytes); expect(body.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        const responseFile = path.join(artifacts, `ai-${engine.mode}-response.png`); await fs.writeFile(responseFile, body); report.artifacts.push(responseFile);
        const preview = page.getByRole('img', { name: '抠图效果', exact: true }); await expect(preview).toBeVisible();
        await expect(page.getByRole('button', { name: '预览当前帧', exact: true })).toBeEnabled();
        const alpha = await preview.evaluate(async image => {
          await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let min = 255, max = 0, transparent = 0, opaque = 0, soft = 0;
          for (let index = 3; index < pixels.length; index += 4) { const alpha = pixels[index]; min = Math.min(min, alpha); max = Math.max(max, alpha); if (alpha === 0) transparent++; else if (alpha === 255) opaque++; else soft++; }
          return { width: canvas.width, height: canvas.height, min, max, transparent, opaque, soft, cornerAlpha: pixels[3] };
        });
        expect(alpha.min).toBe(0); expect(alpha.max).toBeGreaterThanOrEqual(250); expect(alpha.transparent).toBeGreaterThan(alpha.width * alpha.height * .1); expect(alpha.opaque).toBeGreaterThan(100); expect(alpha.soft).toBeGreaterThan(0); expect(alpha.height).toBe(480);
        const previewBytes = await preview.evaluate(async image => Array.from(new Uint8Array(await fetch(image.src).then(response => response.arrayBuffer()))));
        const previewFile = path.join(artifacts, `ai-${engine.mode}-preview.png`); await fs.writeFile(previewFile, Buffer.from(previewBytes)); report.artifacts.push(previewFile);
        await screenshot(`ai-${engine.mode}-desktop.png`);
        return { engine: engine.mode, resolution: 512, variant: 'standard', device: response.headers()['x-matte-device'], elapsedMs: Date.now() - started, responseBytes: body.length, ...alpha };
      });
    }
    await check('hybrid batch calls the AI processor for each generated frame', async () => {
      await page.locator('#start-frame').fill('1'); await page.locator('#end-frame').fill('5'); await page.locator('#stride').fill('4');
      await page.locator('#target-height').fill('160'); await page.locator('#padding').fill('0');
      await expect(page.locator('.engine-option.active strong')).toHaveText('BiRefNet + CorridorKey');
      const before = report.modelRequests.length; const capturedBefore = await page.evaluate(() => window.__framecraftMatteLog.length); const started = Date.now();
      await page.getByRole('button', { name: /^开始抽帧/ }).click();
      await expect(page.locator('.frame-card')).toHaveCount(2, { timeout: 900000 }); await expect(page.locator('.frame-card input:checked')).toHaveCount(2);
      const requests = report.modelRequests.slice(before); expect(requests).toHaveLength(2);
      for (const request of requests) expect(request.url).toMatch(/\/api\/matte$/);
      const capturedRequests = await page.evaluate(start => window.__framecraftMatteLog.slice(start).map(({ bytes, ...metadata }) => ({ ...metadata, responseBytes: bytes?.length })), capturedBefore);
      expect(capturedRequests).toHaveLength(2); for (const request of capturedRequests) { expect(request.mode).toBe('hybrid'); expect(request.status).toBe(200); expect(request.resolution).toBe('512'); expect(request.responseBytes).toBeGreaterThan(1000); }
      const alpha = await page.locator('.frame-card img').evaluateAll(async images => Promise.all(images.map(async image => {
        await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let min = 255, max = 0, transparent = 0, opaque = 0; for (let i = 3; i < pixels.length; i += 4) { min = Math.min(min, pixels[i]); max = Math.max(max, pixels[i]); if (pixels[i] === 0) transparent++; if (pixels[i] === 255) opaque++; }
        return { width: canvas.width, height: canvas.height, min, max, transparent, opaque };
      })));
      for (const frame of alpha) { expect(frame.min).toBe(0); expect(frame.max).toBe(255); expect(frame.transparent).toBeGreaterThan(100); expect(frame.opaque).toBeGreaterThan(100); expect(frame.height).toBe(160); }
      const output = path.join(artifacts, 'ai-hybrid-batch-review.png'); await page.locator('#step-3').screenshot({ path: output, animations: 'disabled' }); report.artifacts.push(output);
      return { frames: 2, aiMatteRequests: requests.length, elapsedMs: Date.now() - started, alpha, requests: capturedRequests };
    });
  } else console.log('Inference skipped. Use --infer only when the local model slot is reserved.');

  await check('AI controls fit the 390px mobile viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#step-4').scrollIntoViewIfNeeded();
    const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth })); expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
    await screenshot('ai-controls-mobile.png'); return width;
  });
  await check('no console, runtime, or failed network requests', async () => { expect(report.consoleErrors).toEqual([]); expect(report.pageErrors).toEqual([]); expect(report.networkFailures).toEqual([]); return { console: 0, runtime: 0, failedRequests: 0, modelRequests: report.modelRequests.length }; });
} finally {
  report.finished = new Date().toISOString(); report.passed = report.checks.filter(check => check.passed).length; report.failed = report.checks.filter(check => !check.passed).length;
  const output = path.join(artifacts, runInference ? 'ai-browser-report.json' : 'ai-controls-report.json'); await fs.writeFile(output, JSON.stringify(report, null, 2));
  await context.close(); console.log(JSON.stringify({ passed: report.passed, failed: report.failed, report: output, artifacts: report.artifacts }, null, 2));
  if (report.failed) process.exitCode = 1;
}
