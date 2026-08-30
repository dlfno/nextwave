import { expect, test, type Page } from '@playwright/test';

const password = process.env.DEMO_ACCOUNT_PASSWORD ?? 'nextwave-demo-2026';
const enabled = process.env.PERSISTED_DEMO === 'true';

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/auth');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page).toHaveURL(/\/intent$/);
}

test.describe('persisted judge rehearsal', () => {
  test.skip(!enabled, 'Set PERSISTED_DEMO=true and point PLAYWRIGHT_BASE_URL at the running stack.');

  test('persists purchase evidence and exposes role-scoped verification', async ({ browser, page }) => {
    await login(page, 'marta@nextwave.demo');
    await page.getByLabel('Purchase intention').fill(
      'Depart from Mexico City MEX to Córdoba, Argentina COR, departing 2026-09-15, one passenger, maximum $150 USD, valid until 2027-12-31. Require final confirmation.',
    );
    await page.getByRole('button', { name: 'Start conversation' }).click();
    await expect(page).toHaveURL(/\/agent\?intentId=[0-9a-f-]+$/);
    await page.getByRole('button', { name: 'Review mandate' }).click();
    await expect(page).toHaveURL(/\/mandates\/[0-9a-f-]+$/, { timeout: 15_000 });

    await page.getByRole('button', { name: 'Authorize mandate' }).click();
    await expect(page.getByText('Mandate signed and activated.')).toBeVisible();
    await page.getByRole('link', { name: 'Start discovery' }).click();
    const offer = page.locator('.offer-card').filter({ hasText: '$130.00' });
    await offer.getByRole('button', { name: 'Get live checkout' }).click();
    await expect(page.getByRole('heading', { name: 'Human approval required' })).toBeVisible();
    await page.getByRole('button', { name: 'Review and approve' }).click();
    await page.getByRole('button', { name: 'Approve checkout' }).click();
    await page.getByRole('button', { name: 'Pay $130.00' }).click();
    await expect(page.getByRole('heading', { name: 'Your agent completed the purchase.' })).toBeVisible();

    const records = await page.evaluate(async () => {
      const response = await fetch('/api/v1/transactions', { credentials: 'include' });
      if (!response.ok) throw new Error(`Transaction lookup failed: ${response.status}`);
      return response.json() as Promise<{ transactions: { id: string; attemptId: string }[] }>;
    });
    const transaction = records.transactions[0]!;
    await page.goto(`/transactions/${transaction.id}`);
    await expect(page.getByText('Signature present')).toBeVisible();
    await page.getByRole('button', { name: /Audit trail/ }).click();
    await expect(page.getByText('Chain verified')).toBeVisible();

    const merchantContext = await browser.newContext();
    const merchantPage = await merchantContext.newPage();
    await login(merchantPage, 'merchant@nextwave.demo');
    await expect(merchantPage.locator('.account')).toContainText('VuelaYa Operator');
    await merchantPage.goto(`/merchant-verification/${transaction.attemptId}`);
    await expect(merchantPage.getByText('Evidence chain verified')).toBeVisible();
    await merchantContext.close();

    const auditorContext = await browser.newContext();
    const auditorPage = await auditorContext.newPage();
    await login(auditorPage, 'auditor@nextwave.demo');
    await expect(auditorPage.locator('.account')).toContainText('Independent Auditor');
    await auditorPage.goto(`/auditor-evidence/${transaction.id}`);
    await expect(auditorPage.getByText('Evidence chain verified')).toBeVisible();
    await expect(auditorPage.getByText('Succeeded', { exact: true })).toBeVisible();
    await expect(auditorPage.getByText(/events exposed in this role projection/)).not.toContainText('0 events');
    await auditorContext.close();
  });
});
