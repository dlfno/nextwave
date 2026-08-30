import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'PRESENTATION_MODE', message: 'API intentionally unavailable' } }),
  }));
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('nextwave_demo_mandate_status'));
});

test('completes the $130 checkout only after human approval', async ({ page }) => {
  await page.goto('/commerce/demo');
  const offer = page.locator('.offer-card').filter({ hasText: 'USD 130.00' });
  await offer.getByRole('button', { name: 'Get live checkout' }).click();

  await expect(page.getByRole('heading', { name: 'Human approval required' })).toBeVisible();
  await expect(page.getByText('HUMAN_APPROVAL_REQUIRED')).toBeVisible();
  await page.getByRole('button', { name: 'Review and approve' }).click();
  await expect(page.getByRole('heading', { name: 'Approve this purchase?' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve checkout' }).click();

  await expect(page.getByRole('heading', { name: 'Authorized to pay' })).toBeVisible();
  await page.getByRole('button', { name: 'Pay $130.00' }).click();
  await expect(page.getByRole('heading', { name: 'Your agent completed the purchase.' })).toBeVisible();
  await expect(page.getByText('VY-ORDER-84M2Q')).toBeVisible();
});

test('rejects the $300 offer with a deterministic amount reason', async ({ page }) => {
  await page.goto('/commerce/demo');
  const offer = page.locator('.offer-card').filter({ hasText: 'USD 300.00' });
  await offer.getByRole('button', { name: 'Get live checkout' }).click();

  await expect(page.getByRole('heading', { name: 'Purchase denied' })).toBeVisible();
  await expect(page.getByText('AMOUNT_EXCEEDS_MANDATE')).toBeVisible();
  await expect(page.getByRole('button', { name: /Pay/ })).toHaveCount(0);
});

test('live revocation makes the next otherwise-valid attempt fail', async ({ page }) => {
  await page.goto('/mandates/demo');
  await page.getByRole('button', { name: 'Authorize mandate' }).click();
  await expect(page.getByText('Mandate signed and activated.')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke mandate' }).click();
  await page.getByRole('button', { name: 'Revoke immediately' }).click();
  await expect(page.getByText('Every later purchase attempt will fail.')).toBeVisible();

  await page.goto('/commerce/demo');
  const offer = page.locator('.offer-card').filter({ hasText: 'USD 130.00' });
  await offer.getByRole('button', { name: 'Get live checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Purchase denied' })).toBeVisible();
  await expect(page.getByText('MANDATE_REVOKED')).toBeVisible();
  await expect(page.locator('.session-state')).toContainText('Mandate revoked');
});

test('reconstructs human, merchant, auditor, and dispute evidence', async ({ page }) => {
  await page.goto('/transactions/demo');
  await expect(page.getByRole('heading', { name: /Córdoba/ })).toBeVisible();
  await page.getByRole('button', { name: /Audit trail/ }).click();
  await expect(page.getByText('Chain verified')).toBeVisible();

  await page.goto('/merchant-verification/demo');
  await expect(page.getByRole('heading', { name: 'Was this agent authorized?' })).toBeVisible();
  await expect(page.getByText('Evidence chain verified')).toBeVisible();

  await page.goto('/auditor-evidence/demo');
  await expect(page.getByRole('heading', { name: 'Reconstruct every decision.' })).toBeVisible();
  await expect(page.getByText('Active, version 1')).toBeVisible();

  await page.goto('/disputes/demo-dispute');
  await expect(page.getByRole('heading', { name: 'Authority under review.' })).toBeVisible();
  await expect(page.getByText('Merchant evidence supported')).toBeVisible();
});
