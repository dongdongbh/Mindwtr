import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { focusControlsWrites, loadFocusControlsFixture, seedFocusControlsStore } from './focus-controls.replay';
import { loadTranslations } from './i18n/i18n-loader';
import { createWriteRecorder, loadMenuViewsFixture, seedMenuViewsStore } from './menu-views-model.replay';
import { createNativeHostContract } from './native-host-contract';
import { getGtdSyncSnapshot } from './settings-options';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import type { TaskSortBy } from './types';
import { generateUUID } from './uuid';

const fixture = loadFocusControlsFixture();
const base = fixture.scenarios.find((entry) => entry.settings === 'base' && !entry.taskIds)!;
type Host = ReturnType<typeof createNativeHostContract>;
type Request = Parameters<Host['setTaskListSortChecked']>[0];
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

describe('native checked task list sort', () => {
    let english: Record<string, string>;
    beforeAll(async () => { english = await loadTranslations('en'); });
    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    const open = async (saveData?: (data: unknown) => Promise<void>) => {
        await seedFocusControlsStore(fixture, base, { saveData });
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        focusControlsWrites().length = 0;
        return host;
    };
    const request = (host: Host, sortBy: TaskSortBy): Request => ({
        requestId: generateUUID(), sortBy, expected: value(host.getTaskListSortOptions({})).expected,
    });
    const raw = (sortBy: unknown) => useTaskStore.setState((state) => {
        const settings = { ...state.settings };
        if (sortBy === undefined) delete settings.taskSortBy;
        else settings.taskSortBy = sortBy as TaskSortBy;
        return { settings };
    });

    it('offers the shared RN roster, translated labels, and effective selection', async () => {
        const host = await open();
        const options = value(host.getTaskListSortOptions({}));
        expect(options.expected).toEqual({ sortBy: null });
        expect(options.choices.map((choice) => choice.value)).toEqual(TASK_LIST_SORT_OPTIONS);
        expect(options.choices.find((choice) => choice.value === 'default')).toMatchObject({
            label: english['sort.default'], selected: true,
        });
        raw('completed');
        expect(value(host.getTaskListSortOptions({})).expected).toEqual({ sortBy: 'completed' });
        expect(value(host.getTaskListSortOptions({})).choices.find((choice) => choice.selected)?.value).toBe('default');
        raw('legacy');
        expect(value(host.getTaskListSortOptions({})).expected).toEqual({ sortBy: 'legacy' });
        raw('timeEstimate');
        useTaskStore.setState((state) => ({ settings: { ...state.settings, features: { ...state.settings.features, timeEstimates: false } } }));
        expect(value(host.getTaskListSortOptions({})).choices.map((choice) => choice.value)).not.toContain('timeEstimate');
        expect(value(host.getTaskListSortOptions({})).choices.find((choice) => choice.selected)?.value).toBe('default');
        raw(null);
        expect(host.getTaskListSortOptions({})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        raw(4);
        expect(host.getTaskListSortOptions({})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getTaskListSortOptions({ extra: true } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('writes only the chosen scalar, including explicit default over missing and completed', async () => {
        const host = await open();
        const before = useTaskStore.getState();
        const data = structuredClone({ tasks: before._allTasks, projects: before._allProjects, sections: before._allSections,
            areas: before._allAreas, people: before._allPeople, settings: before.settings });
        const first = request(host, 'default');
        expect(value(await host.setTaskListSortChecked(first))).toEqual({ sortBy: 'default' });
        expect(focusControlsWrites()).toEqual([['updateSettings', { taskSortBy: 'default' }]]);
        const after = useTaskStore.getState();
        const { settings: initialSettings, ...unchangedData } = data;
        expect({ tasks: after._allTasks, projects: after._allProjects, sections: after._allSections,
            areas: after._allAreas, people: after._allPeople }).toEqual(unchangedData);
        expect({ ...after.settings, taskSortBy: undefined }).toEqual({ ...initialSettings, taskSortBy: undefined });
        expect(getGtdSyncSnapshot(after.settings)).toEqual(getGtdSyncSnapshot(initialSettings));
        expect(after.settings.syncPreferencesUpdatedAt).toEqual(initialSettings.syncPreferencesUpdatedAt);
        expect(value(await host.setTaskListSortChecked({ ...first, requestId: generateUUID() }))).toEqual({ sortBy: 'default' });
        expect(focusControlsWrites()).toHaveLength(1);
        raw('completed');
        expect(value(await host.setTaskListSortChecked(request(host, 'default')))).toEqual({ sortBy: 'default' });
        expect(focusControlsWrites()).toHaveLength(2);
    });

    it('applies a saved global sort to the actual Reference list', async () => {
        const menuFixture = loadMenuViewsFixture();
        const recorder = createWriteRecorder();
        await seedMenuViewsStore(menuFixture,
            { name: 'reference', screen: 'reference', settings: 'base', actions: [] }, recorder);
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const rows = () => value(host.getReferenceView({ groupBy: 'none', offset: 0, limit: 100 }))
            .items.flatMap((item) => item.type === 'task' ? [item.row.id] : []);
        expect(rows()).toEqual(['r-a', 'r-b', 'r-d', 'r-e']);
        expect(value(await host.setTaskListSortChecked(request(host, 'title')))).toEqual({ sortBy: 'title' });
        expect(rows()).toEqual(['r-e', 'r-d', 'r-b', 'r-a']);
    });

    it('validates a bounded exact request before activation', async () => {
        const host = createNativeHostContract();
        const input: Request = { requestId: generateUUID(), sortBy: 'due', expected: { sortBy: null } };
        expect(host.validateTaskListSortWrite(input)).toEqual({ ok: true, value: { sortBy: 'due' } });
        for (const bad of [
            { ...input, extra: true }, { ...input, requestId: input.requestId.toUpperCase() },
            { ...input, requestId: 'bad' }, { ...input, sortBy: 'completed' },
            { ...input, expected: { sortBy: null, extra: true } },
            { ...input, expected: { sortBy: 1 } }, { ...input, expected: { sortBy: 'x'.repeat(501) } },
            { ...input, expected: { sortBy: '😃'.repeat(1020) } },
        ]) expect(host.validateTaskListSortWrite(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.setTaskListSortChecked(input)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    });

    it('recognizes the raw target before feature gating and refuses stale or unknown outcomes', async () => {
        const host = await open();
        const target = request(host, 'timeEstimate');
        raw('timeEstimate');
        useTaskStore.setState((state) => ({ settings: { ...state.settings, features: { ...state.settings.features, timeEstimates: false } } }));
        expect(host.probeTaskListSortOutcome(target)).toEqual({ ok: true, value: { sortBy: 'timeEstimate' } });
        expect(value(await host.setTaskListSortChecked(target))).toEqual({ sortBy: 'timeEstimate' });
        expect(focusControlsWrites()).toEqual([]);
        raw('due');
        expect(host.probeTaskListSortOutcome(target)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await host.setTaskListSortChecked({ ...target, requestId: generateUUID() }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const unavailable = request(host, 'timeEstimate');
        expect(await host.setTaskListSortChecked(unavailable)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(focusControlsWrites()).toEqual([]);
    });

    it('retries failed saves once and recognizes exact replay after recreation', async () => {
        let failSave = false;
        const host = await open(async () => { if (failSave) throw new Error('disk unavailable'); });
        const input = request(host, 'title');
        failSave = true;
        const [first, duplicate] = await Promise.all([host.setTaskListSortChecked(input), host.setTaskListSortChecked(input)]);
        expect(first).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(duplicate).toEqual(first);
        expect(focusControlsWrites()).toHaveLength(1);
        expect(await host.setTaskListSortChecked({ ...input, sortBy: 'due' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        failSave = false;
        expect(value(await host.setTaskListSortChecked(input))).toEqual({ sortBy: 'title' });
        expect(focusControlsWrites()).toHaveLength(1);
        const current = useTaskStore.getState();
        await current.updateSettings({ quickAddAutoClean: true });
        await flushPendingSave();
        const restarted = createNativeHostContract();
        expect(await restarted.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        expect(await restarted.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        focusControlsWrites().length = 0;
        expect(restarted.probeTaskListSortOutcome(input)).toEqual({ ok: true, value: { sortBy: 'title' } });
        expect(value(await restarted.setTaskListSortChecked(input))).toEqual({ sortBy: 'title' });
        expect(useTaskStore.getState().settings.quickAddAutoClean).toBe(true);
        expect(focusControlsWrites()).toEqual([]);
    });
});
