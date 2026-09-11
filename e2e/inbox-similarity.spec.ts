import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('shows offline title matches in both processing modes without changing existing tasks', async ({ page, context }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [
            { id: 'capture', title: 'Buy postage stamps', status: 'inbox' },
            { id: 'other-capture', title: 'Book dentist appointment', status: 'inbox' },
            { id: 'existing', title: 'Buy postage stamps', status: 'next' },
            { id: 'completed', title: 'Buy postage stamps today', status: 'done' },
            { id: 'unrelated', title: 'Buy new shoes', status: 'next' },
        ],
        settings: { ai: { enabled: false }, gtd: { autoArchiveDays: 0, inboxProcessing: { defaultMode: 'guided' } } },
    });
    await page.goto('/?view=inbox');
    await page.getByRole('button', { name: 'Process Inbox (2)' }).click();
    await context.setOffline(true);

    const hints = page.getByRole('region', { name: 'Similar tasks' });
    await expect(hints.getByText('Buy postage stamps', { exact: true })).toBeVisible();
    await expect(hints.getByText('Buy postage stamps today', { exact: true })).toBeVisible();
    await expect(hints.getByText('Done', { exact: true })).toBeVisible();
    await expect(hints.getByText('Buy new shoes', { exact: true })).toHaveCount(0);
    await expect(hints.locator('li')).toHaveCount(2);

    await page.getByRole('button', { name: 'Quick', exact: true }).click();
    await expect(hints).toBeVisible();
    const title = page.getByRole('textbox', { name: 'Title', exact: true });
    await title.fill('Collect repaired bicycle');
    await expect(hints).toHaveCount(0);
    await title.fill('Buy postage stamps');
    await expect(hints).toBeVisible();
    for (const token of ['#errands', '%Alex', '+Home']) {
        await title.fill(`Buy postage stamps ${token}`);
        await expect(hints.getByText('Buy postage stamps', { exact: true })).toBeVisible();
    }
    await title.fill('Buy postage stamps');
    await page.getByRole('button', { name: 'Guided', exact: true }).click();
    await expect(hints).toBeVisible();
    await page.screenshot({ path: '.orchestrator/tasks/similar1042-20260911/desktop-guided.png' });

    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(hints).toHaveCount(0);
    await expect(page.locator('input[value="Book dentist appointment"]')).toBeVisible();

    const existing = await page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}');
        return data.tasks.filter((task: { id: string }) => ['existing', 'completed', 'unrelated'].includes(task.id));
    });
    expect(existing).toHaveLength(3);
    expect(existing.map((task: { id: string; title: string; status: string }) => ({ id: task.id, title: task.title, status: task.status }))).toEqual([
        { id: 'existing', title: 'Buy postage stamps', status: 'next' },
        { id: 'completed', title: 'Buy postage stamps today', status: 'done' },
        { id: 'unrelated', title: 'Buy new shoes', status: 'next' },
    ]);
});
