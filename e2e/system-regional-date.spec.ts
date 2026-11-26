import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test.use({ locale: 'pt-PT' });

test('English desktop uses the Portuguese regional date in Settings, task rows and date entry', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'meeting', title: 'Prepare for meeting', status: 'waiting', dueDate: '2030-11-23' }],
        settings: { language: 'en', dateFormat: 'system' },
    });
    await page.goto('/?view=settings');
    await page.locator('[data-settings-section="regionalFormats"]').click();
    const preview = await page.evaluate(() => new Date().toLocaleDateString('pt-PT'));
    await expect(page.locator('[data-settings-key="dateFormat"] option:checked')).toContainText(preview);
    await page.locator('[data-sidebar-item][data-view="waiting"]').click();
    await page.getByRole('button', { name: 'Show details', exact: true }).click();
    await expect(page.getByText('23/11/2030', { exact: true })).toBeVisible();
    await page.getByText('Prepare for meeting', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Dates…', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Due Date…', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Due Date', exact: true })).toHaveValue('23/11/2030');
});
