import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';
import builtInExample from './built-in-example.mjs';

const tempRoot = fileURLToPath(new URL('../.tmp/', import.meta.url));
await fs.mkdir(tempRoot, { recursive: true });
const temp = await fs.mkdtemp(`${tempRoot}tuner-return-`);
const context = await chromium.launchPersistentContext(temp, {
  ...browserLaunchOptions(),
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ['--no-first-run', '--disable-crash-reporter', '--disable-features=msEdgeSidebarV2'],
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', error => errors.push(error.stack || error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

try {
  await page.goto('http://127.0.0.1:8765/?v=tuner-return#workbench', { waitUntil: 'networkidle' });
  await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length);
  const originalSize = await page.locator('.frame-card img').first().evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  const importResponse = page.waitForResponse(response => /\/api\/tuner\/import$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout: 90000 });
  await page.getByRole('button', { name: '发送到 XSXB 调参', exact: true }).click();
  await expect((await importResponse).ok()).toBe(true);
  const iframe = page.locator('iframe').last();
  await expect(iframe).toBeVisible();
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.waitForSelector('#save', { state: 'visible', timeout: 90000 });
  await frame.waitForFunction(() => Boolean(window.XsxbFrameTunerLite?.current()?.ready), undefined, { timeout: 90000 });
  await expect(page.getByRole('button', { name: '保存精调结果返回 05 动画帧选取与预览', exact: true })).toBeVisible();
  await frame.locator('#adjustGroup').check();
  const before = Number(await frame.locator('#baseX').inputValue());
  await frame.locator('button.numberStep[data-step-target="baseX"][data-step-dir="1"]').click();
  await expect(frame.locator('body')).toHaveClass(/hasUnsavedChanges/);
  await page.getByRole('button', { name: '保存精调结果返回 05 动画帧选取与预览', exact: true }).click();
  await expect(page.locator('#tab-workbench')).toHaveAttribute('aria-selected', 'true', { timeout: 120000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#workbench');
  await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.filter(frame => frame.selected).length);
  const returnedSize = await page.locator('.frame-card img').first().evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  expect(returnedSize).toEqual(originalSize);
  await expect.poll(() => page.locator('#step-5').evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(900);
  await expect(page.getByRole('button', { name: '保存精调结果返回 05 动画帧选取与预览', exact: true })).toHaveCount(0);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ passed: true, sourceOffset: before, returnedFrames: builtInExample.frames.filter(frame => frame.selected).length, originalSize, returnedSize }));
} finally {
  await context.close();
}

