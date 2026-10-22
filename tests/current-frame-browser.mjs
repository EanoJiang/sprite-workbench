import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';
import builtInExample from './built-in-example.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-results');
const temp = path.join(root, '.tmp', `current-frame-${Date.now()}`);
await Promise.all([fs.mkdir(artifacts, { recursive: true }), fs.mkdir(temp, { recursive: true })]);
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
const fixture = path.join(artifacts, 'current-frame-30fps.mp4');
const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=30:d=3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', fixture], { encoding: 'utf8', env: process.env });
if (ffmpeg.status !== 0) throw new Error(ffmpeg.stderr || ffmpeg.error || 'Video fixture generation failed');

const report = { started: new Date().toISOString(), checks: [], consoleErrors: [], pageErrors: [], networkFailures: [], artifacts: [fixture] };
const context = await chromium.launchPersistentContext(path.join(temp, 'user-data'), {
  ...browserLaunchOptions(), headless: true,
  viewport: { width: 1440, height: 1000 },
  args: [`--disk-cache-dir=${path.join(temp, 'disk-cache')}`, '--disable-crash-reporter', '--disable-features=msEdgeSidebarV2', '--no-first-run'], env: process.env,
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(30000);
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
page.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
page.on('response', response => { if (response.status() >= 400) report.networkFailures.push({ status: response.status(), url: response.url() }); });
page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') report.networkFailures.push({ url: request.url(), failure: request.failure()?.errorText }); });

const record = async (name, operation) => {
  try { const detail = await operation(); report.checks.push({ name, passed: true, detail }); console.log(`PASS ${name}: ${JSON.stringify(detail)}`); }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack || String(error) }); throw error; }
};
const range = async () => ({ start: +await page.locator('#start-frame').inputValue(), end: +await page.locator('#end-frame').inputValue() });
const startButton = page.locator('#set-start-current-frame');
const endButton = page.locator('#set-end-current-frame');
const slider = page.getByRole('slider', { name: '视频播放位置', exact: true });
const video = page.locator('.media-stage video');
const seekFrame = async frame => {
  // Set an exact native range value, with the same input event emitted by a pointer seek.
  await slider.evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, frame);
  await expect.poll(() => video.evaluate(element => element.seeking)).toBe(false);
  await expect(slider, `Requested frame ${frame}; video time ${await video.evaluate(element => element.currentTime)}`).toHaveValue(String(frame));
};
const shot = async filename => {
  const output = path.join(artifacts, filename);
  await page.locator('#step-1').scrollIntoViewIfNeeded();
  await page.locator('#step-1').screenshot({ path: output, animations: 'disabled' });
  report.artifacts.push(output);
};

try {
  await page.goto(process.env.FRAMECRAFT_URL || 'http://127.0.0.1:8765', { waitUntil: 'networkidle' });
  await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length, { timeout: 90000 });
  await page.locator('#workbench-media-input').setInputFiles(fixture);
  await expect(page.locator('.file-details strong')).toContainText('current-frame-30fps.mp4');
  await page.getByRole('dialog', { name: '为动画片段命名', exact: true }).getByRole('button', { name: '使用原文件名', exact: true }).click();
  await expect(page.locator('#end-frame')).toHaveValue('90');
  await expect(startButton).toHaveAccessibleName('将当前预览帧设为起始帧');
  await expect(endButton).toHaveAccessibleName('将当前预览帧设为结束帧');
  await expect(page.locator('#loop-animation, #loop-range-status, .loop-range-controls')).toHaveCount(0);

  await record('rapid progress-bar keyboard steps preserve the requested frame number', async () => {
    await slider.focus();
    await slider.press('Home');
    for (let count = 0; count < 13; count++) await slider.press('ArrowRight', { noWaitAfter: true });
    await expect.poll(() => video.evaluate(element => element.seeking)).toBe(false);
    await expect(slider).toHaveValue('14');
    return { requestedFrame: 14, currentTime: await video.evaluate(element => element.currentTime) };
  });
  await record('paused progress-bar frame 14 sets the start without moving the end', async () => {
    await seekFrame(14);
    await startButton.click();
    await expect(page.locator('#start-frame')).toHaveValue('14');
    expect(await range()).toEqual({ start: 14, end: 90 });
    await expect(slider).toHaveValue('14');
    await expect(video).toHaveJSProperty('paused', true);
    return { ...await range(), currentTime: await video.evaluate(element => element.currentTime) };
  });
  await record('paused progress-bar frame 44 sets the end without moving the start', async () => {
    await seekFrame(44);
    await endButton.click();
    await expect(page.locator('#end-frame')).toHaveValue('44');
    expect(await range()).toEqual({ start: 14, end: 44 });
    await expect(slider).toHaveValue('44');
    await shot('current-frame-desktop.png');
    return { ...await range(), currentTime: await video.evaluate(element => element.currentTime) };
  });
  await record('choosing a frame during playback pauses and freezes the captured bound', async () => {
    await seekFrame(20);
    await page.getByRole('button', { name: '播放选定区间', exact: true }).click();
    await expect(video).toHaveJSProperty('paused', false);
    await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(0.75);
    await startButton.click();
    await expect(video).toHaveJSProperty('paused', true);
    await expect(page.getByRole('button', { name: '播放选定区间', exact: true })).toBeVisible();
    const chosen = await range();
    expect(chosen.start).toBeGreaterThanOrEqual(20);
    expect(chosen.start).toBeLessThanOrEqual(44);
    expect(chosen.end).toBe(44);
    await expect.poll(() => video.evaluate(element => element.currentTime)).toBeCloseTo((chosen.start - 1) / 30, 5);
    await expect(slider).toHaveValue(String(chosen.start));
    await page.waitForTimeout(180);
    await expect(slider).toHaveValue(String(chosen.start));
    return { ...chosen, frozen: true };
  });
  await record('selecting the opposite endpoint permits a valid single-frame interval', async () => {
    await seekFrame(44);
    await startButton.click();
    expect(await range()).toEqual({ start: 44, end: 44 });
    await endButton.click();
    expect(await range()).toEqual({ start: 44, end: 44 });
    return await range();
  });
  await record('both current-frame controls remain usable at a 390 pixel viewport', async () => {
    await page.locator('#start-frame').fill('1');
    await page.locator('#end-frame').fill('90');
    await page.setViewportSize({ width: 390, height: 844 });
    await seekFrame(44);
    await endButton.click();
    expect(await range()).toEqual({ start: 1, end: 44 });
    await expect(startButton).toBeVisible();
    await expect(endButton).toBeVisible();
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
    expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport + 1);
    await shot('current-frame-mobile-390.png');
    return dimensions;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await record('manual range and current-frame choices remain unchanged without automatic cycle detection', async () => {
    await page.locator('#start-frame').fill('10');
    await page.locator('#end-frame').fill('60');
    await page.locator('#end-frame').blur();
    await seekFrame(30);
    await startButton.click();
    expect(await range()).toEqual({ start: 30, end: 60 });
    await page.waitForTimeout(1000);
    expect(await range()).toEqual({ start: 30, end: 60 });
    await expect(page.locator('#loop-animation, #loop-range-status, .loop-range-controls')).toHaveCount(0);
    await expect(page.locator('#loop-correction-enabled')).toHaveCount(0);
    await shot('manual-range-desktop.png');
    return { ...await range(), stableAfterMs: 1000, automaticDetectionRemoved: true, correctionRemoved: true };
  });
  await record('single-image source disables both current-frame controls', async () => {
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 48;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#29a387'; ctx.fillRect(0, 0, 48, 48);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#workbench-media-input').setInputFiles({ name: 'current-frame-still.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await expect(page.locator('.file-details strong')).toContainText('current-frame-still.png');
    await expect(startButton).toBeDisabled();
    await expect(endButton).toBeDisabled();
    expect(await range()).toEqual({ start: 1, end: 1 });
    return { startDisabled: true, endDisabled: true };
  });
  await record('focused current-frame selection produces no browser or network errors', async () => {
    expect(report.consoleErrors).toEqual([]); expect(report.pageErrors).toEqual([]); expect(report.networkFailures).toEqual([]);
    return { consoleErrors: 0, pageErrors: 0, networkFailures: 0 };
  });
} finally {
  report.finished = new Date().toISOString();
  report.passed = report.checks.filter(check => check.passed).length;
  report.failed = report.checks.filter(check => !check.passed).length;
  await fs.writeFile(path.join(artifacts, 'current-frame-report.json'), JSON.stringify(report, null, 2));
  await context.close();
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, report: path.join(artifacts, 'current-frame-report.json') }));
  if (report.failed) process.exitCode = 1;
}
