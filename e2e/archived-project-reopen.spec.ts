import { expect, test } from '@playwright/test';
import type { AppData, Task } from '@mindwtr/core';
import { dismissOnboarding } from './seed';

test('reopening one completed task restores its archived project and section after reload', async ({ page }) => {
    const archivedAt = new Date().toISOString();
    const task = (id: string, title: string): Task => ({
        id, title, status: 'done', projectId: 'archived-project', sectionId: 'named-section',
        tags: [], contexts: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: archivedAt,
        completedAt: archivedAt, projectArchivedAt: archivedAt,
        statusBeforeProjectArchive: 'next', rev: 2,
    });
    const payload = JSON.stringify({
        tasks: [task('reopen-selected', 'Reopen selected task'), task('keep-completed', 'Keep sibling completed')],
        projects: [{
            id: 'archived-project', title: 'Archived project regression', status: 'archived',
            color: '#94a3b8', createdAt: archivedAt, updatedAt: archivedAt, rev: 2,
        }],
        sections: [{
            id: 'named-section', projectId: 'archived-project', title: 'Named section',
            createdAt: archivedAt, updatedAt: archivedAt, deletedAt: archivedAt,
            projectArchivedAt: archivedAt, order: 0, rev: 2,
        }],
        areas: [], people: [], settings: {},
    } satisfies AppData);
    await dismissOnboarding(page);
    await page.addInitScript((value) => {
        if (localStorage.getItem('mindwtr-data') === null) localStorage.setItem('mindwtr-data', value);
    }, payload);
    await page.goto('/?view=done');
    const selected = page.locator('[data-task-id="reopen-selected"]');
    await expect(selected).toBeVisible();
    await selected.hover();
    await selected.getByRole('button', { name: 'Move to Next', exact: true }).click();

    const readPersisted = () => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') || '{}'));
    await expect.poll(async () => (await readPersisted()).projects?.[0]?.status).toBe('active');
    await expect.poll(async () => (await readPersisted()).sections?.[0]?.deletedAt).toBeFalsy();
    await page.reload();
    await page.locator('[data-sidebar-item][data-view="projects"]').click();
    await page.getByText('Archived project regression', { exact: true }).first().click();
    await expect(page.getByText('Named section', { exact: true }).first()).toBeVisible();
    await expect(page.locator('[data-task-id="reopen-selected"]')).toBeVisible();
    const saved = await readPersisted();
    expect(saved.tasks.find((entry: { id: string }) => entry.id === 'reopen-selected')).toMatchObject({
        status: 'next', projectId: 'archived-project', sectionId: 'named-section',
    });
    expect(saved.tasks.find((entry: { id: string }) => entry.id === 'keep-completed')).toMatchObject({
        status: 'done', completedAt: archivedAt,
    });
});
