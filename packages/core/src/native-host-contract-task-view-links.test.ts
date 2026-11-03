import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { createTaskDraft } from './task-draft';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { Project, Task } from './types';

const at = '2026-10-01T12:00:00.000Z';
const notes = '# [[task:live|Heading]]\n\n'
    + 'See [[project:target|Project]], [Web](https://example.org/private), [[task:gone|Gone]], '
    + 'and [[project:deleted|Deleted]].\n\n'
    + '- [[task:archived|Archived]]\n- [[project:archived-project|Archived project]]\n\n'
    + '1. [[task:source|Self]]\n\n- [ ] [[task:live|Check]]';
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at, ...extra,
});
const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at, ...extra,
});
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
};

describe('Task View reference target', () => {
    let host: ReturnType<typeof createNativeHostContract>;
    let writes: ReturnType<typeof vi.fn>;
    let view: Parameters<typeof host.getTaskViewReferenceTarget>[0]['view'];
    let revision: string;
    const input = (blockIndex: number, inlineIndex: number, itemIndex?: number) => ({
        view, revision, blockIndex, ...(itemIndex === undefined ? {} : { itemIndex }), inlineIndex,
    });
    const checklistInput = (checklistIndex: number, inlineIndex: number) => ({ view, revision, checklistIndex, inlineIndex });
    const projectInput = () => ({ view, revision, field: 'project' as const });
    const tokenInput = (field: 'contexts' | 'tags', tokenIndex: number) => ({ view, revision, field, tokenIndex });
    const read = (request: Parameters<typeof host.getTaskViewReferenceTarget>[0]) => host.getTaskViewReferenceTarget(request);
    const saved = () => useTaskStore.getState()._tasksById.get('source') as Task;
    const refresh = () => { revision = value(host.getTaskView(view)).revision; };
    const changeTask = (id: string, patch: Partial<Task>) => useTaskStore.setState((state) => {
        const tasks = state._allTasks.map((row) => row.id === id ? { ...row, ...patch } : row);
        return { _allTasks: tasks, _tasksById: new Map(tasks.map((row) => [row.id, row])) };
    });

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(at));
        resetForTests();
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 });
        const projects = [project('target'), project('archived-project', { status: 'archived' }), project('deleted', { deletedAt: at })];
        const tasks = [task('source', { description: notes,
            checklist: [{ id: 'c1', title: 'Saved item', isCompleted: false }],
            attachments: [{ id: 'a1', kind: 'link', title: 'Site', uri: 'https://example.org', createdAt: at, updatedAt: at }],
        }), task('live'), task('archived', { status: 'archived' }), task('gone', { deletedAt: at })];
        writes = vi.fn().mockResolvedValue(undefined);
        setStorageAdapter({ getData: async () => ({ tasks, projects, sections: [], areas: [], people: [], settings: {} }), saveData: writes });
        host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        view = { id: 'source', draft: createTaskDraft(saved()), checklist: saved().checklist, attachments: saved().attachments };
        refresh();
        writes.mockClear();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
    });

    it('resolves the rendered heading, paragraph, list, task list and self links without writing', () => {
        expect(read(input(0, 0))).toEqual({ ok: true, value: { kind: 'task', id: 'live' } });
        expect(read(input(2, 1))).toEqual({ ok: true, value: { kind: 'project', id: 'target' } });
        expect(read(input(4, 0, 0))).toEqual({ ok: true, value: { kind: 'task', id: 'archived' } });
        expect(read(input(4, 0, 1))).toEqual({ ok: true, value: { kind: 'project', id: 'archived-project' } });
        expect(read(input(6, 0, 0))).toEqual({ ok: true, value: { kind: 'task', id: 'source' } });
        expect(read(input(8, 0, 0))).toEqual({ ok: true, value: { kind: 'task', id: 'live' } });
        expect(writes).not.toHaveBeenCalled();
    });

    it('resolves only the rendered Project and exact context and tag tokens', () => {
        changeTask('source', { projectId: 'target', contexts: ['  Deep Work  ', 'same', 'same'], tags: ['MiXeD', 'same', 'same'] });
        view = { ...view, draft: createTaskDraft(saved()) };
        refresh();
        const rows = value(host.getTaskView(view)).rows;
        expect(rows.find((row) => row.type === 'field' && row.field === 'project'))
            .toMatchObject({ project: { id: 'target' } });
        expect(rows.find((row) => row.type === 'tokens' && row.field === 'contexts'))
            .toMatchObject({ items: [{ value: '@Deep Work' }, { value: '@same' }, { value: '@same' }] });
        expect(read(projectInput())).toEqual({ ok: true, value: { kind: 'project', id: 'target' } });
        expect(read(tokenInput('contexts', 0))).toEqual({ ok: true, value: { kind: 'context', id: '@Deep Work' } });
        expect(read(tokenInput('contexts', 2))).toEqual({ ok: true, value: { kind: 'context', id: '@same' } });
        expect(read(tokenInput('tags', 0))).toEqual({ ok: true, value: { kind: 'tag', id: '#MiXeD' } });
        expect(read(tokenInput('tags', 2))).toEqual({ ok: true, value: { kind: 'tag', id: '#same' } });
        expect(writes).not.toHaveBeenCalled();
    });

    it('follows Reference visibility and archived rendering', () => {
        changeTask('source', { status: 'reference', projectId: 'target', contexts: ['hidden'], tags: ['visible'] });
        view = { ...view, draft: createTaskDraft(saved()) };
        refresh();
        expect(read(tokenInput('contexts', 0))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(read(tokenInput('tags', 0))).toEqual({ ok: true, value: { kind: 'tag', id: '#visible' } });
        expect(read(projectInput())).toEqual({ ok: true, value: { kind: 'project', id: 'target' } });
        changeTask('source', { status: 'archived', projectId: 'archived-project' });
        view = { ...view, draft: createTaskDraft(saved()) };
        refresh();
        expect(value(host.getTaskView(view)).readOnly).toBe(true);
        expect(read(projectInput())).toEqual({ ok: true, value: { kind: 'project', id: 'archived-project' } });
        expect(read(tokenInput('contexts', 0))).toEqual({ ok: true, value: { kind: 'context', id: 'hidden' } });
        expect(read(tokenInput('tags', 0))).toEqual({ ok: true, value: { kind: 'tag', id: 'visible' } });
        expect(writes).not.toHaveBeenCalled();
    });

    it('refuses absent, deleted and purged metadata targets or sources', () => {
        expect(read(projectInput())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(read(tokenInput('contexts', 0))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        changeTask('source', { projectId: 'target', contexts: ['value'], tags: ['tag'] });
        view = { ...view, draft: createTaskDraft(saved()) };
        refresh();
        for (const index of [1, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(read(tokenInput('contexts', index))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        for (const field of ['deletedAt', 'purgedAt'] as const) {
            useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'target'
                ? { ...row, [field]: at } : row) }));
            refresh();
            expect(read(projectInput())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'target'
                ? { ...row, [field]: undefined } : row) }));
            refresh();
        }
        for (const field of ['deletedAt', 'purgedAt'] as const) {
            changeTask('source', { [field]: at });
            expect(read(tokenInput('tags', 0))).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
            changeTask('source', { [field]: undefined });
            refresh();
        }
        expect(writes).not.toHaveBeenCalled();
    });

    it('refuses stale metadata rows, forged shapes and unsaved host state', () => {
        changeTask('source', { projectId: 'target', contexts: ['saved'], tags: ['saved-tag'] });
        view = { ...view, draft: createTaskDraft(saved()) };
        refresh();
        const malformed: unknown[] = [
            { ...projectInput(), tokenIndex: 0 }, { ...projectInput(), inlineIndex: 0 },
            { ...projectInput(), targetId: 'target' }, { ...projectInput(), field: 'section' },
            { ...tokenInput('contexts', 0), blockIndex: 0 }, { ...tokenInput('tags', 0), checklistIndex: 0 },
            { ...tokenInput('tags', 0), value: 'saved-tag' }, { ...tokenInput('tags', 0), tokenIndex: null },
            { ...tokenInput('tags', 0), view: { ...view, offset: 0 } },
            { ...tokenInput('tags', 0), revision: 'é'.repeat(1_000_000) },
        ];
        for (const candidate of malformed) {
            expect(host.getTaskViewReferenceTarget(candidate as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        view = { ...view, draft: { ...view.draft!, contexts: 'draft-only' } };
        expect(read(tokenInput('contexts', 0))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        view = { ...view, draft: createTaskDraft(saved()) };
        changeTask('source', { contexts: ['new-saved'] });
        expect(read(tokenInput('contexts', 0))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        refresh();
        expect(read(tokenInput('contexts', 0))).toEqual({ ok: true, value: { kind: 'context', id: '@saved' } });
        useTaskStore.setState({ persistenceFailure: { message: 'private disk failure', failedAt: at, retrying: false } });
        expect(read(projectInput())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(createNativeHostContract().getTaskViewReferenceTarget(projectInput()))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(writes).not.toHaveBeenCalled();
    });

    it('resolves the original checklist index past the first page, even with duplicate item IDs', () => {
        const checklist = Array.from({ length: 150 }, (_, index) => ({
            id: 'duplicate', title: index === 101 ? 'See [[task:live|Live]]' : 'Plain', isCompleted: false,
        }));
        changeTask('source', { checklist });
        view = { ...view, draft: createTaskDraft(saved()), checklist };
        refresh();
        const page = value(host.getTaskView({ ...view, offset: 101, limit: 1, revision })).rows
            .find((row) => row.type === 'checklist');
        expect(page?.type === 'checklist' && page.items.map((item) => item.index)).toEqual([101]);
        expect(read(checklistInput(101, 1))).toEqual({ ok: true, value: { kind: 'task', id: 'live' } });
        expect(read(checklistInput(0, 1))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(read(checklistInput(150, 1))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(writes).not.toHaveBeenCalled();
    });

    it('resolves reference checklist and archived read-only checklist links without a description', () => {
        changeTask('source', { description: '', status: 'reference', checklist: [
            { id: 'c1', title: '[[project:target|Project]]', isCompleted: false },
        ] });
        view = { ...view, draft: createTaskDraft(saved()), checklist: saved().checklist };
        refresh();
        expect(value(host.getTaskView(view)).rows.find((row) => row.type === 'checklist'))
            .toMatchObject({ tappable: true });
        expect(read(checklistInput(0, 0))).toEqual({ ok: true, value: { kind: 'project', id: 'target' } });
        changeTask('source', { status: 'next', projectId: 'archived-project' });
        view = { ...view, draft: createTaskDraft(saved()) };
        refresh();
        expect(value(host.getTaskView(view))).toMatchObject({ readOnly: true });
        expect(read(checklistInput(0, 0))).toEqual({ ok: true, value: { kind: 'project', id: 'target' } });
        expect(writes).not.toHaveBeenCalled();
    });

    it('refuses stale checklist order, editor drafts and global data', () => {
        changeTask('source', { checklist: [
            { id: 'same', title: '[[task:live|Live]]', isCompleted: false },
            { id: 'same', title: '[[project:target|Project]]', isCompleted: false },
        ] });
        view = { ...view, draft: createTaskDraft(saved()), checklist: saved().checklist };
        refresh();
        const stale = () => expect(read(checklistInput(0, 0)))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        view = { ...view, checklist: [...view.checklist!].reverse() };
        stale();
        view = { ...view, checklist: saved().checklist };
        refresh();
        view = { ...view, draft: { ...view.draft!, title: 'Edited' } };
        stale();
        view = { ...view, draft: createTaskDraft(saved()) };
        refresh();
        changeTask('live', { title: 'Changed target' });
        stale();
        expect(writes).not.toHaveBeenCalled();
    });

    it('refuses malformed checklist positions and noninternal or deleted runs', () => {
        changeTask('source', { checklist: [{ id: 'c1',
            title: 'See [[task:live|Live]], [Web](https://example.org), [[task:gone|Gone]], plain', isCompleted: false }] });
        view = { ...view, draft: createTaskDraft(saved()), checklist: saved().checklist };
        refresh();
        expect(read(checklistInput(0, 1))).toEqual({ ok: true, value: { kind: 'task', id: 'live' } });
        for (const candidate of [
            { ...checklistInput(0, 1), blockIndex: 0 },
            { ...checklistInput(0, 1), itemIndex: 0 },
            { ...checklistInput(0, 1), targetId: 'live' },
            { ...checklistInput(0, 1), view: { ...view, offset: 0 } },
            { ...checklistInput(0, 1), checklistIndex: -1 },
            { ...checklistInput(0, 1), checklistIndex: 0.5 },
            { ...checklistInput(0, 1), checklistIndex: Number.MAX_SAFE_INTEGER + 1 },
            { ...checklistInput(0, 1), inlineIndex: -1 },
            { ...checklistInput(0, 1), inlineIndex: 0.5 },
            { ...checklistInput(0, 1), revision: 'é'.repeat(1_000_000) },
        ]) {
            expect(host.getTaskViewReferenceTarget(candidate as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        for (const index of [0, 2, 3, 4, 5, 6, 7]) {
            const result = read(checklistInput(0, index));
            expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(JSON.stringify(result)).not.toMatch(/example\.org|Gone/);
        }
        changeTask('live', { deletedAt: at });
        refresh();
        expect(read(checklistInput(0, 1))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(writes).not.toHaveBeenCalled();
    });

    it('refuses external, deleted, plain and forged positions with content-free errors', () => {
        const malformed: unknown[] = [null, {}, { ...input(0, 0), targetId: 'live' },
            { ...input(0, 0), view: { ...view, offset: 0 } },
            { ...input(0, 0), view: { ...view, id: '' } },
            { ...input(0, 0), view: { ...view, id: 'x'.repeat(501) } },
            { ...input(0, 0), view: { ...view, draft: {} } },
            { ...input(0, 0), view: { ...view, checklist: [{ id: 'bad' }] } },
            { ...input(0, 0), revision: '' }, { ...input(0, 0), revision: 'é'.repeat(1_000_000) },
            { ...input(0, 0), blockIndex: -1 },
            { ...input(0, 0), blockIndex: 0.1 }, { ...input(0, 0), blockIndex: Number.MAX_SAFE_INTEGER + 1 },
            { ...input(0, 0), inlineIndex: -1 }, { ...input(0, 0), inlineIndex: 0.5 },
            { ...input(4, 0), itemIndex: -1 }, { ...input(4, 0), itemIndex: null },
        ];
        for (const candidate of malformed) {
            expect(host.getTaskViewReferenceTarget(candidate as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        for (const request of [input(2, 3), input(2, 5), input(2, 7), input(2, 0),
            input(0, 0, 0), input(4, 0), input(4, 0, 3), input(4, 1, 0), input(99, 0), input(1, 0)]) {
            const result = read(request);
            expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(JSON.stringify(result)).not.toMatch(/Heading|example\.org|Gone|Deleted/);
        }
        expect(writes).not.toHaveBeenCalled();
    });

    it('refuses changed saved data and changed editor inputs at the rendered revision', () => {
        const stale = () => expect(read(input(0, 0))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        changeTask('live', { title: 'Changed target' });
        stale();
        refresh();
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'target'
            ? { ...row, title: 'Changed project' } : row) }));
        stale();
        refresh();
        changeTask('source', { description: '# Changed [[task:live|link]]' });
        stale();
        view = { ...view, draft: createTaskDraft(saved()) };
        refresh();
        view = { ...view, draft: { ...view.draft!, description: '# Another [[task:live|link]]' } };
        stale();
        view = { ...view, draft: createTaskDraft(saved()) };
        refresh();
        view = { ...view, checklist: [{ id: 'c1', title: 'Changed', isCompleted: false }] };
        stale();
        view = { ...view, checklist: saved().checklist };
        refresh();
        view = { ...view, attachments: [] };
        stale();
        view = { ...view, attachments: saved().attachments };
        refresh();
        expect(read({ ...input(0, 0), revision: 'x'.repeat(501) }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(writes).not.toHaveBeenCalled();
    });

    it('refuses deleted and purged source or target, and permits archived source', () => {
        changeTask('live', { purgedAt: at });
        refresh();
        expect(read(input(0, 0))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'target'
            ? { ...row, purgedAt: at } : row) }));
        refresh();
        expect(read(input(2, 1))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        changeTask('source', { purgedAt: at });
        expect(read(input(0, 0))).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        changeTask('source', { purgedAt: undefined, projectId: 'archived-project' });
        view = { id: 'source', draft: createTaskDraft(saved()), checklist: saved().checklist, attachments: saved().attachments };
        refresh();
        expect(read(input(4, 0, 1))).toEqual({ ok: true, value: { kind: 'project', id: 'archived-project' } });
        changeTask('source', { deletedAt: at });
        expect(read(input(2, 1))).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(writes).not.toHaveBeenCalled();
    });

    it('requires an active, saved host', () => {
        expect(createNativeHostContract().getTaskViewReferenceTarget(input(0, 0)))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        useTaskStore.setState({ persistenceFailure: { message: 'private disk failure', failedAt: at, retrying: false } });
        expect(read(input(0, 0))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(JSON.stringify(read(input(0, 0)))).not.toContain('private disk failure');
        expect(writes).not.toHaveBeenCalled();
    });
});
