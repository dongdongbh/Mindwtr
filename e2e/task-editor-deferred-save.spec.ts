import { expect, test } from '@playwright/test';
import { dismissOnboarding, localDateKey, seedAppData } from './seed';

for (const presentation of ['inline', 'modal']) {
    test(`${presentation} editor releases a task moved to Upcoming after saving`, async ({ page }) => {
        await dismissOnboarding(page);
        await seedAppData(page, {
            tasks: [
                { id: 'defer-me', title: 'Defer this task', status: 'next', contexts: ['@work'] },
                { id: 'edit-me', title: 'Edit another task', status: 'next', contexts: ['@work'] },
                { id: 'future-task', title: 'Already deferred', status: 'next', startTime: localDateKey(2) },
            ],
            settings: { keybindingStyle: 'standard', gtd: { taskEditor: { presentation } } },
        });
        await page.goto('/?view=agenda');
        await page.getByRole('combobox', { name: 'Group', exact: true }).click();
        await page.getByRole('option', { name: 'Context', exact: true }).click();
        await page.locator('button[aria-controls="agenda-section-upcoming"]').click();
        await page.getByText('Defer this task', { exact: true }).dblclick();
        const title = page.getByRole('combobox', { name: 'Title', exact: true });
        await title.fill('Defer this task /start:tomorrow');
        await page.getByRole('option', { name: '/start:tomorrow', exact: true }).click();
        await expect(title).toHaveValue('Defer this task');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(title).toHaveCount(0);
        await expect(page.locator('#agenda-section-nextActions [data-task-id="defer-me"]')).toHaveCount(0);
        await page.getByRole('button', { name: 'Toggle task details: Edit another task', exact: true }).focus();
        await page.keyboard.press('Shift+Enter');
        await expect(title).toHaveValue('Edit another task');
        await title.press('Escape');
        await expect(title).toHaveCount(0);
        await page.getByRole('button', { name: 'Toggle task details: Edit another task', exact: true }).focus();
        await page.keyboard.press('Shift+Enter');
        await expect(title).toHaveValue('Edit another task');
        await title.press('Escape');
        await page.locator('button[aria-controls="agenda-section-upcoming"]').click();
        await expect(page.locator('#agenda-section-upcoming [data-task-id="defer-me"]')).toBeVisible();
        await expect(title).toHaveCount(0);
    });
}
