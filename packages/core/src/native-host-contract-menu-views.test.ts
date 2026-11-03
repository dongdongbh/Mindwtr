import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDateFormatter } from './date';
import { loadTranslations } from './i18n/i18n-loader';
import { resolveAreaFilterSelection, isTaskVisibleInArea } from './area-filter';
import { EMPTY_LIST_FILTER_STATE, resolveListFilterState } from './list-filter-state';
import {
    buildSomedayFilterOptions,
    buildSomedayViewModel,
    buildStatusListFilterOptions,
    buildStatusListModel,
    buildWaitingViewModel,
    selectSomedayTasks,
    selectStatusListTasks,
} from './menu-views-model';
import { createWriteRecorder, loadMenuViewsFixture, seedMenuViewsStore, type MenuViewScenario } from './menu-views-model.replay';
import { createNativeHostContract, sortAreasForDisplay } from './native-host-contract';
import { revisionOf, setNativeReplayTokens } from './native-request-receipts';
import { replayAfterRestart } from './screen-parity.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import type { ViewSectionDefinition } from './types';
import { generateUUID } from './uuid';

const fixture = loadMenuViewsFixture();
const scenario = (screen: MenuViewScenario['screen'], settings: string): MenuViewScenario => ({ name: screen, screen, settings, actions: [] });

describe('native host contract: More sheet and list views', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        const english = await loadTranslations('en');
        t = (key) => english[key] ?? key;
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });


    const freezeClock = () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
    };

    const openHost = async (entry: MenuViewScenario, saveData?: (data: unknown) => Promise<void>, data = fixture) => {
        const recorder = createWriteRecorder();
        await seedMenuViewsStore(data, entry, recorder, { saveData });
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: null })).toMatchObject({ ok: true });
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        recorder.log.length = 0;
        return { host, recorder };
    };
    const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return result.value;
    };
    type Host = ReturnType<typeof createNativeHostContract>;

    const parkedRevision = (host: Host, id: string) => value(host.getWaitingView({ offset: 0, limit: 1 })).deferred!.rows.items
        .find((row) => row.id === id)!.projectRevision;

    const somedayRevisions = (host: Host, ids: string[]) => {
        const rows = value(host.getSomedayView({ offset: 0, limit: 100 })).items.flatMap((item) => (item.type === 'task' ? [item.row] : []));
        return Object.fromEntries(ids.map((id) => [id, rows.find((row) => row.id === id)!.taskRevision]));
    };
    const projectRevision = (id: string) => revisionOf(useTaskStore.getState()._projectsById.get(id)!);
    const visible = () => {
        const state = useTaskStore.getState();
        const areas = sortAreasForDisplay(state.areas);
        const areaById = new Map(areas.map((area) => [area.id, area]));
        const resolvedAreaFilter = resolveAreaFilterSelection(state.settings.filters, areas);
        const projectById = new Map(state.projects.map((project) => [project.id, project]));
        return {
            state, areaById, resolvedAreaFilter,
            visibleTasks: state.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter })),
        };
    };


    it('keeps native Someday unchanged when parked projects have a section (#1319)', async () => {
        const { host } = await openHost(scenario('someday', 'sections'));
        const read = () => value(host.getSomedayView({ groupBy: 'viewSection', offset: 0, limit: 100 }));
        const ids = (view: ReturnType<typeof read>) => view.items.map((item) => (item.type === 'heading' ? item.id : item.row.id));


        const place = <T extends { status: string; viewSectionIds?: unknown }>(rows: T[], status: string, id: string) => rows.map((row) => (
            row.status === status ? { ...row, viewSectionIds: { someday: id } } : row));
        useTaskStore.setState((state) => ({
            _allTasks: place(state._allTasks, 'someday', 's-later'),
            tasks: place(state.tasks, 'someday', 's-later'),
            _allProjects: place(state._allProjects, 'someday', 'deleted-section'),
            projects: place(state.projects, 'someday', 'deleted-section'),
        }));
        const parked = useTaskStore.getState()._allProjects.filter((project) => project.status === 'someday').map((project) => project.id);
        expect(parked.length).toBeGreaterThan(0);
        const view = read();
        expect(view.deferred?.rows.items.map((row) => row.id)).toEqual(parked);
        expect(ids(view)).not.toContain('view-section:someday:');
        expect(ids(view).slice(0, 1)).toEqual(['view-section:someday:s-later']);
    });
    it('draws parked projects inside their section when the host asks, as React Native does (#1319)', async () => {
        const { host } = await openHost(scenario('someday', 'sections'));
        const parked = useTaskStore.getState()._allProjects.filter((project) => project.status === 'someday');
        expect(parked.length).toBeGreaterThan(1);
        const [first, ...rest] = parked;

        useTaskStore.setState((state) => {
            const place = (rows: typeof state._allProjects) => rows.map((row) => (row.status !== 'someday' ? row
                : { ...row, viewSectionIds: { someday: row.id === first.id ? 's-later' : 'deleted-section' } }));
            return { _allProjects: place(state._allProjects), projects: place(state.projects) };
        });
        const read = (projectsInSections?: boolean) => value(host.getSomedayView({ groupBy: 'viewSection', projectsInSections, offset: 0, limit: 100 }));
        const view = read(true);
        expect(view.deferred).toBeNull();
        const shown = view.items.map((item) => (item.type === 'task' ? `task:${item.groupId}` : `${item.type}:${item.id}`));
        const later = shown.indexOf('heading:view-section:someday:s-later');
        expect(shown[later + 1]).toBe(`project:${first.id}`);
        const noSection = shown.indexOf('heading:view-section:someday:');
        expect(noSection).toBeGreaterThan(later);
        expect(shown.slice(noSection + 1, noSection + 1 + rest.length)).toEqual(rest.map((project) => `project:${project.id}`));
        const item = view.items.find((entry) => entry.type === 'project' && entry.id === first.id);
        expect(item).toMatchObject({ groupId: 'view-section:someday:s-later', activateLabel: expect.any(String),
            project: { id: first.id, title: first.title, projectRevision: expect.any(String) } });

        expect(read().deferred?.rows.items.map((row) => row.id)).toEqual(parked.map((project) => project.id));
        expect(read().items.some((entry) => entry.type === 'project')).toBe(false);
        expect(view.revision).not.toBe(read().revision);

        expect(value(host.getSomedayView({ groupBy: 'project', projectsInSections: true, offset: 0, limit: 100 })).deferred).not.toBeNull();
    });

    it('moves a parked Someday project to a section, as React Native does (#1319)', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario('someday', 'sections'), saveData);
        const project = useTaskStore.getState()._allProjects.find((row) => row.status === 'someday')!;
        const section = () => useTaskStore.getState()._projectsById.get(project.id)!.viewSectionIds?.someday;
        expect(section()).toBeUndefined();

        const dialog = value(host.getSomedayMoveDialog({ projectId: project.id }));
        expect(dialog.title).toBe('Move to section…');
        expect(dialog.choices.items[0]).toEqual({ sectionId: null, title: 'No section', selected: true });

        const input = { projectId: project.id, sectionId: 's-later', projectRevision: projectRevision(project.id), requestId: generateUUID() };
        expect(value(await host.moveSomedayProjectToSection(input))).toEqual({ moved: 1 });
        expect(section()).toBe('s-later');
        expect(recorder.log).toHaveLength(1);

        expect(value(await host.moveSomedayProjectToSection(input))).toEqual({ moved: 1 });
        expect(recorder.log).toHaveLength(1);
        expect(value(host.getSomedayMoveDialog({ projectId: project.id })).choices.items.find((choice) => choice.selected)?.sectionId).toBe('s-later');


        expect(await host.moveSomedayProjectToSection({ ...input, sectionId: null, requestId: generateUUID() }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });

        const fresh = () => ({ projectRevision: projectRevision(project.id), requestId: generateUUID() });
        expect(value(await host.moveSomedayProjectToSection({ ...input, ...fresh(), sectionId: 'gone' })))
            .toEqual({ refused: { title: 'Error', message: 'Could not update Someday sections.' } });
        expect(value(await host.moveSomedayProjectToSection({ ...input, ...fresh(), sectionId: null }))).toEqual({ moved: 1 });
        expect(section()).toBeUndefined();

        const writes = recorder.log.length;
        expect(value(await host.moveSomedayProjectToSection({ ...input, ...fresh(), sectionId: null }))).toEqual({ moved: 0 });
        expect(recorder.log).toHaveLength(writes);

        const active = useTaskStore.getState()._allProjects.find((row) => row.status === 'active')!;
        expect(await host.moveSomedayProjectToSection({ projectId: active.id, sectionId: null, projectRevision: projectRevision(active.id), requestId: generateUUID() }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.moveSomedayProjectToSection({ ...input, requestId: 'nope' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getSomedayMoveDialog({ projectId: active.id })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('moves a task to a project or an area from its status menu, as React Native does', async () => {
        freezeClock();
        const { host, recorder } = await openHost(scenario('someday', 'sections'));
        const state = useTaskStore.getState();
        const task = state.tasks.find((row) => !row.deletedAt && !row.projectId && !row.areaId)!;
        const project = state.projects.find((row) => row.status === 'active' && !row.deletedAt)!;
        const area = state.areas.find((row) => !row.deletedAt)!;
        expect([task, project, area].every(Boolean)).toBe(true);
        const picker = value(host.getTaskDestinationPicker({ id: task.id }));
        expect(picker).toMatchObject({ title: 'Destination', searchLabel: 'Search...', cancelLabel: 'Cancel',
            none: { title: 'None', selected: true, destination: { kind: 'none' } } });
        expect(picker.projectGroups[0].title).toBe('Projects');
        expect(picker.projectGroups[0].rows).toContainEqual({ title: project.title, accessibilityLabel: `Projects: ${project.title}`, selected: false,
            destination: { kind: 'project', id: project.id } });
        expect(picker.areas.rows.map((row) => row.destination)).toContainEqual({ kind: 'area', id: area.id });

        const query = project.title.slice(0, 3).toLowerCase();
        const searched = value(host.getTaskDestinationPicker({ id: task.id, query }));
        expect(searched.projectGroups.flatMap((group) => group.rows).every((row) => row.title.toLowerCase().includes(query))).toBe(true);
        expect(searched.areas.rows.every((row) => row.title.toLowerCase().includes(query))).toBe(true);
        expect(value(host.getTaskDestinationPicker({ id: task.id, query: 'zzzz-no-such' })).noMatches).toBe('No matches');

        const input = { id: task.id, taskRevision: revisionOf(task), destination: { kind: 'project' as const, id: project.id }, requestId: generateUUID() };
        expect(value(await host.moveTaskToDestination(input))).toEqual({ id: task.id, changed: true });
        expect(useTaskStore.getState()._tasksById.get(task.id)!.projectId).toBe(project.id);
        expect(recorder.log).toHaveLength(1);

        expect(value(await host.moveTaskToDestination(input))).toEqual({ id: task.id, changed: true });
        expect(recorder.log).toHaveLength(1);
        expect(value(host.getTaskDestinationPicker({ id: task.id })).projectGroups[0].rows.find((row) => row.selected)?.destination).toEqual(input.destination);

        expect(await host.moveTaskToDestination({ ...input, destination: { kind: 'area', id: area.id }, requestId: generateUUID() }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const fresh = () => ({ taskRevision: revisionOf(useTaskStore.getState()._tasksById.get(task.id)!), requestId: generateUUID() });

        expect(value(await host.moveTaskToDestination({ ...input, ...fresh(), destination: { kind: 'area', id: area.id } }))).toEqual({ id: task.id, changed: true });
        expect(useTaskStore.getState()._tasksById.get(task.id)).toMatchObject({ projectId: undefined, areaId: area.id });
        expect(value(await host.moveTaskToDestination({ ...input, ...fresh(), destination: { kind: 'none' } }))).toEqual({ id: task.id, changed: true });
        expect(useTaskStore.getState()._tasksById.get(task.id)).toMatchObject({ projectId: undefined, areaId: undefined });
        const writes = recorder.log.length;
        expect(value(await host.moveTaskToDestination({ ...input, ...fresh(), destination: { kind: 'none' } }))).toEqual({ id: task.id, changed: false });
        expect(recorder.log).toHaveLength(writes);

        const archived = useTaskStore.getState()._allProjects.find((row) => row.status === 'archived');
        if (archived) expect(await host.moveTaskToDestination({ ...input, ...fresh(), destination: { kind: 'project', id: archived.id } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.moveTaskToDestination({ ...input, ...fresh(), destination: { kind: 'area', id: 'no-such-area' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.moveTaskToDestination({ ...input, ...fresh(), destination: { kind: 'section', id: 'x' } as never }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.moveTaskToDestination({ ...input, requestId: 'nope' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getTaskDestinationPicker({ id: 'no-such-task' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        const lonely = (await useTaskStore.getState().addArea('Zebra garden'))!;
        const areaOnly = value(host.getTaskDestinationPicker({ id: task.id, query: 'zebra' }));
        expect(areaOnly.projectGroups.flatMap((group) => group.rows)).toEqual([]);
        expect(areaOnly.areas.rows.map((row) => row.destination)).toEqual([{ kind: 'area', id: lonely.id }]);
        expect(areaOnly.noMatches).toBeNull();
    });
    it('returns what core\'s models return when called directly', async () => {
        freezeClock();
        const { host } = await openHost(scenario('someday', 'sections'));
        const { state, areaById, resolvedAreaFilter, visibleTasks } = visible();

        const waiting = buildWaitingViewModel({ tasks: visibleTasks, projects: state.projects, resolvedAreaFilter, areaById, person: 'alice', t });
        const waitingView = value(host.getWaitingView({ person: 'alice', offset: 0, limit: 100 }));
        expect(waitingView.rows.map((row) => row.id)).toEqual(waiting.tasks.map((task) => task.id));

        const parked = waiting.deferred!.rows.map((row) => ({ ...row, projectRevision: projectRevision(row.id) }));
        expect(waitingView.deferred).toEqual({ ...waiting.deferred, rows: { total: parked.length, items: parked } });

        const tasks = selectSomedayTasks(visibleTasks);
        const options = buildSomedayFilterOptions({ tasks, projects: state.projects, settings: state.settings, t });
        const filters = { ...EMPTY_LIST_FILTER_STATE, tokens: ['#music'] };
        const resolved = resolveListFilterState(filters, { ...options, t });
        const someday = buildSomedayViewModel({
            tasks, projects: state.projects, areaById, resolvedAreaFilter, settings: state.settings,
            sortBy: 'title', groupBy: 'project', showDetails: true, criteria: resolved.criteria, searchQuery: resolved.searchQuery, filterChips: resolved.chips, t,
        });
        const somedayView = value(host.getSomedayView({ sortBy: 'title', groupBy: 'project', showDetails: true, filters, offset: 0, limit: 100 }));
        expect(somedayView.items.map((item) => (item.type === 'heading' ? item.id : item.row.id)))
            .toEqual(someday.groups!.flatMap((group) => [group.id, ...group.tasks.map((task) => task.id)]));
        expect(somedayView.filters.state).toEqual(resolved.state);

        const row = somedayView.items.find((item) => item.type === 'task');
        expect(row?.type === 'task' && row.row.meta).toBeTruthy();

        const referenceTasks = selectStatusListTasks({
            kind: 'reference', tasks: state.tasks, projects: state.projects, allProjects: state._allProjects,
            resolvedAreaFilter, areaById, includeArchivedProjects: true,
        });
        const referenceOptions = buildStatusListFilterOptions({ kind: 'reference', tasks: referenceTasks, allProjects: state._allProjects, settings: state.settings, t });
        const reference = buildStatusListModel({
            kind: 'reference', tasks: referenceTasks, projects: state.projects, areas: state.areas, settings: state.settings,
            groupBy: 'project', criteria: {}, searchQuery: '', collapsedGroupIds: new Set(), t,
        });
        const referenceView = value(host.getReferenceView({ groupBy: 'project', includeArchivedProjects: true, offset: 0, limit: 100 }));
        expect(referenceView.items.map((item) => (item.type === 'section' ? item.id : item.row.id)))
            .toEqual(reference.items.map((item) => (item.type === 'section' ? item.id : item.task.id)));
        expect(referenceView.filters.tokens.items.map((token) => token.value)).toEqual(referenceOptions.tokens);

        const archived = referenceView.items.find((item) => item.type === 'task' && item.row.id === 'r-c');
        expect(archived?.type === 'task' && archived.row.readOnly).toBe(true);
    });

    it('accepts each list header token chip edit for Someday, Reference, and Done', async () => {
        freezeClock();
        const { host } = await openHost(scenario('someday', 'sections'));
        const cases = [
            { token: '#music', get: (filters: typeof EMPTY_LIST_FILTER_STATE, filterEdit?: { type: 'removeToken'; value: string }) => host.getSomedayView({ filters, filterEdit, offset: 0, limit: 100 }) },
            { token: '#home', get: (filters: typeof EMPTY_LIST_FILTER_STATE, filterEdit?: { type: 'removeToken'; value: string }) => host.getReferenceView({ filters, filterEdit, offset: 0, limit: 100 }) },
            { token: '#home', get: (filters: typeof EMPTY_LIST_FILTER_STATE, filterEdit?: { type: 'removeToken'; value: string }) => host.getDoneView({ filters, filterEdit, offset: 0, limit: 100 }) },
        ];
        for (const { token, get } of cases) {
            const filters = { ...EMPTY_LIST_FILTER_STATE, tokens: [token] };
            const before = value(get(filters));
            const edit = before.chips.find((chip) => chip.id === `token:${token}`)?.action.filterEdit;
            expect(edit).toEqual({ type: 'removeToken', value: token });
            expect(value(get(before.filters.state, edit as { type: 'removeToken'; value: string })).filters.state.tokens).toEqual([]);
        }
    });

    it('pages within one revision and refuses a stale page after an edit', async () => {
        freezeClock();
        const { host } = await openHost(scenario('waiting', 'base'));
        const first = value(host.getWaitingView({ offset: 0, limit: 2 }));
        expect(first.total).toBe(5);
        const second = value(host.getWaitingView({ offset: 2, limit: 2, revision: first.revision }));
        expect([...first.rows, ...second.rows].map((row) => row.id)).toEqual(['w-alice2', 'w-alice', 'w-desc', 'w-plain']);

        expect(host.getWaitingView({ offset: 2, limit: 2 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(value(host.getWaitingView({ person: 'bob', offset: 0, limit: 2 })).revision).not.toBe(first.revision);

        await useTaskStore.getState().updateTask('w-plain', { title: 'Landlord reply' });
        expect(host.getWaitingView({ offset: 2, limit: 2, revision: first.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const refreshed = value(host.getWaitingView({ offset: 0, limit: 2 }));
        expect(refreshed.revision).not.toBe(first.revision);

        const someday = value(host.getSomedayView({ offset: 0, limit: 1 }));
        await useTaskStore.getState().updateSettings({ gtd: { ...useTaskStore.getState().settings.gtd, viewSections: { someday: [{ id: 'x', title: 'X', order: 0 }] } } });
        expect(host.getSomedayView({ offset: 1, limit: 1, revision: someday.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('refuses invalid input', async () => {
        freezeClock();
        const { host } = await openHost(scenario('someday', 'sections'));

        setNativeReplayTokens('required');
        expect(host.getWaitingView({ offset: 0, limit: 101 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getSomedayView({ groupBy: 'tag' as never, offset: 0, limit: 10 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getSomedayView({ filters: { tokens: 'x' } as never, offset: 0, limit: 10 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getSomedayView({ filters: { color: 'red' } as never, offset: 0, limit: 10 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getSomedayView({ filterEdit: { type: 'togglePriority', value: 'huge' } as never, offset: 0, limit: 10 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getReferenceView({ sortBy: 'title' } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getDoneView({ groupBy: 'completedDate', sortBy: 'completed', includeArchivedProjects: true, offset: 0, limit: 10 } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.reorderSomedaySections({ ids: ['s-later', 's-ideas'] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.renameSomedaySection({ id: 's-later', title: '  ' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.createSomedaySection({ title: ' ', requestId: generateUUID() })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.createSomedaySection({ title: 'Hobbies' } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const revisions = somedayRevisions(host, ['s-a']);
        expect(await host.moveSomedayTasksToSection({ taskIds: ['s-a'], sectionId: null, requestId: 'nope', taskRevisions: revisions })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        expect(await host.moveSomedayTasksToSection({ taskIds: ['s-a'], sectionId: null, requestId: generateUUID() } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.moveSomedayTasksToSection({ taskIds: ['s-a', 's-b'], sectionId: null, requestId: generateUUID(), taskRevisions: revisions }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.activateProject({ projectId: 'p-old', projectRevision: projectRevision('p-old') })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.activateProject({ projectId: 'p-vendor' } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.setTaskListSort({ sortBy: 'completed' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('keeps large and long saved folds readable in Reference and Done', async () => {
        freezeClock();
        const prefix = '🌱'.repeat(260);
        const longA = `tag:${prefix}á`;
        const longB = `tag:${prefix}á`;
        const data = { ...fixture, tasks: fixture.tasks.map((task) => (
            task.id === 'r-a' || task.id === 'd-a' ? { ...task, tags: [longA.slice(4)] }
                : task.id === 'r-b' || task.id === 'd-b' ? { ...task, tags: [longB.slice(4)] } : task
        )) };
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario('done', 'keepDone'), saveData, data);
        saveData.mockClear();
        const saved = [...Array.from({ length: 1001 }, (_, index) => `saved:${index}`), longA, longB];
        for (const get of [host.getReferenceView, host.getDoneView]) {
            const base = value(get({ groupBy: 'project', offset: 0, limit: 100 }));
            const section = base.items.find((item) => item.type === 'section' && base.items.some((row) => row.type === 'task' && row.groupId === item.id));
            expect(section).toBeDefined();
            const collapsedGroupIds = [...saved, section!.id];
            const input = { groupBy: 'project' as const, collapsedGroupIds, offset: 0, limit: 1 };
            const first = value(get(input));
            expect(first.collapsedGroupIds).toEqual(collapsedGroupIds);
            expect(first.items[0]).toMatchObject({ type: 'section', id: section!.id, collapsed: true });
            const next = value(get({ ...input, offset: 1, revision: first.revision }));
            expect(next.items).toHaveLength(Math.min(1, first.total - 1));
            expect(get({ ...input, collapsedGroupIds: [...saved, 7] as never })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(get({ ...input, limit: 101 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const longView = value(get({ ...input, groupBy: 'tag', collapsedGroupIds: saved.slice(0, -1), limit: 100 }));
            expect(longView.items.find((item) => item.type === 'section' && item.id === longA)).toMatchObject({ collapsed: true });
            expect(longView.items.find((item) => item.type === 'section' && item.id === longB)).toMatchObject({ collapsed: false });
        }
        expect(recorder.log).toEqual([]);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('writes nothing again for a target already reached', async () => {
        freezeClock();
        const { host, recorder } = await openHost(scenario('someday', 'sections'));
        expect(value(await host.activateProject({ projectId: 'p-launch', projectRevision: projectRevision('p-launch') }))).toEqual({ id: 'p-launch', changed: false });
        expect(value(await host.renameSomedaySection({ id: 's-later', title: ' Later ' }))).toEqual({ id: 's-later', changed: false });
        expect(value(await host.reorderSomedaySections({ ids: ['s-later', 's-ideas', 's-empty'] }))).toEqual({ changed: false });
        expect(value(await host.createSomedaySection({ title: 'IDEAS', requestId: generateUUID() }))).toEqual({ id: 's-ideas', existing: true });
        expect(value(await host.deleteSomedaySection({ id: 'missing' }))).toEqual({ id: 'missing', changed: false });
        expect(value(await host.moveSomedayTasksToSection({ taskIds: ['s-a'], sectionId: 's-later', requestId: generateUUID(), taskRevisions: somedayRevisions(host, ['s-a']) })))
            .toEqual({ moved: 0, toast: null, undoRequestId: null });
        expect(recorder.log).toEqual([]);
    });

    it('changes only the edited section: entries it cannot show stay as stored, in stored order', async () => {
        freezeClock();
        const { host } = await openHost(scenario('someday', 'sections'));
        const stored = () => useTaskStore.getState().settings.gtd?.viewSections?.someday as unknown[];
        const [later, ideas, travel] = stored() as { id: string; title: string; order: number }[];
        const future = { id: 's-future', title: '', order: 7, color: 'teal' };
        const folder = { kind: 'folder', children: ['s-ideas'] };
        await useTaskStore.getState().updateSettings({
            gtd: { ...useTaskStore.getState().settings.gtd, viewSections: { someday: [later, future, ideas, folder, travel] as never } },
        });

        const created = value(await host.createSomedaySection({ title: 'Books', requestId: generateUUID() }));
        value(await host.renameSomedaySection({ id: 's-ideas', title: 'Big ideas' }));
        const moveDown = value(host.getSomedaySections()).rows[0].moveDown.ids!;
        expect(moveDown).toEqual(['s-ideas', 's-later', 's-empty', created.id]);
        value(await host.reorderSomedaySections({ ids: moveDown }));
        value(await host.deleteSomedaySection({ id: 's-empty' }));

        expect(stored()).toEqual([
            { ...later, order: 1 }, future, { ...ideas, title: 'Big ideas', order: 0 }, folder, { id: created.id, title: 'Books', order: 3 },
        ]);
    });

    it('deletes a section only from settings: its tasks keep their assignment and show under No section', async () => {
        freezeClock();
        const { host, recorder } = await openHost(scenario('someday', 'sections'));
        const row = value(host.getSomedaySections()).rows.find((entry) => entry.id === 's-later')!;
        expect(row.deleteConfirm).toEqual({ title: 'Delete', message: 'Delete "Later"?', cancelLabel: 'Cancel', confirmLabel: 'Delete' });
        expect(value(await host.deleteSomedaySection({ id: 's-later' }))).toEqual({ id: 's-later', changed: true });
        expect(recorder.log.map((entry) => (entry as unknown[])[0])).toEqual(['updateSettings']);
        expect(useTaskStore.getState()._tasksById.get('s-a')?.viewSectionIds).toEqual({ someday: 's-later' });
        const view = value(host.getSomedayView({ offset: 0, limit: 100 }));
        const noSection = view.items.findIndex((item) => item.type === 'heading' && item.id === 'view-section:someday:');
        expect(view.items.slice(noSection).some((item) => item.type === 'task' && item.row.id === 's-a')).toBe(true);
    });

    it('keeps imported none and No section headings distinct, including Add task assignments', async () => {
        const base = fixture.settings.sections;
        const data = {
            ...fixture,
            tasks: [...fixture.tasks, { ...fixture.tasks.find((task) => task.id === 's-a')!, id: 's-none', viewSectionIds: { someday: 'none' } }],
            settings: {
                ...fixture.settings,
                sections: {
                    ...base,
                    gtd: { ...base.gtd, viewSections: { someday: [...(base.gtd?.viewSections?.someday ?? []), { id: 'none', title: 'Imported', order: 3 }] } },
                },
            },
        };
        const { host, recorder } = await openHost(scenario('someday', 'sections'), undefined, data);
        const view = value(host.getSomedayView({ offset: 0, limit: 100 }));
        const imported = view.items.find((item) => item.type === 'heading' && item.id === 'view-section:someday:none');
        const noSection = view.items.find((item) => item.type === 'heading' && item.id === 'view-section:someday:');
        expect(imported).toMatchObject({ title: 'Imported', addTask: { sectionId: 'none' } });
        expect(noSection).toMatchObject({ addTask: { sectionId: null } });
        expect(view.items.find((item) => item.type === 'task' && item.row.id === 's-none')).toMatchObject({ groupId: 'view-section:someday:none' });
        expect(view.items.find((item) => item.type === 'task' && item.row.id === 's-c')).toMatchObject({ groupId: 'view-section:someday:' });
        expect(recorder.log).toEqual([]);
    });

    it('retries a failed section move exactly: one write, and Undo still restores the first sections', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario('someday', 'sections'), saveData);
        const input = { taskIds: ['s-a', 's-b'], sectionId: 's-empty', requestId: generateUUID(), taskRevisions: somedayRevisions(host, ['s-a', 's-b']) };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.moveSomedayTasksToSection(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        expect(recorder.log).toHaveLength(1);

        saveData.mockResolvedValue(undefined);
        const retried = value(await host.moveSomedayTasksToSection(input));
        expect(retried).toEqual({ moved: 2, toast: { message: 'Moved to Travel (2)', undoLabel: 'Undo' }, undoRequestId: input.requestId });
        expect(recorder.log).toHaveLength(1);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; viewSectionIds?: { someday?: string } }[] };
        expect(saved.tasks.filter(({ id }) => id === 's-a' || id === 's-b').map((task) => task.viewSectionIds?.someday)).toEqual(['s-empty', 's-empty']);

        const saves = saveData.mock.calls.length;
        expect(value(await host.moveSomedayTasksToSection(input))).toEqual(retried);
        expect(saveData).toHaveBeenCalledTimes(saves);
        expect(await host.moveSomedayTasksToSection({ ...input, sectionId: null })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        expect(value(await host.undoSomedaySectionMove({ moveRequestId: input.requestId, requestId: generateUUID() })))
            .toEqual({ reverted: 2 });
        expect(['s-a', 's-b'].map((id) => useTaskStore.getState()._tasksById.get(id)?.viewSectionIds?.someday)).toEqual(['s-later', 's-ideas']);
    });

    it('retries a section move whose store save failed after it landed: one write', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario('someday', 'sections'), saveData);

        const inner = useTaskStore.getState().batchUpdateTasks;
        useTaskStore.setState({
            batchUpdateTasks: async (updates) => {
                const result = await inner(updates);
                try {
                    await flushPendingSave();
                } catch (error) {
                    return { success: false, error: error instanceof Error ? error.message : String(error) };
                }
                return result;
            },
        });
        const input = { taskIds: ['s-a', 's-b'], sectionId: 's-empty', requestId: generateUUID(), taskRevisions: somedayRevisions(host, ['s-a', 's-b']) };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.moveSomedayTasksToSection(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(recorder.log).toHaveLength(1);
        saveData.mockResolvedValue(undefined);
        expect(value(await host.moveSomedayTasksToSection(input)))
            .toEqual({ moved: 2, toast: { message: 'Moved to Travel (2)', undoLabel: 'Undo' }, undoRequestId: input.requestId });
        expect(recorder.log).toHaveLength(1);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; viewSectionIds?: { someday?: string } }[] };
        expect(saved.tasks.filter(({ id }) => id === 's-a' || id === 's-b').map((task) => task.viewSectionIds?.someday)).toEqual(['s-empty', 's-empty']);
    });

    it('retries a failed Add task exactly: one task', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario('someday', 'sections'), saveData);
        const input = { title: '  Book flights ', sectionId: 's-empty', captureId: generateUUID() };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.addSomedaySectionTask(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        expect(value(await host.addSomedaySectionTask(input))).toEqual({ id: input.captureId, toast: 'Task created' });
        expect(recorder.normalize(recorder.log)).toEqual([['addTask', 'Book flights', { status: 'someday', viewSectionIds: { someday: 's-empty' } }]]);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; title: string }[] };
        expect(saved.tasks.filter((task) => task.title === 'Book flights')).toHaveLength(1);
    });

    it('retries a failed new section exactly: one settings write, the same section', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario('someday', 'sections'), saveData);
        const input = { title: 'Hobbies', requestId: generateUUID() };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.createSomedaySection(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);

        const retried = value(await host.createSomedaySection(input));
        expect(retried).toEqual({ id: input.requestId.toLowerCase(), existing: false });
        expect(recorder.log).toHaveLength(1);
        const saved = saveData.mock.lastCall?.[0] as { settings: { gtd: { viewSections: { someday: { id: string; title: string }[] } } } };
        expect(saved.settings.gtd.viewSections.someday.find((section) => section.title === 'Hobbies')?.id).toBe(retried.id);
    });

    it('retries a failed project activation exactly: one write', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario('waiting', 'base'), saveData);
        saveData.mockRejectedValue(new Error('disk unavailable'));
        const input = { projectId: 'p-vendor', projectRevision: parkedRevision(host, 'p-vendor') };
        expect(await host.activateProject(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        expect(value(await host.activateProject(input))).toEqual({ id: 'p-vendor', changed: false });
        expect(recorder.log).toEqual([['updateProject', 'p-vendor', { status: 'active' }]]);
        const saved = saveData.mock.lastCall?.[0] as { projects: { id: string; status: string }[] };
        expect(saved.projects.find((project) => project.id === 'p-vendor')?.status).toBe('active');
    });

    it('windows every collection a view carries and pages the rest under the view revision', async () => {
        freezeClock();
        const many = Array.from({ length: 150 }, (_, index) => {
            const n = String(index).padStart(3, '0');
            return [
                { ...fixture.tasks.find((task) => task.id === 's-d')!, id: `s-many-${n}`, title: `Idea ${n}`, tags: [`#t${n}`] },
                { ...fixture.tasks.find((task) => task.id === 'w-bob')!, id: `w-many-${n}`, title: `Wait ${n}`, assignedTo: `Person ${n}` },
            ];
        }).flat();
        const crowded = { ...fixture, tasks: [...fixture.tasks, ...many] };
        const { host } = await openHost(scenario('someday', 'sections'), undefined, crowded);

        const someday = value(host.getSomedayView({ groupBy: 'none', offset: 0, limit: 1 }));
        expect(someday.items).toHaveLength(1);
        expect(someday.filters.tokens.items).toHaveLength(100);
        expect(someday.filters.tokens.total).toBeGreaterThan(150);
        const params = { groupBy: 'none', filters: someday.filters.state };
        const rest = value(host.getMenuViewCollection({
            view: 'someday', collection: 'tokens', params, offset: 100, limit: 100, revision: someday.revision,
        }));
        expect(rest.total).toBe(someday.filters.tokens.total);
        expect([...someday.filters.tokens.items, ...rest.items as { value: string }[]].map((token) => token.value))
            .toEqual(buildSomedayFilterOptions({
                tasks: selectSomedayTasks(visible().visibleTasks), projects: useTaskStore.getState().projects, settings: useTaskStore.getState().settings, t,
            }).tokens);
        expect(host.getMenuViewCollection({ view: 'someday', collection: 'people', params, offset: 0, limit: 10, revision: someday.revision }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        const waiting = value(host.getWaitingView({ offset: 0, limit: 1 }));
        expect(waiting.people.items).toHaveLength(100);
        expect(waiting.people.total).toBeGreaterThan(150);
        const people = value(host.getMenuViewCollection({ view: 'waiting', collection: 'people', offset: 100, limit: 100, revision: waiting.revision }));
        expect(people.items.length).toBe(waiting.people.total - 100);

        await useTaskStore.getState().updateTask('s-many-000', { tags: ['#changed'] });
        expect(host.getMenuViewCollection({ view: 'someday', collection: 'tokens', params, offset: 100, limit: 100, revision: someday.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('retains empty explicit filters with a stable paging revision until cleared', async () => {
        freezeClock();
        const { host } = await openHost(scenario('someday', 'sections'));
        const first = value(host.getSomedayView({ groupBy: 'none', filters: { tokens: ['#gone'] }, offset: 0, limit: 1 }));
        expect(first.filters.state.tokens).toEqual(['#gone']);
        expect(first.total).toBe(0);
        const next = host.getSomedayView({ groupBy: 'none', filters: first.filters.state, offset: 1, limit: 1, revision: first.revision });
        expect(next).toMatchObject({ ok: true, value: { revision: first.revision } });
        const cleared = value(host.getSomedayView({
            groupBy: 'none', filters: first.filters.state,
            filterEdit: { type: 'removeToken', value: '#gone' }, offset: 0, limit: 1,
        }));
        expect(cleared.filters.state.tokens).toEqual([]);
        expect(cleared.total).toBeGreaterThan(0);
    });

    it('refuses a reused captureId for another task', async () => {
        freezeClock();
        const { host } = await openHost(scenario('someday', 'sections'));
        const captureId = generateUUID();
        expect(value(await host.addSomedaySectionTask({ title: 'Book flights', sectionId: 's-empty', captureId }))).toEqual({ id: captureId, toast: 'Task created' });
        expect(await host.addSomedaySectionTask({ title: 'Book hotel', sectionId: 's-empty', captureId })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.addSomedaySectionTask({ title: 'Book flights', sectionId: null, captureId })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(value(await host.addSomedaySectionTask({ title: ' Book flights ', sectionId: 's-empty', captureId }))).toEqual({ id: captureId, toast: 'Task created' });
    });

    it('undoes only a recorded move, and leaves a task filed elsewhere since', async () => {
        freezeClock();
        const { host } = await openHost(scenario('someday', 'sections'));
        expect(await host.undoSomedaySectionMove({ moveRequestId: generateUUID(), requestId: generateUUID() }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const move = { taskIds: ['s-a', 's-b'], sectionId: 's-empty', requestId: generateUUID(), taskRevisions: somedayRevisions(host, ['s-a', 's-b']) };
        expect(value(await host.moveSomedayTasksToSection(move))).toMatchObject({ moved: 2, undoRequestId: move.requestId });
        await useTaskStore.getState().updateTask('s-b', { status: 'next' });
        expect(value(await host.undoSomedaySectionMove({ moveRequestId: move.requestId, requestId: generateUUID() }))).toEqual({ reverted: 1 });
        expect(useTaskStore.getState()._tasksById.get('s-a')?.viewSectionIds).toEqual({ someday: 's-later' });
        expect(useTaskStore.getState()._tasksById.get('s-b')?.viewSectionIds).toEqual({ someday: 's-empty' });

        const again = { taskIds: ['s-a'], sectionId: 's-ideas', requestId: generateUUID(), taskRevisions: somedayRevisions(host, ['s-a']) };
        expect(value(await host.moveSomedayTasksToSection(again))).toMatchObject({ moved: 1 });
        expect(value(await host.moveSomedayTasksToSection({ ...again, requestId: generateUUID() })))
            .toEqual({ moved: 0, toast: null, undoRequestId: null });
    });

    it('returns SAVE_FAILED, never a rejection, when a retry fails to save again', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host } = await openHost(scenario('waiting', 'base'), saveData);
        const input = { projectId: 'p-vendor', projectRevision: parkedRevision(host, 'p-vendor') };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.activateProject(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        await expect(host.activateProject(input)).resolves.toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
    }, 30_000);

    it('titles older completion months with the user\'s date formatting', async () => {
        freezeClock();
        const keepDone = { ...fixture, settings: { ...fixture.settings, keepDone: { gtd: { autoArchiveDays: 0 } } } };
        const { host } = await openHost(scenario('done', 'keepDone'), undefined, keepDone);
        expect(await host.setLanguage({ storedLanguage: 'fr', systemLocale: null })).toMatchObject({ ok: true });
        const view = value(host.getDoneView({ groupBy: 'completedDate', offset: 0, limit: 100 }));
        const month = view.items.find((item) => item.type === 'section' && item.id === 'completedDate:2026-08');
        const title = createDateFormatter({ language: 'fr', systemLocale: null })(new Date(2026, 7, 1), 'LLLL yyyy');
        expect(month).toMatchObject({ type: 'section', title });
        expect(title).not.toBe('August 2026');
    });

    it('offers each match mode control with its edit, and searches the filter picker\'s tokens and projects', async () => {
        freezeClock();
        const { host } = await openHost(scenario('reference', 'base'));
        const filters = { ...EMPTY_LIST_FILTER_STATE, tokens: ['@home', '@desk', '#home', '#work'] };
        const view = value(host.getReferenceView({ filters, offset: 0, limit: 100 }));
        expect(view.filters.matchModes.map((control) => [control.kind, control.label, control.options.map((option) => [option.label, option.selected])])).toEqual([
            ['context', 'Context match', [['Any', false], ['All', true]]],
            ['tag', 'Tag match', [['Any', false], ['All', true]]],
        ]);
        const anyTag = view.filters.matchModes[1].options[0].edit;
        expect(anyTag).toEqual({ type: 'setMatchMode', kind: 'tag', value: 'any' });
        const next = value(host.getReferenceView({ filters: view.filters.state, filterEdit: anyTag, offset: 0, limit: 100 }));
        expect(next.filters.state.tagMatchMode).toBe('any');
        expect(next.filters.matchModes[1].options.map((option) => option.selected)).toEqual([true, false]);
        expect(value(host.getReferenceView({ offset: 0, limit: 100 })).filters.matchModes).toEqual([]);

        const plain = value(host.getReferenceView({ offset: 0, limit: 100 }));
        const params = { filters: plain.filters.state };
        const search = (collection: 'tokens' | 'projects' | 'sections', query: unknown) => host.getMenuViewCollection({
            view: 'reference', collection, params, query: query as string, offset: 0, limit: 100, revision: plain.revision,
        });
        const tokens = plain.filters.tokens.items;
        expect(value(search('tokens', ' HOME ')).items).toEqual(tokens.filter((token) => token.value.toLowerCase().includes('home')));
        expect(value(search('tokens', ' HOME ')).total).toBeGreaterThan(0);
        const projects = plain.filters.projects!.items;
        expect(value(search('projects', 'laun')).items).toEqual(projects.filter((project) => project.title === 'Launch'));
        expect(value(search('tokens', 'zzz'))).toMatchObject({ total: 0, items: [] });
        expect(search('tokens', 5)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(search('sections', 'x')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('is NOT_READY until storage is activated', async () => {
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        const notReady = { ok: false, error: { code: 'NOT_READY' } };
        const page = { offset: 0, limit: 10 };
        expect(host.getMoreMenu()).toMatchObject(notReady);
        expect(host.getWaitingView(page)).toMatchObject(notReady);
        expect(host.getSomedayView(page)).toMatchObject(notReady);
        expect(host.getReferenceView(page)).toMatchObject(notReady);
        expect(host.getDoneView(page)).toMatchObject(notReady);
        expect(host.getSomedaySections()).toMatchObject(notReady);
        expect(host.getSomedayMoveDialog({ taskIds: ['s-a'] })).toMatchObject(notReady);
        expect(await host.activateProject({ projectId: 'p', projectRevision: 'r' })).toMatchObject(notReady);
        expect(await host.moveSomedayTasksToSection({ taskIds: ['s-a'], sectionId: null, requestId: generateUUID(), taskRevisions: { 's-a': 'r' } })).toMatchObject(notReady);
        expect(await host.undoSomedaySectionMove({ moveRequestId: generateUUID(), requestId: generateUUID() })).toMatchObject(notReady);
        expect(host.getMenuViewCollection({ view: 'someday', collection: 'tokens', offset: 0, limit: 10, revision: 'r' })).toMatchObject(notReady);
        expect(await host.addSomedaySectionTask({ title: 'x', sectionId: null, captureId: generateUUID() })).toMatchObject(notReady);
        expect(await host.createSomedaySection({ title: 'x', requestId: generateUUID() })).toMatchObject(notReady);
        expect(await host.renameSomedaySection({ id: 's', title: 'x' })).toMatchObject(notReady);
        expect(await host.reorderSomedaySections({ ids: [] })).toMatchObject(notReady);
        expect(await host.deleteSomedaySection({ id: 's' })).toMatchObject(notReady);
        expect(await host.setTaskListSort({ sortBy: 'title' })).toMatchObject(notReady);
    });

    describe('a replay after a restart (a new host, no receipts) never undoes a later change', () => {
        const stale = { ok: false, error: { code: 'STALE_REVISION' } };
        const sections = () => useTaskStore.getState().settings.gtd?.viewSections?.someday ?? [];

        const writeSections = (next: ViewSectionDefinition[]) => useTaskStore.getState().updateSettings({
            gtd: { ...useTaskStore.getState().settings.gtd, viewSections: { someday: next } },
        });

        it('activateProject: STALE once the project changed since', async () => {
            freezeClock();
            const { host } = await openHost(scenario('waiting', 'base'));
            const input = { projectId: 'p-vendor', projectRevision: parkedRevision(host, 'p-vendor') };
            expect(value(await host.activateProject(input))).toEqual({ id: 'p-vendor', changed: true });

            await useTaskStore.getState().updateProject('p-vendor', { status: 'waiting' });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.activateProject(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(useTaskStore.getState()._projectsById.get('p-vendor')?.status).toBe('waiting');
        });

        it('moveSomedayTasksToSection: STALE once a task it moves changed since', async () => {
            freezeClock();
            const { host } = await openHost(scenario('someday', 'sections'));
            const input = { taskIds: ['s-a', 's-b'], sectionId: 's-empty', requestId: generateUUID(), taskRevisions: somedayRevisions(host, ['s-a', 's-b']) };
            expect(value(await host.moveSomedayTasksToSection(input))).toMatchObject({ moved: 2 });

            await useTaskStore.getState().updateTask('s-a', { viewSectionIds: { someday: 's-ideas' } });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.moveSomedayTasksToSection(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(useTaskStore.getState()._tasksById.get('s-a')?.viewSectionIds).toEqual({ someday: 's-ideas' });
        });

        it('undoSomedaySectionMove: its Undo lives in memory, so a replay is STALE', async () => {
            freezeClock();
            const { host } = await openHost(scenario('someday', 'sections'));
            const move = { taskIds: ['s-a'], sectionId: 's-empty', requestId: generateUUID(), taskRevisions: somedayRevisions(host, ['s-a']) };
            value(await host.moveSomedayTasksToSection(move));
            const undo = { moveRequestId: move.requestId, requestId: generateUUID() };
            expect(value(await host.undoSomedaySectionMove(undo))).toEqual({ reverted: 1 });
            await useTaskStore.getState().updateTask('s-a', { viewSectionIds: { someday: 's-empty' } });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.undoSomedaySectionMove(undo));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(useTaskStore.getState()._tasksById.get('s-a')?.viewSectionIds).toEqual({ someday: 's-empty' });
        });

        it('createSomedaySection: the section named by the request UUID answers, renamed since, and nothing is added', async () => {
            freezeClock();
            const { host } = await openHost(scenario('someday', 'sections'));
            const input = { title: 'Hobbies', requestId: generateUUID() };
            const created = value(await host.createSomedaySection(input));
            expect(created).toEqual({ id: input.requestId.toLowerCase(), existing: false });
            await writeSections(sections().map((section) => (section.id === created.id ? { ...section, title: 'Crafts' } : section)));
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.createSomedaySection(input));
            expect(result).toEqual({ ok: true, value: created });
            expect(wrote).toBe(false);
            expect(sections().map((section) => section.title)).toEqual(['Later', 'Ideas', 'Travel', 'Crafts']);
        });

        it('addSomedaySectionTask: the task named by the capture UUID answers, edited since, and nothing is added', async () => {
            freezeClock();
            const { host } = await openHost(scenario('someday', 'sections'));
            const input = { title: 'Book flights', sectionId: 's-empty', captureId: generateUUID() };
            value(await host.addSomedaySectionTask(input));
            await useTaskStore.getState().updateTask(input.captureId, { status: 'next' });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.addSomedaySectionTask(input));
            expect(result).toEqual({ ok: true, value: { id: input.captureId, toast: 'Task created' } });
            expect(wrote).toBe(false);
            expect(useTaskStore.getState()._tasksById.get(input.captureId)?.status).toBe('next');
        });

        it('renameSomedaySection, reorderSomedaySections, deleteSomedaySection: target state keeps another writer\'s later edit', async () => {
            freezeClock();
            const { host } = await openHost(scenario('someday', 'sections'));
            const rename = { id: 's-later', title: 'Soon' };
            const remove = { id: 's-empty' };
            const reorder = { ids: ['s-ideas', 's-later'] };
            value(await host.renameSomedaySection(rename));
            value(await host.deleteSomedaySection(remove));
            value(await host.reorderSomedaySections(reorder));

            await writeSections(sections().map((section) => (section.id === 's-ideas' ? { ...section, title: 'Big ideas' } : section)));
            const expected = structuredClone(sections());
            for (const replay of [
                (restarted: Host) => restarted.renameSomedaySection(rename),
                (restarted: Host) => restarted.reorderSomedaySections(reorder),
                (restarted: Host) => restarted.deleteSomedaySection(remove),
            ]) {
                const { result, wrote } = await replayAfterRestart(replay);
                expect(result).toMatchObject({ ok: true, value: { changed: false } });
                expect(wrote).toBe(false);
            }
            expect(sections()).toEqual(expected);
        });

        it('setTaskListSort: target state keeps another writer\'s later settings edit', async () => {
            freezeClock();
            const { host } = await openHost(scenario('reference', 'base'));
            value(await host.setTaskListSort({ sortBy: 'title' }));

            await useTaskStore.getState().updateSettings({ gtd: { ...useTaskStore.getState().settings.gtd, autoArchiveDays: 3 } });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.setTaskListSort({ sortBy: 'title' }));
            expect(result).toEqual({ ok: true, value: { sortBy: 'title', changed: false } });
            expect(wrote).toBe(false);
            expect(useTaskStore.getState().settings).toMatchObject({ taskSortBy: 'title', gtd: { autoArchiveDays: 3 } });
        });
    });
});
