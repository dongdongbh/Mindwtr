import { afterEach, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { createTaskDraft } from './task-draft';
import type { ChecklistItem, Project, Task } from './types';

const now = '2026-10-01T12:00:00.000Z';
const task = (id: string, fields: Partial<Task> = {}): Task => ({
    id, title: 'Saved title', status: 'next', priority: 'high', timeEstimate: '30min',
    contexts: ['saved'], tags: [], description: 'Saved description',
    checklist: [{ id: 'saved-step', title: 'Saved step', isCompleted: false }],
    dueDate: '2026-10-03', createdAt: now, updatedAt: now, ...fields,
});
const project = (id: string, status: Project['status']): Project => ({
    id, title: id, status, color: '#94a3b8', order: 0, tagIds: [], createdAt: now, updatedAt: now,
});
const saved = task('t-share', { projectId: 'p-live' });
const rows = [saved, task('t-archived', { projectId: 'p-archived' }),
    task('t-deleted', { deletedAt: now }), task('t-purged', { purgedAt: now }),
    task('t-share:projected-recurrence')];
const copy = <T,>(item: T): T => JSON.parse(JSON.stringify(item)) as T;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const open = async () => {
    await flushPendingSave();
    resetForTests();
    let data = copy({ tasks: rows, projects: [project('p-live', 'active'), project('p-archived', 'archived')],
        sections: [], areas: [], people: [], settings: {} });
    const saveData = vi.fn(async (next: unknown) => { data = copy(next) as typeof data; });
    setStorageAdapter({ getData: async () => data, saveData });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
    value(await host.activate({ writeSafetyReady: true }));
    saveData.mockClear();
    return { host, saveData };
};
const request = (id = 't-share') => {
    const row = useTaskStore.getState()._tasksById.get(id)!;
    return { id, taskRevision: taskRevisionOf(row), draft: createTaskDraft(row),
        checklist: row.checklist ?? [] };
};

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    vi.restoreAllMocks();
});

it('shares unsaved title, description, and checklist without changing any stored row or saving', async () => {
    const { host, saveData } = await open();
    const before = copy(useTaskStore.getState()._allTasks);
    const input = request();
    input.draft.title = '  Unsaved 🌍  ';
    input.draft.description = '  Unsaved notes  ';
    input.checklist = [{ id: 'draft-step', title: 'Unsaved step', isCompleted: true }];
    const result = value(host.getTaskShare(input));
    expect(result.title).toBe('Unsaved 🌍');
    expect(result.message).toContain('Unsaved 🌍');
    expect(result.message).toContain('Unsaved notes');
    expect(result.message).toContain('[x] Unsaved step');
    expect(result.message).not.toContain('Saved step');
    expect(result.message).not.toContain('Saved description');
    expect(useTaskStore.getState()._allTasks).toEqual(before);
    expect(saveData).not.toHaveBeenCalled();
});

it('refuses stale, missing, deleted, purged, projected, and archived-parent targets', async () => {
    const { host } = await open();
    const current = request();
    expect(host.getTaskShare({ ...current, taskRevision: 'old' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(host.getTaskShare({ ...current, id: 'missing' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
    for (const id of ['t-deleted', 't-purged', 't-share:projected-recurrence', 't-archived']) {
        expect(host.getTaskShare(request(id))).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
    }
    useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 't-share'
        ? { ...row, rev: (row.rev ?? 0) + 1 } : row) }));
    expect(host.getTaskShare(current)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
});

it('rejects malformed input and Unicode byte overflow before formatting', async () => {
    const { host, saveData } = await open();
    const current = request();
    const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
    for (const input of [null, {}, { ...current, extra: true }, { ...current, id: '' },
        { ...current, id: 'x'.repeat(201) }, { ...current, taskRevision: '' },
        { ...current, taskRevision: 'x'.repeat(201) }, { ...current, draft: {} },
        { ...current, checklist: [{ id: 'x', title: 'bad', isCompleted: 'yes' }] }]) {
        expect(host.getTaskShare(input as never)).toMatchObject(invalid);
    }
    const oversized = copy(current);
    oversized.draft.description = 'é'.repeat(1_000_001);
    expect(host.getTaskShare(oversized)).toMatchObject(invalid);
    expect(saveData).not.toHaveBeenCalled();
});

it('says why Create project cannot expand the editor draft\'s checklist (RN\'s checklistProjectBlockReason), writing nothing', async () => {
    const { host, saveData } = await open();
    const input = copy(request());
    expect(value(host.getTaskChecklistProjectBlock(input))).toEqual({ blocked:
        'Keep the checklist together, or clear the assignee, location, time estimate and recorded time before expanding. These task details cannot be transferred to a project.' });
    input.draft.timeEstimate = '';
    expect(value(host.getTaskChecklistProjectBlock(input))).toEqual({ blocked: null });
    input.checklist = [{ id: 'blank', title: ' ', isCompleted: false }];
    expect(value(host.getTaskChecklistProjectBlock(input))).toEqual({ blocked: 'Expansion needs a checklist with a title on every item.' });
    expect(host.getTaskChecklistProjectBlock({ ...input, taskRevision: 'old' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(host.getTaskChecklistProjectBlock({ ...input, extra: 1 } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(saveData).not.toHaveBeenCalled();
});
