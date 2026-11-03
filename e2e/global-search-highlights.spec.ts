import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('global search highlights each matched title term on task and project results', async ({ page }, testInfo) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'search-task', title: 'Alpha garden BETA notes', status: 'next' }],
        projects: [{ id: 'search-project', title: 'Beta launch alpha' }],
    });
    await page.goto('/?view=next');
    await expect(page.locator('[data-task-id="search-task"]')).toBeVisible();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    const search = dialog.locator('input').first();
    await search.fill('alpha beta');
    const rows = dialog.locator('[data-search-index]');
    await expect(rows).toHaveCount(2);
    const task = rows.filter({ hasText: 'Alpha garden BETA notes' });
    const project = rows.filter({ hasText: 'Beta launch alpha' });
    await expect(task.locator('.text-primary.font-semibold')).toHaveText(['Alpha', 'BETA']);
    await expect(project.locator('.text-primary.font-semibold')).toHaveText(['Beta', 'alpha']);
    await page.screenshot({ path: testInfo.outputPath('global-search-multiple-highlights.png') });
    await task.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-task-id="search-task"]')).toBeVisible();
});

test('global search highlights separate Chinese title substrings', async ({ page }, testInfo) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ title: '项目设计资料与会议记录', status: 'reference' }],
    });
    await page.goto('/?view=reference');
    await expect(page.locator('[data-task-id="seed-task-1"]')).toBeVisible();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await dialog.locator('input').first().fill('资料 会议');
    const row = dialog.locator('[data-search-index]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.text-primary.font-semibold')).toHaveText(['资料', '会议']);
    await page.screenshot({ path: testInfo.outputPath('global-search-chinese-highlights.png') });
});


for (const opener of ['project', 'task', 'inbox']) test(`search keeps an unsectioned project result in view (${opener})`, async ({ page }) => {
    await dismissOnboarding(page);
    await page.addInitScript(() => {
        const stamp = '2026-09-01T12:00:00.000Z';
        const base = { createdAt: stamp, updatedAt: stamp };
        localStorage.setItem('mindwtr-data', JSON.stringify({
            tasks: Array.from({ length: 105 }, (_, i) => ({
                ...base, id: `task-${i}`, title: i === 24 ? 'Needle unsectioned' : `Task ${i}`,
                status: i >= 93 ? 'done' : 'next', projectId: 'project',
                ...(i >= 25 ? { sectionId: `section-${(i - 25) % 11}` } : {}),
                tags: [], contexts: [], order: i,
            })),
            projects: [{ ...base, id: 'project', title: 'Large project', status: 'active', color: '#94a3b8' }],
            sections: Array.from({ length: 11 }, (_, i) => ({ ...base, id: `section-${i}`, projectId: 'project', title: `Section ${i}`, order: i })),
            areas: [], people: [], settings: { gtd: { autoArchiveDays: 0 } },
        }));
    });
    await page.goto('/?view=projects');
    await page.locator('[data-project-navigation-item][data-project-id="project"]').click();
    await expect(page.locator('[data-project-scroll-container]')).toBeVisible();
    if (opener === 'inbox') {
        await page.goto('/?view=inbox');
        await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
    }
    if (opener === 'task') await page.locator('[data-task-id="task-0"] [data-task-view-toggle]').focus();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await dialog.locator('input').first().fill('Needle unsectioned');
    if (opener === 'inbox') {
        await expect(dialog.locator('[data-search-index]')).toHaveCount(1);
        await page.keyboard.press('Enter');
    } else {
        await dialog.locator('[data-search-index]').click();
    }
    await expect(dialog).toHaveCount(0);
    const task = page.locator('[data-task-id="task-24"]');
    await expect(task).toBeInViewport();

    await page.waitForTimeout(4500);
    await expect(task).toBeInViewport();
});
