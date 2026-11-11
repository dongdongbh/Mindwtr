import { expect, test } from '@playwright/test';
import { dismissOnboarding, localDateKey, seedAppData } from './seed';

test.beforeEach(async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {});
    await page.goto('/');
    await page.locator('[data-sidebar-item][data-view="inbox"]').click();
});

test('quick add previews and persists both advance reminders', async ({ page }, testInfo) => {
    const input = page.getByPlaceholder(/add task/i);
    await input.fill(`Reminder syntax task /start:${localDateKey(3)} 10am /remind-start:30m /due:${localDateKey(4)} 3pm /remind-due:1d`);
    const preview = page.getByTestId('quick-add-preview');
    await expect(preview).toContainText('Before start');
    await expect(preview).toContainText('30 min before');
    await expect(preview).toContainText('Advance reminder');
    await expect(preview).toContainText('1 day before');
    await page.screenshot({ path: testInfo.outputPath('reminder-syntax-preview.png') });
    await input.press('Escape');
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => {
        const task = JSON.parse(localStorage.getItem('mindwtr-data') || '{}').tasks?.find((item: { title: string }) => item.title === 'Reminder syntax task');
        return task && { due: task.dueReminderLeadMinutes, start: task.startReminderLeadMinutes };
    })).toEqual({ due: 1440, start: 30 });
    await page.reload();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') || '{}').tasks?.find((item: { title: string }) => item.title === 'Reminder syntax task')?.dueReminderLeadMinutes)).toBe(1440);
});

for (const invalid of ['/due:tomorrow /remind-due:1d', '/start:tomorrow 10am /remind-start:2h', '/remind:tomorrow 5pm']) {
    test(`quick add refuses unsupported reminder ${invalid}`, async ({ page }) => {
        const input = page.getByPlaceholder(/add task/i);
        const text = `Invalid reminder task ${invalid}`;
        await input.fill(text);
        await expect(page.getByTestId('quick-add-preview')).toContainText('Invalid reminder');
        await input.press('Escape');
        await input.press('Enter');
        await expect(input).toHaveValue(text);
        await expect(page.locator('[data-task-id]', { hasText: 'Invalid reminder task' })).toHaveCount(0);
    });
}
