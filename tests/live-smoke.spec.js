const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

function safeName(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
}

async function verificationShot(page, testInfo, checkpoint) {
  const dir = path.join(process.cwd(), 'verification-artifacts', safeName(testInfo.project.name));
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, safeName(checkpoint) + '.png'), fullPage: true });
}

test('WebbWraps catalog critical path', async ({ page }, testInfo) => {
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__APP_READY__ === true);
  await expect(page).toHaveTitle(/WebbWraps/i);
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Catalog Mode' })).toHaveClass(/active/);
  await verificationShot(page, testInfo, 'startup-catalog');

  await page.getByTestId('vehicle-picker').click();
  await page.getByText('Toyota', { exact: true }).click();
  await page.getByText('Camry', { exact: true }).click();
  await page.getByText(/2024 Toyota Camry/, { exact: true }).click();

  await expect(page.getByTestId('vehicle-picker')).toContainText('Toyota Camry');
  await expect(page.locator('#selection-summary')).toContainText(/Catalog (Image Loaded|Fallback Image)/, { timeout: 20_000 });
  await expect(page.getByTestId('vehicle-image')).toBeVisible();
  await verificationShot(page, testInfo, 'vehicle-selected');

  await page.getByTestId('swatch-trigger').click();
  await page.getByText('Satin Vampire Red', { exact: true }).click();
  await expect(page.locator('#color-name')).toContainText('3M — Satin Vampire Red');
  await verificationShot(page, testInfo, 'wrap-color-applied');

  await page.getByRole('button', { name: 'Live Photo Mode' }).click();
  await expect(page.locator('#panel-b')).toHaveClass(/active/);
  await verificationShot(page, testInfo, 'live-photo-mode');

  expect(browserErrors, 'Browser errors: ' + browserErrors.join('\n')).toEqual([]);
});
