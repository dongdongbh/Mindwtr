import { afterEach, describe, expect, it } from 'vitest';

import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { consoleLogger, setLogger } from './logger';
import {
    batchUpdateTasksFromLatest, mergeTaskDraftOntoLatest, saveTaskDraftOntoLatest, updateProjectFromDraft, updateProjectFromLatest, updateSettingsFromLatest,
    updateTaskFromDraft, updateTaskFromLatest,
} from './store-latest-updates';
import { runSyncStoreSave } from './store-write-gate';
import type { Attachment, Project, Task } from './types';

const AT = new Date(Date.now() - 60_000).toISOString();
const file = (id: string, extra: Partial<Attachment> = {}): Attachment => ({
    id, kind: 'file', title: `${id}.pdf`, uri: '', localStatus: 'missing', createdAt: AT, updatedAt: AT, ...extra,
} as Attachment);
const task = (extra: Partial<Task> = {}): Task => ({
    id: 't1', title: 'Task', status: 'next', tags: ['a'], contexts: [], attachments: [file('A')], rev: 1, createdAt: AT, updatedAt: AT, ...extra,
} as Task);
const project = (extra: Partial<Project> = {}): Project => ({
    id: 'p1', title: 'Project', status: 'active', color: '#3b82f6', order: 0, tagIds: [], attachments: [file('A')],
    rev: 1, createdAt: AT, updatedAt: AT, ...extra,
} as Project);

/** A sync save holds the gate while [write] is called, then publishes [publish] before the write is admitted. */
async function behindSyncSave<T>(publish: () => void, write: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const save = runSyncStoreSave(async () => { await held; publish(); });
    const written = write();
    release();
    await save;
    return written;
}

describe('writes built from the latest row', () => {
    afterEach(async () => { await flushPendingSave(); resetForTests(); });

    it('builds a project attachment list on the row a sync save published while the write waited', async () => {
        useTaskStore.setState({ _allProjects: [project()] });
        const result = await behindSyncSave(
            () => useTaskStore.setState({ _allProjects: [project({ rev: 3, attachments: [file('A'), file('B')] })] }),
            () => updateProjectFromLatest('p1', (latest) => ({
                attachments: (latest.attachments ?? []).map((item) => item.id === 'A' ? { ...item, localStatus: 'available' as const } : item),
            })),
        );
        expect(result.success).toBe(true);
        expect(useTaskStore.getState()._projectsById.get('p1')?.attachments?.map((item) => [item.id, item.localStatus]))
            .toEqual([['A', 'available'], ['B', 'missing']]);
    });

    it('adds a tag to each task on its latest row', async () => {
        useTaskStore.setState({ _allTasks: [task()] });
        await behindSyncSave(
            () => useTaskStore.setState({ _allTasks: [task({ rev: 3, tags: ['a', 'remote'] })] }),
            () => batchUpdateTasksFromLatest(['t1'], (latest) => ({ tags: [...latest.tags, 'added'] })),
        );
        expect(useTaskStore.getState()._tasksById.get('t1')?.tags).toEqual(['a', 'remote', 'added']);
    });

    it('builds a task checklist on its latest row', async () => {
        useTaskStore.setState({ _allTasks: [task({ checklist: [{ id: 'c1', title: 'One', isCompleted: false }] })] });
        await behindSyncSave(
            () => useTaskStore.setState({ _allTasks: [task({ rev: 3, checklist: [{ id: 'c1', title: 'One', isCompleted: false }, { id: 'c2', title: 'Two', isCompleted: false }] })] }),
            () => updateTaskFromLatest('t1', (latest) => ({
                checklist: (latest.checklist ?? []).map((item) => item.id === 'c1' ? { ...item, isCompleted: true } : item),
            })),
        );
        expect(useTaskStore.getState()._tasksById.get('t1')?.checklist?.map((item) => [item.id, item.isCompleted]))
            .toEqual([['c1', true], ['c2', false]]);
    });

    it('saves a settings group built from the settings a sync save published while the write waited', async () => {
        useTaskStore.setState({ settings: { gtd: { defaultScheduleTime: '09:00' } } as never });
        await behindSyncSave(
            () => useTaskStore.setState({ settings: { gtd: { defaultScheduleTime: '09:00', autoArchiveDays: 3 } } as never }),
            () => updateSettingsFromLatest((latest) => ({ gtd: { ...latest.gtd, defaultScheduleTime: '10:00' } })),
        );
        expect(useTaskStore.getState().settings.gtd).toMatchObject({ defaultScheduleTime: '10:00', autoArchiveDays: 3 });
    });
});

describe('a draft saved field by field on the latest row', () => {
    afterEach(async () => { await flushPendingSave(); resetForTests(); });
    const item = (id: string, isCompleted = false) => ({ id, title: id, isCompleted });

    it('writes only the fields the draft changed, and merges a list both sides changed', () => {
        const base = task({ title: 'Old', tags: ['a', 'b'], checklist: [item('c1'), item('c2')], priority: 'low' });
        const latest = task({ title: 'Remote title', tags: ['a', 'b', 'remote'], checklist: [item('c1'), item('c2', true), item('c3')], priority: 'high' });
        const draft = { title: 'Old', tags: ['b', 'mine'], checklist: [item('c1', true), item('c2'), item('c4')], priority: 'medium' as const };
        expect(mergeTaskDraftOntoLatest(base, draft, latest)).toEqual({
            // The draft kept the title: the other device's title stays (nothing written).
            tags: ['b', 'remote', 'mine'],
            checklist: [item('c1', true), item('c2', true), item('c3'), item('c4')],
            priority: 'medium',
        });
    });

    it('writes the draft list as it is (a reorder stays) when nobody else changed that list', () => {
        const base = task({ checklist: [item('c1'), item('c2')] });
        expect(mergeTaskDraftOntoLatest(base, { checklist: [item('c2'), item('c1')] }, task({ title: 'Remote', checklist: [item('c1'), item('c2')] })))
            .toEqual({ checklist: [item('c2'), item('c1')] });
    });

    it('never brings back an item either side removed: tags, contexts, checklist and attachments', () => {
        const att = (id: string, extra: Partial<Attachment> = {}) => file(id, extra);
        const base = task({ tags: ['x', 'k'], contexts: ['@x', '@k'], checklist: [item('x'), item('k')], attachments: [att('X'), att('K')] });
        // The user removes X; another device adds Y.
        const remoteAdded = task({ tags: ['x', 'k', 'y'], contexts: ['@x', '@k', '@y'], checklist: [item('x'), item('k'), item('y')],
            attachments: [att('X'), att('K'), att('Y')] });
        const userRemoved = { tags: ['k'], contexts: ['@k'], checklist: [item('k')],
            attachments: [att('X', { deletedAt: AT }), att('K')] };
        expect(mergeTaskDraftOntoLatest(base, userRemoved, remoteAdded)).toEqual({
            tags: ['k', 'y'], contexts: ['@k', '@y'], checklist: [item('k'), item('y')],
            attachments: [att('X', { deletedAt: AT }), att('K'), att('Y')],
        });
        // Another device removes X; the user edits another field and leaves the lists as opened.
        const remoteRemoved = task({ tags: ['k'], contexts: ['@k'], checklist: [item('k')], attachments: [att('X', { deletedAt: AT }), att('K')] });
        expect(mergeTaskDraftOntoLatest(base, { title: 'Edited', tags: base.tags, contexts: base.contexts, checklist: base.checklist,
            attachments: base.attachments }, remoteRemoved)).toEqual({ title: 'Edited' });
        // Another device removes X; the user adds Z to every list: X stays removed.
        expect(mergeTaskDraftOntoLatest(base, { tags: ['x', 'k', 'z'], contexts: ['@x', '@k', '@z'], checklist: [item('x'), item('k'), item('z')],
            attachments: [att('X'), att('K'), att('Z')] }, task({ ...remoteRemoved, attachments: [att('K')] }))).toEqual({
            tags: ['k', 'z'], contexts: ['@k', '@z'], checklist: [item('k'), item('z')], attachments: [att('K'), att('Z')],
        });
    });

    it('keeps untouched fields only when asked and nobody else changed them', () => {
        const base = task({ title: 'Same', tags: ['a'] });
        const latest = task({ title: 'Same', tags: ['a', 'remote'], priority: 'high' });
        expect(mergeTaskDraftOntoLatest(base, { title: 'Same', tags: ['a', 'mine'], priority: undefined }, latest, { keepUntouched: true }))
            .toEqual({ title: 'Same', tags: ['a', 'remote', 'mine'] });
    });

    it('logs a kept synced change only for a list both sides changed, and only after the write', async () => {
        const logs: Array<{ message?: string; context?: Record<string, unknown> }> = [];
        setLogger((entry) => { logs.push(entry as never); });
        try {
            const base = task({ tags: ['a'], priority: 'low' });
            useTaskStore.setState({ _allTasks: [task({ rev: 3, tags: ['a', 'remote'], priority: 'high' })] });
            await updateTaskFromDraft('t1', base, { tags: ['a', 'mine'], priority: 'medium' });
            const kept = logs.filter((entry) => entry.message === 'Draft saved onto a synced change');
            expect(kept).toEqual([expect.objectContaining({ context: expect.objectContaining({ releaseCheck: 'v1.3.7/sync-field-merge', entity: 'task', fields: 'tags' }) })]);
            logs.length = 0;
            // Only a single value both sides changed: the draft wins it, and nothing was kept, so nothing is logged.
            await updateTaskFromDraft('t1', task({ priority: 'medium' }), { priority: 'low' });
            expect(logs.filter((entry) => entry.message === 'Draft saved onto a synced change')).toEqual([]);
        } finally {
            setLogger(consoleLogger);
        }
    });

    it('logs nothing when the write fails, or when no item from the other device survived the merge', async () => {
        const logs: Array<{ message?: string }> = [];
        setLogger((entry) => { logs.push(entry as never); });
        const kept = () => logs.filter((entry) => entry.message === 'Draft saved onto a synced change');
        try {
            const base = task({ tags: ['a'] });
            useTaskStore.setState({ _allTasks: [task({ rev: 3, tags: ['a', 'remote'] })] });
            await saveTaskDraftOntoLatest('t1', base, { tags: ['a', 'mine'] }, { write: async () => ({ success: false, error: 'disk full' }) });
            expect(kept()).toEqual([]);
            // The other device removed tag a; the draft removed it too and added b: nothing of the other side's is left.
            useTaskStore.setState({ _allTasks: [task({ rev: 4, tags: [] })] });
            await saveTaskDraftOntoLatest('t1', base, { tags: ['b'] });
            expect(useTaskStore.getState()._tasksById.get('t1')?.tags).toEqual(['b']);
            expect(kept()).toEqual([]);
        } finally {
            setLogger(consoleLogger);
        }
    });

    it('sends the relative start with a due change the draft made, so the store keeps the link', () => {
        const offset = { amount: -3, unit: 'day' } as Task['relativeStartOffset'];
        const base = task({ dueDate: '2026-10-20', startTime: '2026-10-17', relativeStartOffset: offset });
        expect(mergeTaskDraftOntoLatest(base, { dueDate: '2026-10-25', startTime: '2026-10-22', relativeStartOffset: offset }, base))
            .toEqual({ dueDate: '2026-10-25', startTime: '2026-10-22', relativeStartOffset: offset });
    });

    it('merges a checklist item both sides edited by field: the rename and the tick both stay', () => {
        const base = task({ checklist: [{ id: 'c1', title: 'One', isCompleted: false }] });
        expect(mergeTaskDraftOntoLatest(base, { checklist: [{ id: 'c1', title: 'Renamed', isCompleted: false }] },
            task({ checklist: [{ id: 'c1', title: 'One', isCompleted: true }] }))).toEqual({ checklist: [{ id: 'c1', title: 'Renamed', isCompleted: true }] });
    });

    it('saves a task draft and a project draft on the rows a sync save published while they waited', async () => {
        const base = task({ tags: ['a'] });
        const projectBase = project({ tagIds: ['t1'] });
        useTaskStore.setState({ _allTasks: [base], _allProjects: [projectBase] });
        await behindSyncSave(
            () => useTaskStore.setState({ _allTasks: [task({ rev: 3, title: 'Remote', tags: ['a', 'remote'] })], _allProjects: [project({ rev: 3, title: 'Remote', tagIds: ['t1', 't2'] })] }),
            async () => {
                await updateTaskFromDraft('t1', base, { title: base.title, tags: ['a', 'mine'] });
                await updateProjectFromDraft('p1', projectBase, { title: projectBase.title, tagIds: ['t1', 't3'] });
            },
        );
        expect(useTaskStore.getState()._tasksById.get('t1')).toMatchObject({ title: 'Remote', tags: ['a', 'remote', 'mine'] });
        expect(useTaskStore.getState()._projectsById.get('p1')).toMatchObject({ title: 'Remote', tagIds: ['t1', 't2', 't3'] });
    });
});
