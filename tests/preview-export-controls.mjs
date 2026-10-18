import { expect } from '@playwright/test';

const labels = { original: '原始帧', processed: '压缩帧' };

export const previewExportToggle = (page, side = 'original') => page.locator(`#step-8 .compression-preview-pane[data-kind="${side}"]`).getByRole('button', { name: `${labels[side]}导出`, exact: true });

/** Export through the same preview card whose pixels the regression inspects. */
export async function openPreviewExport(page, side, mode) {
  const pane = page.locator(`#step-8 .compression-preview-pane[data-kind="${side}"]`);
  const toggle = previewExportToggle(page, side);
  await expect(toggle).toBeEnabled({ timeout: 90000 });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const button = pane.locator(`[data-export-mode="${mode}"]`);
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled({ timeout: 90000 });
  return button;
}
