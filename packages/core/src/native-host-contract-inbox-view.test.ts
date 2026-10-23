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
    type StatusListItem,
} from './menu-views-model';
import { createNativeHostContract, sortAreasForDisplay } from './native-host-contract';
import type { NativeInboxItem } from './native-host-contract-inbox-view';
import { openScreenHost, openSqliteHost } from './screen-parity.replay';
import type { TaskGroupBy } from './task-group-sections';
import { SqliteAdapter } from './sqlite-adapter';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import type { Area, Project, Task } from './types';
import { generateUUID } from './uuid';

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

    // Task737 fixture design only: physical namespaces and initialized databases belong to root.
    const groupedInboxData = () => {
        const stamp = '2026-09-01T12:00:00.000Z', deviceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        const areas: Area[] = [
            { id: 'area-alpha', name: 'Area Alpha', order: 0, createdAt: stamp, updatedAt: stamp, rev: 1, revBy: deviceId },
            { id: 'area-beta', name: 'Area Beta', order: 1, createdAt: stamp, updatedAt: stamp, rev: 1, revBy: deviceId },
        ];
        const projects: Project[] = areas.map((area, index) => ({
            id: 'project-' + (index === 0 ? 'alpha' : 'beta'), title: 'Project ' + (index === 0 ? 'Alpha' : 'Beta'),
            areaId: area.id, status: 'active', color: '#123456', order: index, tagIds: [], createdAt: stamp, updatedAt: stamp, rev: 1, revBy: deviceId,
        }));
        const tasks: Task[] = Array.from({ length: 55 }, (_, index) => ({
            id: `inbox-group-${String(index + 1).padStart(3, '0')}`,
            title: `Inbox group ${String(55 - index).padStart(3, '0')}`, status: 'inbox',
            contexts: index === 0 ? [' @alpha ', '@beta', '@alpha'] : index < 44 ? ['@alpha'] : index < 54 ? ['@beta'] : [],
            tags: index === 0 ? ['alpha', 'beta', 'alpha'] : index < 49 ? ['alpha'] : index < 54 ? ['beta'] : [],
            ...(index < 54 ? { projectId: projects[index < 27 ? 0 : 1].id } : {}),
            createdAt: new Date(Date.parse(stamp) + index * 1000).toISOString(),
            updatedAt: new Date(Date.parse(stamp) + index * 1000).toISOString(), pushCount: 0, rev: 1, revBy: deviceId,
        }));
        return { tasks, projects, areas, settings: { deviceId, theme: 'light' as const, quickAddAutoClean: true, diagnostics: { loggingEnabled: true } } };
    };
    const groupItem = (item: NativeInboxItem | StatusListItem) => item.type === 'section'
        ? { type: item.type, id: item.id, title: item.title, count: item.count,
            muted: item.muted, collapsible: item.collapsible, collapsed: item.collapsed }
        : { type: item.type, id: 'row' in item ? item.row.id : item.task.id, groupId: item.groupId };
    const groupedRN = (groupBy: TaskGroupBy, collapsedGroupIds: string[] = []) => {
        const state = useTaskStore.getState();
        return buildStatusListModel({ kind: 'inbox', tasks: state.tasks, projects: state.projects, areas: state.areas,
            settings: state.settings, groupBy, collapsedGroupIds: new Set(collapsedGroupIds), criteria: {},
            searchQuery: '', t, now: new Date(fixture.now) });
    };

    it.each(['none', 'context', 'area', 'project', 'tag'] as const)(
        'pages complete RN %s groups, including repeated tasks with distinct group identities', async (groupBy) => {
            freezeClock();
            const saveData = vi.fn().mockResolvedValue(undefined), writes: unknown[] = [];
            const host = await openScreenHost({ data: groupedInboxData(), record: { updateSettings: 1 }, log: writes, saveData });
            saveData.mockClear();
            const before = structuredClone(useTaskStore.getState()._allTasks);
            const first = value(host.getInboxView({ groupBy, collapsedGroupIds: [], offset: 0, limit: 50 }));
            const rest = value(host.getInboxView({ groupBy, collapsedGroupIds: [], offset: 50, limit: 50, revision: first.revision }));
            const items = [...first.items, ...rest.items], rn = groupedRN(groupBy);
            expect(first.items).toHaveLength(50);
            expect(rest.total).toBe(first.total);
            expect(rest.revision).toBe(first.revision);
            expect(first.count).toBe(55); // Distinct tasks, not duplicated displayed rows or headings.
            expect(first.total).toBe(rn.items.length);
            expect(items.map(groupItem)).toEqual(rn.items.map(groupItem));
            expect(first.toolbar.group.options.map(({ value: axis, edit, selected }) => ({ axis, edit, selected })))
                .toEqual(['none', 'context', 'area', 'project', 'tag'].map((axis) => ({ axis, edit: { groupBy: axis }, selected: axis === groupBy })));
            const identities = items.map((item) => item.type === 'section' ? 'section:' + item.id : item.groupId + ':' + item.row.id);
            expect(new Set(identities).size).toBe(items.length);
            if (groupBy === 'none') expect(items.every((item) => item.type === 'task' && item.groupId === null)).toBe(true);
            if (groupBy === 'context' || groupBy === 'tag') {
                expect(first.total).toBe(59); // 55 tasks + one legitimate second membership + three headings.
                const duplicated = items.filter((item) => item.type === 'task' && item.row.id === 'inbox-group-001');
                expect(duplicated.map((item) => item.type === 'task' && item.groupId))
                    .toEqual(groupBy === 'context' ? ['context:@alpha', 'context:@beta'] : ['tag:alpha', 'tag:beta']);
            }
            if (groupBy === 'context') {
                expect(first.items[45]).toMatchObject({ type: 'section', id: 'context:@beta', count: 11 });
                expect(rest.items[0]).toMatchObject({ type: 'task', row: { id: 'inbox-group-048' }, groupId: 'context:@beta' });
            }
            if (groupBy === 'tag') expect(rest.items[0]).toMatchObject({ type: 'section', id: 'tag:beta', count: 6 });
            expect(useTaskStore.getState()._allTasks).toEqual(before);
            expect(writes).toEqual([]); expect(saveData).not.toHaveBeenCalled();
        },
    );

    it('returns composable fold edits and refuses continuations under changed axis, folds or filters', async () => {
        freezeClock();
        const writes: unknown[] = [], saveData = vi.fn().mockResolvedValue(undefined);
        const host = await openScreenHost({ data: groupedInboxData(), record: { updateSettings: 1 }, log: writes, saveData });
        saveData.mockClear();
        const params = { groupBy: 'context' as const, collapsedGroupIds: ['context:gone'] };
        const first = value(host.getInboxView({ ...params, offset: 0, limit: 50 }));
        const alpha = first.items.find((item) => item.type === 'section' && item.id === 'context:@alpha');
        expect(alpha?.type).toBe('section');
        if (alpha?.type !== 'section') throw new Error('Missing alpha heading');
        expect(alpha.collapseEdit).toEqual({ collapsedGroupIds: ['context:gone', 'context:@alpha'] });
        expect(params.collapsedGroupIds).toEqual(['context:gone']);
        const folded = value(host.getInboxView({ groupBy: 'context', ...alpha.collapseEdit, offset: 0, limit: 50 }));
        expect(folded.count).toBe(55); expect(folded.total).toBe(15);
        expect(folded.items.map(groupItem)).toEqual(groupedRN('context', alpha.collapseEdit.collapsedGroupIds).items.map(groupItem));
        expect(folded.items.filter((item) => item.type === 'task' && item.row.id === 'inbox-group-001'))
            .toMatchObject([{ groupId: 'context:@beta' }]);
        const foldedAlpha = folded.items.find((item) => item.type === 'section' && item.id === 'context:@alpha');
        expect(foldedAlpha).toMatchObject({ count: 44, collapsed: true, collapseEdit: { collapsedGroupIds: ['context:gone'] } });
        for (const changed of [
            { ...params, groupBy: 'tag' as const },
            { groupBy: 'context' as const, ...alpha.collapseEdit },
            { ...params, filters: { tokens: ['@alpha'] } },
            {}, // Omitting params defaults to none; never treat it as the previous grouped view.
        ]) expect(host.getInboxView({ ...changed, offset: 50, limit: 50, revision: first.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const foldPage = value(host.getInboxView({ groupBy: 'context', ...alpha.collapseEdit, offset: 1, limit: 2, revision: folded.revision }));
        expect(foldPage.items.map(groupItem)).toEqual(folded.items.slice(1, 3).map(groupItem));
        const tagEdit = first.toolbar.group.options.find((option) => option.value === 'tag')!.edit;
        expect(tagEdit).toEqual({ groupBy: 'tag' });
        const tagParams = { ...tagEdit, collapsedGroupIds: ['tag:beta'] };
        const tags = value(host.getInboxView({ ...tagParams, offset: 0, limit: 50 }));
        const tagTail = value(host.getInboxView({ ...tagParams, offset: 50, limit: 50, revision: tags.revision }));
        expect(tagTail.items[0]).toMatchObject({ type: 'section', id: 'tag:beta', collapsed: true });
        expect(value(host.getInboxView({ ...params, ...alpha.collapseEdit, offset: 0, limit: 50 })).revision).toBe(folded.revision);
        expect(writes).toEqual([]); expect(saveData).not.toHaveBeenCalled();
        value(await host.setTaskListSort({ sortBy: 'title' }));
        const sorted = value(host.getInboxView({ groupBy: 'context', ...alpha.collapseEdit, offset: 0, limit: 50 }));
        expect(sorted.revision).not.toBe(folded.revision);
        expect(sorted.items.map(groupItem)).toEqual(groupedRN('context', alpha.collapseEdit.collapsedGroupIds).items.map(groupItem));
        expect(sorted.items.find((item) => item.type === 'task')).toMatchObject({ row: { id: 'inbox-group-054' } });
    });

    it('bounds fold transport without changing the prior read parameters or domain state', async () => {
        freezeClock();
        const writes: unknown[] = [], saveData = vi.fn().mockResolvedValue(undefined);
        const host = await openScreenHost({ data: groupedInboxData(), record: { updateSettings: 1 }, log: writes, saveData });
        saveData.mockClear();
        const collapsedGroupIds = Array.from({ length: 200 }, (_, index) => 'context:old-' + index);
        const params = { groupBy: 'context' as const, collapsedGroupIds };
        const before = value(host.getInboxView({ ...params, offset: 0, limit: 50 }));
        expect(before.collapsedGroupIds).toEqual(collapsedGroupIds);
        const heading = before.items.find((item) => item.type === 'section');
        if (heading?.type !== 'section') throw new Error('Missing heading');
        expect(heading.collapseEdit.collapsedGroupIds).toHaveLength(201); // App must bound even core-offered edits before local persistence.
        expect(host.getInboxView({ ...params, ...heading.collapseEdit, offset: 0, limit: 50 }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const bad of [[...collapsedGroupIds, 'context:overflow'], [1], 'context:@alpha']) {
            expect(host.getInboxView({ ...params, collapsedGroupIds: bad as never, offset: 0, limit: 50 }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(value(host.getInboxView({ ...params, offset: 0, limit: 50 }))).toEqual(before);
        expect(writes).toEqual([]); expect(saveData).not.toHaveBeenCalled();
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

    it('cycles legacy bare Inbox token picker edits through real include and exclude filters without saving', async () => {
        freezeClock();
        const { host, writes } = await openHost(scenario('base'));
        const template = useTaskStore.getState()._allTasks.find((task) => task.status === 'inbox')!;
        const tasks: Task[] = [
            { ...template, id: 'bare', title: 'Bare', contexts: ['office'], tags: ['admin'] },
            { ...template, id: 'other', title: 'Other', contexts: ['@home'], tags: ['#other'] },
        ];
        useTaskStore.setState({ tasks, _allTasks: tasks, _tasksById: new Map(tasks.map((task) => [task.id, task])), lastDataChangeAt: Date.now() });
        const before = JSON.stringify(useTaskStore.getState()._allTasks);
        const first = value(host.getInboxView({ offset: 0, limit: 100 }));
        const rows = (view: typeof first) => view.items.flatMap((item) => item.type === 'task' ? [item.row.id] : []);
        for (const token of ['#admin', '@office']) {
            const picker = value(host.getInboxFilterTokens({ offset: 0, limit: 100, revision: first.revision, query: token.slice(1) }));
            const edit = picker.items.find((item) => item.value === token)?.edit;
            expect(edit).toEqual({ type: 'toggleToken', value: token });
            const included = value(host.getInboxView({ offset: 0, limit: 100, filterEdit: edit }));
            expect(rows(included)).toEqual(['bare']);
            expect(included.filterActiveCount).toBe(1);
            expect(included.filters.tokens.items.find((item) => item.value === token)?.state).toBe('included');
            const excluded = value(host.getInboxView({ offset: 0, limit: 100, filters: included.filters.state, filterEdit: edit }));
            expect(rows(excluded)).toEqual(['other']);
            expect(excluded.filterActiveCount).toBe(1);
            expect(excluded.chips).toMatchObject([{ label: token, excluded: true }]);
            const cleared = value(host.getInboxView({ offset: 0, limit: 100, filters: excluded.filters.state, filterEdit: edit }));
            expect(new Set(rows(cleared))).toEqual(new Set(['bare', 'other']));
            expect(cleared.hasActiveFilters).toBe(false);
        }
        await flushPendingSave();
        expect(writes).toEqual([]);
        expect(JSON.stringify(useTaskStore.getState()._allTasks)).toBe(before);
    });

    it('searches the complete Inbox token pool and keeps filter reads out of SQLite', async () => {
        freezeClock();
        const tokens = Array.from({ length: 103 }, (_, index) => `@context-${String(index).padStart(3, '0')}`);
        const stamp = '2026-09-01T12:00:00.000Z';
        const tasks: Task[] = tokens.map((token, index) => ({
            id: `filter-${index}`, title: `Filter ${index}`, status: 'inbox', contexts: [token], tags: [],
            createdAt: stamp, updatedAt: stamp, rev: 1, revBy: 'filter-fixture',
        }));
        const sqlite = await openSqliteHost({ tasks, settings: { taskSortBy: 'title' } });
        try {
            const data = () => new SqliteAdapter(sqlite.client()).getData({ rawTasks: true });
            const before = await data();
            const rows = await sqlite.sql('SELECT rowid AS evidence_rowid, * FROM tasks ORDER BY rowid');
            const receipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY rowid');
            const first = value(sqlite.host.getInboxView({ offset: 0, limit: 100 }));
            expect(first.filters.tokens.total).toBe(103);
            expect(first.filters.tokens.items).toHaveLength(100);
            const tail = value(sqlite.host.getInboxFilterTokens({ offset: 100, limit: 100, revision: first.revision }));
            expect(tail.items.map((item) => item.value)).toEqual(tokens.slice(100));
            const searched = value(sqlite.host.getInboxFilterTokens({ offset: 0, limit: 100, revision: first.revision, query: 'CONTEXT-102' }));
            expect(searched.total).toBe(1);
            expect(searched.items.map((item) => item.value)).toEqual([tokens[102]]);
            const fullSelection = { tokens: tokens.slice(0, 100) };
            expect(sqlite.host.getInboxView({ filters: fullSelection,
                filterEdit: { type: 'toggleToken', value: tokens[100] }, offset: 0, limit: 100 }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const fullExcluded = { tokens: [tokens[100]], excludedTokens: tokens.slice(0, 100) };
            expect(sqlite.host.getInboxView({ filters: fullExcluded,
                filterEdit: { type: 'toggleToken', value: tokens[100] }, offset: 0, limit: 100 }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const bounded = value(sqlite.host.getInboxView({ filters: { tokens: tokens.slice(0, 99) },
                filterEdit: { type: 'toggleToken', value: tokens[99] }, offset: 0, limit: 100 }));
            expect(bounded.filters.state.tokens).toHaveLength(100);
            expect(value(sqlite.host.getInboxFilterTokens({ params: { filters: bounded.filters.state },
                offset: 100, limit: 100, revision: bounded.revision })).items).toHaveLength(3);
            let filters = first.filters.state;
            for (const [included, excluded, count] of [[true, false, 1], [false, true, 102], [false, false, 103]] as const) {
                const next = value(sqlite.host.getInboxView({ filters, filterEdit: { type: 'toggleToken', value: tokens[102] }, offset: 0, limit: 100 }));
                filters = next.filters.state;
                expect(filters.tokens.includes(tokens[102])).toBe(included);
                expect(filters.excludedTokens.includes(tokens[102])).toBe(excluded);
                expect(next.total).toBe(count);
            }
            const empty = value(sqlite.host.getInboxView({ filterEdit: { type: 'setSearch', value: 'absent-fixture-title' }, offset: 0, limit: 100 }));
            expect(empty.total).toBe(0);
            expect(empty.empty.action).toEqual({ filterEdit: { type: 'clear' } });
            const cleared = value(sqlite.host.getInboxView({ filters: empty.filters.state, ...empty.empty.action, offset: 0, limit: 100 }));
            expect(cleared.total).toBe(103);
            expect(cleared.hasActiveFilters).toBe(false);
            expect(await data()).toEqual(before);
            expect(await sqlite.sql('SELECT rowid AS evidence_rowid, * FROM tasks ORDER BY rowid')).toEqual(rows);
            expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY rowid')).toEqual(receipts);
        } finally { await sqlite.close(); }
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

    it('persists checked Inbox sorts through complete paging and cold reload without editing tasks', async () => {
        freezeClock();
        const ids = Array.from({ length: 55 }, (_, index) => `inbox-sort-${String(index + 1).padStart(3, '0')}`);
        const deviceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        const tasks: Task[] = ids.map((id, index) => ({
            id, title: `Inbox sort ${String(55 - index).padStart(3, '0')}`, status: 'inbox', contexts: [], tags: [],
            createdAt: new Date(Date.parse('2026-09-01T12:00:00.000Z') + index * 1000).toISOString(),
            updatedAt: '2026-09-01T12:00:00.000Z', rev: 1, revBy: deviceId,
        }));
        const sqlite = await openSqliteHost({ tasks, settings: { deviceId, theme: 'light', quickAddAutoClean: true } });
        try {
            const data = () => new SqliteAdapter(sqlite.client()).getData({ rawTasks: true });
            const taskRows = () => sqlite.sql('SELECT rowid AS evidence_rowid, * FROM tasks ORDER BY rowid');
            const receiptRows = () => sqlite.sql<{ request_id: string; reply: string }>(
                'SELECT rowid AS evidence_rowid, * FROM native_request_receipts ORDER BY rowid');
            const before = await data(), originalTasks = await taskRows();
            const pages = () => {
                const first = value(sqlite.host.getInboxView({ offset: 0, limit: 50 }));
                const last = value(sqlite.host.getInboxView({ offset: 50, limit: 50, revision: first.revision }));
                expect(first.total).toBe(55);
                expect(first.items).toHaveLength(50);
                expect(last.items).toHaveLength(5);
                return { first, ids: [...first.items, ...last.items].map((item) => item.type === 'task' ? item.row.id : item.id) };
            };
            let previous = pages();
            expect(previous.ids).toEqual(ids);
            expect(value(sqlite.host.getTaskListSortOptions({})).expected).toEqual({ sortBy: null });
            const requests: string[] = [], replies: { sortBy: string }[] = [];
            for (const sortBy of ['title', 'default'] as const) {
                const requestId = generateUUID();
                const expected = value(sqlite.host.getTaskListSortOptions({})).expected;
                expect(await sqlite.host.setTaskListSortChecked({ requestId, sortBy, expected }))
                    .toEqual({ ok: true, value: { sortBy } });
                requests.push(requestId); replies.push({ sortBy });
                const persisted = await data();
                expect(persisted.settings?.taskSortBy).toBe(sortBy);
                const otherSettings = { ...persisted.settings };
                delete otherSettings.taskSortBy;
                expect({ ...persisted, settings: otherSettings }).toEqual(before);
                expect(await taskRows()).toEqual(originalTasks);
                const receipts = await receiptRows();
                expect(receipts.map((row) => row.request_id)).toEqual(requests);
                expect(receipts.map((row) => JSON.parse(row.reply))).toEqual(replies);
                expect(sqlite.host.getInboxView({ offset: 50, limit: 50, revision: previous.first.revision }))
                    .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                const ordered = sortBy === 'title' ? [...ids].reverse() : ids;
                const state = useTaskStore.getState();
                const rn = buildStatusListModel({ kind: 'inbox', tasks: state.tasks, projects: state.projects,
                    areas: state.areas, settings: state.settings, groupBy: 'none', criteria: {}, searchQuery: '',
                    collapsedGroupIds: new Set(), t, now: new Date(fixture.now) });
                expect(rn.orderedTasks.map((task) => task.id)).toEqual(ordered);
                expect(pages().ids).toEqual(ordered);
                await sqlite.restart();
                expect(await data()).toEqual(persisted);
                expect(await receiptRows()).toEqual(receipts);
                expect(value(sqlite.host.getTaskListSortOptions({})).expected).toEqual({ sortBy });
                previous = pages();
                expect(previous.ids).toEqual(ordered);
                expect(previous.first.sortBy).toBe(sortBy);
                expect(previous.first.toolbar.sort.options.find((option) => option.selected)?.value).toBe(sortBy);
            }
        } finally { await sqlite.close(); }
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
