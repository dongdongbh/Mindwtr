import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('Contexts combines tokens with All/Any and keeps the compact selector usable', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, { tasks: [
        { id: 'alice', title: 'Alice only', status: 'next' },
        { id: 'bob', title: 'Bob only', status: 'next' },
        { id: 'both', title: 'Alice and Bob', status: 'next' },
        { id: 'other', title: 'Other', status: 'next' },
        { id: 'none', title: 'Untagged', status: 'next' },
    ] });
    await page.addInitScript(() => {
        const key = 'mindwtr-data';
        const data = JSON.parse(localStorage.getItem(key) ?? '{}') as {
            tasks: Array<{ id: string; contexts: string[]; tags: string[] }>;
        };
        for (const task of data.tasks) {
            task.contexts = task.id === 'alice' || task.id === 'both' ? ['@alice']
                : task.id === 'other' ? ['@other'] : [];
            task.tags = task.id === 'bob' || task.id === 'both' ? ['#bob'] : [];
        }
        localStorage.setItem(key, JSON.stringify(data));
    });
    await page.goto('/');
    await page.locator('[data-sidebar-item][data-view="contexts"]').click();

    // A plain click switches to one token; Ctrl/Cmd-click adds another (#1427).
    await page.getByRole('button', { name: '#bob (2)' }).click();
    await page.getByRole('button', { name: '@alice (2)' }).click();
    await expect(page.getByText('Bob only', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '#bob (2)' }).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByText('Alice and Bob', { exact: true })).toBeVisible();
    await expect(page.getByText('Alice only', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Any', exact: true }).click();
    await expect(page.getByText('Alice only', { exact: true })).toBeVisible();
    await expect(page.getByText('Bob only', { exact: true })).toBeVisible();
    await expect(page.locator('[data-task-id="both"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'No context (1)' }).click();
    await expect(page.getByText('Untagged', { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 700, height: 900 });
    await page.getByRole('combobox', { name: 'Contexts & Tags' }).selectOption('@alice');
    await page.getByRole('combobox', { name: 'Contexts & Tags' }).selectOption('#bob');
    await expect(page.getByRole('button', { name: 'Remove filter @alice' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove filter #bob' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove filter #bob' }).click();
    await expect(page.getByRole('heading', { name: '@alice' })).toBeVisible();
});
