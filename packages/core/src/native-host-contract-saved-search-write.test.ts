import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSavedSearchWriteMethods } from './native-host-contract-saved-search-write';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { mergeSettingsForSync } from './sync-merge-settings';
import type { PreparedSavedSearchWrite, SavedSearchWriteOperation, SavedSearchWriteRequest } from './store-types';
import type { AppData, AppSettings, SavedSearch } from './types';

const now = '2026-10-01T12:00:00.000Z';
const uuid = 'e2f841a9-fbee-4d80-84d0-c4de923a12bc';
const otherUUID = 'e2f841a9-fbee-4d80-84d0-c4de923a12bd';
const row = { id: 'older', name: 'Café 🧭', query: '@home', future: { text: '保持 🌿' } } as SavedSearch;
const data = (settings: AppSettings): AppData => ({ tasks: [], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'device', ...settings } });

function harness(settings: AppSettings = {}) {
    let disk = data(settings);
    let saves = 0;
    let failSave = false;
    const open = async () => {
        await flushPendingSave().catch(() => undefined);
        resetForTests();
        setStorageAdapter({ getData: async () => structuredClone(disk), saveData: async (next) => {
            if (failSave) throw new Error('disk unavailable');
            disk = structuredClone(next); saves++;
        } });
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0,
            lastDataChangeAt: 0 } as never);
        await useTaskStore.getState().fetchData({ throwOnError: true });
        expect(useTaskStore.getState().settings.savedSearches).toEqual(disk.settings.savedSearches);
        const methods = createSavedSearchWriteMethods({ readiness: () => ({ ok: true, value: null }),
            save: async () => {
                try { await flushPendingSave(); return { ok: true as const, value: null }; }
                catch { return { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'Save failed' } }; }
            } });
        const request = (operation: SavedSearchWriteOperation, name: string | null = null,
            requestId = uuid): SavedSearchWriteRequest => {
            const options = methods.getSavedSearchWriteOptions({ operation });
            if (!options.ok) throw new Error(options.error.code);
            return { requestId, operation, name, expected: options.value.expected };
        };
        const prepare = (input: SavedSearchWriteRequest) => {
            const result = methods.prepareSavedSearchWrite(input);
            if (!result.ok) throw new Error(result.error.code);
            return result.value;
        };
        const prepared = (input: SavedSearchWriteRequest): PreparedSavedSearchWrite => {
            const result = prepare(input);
            if (result.kind !== 'prepared') throw new Error('Expected prepared write');
            return result.prepared;
        };
        return { methods, request, prepare, prepared };
    };
    return { open, disk: () => disk, saves: () => saves, setFailSave: (value: boolean) => { failSave = value; } };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now)); });
afterEach(async () => { vi.useRealTimers(); await flushPendingSave().catch(() => undefined); resetForTests(); });

describe('prepared saved-search writes', () => {
    it('sorts only the selected search, persists through reload, replays, and clears to global', async () => {
        const sibling = { id: 'sibling', name: 'Other', query: '#work', sort: 'dueDate' };
        const host = harness({ savedSearches: [row, sibling], taskSortBy: 'title' });
        let view = await host.open();
        const options = view.methods.getSavedSearchSortOptions({ id: row.id });
        expect(options.ok && options.value.choices.find((choice) => choice.selected)?.value).toBe(null);
        const request = view.request({ type: 'sort', id: row.id, sort: 'priority' });
        const prepared = view.prepared(request);
        expect(await view.methods.commitPreparedSavedSearchWrite({ request, prepared })).toEqual({ ok: true,
            value: { id: row.id, existing: true, changed: true } });
        expect(host.disk().settings.savedSearches).toEqual([{ ...row, sort: 'priority' }, sibling]);
        expect(host.disk().settings.taskSortBy).toBe('title');
        const writes = host.saves();
        view = await host.open();
        expect(await view.methods.commitPreparedSavedSearchWrite({ request, prepared })).toEqual({ ok: true, value: prepared.result });
        expect(host.saves()).toBe(writes);
        const clear = view.request({ type: 'sort', id: row.id, sort: null }, null, otherUUID);
        const cleared = view.prepared(clear);
        expect(await view.methods.commitPreparedSavedSearchWrite({ request: clear, prepared: cleared })).toEqual({ ok: true, value: cleared.result });
        expect(host.disk().settings.savedSearches).toEqual([row, sibling]);
    });

    it('refuses stale sort collections, missing searches and unavailable choices', async () => {
        const host = harness({ savedSearches: [row], features: { priorities: false } });
        const view = await host.open();
        const options = view.methods.getSavedSearchSortOptions({ id: row.id });
        expect(options.ok && options.value.choices.some((choice) => choice.value === 'priority')).toBe(false);
        const hidden = view.request({ type: 'sort', id: row.id, sort: 'priority' });
        expect(view.methods.prepareSavedSearchWrite(hidden)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const stale = view.request({ type: 'sort', id: row.id, sort: 'title' });
        await useTaskStore.getState().updateSettings({ savedSearches: [{ ...row, name: 'Changed' }] });
        expect(view.methods.prepareSavedSearchWrite(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(view.methods.getSavedSearchSortOptions({ id: 'missing' })).toMatchObject({ ok: false });
        expect(view.methods.prepareSavedSearchWrite(view.request({ type: 'sort', id: 'missing', sort: 'title' })))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('saves the RN plan under the request UUID, preserves raw siblings and replays after reload without writing', async () => {
        const host = harness({ savedSearches: [row], savedSearchesUpdatedAt: now, theme: 'light' });
        let view = await host.open();
        const request = view.request({ type: 'save', query: '  #mañana  ' }, '  森 🌿  ');
        const prepared = view.prepared(request);
        expect(prepared.before.savedSearches).toEqual([row]);
        expect(prepared.after.savedSearches).toEqual([row, { id: uuid, name: '森 🌿', query: '#mañana' }]);
        expect(Date.parse(prepared.after.stamp!)).toBeGreaterThan(Date.parse(now));
        expect(view.methods.validatePreparedSavedSearchWrite({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(await view.methods.commitPreparedSavedSearchWrite({ request, prepared }))
            .toEqual({ ok: true, value: { id: uuid, existing: false, changed: true } });
        expect(host.disk().settings.savedSearches).toEqual(prepared.after.savedSearches);
        expect(host.disk().settings.savedSearchesUpdatedAt).toBe(prepared.after.stamp);
        expect(host.disk().settings.theme).toBe('light');
        const saved = host.saves();
        view = await host.open();
        expect(await view.methods.commitPreparedSavedSearchWrite({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(host.saves()).toBe(saved);
        expect(view.methods.probeSavedSearchWriteOutcome(request))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('returns exact-query duplicate and missing-delete noops after the expected-scope check', async () => {
        const host = harness({ savedSearches: [row] });
        const view = await host.open();
        const duplicate = view.request({ type: 'save', query: ' @home ' }, 'Different', otherUUID);
        expect(view.prepare(duplicate)).toEqual({ kind: 'noop',
            result: { id: 'older', existing: true, changed: false } });
        const missing = view.request({ type: 'delete', id: 'missing' });
        expect(view.prepare(missing)).toEqual({ kind: 'noop',
            result: { id: 'missing', existing: false, changed: false } });
        expect(host.saves()).toBe(0);
        await useTaskStore.getState().updateSettings({ theme: 'dark' });
        expect(view.methods.prepareSavedSearchWrite(missing))
            .toMatchObject({ ok: true, value: { kind: 'noop' } });
        await useTaskStore.getState().updateSettings({ savedSearches: [row] });
        expect(view.methods.prepareSavedSearchWrite(missing))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('deletes by exact ID and refuses resurrection or equal-list ABA after later stamps', async () => {
        const host = harness({ savedSearches: [] });
        let view = await host.open();
        const save = view.request({ type: 'save', query: 'work' }, 'Work');
        const created = view.prepared(save);
        expect(await view.methods.commitPreparedSavedSearchWrite({ request: save, prepared: created })).toEqual({
            ok: true, value: created.result,
        });
        const deletion = view.request({ type: 'delete', id: uuid });
        const deleted = view.prepared(deletion);
        expect(await view.methods.commitPreparedSavedSearchWrite({ request: deletion, prepared: deleted })).toEqual({
            ok: true, value: deleted.result,
        });
        expect(host.disk().settings.savedSearches).toEqual([]);
        expect(Date.parse(deleted.after.stamp!)).toBeGreaterThan(Date.parse(created.after.stamp!));
        view = await host.open();
        expect(await view.methods.commitPreparedSavedSearchWrite({ request: save, prepared: created }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await view.methods.commitPreparedSavedSearchWrite({ request: deletion, prepared: deleted }))
            .toEqual({ ok: true, value: deleted.result });
        await useTaskStore.getState().updateSettings({ savedSearches: [] });
        await flushPendingSave();
        view = await host.open();
        expect(await view.methods.commitPreparedSavedSearchWrite({ request: deletion, prepared: deleted }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.disk().settings.savedSearches).toEqual([]);
    });

    it('rejects later rename, delete and recreate while preserving unrelated settings changes', async () => {
        const host = harness({ savedSearches: [row], theme: 'light' });
        const view = await host.open();
        const request = view.request({ type: 'delete', id: 'older' });
        const prepared = view.prepared(request);
        await useTaskStore.getState().updateSettings({ theme: 'dark' });
        expect(await view.methods.commitPreparedSavedSearchWrite({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(host.disk().settings.theme).toBe('dark');
        expect(host.disk().settings.savedSearches).toEqual([]);
        await useTaskStore.getState().updateSettings({ savedSearches: [{ ...row, name: 'Renamed' }] });
        expect(await view.methods.commitPreparedSavedSearchWrite({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        await useTaskStore.getState().updateSettings({ savedSearches: [row] });
        expect(await view.methods.commitPreparedSavedSearchWrite({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('distinguishes absent and empty lists and keeps the device-local list and stamp through sync merge', async () => {
        const absent = harness();
        const absentView = await absent.open();
        const operation = { type: 'save' as const, query: 'work' };
        const absentRequest = absentView.request(operation, 'Work');
        expect(absentView.prepared(absentRequest).before)
            .toMatchObject({ savedSearchesPresent: false, savedSearches: null, stampPresent: false, stamp: null });
        const empty = harness({ savedSearches: [] });
        const emptyView = await empty.open();
        const emptyRequest = emptyView.request(operation, 'Work');
        expect(emptyRequest.expected).not.toBe(absentRequest.expected);
        expect(emptyView.prepared(emptyRequest).before)
            .toMatchObject({ savedSearchesPresent: true, savedSearches: [], stampPresent: false, stamp: null });
        const local = { deviceId: 'local', savedSearches: [row], savedSearchesUpdatedAt: now };
        const incoming = { deviceId: 'peer', savedSearches: [], savedSearchesUpdatedAt: '2099-01-01T00:00:00.000Z' };
        expect(mergeSettingsForSync(local, incoming)).toMatchObject(local);
    });

    it('rejects malformed scopes, forged journals, extra keys and request-ID collisions', async () => {
        const host = harness({ savedSearches: [row] });
        const view = await host.open();
        const request = view.request({ type: 'save', query: 'other' }, 'Other');
        const prepared = view.prepared(request);
        const invalid = (change: (copy: { request: SavedSearchWriteRequest;
            prepared: PreparedSavedSearchWrite }) => void) => {
            const copy = structuredClone({ request, prepared });
            change(copy);
            expect(view.methods.validatePreparedSavedSearchWrite(copy))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        };
        invalid((copy) => { copy.prepared.result.id = 'forged'; });
        invalid((copy) => { copy.prepared.after.savedSearches![0].name = 'forged'; });
        invalid((copy) => { copy.prepared.after.stamp = copy.prepared.before.stamp; });
        invalid((copy) => { copy.prepared.before.stampPresent = true; });
        invalid((copy) => { copy.request.operation = { type: 'delete', id: 'older' }; });
        invalid((copy) => { (copy.prepared as PreparedSavedSearchWrite & { extra: number }).extra = 1; });
        invalid((copy) => { (copy.prepared.after.savedSearches![0] as SavedSearch & { huge: string }).huge = 'é'.repeat(1_000_000); });
        expect(view.methods.prepareSavedSearchWrite({ ...request, requestId: uuid.toUpperCase() }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(view.methods.getSavedSearchWriteOptions({ operation: { type: 'save', query: '' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(view.methods.getSavedSearchWriteOptions({ operation: { type: 'save', query: 'valid' }, extra: 1 } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        useTaskStore.setState((state) => ({ settings: { ...state.settings, savedSearchesUpdatedAt: 'invalid' } }));
        expect(view.methods.getSavedSearchWriteOptions({ operation: { type: 'delete', id: 'older' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        useTaskStore.setState((state) => ({ settings: { ...state.settings,
            savedSearchesUpdatedAt: undefined, savedSearches: [{ id: 'x', name: 'x', query: '' }] } }));
        expect(view.methods.getSavedSearchWriteOptions({ operation: { type: 'delete', id: 'x' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.saves()).toBe(0);
        const collision = harness({ savedSearches: [{ id: uuid, name: 'Prior', query: 'prior' }] });
        const collisionView = await collision.open();
        const collisionRequest = collisionView.request({ type: 'save', query: 'new' }, 'New');
        expect(collisionView.methods.prepareSavedSearchWrite(collisionRequest))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const longID = 'x'.repeat(201);
        const legacy = harness({ savedSearches: [{ id: longID, name: 'Legacy', query: 'legacy' }] });
        const legacyView = await legacy.open();
        expect(legacyView.methods.getSavedSearchWriteOptions({ operation: { type: 'delete', id: longID } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const duplicate = legacyView.request({ type: 'save', query: 'legacy' }, 'Other', otherUUID);
        expect(legacyView.methods.prepareSavedSearchWrite(duplicate))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('retries a failed save from the same UUID after reloading the pre-write snapshot', async () => {
        const host = harness({ savedSearches: [] });
        let view = await host.open();
        const request = view.request({ type: 'save', query: 'work' }, 'Work');
        const prepared = view.prepared(request);
        host.setFailSave(true);
        expect(await view.methods.commitPreparedSavedSearchWrite({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(host.disk().settings.savedSearches).toEqual([]);
        host.setFailSave(false);
        view = await host.open();
        expect(await view.methods.commitPreparedSavedSearchWrite({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(host.disk().settings.savedSearches).toEqual(prepared.after.savedSearches);
    });

    it('stamps every loaded updateSettings saved-search write, including same-value calls and backward clocks', async () => {
        const future = '2099-01-01T00:00:00.000Z';
        const host = harness({ savedSearches: [row], savedSearchesUpdatedAt: future });
        const view = await host.open();
        const request = view.request({ type: 'delete', id: 'older' });
        const prepared = view.prepared(request);
        expect(Date.parse(prepared.after.stamp!)).toBeGreaterThan(Date.parse(future));
        await useTaskStore.getState().updateSettings({ savedSearches: [row] });
        const first = useTaskStore.getState().settings.savedSearchesUpdatedAt!;
        expect(Date.parse(first)).toBeGreaterThan(Date.parse(future));
        vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
        await useTaskStore.getState().updateSettings({ savedSearches: [row] });
        const second = useTaskStore.getState().settings.savedSearchesUpdatedAt!;
        expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
        expect(await view.methods.commitPreparedSavedSearchWrite({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });
});
