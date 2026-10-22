import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';

const browser = await chromium.launch({ ...browserLaunchOptions(), headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.FRAMECRAFT_URL || 'http://127.0.0.1:8765');
  await expect(page.locator('#step-3 .frame-card').first()).toBeVisible();
  const original = await page.locator('.source-header-file dd').textContent();
  const dispatch = (selector, type, name) => page.evaluate(({ selector, type, name }) => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 24;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 16, 24);
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], name, { type: 'image/png' }));
    const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data });
    document.querySelector(selector).dispatchEvent(event);
    return { prevented: event.defaultPrevented, effect: data.dropEffect };
  }, { selector, type, name });
  for (const selector of ['body', '.hero > div:first-child', '#step-1', '#step-3 .frame-list', '.project-library']) {
    const over = await dispatch(selector, 'dragover', 'outside.png');
    expect(over.prevented).toBe(true);
    expect(over.effect).toBe('none');
    await expect(page.locator('.drop-overlay')).toHaveCount(0);
    const drop = await dispatch(selector, 'drop', 'outside.png');
    expect(drop.prevented).toBe(true);
    await expect(page.locator('.source-header-file dd')).toHaveText(original);
    await expect(page.locator('#media-import-trigger')).toBeEnabled();
  }
  await dispatch('#media-import-hint', 'dragover', 'inside-hint.png');
  await expect(page.locator('.media-import-zone')).toHaveClass(/is-dragover/);
  await dispatch('#media-import-hint', 'drop', 'inside-hint.png');
  await expect(page.locator('.source-header-file dd')).toHaveText('inside-hint.png');
  await page.getByRole('dialog', { name: '为新项目命名', exact: true }).getByRole('button', { name: '确认名称', exact: true }).click();
  await expect(page.locator('.media-import-zone')).not.toHaveClass(/is-dragover/);
  await dispatch('#media-import-trigger', 'dragover', 'inside-button.png');
  await dispatch('#media-import-trigger', 'drop', 'inside-button.png');
  await expect(page.locator('.source-header-file dd')).toHaveText('inside-button.png');
  await page.getByRole('dialog', { name: '为新项目命名', exact: true }).getByRole('button', { name: '确认名称', exact: true }).click();
  await dispatch('body', 'drop', 'outside-after-import.png');
  await expect(page.locator('.source-header-file dd')).toHaveText('inside-button.png');
  expect(errors).toEqual([]);
  console.log('PASS: only import button/hint area accepts files; page/body/review reject drops without navigation or overlays.');
} finally { await browser.close(); }
