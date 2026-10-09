import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from './types';
import type { NativeHostResult } from './native-host-contract';

const cleanup: Array<() => Promise<void>> = [];
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value;
};
const data = (): AppData => ({ tasks: [], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'registered-device', externalCalendars: [] } });

afterEach(async () => {
    for (const close of cleanup.splice(0)) await close();
    vi.resetModules();
});

describe('Calendar subscription store registration', () => {
    it('direct store producers fail closed when helpers have not registered', async () => {
        vi.resetModules();
        const store = await import('./store');
        const { calendarSubscriptionModules } = await import('./store-calendar-subscription-modules');
        expect(calendarSubscriptionModules).toEqual({});
        const state = store.useTaskStore.getState();
        const authority = { state, snapshot: data() };
        let publications = 0;
        const unsubscribe = store.useTaskStore.subscribe(() => { publications += 1; });
        try {
            expect(await state.commitPreparedCalendarSubscriptionSetting({} as never, authority, null))
                .toMatchObject({ success: false, reason: 'conflict' });
            expect(await state.commitPreparedCalendarSubscriptionAdd({} as never, authority, null))
                .toMatchObject({ success: false, reason: 'conflict' });
            expect(store.useTaskStore.getState()).toBe(state);
            expect(publications).toBe(0);
            expect(store.getPersistenceStatus().queued).toBe(0);
            expect(store.getPersistenceStatus().generation).toBe(0);
        } finally { unsubscribe(); }
    });

    it.each(['store-first', 'facade-first'] as const)('actual core exports commit and replay with %s import order', async (order) => {
        vi.resetModules();
        if (order === 'store-first') {
            await import('./store');
            const { calendarSubscriptionModules } = await import('./store-calendar-subscription-modules');
            expect(calendarSubscriptionModules).toEqual({});
        } else {
            await import('./native-host-contract-calendar-subscription-add');
        }
        const core = await import('./index');
        const store = await import('./store');
        const { resetNativeRequestReceipts } = await import('./native-request-receipts');
        const { openScratchSqlite } = await import('./screen-parity.replay');
        const { calendarSubscriptionSettingSource } = await import('./calendar-subscription-settings-witness');
        const { calendarSubscriptionModules } = await import('./store-calendar-subscription-modules');
        expect(calendarSubscriptionModules.setting).toBeDefined();
        expect(calendarSubscriptionModules.add).toBeDefined();
        const directory = mkdtempSync(join(tmpdir(), 'mindwtr-calendar-registration-'));
        const scratch = openScratchSqlite(join(directory, 'calendar.sqlite'));
        cleanup.push(async () => {
            try {
                await store.flushPendingSave();
                store.resetForTests(); resetNativeRequestReceipts();
            } finally { scratch.close(); rmSync(directory, { recursive: true, force: true }); }
        });
        await new core.SqliteAdapter(scratch.client).saveData(data());
        const sql: string[] = [];
        const client = { ...scratch.client, run: async (statement: string, args?: unknown[]) => {
            sql.push(statement); await scratch.client.run(statement, args);
        } };
        const adapter = new core.NativeReceiptSqliteAdapter(client);
        store.setStorageAdapter(adapter);
        const snapshot = await adapter.getData({ rawTasks: true });
        store.useTaskStore.setState({ _allTasks: snapshot.tasks, _allProjects: snapshot.projects,
            _allSections: snapshot.sections ?? [], _allAreas: snapshot.areas, _allPeople: snapshot.people ?? [],
            settings: snapshot.settings, isLoading: false, error: null, persistenceFailure: null, lastDataChangeAt: 0 });
        await core.loadNativeRequestReceipts(client, { durableCommands: ['calendarSubscriptionAdd'] });
        const create = () => core.createCalendarSubscriptionAddMethods({ readiness: () => ({ ok: true, value: null }),
            storage: () => null, save: async () => { await store.flushPendingSave(); return { ok: true, value: null }; } });
        let methods = create();
        const request = { requestId: '00000000-0000-4000-8000-000000000472', name: '', defaultName: 'Calendar',
            url: ' https://example.invalid/registered.ics ',
            expected: calendarSubscriptionSettingSource(snapshot.settings, null)!.witness };
        const preparation = value(await methods.prepareCalendarSubscriptionAdd(request));
        expect(preparation.kind).toBe('prepared');
        if (preparation.kind !== 'prepared') throw new Error('Expected preparation');
        const envelope = { request, prepared: preparation.prepared };
        expect(value(await methods.commitPreparedCalendarSubscriptionAdd(envelope))).toEqual({
            changed: true, toasts: [], open: null, clearDraft: true,
        });
        const saved = await adapter.getData({ rawTasks: true });
        expect(saved.settings.externalCalendars).toEqual([{ id: request.requestId, name: 'Calendar',
            url: 'https://example.invalid/registered.ics', enabled: true }]);
        expect(await client.all('SELECT request_id FROM native_request_receipts')).toHaveLength(1);
        sql.length = 0;
        resetNativeRequestReceipts();
        await core.loadNativeRequestReceipts(client, { durableCommands: ['calendarSubscriptionAdd'] });
        methods = create();
        expect(value(await methods.commitPreparedCalendarSubscriptionAdd(envelope))).toEqual({
            changed: true, toasts: [], open: null, clearDraft: true,
        });
        expect(sql.filter((statement) => /^(INSERT|UPDATE|DELETE)/.test(statement))).toEqual([]);
        expect(await adapter.getData({ rawTasks: true })).toEqual(saved);
    });
});
