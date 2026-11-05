import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import * as logger from './logger';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';
import { generateUUID } from './uuid';


const T0 = '2026-09-01T00:00:00.000Z';
const editTask = (): Task => ({
    id: 'edit', title: 'Opened', status: 'next', contexts: ['@old'], tags: ['#old'], description: 'Before',
    checklist: [{ id: 'c1', title: 'One', isCompleted: false }],
    createdAt: T0, updatedAt: T0, rev: 3, revBy: 'phone',
});
const inboxTask = (): Task => ({
    id: 'inbox-a', title: 'Call the plumber', status: 'inbox', contexts: [], tags: [],
    createdAt: T0, updatedAt: T0, rev: 1, revBy: 'phone',
});

describe('native saves keep a change synced while the draft was open', () => {
    let durable: AppData;
    let host: ReturnType<typeof createNativeHostContract>;
    const stored = (id: string) => useTaskStore.getState()._tasksById.get(id)!;

    const syncedChange = async (id: string, updates: Partial<Task>) => {
        await flushPendingSave();
        durable = { ...durable, tasks: durable.tasks.map((item) => (item.id === id
            ? { ...item, ...updates, rev: (item.rev ?? 0) + 5, revBy: 'desktop', updatedAt: '2026-09-02T00:00:00.000Z' }
            : item)) };

        await useTaskStore.getState().fetchData({ throwOnError: true });
    };

    beforeEach(async () => {
        durable = { tasks: [editTask(), inboxTask()], projects: [], sections: [], areas: [], people: [], settings: {} };
        setStorageAdapter({ getData: async () => structuredClone(durable), saveData: async (data) => { durable = structuredClone(data); } });
        resetForTests();
        host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        await flushPendingSave();
    });
    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    const editorSave = (mergeSyncedChanges?: boolean) => host.saveTaskDraft({
        id: 'edit',
        base: { title: 'Opened', tags: '#old' },
        patch: { title: 'Mine', tags: '#old, #mine' },
        checklist: { base: [{ id: 'c1', title: 'One', isCompleted: false }], value: [{ id: 'c1', title: 'One renamed', isCompleted: false }] },
        requestId: generateUUID(),
        ...(mergeSyncedChanges === undefined ? {} : { mergeSyncedChanges }),
    } as never);
    const desktopEdits = () => syncedChange('edit', {
        title: 'Desktop title', tags: ['#old', '#synced'],
        checklist: [{ id: 'c1', title: 'One', isCompleted: true }, { id: 'c2', title: 'Two', isCompleted: false }],
    });

    it('merges the editor\'s lists onto the latest task and keeps its own title', async () => {
        await desktopEdits();
        const info = vi.spyOn(logger, 'logInfo');

        expect(await editorSave(true)).toMatchObject({ ok: true });

        const task = stored('edit');
        expect(task.title).toBe('Mine');
        expect([...task.tags].sort()).toEqual(['#mine', '#old', '#synced']);
        expect(task.checklist).toEqual([
            { id: 'c1', title: 'One renamed', isCompleted: true },
            { id: 'c2', title: 'Two', isCompleted: false },
        ]);
        expect(info).toHaveBeenCalledWith('Native draft saved onto a synced change', expect.objectContaining({
            context: expect.objectContaining({ releaseCheck: 'v1.3.8/native-draft-merge', fields: 'checklist,tags,title' }),
        }));
    });


    it('keeps a tag another device added when the editor only normalized the stored tags', async () => {
        await flushPendingSave();
        durable = { ...durable, tasks: durable.tasks.map((item) => (item.id === 'edit' ? { ...item, tags: ['work'] } : item)) };
        await useTaskStore.getState().fetchData({ throwOnError: true });
        await syncedChange('edit', { tags: ['work', '#x'] });

        expect(await host.saveTaskDraft({ id: 'edit', base: { tags: 'work' }, patch: { tags: '#work' }, requestId: generateUUID(), mergeSyncedChanges: true } as never))
            .toMatchObject({ ok: true });

        expect(stored('edit').tags).toContain('#x');
    });

    it('still refuses a conflicting editor save when the host does not opt in', async () => {
        await desktopEdits();

        expect(await editorSave()).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(stored('edit').title).toBe('Desktop title');
    });

    const processInbox = async (mergeSyncedChanges?: boolean) => {
        const started = host.startInboxProcessing({ mode: 'guided', ...(mergeSyncedChanges === undefined ? {} : { mergeSyncedChanges }) } as never);
        if (!started.ok || !started.value.sessionId) throw new Error('Process Inbox did not start');
        const sessionId = started.value.sessionId;
        expect(host.getInboxProcessingStep({ sessionId, taskId: 'inbox-a', step: 'actionable', edit: { type: 'set', field: 'description', value: 'My note' } }))
            .toMatchObject({ ok: true });
        expect(await host.commitInboxProcessingStep({ sessionId, taskId: 'inbox-a', step: 'actionable', decision: { choice: 'later' }, requestId: generateUUID() }))
            .toMatchObject({ ok: true });
        expect(host.getInboxProcessingStep({ sessionId, taskId: 'inbox-a', step: 'later', edit: { type: 'setPickedDate', field: 'startTime', day: '2026-10-05' } }))
            .toMatchObject({ ok: true });

        await syncedChange('inbox-a', { contexts: ['@synced'] });
        return host.commitInboxProcessingStep({ sessionId, taskId: 'inbox-a', step: 'later', decision: { choice: 'fileIt' }, requestId: generateUUID() });
    };

    it('lets Process Inbox finish an item another device changed, keeping both edits', async () => {
        const info = vi.spyOn(logger, 'logInfo');
        expect(await processInbox(true)).toMatchObject({ ok: true });
        expect(info).toHaveBeenCalledWith('Native Process Inbox saved onto a synced change', expect.objectContaining({
            context: expect.objectContaining({ releaseCheck: 'v1.3.8/native-draft-merge', fields: 'contexts' }),
        }));

        const task = stored('inbox-a');
        expect(task.description).toBe('My note');
        expect(task.startTime).toBe('2026-10-05');
        expect(task.contexts).toEqual(['@synced']);
    });

    it('still ends a Process Inbox step on a synced change when the host does not opt in', async () => {
        expect(await processInbox()).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });
});
