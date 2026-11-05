import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './seed';

test('saved Focus filters toggle off without deletion and delete only through the menu', async ({ page }, testInfo) => {
    await dismissOnboarding(page);
    await page.addInitScript(() => {
        const timestamp = '2026-09-01T00:00:00.000Z';
        localStorage.setItem('mindwtr-data', JSON.stringify({
            tasks: [
                { id: 'desk', title: 'Desk action', contexts: ['@desk'] },
                { id: 'phone', title: 'Phone action', contexts: ['@phone'] },
            ].map(task => ({ ...task, status: 'next', tags: [], createdAt: timestamp, updatedAt: timestamp })),
            projects: [], areas: [], sections: [], people: [],
            settings: { savedFilters: [{
                id: 'desk-filter', name: 'Desk', view: 'focus', criteria: { contexts: ['@desk'] },
                createdAt: timestamp, updatedAt: timestamp,
            }] },
        }));
    });
    await page.goto('/?view=agenda');
    const chip = page.getByRole('button', { name: 'Desk', exact: true });
    await expect(page.locator('[data-task-id="phone"]')).toBeVisible();
    const savedBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data')!).settings.savedFilters);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-task-id="desk"]')).toBeVisible();
    await expect(page.locator('[data-task-id="phone"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /delete saved filter/i })).toHaveCount(0);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-task-id="phone"]')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data')!).settings.savedFilters)).toEqual(savedBefore);
    await chip.click();
    await page.screenshot({ path: testInfo.outputPath('saved-filter-active.png') });

    const menuTrigger = page.getByRole('button', { name: /more.*Desk/i });
    await menuTrigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: /Delete/ })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('saved-filter-menu.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(menuTrigger).toBeFocused();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: /Delete/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(chip).toBeVisible();
    await menuTrigger.click();
    await page.getByRole('menuitem', { name: /Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(chip).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => (
        Boolean(JSON.parse(localStorage.getItem('mindwtr-data')!).settings.savedFilters[0].deletedAt)
    ))).toBe(true);
});
