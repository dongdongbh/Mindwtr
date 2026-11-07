import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { AppData, Task } from './types';

const OLD = '2026-10-12T12:00:00.000Z';
let request = 0;
const requestId = () => `00000000-0000-4000-8000-${String(1415 + ++request).padStart(12, '0')}`;
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next', projectId: 'project',
    createdAt: OLD, updatedAt: OLD, rev: 2, revBy: 'device-a', tags: [], contexts: [], order: 2, orderNum: 2, ...extra });
const seed = (): Partial<AppData> => ({
    tasks: [task('one'), task('two', { tags: ['#keep'] }), task('three'), task('foreign', { projectId: 'other' })],
    projects: ['project', 'other'].map((id) => ({ id, title: id, status: 'active' as const, tagIds: [], createdAt: OLD, updatedAt: OLD,
        rev: 1, revBy: 'device-a', order: 0, color: '#94a3b8' })),
    settings: { deviceId: 'device-a', gtd: { autoArchiveDays: 0 } },
});
const params = { projectId: 'project', showCompleted: false, completedCollapsed: true, filters: {} };
const stored = (id: string) => useTaskStore.getState()._tasksById.get(id);
afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('Android Project task selection writes (RN #1415, #1477)', () => {
    const open = async () => {
        const s = await openSqliteHost(seed());
        const revisions = (taskIds: string[]) => value(s.host.getBulkActions({ list: 'project', params, taskIds })).taskRevisions;
        const run = (action: Record<string, unknown>, scope: unknown = params) =>
            s.host.runBulkAction({ requestId: requestId(), list: 'project', params: scope, action } as never);
        return { s, revisions, run };
    };

    it('keeps the Project selection read iOS validates: the exact key set CoreModel.validateProjectTaskBulk checks', async () => {
        const { s } = await open();
        try {
            const bulk = value(s.host.getBulkActions({ list: 'project', params, taskIds: ['one'] }));
            expect(Object.keys(bulk).sort()).toEqual(['version', 'revision', 'list', 'selectedIds', 'taskRevisions', 'selectedCount', 'anchorId', 'selectAll',
                'selectableCount', 'bar', 'labels', 'addTag', 'removeTag', 'deleteConfirmation', 'moveToSection', 'organize', 'picker'].sort());
            expect(bulk).toMatchObject({ list: 'project', selectAll: null, selectedIds: ['one'] });
        } finally { await s.close(); }
    });

    it('moves the selected Project tasks to a status once, the RN batch move', async () => {
        const { s, revisions, run } = await open();
        try {
            const result = value(await run({ type: 'moveTasks', status: 'waiting', taskIds: ['one', 'two'], taskRevisions: revisions(['one', 'two']) }));
            expect(result.changed).toBe(true);
            expect(['one', 'two', 'three'].map((id) => stored(id)?.status)).toEqual(['waiting', 'waiting', 'next']);
            expect(stored('one')?.rev).toBe(3);
        } finally { await s.close(); }
    });

    it('adds a tag, removes one and organizes the selected Project tasks', async () => {
        const { s, revisions, run } = await open();
        try {
            value(await run({ type: 'editTaskTokens', field: 'tags', mode: 'add', values: ['urgent'], taskIds: ['one'], taskRevisions: revisions(['one']) }));
            expect(stored('one')?.tags).toEqual(['#urgent']);
            value(await run({ type: 'editTaskTokens', field: 'tags', mode: 'remove', values: ['#keep'], taskIds: ['two'], taskRevisions: revisions(['two']) }));
            expect(stored('two')?.tags).toEqual([]);
            value(await run({ type: 'organize', draft: { contexts: '@desk' }, taskIds: ['three'], taskRevisions: revisions(['three']) }));
            expect(stored('three')?.contexts).toEqual(['@desk']);
        } finally { await s.close(); }
    });

    it('trashes the selection and its Undo restores it', async () => {
        const { s, revisions, run } = await open();
        try {
            const trashed = value(await run({ type: 'trashTasks', taskIds: ['one', 'three'], taskRevisions: revisions(['one', 'three']) }));
            expect(Boolean(stored('one')?.deletedAt && stored('three')?.deletedAt)).toBe(true);
            const undo = trashed.toast?.undo?.action;
            expect(undo).toMatchObject({ type: 'restoreTasks', taskIds: ['one', 'three'] });
            value(await run(undo as unknown as Record<string, unknown>));
            expect([stored('one')?.deletedAt, stored('three')?.deletedAt]).toEqual([undefined, undefined]);
        } finally { await s.close(); }
    });

    it('refuses a task outside the Project, Select all, and missing Project params without writing', async () => {
        const { s, revisions, run } = await open();
        try {
            const before = JSON.stringify(useTaskStore.getState()._allTasks);
            expect(await run({ type: 'moveTasks', status: 'waiting', taskIds: ['one', 'foreign'], taskRevisions: { ...revisions(['one']), foreign: 'x' } }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await run({ type: 'moveTasks', status: 'waiting', selectAll: { params, revision: 'r' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await run({ type: 'moveTasks', status: 'waiting', taskIds: ['one'], taskRevisions: revisions(['one']) }, null))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(JSON.stringify(useTaskStore.getState()._allTasks)).toBe(before);
        } finally { await s.close(); }
    });

    it('creates a Project from the organize picker for a Project selection', async () => {
        const { s } = await open();
        try {
            expect(await s.host.createBulkOrganizeDestination({ requestId: requestId(), list: 'project', kind: 'project', name: 'Garden', draft: {} } as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const made = value(await s.host.createBulkOrganizeDestination({ requestId: requestId(), list: 'project', params, kind: 'project', name: 'Garden', draft: {} } as never));
            expect(made.changed).toBe(true);
            expect(useTaskStore.getState()._allProjects.some((project) => project.title === 'Garden')).toBe(true);
        } finally { await s.close(); }
    });
});
