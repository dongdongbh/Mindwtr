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

test('Contexts applies a bulk estimate only to selected tasks in the No estimate filter', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [
            { id: 'one', title: 'Outline report', status: 'next', contexts: ['@work'] },
            { id: 'two', title: 'Review draft', status: 'waiting', contexts: ['@work'] },
            { id: 'three', title: 'Send feedback', status: 'next', contexts: ['@work'] },
            { id: 'estimated', title: 'Read proposal', status: 'next', contexts: ['@work'], timeEstimate: '15min' },
            { id: 'other-context', title: 'Plan dinner', status: 'next', contexts: ['@home'] },
        ],
        settings: { language: 'en', features: { timeEstimates: true } },
    });
    await page.goto('/');
    await page.locator('[data-sidebar-item][data-view="contexts"]').click();
    await page.getByRole('button', { name: '@work (4)', exact: true }).click();

    const filters = page.getByRole('button', { name: 'Filters', exact: true });
    await filters.click();
    const panel = page.locator('#agenda-filters-panel');
    await panel.getByRole('button', { name: /^Time estimate/i }).click();
    await panel.getByRole('button', { name: 'No estimate', exact: true }).click();
    await panel.getByRole('button', { name: 'Hide', exact: true }).click();
    const rows = page.locator('[data-task-id]');
    const row = (id: string) => page.locator(`[data-task-id="${id}"]`);
    await expect(rows).toHaveCount(3);
    await expect(row('estimated')).toHaveCount(0);
    await expect(row('other-context')).toHaveCount(0);

    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await row('one').getByRole('checkbox', { name: 'Select task' }).click();
    await row('two').getByRole('checkbox', { name: 'Select task' }).click();
    await expect(page.getByText('2 selected - 3 tasks', { exact: true })).toBeVisible();
    await expect(row('three').getByRole('checkbox', { name: 'Select task' })).not.toBeChecked();
    await page.getByRole('button', { name: 'Bulk organize', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Bulk organize' });
    await dialog.getByRole('combobox', { name: 'Time Estimate', exact: true }).selectOption('30min');
    await dialog.getByRole('button', { name: 'Apply to selected', exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(rows).toHaveCount(1);
    await expect(row('three')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toBeVisible();
    await filters.click();
    await panel.getByRole('button', { name: 'Remove filter: No estimate', exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect.poll(async () => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}');
        return Object.fromEntries(data.tasks.map(({ id, status, timeEstimate }: {
            id: string; status: string; timeEstimate?: string;
        }) => [id, [status, timeEstimate ?? null]]));
    })).toEqual({
        one: ['next', '30min'],
        two: ['waiting', '30min'],
        three: ['next', null],
        estimated: ['next', '15min'],
        'other-context': ['next', null],
    });
});
