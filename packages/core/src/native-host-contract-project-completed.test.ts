import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, NATIVE_HOST_MAX_WINDOW } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { buildProjectTaskListModel, getProjectDetailTaskListOptions, selectProjectTaskListTasks } from './project-task-list-model';
import { resolveNonDoneTaskSortBy } from './task-list-sort-options';
import { resolveTaskSortByForFeatures } from './task-utils';
import type { Area, Project, Section, Task } from './types';

const stamp = '2026-09-01T00:00:00.000Z';
const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: stamp, updatedAt: stamp, ...extra,
});
const task = (id: string, projectId: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
    id, title: id, projectId, status, tags: [], contexts: [], createdAt: stamp, updatedAt: stamp, ...extra,
});
const projects = [project('parallel'), project('sequential', { isSequential: true }), project('archived', { status: 'archived' })];
const tasks = [
    task('p-next', 'parallel', 'next'), task('p-done', 'parallel', 'done'), task('p-archived', 'parallel', 'archived'),
    task('p-ref', 'parallel', 'reference'), task('p-deleted', 'parallel', 'next', { deletedAt: stamp }),
    task('s-next', 'sequential', 'next'), task('s-done', 'sequential', 'done'),
    task('a-next', 'archived', 'next'), task('a-done', 'archived', 'done'), task('a-archived', 'archived', 'archived'),
];
const sections: Section[] = [];
const area = (id: string): Area => ({ id, name: id, order: 0, color: '#123456', icon: 'home', createdAt: stamp, updatedAt: stamp });
const saveData = vi.fn().mockResolvedValue(undefined);

describe('native Project completed view', () => {
    beforeEach(() => {
        saveData.mockClear();
        setStorageAdapter({ getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }), saveData });
        useTaskStore.setState({
            _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
        });
    });
    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    it('exposes the completed controls through the shared Project list model without writes', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        useTaskStore.setState({ _allTasks: tasks, _allProjects: projects, _allSections: sections });
        saveData.mockClear();
        const before = JSON.stringify([useTaskStore.getState()._allTasks, useTaskStore.getState()._allProjects,
            useTaskStore.getState()._allSections, useTaskStore.getState().settings]);
        for (const candidate of projects) for (const showCompleted of [false, true]) for (const completedCollapsed of [false, true]) {
            const result = host.getProjectDetailView({ projectId: candidate.id, offset: 0, limit: NATIVE_HOST_MAX_WINDOW, showCompleted, completedCollapsed });
            if (!result.ok) throw new Error(result.error.code);
            const state = useTaskStore.getState();
            const options = getProjectDetailTaskListOptions(candidate, showCompleted);
            const sortBy = resolveTaskSortByForFeatures(candidate.taskSortBy ?? 'default', state.settings);
            const model = buildProjectTaskListModel({
                project: candidate,
                tasks: selectProjectTaskListTasks(tasks.filter((item) => item.projectId === candidate.id && !item.deletedAt), {
                    projectId: candidate.id, statusFilter: 'all', includeArchived: options.includeArchived, includeDone: options.includeDone,
                }),
                visibleTasks: state.tasks, sections: state.sections, allSections: state._allSections,
                statusFilter: 'all', criteria: {}, searchQuery: '',
                sortBy: resolveNonDoneTaskSortBy(sortBy, state.settings), projectOrder: options.enableProjectReorder,
                reorderMode: false, groupCompletedTasksLast: options.groupCompletedTasksLast, completedCollapsed,
                t: (key) => key,
            });
            expect(result.value.items.map((item) => item.type === 'section'
                ? [item.type, item.id, item.count, item.collapsible, item.collapsed]
                : [item.type, item.row.id, item.sectionId]))
                .toEqual(model.items.map((item) => item.type === 'section'
                    ? [item.type, item.id, item.count, item.collapsible === true, item.collapsed === true]
                    : [item.type, item.task.id, item.reorderSectionId ?? null]));
            expect(result.value.controls).toMatchObject({
                showCompleted, completedCollapsed, canToggleCompleted: !options.readOnly,
                groupCompletedTasksLast: options.groupCompletedTasksLast,
                label: showCompleted ? 'Hide completed' : 'Show completed',
            });
        }
        expect(JSON.stringify([useTaskStore.getState()._allTasks, useTaskStore.getState()._allProjects,
            useTaskStore.getState()._allSections, useTaskStore.getState().settings])).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('binds paging to the exact project and controls while preserving the legacy detail shape', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        const revisedProjects = projects.map((item) => item.id === 'parallel'
            ? { ...item, rev: 7, revBy: 'remote-device' } : item);
        useTaskStore.setState({ _allTasks: tasks, _allProjects: revisedProjects, _allSections: sections });
        saveData.mockClear();
        const read = (projectId: string, showCompleted = true, completedCollapsed = false) => host.getProjectDetailView({
            projectId, offset: 0, limit: 2, showCompleted, completedCollapsed,
        });
        const first = read('parallel');
        if (!first.ok) throw new Error(first.error.code);
        const full = host.getProjectDetailView({ projectId: 'parallel', offset: 0, limit: NATIVE_HOST_MAX_WINDOW,
            showCompleted: true, completedCollapsed: false });
        if (!full.ok) throw new Error(full.error.code);
        const pages = [...first.value.items];
        for (let offset = 2; offset < full.value.total; offset += 2) {
            const page = host.getProjectDetailView({ projectId: 'parallel', offset, limit: 2,
                revision: first.value.revision, showCompleted: true, completedCollapsed: false });
            if (!page.ok) throw new Error(page.error.code);
            expect(page.value.projectRevision).toBe('7:remote-device:2026-09-01T00:00:00.000Z');
            pages.push(...page.value.items);
        }
        expect(pages).toEqual(full.value.items);
        for (const [projectId, showCompleted, completedCollapsed] of [
            ['parallel', false, false], ['parallel', true, true], ['sequential', true, false],
        ] as const) {
            expect(host.getProjectDetailView({ projectId, offset: 0, limit: 2,
                revision: first.value.revision, showCompleted, completedCollapsed }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(host.getProjectDetailView({ projectId, offset: 2, limit: 2,
                revision: first.value.revision, showCompleted, completedCollapsed }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        const legacy = host.getProjectDetail({ projectId: 'parallel', offset: 0, limit: NATIVE_HOST_MAX_WINDOW });
        const defaultView = host.getProjectDetailView({ projectId: 'parallel', offset: 0,
            limit: NATIVE_HOST_MAX_WINDOW, showCompleted: false, completedCollapsed: false });
        if (!legacy.ok || !defaultView.ok) throw new Error('Project detail failed');
        expect(Object.keys(legacy.value).sort()).toEqual([
            'items', 'metadata', 'mutationRevision', 'projectId', 'projectRevision', 'readOnly', 'revision', 'total', 'version',
        ]);
        expect(legacy.value.projectRevision).toBe('7:remote-device:2026-09-01T00:00:00.000Z');
        expect(defaultView.value.projectRevision).toBe(legacy.value.projectRevision);
        expect(defaultView.value.projectRevision).not.toBe(defaultView.value.mutationRevision);
        expect(legacy.value.items).toEqual(defaultView.value.items.map((item) => {
            if (item.type !== 'section') return item;
            const { collapsible: _collapsible, collapsed: _collapsed, ...section } = item;
            return section;
        }));
        expect(legacy.value.revision).not.toBe(defaultView.value.revision);
        expect(legacy.value.mutationRevision).toBe(defaultView.value.mutationRevision);
        useTaskStore.setState({ _allProjects: revisedProjects.map((item) => item.id === 'parallel' ? { ...item, title: 'renamed' } : item) });
        expect(host.getProjectDetailView({ projectId: 'parallel', offset: 0, limit: 2,
            revision: first.value.revision, showCompleted: true, completedCollapsed: false }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('keeps the project Area filter on the listed tasks', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        useTaskStore.setState({
            _allTasks: [...tasks, task('p-hidden-ref', 'parallel', 'reference', { areaId: 'hidden' })]
                .map((item) => item.id === 'p-next' ? { ...item, areaId: 'hidden' } : item),
            _allProjects: projects.map((item) => item.id === 'parallel' ? { ...item, areaId: 'shown' } : item),
            _allAreas: [area('shown'), area('hidden')],
            settings: { filters: { areaId: 'hidden', areaIds: ['hidden'], excludedAreaIds: [] } },
        });
        saveData.mockClear();
        const result = host.getProjectDetailView({ projectId: 'parallel', offset: 0, limit: NATIVE_HOST_MAX_WINDOW,
            showCompleted: true, completedCollapsed: false });
        if (!result.ok) throw new Error(result.error.code);
        expect(result.value.items.flatMap((item) => item.type === 'task' && item.row.status !== 'reference' ? [item.row.id] : []))
            .toEqual([]);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('rejects malformed and oversized requests before reading the project', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        useTaskStore.setState({ _allTasks: tasks, _allProjects: projects });
        saveData.mockClear();
        const valid = { projectId: 'parallel', offset: 0, limit: 1, showCompleted: false, completedCollapsed: true };
        for (const input of [
            null, [], {}, { ...valid, projectId: '' }, { ...valid, projectId: 'x'.repeat(501) },
            { ...valid, offset: -1 }, { ...valid, offset: 0.5 }, { ...valid, offset: Number.MAX_SAFE_INTEGER + 1 },
            { ...valid, limit: 0 }, { ...valid, limit: NATIVE_HOST_MAX_WINDOW + 1 },
            { ...valid, showCompleted: 1 }, { ...valid, completedCollapsed: null },
            { ...valid, extra: true }, { ...valid, revision: undefined },
            { ...valid, offset: 1 }, { ...valid, revision: 3 },
            { ...valid, projectId: 'x'.repeat(1_000_000) },
        ]) {
            expect(host.getProjectDetailView(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(host.getProjectDetailView({ ...valid, projectId: 'missing' }))
            .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    // RN's task list shows Parallel or Sequential under each section header of a Per section project (#1429, d25316cf9).
    it('labels each section header with its flow in a Per section project only', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        const section = (id: string, projectId: string, order: number, extra: Partial<Section> = {}): Section =>
            ({ id, projectId, title: id, order, createdAt: stamp, updatedAt: stamp, ...extra });
        useTaskStore.setState({ _allProjects: [project('flow', { perSectionFlow: true }), project('plain')],
            _allSections: [section('steps', 'flow', 0, { isSequential: true }), section('ideas', 'flow', 1), section('plain-s', 'plain', 0)],
            _allTasks: [task('a', 'flow', 'next', { sectionId: 'steps' }), task('b', 'flow', 'next', { sectionId: 'ideas' }),
                task('c', 'plain', 'next', { sectionId: 'plain-s' })] });
        const headers = (projectId: string) => {
            const result = host.getProjectDetailView({ projectId, offset: 0, limit: 50, showCompleted: false, completedCollapsed: false });
            if (!result.ok) throw new Error(result.error.code);
            return result.value.items.filter((item) => item.type === 'section').map((item) => [item.id, (item as { flowLabel?: string }).flowLabel]);
        };
        expect(headers('flow')).toEqual([['steps', 'Sequential'], ['ideas', 'Parallel']]);
        expect(headers('plain')).toEqual([['plain-s', undefined]]);
    });
});
