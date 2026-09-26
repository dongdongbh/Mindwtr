import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    applyFocusControlEdit,
    canReorderFocusTasks,
    DEFAULT_FOCUS_CONTROL_STATE,
    getFocusFilterTokens,
    getFocusGroupByOptions,
    getFocusReorderPositionLabel,
    getFocusSortOptions,
    moveFocusReorderTask,
    planFocusFilterDelete,
    planFocusGroupChange,
    reconcileFocusReorderOrder,
    resolveFocusFilterState,
} from './focus-controls';
import {
    createCoreFocusDriver,
    loadFocusControlsFixture,
    seedFocusControlsStore,
} from './focus-controls.replay';
import { loadTranslations } from './i18n/i18n-loader';
import { EMPTY_LIST_FILTER_STATE } from './list-filter-state';
import { flushPendingSave, resetForTests } from './store';
import type { SavedFilter } from './types';

const fixture = loadFocusControlsFixture();


describe('Focus controls', () => {
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
    });

    it.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))(
        'replays the frozen React Native scenario through core: %s',
        async (_name, scenario) => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date(fixture.now));
            await seedFocusControlsStore(fixture, scenario);
            const driver = createCoreFocusDriver(t, () => new Date());
            const observed = [driver.observe()];
            for (const action of scenario.actions) {
                await driver.perform(action);
                observed.push(driver.observe());
            }
            expect(observed).toEqual(fixture.observations[scenario.name]);
        },
    );

    it('offers the context and tag chips of the tasks Focus can show, sorted and unique', () => {
        expect(getFocusFilterTokens([
            { contexts: ['@work', '@home', ''], tags: ['#deep'] },
            { contexts: ['@work/calls', '@home'], tags: ['#deep', '#ops'] },
            { contexts: [], tags: [] },
        ] as never)).toEqual(['@home', '@work', '@work/calls', '#deep', '#ops']);
    });

    it('offers and honours priority sort and grouping only while Priorities is on', () => {
        expect(getFocusSortOptions(true)).toContain('priority');
        expect(getFocusSortOptions(false)).not.toContain('priority');
        expect(getFocusGroupByOptions(true)).toContain('priority');
        expect(getFocusGroupByOptions(false)).not.toContain('priority');
    });

    it('detaches a saved filter on any picker change, a sort or a grouping, and clears the sort with Clear', () => {
        const saved: SavedFilter = { id: 's', name: 'S', view: 'focus', criteria: { contexts: ['@a'] }, sortBy: 'due', createdAt: 'x', updatedAt: 'x' };
        const applied = applyFocusControlEdit({ state: DEFAULT_FOCUS_CONTROL_STATE, activeSavedFilter: null, effectiveSortBy: 'default' }, { type: 'applySavedFilter', id: 's' }, [saved])!;
        expect(applied).toEqual({ filters: { ...EMPTY_LIST_FILTER_STATE, tokens: ['@a'] }, savedFilterId: 's', sortBy: 'due' });
        const resolved = { state: applied, activeSavedFilter: saved, effectiveSortBy: 'due' as const };
        expect(applyFocusControlEdit(resolved, { type: 'filter', edit: { type: 'toggleToken', value: '@b' } }, [saved])?.savedFilterId).toBeNull();
        // The same sort as the saved filter's still detaches it.
        expect(applyFocusControlEdit(resolved, { type: 'sort', sortBy: 'due' }, [saved])).toEqual({ ...applied, savedFilterId: null });
        expect(applyFocusControlEdit({ ...resolved, activeSavedFilter: null, state: { ...applied, savedFilterId: null } }, { type: 'sort', sortBy: 'due' }, [saved]))
            .toEqual({ ...applied, savedFilterId: null });
        expect(applyFocusControlEdit(resolved, { type: 'filter', edit: { type: 'clear' } }, [saved])).toEqual(DEFAULT_FOCUS_CONTROL_STATE);
        expect(applyFocusControlEdit(resolved, { type: 'applySavedFilter', id: 'gone' }, [saved])).toBeNull();
        expect(planFocusGroupChange('context', { effectiveGroupBy: 'context', hasActiveSavedFilter: false, settings: {} })).toBeNull();
        expect(planFocusGroupChange('context', { effectiveGroupBy: 'context', hasActiveSavedFilter: true, settings: { gtd: { focusTaskLimit: 5 } } }))
            .toEqual({ settingsUpdate: { gtd: { focusTaskLimit: 5, focusGroupBy: 'context' } } });
    });

    it('filters from an applied saved filter\'s own criteria and hides its location chip', () => {
        const saved: SavedFilter = { id: 's', name: 'S', view: 'focus', criteria: { locations: ['Office'], areas: ['a'] }, createdAt: 'x', updatedAt: 'x' };
        const visibility = { energyLevel: true, location: true, priority: false, timeEstimate: true };
        const options = { savedFilters: [saved], visibility, retainTokens: [], retainProjects: [], getProjectLabel: () => undefined, t };
        const bound = resolveFocusFilterState({ ...DEFAULT_FOCUS_CONTROL_STATE, filters: { ...EMPTY_LIST_FILTER_STATE, location: 'Office' }, savedFilterId: 's' }, options);
        expect(bound.criteria).toMatchObject({ locations: ['Office'], areas: ['a'], priority: undefined });
        expect(bound.chips).toEqual([]);
        expect(bound.canSave).toBe(false);
        const detached = resolveFocusFilterState({ ...bound.state, savedFilterId: 'deleted' }, options);
        expect(detached.state.savedFilterId).toBeNull();
        expect(detached.chips.map((chip) => chip.id)).toEqual(['location']);
        expect(detached.canSave).toBe(true);
    });

    it('speaks a reorder row\'s title literally, even with $ replacement patterns', () => {
        expect(getFocusReorderPositionLabel((key) => key, 'Pay $& and $$ {{count}}', 0, 3))
            .toBe('Pay $& and $$ {{count}}. Position 1 of 3');
    });

    it('marks a deleted saved filter instead of dropping it', () => {
        const filters: SavedFilter[] = [{ id: 's', name: 'S', view: 'focus', criteria: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }];
        expect(planFocusFilterDelete(filters, 's', '2026-02-01T00:00:00.000Z').savedFilters)
            .toEqual([{ ...filters[0], updatedAt: '2026-02-01T00:00:00.000Z', deletedAt: '2026-02-01T00:00:00.000Z' }]);
    });

    it('allows reorder only on the default sort without a filter, and keeps a dragged order against the live list', () => {
        expect(canReorderFocusTasks({ effectiveSortBy: 'default', hasActiveFilters: false, focusedCount: 2 })).toBe(true);
        expect(canReorderFocusTasks({ effectiveSortBy: 'due', hasActiveFilters: false, focusedCount: 2 })).toBe(false);
        expect(canReorderFocusTasks({ effectiveSortBy: 'default', hasActiveFilters: true, focusedCount: 2 })).toBe(false);
        expect(canReorderFocusTasks({ effectiveSortBy: 'default', hasActiveFilters: false, focusedCount: 0 })).toBe(false);
        const [a, b, c] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        expect(reconcileFocusReorderOrder([c, a, { id: 'gone' }], [a, b, c]).map(({ id }) => id)).toEqual(['c', 'a', 'b']);
        expect(moveFocusReorderTask([a, b, c], 'b', -1)?.map(({ id }) => id)).toEqual(['b', 'a', 'c']);
        expect(moveFocusReorderTask([a, b, c], 'a', -1)).toBeNull();
        expect(moveFocusReorderTask([a, b, c], 'c', 1)).toBeNull();
    });
});
