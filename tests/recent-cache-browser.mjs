import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';
import builtInExample from './built-in-example.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.FRAMECRAFT_URL || 'http://127.0.0.1:8765';
const temp = path.join(root, '.tmp', `recent-cache-${Date.now()}`);
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
const names = builtInExample.frames.map(frame => frame.name);
const selected = builtInExample.frames.filter(frame => frame.selected).length;
const assertBuiltInExample = async () => {
  await expect(page.locator('.frame-card')).toHaveCount(builtInExample.frames.length);
  await expect(page.locator('.frame-card .frame-meta span')).toHaveText(names);
  await expect(page.locator('.frame-card input:checked')).toHaveCount(selected);
  expect(await page.locator('.frame-card input').evaluateAll(inputs => inputs.map(input => input.checked))).toEqual(builtInExample.frames.map(frame => frame.selected));
  await expect(page.locator('#animation-name')).toHaveValue(builtInExample.animationName);
  await expect(page.locator('#animation-fps')).toHaveValue(String(builtInExample.fps));
  const sourceName = builtInExample.source?.name || builtInExample.frames[0].name;
  await expect(page.locator('.file-details strong')).toHaveText(`内置示例 · ${sourceName}`);
  const media = page.locator(builtInExample.source?.type.startsWith('video/') ? '.media-stage video' : '.media-stage img');
  await expect(media).toBeVisible();
  await expect.poll(() => media.evaluate(element => element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth)).toBeGreaterThan(0);
  const manifestUrl = new URL('built-in-example/manifest.json', base);
  expect(await page.locator('.frame-card img').evaluateAll(images => images.map(image => image.src))).toEqual(builtInExample.frames.map(frame => new URL(frame.file, manifestUrl).href));
};

try {
  await page.goto(`${base}/?v=fixed-example#workbench`, { waitUntil: 'networkidle' });
  await assertBuiltInExample();
  const png = await fs.readFile(path.join(root, 'public', 'demo-reference.png'));
  await page.locator('#workbench-frames-input').setInputFiles([
    { name: 'cached_case_01.png', mimeType: 'image/png', buffer: png },
    { name: 'cached_case_02.png', mimeType: 'image/png', buffer: png },
    { name: 'cached_case_03.png', mimeType: 'image/png', buffer: png },
  ]);
  await expect(page.locator('.frame-card')).toHaveCount(3);
  await expect(page.locator('.frame-card .frame-meta span')).toHaveText(['cached_case_01.png', 'cached_case_02.png', 'cached_case_03.png']);

  // Simulate the former latest-import cache, including its distinct FPS and name.
  // Startup must ignore it even when a valid record survives an application upgrade.
  await page.evaluate(async ({ encoded, width, height }) => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    const request = indexedDB.open('sprite-workbench-cache', 1);
    const database = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => request.result.createObjectStore('recent-preview');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('recent-preview', 'readwrite');
        transaction.objectStore('recent-preview').put({
          version: 1, savedAt: Date.now(), animationName: 'cached_animation', fps: 24,
          frames: Array.from({ length: 3 }, (_, index) => ({
            id: `cached-${index + 1}`, name: `cached_case_0${index + 1}.png`, sourceIndex: index + 1,
            time: index / 24, width, height, selected: true, blob,
          })),
        }, 'latest');
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, { encoded: png.toString('base64'), width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  await page.reload({ waitUntil: 'networkidle' });
  await assertBuiltInExample();

  await page.locator('#animation-name').fill('temporary_animation');
  await page.getByRole('spinbutton', { name: '动画预览帧率', exact: true }).fill('24');
  await page.getByRole('button', { name: '反转顺序', exact: true }).click();
  await expect(page.locator('.frame-card .frame-meta span')).toHaveText([...names].reverse());
  await page.getByRole('button', { name: '奇数帧', exact: true }).click();
  await expect(page.locator('.frame-card input:checked')).toHaveCount(Math.ceil(names.length / 2));
  await page.reload({ waitUntil: 'networkidle' });
  await assertBuiltInExample();

  await page.getByRole('button', { name: '清空帧列表', exact: true }).click();
  await expect(page.locator('.frame-card')).toHaveCount(0);
  await page.reload({ waitUntil: 'networkidle' });
  await assertBuiltInExample();
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, builtInFrames: names.length, legacyCacheIgnored: true, importedFramesIgnoredOnReload: true, editsResetOnReload: true, clearResetOnReload: true }));
} finally {
  await context.close();
}
