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
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
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

    // Revisions read the clock.
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

    it('returns what core\'s models return when called directly', async () => {
        freezeClock();
        const { host } = await openHost(scenario('someday', 'sections'));
        const { state, areaById, resolvedAreaFilter, visibleTasks } = visible();

        const waiting = buildWaitingViewModel({ tasks: visibleTasks, projects: state.projects, resolvedAreaFilter, areaById, person: 'alice', t });
        const waitingView = value(host.getWaitingView({ person: 'alice', offset: 0, limit: 100 }));
        expect(waitingView.rows.map((row) => row.id)).toEqual(waiting.tasks.map((task) => task.id));
        expect(waitingView.deferred).toEqual({ ...waiting.deferred, rows: { total: waiting.deferred!.rows.length, items: waiting.deferred!.rows } });

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
        // Rows carry core meta.
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
        // A reference filed in an archived project opens read-only, as on mobile.
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
        // A later page needs the revision; another person's list is another revision.
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
        expect(await host.createSomedaySection({ title: ' ' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.moveSomedayTasksToSection({ taskIds: ['s-a'], sectionId: null, requestId: 'nope' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.activateProject({ projectId: 'p-old' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.setTaskListSort({ sortBy: 'completed' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('writes nothing again for a target already reached', async () => {
        freezeClock();
        const { host, recorder } = await openHost(scenario('someday', 'sections'));
        expect(value(await host.activateProject({ projectId: 'p-launch' }))).toEqual({ id: 'p-launch', changed: false });
        expect(value(await host.renameSomedaySection({ id: 's-later', title: ' Later ' }))).toEqual({ id: 's-later', changed: false });
        expect(value(await host.reorderSomedaySections({ ids: ['s-later', 's-ideas', 's-empty'] }))).toEqual({ changed: false });
        expect(value(await host.createSomedaySection({ title: 'IDEAS' }))).toEqual({ id: 's-ideas', existing: true });
        expect(value(await host.deleteSomedaySection({ id: 'missing' }))).toEqual({ id: 'missing', changed: false });
        expect(value(await host.moveSomedayTasksToSection({ taskIds: ['s-a'], sectionId: 's-later', requestId: generateUUID() })))
            .toEqual({ moved: 0, toast: null, undoRequestId: null });
        expect(recorder.log).toEqual([]);
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
        const noSection = view.items.findIndex((item) => item.type === 'heading' && item.id === 'view-section:someday:none');
        expect(view.items.slice(noSection).some((item) => item.type === 'task' && item.row.id === 's-a')).toBe(true);
    });

    it('retries a failed section move exactly: one write, and Undo still restores the first sections', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario('someday', 'sections'), saveData);
        const input = { taskIds: ['s-a', 's-b'], sectionId: 's-empty', requestId: generateUUID() };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.moveSomedayTasksToSection(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        expect(recorder.log).toHaveLength(1);

        saveData.mockResolvedValue(undefined);
        const retried = value(await host.moveSomedayTasksToSection(input));
        expect(retried).toEqual({ moved: 2, toast: { message: 'Moved to Travel (2)', undoLabel: 'Undo' }, undoRequestId: input.requestId });
        expect(recorder.log).toHaveLength(1);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; viewSectionIds?: { someday?: string } }[] };
        expect(saved.tasks.filter(({ id }) => id === 's-a' || id === 's-b').map((task) => task.viewSectionIds?.someday)).toEqual(['s-empty', 's-empty']);
        // A lost reply repeats the request: no write, no save.
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
        // A store write that saves at once, as the store's reactivation path does: it lands, then reports the failed save.
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
        const input = { taskIds: ['s-a', 's-b'], sectionId: 's-empty', requestId: generateUUID() };
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
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.createSomedaySection({ title: 'Hobbies' })).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        const retried = value(await host.createSomedaySection({ title: 'Hobbies' }));
        expect(retried.existing).toBe(true);
        expect(recorder.log).toHaveLength(1);
        const saved = saveData.mock.lastCall?.[0] as { settings: { gtd: { viewSections: { someday: { id: string; title: string }[] } } } };
        expect(saved.settings.gtd.viewSections.someday.find((section) => section.title === 'Hobbies')?.id).toBe(retried.id);
    });

    it('retries a failed project activation exactly: one write', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario('waiting', 'base'), saveData);
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.activateProject({ projectId: 'p-vendor' })).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        expect(value(await host.activateProject({ projectId: 'p-vendor' }))).toEqual({ id: 'p-vendor', changed: false });
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

    it('computes the revision from the pruned filters, so the returned state continues paging', async () => {
        freezeClock();
        const { host } = await openHost(scenario('someday', 'sections'));
        const first = value(host.getSomedayView({ groupBy: 'none', filters: { tokens: ['#gone'] }, offset: 0, limit: 1 }));
        expect(first.filters.state.tokens).toEqual([]);
        const next = host.getSomedayView({ groupBy: 'none', filters: first.filters.state, offset: 1, limit: 1, revision: first.revision });
        expect(next).toMatchObject({ ok: true, value: { revision: first.revision } });
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
        const move = { taskIds: ['s-a', 's-b'], sectionId: 's-empty', requestId: generateUUID() };
        expect(value(await host.moveSomedayTasksToSection(move))).toMatchObject({ moved: 2, undoRequestId: move.requestId });
        await useTaskStore.getState().updateTask('s-b', { status: 'next' });
        expect(value(await host.undoSomedaySectionMove({ moveRequestId: move.requestId, requestId: generateUUID() }))).toEqual({ reverted: 1 });
        expect(useTaskStore.getState()._tasksById.get('s-a')?.viewSectionIds).toEqual({ someday: 's-later' });
        expect(useTaskStore.getState()._tasksById.get('s-b')?.viewSectionIds).toEqual({ someday: 's-empty' });
        // A move retried after its receipt is gone is target state: it writes nothing again.
        const again = { taskIds: ['s-a'], sectionId: 's-ideas', requestId: generateUUID() };
        expect(value(await host.moveSomedayTasksToSection(again))).toMatchObject({ moved: 1 });
        expect(value(await host.moveSomedayTasksToSection({ ...again, requestId: generateUUID() })))
            .toEqual({ moved: 0, toast: null, undoRequestId: null });
    });

    it('returns SAVE_FAILED, never a rejection, when a retry fails to save again', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host } = await openHost(scenario('waiting', 'base'), saveData);
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.activateProject({ projectId: 'p-vendor' })).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        await expect(host.activateProject({ projectId: 'p-vendor' })).resolves.toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
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
        expect(await host.activateProject({ projectId: 'p' })).toMatchObject(notReady);
        expect(await host.moveSomedayTasksToSection({ taskIds: ['s-a'], sectionId: null, requestId: generateUUID() })).toMatchObject(notReady);
        expect(await host.undoSomedaySectionMove({ moveRequestId: generateUUID(), requestId: generateUUID() })).toMatchObject(notReady);
        expect(host.getMenuViewCollection({ view: 'someday', collection: 'tokens', offset: 0, limit: 10, revision: 'r' })).toMatchObject(notReady);
        expect(await host.addSomedaySectionTask({ title: 'x', sectionId: null, captureId: generateUUID() })).toMatchObject(notReady);
        expect(await host.createSomedaySection({ title: 'x' })).toMatchObject(notReady);
        expect(await host.renameSomedaySection({ id: 's', title: 'x' })).toMatchObject(notReady);
        expect(await host.reorderSomedaySections({ ids: [] })).toMatchObject(notReady);
        expect(await host.deleteSomedaySection({ id: 's' })).toMatchObject(notReady);
        expect(await host.setTaskListSort({ sortBy: 'title' })).toMatchObject(notReady);
    });
});
