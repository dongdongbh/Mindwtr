import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

for (const locale of ['en-US', 'en-GB']) {
    test.describe(`desktop time entry in ${locale}`, () => {
        test.use({ locale, timezoneId: 'America/New_York' });

        test('system time format follows the device rather than the date format', async ({ page }) => {
            await dismissOnboarding(page);
            await seedAppData(page, {
                tasks: [{ id: 'system-time-task', title: 'Check the appointment', status: 'waiting', startTime: '2026-10-01T13:59' }],
                settings: {
                    timeFormat: 'system', dateFormat: locale === 'en-US' ? 'dmy' : 'mdy',
                    gtd: { taskEditor: { presentation: 'inline' } },
                },
            });
            await page.goto('/');
            await page.locator('[data-sidebar-item][data-view="waiting"]').click();
            await page.getByText('Check the appointment', { exact: true }).dblclick();
            await expect(page.getByLabel('Start time', { exact: true })).toHaveValue(locale === 'en-US' ? '1:59 PM' : '13:59');
        });

        test('24-hour keyboard entry survives save, reload, and a format change', async ({ page }, testInfo) => {
            await dismissOnboarding(page);
            await seedAppData(page, {
                tasks: [{
                    id: 'time-format-task', title: 'Plan the garden', status: 'waiting',
                    startTime: '2026-10-01', dueDate: '2026-10-03',
                }],
                settings: { timeFormat: '24h', gtd: { taskEditor: { presentation: 'inline' } } },
            });
            const openEditor = async () => {
                await page.locator('[data-sidebar-item][data-view="waiting"]').click();
                await page.getByText('Plan the garden', { exact: true }).dblclick();
            };
            const editor = page.locator('form').filter({ has: page.getByRole('combobox', { name: 'Title', exact: true }) });
            const time = editor.getByLabel('Start time', { exact: true });
            const storedTimes = () => page.evaluate(() => {
                const task = JSON.parse(localStorage.getItem('mindwtr-data')!).tasks.find((item: { id: string }) => item.id === 'time-format-task');
                const start = new Date(task.startTime);
                return { hour: start.getHours(), minute: start.getMinutes(), dueDate: task.dueDate };
            });

            await page.goto('/');
            await openEditor();
            await expect(time).toHaveValue('');


            await time.focus();
            await time.pressSequentially('13:59');
            await time.press('Tab');
            await expect(time).toHaveValue('13:59');
            expect(await time.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
            await page.screenshot({ path: testInfo.outputPath(`time-24h-${locale}.png`) });
            await editor.getByRole('button', { name: 'Save', exact: true }).click();
            await expect.poll(storedTimes).toEqual({ hour: 13, minute: 59, dueDate: '2026-10-03' });
            await page.reload();
            await openEditor();
            await expect(time).toHaveValue('13:59');
            await editor.getByRole('button', { name: 'Cancel', exact: true }).click();

            await page.goto('/?view=settings');
            await page.locator('[data-settings-section="regionalFormats"]').click();
            await page.locator('[data-settings-key="timeFormat"] select').selectOption('12h');
            await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data')!).settings.timeFormat)).toBe('12h');
            await openEditor();
            await expect(time).toHaveValue(/^0?1:59\s*PM$/i);
            await time.fill('12:01 AM');
            await time.press('Tab');
            await editor.getByRole('button', { name: 'Save', exact: true }).click();
            await expect.poll(storedTimes).toEqual({ hour: 0, minute: 1, dueDate: '2026-10-03' });
        });
    });
}
