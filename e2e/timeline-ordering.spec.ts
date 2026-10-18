import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding } from './seed';

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data')!));
const taskOrder = async (page: Page) => (await stored(page)).tasks
    .filter((task: { projectId?: string; sectionId?: string }) => task.projectId === 'project-a' && !task.sectionId)
    .sort((a: { order: number }, b: { order: number }) => a.order - b.order)
    .map((task: { id: string }) => task.id);

test('Timeline shares row ordering, preserves hidden tasks and dates, and refuses cross-section drops', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.clock.setFixedTime(new Date('2026-10-14T12:00:00Z'));
    await dismissOnboarding(page);
    await page.addInitScript(() => {
        if (localStorage.getItem('mindwtr-data')) return;
        const common = { tags: [], contexts: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
        localStorage.setItem('mindwtr-data', JSON.stringify({
            tasks: [
                { ...common, id: 'task-a', title: 'First action', status: 'next', projectId: 'project-a', order: 0, orderNum: 0, dueDate: '2026-10-19' },
                { ...common, id: 'hidden', title: 'Undated action', status: 'next', projectId: 'project-a', order: 1024, orderNum: 1024 },
                { ...common, id: 'task-b', title: 'Second action', status: 'next', projectId: 'project-a', order: 2048, orderNum: 2048, dueDate: '2026-10-17' },
                { ...common, id: 'task-c', title: 'Third action', status: 'next', projectId: 'project-a', order: 3072, orderNum: 3072, dueDate: '2026-10-15' },
                { ...common, id: 'section-task', title: 'Separate section action', status: 'next', projectId: 'project-a', sectionId: 'section', order: 4096, dueDate: '2026-10-16' },
            ],
            projects: [
                { ...common, id: 'project-a', title: 'First project', status: 'active', order: 0, tagIds: [], color: '#3b82f6', startDate: '2026-10-14', dueDate: '2026-10-20' },
                { ...common, id: 'project-b', title: 'Second project', status: 'active', order: 2048, tagIds: [], color: '#10b981', startDate: '2026-10-14', dueDate: '2026-10-20' },
            ],
            sections: [{ id: 'section', projectId: 'project-a', title: 'Separate section', order: 0, createdAt: common.createdAt, updatedAt: common.updatedAt }],
            areas: [], people: [], settings: { language: 'en', features: { timeline: true } },
        }));
    });
    await page.goto('/?view=timeline');
    const handle = (id: string) => page.locator(`[data-testid="timeline-reorder-task"][data-task-id="${id}"]`);
    await expect(handle('task-a')).toBeVisible({ timeout: 30_000 });
    expect((await handle('task-a').boundingBox())!.y).toBeLessThan((await handle('task-c').boundingBox())!.y);
    const before = (await stored(page)).tasks.map((task: { id: string; dueDate?: string; startTime?: string }) => ({ id: task.id, due: task.dueDate, start: task.startTime }));
    const source = (await handle('task-c').boundingBox())!;
    const target = (await handle('task-a').boundingBox())!;
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => taskOrder(page)).toEqual(['task-c', 'task-a', 'hidden', 'task-b']);

    // A different section is not a reorder destination and cannot reparent the task.
    const moved = (await handle('task-c').boundingBox())!;
    const other = (await handle('section-task').boundingBox())!;
    await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2);
    await page.mouse.down();
    await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2, { steps: 12 });
    await page.mouse.up();
    expect(await taskOrder(page)).toEqual(['task-c', 'task-a', 'hidden', 'task-b']);
    expect((await stored(page)).tasks.find((task: { id: string }) => task.id === 'task-c').sectionId).toBeUndefined();

    const projectHandle = page.locator('[data-testid="timeline-reorder-project"][data-project-id="project-b"]');
    await projectHandle.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    await expect.poll(async () => (await stored(page)).projects.sort((a: { order: number }, b: { order: number }) => a.order - b.order).map((project: { id: string }) => project.id)).toEqual(['project-b', 'project-a']);
    expect((await stored(page)).tasks.map((task: { id: string; dueDate?: string; startTime?: string }) => ({ id: task.id, due: task.dueDate, start: task.startTime }))).toEqual(before);
    await page.reload();
    await expect(handle('task-c')).toBeVisible();
    expect((await handle('task-c').boundingBox())!.y).toBeLessThan((await handle('task-a').boundingBox())!.y);
    expect(await taskOrder(page)).toEqual(['task-c', 'task-a', 'hidden', 'task-b']);
    await page.screenshot({ path: testInfo.outputPath('timeline-shared-order.png') });
});

for (const taskCount of [40, 60]) {
    test(`Keyboard reordering reaches offscreen project headers with ${taskCount * 2} tasks`, async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.clock.setFixedTime(new Date('2026-10-14T12:00:00Z'));
        await dismissOnboarding(page);
        await page.addInitScript((taskCount) => {
            const common = { createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
            localStorage.setItem('mindwtr-data', JSON.stringify({
                projects: [0, 1].map((index) => ({ ...common, id: `project-${index}`, title: `Project ${index}`,
                    status: 'active', order: index * 1024, tagIds: [], color: '#3b82f6',
                    startDate: '2026-10-14', dueDate: '2026-10-20' })),
                tasks: Array.from({ length: taskCount * 2 }, (_, index) => ({ ...common, id: `task-${index}`,
                    title: `Action ${index}`, status: 'next', projectId: `project-${Math.floor(index / taskCount)}`,
                    order: (index % taskCount) * 1024, tags: [], contexts: [], dueDate: '2026-10-18' })),
                sections: [], areas: [], people: [], settings: { language: 'en', features: { timeline: true } },
            }));
        }, taskCount);
        await page.goto('/?view=timeline');
        const first = page.locator('[data-testid="timeline-reorder-project"][data-project-id="project-0"]');
        await expect(first).toBeVisible({ timeout: 30_000 });
        const destination = page.locator('[data-testid="timeline-reorder-project"][data-project-id="project-1"]');
        if (taskCount === 60) await expect(destination).toHaveCount(0);
        await first.focus();
        await page.keyboard.press('Space');
        await page.keyboard.press('ArrowDown');
        await expect(destination).toBeInViewport();
        await expect(destination).toBeFocused();
        await page.keyboard.press('Space');
        await expect.poll(async () => (await stored(page)).projects
            .sort((a: { order: number }, b: { order: number }) => a.order - b.order)
            .map((project: { id: string }) => project.id)).toEqual(['project-1', 'project-0']);
        if (taskCount === 60) expect(await page.locator('[data-testid="timeline-reorder-task"]').count()).toBeLessThan(120);
    });
}
