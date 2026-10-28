import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveAreaFilterSelection } from './area-filter';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract, sortAreasForDisplay } from './native-host-contract';
import {
    buildSavedSearchScreenText,
    deleteSavedSearchById,
    findSavedSearch,
    getSavedSearchGlobalSortLabel,
    removeSavedSearch,
    selectSavedSearchTasks,
    setSavedSearchSortById,
    type SavedSearchScreenText,
} from './saved-search-view-model';
import { loadScreenFixture, normalize, openScreenHost, replayAfterRestart, requestId, value, type ScreenHost } from './screen-parity.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { getTaskSortByLabel, getVisibleTaskSortOptions, resolveNonDoneTaskSortBy, TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import { getTaskListHeaderText } from './menu-views-model';
import type { AppSettings, Area, Project, Task, TaskStatus } from './types';

type Action = [string, ...unknown[]];
type Fixture = {
    timeZone: string;
    now: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings: Record<string, AppSettings>;
    scenarios: { name: string; settings: string; id: string; canGoBack?: boolean; actions: Action[] }[];
    observations: Record<string, unknown[]>;
};
const fixture = loadScreenFixture<Fixture>('saved-search');
const RECORD = { updateTask: null, deleteTask: null, updateSettings: null };

/** The screen as a host draws it: its text, its rows' IDs, and what Delete asks. */
type Screen = { text: SavedSearchScreenText; rowIds: string[] };
type Driver = { screen: (id: string) => Screen; deleteSavedSearch: (id: string) => Promise<void> };

/** Replays one scenario as the mobile screen runs it, and records the mobile harness's observation. */
async function replay(scenario: Fixture['scenarios'][number], driver: Driver, log: unknown[][]) {
    const navigation: unknown[][] = [];
    const alerts: unknown[] = [];
    let editor: [boolean, string | null, string] = [false, null, 'view'];
    const seen = { writes: 0, alerts: 0, navigation: 0 };
    const goBackOrInbox = () => navigation.push(scenario.canGoBack ? ['back'] : ['replace', '/inbox']);
    const snapshot = () => {
        const { text, rowIds } = driver.screen(scenario.id);
        const observation = {
            header: [text.title, ...(text.query ? [text.query] : [])],
            deleteButton: text.deleteAction ? [[text.deleteAction.label, 1]] : [],
            rows: rowIds,
            rowProps: rowIds.length > 0 ? { sameActions: true, handlers: ['function', 'function', 'function'] } : null,
            empty: rowIds.length > 0 ? null : {
                texts: [text.empty.message, ...(text.empty.actions ? [text.empty.actions.inboxLabel, text.empty.actions.backLabel] : [])],
                actions: text.empty.actions ? [text.empty.actions.inboxLabel, text.empty.actions.backLabel] : [],
            },
            editor,
            alerts: alerts.slice(seen.alerts),
            navigation: navigation.slice(seen.navigation),
            writes: log.slice(seen.writes),
        };
        seen.writes = log.length;
        seen.alerts = alerts.length;
        seen.navigation = navigation.length;
        return normalize(observation);
    };
    const observations = [snapshot()];
    for (const action of scenario.actions) {
        const [kind] = action;
        const { text } = driver.screen(scenario.id);
        const store = useTaskStore.getState();
        if (kind === 'delete') {
            const { confirm } = text.deleteAction!;
            alerts.push([confirm.title, confirm.message, [[confirm.cancelLabel, 'cancel'], [confirm.confirmLabel, 'destructive']]]);
        } else if (kind === 'alert') {
            if (action[1] === text.deleteAction?.confirm.confirmLabel) {
                await driver.deleteSavedSearch(scenario.id);
                goBackOrInbox();
            }
        } else if (kind === 'emptyAction') {
            if (action[1] === text.empty.actions!.inboxLabel) navigation.push(['replace', '/inbox']);
            else goBackOrInbox();
        } else if (kind === 'row') {
            // A row's swipes and taps are the task lists' own: the same store calls.
            const id = action[1] as string;
            if (action[2] === 'edit') editor = [true, id, 'view'];
            else if (action[2] === 'remove') await store.deleteTask(id);
            else await store.updateTask(id, { status: action[3] as TaskStatus });
        } else if (kind === 'editorSave') {
            await store.updateTask(action[1] as string, action[2] as Partial<Task>);
            editor = [false, null, 'view'];
        } else if (kind === 'editorClose') {
            editor = [false, editor[1], 'view'];
        } else {
            throw new Error(`Unknown action ${kind}`);
        }
        await flushPendingSave();
        observations.push(snapshot());
    }
    return observations;
}

describe('saved search screen: core and the native host contract', () => {
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
    const open = async (settings = 'base', saveData?: (data: unknown) => Promise<void>) => {
        const log: unknown[][] = [];
        const host = await openScreenHost({
            data: { tasks: fixture.tasks, projects: fixture.projects, areas: fixture.areas, settings: fixture.settings[settings] },
            record: RECORD,
            log,
            saveData,
        });
        return { host, log };
    };
    /** The screen from core called directly, with the store read as mobile reads it. */
    const direct = (id: string): Screen => {
        const state = useTaskStore.getState();
        const areas = sortAreasForDisplay(state.areas);
        const savedSearch = findSavedSearch(state.settings.savedSearches, id);
        return {
            text: buildSavedSearchScreenText({ savedSearch, savedSearches: state.settings.savedSearches, t }),
            rowIds: selectSavedSearchTasks({
                query: savedSearch?.query || '',
                tasks: state.tasks,
                projects: state.projects,
                areaFilter: resolveAreaFilterSelection(state.settings.filters, areas),
                areaById: new Map(areas.map((area) => [area.id, area])),
                sortBy: resolveNonDoneTaskSortBy(state.settings.taskSortBy, state.settings),
            }).map((task) => task.id),
        };
    };
    const fromContract = (host: ScreenHost) => (id: string): Screen => {
        const view = value(host.getSavedSearchView({ id }));
        return {
            text: { title: view.title, query: view.query ?? '', deleteAction: view.delete, empty: view.empty ?? { message: '', actions: null } },
            rowIds: view.rows.map((row) => row.id),
        };
    };

    it('has a fixture captured from React Native', () => {
        expect((fixture as unknown as { provenance: { capturedAt: string } }).provenance.capturedAt).toMatch(/^[0-9a-f]{40}$/);
        expect(fixture.scenarios.map((scenario) => scenario.name)).toEqual(Object.keys(fixture.observations));
    });

    describe.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))('replays the frozen React Native scenario: %s', (_name, scenario) => {
        it('through core called directly', async () => {
            freezeClock();
            const { log } = await open(scenario.settings);
            const observations = await replay(scenario, {
                screen: direct,
                deleteSavedSearch: async (id) => {
                    await useTaskStore.getState().updateSettings({ savedSearches: removeSavedSearch(useTaskStore.getState().settings.savedSearches, id) });
                },
            }, log);
            expect(observations).toEqual(fixture.observations[scenario.name]);
        });

        it('through the native host contract', async () => {
            freezeClock();
            const { host, log } = await open(scenario.settings);
            const observations = await replay(scenario, {
                screen: fromContract(host),
                deleteSavedSearch: async (id) => {
                    expect(value(await host.deleteSavedSearch({ requestId: requestId(), id }))).toEqual({ changed: true });
                },
            }, log);
            expect(observations).toEqual(fixture.observations[scenario.name]);
        });
    });

    it('serves core\'s screen with list rows, windowed under a revision', async () => {
        freezeClock();
        const extra = Array.from({ length: 103 }, (_, index) => ({
            ...fixture.tasks[0], id: `t-extra-${index}`, title: `Errand ${index}`, areaId: undefined,
        }));
        const log: unknown[][] = [];
        const host = await openScreenHost({
            data: { tasks: [...fixture.tasks, ...extra], projects: fixture.projects, areas: fixture.areas, settings: fixture.settings.base },
            record: RECORD,
            log,
        });
        const expected = direct('ss-errands');
        const first = value(host.getSavedSearchView({ id: 'ss-errands' }));
        expect(first).toMatchObject({
            version: 1, id: 'ss-errands', found: true, title: 'Errands', query: '@errand',
            delete: expected.text.deleteAction, total: expected.rowIds.length, empty: null,
        });
        expect(first.rows).toHaveLength(100);
        // Rows carry the list rows' meta.
        expect(first.rows[0]).toMatchObject({ id: expected.rowIds[0], meta: expect.any(Object) });
        const second = value(host.getSavedSearchView({ id: 'ss-errands', offset: 100, limit: 100, revision: first.revision }));
        expect([...first.rows, ...second.rows].map((row) => row.id)).toEqual(expected.rowIds);
        // A store edit moves the revision: a later window is stale.
        await useTaskStore.getState().updateTask('t-milk', { title: 'Buy oat milk' });
        expect(host.getSavedSearchView({ id: 'ss-errands', offset: 100, limit: 100, revision: first.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        // Another saved search is another screen.
        const other = value(host.getSavedSearchView({ id: 'ss-milk' }));
        expect(host.getSavedSearchView({ id: 'ss-errands', offset: 100, limit: 100, revision: other.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getSavedSearchView({ id: 'ss-errands', offset: 100, limit: 100 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(value(host.getSavedSearchView({ id: 'ss-gone' }))).toMatchObject({
            found: false, title: 'Saved Searches', query: null, delete: null, total: 0, rows: [],
            empty: { message: 'No results found', actions: { inboxLabel: 'Inbox', backLabel: 'Back' } },
        });
    });

    // #1453 (352686e64): RN's saved search screen has a Sort button; its modal starts with "Use global setting (...)", and a
    // choice is setSavedSearchSortById (null clears the search's own sort).
    it("draws RN's Sort control and keeps the saved search's own sort, as RN does (#1453)", async () => {
        freezeClock();
        const core = await open();
        await setSavedSearchSortById('ss-errands', 'title');
        await setSavedSearchSortById('ss-errands', null);
        const expected = [...core.log];

        const { host, log } = await open();
        const sortOf = () => value(host.getSavedSearchView({ id: 'ss-errands' })).sort!;
        const settings = () => useTaskStore.getState().settings;
        const labels = getVisibleTaskSortOptions(TASK_LIST_SORT_OPTIONS, settings());
        expect(sortOf()).toEqual({
            title: t('sort.label'),
            accessibilityLabel: getTaskListHeaderText({
                sortByLabel: getTaskSortByLabel(resolveNonDoneTaskSortBy(settings().taskSortBy, settings()), t), hasActiveFilters: false, filterActiveCount: 0, t,
            }).sortAccessibilityLabel,
            options: [
                { label: getSavedSearchGlobalSortLabel(settings(), t), selected: true, edit: { sortBy: null } },
                ...labels.map((sortBy) => ({ label: getTaskSortByLabel(sortBy, t), selected: false, edit: { sortBy } })),
            ],
        });
        const titled = requestId();
        expect(value(await host.setSavedSearchSort({ requestId: titled, id: 'ss-errands', sortBy: 'title' }))).toEqual({ changed: true });
        expect(sortOf().options.filter((option) => option.selected)).toEqual([{ label: getTaskSortByLabel('title', t), selected: true, edit: { sortBy: 'title' } }]);
        const state = useTaskStore.getState();
        const areas = sortAreasForDisplay(state.areas);
        expect(value(host.getSavedSearchView({ id: 'ss-errands' })).rows.map((row) => row.id)).toEqual(selectSavedSearchTasks({
            query: '@errand', tasks: state.tasks, projects: state.projects,
            areaFilter: resolveAreaFilterSelection(state.settings.filters, areas), areaById: new Map(areas.map((area) => [area.id, area])), sortBy: 'title',
        }).map((task) => task.id));
        // A replay of the same request answers from its receipt and writes nothing.
        const written = log.length;
        expect(value(await host.setSavedSearchSort({ requestId: titled, id: 'ss-errands', sortBy: 'title' }))).toEqual({ changed: true });
        expect(log).toHaveLength(written);
        expect(value(await host.setSavedSearchSort({ requestId: requestId(), id: 'ss-errands', sortBy: null }))).toEqual({ changed: true });
        expect(value(await host.setSavedSearchSort({ requestId: requestId(), id: 'ss-errands', sortBy: null }))).toEqual({ changed: false });
        expect(log).toEqual(expected);
        expect(value(await host.setSavedSearchSort({ requestId: requestId(), id: 'ss-gone', sortBy: 'title' }))).toEqual({ changed: false });
        for (const input of [{ requestId: requestId(), id: 'ss-errands', sortBy: 'nope' }, { requestId: requestId(), id: 'ss-errands' },
            { requestId: 'not-a-uuid', id: 'ss-errands', sortBy: 'title' }]) {
            expect(await host.setSavedSearchSort(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(value(host.getSavedSearchView({ id: 'ss-gone' })).sort).toBeNull();
    });

    it('deletes as mobile does, and a replay after it landed writes nothing', async () => {
        freezeClock();
        const core = await open();
        await useTaskStore.getState().updateSettings({ savedSearches: removeSavedSearch(useTaskStore.getState().settings.savedSearches, 'ss-milk') });
        const expected = [...core.log];

        const contract = await open();
        expect(value(await contract.host.deleteSavedSearch({ requestId: requestId(), id: 'ss-milk' }))).toEqual({ changed: true });
        expect(contract.log).toEqual(expected);
        contract.log.length = 0;
        expect(value(await contract.host.deleteSavedSearch({ requestId: requestId(), id: 'ss-milk' }))).toEqual({ changed: false });
        expect(contract.log).toEqual([]);
    });

    it('deletes by ID against the saved searches as they are when the write runs, keeping the others as stored', async () => {
        freezeClock();
        const { host, log } = await open();
        value(host.getSavedSearchView({ id: 'ss-milk' }));
        // Another writer adds a saved search (with a field this build does not know) after the screen was read.
        const later = { id: 'ss-later', name: 'Later', query: 'later', futureField: 1 } as never;
        await useTaskStore.getState().updateSettings({ savedSearches: [...useTaskStore.getState().settings.savedSearches!, later] });
        const before = useTaskStore.getState().settings.savedSearches!;
        log.length = 0;
        expect(value(await host.deleteSavedSearch({ requestId: requestId(), id: 'ss-milk' }))).toEqual({ changed: true });
        const after = useTaskStore.getState().settings.savedSearches!;
        expect(after.map((search) => search.id)).toEqual(['ss-errands', 'ss-next-work', 'ss-none', 'ss-blank', 'ss-later']);
        // Every other saved search is the stored object itself.
        for (const search of after) expect(search).toBe(before.find((entry) => entry.id === search.id));
        expect(log).toHaveLength(1);

        // The ID-targeted operation core owns: nothing to delete writes nothing.
        log.length = 0;
        expect(await deleteSavedSearchById('ss-gone')).toBe(false);
        expect(log).toEqual([]);
        expect(await deleteSavedSearchById('ss-later')).toBe(true);
        expect(useTaskStore.getState().settings.savedSearches!.map((search) => search.id)).toEqual(['ss-errands', 'ss-next-work', 'ss-none', 'ss-blank']);
    });

    it('a replay after a restart finds the saved search gone, writes nothing, and keeps a later edit of the others', async () => {
        freezeClock();
        const { host, log } = await open();
        const input = { requestId: requestId(), id: 'ss-none' };
        expect(value(await host.deleteSavedSearch(input))).toEqual({ changed: true });
        // Another writer renames another saved search.
        await useTaskStore.getState().updateSettings({
            savedSearches: useTaskStore.getState().settings.savedSearches!.map((search) => (search.id === 'ss-milk' ? { ...search, name: 'Dairy' } : search)),
        });
        const before = useTaskStore.getState().settings.savedSearches;
        log.length = 0;
        const { result, wrote } = await replayAfterRestart((restarted) => restarted.deleteSavedSearch(input));
        expect(result).toEqual({ ok: true, value: { changed: false } });
        expect(wrote).toBe(false);
        expect(log).toEqual([]);
        expect(useTaskStore.getState().settings.savedSearches).toBe(before);
        expect(findSavedSearch(before, 'ss-milk')?.name).toBe('Dairy');
        expect(findSavedSearch(before, 'ss-none')).toBeUndefined();
    });

    it('retries a delete exactly after a failed save', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, log } = await open('base', saveData);
        const input = { requestId: requestId(), id: 'ss-none' };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.deleteSavedSearch(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        expect(log).toHaveLength(1);
        const landed = useTaskStore.getState().settings.savedSearches;
        expect(landed?.map((search) => search.id)).not.toContain('ss-none');
        saveData.mockResolvedValue(undefined);
        const retried = await host.deleteSavedSearch(input);
        expect(retried).toEqual({ ok: true, value: { changed: true } });
        // The retry only saved: no second write, and storage holds the deletion.
        expect(log).toHaveLength(1);
        expect(useTaskStore.getState().settings.savedSearches).toBe(landed);
        expect((saveData.mock.lastCall?.[0] as { settings: AppSettings }).settings.savedSearches).toEqual(landed);
        // A lost reply repeats the request: no write, no save.
        const saves = saveData.mock.calls.length;
        expect(await host.deleteSavedSearch(input)).toEqual(retried);
        expect(saveData).toHaveBeenCalledTimes(saves);
        expect(await host.deleteSavedSearch({ ...input, id: 'ss-milk' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }, 20_000);

    it('refuses invalid input without writing', async () => {
        freezeClock();
        const { host, log } = await open();
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(host.getSavedSearchView({} as never)).toMatchObject(invalid);
        expect(host.getSavedSearchView({ id: 7 } as never)).toMatchObject(invalid);
        expect(host.getSavedSearchView({ id: 'ss-errands', limit: 101 })).toMatchObject(invalid);
        expect(host.getSavedSearchView('ss-errands' as never)).toMatchObject(invalid);
        expect(await host.deleteSavedSearch({ requestId: requestId(), id: '' })).toMatchObject(invalid);
        expect(await host.deleteSavedSearch({ requestId: 'not-a-uuid', id: 'ss-milk' })).toMatchObject(invalid);
        expect(await host.deleteSavedSearch({ requestId: requestId() } as never)).toMatchObject(invalid);
        expect(log).toEqual([]);
    });

    it('is NOT_READY before native storage is activated', async () => {
        await flushPendingSave();
        resetForTests();
        setStorageAdapter({ getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], settings: fixture.settings.base }), saveData: async () => undefined });
        const host = createNativeHostContract();
        expect(host.getSavedSearchView({ id: 'ss-errands' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.deleteSavedSearch({ requestId: requestId(), id: 'ss-errands' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    });
});
