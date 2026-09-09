import { test, expect } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('advanced AI timeout persists and settings search reveals it', async ({ page }, testInfo) => {
    await page.route('http://localhost:11434/**', (route) => route.fulfill({ json: { data: [] } }));
    await dismissOnboarding(page);
    await seedAppData(page, { settings: { ai: {
        enabled: false,
        provider: 'openai',
        model: 'local-test-model',
        baseUrl: 'http://localhost:11434/v1',
    } } });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'AI assistant', exact: true }).click();
    await page.locator('button[data-settings-key="aiEnable"]').click();
    const timeout = page.getByRole('combobox', { name: 'Request timeout', exact: true });
    await expect(timeout).not.toBeVisible();
    await page.locator('button[data-settings-section="aiRequestTimeout"]').click();
    await expect(timeout).toHaveValue('30');
    await expect(timeout.locator('option')).toHaveText(['30 seconds', '60 seconds', '120 seconds', '300 seconds']);
    await timeout.selectOption('120');
    await expect.poll(() => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}');
        return data.settings?.ai;
    })).toMatchObject({
        requestTimeoutSeconds: 120,
        enabled: false,
        provider: 'openai',
        model: 'local-test-model',
        baseUrl: 'http://localhost:11434/v1',
    });
    await page.screenshot({ path: testInfo.outputPath('ai-timeout.png') });

    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('combobox', { name: /search settings/i }).fill('Request timeout');
    await page.getByRole('option', { name: /Request timeout/i }).click();
    await expect(timeout).toBeVisible();
    await expect(timeout).toHaveValue('120');
});
