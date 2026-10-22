import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { browserLaunchOptions } from './browser-options.mjs';
import { openPreviewExport, previewExportToggle } from './preview-export-controls.mjs';
import JSZip from 'jszip';

const temp = path.resolve('.tmp', `loop-removal-${Date.now()}`);
await fs.mkdir(temp, { recursive: true });
const browser = await chromium.launch({ ...browserLaunchOptions(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const fingerprint = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const endpoints = () => page.locator('#step-5 .sequence-frame img').evaluateAll(async images => Promise.all([images[0], images.at(-1)].map(async img => Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer()))))).then(bytes => bytes.map(fingerprint));
const save = async () => {
  const waiting = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/projects'));
  await page.getByRole('button', { name: '添加到帧动画项目列表', exact: true }).click();
  const response = await waiting;
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
};
try {
  await page.goto(process.env.FRAMECRAFT_URL || 'http://127.0.0.1:8765');
  await expect(page.locator('#step-5 .sequence-frame').first()).toBeVisible();
  await expect(page.locator('.workflow-nav .step')).toHaveCount(7);
  await expect(page.locator('#loop-correction-enabled, .loop-correction-panel')).toHaveCount(0);
  const original = await endpoints();
  expect(original[0]).not.toEqual(original[1]);
  await page.getByRole('textbox', { name: '项目目录', exact: true }).fill(temp);
  const saved = await save();
  const manifestPath = path.join(saved.path, 'project.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  expect(manifest.loopCorrection).toBeUndefined();
  const selected = manifest.frames.filter(frame => frame.selected !== false);
  // A real legacy project with a completed correction that replaced the last image.
  manifest.loopCorrection = { enabled: true, settings: { mode: 'match', transitionFrames: 4 }, frames: selected.map((frame, index) => index === selected.length - 1 ? { ...frame, file: selected[0].file } : frame) };
  const open = async () => {
    await page.getByRole('button', { name: '清空当前素材', exact: true }).click();
    await page.locator('.project-library').getByRole('button', { name: `打开项目 ${manifest.name}`, exact: true }).click();
    await expect(page.locator('#step-5 .sequence-frame')).toHaveCount(selected.length);
    await expect.poll(endpoints).toEqual(original);
    await expect(previewExportToggle(page)).toBeEnabled();
    await expect(page.getByRole('button', { name: '发送到 XSXB 调参', exact: true })).toBeEnabled();
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await open();
  const downloading = page.waitForEvent('download');
  await (await openPreviewExport(page, 'original', 'frames')).click();
  const downloaded = await downloading;
  const output = path.join(temp, 'frames.zip');
  await downloaded.saveAs(output);
  const zip = await JSZip.loadAsync(await fs.readFile(output));
  const exported = JSON.parse(await zip.file('manifest.json').async('string'));
  const first = await zip.file(exported.frames[0].filename).async('uint8array');
  const last = await zip.file(exported.frames.at(-1).filename).async('uint8array');
  expect(fingerprint(first)).toEqual(original[0]);
  expect(fingerprint(last)).toEqual(original[1]);
  // A pending legacy correction must not block exports or transfers either.
  manifest.loopCorrection.frames = null;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await open();
  // Saved smoothing may already contain the removed correction's replacement pixels.
  manifest.loopCorrection.frames = selected.map((frame, index) => index === selected.length - 1 ? { ...frame, file: selected[0].file } : frame);
  const smoothingCode = await fs.readFile('src/lib/smoothing.ts', 'utf8');
  const pipelineVersion = Number(smoothingCode.match(/SMOOTHING_PIPELINE_VERSION = (\d+)/)[1]);
  manifest.smoothing = { enabled: true, pipelineVersion, options: manifest.workspace.options, frames: manifest.loopCorrection.frames };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await open();
  await expect(page.locator('#smoothing-enabled')).not.toBeChecked();
  await page.locator('#animation-name').fill(`${manifest.name}_migrated`);
  const resaved = await save();
  const migrated = JSON.parse(await fs.readFile(path.join(resaved.path, 'project.json'), 'utf8'));
  expect(migrated.loopCorrection).toBeUndefined();
  expect(migrated.smoothing).toMatchObject({ enabled: false, frames: null });
  // Ordinary saved smoothing remains usable when legacy correction was disabled.
  manifest.loopCorrection.enabled = false;
  manifest.smoothing.frames = selected;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await open();
  await expect(page.locator('#smoothing-enabled')).toBeChecked();
  expect(errors).toEqual([]);
  console.log('PASS: seven-step workflow; legacy corrections and dependent smoothing discarded; original endpoints preserved in preview/export; new saves omit correction settings; ordinary smoothing still restores.');
} finally {
  await browser.close();
}
