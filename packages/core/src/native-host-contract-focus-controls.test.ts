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
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import { generateUUID } from './uuid';

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

    it('refuses what Focus cannot hold or offer', async () => {
        freezeClock();
        const host = await openHost('prioritiesOff');
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(host.getFocus({ limit: 1, controls: { filters: { searchQuery: 'x' } } })).toMatchObject(invalid);
        expect(host.getFocus({ limit: 1, controls: { sortBy: 'title' as never } })).toMatchObject(invalid);
        expect(host.getFocus({ limit: 1, controls: { extra: true } as never })).toMatchObject(invalid);
        expect(host.getFocus({ limit: 1, controlEdit: { type: 'filter', edit: { type: 'setSearch', value: 'x' } } })).toMatchObject(invalid);
        expect(host.getFocus({ limit: 1, controlEdit: { type: 'applySavedFilter', id: 'sf-list' } })).toMatchObject(invalid);
        const input = () => ({ requestId: generateUUID(), controls: DEFAULT_FOCUS_CONTROL_STATE });
        expect(await host.setFocusGroupBy({ ...input(), groupBy: 'priority' })).toMatchObject(invalid);
        expect(await host.saveFocusFilter({ ...input(), name: 'Nothing' })).toMatchObject(invalid);
        expect(await host.removeFocusFilterCriterion({ ...input(), criterionId: 'area:a-work' })).toMatchObject(invalid);
        expect(await host.reorderFocus({ ...input(), ids: ['f2', 'f1'] })).toMatchObject(invalid);
        expect(await host.reorderFocus({ requestId: generateUUID(), controls: withFilters({ tokens: ['@office'] }), ids: ['f2', 'f1', 'f3'] })).toMatchObject(invalid);
        expect(await host.reorderFocus({ requestId: generateUUID(), controls: { sortBy: 'due' }, ids: ['f2', 'f1', 'f3'] })).toMatchObject(invalid);
        expect(await host.reorderFocus({ ...input(), ids: ['f2', 'f1', 'f3'], requestId: 'not-a-uuid' })).toMatchObject(invalid);
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
        expect(value(await restarted.reorderFocus({ requestId: generateUUID(), controls, ids: ['f2', 'f1', 'f3'] }))).toEqual({ controls, changed: false });
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
            await retry('base', (host, requestId) => host.reorderFocus({ requestId, controls: DEFAULT_FOCUS_CONTROL_STATE, ids: ['f3', 'f2', 'f1'] }), (saved) => {
                expect(Object.fromEntries(saved.tasks.filter((task) => ['f1', 'f2', 'f3'].includes(task.id)).map((task) => [task.id, task.focusOrder])))
                    .toEqual({ f3: 0, f2: 1, f1: 2 });
            });
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
        expect(await host.reorderFocus({ ...input, ids: ['f1'] })).toMatchObject(notReady);
    });
});
