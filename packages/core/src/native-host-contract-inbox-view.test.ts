import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveAreaFilterSelection } from './area-filter';
import { loadTranslations } from './i18n/i18n-loader';
import { loadInboxViewFixture, replayInboxScenario, seedInboxStore, type InboxViewScenario } from './inbox-view-model.replay';
import { EMPTY_LIST_FILTER_STATE, resolveListFilterState } from './list-filter-state';
import {
    buildInboxScreenModel,
    buildStatusListFilterOptions,
    buildStatusListFilterSummary,
    buildStatusListModel,
    selectStatusListTasks,
} from './menu-views-model';
import { createNativeHostContract, sortAreasForDisplay } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';

const fixture = loadInboxViewFixture();
const scenario = (settings: string, extra: Partial<InboxViewScenario> = {}): InboxViewScenario => ({ name: settings, settings, actions: [], ...extra });

describe('native host contract: the Inbox view', () => {
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
    const openHost = async (entry: InboxViewScenario, saveData?: (data: unknown) => Promise<void>) => {
        const writes: unknown[] = [];
        await seedInboxStore(fixture, entry, writes, { saveData });
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: null })).toMatchObject({ ok: true });
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        writes.length = 0;
        return { host, writes };
    };
    const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return result.value;
    };

    it('replays every frozen React Native Inbox scenario through the contract', async () => {
        freezeClock();
        for (const entry of fixture.scenarios) {
            const { host, writes } = await openHost(entry);
            const observations = await replayInboxScenario({ scenario: entry, writes, t, contract: host });
            expect({ [entry.name]: observations }).toEqual({ [entry.name]: fixture.observations[entry.name] });
            await flushPendingSave();
        }
    });

    it('returns what core\'s models return when called directly, with the Inbox list\'s rows', async () => {
        freezeClock();
        const { host } = await openHost(scenario('features'));
        const filters = { ...EMPTY_LIST_FILTER_STATE, tokens: ['@phone'] };
        const view = value(host.getInboxView({ groupBy: 'context', filters, collapsedGroupIds: ['context:@home'], offset: 0, limit: 100 }));

        const state = useTaskStore.getState();
        const areas = sortAreasForDisplay(state.areas);
        const tasks = selectStatusListTasks({
            kind: 'inbox', tasks: state.tasks, projects: state.projects, allProjects: state._allProjects,
            resolvedAreaFilter: resolveAreaFilterSelection(state.settings.filters, areas), areaById: new Map(areas.map((area) => [area.id, area])),
        });
        const options = buildStatusListFilterOptions({ kind: 'inbox', tasks, allProjects: state._allProjects, settings: state.settings, t });
        const resolved = resolveListFilterState(filters, { visibility: options.visibility, t });
        const model = buildStatusListModel({
            kind: 'inbox', tasks, projects: state.projects, areas: state.areas, settings: state.settings,
            groupBy: 'context', criteria: resolved.criteria, searchQuery: resolved.searchQuery, collapsedGroupIds: new Set(['context:@home']), t,
        });
        const summary = buildStatusListFilterSummary({
            kind: 'inbox', chips: resolved.chips, activeCount: resolved.activeCount, hasActive: resolved.hasActive,
            includeArchivedProjects: false, settings: state.settings, t,
        });
        const screen = buildInboxScreenModel({ count: tasks.length, settings: state.settings, t });

        expect(view.items.map((item) => (item.type === 'section' ? item.id : item.row.id)))
            .toEqual(model.items.map((item) => (item.type === 'section' ? item.id : item.task.id)));
        expect(view.count).toBe(model.orderedTasks.length);
        expect(view.toolbar.sort.options.map(({ value: option, label, selected }) => ({ value: option, label, selected }))).toEqual(model.sortOptions);
        expect(view.toolbar.group.options.map(({ value: option, label, selected }) => ({ value: option, label, selected }))).toEqual(model.groupOptions);
        expect(view.filters.state).toEqual(resolved.state);
        expect(view.filters.tokens.items.map((token) => token.value)).toEqual(options.tokens);
        expect(view.chips.map(({ id, label, excluded, action }) => ({ id, label, excluded, edit: action.filterEdit }))).toEqual(summary.chips);
        expect({ message: view.empty.message, hint: view.empty.hint, actionLabel: view.empty.actionLabel }).toEqual(summary.empty);
        expect(view.process).toEqual(screen.process);
        expect(view.scopeLabel).toBe(screen.scopeLabel);
        // A folded heading's edit unfolds it; an open one's folds it too.
        const folded = view.items.find((item) => item.type === 'section' && item.id === 'context:@home');
        expect(folded?.type === 'section' && folded.collapseEdit).toEqual({ collapsedGroupIds: [] });
        const open = view.items.find((item) => item.type === 'section' && item.id === 'context:@phone');
        expect(open?.type === 'section' && open.collapseEdit).toEqual({ collapsedGroupIds: ['context:@home', 'context:@phone'] });

        // Rows carry core meta exactly as the existing Inbox window builds them (no checklist progress).
        const plain = value(host.getInboxView({ offset: 0, limit: 100 }));
        const window = value(host.getInboxWindow({ offset: 0, limit: 100 }));
        expect(plain.items.map((item) => (item.type === 'task' ? { ...item.row, readOnly: undefined } : null)))
            .toEqual(window.rows.map((row) => ({ ...row, readOnly: undefined })));
        const gutter = window.rows.find((row) => row.id === 'i-gutter');
        expect(gutter?.meta).toBeTruthy();
    });

    it('pages items and tokens within one revision, and refuses a stale page after a relevant edit', async () => {
        freezeClock();
        const { host } = await openHost(scenario('base', { extra: 100, omit: [] }));
        const first = value(host.getInboxView({ offset: 0, limit: 100 }));
        expect(first.total).toBe(108);
        expect(first.items).toHaveLength(100);
        const second = value(host.getInboxView({ offset: 100, limit: 100, revision: first.revision }));
        expect(second.items.map((item) => (item.type === 'task' ? item.row.id : item.id))).toHaveLength(8);
        expect(host.getInboxView({ offset: 0, limit: 101 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getInboxView({ offset: 100, limit: 10 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        const tokens = value(host.getInboxFilterTokens({ offset: 0, limit: 2, revision: first.revision }));
        expect(tokens.items.map((token) => token.value)).toEqual(first.filters.tokens.items.slice(0, 2).map((token) => token.value));
        expect(tokens.total).toBe(first.filters.tokens.total);
        // The picker's search box narrows the tokens, ignoring case.
        const needle = first.filters.tokens.items[0].value.slice(1, 3).toUpperCase();
        const found = value(host.getInboxFilterTokens({ offset: 0, limit: 100, revision: first.revision, query: ` ${needle} ` }));
        expect(found.items.map((token) => token.value)).toEqual(first.filters.tokens.items
            .map((token) => token.value)
            .filter((token) => token.toLowerCase().includes(needle.toLowerCase())));
        expect(found.total).toBe(found.items.length);
        expect(host.getInboxFilterTokens({ offset: 0, limit: 2, revision: first.revision, query: 7 as never }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        // Another grouping is another view: its revision differs.
        expect(host.getInboxFilterTokens({ params: { groupBy: 'tag' }, offset: 0, limit: 2, revision: first.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });

        // A new capture is a relevant edit.
        await useTaskStore.getState().addTask('Fresh capture', { status: 'inbox' });
        expect(host.getInboxView({ offset: 100, limit: 100, revision: first.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const after = value(host.getInboxView({ offset: 0, limit: 100 }));
        expect(after.revision).not.toBe(first.revision);
        expect(after.process?.count).toBe(109);

        // So is the sort.
        value(await host.setTaskListSort({ sortBy: 'title' }));
        expect(value(host.getInboxView({ offset: 0, limit: 100 })).revision).not.toBe(after.revision);
    });

    it('reads back a sort set through setTaskListSort, the command its sort options name', async () => {
        freezeClock();
        const { host } = await openHost(scenario('base'));
        const edit = value(host.getInboxView({ offset: 0, limit: 10 })).toolbar.sort.options.find((option) => option.value === 'title')!.edit;
        expect(await host.setTaskListSort(edit)).toEqual({ ok: true, value: { sortBy: 'title', changed: true } });
        const view = value(host.getInboxView({ offset: 0, limit: 10 }));
        expect(view.sortBy).toBe('title');
        expect(view.toolbar.sort.options.find((option) => option.selected)?.value).toBe('title');
        expect(view.toolbar.sort.accessibilityLabel).toBe('Sort: Title');
    });

    it('retries a failed Inbox sort through setTaskListSort with one settings write', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, writes } = await openHost(scenario('base'), saveData);
        const edit = value(host.getInboxView({ offset: 0, limit: 10 })).toolbar.sort.options.find((option) => option.value === 'due')!.edit;
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.setTaskListSort(edit)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        saveData.mockResolvedValue(undefined);
        // Target state: the retry finds the sort stored, only saves, and writes nothing again.
        expect(await host.setTaskListSort(edit)).toEqual({ ok: true, value: { sortBy: 'due', changed: false } });
        expect(writes).toEqual([['updateSettings', { taskSortBy: 'due' }]]);
        const saved = saveData.mock.lastCall?.[0] as { settings: { taskSortBy?: string } };
        expect(saved.settings.taskSortBy).toBe('due');
    });

    it('refuses invalid input', async () => {
        freezeClock();
        const { host } = await openHost(scenario('base'));
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(host.getInboxView({ groupBy: 'completedDate', offset: 0, limit: 10 })).toMatchObject(invalid);
        expect(host.getInboxView({ filters: { unknown: true } as never, offset: 0, limit: 10 })).toMatchObject(invalid);
        expect(host.getInboxView({ filterEdit: { type: 'nope' } as never, offset: 0, limit: 10 })).toMatchObject(invalid);
        expect(host.getInboxView({ collapsedGroupIds: 'general' as never, offset: 0, limit: 10 })).toMatchObject(invalid);
        const view = value(host.getInboxView({ offset: 0, limit: 10 }));
        expect(host.getInboxFilterTokens({ params: { filterEdit: { type: 'clear' } }, offset: 0, limit: 10, revision: view.revision })).toMatchObject(invalid);
    });

    it('is NOT_READY until storage is activated', async () => {
        await flushPendingSave();
        resetForTests();
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        const notReady = { ok: false, error: { code: 'NOT_READY' } };
        expect(host.getInboxView({ offset: 0, limit: 10 })).toMatchObject(notReady);
        expect(host.getInboxFilterTokens({ offset: 0, limit: 10, revision: 'x' })).toMatchObject(notReady);
    });
});
