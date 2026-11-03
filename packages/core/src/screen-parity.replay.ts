


import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { SqliteAdapter, type SqliteAdapterOptions, type SqliteClient } from './sqlite-adapter';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, AppSettings, Area, Project, Task } from './types';

export const loadScreenFixture = <T,>(name: string): T => JSON.parse(
    readFileSync(new URL(`./${name}-parity.fixtures.json`, import.meta.url), 'utf8'),
) as T;

export const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
    entry === undefined ? '<undefined>' : entry
)));

export const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

let requestCount = 0;

export const requestId = () => `00000000-0000-4000-8000-${String(++requestCount).padStart(12, '0')}`;

type StoreFn = (...args: unknown[]) => Promise<unknown>;
const realActions = new Map<string, StoreFn>();


export async function openScreenHost(input: {
    data: { tasks?: Task[]; projects?: Project[]; areas?: Area[]; settings?: AppSettings };
    record: Record<string, number | null>;
    log: unknown[][];
    saveData?: (data: unknown) => Promise<void>;
    intercept?: (name: string, args: unknown[]) => Promise<unknown> | undefined;

    bindings?: Omit<NonNullable<Parameters<typeof createNativeHostContract>[0]>, 'replayTokens'>;
}) {
    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState() as unknown as Record<string, StoreFn>;
    for (const name of Object.keys(input.record)) if (!realActions.has(name)) realActions.set(name, initial[name]);
    let stored = JSON.parse(JSON.stringify({
        tasks: input.data.tasks ?? [], projects: input.data.projects ?? [], sections: [], areas: input.data.areas ?? [], people: [],
        settings: input.data.settings ?? {},
    }));
    setStorageAdapter({
        getData: async () => JSON.parse(JSON.stringify(stored)),
        saveData: async (next) => {
            await input.saveData?.(next);
            stored = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        ...Object.fromEntries(Object.keys(input.record).map((name) => [name, realActions.get(name)])),
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    } as never);
    const host = createNativeHostContract({ ...input.bindings, replayTokens: 'required' });
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: null }));
    value(await host.activate({ writeSafetyReady: true }));
    useTaskStore.setState(Object.fromEntries(Object.entries(input.record).map(([name, count]) => [name, async (...args: unknown[]) => {
        input.log.push([name, ...(normalize(count === null ? args : args.slice(0, count)) as unknown[])]);
        const answer = input.intercept?.(name, args);
        return answer ?? realActions.get(name)!(...args);
    }])) as never);
    return host;
}
export type ScreenHost = Awaited<ReturnType<typeof openScreenHost>>;


export async function restartScreenHost() {
    await flushPendingSave();
    const host = createNativeHostContract({ replayTokens: 'required' });
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: null }));
    value(await host.activate({ writeSafetyReady: true }));
    return host;
}


export async function replayAfterRestart<T>(replay: (host: ScreenHost) => Promise<NativeHostResult<T>>) {
    const host = await restartScreenHost();
    const data = () => {
        const state = useTaskStore.getState();
        return [state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings];
    };
    const before = data();
    const result = await replay(host);
    return { result, wrote: data().some((entry, index) => entry !== before[index]) };
}

type Statement = { run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[]; get: (...params: unknown[]) => unknown };
type Database = { exec: (sql: string) => void; close: () => void; prepare?: (sql: string) => Statement; query?: (sql: string) => Statement };
const require = createRequire(import.meta.url);
const openDatabase = (file: string): Database => {
    const bun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
    const Database = bun
        ? (require('bun:sqlite') as { Database: new (file: string) => Database }).Database
        : (require('node:sqlite') as { DatabaseSync: new (file: string) => Database }).DatabaseSync;
    return new Database(file);
};

const clientOf = (database: Database): SqliteClient => {
    const statement = (sql: string) => {
        const prepared = database.prepare ? database.prepare(sql) : database.query!(sql);
        return (method: keyof Statement, params: unknown[] = []) => (database.prepare ? prepared[method](...params) : prepared[method](params));
    };
    return {
        run: async (sql, params) => { statement(sql)('run', params); },
        all: async <T,>(sql: string, params?: unknown[]) => statement(sql)('all', params) as T[],
        get: async <T,>(sql: string, params?: unknown[]) => (statement(sql)('get', params) ?? undefined) as T | undefined,
        exec: async (sql) => { database.exec(sql); },
    };
};


export const openScratchSqlite = (file: string) => {
    const database = openDatabase(file);
    return { client: clientOf(database), close: () => database.close() };
};


export async function openSqliteHost(
    seed: Partial<AppData>,
    wrap: (client: SqliteClient) => SqliteClient = (client) => client,

    bindings: Omit<NonNullable<Parameters<typeof createNativeHostContract>[0]>, 'replayTokens'> = {},
    adapterOptions?: SqliteAdapterOptions,
) {
    const dir = mkdtempSync(join(tmpdir(), 'mindwtr-receipts-'));
    const file = join(dir, 'mindwtr.db');
    let database = openDatabase(file);
    await new SqliteAdapter(clientOf(database)).saveData({
        tasks: [], projects: [], sections: [], areas: [], people: [], settings: {}, ...JSON.parse(JSON.stringify(seed)),
    });
    const boot = async (recoveryLoad = false) => {
        resetForTests();
        resetNativeRequestReceipts();
        useTaskStore.setState({
            _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
        } as never);
        const client = wrap(clientOf(database));
        setStorageAdapter(new NativeReceiptSqliteAdapter(client, adapterOptions));
        await loadNativeRequestReceipts(client);
        const host = createNativeHostContract({ ...bindings, replayTokens: 'required' });
        value(await host.setLanguage({ storedLanguage: 'en', systemLocale: null }));
        value(await host.activate({ writeSafetyReady: true, recoveryLoad }));
        return host;
    };
    let host = await boot();
    const receiptIds = async () => (await clientOf(database).all<{ request_id: string }>('SELECT request_id FROM native_request_receipts ORDER BY request_id'))
        .map((row) => row.request_id);
    return {
        get host() { return host; },

        client: () => clientOf(database),
        sql: <T,>(query: string, params?: unknown[]) => clientOf(database).all<T>(query, params),
        receiptIds,

        dir,

        async restart(from?: string, options?: { recoveryLoad?: boolean }) {
            const status = getPersistenceStatus();
            if (status.queued || status.inFlight || status.immediate) throw new Error('Restart with a save still queued: flush the change first');
            database.close();
            if (from) copyFileSync(from, file);
            database = openDatabase(file);
            host = await boot(options?.recoveryLoad);
            return host;
        },


        async replay<T>(replay: (restarted: ScreenHost) => Promise<NativeHostResult<T>>, from?: string) {
            const restarted = await this.restart(from);
            const data = () => {
                const state = useTaskStore.getState();
                return [state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings];
            };
            const before = data();
            const receiptsBefore = await receiptIds();
            const result = await replay(restarted);
            await flushPendingSave();
            return {
                result,
                wrote: data().some((entry, index) => entry !== before[index]),
                receipts: JSON.stringify(await receiptIds()) !== JSON.stringify(receiptsBefore),
            };
        },
        async close() {
            await flushPendingSave();
            resetNativeRequestReceipts();
            database.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
