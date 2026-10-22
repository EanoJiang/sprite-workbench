import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';
const browser = await chromium.launch({ ...browserLaunchOptions(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(process.env.FRAMECRAFT_URL || 'http://127.0.0.1:8765');
  await expect(page.locator('#step-3 .frame-card').first()).toBeVisible();
  const drop = (selector, names) => page.evaluate(({ selector, names }) => {
    const data = new DataTransfer();
    for (const name of names) {
      const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 64;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(12, 8, 24, 48);
      data.items.add(new File([Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0))], name, { type: 'image/png' }));
    }
    document.querySelector(selector).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    document.querySelector(selector).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, { selector, names });
  await drop('.media-import-zone', ['first_01.png', 'first_02.png']);
  const dialog = page.getByRole('dialog', { name: '为新项目命名', exact: true });
  await expect(dialog).toBeVisible();
  const name = dialog.getByRole('textbox', { name: '项目名', exact: true });
  await name.fill('');
  await expect(dialog.getByRole('button', { name: '确认名称', exact: true })).toBeDisabled();
  await name.press('Escape');
  await expect(dialog).toBeVisible();
  await name.fill('新的奔跑项目');
  await dialog.getByRole('button', { name: '确认名称', exact: true }).click();
  await expect(page.locator('#animation-name')).toHaveValue('新的奔跑项目');
  await expect(page.locator('#step-1 .frame-card')).toHaveCount(2);
  await page.locator('#step-1 .frame-card input').first().uncheck();
  const beforeIds = await page.locator('#step-1 .frame-card').evaluateAll(cards => cards.map(card => card.dataset.frameId));
  await drop('#step-1 .frame-list', ['extra_02.png', 'extra_01.png']);
  await expect(page.locator('#step-1 .frame-card')).toHaveCount(4);
  expect(await page.locator('#step-1 .frame-meta span').allTextContents()).toEqual(['first_01.png', 'first_02.png', 'extra_01.png', 'extra_02.png']);
  expect((await page.locator('#step-1 .frame-card').evaluateAll(cards => cards.map(card => card.dataset.frameId))).slice(0, 2)).toEqual(beforeIds);
  await expect(page.locator('#step-1 .frame-card input').first()).not.toBeChecked();
  await expect(page.locator('#animation-name')).toHaveValue('新的奔跑项目');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#step-3 .frame-card')).toHaveCount(4);
  await expect(page.locator('#step-5 .sequence-frame')).toHaveCount(3);
  await drop('body', ['outside.png']);
  await expect(page.locator('#step-1 .frame-card')).toHaveCount(4);
  const card = page.locator('#step-1 .frame-card').first();
  await card.hover();
  expect(await card.evaluate(el => ({ animation: getComputedStyle(el).animationName, transform: getComputedStyle(el).transform, transition: getComputedStyle(el).transitionDuration }))).toEqual({ animation: 'none', transform: 'none', transition: '0s' });
  await drop('.media-import-zone', ['replacement.png']);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '项目名', exact: true }).fill('另一个项目');
  await dialog.getByRole('button', { name: '确认名称', exact: true }).click();
  await expect(page.locator('#animation-name')).toHaveValue('另一个项目');
  await expect(page.locator('#step-3 .frame-card')).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log('PASS: new project naming required; batch append preserves names, IDs, selection and order; outside drops ignored; frame cards static.');
} finally { await browser.close(); }
