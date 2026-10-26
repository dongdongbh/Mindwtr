import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

for (const [field, label] of [
    ['startTime', 'Start Date'],
    ['dueDate', 'Due Date'],
    ['reviewAt', 'Review Date'],
] as const) {
    test.describe(label, () => {
        test.beforeEach(async ({ page }) => {
            await dismissOnboarding(page);
            await seedAppData(page, {
                projects: [{ id: 'garden', title: 'Garden project' }],
                tasks: [{ id: 'dated-task', title: 'Order seeds', status: 'next', projectId: 'garden', [field]: '2026-09-01' }],
                settings: { language: 'en', dateFormat: 'ymd' },
            });
            await page.goto('/?view=projects');
            await page.locator('[data-project-navigation-item][data-project-id="garden"]').click();
            await page.getByText('Order seeds', { exact: true }).click({ button: 'right' });
            await page.getByRole('menuitem', { name: 'Dates…', exact: true }).click();
            await page.getByRole('menuitem', { name: `${label}…`, exact: true }).click();
        });

        test(`${label} calendar opens on entry and stays open on its first click`, async ({ page }) => {
            const input = page.getByRole('textbox', { name: label, exact: true });
            await expect(input).toBeFocused();
            const calendar = page.getByRole('dialog', { name: `${label} Calendar`, exact: true });
            await expect(calendar).toBeVisible();
            await page.getByRole('button', { name: `${label} Calendar`, exact: true }).click();
            // Let the pointer-release blur timer run before asserting persistence.
            await page.waitForTimeout(150);
            await expect(calendar).toBeVisible();
            await calendar.getByRole('button', { name: 'Calendar: Next month', exact: true }).click();
            await expect(calendar).toBeVisible();
            await calendar.getByRole('button', { name: 'Calendar: Previous month', exact: true }).click();
            await expect(calendar).toBeVisible();
            await calendar.getByRole('button', { name: 'Wednesday, September 2, 2026', exact: true }).click();
            await expect(input).toHaveValue('2026-09-02');
            await page.getByRole('button', { name: 'Save', exact: true }).click();
            await expect.poll(() => page.evaluate((field) => {
                const data = JSON.parse(localStorage.getItem('mindwtr-data')!);
                return data.tasks.find((task: { id: string }) => task.id === 'dated-task')[field];
            }, field)).toBe('2026-09-02');
        });

        test(`${label} clears visibly before Save and remains cleared after reload`, async ({ page }) => {
            const input = page.getByRole('textbox', { name: label, exact: true });
            await expect(input).toHaveValue('2026-09-01');
            await expect(input).toBeFocused();
            await page.getByRole('button', { name: `Clear ${label}`, exact: true }).click();
            await page.waitForTimeout(150);
            await expect(input).toHaveValue('');
            const savedDate = () => page.evaluate(({ field }) => {
                const data = JSON.parse(localStorage.getItem('mindwtr-data')!);
                return data.tasks.find((task: { id: string }) => task.id === 'dated-task')[field] ?? null;
            }, { field });
            expect(await savedDate()).toBe('2026-09-01');
            await page.getByRole('button', { name: 'Save', exact: true }).click();
            await expect.poll(savedDate).toBeNull();
            await page.reload();
            await expect(page.getByText('Order seeds', { exact: true })).toBeVisible();
            expect(await savedDate()).toBeNull();
        });
    });
}

test('mouse hover opens panels without focus changes or saving a date draft', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        projects: [{ id: 'garden', title: 'Garden project' }],
        tasks: [{ id: 'dated-task', title: 'Order seeds', status: 'next', projectId: 'garden', dueDate: '2026-09-01' }],
        settings: { language: 'en', dateFormat: 'ymd' },
    });
    await page.goto('/?view=projects');
    await page.locator('[data-project-navigation-item][data-project-id="garden"]').click();
    await page.getByText('Order seeds', { exact: true }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'More options', exact: true });
    const dates = page.getByRole('menuitem', { name: 'Dates…', exact: true });
    await dates.hover();
    await expect(dates).toHaveAttribute('aria-expanded', 'false');
    const datesPanel = page.getByRole('dialog', { name: 'Dates…', exact: true });
    await expect(datesPanel).toBeVisible();
    await expect(menu).toBeFocused();
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).hover();
    await datesPanel.hover();
    await page.waitForTimeout(350);
    await expect(datesPanel).toBeVisible();
    await datesPanel.getByRole('menuitem', { name: 'Due Date…', exact: true }).click();
    const calendar = page.getByRole('dialog', { name: 'Due Date Calendar', exact: true });
    await expect(calendar).toBeVisible();
    await calendar.getByRole('button', { name: 'Wednesday, September 2, 2026', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Due Date', exact: true });
    await expect(input).toHaveValue('2026-09-02');
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).hover();
    await page.waitForTimeout(350);
    await expect(input).toHaveValue('2026-09-02');
    const savedDate = () => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data')!);
        return data.tasks.find((task: { id: string }) => task.id === 'dated-task').dueDate;
    });
    expect(await savedDate()).toBe('2026-09-01');
    await page.getByRole('textbox', { name: 'Due time', exact: true }).fill('09:30');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(savedDate).toBe('2026-09-02T09:30');
});

test('hovering a date row opens its calendar beside the Dates list', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        projects: [{ id: 'garden', title: 'Garden project' }],
        tasks: [{ id: 'dated-task', title: 'Order seeds', status: 'next', projectId: 'garden', startTime: '2026-09-01' }],
        settings: { language: 'en', dateFormat: 'ymd' },
    });
    await page.goto('/?view=projects');
    await page.locator('[data-project-navigation-item][data-project-id="garden"]').click();
    await page.getByText('Order seeds', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Dates…', exact: true }).hover();
    const datesPanel = page.getByRole('dialog', { name: 'Dates…', exact: true });
    await datesPanel.getByRole('menuitem', { name: 'Start Date…', exact: true }).hover();
    const calendar = page.getByRole('dialog', { name: 'Start Date Calendar', exact: true });
    await expect(calendar).toBeVisible();
    await expect(datesPanel).toBeVisible();
    await calendar.getByRole('button', { name: 'Wednesday, September 2, 2026', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data')!);
        return data.tasks.find((task: { id: string }) => task.id === 'dated-task').startTime;
    })).toBe('2026-09-02');
});
