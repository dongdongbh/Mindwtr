import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding, seedTheme } from './seed';

async function seedReferences(page: Page, large = false) {
    const stamp = '2026-09-01T00:00:00.000Z';
    const task = (id: string, title: string, extra = {}) => ({
        id, title, status: 'reference', contexts: ['@retained'], tags: ['#reading'],
        createdAt: stamp, updatedAt: stamp, ...extra,
    });
    const project = (id: string, status: string, extra = {}) => ({
        id, title: id, status, color: '#94a3b8', createdAt: stamp, updatedAt: stamp, ...extra,
    });
    const data = {
        tasks: [
            task('active-reference', 'key1 key2 key3', { description: 'Research notes: winter garden 资料', projectId: 'Active project' }),
            task('archived-reference', 'Historical reference', { description: 'Previous project notes', projectId: 'Archived project' }),
            task('deleted-project-reference', 'Deleted project reference', { projectId: 'Deleted project', deletedAt: stamp }),
            task('deleted-reference', 'Deleted reference', { deletedAt: stamp }),
            task('normal-action', 'Ordinary action', { status: 'next', dueDate: '2026-10-01' }),
            ...(large ? Array.from({ length: 300 }, (_, i) => task(`bulk-${i}`, `Library entry ${String(i).padStart(3, '0')}`)) : []),
        ],
        projects: [project('Active project', 'active'), project('Archived project', 'archived'), project('Deleted project', 'active', { deletedAt: stamp })],
        sections: [], areas: [], people: [],
        settings: { gtd: { autoArchiveDays: 0, taskEditor: { presentation: 'inline' } } },
    };
    await dismissOnboarding(page);
    await page.addInitScript((value) => {
        if (localStorage.getItem('mindwtr-data') === null) localStorage.setItem('mindwtr-data', value);
    }, JSON.stringify(data));
}

const row = (page: Page, id: string) => page.locator(`[data-task-id="${id}"]`);
const readTask = (page: Page, id: string) => page.evaluate((taskId) => {
    const data = JSON.parse(localStorage.getItem('mindwtr-data') || '{}');
    return data.tasks?.find((task: { id: string }) => task.id === taskId);
}, id);

test('Reference searches title and notes with all terms and optionally includes archived projects', async ({ page }, testInfo) => {
    await seedReferences(page);
    await page.goto('/?view=reference');
    await expect(row(page, 'active-reference')).toBeVisible();
    await expect(row(page, 'archived-reference')).toHaveCount(0);
    await expect(row(page, 'deleted-project-reference')).toHaveCount(0);
    const search = page.locator('[data-view-filter-input]');
    for (const query of ['ke 1 2', 'KEY winter', 'garden 资料']) {
        await search.fill(query);
        await expect(row(page, 'active-reference')).toBeVisible();
    }
    await search.fill('winter missing');
    await expect(row(page, 'active-reference')).toHaveCount(0);
    await search.fill('');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const archived = page.getByRole('checkbox', { name: 'Include archived projects' });
    await expect(archived).not.toBeChecked();
    await archived.check();
    await expect(row(page, 'archived-reference')).toBeVisible();
    await expect(row(page, 'deleted-project-reference')).toHaveCount(0);
    await expect(row(page, 'deleted-reference')).toHaveCount(0);
    await row(page, 'archived-reference').getByText('Historical reference', { exact: true }).click();
    await expect(page.getByText('Previous project notes', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('reference-archive-filter.png') });
    await archived.uncheck();
    await expect(row(page, 'archived-reference')).toHaveCount(0);
    expect((await readTask(page, 'archived-reference')).status).toBe('reference');
});

test('Reference editing preserves retained metadata and exposes a secondary conversion to action', async ({ page }, testInfo) => {
    await seedReferences(page);
    await seedTheme(page, 'dark');
    await page.goto('/?view=reference');
    await row(page, 'active-reference').getByText('key1 key2 key3', { exact: true }).dblclick();
    const editor = page.locator('form').filter({ has: page.getByRole('combobox', { name: 'Title', exact: true }) });
    await expect(editor.getByRole('button', { name: 'Convert to action', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: /^Scheduling/ })).toHaveCount(0);
    await expect(editor.getByText('@retained', { exact: true })).toHaveCount(0);
    await editor.getByRole('combobox', { name: 'Title', exact: true }).fill('Updated reference notes');
    await page.setViewportSize({ width: 900, height: 700 });
    await page.screenshot({ path: testInfo.outputPath('reference-editor-dark.png') });
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await readTask(page, 'active-reference')).title).toBe('Updated reference notes');
    expect(await readTask(page, 'active-reference')).toMatchObject({
        status: 'reference', contexts: ['@retained'], tags: ['#reading'],
        description: 'Research notes: winter garden 资料', projectId: 'Active project',
    });
    await row(page, 'active-reference').getByText('Updated reference notes', { exact: true }).dblclick();
    await editor.getByRole('button', { name: 'Convert to action', exact: true }).click();
    await expect(editor.getByRole('button', { name: /^Scheduling/ })).toBeVisible();
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await readTask(page, 'active-reference')).status).toBe('next');
    await expect(row(page, 'active-reference')).toHaveCount(0);
    expect(await readTask(page, 'normal-action')).toMatchObject({
        title: 'Ordinary action', status: 'next', contexts: ['@retained'], dueDate: '2026-10-01',
    });
});

test('large Reference collections retain windowed rows and search the full collection', async ({ page }) => {
    await seedReferences(page, true);
    await page.goto('/?view=reference');
    await expect(page.locator('[data-task-id]').first()).toBeVisible();
    expect(await page.locator('[data-task-id]').count()).toBeLessThan(100);
    await page.locator('[data-view-filter-input]').fill('Library 299');
    await expect(row(page, 'bulk-299')).toBeVisible();
    await expect(row(page, 'bulk-0')).toHaveCount(0);
});


test('bulk selection leaves archived-project references unchanged', async ({ page }) => {
    await seedReferences(page);
    await page.goto('/?view=reference');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Include archived projects' }).check();
    await expect(row(page, 'archived-reference')).toBeVisible();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: 'Select All', exact: true }).click();
    await page.getByRole('combobox', { name: 'Move to', exact: true }).selectOption('next');
    await expect.poll(async () => (await readTask(page, 'active-reference')).status).toBe('next');
    expect(await readTask(page, 'archived-reference')).toMatchObject({
        status: 'reference', projectId: 'Archived project',
    });
    const archivedProject = await page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data') || '{}');
        return data.projects.find((project: { id: string }) => project.id === 'Archived project');
    });
    expect(archivedProject.status).toBe('archived');
});
