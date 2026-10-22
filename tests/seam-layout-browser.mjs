import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';

const browser = await chromium.launch({ ...browserLaunchOptions(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.FRAMECRAFT_URL || 'http://127.0.0.1:8765');
  await expect(page.locator('#step-3 .frame-card').first()).toBeVisible();
  const titles = ['预览与截取区间', '抽帧设置', '检查帧与布局', '精细抠图', '动画帧选取与预览', 'Real-ESRGAN 平滑处理', '动画帧精度压缩'];
  await expect(page.locator('.workspace-section > .section-heading h2')).toHaveText(titles);
  await expect(page.locator('.section-number')).toHaveText(['01', '02', '03', '04', '05', '06', '07']);
  for (let index = 0; index < titles.length; index++) {
    await page.locator('.workflow-nav .step').nth(index).click();
    await expect(page.locator('.workflow-nav [aria-current="step"] .step-number')).toHaveText(String(index + 1).padStart(2, '0'));
    await expect.poll(() => page.locator(`#step-${index + 1}`).evaluate(node => Math.abs(node.getBoundingClientRect().top))).toBeLessThan(200);
  }
  await page.getByRole('button', { name: '使用指南', exact: true }).click();
  const help = page.getByRole('dialog');
  await expect(help.getByRole('heading', { name: '七步，做出你的动画素材' })).toBeVisible();
  await expect(help.locator('.help-steps > li')).toHaveCount(7);
  await expect(help).not.toContainText('首尾帧修正');
  await page.getByRole('button', { name: '关闭使用指南', exact: true }).click();
  await fs.mkdir('test-results', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('.workflow-nav').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.resolve('test-results', `seven-step-workflow-${width}.png`) });
    await page.locator('#step-3').scrollIntoViewIfNeeded();
    await expect(page.locator('#step-3 .frame-card').first()).toBeVisible();
    await page.locator('#step-3').screenshot({ path: path.resolve('test-results', `seven-step-review-${width}.png`) });
  }
  expect(errors).toEqual([]);
  console.log('PASS: seven consecutive sections and working navigation; updated help; desktop/mobile layouts fit.');
} finally {
  await browser.close();
}
