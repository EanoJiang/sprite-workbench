import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';
import builtInExample from './built-in-example.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selectedFrameCount = builtInExample.frames.filter(frame => frame.selected).length;
const tailCount = Math.min(3, Math.ceil(selectedFrameCount / 2));
const firstTailIndex = selectedFrameCount - tailCount;
const artifacts = path.join(root, 'test-results');
const temp = path.join(root, '.tmp', `seam-layout-${Date.now()}`);
await Promise.all([fs.mkdir(artifacts, { recursive: true }), fs.mkdir(temp, { recursive: true })]);
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
const report = { started: new Date().toISOString(), checks: [], pageErrors: [], consoleErrors: [], networkFailures: [], artifacts: [] };
const record = async (name, operation) => {
  try {
    const detail = await operation();
    report.checks.push({ name, passed: true, detail });
    console.log(`PASS ${name}: ${JSON.stringify(detail || {})}`);
    return detail;
  } catch (error) {
    report.checks.push({ name, passed: false, error: error?.stack || String(error) });
    throw error;
  }
};
const context = await chromium.launchPersistentContext(path.join(temp, 'user-data'), {
  ...browserLaunchOptions(), headless: true,
  viewport: { width: 1440, height: 1000 },
  args: [`--disk-cache-dir=${path.join(temp, 'disk-cache')}`, '--disable-crash-reporter', '--disable-features=msEdgeSidebarV2', '--no-first-run'],
  env: process.env,
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(30000);
page.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
page.on('response', response => { if (response.status() >= 400) report.networkFailures.push({ url: response.url(), status: response.status() }); });
page.on('requestfailed', request => {
  if (request.failure()?.errorText !== 'net::ERR_ABORTED') report.networkFailures.push({ url: request.url(), failure: request.failure()?.errorText });
});
const panel = page.locator('#step-4');
const comparison = panel.locator('.loop-correction-comparison');
const seam = panel.locator('.loop-correction-seam');
const stage = panel.locator('.loop-correction-seam-image');
const grid = panel.locator('.loop-correction-preview-grid');
const slider = panel.getByRole('slider', { name: '循环接缝预览帧', exact: true });
const toggle = page.locator('#loop-correction-enabled');
const shot = async filename => {
  const output = path.join(artifacts, filename);
  const closeToast = page.getByRole('button', { name: '关闭提示', exact: true });
  if (await closeToast.count()) await closeToast.click();
  await comparison.scrollIntoViewIfNeeded();
  await comparison.screenshot({ path: output, animations: 'disabled' });
  report.artifacts.push(output);
};
const assertHierarchy = async () => {
  const hierarchy = await comparison.evaluate(element => {
    const main = element.querySelector('.loop-correction-seam');
    const grid = element.querySelector('.loop-correction-preview-grid');
    const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom }; };
    return {
      seamBeforeGrid: !!(main.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING),
      main: rect(main), stage: rect(main.querySelector('.loop-correction-seam-image')),
      grid: rect(grid), images: Array.from(grid.querySelectorAll('.loop-correction-image'), rect),
    };
  });
  expect(hierarchy.seamBeforeGrid).toBe(true);
  expect(hierarchy.main.bottom).toBeLessThanOrEqual(hierarchy.grid.y + 1);
  expect(hierarchy.images).toHaveLength(3);
  for (const image of hierarchy.images) {
    expect(hierarchy.stage.height).toBeGreaterThan(image.height);
    expect(hierarchy.stage.width * hierarchy.stage.height).toBeGreaterThan(image.width * image.height);
    expect(image.y).toBeGreaterThanOrEqual(hierarchy.stage.bottom);
  }
  return hierarchy;
};
const seekTailEnd = async () => {
  await slider.focus();
  await slider.press('Home');
  for (let index = 1; index < tailCount; index++) await slider.press('ArrowRight');
  await expect(slider).toHaveValue(String(tailCount - 1));
  await expect(stage).toHaveAttribute('data-frame-index', String(selectedFrameCount - 1));
};

try {
  await page.goto(process.env.FRAMECRAFT_URL || 'http://127.0.0.1:8765', { waitUntil: 'networkidle' });
  await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length, { timeout: 90000 });
  await record('loop comparison is hidden until endpoint correction is enabled', async () => {
    await expect(comparison).toHaveCount(0);
    await toggle.check();
    await expect(comparison).toBeVisible();
    await expect(panel.locator('#loop-correction-status')).toHaveAttribute('data-state', 'ready', { timeout: 90000 });
    await toggle.uncheck();
    await expect(comparison).toHaveCount(0);
    return { hiddenWhenDisabled: true, visibleWhenEnabled: true };
  });
  await record('desktop seam stage precedes and exceeds all three endpoint comparison panes', async () => {
    await toggle.check();
    await expect(panel.locator('#loop-correction-status')).toHaveAttribute('data-state', 'ready', { timeout: 90000 });
    await expect(comparison.getByRole('heading', { name: '循环接缝预览', exact: true })).toBeVisible();
    await expect(panel.locator('.loop-correction-preview strong')).toHaveText(['首帧', '原始末帧', '修正末帧']);
    await panel.getByRole('button', { name: '暂停循环接缝预览', exact: true }).click();
    const detail = await assertHierarchy();
    await shot('seam-layout-desktop-original.png');
    return detail;
  });
  await record('seam playback pause, play and seek preserve their original behavior', async () => {
    await slider.focus(); await slider.press('Home');
    await expect(slider).toHaveValue('0');
    await expect(stage).toHaveAttribute('data-frame-index', String(firstTailIndex));
    await page.waitForTimeout(180);
    await expect(stage).toHaveAttribute('data-frame-index', String(firstTailIndex));
    await panel.getByRole('button', { name: '播放循环接缝预览', exact: true }).click();
    await expect.poll(async () => stage.getAttribute('data-frame-index')).not.toBe(String(firstTailIndex));
    await panel.getByRole('button', { name: '暂停循环接缝预览', exact: true }).click();
    await seekTailEnd();
    await expect(panel.getByRole('button', { name: '播放循环接缝预览', exact: true })).toBeVisible();
    const correctedLast = await panel.locator('[data-kind="corrected-last"] img').getAttribute('src');
    await expect(stage.locator('img')).toHaveAttribute('src', correctedLast);
    return { pausedIndex: firstTailIndex, originalTailIndex: selectedFrameCount - 1, seekPauses: true, playingAdvanced: true };
  });
  await record('main seam preview uses corrected and original output as the correction switch changes', async () => {
    await toggle.uncheck();
    await expect(comparison).toHaveCount(0);
    await toggle.check();
    await expect(panel.locator('#loop-correction-status')).toHaveAttribute('data-state', 'ready', { timeout: 90000 });
    await expect(comparison.locator('.loop-correction-preview-mode')).toHaveText('修正后');
    await seekTailEnd();
    const correctedLast = await panel.locator('[data-kind="corrected-last"] img').getAttribute('src');
    await expect(stage.locator('img')).toHaveAttribute('src', correctedLast);
    await shot('seam-layout-desktop-corrected.png');
    await toggle.uncheck();
    await expect(comparison).toHaveCount(0);
    return { correctedSourceMatches: true, hiddenWhenDisabled: true };
  });
  await record('endpoint overlay remains available beneath the enlarged seam stage', async () => {
    await toggle.check();
    await expect(panel.locator('#loop-correction-status')).toHaveAttribute('data-state', 'ready', { timeout: 90000 });
    const overlay = panel.getByRole('button', { name: '原始首尾叠加', exact: true });
    await overlay.click();
    await expect(overlay).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('.loop-correction-overlay')).toBeVisible();
    await overlay.click();
    await expect(panel.locator('.loop-correction-overlay')).toHaveCount(0);
    return { enabledAndDisabled: true };
  });
  await record('390px layout retains a larger upper seam stage and all endpoint panes without horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await comparison.scrollIntoViewIfNeeded();
    const hierarchy = await assertHierarchy();
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
    expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);
    await expect(panel.locator('.loop-correction-preview strong')).toHaveText(['首帧', '原始末帧', '修正末帧']);
    for (const pane of await panel.locator('.loop-correction-preview').all()) await expect(pane).toBeVisible();
    await shot('seam-layout-mobile-390.png');
    return { ...widths, hierarchy };
  });
  await record('browser has no runtime, console or failed network errors', async () => {
    expect(report.pageErrors).toEqual([]); expect(report.consoleErrors).toEqual([]); expect(report.networkFailures).toEqual([]);
    return { pageErrors: 0, consoleErrors: 0, networkFailures: 0 };
  });
} finally {
  report.finished = new Date().toISOString();
  report.passed = report.checks.filter(check => check.passed).length;
  report.failed = report.checks.filter(check => !check.passed).length;
  const output = path.join(artifacts, 'seam-layout-browser-report.json');
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  await context.close();
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, report: output }, null, 2));
  if (report.failed) process.exitCode = 1;
}
