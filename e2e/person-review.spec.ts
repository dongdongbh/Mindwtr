import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './seed';

test('Manage People opens a combined, deduplicated person review', async ({ page }, testInfo) => {
    await dismissOnboarding(page);
    await page.addInitScript(() => {
        if (localStorage.getItem('mindwtr-data')) return;
        const timestamp = '2026-09-01T00:00:00.000Z';
        localStorage.setItem('mindwtr-data', JSON.stringify({
            tasks: [
                { id: 'assigned', title: 'Await the budget', status: 'waiting', assignedTo: 'Alex' },
                { id: 'context', title: 'Discuss the design', status: 'next', contexts: ['@Alex'] },
                { id: 'both', title: 'Confirm the dates', status: 'waiting', assignedTo: 'Alex', contexts: ['@Alex'] },
                { id: 'finished', title: 'Previous meeting', status: 'done', assignedTo: 'Alex', completedAt: timestamp },
                { id: 'other', title: 'Unrelated action', status: 'next', contexts: ['@Alexander'] },
            ].map(task => ({ createdAt: timestamp, updatedAt: timestamp, tags: [], contexts: [], ...task })),
            people: [{ id: 'alex', name: 'Alex', createdAt: timestamp, updatedAt: timestamp }],
            projects: [], areas: [], sections: [],
            settings: { gtd: { autoArchiveDays: 0 } },
        }));
    });
    await page.goto('/?view=settings');
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.locator('[data-settings-key="managePeople"]').click();
    const review = page.getByRole('button', { name: /Alex.*4.*tasks|4.*tasks.*Alex/i });
    await expect(review).toBeVisible();
    await review.focus();
    await review.press('Enter');
    const search = page.getByRole('dialog');
    await expect(search).toBeVisible();
    await expect(search.getByRole('textbox', { name: 'Search', exact: true })).toHaveValue('person:"Alex"');
    for (const title of ['Await the budget', 'Discuss the design', 'Confirm the dates', 'Previous meeting']) {
        await expect(search.getByText(title, { exact: true })).toHaveCount(1);
    }
    await expect(search.getByText('Unrelated action', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('combined-person-review.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Search', exact: true })).toHaveValue('');

    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data')!).tasks);
    expect(persisted.find((task: { id: string }) => task.id === 'context').assignedTo).toBeUndefined();
    expect(persisted.find((task: { id: string }) => task.id === 'both').contexts).toEqual(['@Alex']);
});
