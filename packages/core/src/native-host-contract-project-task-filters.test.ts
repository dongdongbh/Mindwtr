import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, type NativeProjectDetailFilterView } from './native-host-contract';
import { buildProjectTaskListModel, getProjectDetailTaskListOptions, PROJECT_COMPLETED_SECTION_ID, selectProjectTaskListTasks } from './project-task-list-model';
import { resolveListFilterState } from './list-filter-state';
import { getTaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import { resolveNonDoneTaskSortBy } from './task-list-sort-options';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { Area, Project, Section, Task } from './types';

const stamp = '2026-09-01T00:00:00.000Z';
const project: Project = { id: 'p', title: 'Project', status: 'active', color: '#123456', order: 0,
    tagIds: [], createdAt: stamp, updatedAt: stamp };
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, projectId: 'p',
    status: 'next', tags: [], contexts: [], createdAt: stamp, updatedAt: stamp, ...extra });
const area = (id: string): Area => ({ id, name: id, order: 0, color: '#123456', icon: 'home', createdAt: stamp, updatedAt: stamp });
const section = (id: string, order: number): Section => ({ id, projectId: 'p', title: id, order, createdAt: stamp, updatedAt: stamp });
const saveData = vi.fn().mockResolvedValue(undefined);
const rows = (view: NativeProjectDetailFilterView) => view.items.flatMap((item) => item.type === 'task' ? [item.row.id] : []);

describe('native Project task filters', () => {
    beforeEach(() => {
        saveData.mockClear();
        setStorageAdapter({ getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }), saveData });
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 });
    });
    afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); });

    it('filters the shared Project model without writing', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        useTaskStore.setState({ _allProjects: [project], _allTasks: [
            task('one', { contexts: ['@work'] }), task('two', { contexts: ['@home'] }),
        ] });
        saveData.mockClear();
        const view = host.getProjectDetailFilterView({ projectId: 'p', offset: 0, limit: 100,
            showCompleted: false, completedCollapsed: false, filters: { tokens: ['@work'] } });
        expect(view).toMatchObject({ ok: true, value: { filters: { state: { tokens: ['@work'] } } } });
        if (!view.ok) throw new Error(view.error.code);
        expect(view.value.items.filter((item) => item.type === 'task').map((item) => item.type === 'task' && item.row.id)).toEqual(['one']);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('keeps RN selection, search, visibility, section, reference, and completed semantics', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const tasks = [
            task('alpha', { title: 'Alpha note', contexts: ['@work/deep'], tags: ['#caf\u00e9'], priority: 'high', sectionId: 's2' }),
            task('beta', { title: 'Beta note', description: 'needle', contexts: ['@work'], tags: ['#cafe\u0301'], energyLevel: 'high', sectionId: 's1' }),
            task('done', { status: 'done', contexts: ['@work'], completedAt: stamp }),
            task('ref', { status: 'reference', contexts: ['@work'], tags: ['#caf\u00e9'] }),
            task('hidden', { contexts: ['@else'], areaId: 'b' }),
            task('deleted', { contexts: ['@work'], deletedAt: stamp }),
        ];
        useTaskStore.setState({ _allTasks: tasks, _allProjects: [{ ...project, areaId: 'a' }], _allAreas: [area('a'), area('b')],
            _allSections: [section('s1', 0), section('s2', 1)],
            settings: { filters: { areaId: 'a', areaIds: ['a'], excludedAreaIds: [] } } });
        saveData.mockClear();
        const before = JSON.stringify([useTaskStore.getState()._allTasks, useTaskStore.getState()._allProjects,
            useTaskStore.getState()._allSections, useTaskStore.getState()._allAreas, useTaskStore.getState().settings]);
        const read = (filters: Parameters<typeof host.getProjectDetailFilterView>[0]['filters'], showCompleted = true, completedCollapsed = false) => {
            const result = host.getProjectDetailFilterView({ projectId: 'p', offset: 0, limit: 100,
                showCompleted, completedCollapsed, filters, filterSheetOpen: true });
            if (!result.ok) throw new Error(result.error.code);
            return result.value;
        };
        const filtered = read({ tokens: ['@work'], excludedTokens: ['#cafe\u0301'] });
        expect(rows(filtered)).toEqual(['alpha', 'done', 'ref']);
        expect(filtered.filters.tokens.items.map((item) => item.value)).toContain('@work');
        expect(filtered.filters.tokens.items.map((item) => item.value)).toContain('@work/deep');
        expect(filtered.filters.tokens.items.map((item) => item.value)).toContain('#caf\u00e9');
        expect(filtered.filters.tokens.items.map((item) => item.value)).toContain('#cafe\u0301');
        expect(filtered.chips.find((chip) => chip.id === 'excluded-token:#cafe\u0301')).toMatchObject({ excluded: true,
            action: { filterEdit: { type: 'removeToken', value: '#cafe\u0301' } } });
        expect(filtered.filters.projects).toBeNull();
        expect(filtered.filters.timeEstimates).toEqual([]);
        expect(filtered.filters.visibility).toMatchObject({ priority: true, energyLevel: true, timeEstimate: false });
        expect(filtered.filterButtonLabel).toBe('Filters · 2');
        const sources = selectProjectTaskListTasks(tasks, {
            projectId: 'p', statusFilter: 'all', includeArchived: true, includeDone: true,
            isVisible: (item) => item.areaId !== 'b',
        });
        const resolved = resolveListFilterState({ searchQuery: '', tokens: ['@work'], excludedTokens: ['#cafe\u0301'],
            projects: [], priorities: [], energyLevels: [], timeEstimates: [], location: '', contextMatchMode: 'all', tagMatchMode: 'all' }, {
            visibility: getTaskMetadataFilterVisibility(sources, { prioritiesEnabled: true, timeEstimatesEnabled: false }),
            t: (key) => key,
        });
        const options = getProjectDetailTaskListOptions(project, true);
        const model = buildProjectTaskListModel({ project, tasks: sources, visibleTasks: useTaskStore.getState().tasks,
            sections: useTaskStore.getState().sections, allSections: useTaskStore.getState()._allSections,
            statusFilter: 'all', criteria: resolved.criteria, searchQuery: resolved.searchQuery,
            sortBy: resolveNonDoneTaskSortBy('default', useTaskStore.getState().settings), projectOrder: options.enableProjectReorder,
            reorderMode: false, groupCompletedTasksLast: options.groupCompletedTasksLast, completedCollapsed: false, t: (key) => key });
        expect(filtered.items.map((item) => item.type === 'section' ? [item.type, item.id, item.count] : [item.type, item.row.id]))
            .toEqual(model.items.map((item) => item.type === 'section' ? [item.type, item.id, item.count] : [item.type, item.task.id]));
        expect(rows(read({ searchQuery: 'needle' }))).toEqual(['beta']);
        expect(rows(read({ searchQuery: 'id:alpha' }))).toEqual(['alpha']);
        expect(rows(read({ tokens: ['#caf\u00e9'] }))).toEqual(['alpha', 'ref']);
        expect(rows(read({ tokens: ['#cafe\u0301'] }))).toEqual(['beta']);
        const collapsed = read({ tokens: ['@work'] }, true, true);
        expect(collapsed.items.find((item) => item.type === 'section' && item.id === PROJECT_COMPLETED_SECTION_ID))
            .toMatchObject({ count: 1, collapsible: true, collapsed: true });
        expect(rows(collapsed)).not.toContain('done');
        expect(rows(read({ tokens: ['@work'] }, false))).not.toContain('done');
        expect(JSON.stringify([useTaskStore.getState()._allTasks, useTaskStore.getState()._allProjects,
            useTaskStore.getState()._allSections, useTaskStore.getState()._allAreas, useTaskStore.getState().settings])).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('cycles tokens, retains absent chips, prunes hidden metadata, and exposes Clear', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allTasks: [task('plain')] });
        saveData.mockClear();
        const base = { projectId: 'p', offset: 0, limit: 100, showCompleted: false, completedCollapsed: false };
        const included = host.getProjectDetailFilterView({ ...base, filters: {}, filterEdit: { type: 'toggleToken', value: '@missing' } });
        if (!included.ok) throw new Error(included.error.code);
        expect(included.value.filters.state.tokens).toEqual(['@missing']);
        expect(included.value.chips).toMatchObject([{ id: 'token:@missing' }]);
        expect(included.value.empty).toMatchObject({ message: 'No tasks match these filters.', actionLabel: 'Clear',
            action: { filterEdit: { type: 'clear' } } });
        const excluded = host.getProjectDetailFilterView({ ...base, filters: included.value.filters.state,
            filterEdit: { type: 'toggleToken', value: '@missing' } });
        if (!excluded.ok) throw new Error(excluded.error.code);
        expect(excluded.value.filters.state.excludedTokens).toEqual(['@missing']);
        const neutral = host.getProjectDetailFilterView({ ...base, filters: excluded.value.filters.state,
            filterEdit: { type: 'toggleToken', value: '@missing' } });
        if (!neutral.ok) throw new Error(neutral.error.code);
        expect(neutral.value.filters.state.excludedTokens).toEqual([]);
        const pruned = host.getProjectDetailFilterView({ ...base, filters: { priorities: ['high'], energyLevels: ['high'],
            location: 'office', timeEstimates: [] } });
        if (!pruned.ok) throw new Error(pruned.error.code);
        expect(pruned.value.filters.state).toMatchObject({ priorities: [], energyLevels: [], location: '' });
        expect(pruned.value.filters.activeCount).toBe(0);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('folds real sections before paging and scopes selection to the shown tasks', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const first = PROJECT_COMPLETED_SECTION_ID;
        useTaskStore.setState({ _allProjects: [project],
            _allSections: [section(first, 0), section('empty', 1), section('last', 2)],
            _allTasks: [
                ...Array.from({ length: 55 }, (_, index) => task(`hidden-${index}`, { sectionId: first })),
                task('visible', { sectionId: 'last' }),
                task('unfiled'),
                task('done', { status: 'done', sectionId: first, completedAt: stamp }),
                task('ref', { status: 'reference', sectionId: first }),
            ] });
        saveData.mockClear();
        const params = { projectId: 'p', showCompleted: true, completedCollapsed: true, filters: {} };
        const expanded = host.getProjectDetailFilterView({ ...params, offset: 0, limit: 4, collapsedSectionIds: [] });
        if (!expanded.ok) throw new Error(expanded.error.code);
        expect(rows(expanded.value)).toHaveLength(3);
        const collapse = { ...params, collapsedSectionIds: [first] };
        const folded = host.getProjectDetailFilterView({ ...collapse, offset: 0, limit: 4 });
        if (!folded.ok) throw new Error(folded.error.code);
        expect(folded.value.items).toMatchObject([
            { id: first, sectionId: first, count: 55, collapsible: true, collapsed: true },
            { id: 'empty', sectionId: 'empty', count: 0, collapsible: true, collapsed: false },
            { id: 'last', sectionId: 'last', count: 1, collapsible: true, collapsed: false },
            { type: 'task', row: { id: 'visible' } },
        ]);
        expect(host.getProjectDetailFilterView({ ...collapse, offset: 4, limit: 4, revision: expanded.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const next = host.getProjectDetailFilterView({ ...collapse, offset: 4, limit: 5, revision: folded.value.revision });
        if (!next.ok) throw new Error(next.error.code);
        expect(rows(next.value)).toEqual(['unfiled', 'ref']);
        expect(next.value.items.find(item => item.type === 'section' && item.collapsible))
            .toMatchObject({ id: `${first}:1`, collapsible: true, collapsed: true });
        expect(next.value.items.every(item => item.type === 'task' || item.sectionId === undefined)).toBe(true);
        const selected = host.getBulkActions({ list: 'project', params: collapse, taskIds: ['hidden-0', 'visible'] });
        expect(selected).toMatchObject({ ok: true, value: { selectedIds: ['visible'] } });
        expect(host.getProjectDetailFilterView({ ...collapse, offset: 0, limit: 4, filters: { searchQuery: 'no matches' } }))
            .toMatchObject({ ok: true, value: { total: 0, empty: { actionLabel: 'Clear' } } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('applies context and tag match modes plus metadata, including feature-off pruning', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allTasks: [
            task('both', { contexts: ['@a', '@b'], tags: ['#x', '#y'], priority: 'high', energyLevel: 'high', location: 'Office' }),
            task('one', { contexts: ['@a'], tags: ['#x'], priority: 'low', energyLevel: 'low', location: 'Home' }),
            task('other', { contexts: ['@c'], tags: ['#z'] }),
        ] });
        saveData.mockClear();
        const read = (filters: Parameters<typeof host.getProjectDetailFilterView>[0]['filters']) => {
            const result = host.getProjectDetailFilterView({ projectId: 'p', offset: 0, limit: 100,
                showCompleted: false, completedCollapsed: false, filters });
            if (!result.ok) throw new Error(result.error.code);
            return result.value;
        };
        const selected = { tokens: ['@a', '@b', '#x', '#y'] };
        expect(rows(read(selected))).toEqual(['both']);
        const any = read({ ...selected, contextMatchMode: 'any', tagMatchMode: 'any' });
        expect(rows(any)).toEqual(['both', 'one']);
        expect(any.filters.matchModes.map((control) => control.kind)).toEqual(['context', 'tag']);
        expect(rows(read({ priorities: ['high'], energyLevels: ['high'], location: 'Office' }))).toEqual(['both']);
        useTaskStore.setState({ settings: { features: { priorities: false } } });
        const featureOff = read({ priorities: ['high'] });
        expect(featureOff.filters.state.priorities).toEqual([]);
        expect(featureOff.filters.visibility.priority).toBe(false);
        expect(rows(featureOff)).toEqual(['both', 'one', 'other']);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('filters archived Project tasks read-only and reports unfiltered emptiness', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [{ ...project, status: 'archived' }], _allTasks: [
            task('old', { status: 'archived', tags: ['#keep'] }),
            task('done', { status: 'done', tags: ['#keep'] }),
        ] });
        saveData.mockClear();
        const base = { projectId: 'p', offset: 0, limit: 100, showCompleted: false, completedCollapsed: false };
        const archived = host.getProjectDetailFilterView({ ...base, filters: { tokens: ['#keep'] } });
        if (!archived.ok) throw new Error(archived.error.code);
        expect(archived.value.readOnly).toBe(true);
        expect(archived.value.controls.canToggleCompleted).toBe(false);
        expect(rows(archived.value)).toEqual(['done', 'old']);
        useTaskStore.setState({ _allTasks: [] });
        const empty = host.getProjectDetailFilterView({ ...base, filters: {} });
        if (!empty.ok) throw new Error(empty.error.code);
        expect(empty.value.empty).toEqual({ message: 'No tasks found', hint: '', actionLabel: null, action: null });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('pages more than 100 token choices under exact view and query revisions', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allTasks: Array.from({ length: 125 }, (_, index) =>
            task(`row-${index}`, { contexts: [`@token-${String(index).padStart(3, '0')}`] })) });
        saveData.mockClear();
        const base = { projectId: 'p', showCompleted: false, completedCollapsed: false,
            filters: {}, picker: 'tokens' as const, query: '', offset: 0, limit: 100 };
        const first = host.getProjectDetailFilterOptions(base);
        if (!first.ok) throw new Error(first.error.code);
        expect(first.value.total).toBe(125);
        expect(first.value.items).toHaveLength(100);
        expect(first.value.revision).toBe(JSON.stringify([first.value.viewRevision, '']));
        const next = host.getProjectDetailFilterOptions({ ...base, offset: 100, revision: first.value.revision });
        if (!next.ok) throw new Error(next.error.code);
        expect(next.value.items).toHaveLength(25);
        expect(new Set([...first.value.items, ...next.value.items].map((item) => item.value)).size).toBe(125);
        const open = host.getProjectDetailFilterView({ projectId: 'p', offset: 0, limit: 1,
            showCompleted: false, completedCollapsed: false, filters: {}, filterSheetOpen: true });
        if (!open.ok) throw new Error(open.error.code);
        expect(first.value.viewRevision).toBe(open.value.revision);
        const queried = host.getProjectDetailFilterOptions({ ...base, query: 'TOKEN-12' });
        if (!queried.ok) throw new Error(queried.error.code);
        expect(queried.value.total).toBe(5);
        expect(queried.value.items.map((item) => item.value)).toEqual([
            '@token-120', '@token-121', '@token-122', '@token-123', '@token-124',
        ]);
        expect(host.getProjectDetailFilterOptions({ ...base, query: 'token-12', offset: 100, revision: first.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getProjectDetailFilterView({ projectId: 'p', offset: 1, limit: 1,
            showCompleted: false, completedCollapsed: false, filters: { tokens: ['@token-000'] },
            filterSheetOpen: true, revision: open.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('rejects malformed, unsupported, oversized, and unrevisioned requests', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project] });
        saveData.mockClear();
        const view = { projectId: 'p', offset: 0, limit: 1, showCompleted: false, completedCollapsed: false, filters: {} };
        for (const input of [null, {}, { ...view, extra: true }, { ...view, filters: null },
            { ...view, filters: { bogus: true } }, { ...view, filters: { projects: ['p'] } },
            { ...view, filters: { timeEstimates: ['15m'] } }, { ...view, filterEdit: { type: 'toggleProject', value: 'p' } },
            { ...view, filterEdit: { type: 'toggleTimeEstimate', value: '15m' } },
            { ...view, filterEdit: { type: 'bad' } }, { ...view, filterSheetOpen: 1 },
            { ...view, offset: 1 }, { ...view, limit: 101 }, { ...view, projectId: 'x'.repeat(501) },
            { ...view, filters: { searchQuery: 'x'.repeat(2001) } }, { ...view, filters: { tokens: ['x'.repeat(501)] } },
            { ...view, filters: { tokens: Array(101).fill('@x') } }, { ...view, filters: { searchQuery: 'x'.repeat(1_000_000) } },
        ]) expect(host.getProjectDetailFilterView(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const picker = { projectId: 'p', showCompleted: false, completedCollapsed: false, filters: {},
            picker: 'tokens', query: '', offset: 0, limit: 1 };
        for (const input of [null, {}, { ...picker, extra: true }, { ...picker, picker: 'projects' },
            { ...picker, query: 'x'.repeat(501) }, { ...picker, offset: 1 }, { ...picker, limit: 101 },
            { ...picker, filters: { projects: ['p'] } }, { ...picker, filters: { timeEstimates: ['15m'] } },
        ]) expect(host.getProjectDetailFilterOptions(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
    });
});
