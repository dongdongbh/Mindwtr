import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildFocusControlsModel, DEFAULT_FOCUS_CONTROL_STATE, type FocusControlState } from './focus-controls';
import {
    createContractFocusDriver,
    focusControlsWrites,
    loadFocusControlsFixture,
    seedFocusControlsStore,
} from './focus-controls.replay';
import { loadTranslations } from './i18n/i18n-loader';
import { EMPTY_LIST_FILTER_STATE } from './list-filter-state';
import { createNativeHostContract } from './native-host-contract';
import { replayAfterRestart } from './screen-parity.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import { generateUUID } from './uuid';
import { setNativeReplayTokens } from './native-request-receipts';

const fixture = loadFocusControlsFixture();
const scenario = (settings = 'base') => fixture.scenarios.find((entry) => entry.settings === settings && !entry.taskIds)!;
const withFilters = (filters: Partial<FocusControlState['filters']>, rest: Partial<FocusControlState> = {}): FocusControlState => ({
    ...DEFAULT_FOCUS_CONTROL_STATE, filters: { ...EMPTY_LIST_FILTER_STATE, ...filters }, ...rest,
});

describe('native host contract: Focus controls', () => {
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
    const openHost = async (settings = 'base', saveData?: (data: unknown) => Promise<void>) => {
        await seedFocusControlsStore(fixture, scenario(settings), { saveData });
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        focusControlsWrites().length = 0;
        return host;
    };
    const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return result.value;
    };
    type Host = ReturnType<typeof createNativeHostContract>;
    /** Today's Focus rows' revisions, as the reorder screen shows them. */
    const reorderRevisions = (host: Host) => Object.fromEntries(value(host.getFocus({ limit: 1, controls: DEFAULT_FOCUS_CONTROL_STATE })).controls.reorder!.rows.items
        .map((row) => [row.id, row.taskRevision]));
    const direct = (state: FocusControlState) => {
        const store = useTaskStore.getState();
        return buildFocusControlsModel({
            state, tasks: store.tasks, projects: store.projects, areas: store.areas, sections: store.sections, settings: store.settings, now: new Date(), t,
        });
    };

    // The contract view carries what a host draws; criteria and save flags stay in core's model.
    const contractPart = (observations: unknown[]) => observations.map((entry) => {
        const copy = structuredClone(entry) as { sheet: { selections: Record<string, unknown> } };
        for (const key of ['criteria', 'currentCriteria', 'hasCurrentCriteria', 'canSave']) delete copy.sheet.selections[key];
        return copy;
    });

    it.each(fixture.scenarios.map((entry) => [entry.name, entry] as const))(
        'replays the frozen React Native scenario through the contract: %s',
        async (_name, entry) => {
            freezeClock();
            await seedFocusControlsStore(fixture, entry);
            const host = createNativeHostContract();
            expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
            expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
            focusControlsWrites().length = 0;
            const driver = createContractFocusDriver(host, t);
            const observed = [driver.observe()];
            for (const action of entry.actions) {
                await driver.perform(action);
                observed.push(driver.observe());
            }
            expect(contractPart(observed)).toEqual(contractPart(fixture.observations[entry.name]));
        },
    );

    it('keeps globally occupied Focus slots and pages only visible rows under area and criteria filters', async () => {
        freezeClock();
        const host = await openHost();
        const state = useTaskStore.getState();
        const focused = state.tasks.filter((task) => task.isFocusedToday);
        expect(focused).toHaveLength(3);
        await state.updateTask(focused[0].id, { areaId: 'a-work' });
        await state.updateTask(focused[1].id, { areaId: 'a-home' });
        await state.updateTask(focused[2].id, { areaId: 'a-home' });
        await state.updateSettings({ filters: { areaIds: ['a-work'] }, gtd: { ...state.settings.gtd, focusTaskLimit: 3 } });
        const controls = DEFAULT_FOCUS_CONTROL_STATE;
        const view = value(host.getFocus({ limit: 100, controls }));
        const section = view.sections.find((item) => item.key === 'focus')!;
        expect(section).toMatchObject({ total: 3, rowTotal: 1, countLabel: '3/3', hiddenByAreaLabel: '2 selected in other areas' });
        expect(section.rows.map((row) => row.id)).toEqual([focused[0].id]);
        const filtered = value(host.getFocus({ limit: 100, controls: { ...controls, preservedCriteria: { hasDescription: true } } }));
        const filteredSection = filtered.sections.find((item) => item.key === 'focus')!;
        expect(filteredSection).toMatchObject({ total: 3, rowTotal: 0, countLabel: '3/3', hiddenByAreaLabel: '2 selected in other areas' });
        expect(filtered.controls.empty).toBeNull();
        const page = value(host.getFocusSectionWindow({ key: 'focus', offset: 0, limit: 100,
            revision: filtered.revision, controls: filtered.controls.state }));
        expect(page).toMatchObject({ total: 3, rowTotal: 0, rows: [] });
    });

    it('pages Pomodoro choices from all four RN Focus pools under the same controls and revision', async () => {
        freezeClock();
        const host = await openHost();
        const states = [DEFAULT_FOCUS_CONTROL_STATE, withFilters({ tokens: ['@phone'] })];
        for (const controls of states) {
            const focus = value(host.getFocus({ limit: 1, controls }));
            const lists = direct(controls).lists;
            const expected = new Map<string, string>();
            for (const task of [...lists.focusedTasks, ...lists.schedule, ...lists.nextActions, ...lists.reviewDue])
                if (!task.deletedAt) expected.set(task.id, task.title);
            const observed: { id: string; title: string }[] = [];
            for (let offset = 0; offset < Math.max(1, expected.size); offset += 2) {
                const page = value(host.getPomodoroTaskWindow({ offset, limit: 2, revision: focus.revision, controls }));
                expect(page.total).toBe(expected.size);
                expect(page.revision).toBe(focus.revision);
                observed.push(...page.rows);
            }
            expect(observed).toEqual([...expected].map(([id, title]) => ({ id, title })));
            expect(host.getPomodoroTaskWindow({ offset: 0, limit: 2, revision: focus.revision + '-stale', controls }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        expect(focusControlsWrites()).toHaveLength(0);
    });

    it('rejects malformed, oversized and unready Pomodoro picker reads', async () => {
        freezeClock();
        const host = await openHost();
        const focus = value(host.getFocus({ limit: 1 }));
        const input = { offset: 0, limit: 1, revision: focus.revision };
        for (const change of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 },
            { revision: null }, { controls: { extra: true } }, { extra: true }]) {
            expect(host.getPomodoroTaskWindow({ ...input, ...change } as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(createNativeHostContract().getPomodoroTaskWindow(input))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    });

    it('returns what core\'s Focus model returns when called directly', async () => {
        freezeClock();
        const host = await openHost('base');
        const states = [
            DEFAULT_FOCUS_CONTROL_STATE,
            withFilters({ tokens: ['@office', '@phone'], contextMatchMode: 'any' }, { sortBy: 'due' }),
            withFilters({}, { savedFilterId: 'sf-work' }),
            withFilters({ tokens: ['@nowhere'], priorities: ['urgent'] }),
        ];
        for (const state of states) {
            const model = direct(state);
            const view = value(host.getFocus({ limit: 100, controls: state }));
            expect(view.controls.state).toEqual(model.filter.state);
            const rows = Object.fromEntries(view.sections.map((section) => [section.key, section.rows.map((row) => row.id)]));
            expect(rows.focus ?? []).toEqual(model.lists.focusedTasks.map((task) => task.id));
            expect(rows.reviewDue).toEqual(model.lists.reviewDue.map((task) => task.id));
            expect(rows.next).toEqual(model.lists.nextActions.map((task) => task.id));
            expect(rows.upcoming ?? []).toEqual(model.lists.upcoming.map((task) => task.id));
            expect(view.controls.widgetFilter).toEqual({
                criteria: model.filter.criteria, sortBy: model.perspective.effectiveSortBy, sortOrder: model.filter.activeSavedFilter?.sortOrder ?? null,
            });
            expect(view.controls.filterSheet.chips.map((chip) => [chip.id, chip.label, chip.edit]))
                .toEqual(model.filter.chips.map((chip) => [chip.id, chip.label, { type: 'filter', edit: chip.edit }]));
            expect(view.controls.filterSheet.advancedChips).toEqual(model.advancedChips);
            expect(view.controls.reorder !== null).toBe(model.canReorder);
            expect(view.controls.empty).toEqual(model.empty);
        }
    });

    it('round trips task-date options, widget criteria, preserved advanced chips and clear', async () => {
        freezeClock();
        const host = await openHost('base');
        const saved = { id: 'date-filter', name: 'Dates', view: 'focus' as const,
            criteria: { anyDateRange: { preset: 'overdue_next_7_days' as const }, dueDateRange: { preset: 'today' as const }, statuses: ['next' as const], futureDateRule: { keep: true },
                priority: ['none' as const], timeEstimates: ['custom:45'], locations: ['Office', 'Home'] },
            createdAt: fixture.now, updatedAt: fixture.now };
        useTaskStore.setState((state) => ({ settings: { ...state.settings, savedFilters: [saved] } }));
        const applied = value(host.getFocus({ limit: 100, controlEdit: { type: 'applySavedFilter', id: saved.id } }));
        const options = applied.controls.filterSheet.taskDates.options;
        expect(options.map((option) => option.value)).toEqual(['', 'today', 'next_7_days', 'overdue_next_7_days', 'next_14_days', 'next_30_days', 'upcoming']);
        expect(options.find((option) => option.selected)?.value).toBe('overdue_next_7_days');
        expect(applied.controls.widgetFilter.criteria).toMatchObject({ anyDateRange: { preset: 'overdue_next_7_days' }, dueDateRange: { preset: 'today' } });
        expect(applied.controls.filterSheet.advancedChips.map((chip) => chip.criterionId)).not.toContain('anyDateRange');
        const next30 = options.find((option) => option.value === 'next_30_days')!;
        const edited = value(host.getFocus({ limit: 100, controls: applied.controls.state, controlEdit: next30.edit }));
        expect(edited.controls.state.savedFilterId).toBeNull();
        expect(edited.controls.widgetFilter.criteria).toEqual({ ...saved.criteria, anyDateRange: { preset: 'next_30_days' } });
        const overdueEdit = options.find((option) => option.value === 'overdue_next_7_days')!.edit;
        expect(value(host.getFocus({ limit: 100, controls: edited.controls.state, controlEdit: overdueEdit }))
            .controls.widgetFilter.criteria.anyDateRange).toEqual({ preset: 'overdue_next_7_days' });
        expect(edited.controls.filterSheet.chips.map((chip) => chip.id)).toEqual(expect.arrayContaining([
            'preserved:priority', 'preserved:timeEstimates', 'preserved:location:Office', 'preserved:location:Home',
        ]));
        const basicRemoved = value(host.getFocus({ limit: 100, controls: edited.controls.state,
            controlEdit: edited.controls.filterSheet.chips.find((chip) => chip.id === 'preserved:priority')!.edit }));
        expect(basicRemoved.controls.widgetFilter.criteria.priority).toBeUndefined();
        const malformed = value(host.getFocus({ limit: 100, controls: { ...DEFAULT_FOCUS_CONTROL_STATE,
            preservedCriteria: { dueDateRange: { preset: 42 } as never } } }));
        expect(malformed.controls.filterSheet.chips).toEqual([]);
        const preserved = edited.controls.filterSheet.chips.find((chip) => chip.id === 'preserved:dueDateRange')!;
        expect(preserved).toBeDefined();
        const removed = value(host.getFocus({ limit: 100, controls: edited.controls.state, controlEdit: preserved.edit }));
        expect(removed.controls.widgetFilter.criteria.dueDateRange).toBeUndefined();
        expect(removed.controls.widgetFilter.criteria.statuses).toEqual(['next']);
        const noDate = value(host.getFocus({ limit: 100, controls: removed.controls.state,
            controlEdit: removed.controls.filterSheet.taskDates.options[0].edit }));
        expect(noDate.controls.widgetFilter.criteria).toEqual({ ...saved.criteria, anyDateRange: undefined, dueDateRange: undefined });
        const cleared = value(host.getFocus({ limit: 100, controls: noDate.controls.state, controlEdit: noDate.controls.filterSheet.clear.edit }));
        expect(cleared.controls.state).toEqual(DEFAULT_FOCUS_CONTROL_STATE);
        expect(cleared.controls.widgetFilter.criteria).toEqual({});
        expect(host.getFocus({ limit: 100, controls: withFilters({ anyDateRange: { preset: 'invalid' } as never }) }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('groups Next actions as RN does, and pages the rows with their headings under one revision', async () => {
        freezeClock();
        const host = await openHost('base');
        const controls = withFilters({}, { savedFilterId: 'sf-phone' });
        const view = value(host.getFocus({ limit: 1, controls: DEFAULT_FOCUS_CONTROL_STATE, controlEdit: { type: 'applySavedFilter', id: 'sf-phone' } }));
        expect(view.controls.state).toMatchObject({ savedFilterId: 'sf-phone', sortBy: 'due' });
        const next = view.sections.find((section) => section.key === 'next')!;
        // Call bank has two contexts: it is listed under each, and counted once in the header.
        expect({ total: next.total, rowTotal: next.rowTotal, rows: next.rows.map((row) => row.id), groups: next.groups }).toEqual({
            total: 1, rowTotal: 2, rows: ['n2'],
            groups: [{ id: 'context:@office', title: '@office', count: 1, muted: false, dotColor: '#2563eb', start: 0 }],
        });
        const page = value(host.getFocusSectionWindow({ key: 'next', offset: 1, limit: 1, revision: view.revision, controls: view.controls.state }));
        expect({ rows: page.rows.map((row) => row.id), groups: page.groups, total: page.total, rowTotal: page.rowTotal }).toEqual({
            rows: ['n2'], groups: [{ id: 'context:@phone', title: '@phone', count: 1, muted: false, dotColor: '#15803d', start: 1 }], total: 1, rowTotal: 2,
        });
        // Paging with another control state is another view.
        expect(host.getFocusSectionWindow({ key: 'next', offset: 0, limit: 1, revision: view.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(view.controls.state).toEqual({ ...controls, filters: { ...controls.filters, tokens: ['@phone'] }, sortBy: 'due' });
    });

    it('keeps a read without controls flat after a stored grouping: each task once, sections and paging unchanged', async () => {
        freezeClock();
        const host = await openHost('base');
        const before = value(host.getFocus({ limit: 100 }));
        const beforePage = value(host.getFocusSectionWindow({ key: 'next', offset: 1, limit: 2, revision: before.revision }));
        value(await host.setFocusGroupBy({ requestId: generateUUID(), controls: DEFAULT_FOCUS_CONTROL_STATE, groupBy: 'context' }));
        expect(useTaskStore.getState().settings.gtd?.focusGroupBy).toBe('context');
        const after = value(host.getFocus({ limit: 100 }));
        expect(after.sections).toEqual(before.sections);
        const next = after.sections.find((section) => section.key === 'next')!;
        // Call bank (n2) has two contexts and is still listed once.
        expect(next.rows.map((row) => row.id)).toEqual(['n2', 'n5', 'n1', 'n3', 'n4']);
        expect(after.sections.every((section) => !('rowTotal' in section) && !('groups' in section))).toBe(true);
        const afterPage = value(host.getFocusSectionWindow({ key: 'next', offset: 1, limit: 2, revision: after.revision }));
        expect({ ...afterPage, revision: '' }).toEqual({ ...beforePage, revision: '' });
        expect('groups' in afterPage || 'rowTotal' in afterPage).toBe(false);
        // A read that sends controls gets the stored grouping.
        const grouped = value(host.getFocus({ limit: 100, controls: DEFAULT_FOCUS_CONTROL_STATE }));
        const groupedNext = grouped.sections.find((section) => section.key === 'next')!;
        expect(groupedNext.rows.filter((row) => row.id === 'n2')).toHaveLength(2);
        expect(groupedNext.groups?.map((group) => group.id)).toContain('context:@phone');
        expect(grouped.revision).not.toBe(after.revision);
    });

    it('sends the grey default dot for a Project with no Area and no color, which the native headers paint (#1422)', async () => {
        freezeClock();
        const host = await openHost('base');
        value(await host.setFocusGroupBy({ requestId: generateUUID(), controls: DEFAULT_FOCUS_CONTROL_STATE, groupBy: 'project' }));
        const next = value(host.getFocus({ limit: 100, controls: DEFAULT_FOCUS_CONTROL_STATE })).sections.find((section) => section.key === 'next')!;
        expect(next.groups?.find((group) => group.id === 'project:p-alpha')?.dotColor).toBe('#94a3b8');
    });

    it('changes the revision on a control edit or a relevant store edit, and refuses a stale page', async () => {
        freezeClock();
        const host = await openHost('base');
        const first = value(host.getFocus({ limit: 1 }));
        expect(value(host.getFocus({ limit: 1 })).revision).toBe(first.revision);
        const filtered = value(host.getFocus({ limit: 1, controlEdit: { type: 'filter', edit: { type: 'toggleToken', value: '@office' } } }));
        expect(filtered.revision).not.toBe(first.revision);
        expect(host.getFocusSectionWindow({ key: 'next', offset: 0, limit: 1, revision: first.revision, controls: filtered.controls.state }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        value(await host.setFocusGroupBy({ requestId: generateUUID(), controls: first.controls.state, groupBy: 'project' }));
        const grouped = value(host.getFocus({ limit: 1 }));
        expect(grouped.revision).not.toBe(first.revision);
        expect(host.getFocusSectionWindow({ key: 'next', offset: 0, limit: 1, revision: first.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getFocusControlsList({ list: 'tokens', offset: 0, limit: 2, revision: first.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(value(host.getFocusControlsList({ list: 'tokens', offset: 2, limit: 2, revision: grouped.revision })).items.map((item) => (item as { value: string }).value))
            .toEqual(['@office', '@phone']);
    });

    it.each(['tokens', 'projects'] as const)('searches %s beyond the first 100 options before counting and paging', async (list) => {
        freezeClock();
        const expanded = structuredClone(fixture);
        for (let index = 0; index < 140; index += 1) {
            const suffix = String(index).padStart(3, '0');
            expanded.projects.push({ ...fixture.projects[0], id: `picker-project-${suffix}`, title: `Picker Project ${suffix}`, status: 'active' });
            expanded.tasks.push({ ...fixture.tasks[0], id: `picker-task-${suffix}`, projectId: `picker-project-${suffix}`, contexts: [`@picker-${suffix}`], tags: [], status: 'next' });
        }
        expanded.tasks[expanded.tasks.length - 1].contexts.push('@café', '@literal*');
        expanded.projects.push({ ...fixture.projects[0], id: 'literal-project', title: 'Café *', status: 'active' });
        expanded.tasks.push({ ...fixture.tasks[0], id: 'literal-task', projectId: 'literal-project', contexts: [], tags: [], status: 'next' });
        const saveData = vi.fn().mockResolvedValue(undefined);
        await seedFocusControlsStore(expanded, scenario(), { saveData });
        const host = createNativeHostContract();
        value(await host.activate({ writeSafetyReady: true }));
        saveData.mockClear();
        focusControlsWrites().length = 0;
        const view = value(host.getFocus({ limit: 1, controls: DEFAULT_FOCUS_CONTROL_STATE }));
        const input = { controls: view.controls.state, list, offset: 0, limit: 100, revision: view.revision };
        const identify = (item: { value?: string; title?: string }) => item.value ?? item.title;
        const unfiltered = value(host.getFocusControlsList(input));
        expect(unfiltered.total).toBeGreaterThan(140);
        expect(unfiltered.items.map(identify)).not.toContain(list === 'tokens' ? '@picker-133' : 'Picker Project 133');

        const query = list === 'tokens' ? '  PICKER-13  ' : '  PICKER PROJECT 13  ';
        const filtered = value(host.getFocusControlsList({ ...input, query, offset: 3, limit: 2 }));
        expect(filtered.total).toBe(10);
        expect(filtered.items.map(identify)).toEqual(list === 'tokens' ? ['@picker-133', '@picker-134'] : ['Picker Project 133', 'Picker Project 134']);
        const first = value(host.getFocusControlsList({ ...input, query, limit: 3 }));
        expect(first.items.map(identify)).toEqual(list === 'tokens' ? ['@picker-130', '@picker-131', '@picker-132'] : ['Picker Project 130', 'Picker Project 131', 'Picker Project 132']);
        expect(filtered.revision).toBe(view.revision);
        expect(filtered.items[0]).toMatchObject(list === 'tokens'
            ? { state: 'none', edit: { type: 'filter', edit: { type: 'toggleToken', value: '@picker-133' } } }
            : { selected: false, edit: { type: 'filter', edit: { type: 'toggleProject', value: 'picker-project-133' } } });
        for (const empty of ['', ' \t\n ']) {
            expect(value(host.getFocusControlsList({ ...input, query: empty }))).toEqual(unfiltered);
        }
        expect(value(host.getFocusControlsList({ ...input, query, offset: 10 })).items).toEqual([]);
        expect(value(host.getFocusControlsList({ ...input, query: '*' })).items.map(identify))
            .toEqual(list === 'tokens' ? ['@literal*'] : ['Café *']);
        expect(value(host.getFocusControlsList({ ...input, query: '  CAFÉ ' })).items.map(identify))
            .toEqual(list === 'tokens' ? ['@café'] : ['Café *']);
        for (const unmatched of ['cafe', 'picker-*', '[a-z]', 'x'.repeat(2000)]) {
            expect(value(host.getFocusControlsList({ ...input, query: unmatched }))).toMatchObject({ total: 0, items: [] });
        }
        if (list === 'projects') {
            expect(value(host.getFocusControlsList({ ...input, query: 'picker-project-133' }))).toMatchObject({ total: 0, items: [] });
        }
        expect(saveData).not.toHaveBeenCalled();
        expect(focusControlsWrites()).toEqual([]);
    });

    it('refuses malformed picker queries and stale control revisions without writing', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const host = await openHost('base', saveData);
        saveData.mockClear();
        const view = value(host.getFocus({ limit: 1, controls: DEFAULT_FOCUS_CONTROL_STATE }));
        const input = { controls: view.controls.state, list: 'tokens' as const, offset: 0, limit: 100, revision: view.revision };
        const invalid = [
            { query: null }, { query: false }, { query: 42 }, { query: [] }, { query: {} }, { query: 'x'.repeat(2001) },
            { list: 'savedFilters', query: '' }, { list: 'savedFilters', query: 'Calls' }, { list: 'unknown', query: '' },
            { query: '@office', offset: -1 }, { query: '@office', limit: 101 },
        ];
        for (const extra of invalid) {
            expect(host.getFocusControlsList({ ...input, ...extra } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(host.getFocusControlsList({ ...input, list: 'savedFilters' })).toMatchObject({ ok: true });
        const changed = value(host.getFocus({ limit: 1, controls: view.controls.state, controlEdit: { type: 'sort', sortBy: 'due' } }));
        expect(changed.revision).not.toBe(view.revision);
        expect(host.getFocusControlsList({ ...input, controls: changed.controls.state, query: '@office' }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getFocusControlsList({ ...input, controls: changed.controls.state, revision: changed.revision, query: '@office' }))
            .toMatchObject({ ok: true, value: { total: 1, items: [{ value: '@office' }] } });
        expect(saveData).not.toHaveBeenCalled();
        expect(focusControlsWrites()).toEqual([]);
    });

    it('roundtrips a saved title sort through Focus reads and filter edits without offering a title sort edit', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const host = await openHost('base', saveData);
        const state = useTaskStore.getState();
        useTaskStore.setState({ settings: {
            ...state.settings,
            savedFilters: state.settings.savedFilters?.map((filter) => filter.id === 'sf-phone'
                ? { ...filter, sortBy: 'title', groupBy: 'context' }
                : filter),
        } });
        saveData.mockClear();
        const before = { tasks: useTaskStore.getState()._allTasks, settings: useTaskStore.getState().settings };
        const first = value(host.getFocus({
            limit: 1, controls: DEFAULT_FOCUS_CONTROL_STATE, controlEdit: { type: 'applySavedFilter', id: 'sf-phone' },
        }));
        expect(first.controls.state).toMatchObject({ savedFilterId: 'sf-phone', sortBy: 'title' });
        expect(first.controls.view.sort.options.map((option) => option.value)).not.toContain('title');
        expect(value(host.getFocus({ limit: 1, controls: first.controls.state }))).toEqual(first);
        const page = value(host.getFocusSectionWindow({ key: 'next', offset: 1, limit: 1, revision: first.revision, controls: first.controls.state }));
        expect(page.rows.map((row) => row.id)).toEqual(['n2']);
        expect(page).toMatchObject({ total: 1, rowTotal: 2, groups: [{ id: 'context:@phone', start: 1 }] });
        expect(value(host.getFocusControlsList({ list: 'tokens', offset: 0, limit: 100, revision: first.revision, controls: first.controls.state, query: 'phone' })))
            .toMatchObject({ total: 1, items: [{ value: '@phone', state: 'included' }] });

        const office = first.controls.filterSheet.tokens.items.find((token) => token.value === '@office')!;
        const changed = value(host.getFocus({ limit: 100, controls: first.controls.state, controlEdit: office.edit }));
        // RN retains the inherited sort when a picker change detaches the saved filter.
        expect(changed.controls.state).toMatchObject({ savedFilterId: null, sortBy: 'title' });
        expect(value(host.getFocus({ limit: 100, controls: changed.controls.state }))).toEqual(changed);
        expect(host.getFocusControlsList({ list: 'projects', offset: 0, limit: 100, revision: changed.revision, controls: changed.controls.state })).toMatchObject({ ok: true });
        const cleared = value(host.getFocus({ limit: 100, controls: changed.controls.state, controlEdit: changed.controls.filterSheet.clear.edit }));
        expect(cleared.controls.state).toEqual(DEFAULT_FOCUS_CONTROL_STATE);
        expect(host.getFocus({ limit: 1, controls: first.controls.state, controlEdit: { type: 'sort', sortBy: 'title' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const sortBy of ['unknown', 1, null, 'completed']) {
            expect(host.getFocus({ limit: 1, controls: { sortBy } } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect({ tasks: useTaskStore.getState()._allTasks, settings: useTaskStore.getState().settings }).toEqual(before);
        expect(saveData).not.toHaveBeenCalled();
        expect(focusControlsWrites()).toEqual([]);
    });

    it('refuses what Focus cannot hold or offer', async () => {
        freezeClock();
        const host = await openHost('prioritiesOff');
        // As the journaling Android host: each write must carry its replay tokens.
        setNativeReplayTokens('required');
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(host.getFocus({ limit: 1, controls: { filters: { searchQuery: 'x' } } })).toMatchObject(invalid);
        expect(host.getFocus({ limit: 1, controls: { sortBy: 'unknown' as never } })).toMatchObject(invalid);
        expect(host.getFocus({ limit: 1, controls: { extra: true } as never })).toMatchObject(invalid);
        expect(host.getFocus({ limit: 1, controlEdit: { type: 'filter', edit: { type: 'setSearch', value: 'x' } } })).toMatchObject(invalid);
        expect(host.getFocus({ limit: 1, controlEdit: { type: 'applySavedFilter', id: 'sf-list' } })).toMatchObject(invalid);
        const input = () => ({ requestId: generateUUID(), controls: DEFAULT_FOCUS_CONTROL_STATE });
        expect(await host.setFocusGroupBy({ ...input(), groupBy: 'priority' })).toMatchObject(invalid);
        expect(await host.saveFocusFilter({ ...input(), name: 'Nothing' })).toMatchObject(invalid);
        expect(await host.removeFocusFilterCriterion({ ...input(), criterionId: 'area:a-work' })).toMatchObject(invalid);
        const taskRevisions = reorderRevisions(host);
        const { f3: _f3, ...twoRevisions } = taskRevisions;
        expect(await host.reorderFocus({ ...input(), ids: ['f2', 'f1'], taskRevisions: twoRevisions })).toMatchObject(invalid);
        expect(await host.reorderFocus({ requestId: generateUUID(), controls: withFilters({ tokens: ['@office'] }), ids: ['f2', 'f1', 'f3'], taskRevisions })).toMatchObject(invalid);
        expect(await host.reorderFocus({ requestId: generateUUID(), controls: { sortBy: 'due' }, ids: ['f2', 'f1', 'f3'], taskRevisions })).toMatchObject(invalid);
        expect(await host.reorderFocus({ ...input(), ids: ['f2', 'f1', 'f3'], taskRevisions, requestId: 'not-a-uuid' })).toMatchObject(invalid);
        // The order carries the revision the reorder screen showed for each task, and for nothing else.
        expect(await host.reorderFocus({ ...input(), ids: ['f3', 'f1', 'f2'] } as never)).toMatchObject(invalid);
        expect(await host.reorderFocus({ ...input(), ids: ['f3', 'f1', 'f2'], taskRevisions: twoRevisions })).toMatchObject(invalid);
        expect(focusControlsWrites()).toEqual([]);
    });

    it('writes nothing again for a target already reached, even after a restart', async () => {
        freezeClock();
        const host = await openHost('base');
        const controls = DEFAULT_FOCUS_CONTROL_STATE;
        const requestId = generateUUID();
        const saved = value(await host.saveFocusFilter({ requestId, controls: withFilters({ tokens: ['@phone'] }), name: 'Calls' }));
        expect(saved.controls.savedFilterId).toBe(requestId.toLowerCase());
        expect(focusControlsWrites()).toHaveLength(1);
        // A new host has no receipts: the filter the request created answers it.
        const restarted = createNativeHostContract();
        expect(await restarted.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        expect(await restarted.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        expect(value(await restarted.saveFocusFilter({ requestId, controls: withFilters({ tokens: ['@phone'] }), name: 'Calls' }))).toEqual({ ...saved, changed: false });
        expect(await restarted.saveFocusFilter({ requestId, controls: withFilters({ tokens: ['@phone'] }), name: 'Other' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(value(await restarted.deleteFocusFilter({ requestId: generateUUID(), controls, id: 'sf-list' }))).toEqual({ controls, changed: false });
        expect(value(await restarted.reorderFocus({ requestId: generateUUID(), controls, ids: ['f2', 'f1', 'f3'], taskRevisions: reorderRevisions(restarted) })))
            .toEqual({ controls, changed: false });
        // A saved filter's grouping differs from the stored one: choosing the stored one detaches it and writes nothing.
        const bound = { ...controls, savedFilterId: 'sf-phone' };
        value(await restarted.setFocusGroupBy({ requestId: generateUUID(), controls, groupBy: 'tag' }));
        expect(value(await restarted.setFocusGroupBy({ requestId: generateUUID(), controls: bound, groupBy: 'tag' })))
            .toMatchObject({ changed: false, controls: { savedFilterId: null } });
        expect(value(await restarted.removeFocusFilterCriterion({ requestId: generateUUID(), controls: bound, criterionId: 'area:a-work' })))
            .toMatchObject({ changed: false });
        expect(focusControlsWrites()).toHaveLength(2);
        expect(focusControlsWrites()[1]).toMatchObject(['updateSettings', { gtd: { focusGroupBy: 'tag' } }]);
    });

    describe('exact retry after a failed save: one write, and the retry finishes the save', () => {
        const retry = async (
            settings: string,
            run: (host: ReturnType<typeof createNativeHostContract>, requestId: string) => Promise<unknown>,
            check: (saved: { settings: { savedFilters?: { id: string; deletedAt?: string; criteria: object }[]; gtd?: { focusGroupBy?: string } }; tasks: { id: string; focusOrder?: number }[] }) => void,
        ) => {
            freezeClock();
            const saveData = vi.fn().mockResolvedValue(undefined);
            const host = await openHost(settings, saveData);
            const requestId = generateUUID();
            saveData.mockRejectedValue(new Error('disk unavailable'));
            expect(await run(host, requestId)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
            expect(focusControlsWrites()).toHaveLength(1);
            saveData.mockResolvedValue(undefined);
            const retried = await run(host, requestId);
            expect(retried).toMatchObject({ ok: true, value: { changed: true } });
            expect(focusControlsWrites()).toHaveLength(1);
            check(saveData.mock.lastCall?.[0]);
            // A lost reply repeats the request: no write, no save.
            const saves = saveData.mock.calls.length;
            expect(await run(host, requestId)).toEqual(retried);
            expect(saveData).toHaveBeenCalledTimes(saves);
            return retried;
        };

        it('setFocusGroupBy', async () => {
            await retry('base', (host, requestId) => host.setFocusGroupBy({ requestId, controls: DEFAULT_FOCUS_CONTROL_STATE, groupBy: 'area' }), (saved) => {
                expect(saved.settings.gtd?.focusGroupBy).toBe('area');
            });
        });

        it('saveFocusFilter', async () => {
            const controls = withFilters({ tokens: ['@phone'] }, { sortBy: 'due' });
            let id = '';
            await retry('base', (host, requestId) => {
                id = requestId.toLowerCase();
                return host.saveFocusFilter({ requestId, controls, name: '  Calls ' });
            }, (saved) => {
                expect(saved.settings.savedFilters?.find((filter) => filter.id === id)).toMatchObject({ name: 'Calls', view: 'focus', criteria: { contexts: ['@phone'] }, sortBy: 'due' });
            });
        });

        it('removeFocusFilterCriterion', async () => {
            await retry('base', (host, requestId) => host.removeFocusFilterCriterion({
                requestId, controls: { savedFilterId: 'sf-work' }, criterionId: 'area:a-work',
            }), (saved) => {
                expect(saved.settings.savedFilters?.find((filter) => filter.id === 'sf-work')?.criteria).not.toHaveProperty('areas');
            });
        });

        it('deleteFocusFilter', async () => {
            const retried = await retry('base', (host, requestId) => host.deleteFocusFilter({
                requestId, controls: { savedFilterId: 'sf-phone' }, id: 'sf-phone',
            }), (saved) => {
                expect(saved.settings.savedFilters?.find((filter) => filter.id === 'sf-phone')?.deletedAt).toBe(fixture.now);
            });
            expect(retried).toMatchObject({ value: { controls: { savedFilterId: null } } });
        });

        it('reorderFocus', async () => {
            // The revisions the screen showed before the first try: the retry is the same request.
            let taskRevisions: Record<string, string> | null = null;
            await retry('base', (host, requestId) => host.reorderFocus({
                requestId, controls: DEFAULT_FOCUS_CONTROL_STATE, ids: ['f3', 'f2', 'f1'], taskRevisions: taskRevisions ??= reorderRevisions(host),
            }), (saved) => {
                expect(Object.fromEntries(saved.tasks.filter((task) => ['f1', 'f2', 'f3'].includes(task.id)).map((task) => [task.id, task.focusOrder])))
                    .toEqual({ f3: 0, f2: 1, f1: 2 });
            });
        });
    });

    describe('a replay after a restart (a new host, no receipts) never undoes a later change', () => {
        const savedFilters = () => useTaskStore.getState().settings.savedFilters ?? [];
        /** Another writer's edit of one saved filter. */
        const editFilter = (id: string, fields: Record<string, unknown>) => useTaskStore.getState().updateSettings({
            savedFilters: savedFilters().map((filter) => (filter.id === id ? { ...filter, ...fields } : filter)),
        });
        const replayUnchanged = async (replay: (host: Host) => Promise<unknown>) => {
            const { result, wrote } = await replayAfterRestart(replay as never);
            expect(result).toMatchObject({ ok: true, value: { changed: false } });
            expect(wrote).toBe(false);
        };

        it('setFocusGroupBy: target state keeps a later edit of the other Focus settings', async () => {
            freezeClock();
            const host = await openHost('base');
            const input = { requestId: generateUUID(), controls: DEFAULT_FOCUS_CONTROL_STATE, groupBy: 'area' as const };
            value(await host.setFocusGroupBy(input));
            await useTaskStore.getState().updateSettings({ gtd: { ...useTaskStore.getState().settings.gtd, autoArchiveDays: 3 } });
            await replayUnchanged((restarted) => restarted.setFocusGroupBy(input));
            expect(useTaskStore.getState().settings.gtd).toMatchObject({ focusGroupBy: 'area', autoArchiveDays: 3 });
        });

        it('saveFocusFilter: the filter named by the request UUID answers, and keeps a later edit', async () => {
            freezeClock();
            const host = await openHost('base');
            const input = { requestId: generateUUID(), controls: withFilters({ tokens: ['@phone'] }), name: 'Calls' };
            value(await host.saveFocusFilter(input));
            await editFilter(input.requestId.toLowerCase(), { sortOrder: 'desc' });
            await replayUnchanged((restarted) => restarted.saveFocusFilter(input));
            expect(savedFilters().filter((filter) => filter.name === 'Calls')).toMatchObject([{ id: input.requestId.toLowerCase(), sortOrder: 'desc' }]);
        });

        it('removeFocusFilterCriterion: target state keeps a later edit of the filter', async () => {
            freezeClock();
            const host = await openHost('base');
            const input = { requestId: generateUUID(), controls: { savedFilterId: 'sf-work' }, criterionId: 'area:a-work' };
            expect(value(await host.removeFocusFilterCriterion(input))).toMatchObject({ changed: true });
            await editFilter('sf-work', { name: 'Work' });
            await replayUnchanged((restarted) => restarted.removeFocusFilterCriterion(input));
            expect(savedFilters().find((filter) => filter.id === 'sf-work')).toMatchObject({ name: 'Work' });
        });

        it('deleteFocusFilter: target state keeps a later edit of the other filters', async () => {
            freezeClock();
            const host = await openHost('base');
            const input = { requestId: generateUUID(), controls: DEFAULT_FOCUS_CONTROL_STATE, id: 'sf-phone' };
            expect(value(await host.deleteFocusFilter(input))).toMatchObject({ changed: true });
            await editFilter('sf-work', { name: 'Work' });
            const before = structuredClone(savedFilters());
            await replayUnchanged((restarted) => restarted.deleteFocusFilter(input));
            expect(savedFilters()).toEqual(before);
        });

        it('reorderFocus: STALE once a task it orders changed since', async () => {
            freezeClock();
            const host = await openHost('base');
            const input = { requestId: generateUUID(), controls: DEFAULT_FOCUS_CONTROL_STATE, ids: ['f3', 'f2', 'f1'], taskRevisions: reorderRevisions(host) };
            expect(value(await host.reorderFocus(input))).toMatchObject({ changed: true });
            // The user puts the old order back.
            await useTaskStore.getState().reorderFocusedTasks(['f2', 'f1', 'f3']);
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.reorderFocus(input));
            expect(result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(wrote).toBe(false);
            const order = ['f1', 'f2', 'f3'].map((id) => useTaskStore.getState()._tasksById.get(id)!.focusOrder);
            expect(order).toEqual([1, 0, 2]);
        });
    });

    it('is NOT_READY until storage is activated', async () => {
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        const notReady = { ok: false, error: { code: 'NOT_READY' } };
        const input = { requestId: generateUUID(), controls: DEFAULT_FOCUS_CONTROL_STATE };
        expect(host.getFocus({ limit: 10, controls: DEFAULT_FOCUS_CONTROL_STATE })).toMatchObject(notReady);
        expect(host.getFocusSectionWindow({ key: 'next', offset: 0, limit: 1, revision: 'r', controls: DEFAULT_FOCUS_CONTROL_STATE })).toMatchObject(notReady);
        expect(host.getFocusControlsList({ list: 'tokens', offset: 0, limit: 1, revision: 'r' })).toMatchObject(notReady);
        expect(await host.setFocusGroupBy({ ...input, groupBy: 'context' })).toMatchObject(notReady);
        expect(await host.saveFocusFilter({ ...input, name: 'x' })).toMatchObject(notReady);
        expect(await host.removeFocusFilterCriterion({ ...input, criterionId: 'area:a' })).toMatchObject(notReady);
        expect(await host.deleteFocusFilter({ ...input, id: 'sf-phone' })).toMatchObject(notReady);
        expect(await host.reorderFocus({ ...input, ids: ['f1'], taskRevisions: { f1: 'r' } })).toMatchObject(notReady);
    });
});
