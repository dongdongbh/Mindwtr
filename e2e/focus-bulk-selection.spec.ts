import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData, seedTasks } from './seed';

test('Focus selects filtered offscreen tasks once and organizes them through the shared modal', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [
            ...seedTasks('Included', 45, { status: 'next', contexts: ['@work', '@computer'] }),
            { id: 'hidden', title: 'Hidden task', status: 'next' },
        ],
        settings: { language: 'en', keybindingStyle: 'standard' },
    });
    await page.goto('/?view=agenda');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search task titles' }).fill('Included');
    await page.locator('button[aria-controls="agenda-filters-panel"]').click();
    const renderedCount = await page.locator('[data-task-id]').count();
    expect(renderedCount).toBeLessThan(45);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: 'Select All', exact: true }).click();
    await expect(page.getByText('45 selected - 45 tasks', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select All', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Bulk organize', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Bulk organize' });
    await dialog.getByRole('combobox', { name: 'Tags' }).fill('#organized');
    await dialog.getByRole('button', { name: 'Apply to selected' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}');
        return data.tasks?.filter((task: { tags: string[] }) => task.tags.includes('#organized')).length;
    })).toBe(45);
    const hiddenTags = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').tasks.find((task: { id: string }) => task.id === 'hidden').tags);
    expect(hiddenTags).toEqual([]);
});

test('Focus supports keyboard and range selection while hiding drag and row quick actions', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [
            { id: 'one', title: 'Focus one', status: 'next', isFocusedToday: true },
            { id: 'two', title: 'Focus two', status: 'next', isFocusedToday: true },
            { id: 'three', title: 'Focus three', status: 'next', isFocusedToday: true },
        ],
        settings: { language: 'en', keybindingStyle: 'standard' },
    });
    await page.goto('/?view=agenda');
    await expect(page.getByRole('button', { name: 'Reorder', exact: true })).toHaveCount(3);
    const first = page.locator('[data-task-id="one"]');
    await first.getByRole('button', { name: 'Toggle task details: Focus one', exact: true }).focus();
    await page.keyboard.press('x');
    await expect(first.getByRole('checkbox')).toBeChecked();
    await expect(page.getByRole('button', { name: 'Reorder', exact: true })).toHaveCount(0);
    const third = page.locator('[data-task-id="three"]');
    await third.getByRole('checkbox').click({ modifiers: ['Shift'] });
    await expect(page.getByText('3 selected - 3 tasks', { exact: true })).toBeVisible();
    await expect(page.locator('[data-task-quick-actions-trigger]')).toHaveCount(0);
    await third.click({ button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.getByRole('button', { name: 'Bulk organize', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('3 selected - 3 tasks', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reorder', exact: true })).toHaveCount(3);
});
