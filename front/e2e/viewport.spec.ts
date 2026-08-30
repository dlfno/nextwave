import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'PRESENTATION_MODE', message: 'API intentionally unavailable' } }),
  }));
});

for (const route of ['/intent', '/mandates/demo', '/commerce/demo', '/activity']) {
  test(`${route} has no horizontal viewport overflow`, async ({ page }) => {
    await page.goto(route);
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
    await expect(page.locator('app-nav')).toBeVisible();
  });
}
