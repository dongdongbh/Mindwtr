import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

async function seedHistory(page: Page) {
    await dismissOnboarding(page);
    const timestamp = new Date().toISOString();
    await page.addInitScript((stamp) => {
        if (localStorage.getItem('mindwtr-data')) return;
        const task = (id: string, status: string, extra = {}) => ({
            id, title: id, status, contexts: [], tags: [],
            createdAt: stamp, updatedAt: stamp, completedAt: stamp, ...extra,
        });
        localStorage.setItem('mindwtr-data', JSON.stringify({
            tasks: [
                task('Recently completed task', 'done'),
                task('Retained archived task', 'archived'),
                task('Recoverable deleted task', 'next', { deletedAt: stamp }),
            ],
            projects: [], sections: [], areas: [], people: [],
            settings: { gtd: { autoArchiveDays: 0, timeEstimatePresets: ['15min', 'custom:37'] } },
        }));
    }, timestamp);
}

for (const [view, selectedTab, visibleTask, otherTask] of [
    ['done', 'Done', 'Recently completed task', 'Retained archived task'],
    ['archived', 'Archived', 'Retained archived task', 'Recently completed task'],
] as const) {
    test(`legacy ${view} route opens its History tab without changing lifecycle data`, async ({ page }, testInfo) => {
        await seedHistory(page);
        await page.goto(`/?view=${view}`);
        await expect(page.getByRole('tab', { name: selectedTab, exact: true })).toHaveAttribute('aria-selected', 'true');
        const header = page.locator('[data-history-header]');
        await expect(header.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
        await expect(header.getByRole('combobox', { name: 'Sort', exact: true })).toBeVisible();
        await expect(header.getByRole('combobox', { name: 'Group', exact: true })).toBeVisible();
        const tabBounds = await header.getByRole('tablist').boundingBox();
        const toolbarBounds = await header.locator('[data-history-toolbar]').boundingBox();
        expect(tabBounds).not.toBeNull();
        expect(toolbarBounds).not.toBeNull();
        expect(Math.abs(tabBounds!.y - toolbarBounds!.y)).toBeLessThan(12);
        await page.screenshot({ path: testInfo.outputPath(`history-${view}-wide.png`) });
        await expect(page.getByText(visibleTask, { exact: true })).toBeVisible();
        await expect(page.getByText(otherTask, { exact: true })).toHaveCount(0);
        await expect(page.getByText('Recoverable deleted task', { exact: true })).toHaveCount(0);
        await page.getByRole('tab', { name: selectedTab === 'Done' ? 'Archived' : 'Done', exact: true }).click();
        await expect(page.getByText(otherTask, { exact: true })).toBeVisible();
        await expect(header.getByRole('combobox', { name: 'Sort', exact: true })).toBeVisible();
        await expect(header.getByRole('combobox', { name: 'Group', exact: true })).toBeVisible();
        await page.reload();
        await expect(page.getByText(otherTask, { exact: true })).toBeVisible();
        const data = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}'));
        expect(data.tasks.map((task: { id: string; status: string }) => [task.id, task.status])).toEqual([
            ['Recently completed task', 'done'],
            ['Retained archived task', 'archived'],
            ['Recoverable deleted task', 'next'],
        ]);
        expect(data.tasks[2].deletedAt).toBeTruthy();
        expect(data.settings.gtd).toMatchObject({ autoArchiveDays: 0, timeEstimatePresets: ['15min', 'custom:37'] });
        await page.setViewportSize({ width: 600, height: 900 });
        for (const button of await header.getByRole('button').all()) {
            const bounds = await button.boundingBox();
            if (bounds) expect(bounds.x + bounds.width).toBeLessThanOrEqual(600);
        }
        await page.screenshot({ path: testInfo.outputPath(`history-${view}-narrow.png`) });
    });
}

test('list presentation options are directly accessible without hiding filtering', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, { tasks: [{ id: 'plain-task', title: 'A simple task', status: 'next' }] });
    await page.goto('/?view=next');
    await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show details', exact: true })).toBeVisible();
    const sort = page.getByRole('combobox', { name: 'Sort', exact: true });
    await expect(sort).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Group', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View options', exact: true })).toHaveCount(0);
    await sort.click();
    await expect(page.getByRole('listbox', { name: 'Sort', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sort).toBeFocused();
    await expect(page.getByText('A simple task', { exact: true })).toBeVisible();
});

test('enabled Timeline and legacy customized estimate shortcuts survive an upgrade', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'timeline-task', title: 'Plan the garden', status: 'next', startTime: '2026-09-17', dueDate: '2026-09-20' }],
        settings: { features: { timeline: true }, gtd: { timeEstimatePresets: ['15min', 'custom:37'] } },
    });
    await page.goto('/?view=timeline');
    await expect(page.getByRole('heading', { name: 'Timeline', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Timeline', exact: true })).toBeVisible();
    const data = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}'));
    expect(data.settings.features.timeline).toBe(true);
    expect(data.settings.gtd.timeEstimatePresets).toEqual(['15min', 'custom:37']);
    expect(data.tasks[0]).toMatchObject({ startTime: '2026-09-17', dueDate: '2026-09-20' });
});

test('Focus keeps Sort and Group directly accessible, global density unchanged, and Details direct', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'focus-task', title: 'Focus presentation task', status: 'next' }],
        settings: { appearance: { density: 'comfortable' } },
    });
    await page.goto('/?view=agenda');
    await expect(page.getByRole('heading', { name: 'Focus', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Show details', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await expect(page.locator('#agenda-filters-panel').getByRole('combobox', { name: 'Sort', exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Group', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View options', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Density/ })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').settings.appearance.density)).toBe('comfortable');
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Group', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Density/ })).toHaveCount(0);
});

test('Move to groups projects and areas and leaves dates and status unchanged', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'moving-task', title: 'Organize the garden', status: 'next', dueDate: '2026-10-20' }],
        projects: [{ id: 'garden', title: 'Garden project', areaId: 'home' }],
        areas: [{ id: 'home', name: 'Home' }],
    });
    await page.goto('/?view=next');
    const title = page.getByText('Organize the garden', { exact: true });
    const readTask = () => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').tasks[0]);
    for (const [group, option, expected] of [
        ['Projects', 'Garden project', { projectId: 'garden', areaId: undefined }],
        ['Areas', 'Home', { projectId: undefined, areaId: 'home' }],
    ] as const) {
        await title.click({ button: 'right' });
        await expect(page.getByRole('menuitem', { name: 'Dates…', exact: true })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Convert to Reference', exact: true })).toHaveCount(0);
        await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
        await page.getByRole('button', { name: 'Destination', exact: true }).click();
        await page.getByRole('group', { name: group, exact: true }).getByRole('option', { name: option, exact: true }).click();
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(async () => {
            const task = await readTask();
            return { projectId: task.projectId, areaId: task.areaId };
        }).toEqual(expected);
        expect(await readTask()).toMatchObject({ status: 'next', dueDate: '2026-10-20' });
        await page.keyboard.press('Escape');
    }
});

test('desktop settings keep AI and Integrations directly accessible and keyboard help together', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, { settings: { keybindingStyle: 'emacs' } });
    await page.goto('/?view=settings');
    await expect(page.getByRole('button', { name: 'Keyboard Shortcuts', exact: true })).toHaveCount(0);
    for (const child of ['AI assistant', 'Integrations']) {
        await page.getByRole('button', { name: child, exact: true }).click();
        await expect(page.getByRole('heading', { name: child, exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Back to Advanced', exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(page.getByText('Keyboard and window', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').settings.keybindingStyle)).toBe('emacs');
});

test('Review toolbar stays compact and its status picker preserves filtering', async ({ page }, testInfo) => {
    await dismissOnboarding(page);
    await seedAppData(page, { tasks: [
        { id: 'review-inbox', title: 'Inbox review task', status: 'inbox' },
        { id: 'review-next', title: 'Next review task', status: 'next' },
    ] });
    await page.goto('/?view=review');
    await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All open tasks', exact: true }).click();
    const toolbar = page.locator('.review-toolbar');
    const status = toolbar.getByRole('combobox', { name: 'Status', exact: true });
    await expect(status).toContainText('Open tasks (2)');
    await status.click();
    await page.getByRole('option', { name: 'Inbox (1)', exact: true }).click();
    await expect(page.getByText('Inbox review task', { exact: true })).toBeVisible();
    await expect(page.getByText('Next review task', { exact: true })).toHaveCount(0);
    for (const width of [1440, 900, 600]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(toolbar.getByRole('button', { name: 'Show details', exact: true })).toBeVisible();
        for (const button of await toolbar.getByRole('button').all()) {
            const bounds = await button.boundingBox();
            if (bounds) expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        }
        await page.screenshot({ path: testInfo.outputPath(`review-toolbar-${width}.png`) });
    }
});

test('creating a project from task details saves the edited title first', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, { tasks: [{ id: 'convert-task', title: 'Original conversion title', status: 'next' }] });
    await page.goto('/?view=next');
    await page.getByText('Original conversion title', { exact: true }).dblclick();
    await page.getByRole('combobox', { name: 'Title', exact: true }).fill('Edited conversion title');
    await page.getByRole('button', { name: 'Create project from task', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}');
        return data.projects?.some((project: { title: string }) => project.title === 'Edited conversion title');
    })).toBe(true);
    const task = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').tasks.find((item: { id: string }) => item.id === 'convert-task'));
    expect(task.title).toBe('Edited conversion title');
});

test('sidebar group titles are at least as large as their navigation items', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {});
    await page.goto('/?view=inbox');
    const inbox = page.locator('[data-sidebar-item][data-view="inbox"] span.truncate');
    await expect(inbox).toBeVisible();
    const itemSize = await inbox.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    const titles = page.locator('[data-sidebar-section-toggle] span');
    await expect(titles).toHaveCount(4);
    for (const title of await titles.all()) {
        expect(await title.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(itemSize);
    }
});
