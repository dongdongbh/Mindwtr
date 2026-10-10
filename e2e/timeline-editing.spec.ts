import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding } from './seed';

const readDates = (page: Page, id: string, kind: 'tasks' | 'projects' = 'tasks') => page.evaluate(({ id, kind }) => {
    const record = JSON.parse(localStorage.getItem('mindwtr-data')!)[kind].find((item: { id: string }) => item.id === id);
    return { start: kind === 'tasks' ? record.startTime : record.startDate, due: record.dueDate };
}, { id, kind });

test('Timeline previews dates before saving, supports undo/cancel, and includes completed history', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.clock.setFixedTime(new Date('2026-10-10T12:00:00Z'));
    await dismissOnboarding(page);
    await page.addInitScript(() => {
        if (localStorage.getItem('mindwtr-data')) return;
        const common = { tags: [], contexts: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
        localStorage.setItem('mindwtr-data', JSON.stringify({
            tasks: [
                { ...common, id: 'editable', title: 'Prepare proposal', status: 'next', projectId: 'active', startTime: '2026-10-11', dueDate: '2026-10-15' },
                { ...common, id: 'waiting', title: 'Waiting for approval', status: 'waiting', projectId: 'active', dueDate: '2026-10-17' },
                { ...common, id: 'history', title: 'Completed milestone', status: 'archived', projectId: 'closed', startTime: '2026-10-10', dueDate: '2026-10-12', completedAt: '2026-10-12T12:00:00Z' },
                { ...common, id: 'cancelled', title: 'Cancelled milestone', status: 'archived', dueDate: '2026-10-12', cancelledAt: '2026-10-12T12:00:00Z' },
            ],
            projects: [
                { ...common, id: 'active', title: 'Current project', status: 'active', color: '#3b82f6', order: 0, tagIds: [], startDate: '2026-10-10', dueDate: '2026-10-20' },
                { ...common, id: 'closed', title: 'Closed project', status: 'archived', color: '#10b981', order: 1, tagIds: [], startDate: '2026-10-10', dueDate: '2026-10-12' },
            ],
            sections: [], areas: [], people: [], settings: { language: 'en', features: { timeline: true }, undoNotificationsEnabled: true },
        }));
    });
    await page.goto('/?view=timeline');
    const bar = page.locator('[data-testid="timeline-bar"][data-task-id="editable"]');
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Completed milestone', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Status', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Completed', exact: true }).check();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Completed milestone', { exact: true })).toBeVisible();
    await expect(page.getByText('Closed project', { exact: true })).toBeVisible();
    await expect(page.getByText('Cancelled milestone', { exact: true })).toHaveCount(0);

    const before = { start: '2026-10-11', due: '2026-10-15' };
    const box = (await bar.boundingBox())!;
    const dayWidth = box.width / 5;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dayWidth, box.y + box.height / 2, { steps: 5 });
    expect(await readDates(page, 'editable')).toEqual(before);
    await page.mouse.up();
    await expect.poll(() => readDates(page, 'editable')).toEqual({ start: '2026-10-12', due: '2026-10-16' });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => readDates(page, 'editable')).toEqual(before);

    const cancelledBox = (await bar.boundingBox())!;
    await page.mouse.move(cancelledBox.x + cancelledBox.width / 2, cancelledBox.y + cancelledBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cancelledBox.x + cancelledBox.width / 2 + dayWidth, cancelledBox.y + cancelledBox.height / 2, { steps: 5 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await readDates(page, 'editable')).toEqual(before);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await bar.getByTestId('timeline-resize-due').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => readDates(page, 'editable')).toEqual({ start: '2026-10-11', due: '2026-10-16' });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => readDates(page, 'editable')).toEqual(before);
    await expect(page.locator('[data-testid="timeline-bar"][data-task-id="history"] button')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('timeline-status-and-editing.png') });

    const projectBar = page.locator('[data-testid="timeline-project-bar"][data-project-id="active"]');
    const projectBox = (await projectBar.boundingBox())!;
    await page.mouse.move(projectBox.x + projectBox.width / 2, projectBox.y + projectBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(projectBox.x + projectBox.width / 2 + dayWidth, projectBox.y + projectBox.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => readDates(page, 'active', 'projects')).toEqual({ start: '2026-10-11', due: '2026-10-21' });
    expect(await readDates(page, 'editable')).toEqual(before);
});
