import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import {
    createWriteRecorder,
    loadMenuViewsFixture,
    projectObservation,
    replayMenuViewsScenario,
    seedMenuViewsStore,
} from './menu-views-model.replay';
import { applyListFilterEdit, EMPTY_LIST_FILTER_STATE, resolveListFilterState } from './list-filter-state';
import { buildSomedayFilterOptions, buildSomedayViewModel, buildStatusListFilterOptions, buildStatusListModel, buildWaitingViewModel, getSomedayGroupSectionId, selectDeferredProjects } from './menu-views-model';
import { tokenOptions } from './native-host-contract-menu-views';
import { AREA_FILTER_NONE, projectMatchesAreaFilterSelection, type AreaFilterSelection } from './area-filter';
import { buildMoreMenuModel, resolveMobileQuickAccessView } from './more-menu-model';
import { createNativeHostContract } from './native-host-contract';
import {
    buildSomedaySectionsSettingsUpdate,
    getSomedaySectionTaskText,
    moveSomedaySection,
    orderSomedaySections,
    planSomedaySectionCreate,
    planSomedaySectionMove,
    removeSomedaySection,
    renameSomedaySection,
} from './someday-sections-model';
import { resetForTests } from './store';
import type { AppSettings, Area, Project, Task, ViewSectionDefinition } from './types';

const fixture = loadMenuViewsFixture();

describe('list views parity with the frozen React Native fixture', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        const strings = await loadTranslations('en');
        t = (key) => strings[key] ?? key;
    });
    afterAll(() => {
        vi.useRealTimers();
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    const expected = (name: string, screen: Parameters<typeof projectObservation>[0]) => (
        fixture.observations[name].map((observation) => projectObservation(screen, observation, t))
    );

    it('was captured from React Native before the screens changed', () => {
        expect(fixture.provenance.capturedAt).toMatch(/^[0-9a-f]{40}$/);
        expect(fixture.scenarios.length).toBe(Object.keys(fixture.observations).length);
    });

    for (const scenario of fixture.scenarios) {
        it(`core reproduces "${scenario.name}"`, async () => {
            const recorder = createWriteRecorder();
            await seedMenuViewsStore(fixture, scenario, recorder);
            const observed = await replayMenuViewsScenario({ fixture, scenario, recorder, t });
            expect(observed.map((observation) => projectObservation(scenario.screen, observation, t)))
                .toEqual(expected(scenario.name, scenario.screen));
        });
    }

    for (const scenario of fixture.scenarios) {
        it(`the native host contract reproduces "${scenario.name}"`, async () => {
            const recorder = createWriteRecorder();
            await seedMenuViewsStore(fixture, scenario, recorder);
            const contract = createNativeHostContract();
            expect((await contract.setLanguage({ storedLanguage: 'en', systemLocale: null })).ok).toBe(true);
            expect((await contract.activate({ writeSafetyReady: true })).ok).toBe(true);
            recorder.log.splice(0);
            const observed = await replayMenuViewsScenario({ fixture, scenario, recorder, t, contract });
            expect(observed.map((observation) => projectObservation(scenario.screen, observation, t)))
                .toEqual(expected(scenario.name, scenario.screen));
        });
    }
});

describe('list view models', () => {
    const t = (key: string) => key;

    it.each(['inbox', 'done'] as const)('filters %s with canonical options for legacy bare tags and contexts without changing stored data', (kind) => {
        const stamp = '2026-10-20T12:00:00.000Z';
        const tasks: Task[] = [
            { id: 'legacy', title: 'Legacy', status: kind, contexts: [' office/desk ', '@office/desk'], tags: [' admin/team ', '#admin/team'], createdAt: stamp, updatedAt: stamp },
            { id: 'other', title: 'Other', status: kind, contexts: ['@home'], tags: ['#other'], createdAt: stamp, updatedAt: stamp },
        ];
        const settings: AppSettings = { taxonomy: {
            contexts: [{ token: '@office/desk', rev: 1, updatedAt: stamp }],
            tags: [{ token: '#admin/team', rev: 1, updatedAt: stamp }, { token: '#unused', rev: 1, updatedAt: stamp }],
        } };
        const before = JSON.stringify({ tasks, settings });
        const options = buildStatusListFilterOptions({ kind, tasks, allProjects: [], settings, t });
        expect(new Set(options.tokens)).toEqual(new Set(['@home', '@office', '@office/desk', '#admin', '#admin/team', '#other']));
        expect(options.tokens).toHaveLength(6);
        expect(buildStatusListFilterOptions({ kind, tasks, allProjects: [], settings, t, withTokens: false }).tokens).toEqual([]);
        for (const token of ['#admin', '@office']) {
            const picker = tokenOptions(options, EMPTY_LIST_FILTER_STATE).find((item) => item.value === token)!;
            const included = applyListFilterEdit(EMPTY_LIST_FILTER_STATE, picker.edit);
            const excluded = applyListFilterEdit(included, picker.edit);
            for (const [state, expectedIds] of [[included, ['legacy']], [excluded, ['other']]] as const) {
                const resolved = resolveListFilterState(state, { visibility: options.visibility, t });
                expect(resolved.activeCount).toBe(1);
                expect(tokenOptions(options, state).find((item) => item.value === token)?.state)
                    .toBe(state === included ? 'included' : 'excluded');
                const model = buildStatusListModel({ kind, tasks, projects: [], areas: [], settings, groupBy: 'none',
                    criteria: resolved.criteria, searchQuery: resolved.searchQuery, collapsedGroupIds: new Set(), t, now: new Date(stamp) });
                expect(model.orderedTasks.map((task) => task.id)).toEqual(expectedIds);
            }
            expect(applyListFilterEdit(excluded, picker.edit)).toEqual(EMPTY_LIST_FILTER_STATE);
        }
        expect(JSON.stringify({ tasks, settings })).toBe(before);
    });

    it('offers a parent token in Someday when only its child is assigned', () => {
        const item = { id: 'tool', status: 'someday', contexts: ['@tools/excavator'], tags: [] } as Task;
        expect(buildSomedayFilterOptions({ tasks: [item], projects: [], settings: {}, t }).tokens)
            .toEqual(['@tools', '@tools/excavator']);
    });

    it('shows all waiting tasks immediately when the chosen person disappears', () => {
        const task = { id: 'waiting', title: 'Waiting', status: 'waiting', assignedTo: 'Bob' } as Task;
        const model = buildWaitingViewModel({ tasks: [task], projects: [], resolvedAreaFilter: { mode: 'all' }, areaById: new Map(), person: 'Alice', t });
        expect(model.tasks.map(({ id }) => id)).toEqual(['waiting']);
        expect(model.person).toBe('');
    });

    it('resolves an unknown quick-access view to Review and gives its tile to Projects', () => {
        expect(resolveMobileQuickAccessView('trash')).toBe('review');
        const menu = buildMoreMenuModel({ quickAccessView: 'calendar', savedSearches: [], t });
        expect(menu.primary.map((item) => item.id)).toEqual(['waiting', 'someday', 'review', 'reference', 'contexts', 'projects']);
    });

    it('cycles a token through included, excluded and neutral, and retains a missing selection', () => {
        const included = applyListFilterEdit(EMPTY_LIST_FILTER_STATE, { type: 'toggleToken', value: '#a' });
        const excluded = applyListFilterEdit(included, { type: 'toggleToken', value: '#a' });
        expect([included.tokens, excluded.excludedTokens]).toEqual([['#a'], ['#a']]);
        expect(applyListFilterEdit(excluded, { type: 'toggleToken', value: '#a' })).toEqual(EMPTY_LIST_FILTER_STATE);
        const resolved = resolveListFilterState(
            { ...EMPTY_LIST_FILTER_STATE, tokens: ['#gone'], priorities: ['high'] },
            { visibility: { energyLevel: false, location: false, priority: false, timeEstimate: false }, retainTokens: ['#a'], t },
        );
        expect(resolved.state.tokens).toEqual(['#gone']);
        expect(resolved.state.priorities).toEqual([]);
        expect(resolved.activeCount).toBe(1);
    });

    it('uses the Search title rather than its input placeholder in the active chip', () => {
        const resolved = resolveListFilterState(
            { ...EMPTY_LIST_FILTER_STATE, searchQuery: ' MILK ' },
            { visibility: { energyLevel: false, location: false, priority: false, timeEstimate: false }, t: (key) => ({ 'common.search': 'Search...', 'search.title': 'Search' }[key] ?? key) },
        );
        expect(resolved.chips[0].label).toBe('Search: MILK');
    });

    it('removes a header token chip without turning it into an exclusion', () => {
        const included = { ...EMPTY_LIST_FILTER_STATE, tokens: ['#milk'] };
        const resolved = resolveListFilterState(included, {
            visibility: { energyLevel: false, location: false, priority: false, timeEstimate: false }, t,
        });
        expect(applyListFilterEdit(included, resolved.chips[0].edit)).toEqual(EMPTY_LIST_FILTER_STATE);
    });

    it('shows the filtered empty state instead of empty Someday section headings', () => {
        const task = { id: 'task', title: 'Milk', status: 'someday', contexts: [], tags: [], createdAt: '', updatedAt: '' } as Task;
        const settings = { gtd: { viewSections: { someday: [{ id: 'books', title: 'Books', order: 0 }] } } } as AppSettings;
        const model = buildSomedayViewModel({
            tasks: [task], projects: [], areaById: new Map(), resolvedAreaFilter: { mode: 'all' },
            settings, sortBy: 'default', groupBy: 'viewSection', showDetails: true,
            criteria: {}, searchQuery: 'unmatched', filterChips: [{ id: 'search', label: 'Search: unmatched', excluded: false }],
            t: (key) => ({ 'filters.noMatch': 'No tasks match these filters.' }[key] ?? key),
        });
        expect(model.groups).toBeUndefined();
        expect(model.showEmptyState).toBe(true);
        expect(model.labels.emptyTitle).toBe('No tasks match these filters.');
    });

    it('keeps an empty imported none heading and the true No section heading separate', () => {
        const loose = { id: 'loose', title: 'Loose', status: 'someday', contexts: [], tags: [], createdAt: '', updatedAt: '' } as Task;
        const orphan = { ...loose, id: 'orphan', viewSectionIds: { someday: 'removed' } };
        const settings = { gtd: { viewSections: { someday: [{ id: 'none', title: 'Imported', order: 0 }] } } } as AppSettings;
        const model = buildSomedayViewModel({
            tasks: [loose, orphan], projects: [], areaById: new Map(), resolvedAreaFilter: { mode: 'all' },
            settings, sortBy: 'default', groupBy: 'viewSection', showDetails: false,
            criteria: {}, searchQuery: '', filterChips: [], t,
        });
        expect(model.groups?.map(({ id, title, tasks }) => [id, title, tasks.map((task) => task.id)])).toEqual([
            ['view-section:someday:none', 'Imported', []],
            ['view-section:someday:', 'No section', ['loose', 'orphan']],
        ]);
        expect(getSomedayGroupSectionId('view-section:someday:none')).toBe('none');
        expect(getSomedayGroupSectionId('view-section:someday:')).toBeUndefined();
    });

    describe('Someday projects in sections (#1319)', () => {
        const settings = { gtd: { viewSections: { someday: [
            { id: 'travel', title: 'Travel', order: 0 }, { id: 'books', title: 'Books', order: 1 },
        ] } } } as AppSettings;
        const project = (id: string, order: number, viewSectionIds?: Project['viewSectionIds']): Project => ({
            id, title: id, status: 'someday', color: '#6B7280', order, tagIds: [], createdAt: '', updatedAt: '',
            ...(viewSectionIds ? { viewSectionIds } : {}),
        });
        const projects = [
            project('assigned', 0, { someday: 'travel' }),
            project('unassigned', 1),
            project('unknown', 2, { someday: 'deleted-section' }),
            { ...project('active', 3, { someday: 'travel' }), status: 'active' as const },
        ];
        const trip = { id: 'trip-task', title: 'Trip', status: 'someday', contexts: [], tags: [], createdAt: '', updatedAt: '',
            viewSectionIds: { someday: 'travel' } } as Task;
        const build = (groupBy: 'viewSection' | 'project' | 'area' | 'none', tasks: Task[] = [trip], withSettings = settings) => buildSomedayViewModel({
            tasks, projects, areaById: new Map(), resolvedAreaFilter: { included: [], excluded: [] },
            settings: withSettings, sortBy: 'default', groupBy, showDetails: false,
            criteria: {}, searchQuery: '', filterChips: [], t,
        });

        it('puts each parked project in its section, unknown and missing ids in No section, and drops the top block', () => {
            const model = build('viewSection');
            expect(model.groups?.map(({ id, tasks, projects: grouped }) => [id, (grouped ?? []).map((p) => p.id), tasks.map((task) => task.id)])).toEqual([
                ['view-section:someday:travel', ['assigned'], ['trip-task']],
                ['view-section:someday:books', [], []],
                ['view-section:someday:', ['unassigned', 'unknown'], []],
            ]);
            expect(model.deferred).toBeNull();
            expect(model.deferredProjects.map((p) => p.id)).toEqual(['assigned', 'unassigned', 'unknown']);
            expect(model.showEmptyState).toBe(false);
        });

        it('shows parked projects even when Someday has no tasks', () => {
            const model = build('viewSection', []);
            expect(model.groups?.flatMap((group) => group.projects ?? []).map((p) => p.id)).toEqual(['assigned', 'unassigned', 'unknown']);
        });

        it('keeps the top block and plain groups in every other grouping', () => {
            for (const groupBy of ['project', 'area', 'none'] as const) {
                const model = build(groupBy);
                expect(model.deferred?.rows.map((row) => row.id)).toEqual(['assigned', 'unassigned', 'unknown']);
                expect(model.groups?.some((group) => group.projects) ?? false).toBe(false);
            }
            const noSections = build('viewSection', [trip], {} as AppSettings);
            expect(noSections.groups).toBeUndefined();
            expect(noSections.deferred?.rows).toHaveLength(3);
        });
    });

    it('gives filtered Someday the standard chip hint and Clear action', () => {
        const model = buildSomedayViewModel({
            tasks: [], projects: [], areaById: new Map(), resolvedAreaFilter: { mode: 'all' },
            settings: undefined, sortBy: 'default', groupBy: 'none', showDetails: false,
            criteria: {}, searchQuery: 'missing',
            filterChips: ['Search: missing', '#one', '#two', '#three'].map((label, index) => ({ id: String(index), label, excluded: false })),
            t: (key) => ({ 'filters.noMatch': 'No tasks match these filters.', 'filters.clear': 'Clear' }[key] ?? key),
        });
        expect(model.empty).toEqual({ message: 'No tasks match these filters.', hint: 'Search: missing, #one, #two', actionLabel: 'Clear' });
    });

    it('plans Someday section edits without touching other definitions', () => {
        const stored = [{ id: 'b', title: 'B', order: 1 }, { id: 'a', title: 'A', order: 0 }];
        expect(planSomedaySectionCreate(stored, ' a ')).toEqual({ kind: 'existing', id: 'a' });
        expect(planSomedaySectionCreate(stored, 'C', () => 'c')).toEqual({
            kind: 'create', id: 'c', sections: [...stored, { id: 'c', title: 'C', order: 2 }],
        });
        expect(renameSomedaySection(stored, 'a', '  ')).toBeNull();
        expect(moveSomedaySection(stored, 'a', -1)).toBeNull();
        expect(moveSomedaySection(stored, 'a', 1)?.map(({ id, order }) => [id, order])).toEqual([['b', 0], ['a', 1]]);
    });

    it('changes only the edited Someday section: every other entry stays as stored, in stored order', () => {
        // Entries this build cannot show (a newer app's shapes) are kept, not dropped.
        const future = { id: 'f', title: '', order: 0.5, color: 'teal' } as unknown as ViewSectionDefinition;
        const folder = { kind: 'folder', children: ['b'] } as unknown as ViewSectionDefinition;
        const b = { id: 'b', title: 'B', order: 1, icon: 'book' } as ViewSectionDefinition;
        const a = { id: 'a', title: 'A', order: 0 };
        const c = { id: 'c', title: 'C', order: 2 };
        const stored = [b, future, a, folder, c];

        const created = planSomedaySectionCreate(stored, 'D', () => 'd');
        expect(created).toEqual({ kind: 'create', id: 'd', sections: [...stored, { id: 'd', title: 'D', order: 3 }] });

        const renamed = renameSomedaySection(stored, 'a', ' Z ')!;
        expect(renamed).toEqual([b, future, { ...a, title: 'Z' }, folder, c]);
        [0, 1, 3, 4].forEach((index) => expect(renamed[index]).toBe(stored[index]));

        const removed = removeSomedaySection(stored, 'b');
        expect(removed).toEqual([future, a, folder, c]);
        removed.forEach((entry, index) => expect(entry).toBe([future, a, folder, c][index]));

        // Moving C up swaps it with B; A, and the entries it cannot show, stay as stored.
        const moved = moveSomedaySection(stored, 'c', -1)!;
        expect(moved).toEqual([{ ...b, order: 2 }, future, a, folder, { ...c, order: 1 }]);
        [1, 2, 3].forEach((index) => expect(moved[index]).toBe(stored[index]));
        expect(orderSomedaySections(stored, ['a', 'b', 'c'])).toEqual(stored);
        expect(orderSomedaySections(stored, ['a', 'b', 'c']).every((entry, index) => entry === stored[index])).toBe(true);

        expect(buildSomedaySectionsSettingsUpdate({ gtd: { viewSections: { someday: stored } } }, removed))
            .toEqual({ gtd: { viewSections: { someday: [future, a, folder, c] } } });
    });

    it('names a Someday section literally in its Add task heading, even with $ replacement patterns', () => {
        expect(getSomedaySectionTaskText((key) => key, 'Ideas $& $$').title).toBe('Add task to Ideas $& $$');
    });

    it('keeps the first attempt\'s Undo when a failed move is retried', () => {
        const task = { id: 's', title: 'S', status: 'someday', tags: [], contexts: [], createdAt: '', updatedAt: '' } as Task;
        const moved = { ...task, viewSectionIds: { someday: 'x' } };
        const pending = { ids: ['s'], destination: 'x', previous: [{ id: 's', sectionId: 'old' }] };
        expect(planSomedaySectionMove({ ids: ['s'], tasks: [moved], destination: 'x', pending }))
            .toEqual({ updates: [], previous: [{ id: 's', sectionId: 'old' }], resumed: true });
        expect(planSomedaySectionMove({ ids: ['s'], tasks: [task], destination: 'x' }).previous).toEqual([{ id: 's', sectionId: undefined }]);
    });
});

describe('selectDeferredProjects', () => {
    const makeProject = (id: string, overrides: Partial<Project> = {}): Project => ({
        id,
        title: `Project ${id}`,
        status: 'someday',
        color: '#2563eb',
        order: 0,
        tagIds: [],
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        ...overrides,
    } as Project);

    const homeArea = { id: 'area-home', name: 'Home', order: 0 } as Area;
    const areaById = new Map<string, Area>([[homeArea.id, homeArea]]);

    // The predicate React Native's Someday and Waiting screens each carried before the
    // extraction. Comparing against it, rather than iterating the helper, catches the
    // helper quietly accepting a different set.
    const legacySelectDeferredProjects = (
        projects: Project[],
        status: 'someday' | 'waiting',
        resolvedAreaFilter: AreaFilterSelection,
    ) => [...projects]
        .filter((project) => (
            !project.deletedAt
            && project.status === status
            && projectMatchesAreaFilterSelection(project, resolvedAreaFilter, areaById)
        ))
        .sort((a, b) => {
            const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
            const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.title.localeCompare(b.title);
        });

    const candidates: Project[] = [
        makeProject('someday-late', { order: 9, title: 'Zulu' }),
        makeProject('someday-early', { order: 1 }),
        makeProject('someday-unordered', { order: Number.NaN as unknown as number, title: 'Alpha' }),
        makeProject('someday-unordered-2', { order: Number.NaN as unknown as number, title: 'Bravo' }),
        makeProject('someday-deleted', { order: 0, deletedAt: '2026-07-01T00:00:00.000Z' }),
        makeProject('someday-home', { order: 2, areaId: homeArea.id }),
        makeProject('waiting-1', { status: 'waiting', order: 3 }),
        makeProject('waiting-home', { status: 'waiting', order: 1, areaId: homeArea.id }),
        makeProject('waiting-deleted', { status: 'waiting', order: 0, deletedAt: '2026-07-01T00:00:00.000Z' }),
        makeProject('active-1', { status: 'active', order: 0 }),
        makeProject('archived-1', { status: 'archived', order: 0 }),
    ];

    const filters: AreaFilterSelection[] = [
        { included: [], excluded: [] },
        { included: [AREA_FILTER_NONE], excluded: [] },
        { included: [homeArea.id], excluded: [] },
        { included: [], excluded: [homeArea.id] },
    ];

    it.each(['someday', 'waiting'] as const)('matches the old per-screen predicate for %s', (status) => {
        for (const filter of filters) {
            expect(selectDeferredProjects(candidates, status, filter, areaById).map((p) => p.id))
                .toEqual(legacySelectDeferredProjects(candidates, status, filter).map((p) => p.id));
        }
    });

    it('orders by order then title, with unordered projects last', () => {
        const ids = selectDeferredProjects(candidates, 'someday', { included: [], excluded: [] }, areaById).map((p) => p.id);
        expect(ids).toEqual([
            'someday-early',
            'someday-home',
            'someday-late',
            'someday-unordered',
            'someday-unordered-2',
        ]);
    });
});
