import { expect, test } from '@playwright/test';
import { dismissOnboarding, localDateKey, seedAppData } from './seed';

for (const presentation of ['inline', 'modal']) {
    test(`date-only reminders remain date-only in the ${presentation} editor`, async ({ page }, testInfo) => {
        const dueDate = localDateKey(7);
        await dismissOnboarding(page);
        await seedAppData(page, {
            tasks: [{ id: 'date-only', title: 'Date-only appointment', status: 'inbox', dueDate }],
            settings: { dateOnlyDueReminderTime: '09:00', gtd: { taskEditor: { presentation } } },
        });
        await page.goto('/');
        await page.locator('[data-sidebar-item][data-view="inbox"]').click();
        await page.getByText('Date-only appointment', { exact: true }).dblclick();
        const policy = page.getByRole('combobox', { name: 'Start/due reminders', exact: true });
        if (!await policy.isVisible()) await page.getByRole('button', { name: /^Start\/due reminders:/ }).click();
        await expect(page.getByText(/Due reminder: 09:00 · date-only default/)).toBeVisible();
        const advance = page.getByRole('combobox', { name: 'Advance reminder', exact: true });
        await expect(advance).toBeEnabled();
        await advance.selectOption('1440');
        await policy.selectOption('skip');
        await expect(advance).toBeDisabled();
        await policy.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`date-only-${presentation}.png`) });
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(() => page.evaluate(() => {
            const task = JSON.parse(localStorage.getItem('mindwtr-data') || '{}').tasks?.find((entry: { id: string }) => entry.id === 'date-only');
            return { dueDate: task?.dueDate, reminderPolicy: task?.reminderPolicy, lead: task?.dueReminderLeadMinutes };
        })).toEqual({ dueDate, reminderPolicy: 'skip', lead: 1440 });
    });
}

test('date-only reminder settings persist independently without editing tasks', async ({ page }, testInfo) => {
    const dueDate = localDateKey(7);
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'unchanged', title: 'Leave dates alone', status: 'inbox', dueDate }],
        settings: { timeFormat: '24h' },
    });
    await page.goto('/?view=settings');
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    const start = page.getByRole('textbox', { name: 'Date-only start reminders', exact: true });
    const due = page.getByRole('textbox', { name: 'Date-only due reminders', exact: true });
    await expect(start).toHaveValue('');
    await expect(due).toHaveValue('');
    await due.fill('09:00');
    await due.press('Tab');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') || '{}').settings?.dateOnlyDueReminderTime)).toBe('09:00');
    await start.fill('08:00');
    await start.press('Tab');
    await page.getByRole('button', { name: 'Date-only due reminders: Off', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data') || '{}');
        return { start: data.settings?.dateOnlyStartReminderTime, due: data.settings?.dateOnlyDueReminderTime, date: data.tasks?.find((entry: { id: string }) => entry.id === 'unchanged')?.dueDate };
    })).toEqual({ start: '08:00', due: '', date: dueDate });
    await page.screenshot({ path: testInfo.outputPath('date-only-settings.png') });
});
