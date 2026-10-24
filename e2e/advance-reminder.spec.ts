import { expect, test } from '@playwright/test';
import { dismissOnboarding, localDateKey, seedAppData } from './seed';

for (const presentation of ['inline', 'modal']) {
    test(`advance reminder saves and clears in the ${presentation} editor`, async ({ page, context }, testInfo) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await dismissOnboarding(page);
        await seedAppData(page, {
            tasks: [{ id: 'advance-task', title: 'Friday appointment', status: 'inbox', dueDate: `${localDateKey(7)}T09:00:00` }],
            settings: { gtd: { taskEditor: { presentation } } },
        });
        await page.goto('/');
        await page.locator('[data-sidebar-item][data-view="inbox"]').click();
        await page.getByText('Friday appointment', { exact: true }).dblclick();
        const advance = page.getByRole('combobox', { name: 'Advance reminder', exact: true });
        if (!await advance.isVisible()) await page.getByRole('button', { name: /^Start\/due reminders:/ }).click();
        await expect(advance).toHaveValue('0');
        await advance.selectOption('2880');
        await advance.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`advance-${presentation}.png`) });
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') || '{}').tasks?.find((t: { id: string }) => t.id === 'advance-task')?.dueReminderLeadMinutes)).toBe(2880);

        // A new page reads the saved document without rerunning the seed script.
        await page.close();
        const reopened = await context.newPage();
        await reopened.goto('/');
        await reopened.locator('[data-sidebar-item][data-view="inbox"]').click();
        await reopened.getByText('Friday appointment', { exact: true }).dblclick();
        const saved = reopened.getByRole('combobox', { name: 'Advance reminder', exact: true });
        if (!await saved.isVisible()) await reopened.getByRole('button', { name: /^Start\/due reminders:/ }).click();
        await expect(saved).toHaveValue('2880');
        await saved.selectOption('0');
        await reopened.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(() => reopened.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') || '{}').tasks?.find((t: { id: string }) => t.id === 'advance-task')?.dueReminderLeadMinutes)).toBe(0);
    });
}
