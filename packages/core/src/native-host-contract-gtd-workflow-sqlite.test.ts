import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeHostContract } from './native-host-contract';
import type { NativeGtdWorkflowRequest } from './native-host-contract-gtd-workflow';
import { buildGtdSettingsUpdate } from './gtd-settings-model';
import { NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { SqliteClient } from './sqlite-adapter';
import type { AppData, Area, Task } from './types';

const require = createRequire(import.meta.url);
type Statement = { run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown };
type Database = { exec: (sql: string) => void; prepare: (sql: string) => Statement; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
const clientOf = (db: Database, fault: { commits: number }): SqliteClient => ({
    run: async (sql, params = []) => {
        if (sql === 'COMMIT' && fault.commits > 0) { fault.commits -= 1; throw new Error('injected commit failure'); }
        db.prepare(sql).run(...params);
    },
    all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
    exec: async (sql) => { db.exec(sql); },
});
const ID = '00000000-0000-4000-8000-000000000103';
const AT = '2026-09-01T00:00:00.000Z';
const task: Task = { id: 'gtd-raw', title: 'Raw terminal', status: 'done', tags: [], contexts: [],
    focusOrder: 9, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', rev: 7 };
const initial = (): AppData => ({ tasks: [task], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'gtd-device', gtd: { focusGroupBy: 'project', legacySibling: 'keep' },
        syncPreferencesUpdatedAt: { gtd: AT, language: AT } } as AppData['settings'] });

const tempRoot = join(process.cwd(), '../../.orchestrator/tmp');
mkdirSync(tempRoot, { recursive: true });
const directories: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    for (const db of databases.splice(0)) db.close();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(path: string, seed = false, seedData = initial()) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(path); databases.push(db);
    const fault = { commits: 0 };
    const client = clientOf(db, fault);
    if (seed) await new NativeReceiptSqliteAdapter(client).saveData(seedData);
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    await flushPendingSave();
    return { db, adapter, host, fault };
}

async function plan(host: ReturnType<typeof createNativeHostContract>,
    edit: Extract<NativeGtdWorkflowRequest['edit'], { type: 'defaultScheduleTime' | 'focusTaskLimit'
        | 'focusIncludeStartDates' | 'defaultProjectFlowMode' }>) {
    const options = await host.getGtdWorkflowOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit, expected: options.value.expected[edit.type] };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planPomodoro(host: ReturnType<typeof createNativeHostContract>,
    edit: { type: 'pomodoro' | 'pomodoroLinkTask' | 'pomodoroAutoStartBreaks' | 'pomodoroAutoStartFocus'
        | 'pomodoroCompletionAlert'; value: boolean }
        | { type: 'pomodoroDurations'; value: { focusMinutes: number; breakMinutes: number } }) {
    const options = await host.getGtdPomodoroOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const expected = options.value.expected[edit.type];
    if (!expected) throw new Error('Selected Pomodoro setting is unavailable');
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit, expected };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planArchive(host: ReturnType<typeof createNativeHostContract>, value: number) {
    const options = await host.getGtdArchiveOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'autoArchiveDays', value }, expected: options.value.expected };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planReview(host: ReturnType<typeof createNativeHostContract>,
    edit: { type: 'dailyReviewFocusStep' | 'weeklyReviewContextStep'; value: boolean }) {
    const options = await host.getGtdReviewOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit, expected: options.value.expected[edit.type] };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planInbox(host: ReturnType<typeof createNativeHostContract>,
    edit: { type: 'inboxTwoMinute' | 'inboxProjectFirst' | 'inboxContextStep' | 'inboxSchedule'; value: boolean }) {
    const options = await host.getGtdInboxOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit, expected: options.value.expected[edit.type] };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planArea(host: ReturnType<typeof createNativeHostContract>, value: string) {
    const options = await host.getGtdCaptureAreaOptions({ offset: 0, limit: 50 });
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit: { type: 'defaultArea', value },
        expected: options.value.expected };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planCaptureParse(host: ReturnType<typeof createNativeHostContract>,
    edit: { type: 'quickAddAutoClean' | 'naturalLanguageDates'; value: boolean }) {
    const options = await host.getGtdCaptureParseOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit, expected: options.value.expected[edit.type] };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planEditorSection(host: ReturnType<typeof createNativeHostContract>,
    section: 'scheduling' | 'organization' | 'details', value: boolean) {
    const options = await host.getGtdTaskEditorOpenOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'taskEditorSectionOpen', section, value }, expected: options.value.expected[section] };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planPreset(host: ReturnType<typeof createNativeHostContract>, value: 'simple' | 'standard' | 'full') {
    const options = await host.getGtdTaskEditorPresetOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'taskEditorPreset', value }, expected: options.value.expected };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planReset(host: ReturnType<typeof createNativeHostContract>) {
    const options = await host.getGtdTaskEditorPresetOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'taskEditorReset' }, expected: options.value.expected };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planField(host: ReturnType<typeof createNativeHostContract>, field: 'description', value: boolean) {
    const options = await host.getGtdTaskEditorFieldOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'taskEditorFieldVisible', field, value }, expected: options.value.expected };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planFieldSection(host: ReturnType<typeof createNativeHostContract>, value: 'scheduling') {
    const options = await host.getGtdTaskEditorFieldOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'taskEditorFieldSection', field: 'description', value }, expected: options.value.expected };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

async function planOrder(host: ReturnType<typeof createNativeHostContract>) {
    const options = await host.getGtdTaskEditorFieldOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const field = options.value.taskEditor.groups.flatMap((group) => group.fields)
        .find((row) => row.id === 'status');
    const move = field?.sheet.order.moveDown.edit;
    if (!move || move.type !== 'taskEditorOrder') throw new Error('Expected shared Status move');
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'taskEditorOrder', field: 'status', value: move.value },
        expected: options.value.expected };
    const prepared = await host.prepareGtdWorkflow(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, prepared: prepared.value.prepared };
}

const tables = ['tasks', 'projects', 'areas', 'people', 'sections', 'settings', 'saved_filters',
    'schema_migrations', 'calendar_sync'] as const;
const nineTables = (db: Database) => Object.fromEntries(tables.map((table) =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

describe('GTD workflow SQLite recovery', () => {
    it.each([
        { type: 'focusTaskLimit', value: 5 },
        { type: 'focusIncludeStartDates', value: false },
    ] as const)('requeues raw saved rows after failed COMMIT and cold-replays $type', async (edit) => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-workflow-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const beforeTask = first.db.prepare('SELECT * FROM tasks WHERE id = ?').get('gtd-raw');
        const beforeSettings = (await first.adapter.getData()).settings;
        const envelope = await plan(first.host, edit);
        first.fault.commits = 10;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(first.db.prepare('SELECT * FROM tasks WHERE id = ?').get('gtd-raw')).toEqual(beforeTask);
        expect((await first.adapter.getData()).settings).toEqual(beforeSettings);
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(first.db.prepare('SELECT * FROM tasks WHERE id = ?').get('gtd-raw')).toEqual(beforeTask);
        expect((await first.adapter.getData()).settings).toEqual(beforeSettings);
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: { type: edit.type, value: edit.value, changed: true } });
        expect(first.db.prepare('SELECT * FROM tasks WHERE id = ?').get('gtd-raw')).toEqual(beforeTask);
        const saved = (await first.adapter.getData()).settings;
        expect(saved.gtd).toEqual({ ...beforeSettings.gtd, [edit.type]: edit.value });
        expect(saved.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
        expect(saved.syncPreferencesUpdatedAt?.language).toBe(AT);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(cold.db.prepare('SELECT * FROM tasks WHERE id = ?').get('gtd-raw')).toEqual(beforeTask);
        expect((await cold.adapter.getData()).settings).toEqual(saved);
    }, 20_000);

    it('applies a frozen journal after restart only at the original field/group CAS', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-workflow-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const envelope = await plan(first.host, { type: 'defaultProjectFlowMode', value: 'sequential' });
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const data = await cold.adapter.getData();
        expect(data.settings.gtd?.defaultProjectFlowMode).toBe('sequential');
        expect(data.settings.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
    });

    it('refuses independent same-target and ABA changes with a distinct group stamp', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-workflow-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const envelope = await plan(first.host, { type: 'defaultScheduleTime', value: '09:30' });
        const changed = await first.adapter.getData();
        changed.settings.gtd = { ...changed.settings.gtd, defaultScheduleTime: '09:30' };
        changed.settings.syncPreferencesUpdatedAt = { ...changed.settings.syncPreferencesUpdatedAt,
            gtd: '2026-09-02T00:00:00.000Z' };
        await first.adapter.saveData(changed);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        const changedAgain = await cold.adapter.getData();
        changedAgain.settings.gtd = { ...changedAgain.settings.gtd, defaultScheduleTime: undefined };
        await cold.adapter.saveData(changedAgain);
        cold.db.close(); databases.splice(databases.indexOf(cold.db), 1);
        const afterAba = await open(path);
        expect(await afterAba.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect((await afterAba.adapter.getData()).settings.gtd?.defaultScheduleTime).toBeUndefined();
    });
});

describe('GTD Auto-archive SQLite recovery', () => {
    it('preserves raw rows after failed COMMIT and cold-applies the complete frozen archive batch', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-auto-archive-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
        const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
        const seed = initial(); seed.settings.gtd = { ...seed.settings.gtd, autoArchiveDays: 30 };
        seed.tasks = [
            { ...task, id: 'archive-old', status: 'done', completedAt: old, updatedAt: old },
            { ...task, id: 'archive-recent', status: 'done', completedAt: recent, updatedAt: recent },
        ];
        const first = await open(path, true, seed);
        const before = nineTables(first.db);
        const envelope = await planArchive(first.host, 7);
        expect(envelope.prepared.archiveEffects).toHaveLength(1);
        first.fault.commits = 10;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(nineTables(first.db)).toEqual(before);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);

        const cold = await open(path);
        const beforeCold = await cold.adapter.getData();
        expect(beforeCold.settings.gtd?.autoArchiveDays).toBe(30);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const saved = await cold.adapter.getData();
        expect(saved.settings.gtd).toEqual({ ...beforeCold.settings.gtd, autoArchiveDays: 7 });
        expect(saved.settings.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
        expect(saved.tasks.find((row) => row.id === 'archive-old')).toMatchObject({ status: 'archived',
            archivedAt: envelope.prepared.preparedAt, rev: 8, revBy: 'gtd-device' });
        expect(saved.tasks.find((row) => row.id === 'archive-recent')?.status).toBe('done');
        const unrelated = structuredClone(saved);
        unrelated.settings.language = 'ko';
        unrelated.tasks = unrelated.tasks.map((row) => row.id === 'archive-recent'
            ? { ...row, title: 'changed after receipt' } : row);
        await cold.adapter.saveData(unrelated);
        cold.db.close(); databases.splice(databases.indexOf(cold.db), 1);
        const replay = await open(path);
        expect(await replay.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const afterReplay = await replay.adapter.getData();
        expect(afterReplay.settings.language).toBe('ko');
        expect(afterReplay.tasks.find((row) => row.id === 'archive-recent')?.title).toBe('changed after receipt');
        expect(afterReplay.tasks.find((row) => row.id === 'archive-old')).toEqual(
            saved.tasks.find((row) => row.id === 'archive-old'));
    }, 30_000);
});

describe('GTD Capture Default Area paired SQLite recovery', () => {
    it('keeps nine raw tables through two failed COMMITs, saves the pair once, and cold-replays its exact receipt', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-area-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const area: Area = { id: 'area-work', name: 'Private work name', order: 0,
            createdAt: AT, updatedAt: AT, rev: 1, revBy: 'gtd-device' };
        const seed = initial(); seed.areas = [area];
        seed.settings.gtd = { ...seed.settings.gtd, pomodoro: { legacy: 'keep' } as never };
        const first = await open(path, true, seed);
        const before = nineTables(first.db);
        const beforeSettings = (await first.adapter.getData()).settings;
        const envelope = await planArea(first.host, area.id);
        expect(envelope.prepared.version).toBe(1);
        expect(JSON.stringify(envelope)).not.toContain(area.name);
        first.fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const after = nineTables(first.db);
        for (const table of tables.filter((table) => table !== 'settings')) expect(after[table]).toEqual(before[table]);
        const saved = await first.adapter.getData();
        expect(saved.settings.gtd).toEqual({ ...beforeSettings.gtd,
            defaultAreaMode: 'fixed', defaultAreaId: area.id });
        expect(saved.settings.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(after);
        const changedModeOnly = await cold.adapter.getData();
        changedModeOnly.settings.gtd = { ...changedModeOnly.settings.gtd, defaultAreaMode: 'active' };
        await cold.adapter.saveData(changedModeOnly);
        cold.db.close(); databases.splice(databases.indexOf(cold.db), 1);
        const modeHost = await open(path);
        expect(await modeHost.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        const changedIdOnly = await modeHost.adapter.getData();
        changedIdOnly.settings.gtd = { ...changedIdOnly.settings.gtd,
            defaultAreaMode: 'fixed', defaultAreaId: 'area-other' };
        await modeHost.adapter.saveData(changedIdOnly);
        modeHost.db.close(); databases.splice(databases.indexOf(modeHost.db), 1);
        const idHost = await open(path);
        expect(await idHost.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });

        const independent = await idHost.adapter.getData();
        independent.settings.gtd = { ...independent.settings.gtd,
            defaultAreaMode: 'active', defaultAreaId: null };
        independent.settings.syncPreferencesUpdatedAt = { ...independent.settings.syncPreferencesUpdatedAt,
            gtd: '2026-10-01T00:00:00.000Z' };
        await idHost.adapter.saveData(independent);
        idHost.db.close(); databases.splice(databases.indexOf(idHost.db), 1);
        const changed = await open(path);
        expect(await changed.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        const aba = await changed.adapter.getData();
        aba.settings.gtd = { ...aba.settings.gtd, defaultAreaMode: 'fixed', defaultAreaId: area.id };
        await changed.adapter.saveData(aba);
        changed.db.close(); databases.splice(databases.indexOf(changed.db), 1);
        const reopened = await open(path);
        expect(await reopened.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    }, 20_000);
});

describe('GTD Capture parser scalar SQLite recovery', () => {
    it.each([
        { type: 'naturalLanguageDates', value: false },
        { type: 'quickAddAutoClean', value: true },
    ] as const)('retries $type from raw rows and requires exact cold field/group receipt', async (edit) => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-capture-parse-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        // Store migrations normalize this legacy sibling on load. Stage the
        // saved raw row after bootstrap to prove the writer itself preserves it.
        const raw = await first.adapter.getData();
        raw.settings.gtd = { ...raw.settings.gtd, pomodoro: 'malformed-unrelated' as never };
        await first.adapter.saveData(raw);
        const before = nineTables(first.db);
        const beforeSettings = (await first.adapter.getData()).settings;
        const envelope = await planCaptureParse(first.host, edit);
        expect(Object.keys(envelope.prepared).sort()).toEqual([
            'version', 'request', 'preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'after', 'result'].sort());
        expect(JSON.stringify(envelope)).not.toContain('legacySibling');
        first.fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const after = nineTables(first.db);
        for (const table of tables.filter((table) => table !== 'settings')) expect(after[table]).toEqual(before[table]);
        const saved = await first.adapter.getData();
        expect(edit.type === 'naturalLanguageDates'
            ? saved.settings.gtd?.naturalLanguageDates : saved.settings.quickAddAutoClean).toBe(edit.value);
        expect(saved.settings.gtd).toMatchObject({ ...beforeSettings.gtd,
            pomodoro: 'malformed-unrelated' });
        expect(saved.settings.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(after);
        expect(cold.host.probeGtdWorkflowOutcome(envelope.request)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });

        const independent = await cold.adapter.getData();
        independent.settings.syncPreferencesUpdatedAt = { ...independent.settings.syncPreferencesUpdatedAt,
            gtd: '2026-10-01T00:00:00.000Z' };
        await cold.adapter.saveData(independent);
        cold.db.close(); databases.splice(databases.indexOf(cold.db), 1);
        const changed = await open(path);
        const changedRows = nineTables(changed.db);
        expect(await changed.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(changed.db)).toEqual(changedRows);
        const aba = await changed.adapter.getData();
        if (edit.type === 'naturalLanguageDates') delete aba.settings.gtd?.naturalLanguageDates;
        else delete aba.settings.quickAddAutoClean;
        await changed.adapter.saveData(aba);
        changed.db.close(); databases.splice(databases.indexOf(changed.db), 1);
        const reopened = await open(path);
        const abaRows = nineTables(reopened.db);
        expect(await reopened.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(reopened.db)).toEqual(abaRows);
    }, 20_000);
});

describe('GTD Review variants retain the v1 SQLite recovery contract', () => {
    it('retries two failed COMMITs from owned raw rows, then cold-replays exact Review field/stamp', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-review-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const before = nineTables(first.db);
        const envelope = await planReview(first.host, { type: 'dailyReviewFocusStep', value: false });
        expect(envelope.prepared.version).toBe(1);
        first.fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: { type: 'dailyReviewFocusStep', value: false, changed: true } });
        const saved = nineTables(first.db);
        for (const table of tables.filter((name) => name !== 'settings')) expect(saved[table]).toEqual(before[table]);
        expect((await first.adapter.getData()).settings.gtd?.dailyReview?.includeFocusStep).toBe(false);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(saved);
    }, 20_000);

    it('cold-refuses an independently landed same target and parent/group ABA', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-review-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const envelope = await planReview(first.host, { type: 'weeklyReviewContextStep', value: false });
        const independent = await first.adapter.getData();
        independent.settings.gtd = { ...independent.settings.gtd,
            weeklyReview: { includeContextStep: false } };
        independent.settings.syncPreferencesUpdatedAt = { ...independent.settings.syncPreferencesUpdatedAt,
            gtd: '2026-09-02T00:00:00.000Z' };
        await first.adapter.saveData(independent);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        const sameTarget = nineTables(cold.db);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(cold.db)).toEqual(sameTarget);
        const changed = await cold.adapter.getData();
        changed.settings.gtd = { ...changed.settings.gtd,
            weeklyReview: { includeContextStep: true } };
        changed.settings.syncPreferencesUpdatedAt = { ...changed.settings.syncPreferencesUpdatedAt,
            gtd: '2026-09-03T00:00:00.000Z' };
        await cold.adapter.saveData(changed);
        const restored = await cold.adapter.getData();
        restored.settings.gtd = { ...restored.settings.gtd,
            weeklyReview: { includeContextStep: false } };
        restored.settings.syncPreferencesUpdatedAt = { ...restored.settings.syncPreferencesUpdatedAt,
            gtd: '2026-09-04T00:00:00.000Z' };
        await cold.adapter.saveData(restored);
        cold.db.close(); databases.splice(databases.indexOf(cold.db), 1);
        const afterAba = await open(path);
        const beforeRefusal = nineTables(afterAba.db);
        expect(await afterAba.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(afterAba.db)).toEqual(beforeRefusal);
    });
});

describe('GTD Inbox variants retain the v1 SQLite recovery contract', () => {
    it('retries two failed COMMITs from raw rows, then cold-replays only the Inbox field and stamp', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-inbox-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const before = nineTables(first.db);
        const envelope = await planInbox(first.host, { type: 'inboxTwoMinute', value: false });
        expect(envelope.prepared.version).toBe(1);
        first.fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: { type: 'inboxTwoMinute', value: false, changed: true } });
        const saved = nineTables(first.db);
        for (const table of tables.filter((name) => name !== 'settings')) expect(saved[table]).toEqual(before[table]);
        expect((await first.adapter.getData()).settings.gtd?.inboxProcessing?.twoMinuteEnabled).toBe(false);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(saved);
    }, 20_000);

    it('cold-refuses an independently landed same target and parent/group ABA', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-inbox-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const envelope = await planInbox(first.host, { type: 'inboxSchedule', value: true });
        const independent = await first.adapter.getData();
        independent.settings.gtd = { ...independent.settings.gtd,
            inboxProcessing: { scheduleEnabled: true } };
        independent.settings.syncPreferencesUpdatedAt = { ...independent.settings.syncPreferencesUpdatedAt,
            gtd: '2026-09-02T00:00:00.000Z' };
        await first.adapter.saveData(independent);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        const sameTarget = nineTables(cold.db);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(cold.db)).toEqual(sameTarget);
        const changed = await cold.adapter.getData();
        changed.settings.gtd = { ...changed.settings.gtd, inboxProcessing: { scheduleEnabled: false } };
        changed.settings.syncPreferencesUpdatedAt = { ...changed.settings.syncPreferencesUpdatedAt,
            gtd: '2026-09-03T00:00:00.000Z' };
        await cold.adapter.saveData(changed);
        const restored = await cold.adapter.getData();
        restored.settings.gtd = { ...restored.settings.gtd, inboxProcessing: { scheduleEnabled: true } };
        restored.settings.syncPreferencesUpdatedAt = { ...restored.settings.syncPreferencesUpdatedAt,
            gtd: '2026-09-04T00:00:00.000Z' };
        await cold.adapter.saveData(restored);
        cold.db.close(); databases.splice(databases.indexOf(cold.db), 1);
        const afterAba = await open(path);
        const beforeRefusal = nineTables(afterAba.db);
        expect(await afterAba.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(afterAba.db)).toEqual(beforeRefusal);
    });
});

describe('GTD Task Editor section defaults retain the v1 SQLite recovery contract', () => {
    it('retries two failed COMMITs from raw rows, then cold-replays only the selected section and stamp', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-open-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const before = nineTables(first.db);
        const envelope = await planEditorSection(first.host, 'scheduling', true);
        expect(envelope.prepared).toMatchObject({ version: 1, after: { selected: {
            taskEditorPresent: true, sectionOpenPresent: true, present: true, value: true } },
        result: { type: 'taskEditorSectionOpen', section: 'scheduling', value: true, changed: true } });
        first.fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const saved = nineTables(first.db);
        for (const table of tables.filter((name) => name !== 'settings')) expect(saved[table]).toEqual(before[table]);
        const settings = (await first.adapter.getData()).settings;
        expect(settings.gtd?.taskEditor?.sectionOpen).toEqual({ scheduling: true });
        expect(settings.gtd?.legacySibling).toBe('keep');
        expect(settings.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(saved);
    }, 20_000);

    it('requires both parent/map receipt bits after a default-false deletion', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-open-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const start = initial(); start.settings.gtd = { ...start.settings.gtd,
            taskEditor: { sectionOpen: { details: true, organization: true } } };
        const first = await open(path, true, start);
        const envelope = await planEditorSection(first.host, 'details', false);
        expect(envelope.prepared.after.selected).toEqual({ taskEditorPresent: true,
            sectionOpenPresent: true, present: false, value: null });
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const saved = await first.adapter.getData();
        expect(saved.settings.gtd?.taskEditor?.sectionOpen).toEqual({ organization: true });
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const noMap = await cold.adapter.getData();
        noMap.settings.gtd!.taskEditor = {};
        await cold.adapter.saveData(noMap);
        cold.db.close(); databases.splice(databases.indexOf(cold.db), 1);
        const mapMissing = await open(path);
        const beforeMap = nineTables(mapMissing.db);
        expect(await mapMissing.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(mapMissing.db)).toEqual(beforeMap);
        const noParent = await mapMissing.adapter.getData();
        delete noParent.settings.gtd!.taskEditor;
        await mapMissing.adapter.saveData(noParent);
        mapMissing.db.close(); databases.splice(databases.indexOf(mapMissing.db), 1);
        const parentMissing = await open(path);
        const beforeParent = nineTables(parentMissing.db);
        expect(await parentMissing.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(parentMissing.db)).toEqual(beforeParent);
    }, 20_000);

    it('cold-refuses independent same-target writes and parent/group ABA', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-open-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const envelope = await planEditorSection(first.host, 'organization', true);
        const independent = await first.adapter.getData();
        independent.settings.gtd = { ...independent.settings.gtd,
            taskEditor: { sectionOpen: { organization: true } } };
        independent.settings.syncPreferencesUpdatedAt = { ...independent.settings.syncPreferencesUpdatedAt,
            gtd: '2026-09-02T00:00:00.000Z' };
        await first.adapter.saveData(independent);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        const sameTarget = nineTables(cold.db);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(cold.db)).toEqual(sameTarget);
        const changed = await cold.adapter.getData();
        changed.settings.gtd!.taskEditor = { sectionOpen: { organization: false } };
        changed.settings.syncPreferencesUpdatedAt!.gtd = '2026-09-03T00:00:00.000Z';
        await cold.adapter.saveData(changed);
        const restored = await cold.adapter.getData();
        delete restored.settings.gtd!.taskEditor;
        restored.settings.syncPreferencesUpdatedAt!.gtd = '2026-09-04T00:00:00.000Z';
        await cold.adapter.saveData(restored);
        cold.db.close(); databases.splice(databases.indexOf(cold.db), 1);
        const afterAba = await open(path);
        const beforeRefusal = nineTables(afterAba.db);
        expect(await afterAba.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(afterAba.db)).toEqual(beforeRefusal);
    }, 20_000);
});

describe('GTD Task Editor presets use the composite v1 receipt', () => {
    it('retries failed raw saves and cold-replays all four layout fields without task changes', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-preset-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const seed = initial(); seed.settings.features = { priorities: false, timeEstimates: true };
        const first = await open(path, true, seed);
        const before = nineTables(first.db);
        const envelope = await planPreset(first.host, 'full');
        first.fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const saved = nineTables(first.db);
        for (const table of tables.filter((name) => name !== 'settings')) expect(saved[table]).toEqual(before[table]);
        const settings = (await first.adapter.getData()).settings;
        expect(settings.gtd?.taskEditor).toMatchObject({
            order: envelope.prepared.after.selected?.order.value,
            hidden: envelope.prepared.after.selected?.hidden.value,
            sections: envelope.prepared.after.selected?.sections.value,
            sectionOpen: envelope.prepared.after.selected?.sectionOpen.value });
        expect(settings.features).toEqual(seed.settings.features);
        expect(settings.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(saved);
    }, 20_000);

    it('cold-refuses a one-field receipt mismatch, feature change, and same-target recreation', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-preset-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const envelope = await planPreset(first.host, 'simple');
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const landed = await first.adapter.getData();
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        for (const field of ['order', 'hidden', 'sections', 'sectionOpen'] as const) {
            const alter = await open(path);
            const wrong = structuredClone(landed);
            const editor = wrong.settings.gtd!.taskEditor!;
            if (field === 'order') editor.order = [...(editor.order ?? [])].reverse();
            if (field === 'hidden') editor.hidden = (editor.hidden ?? []).slice(1);
            if (field === 'sections') editor.sections = { description: 'details' };
            if (field === 'sectionOpen') editor.sectionOpen = { scheduling: true };
            await alter.adapter.saveData(wrong);
            alter.db.close(); databases.splice(databases.indexOf(alter.db), 1);
            const cold = await open(path);
            const beforeField = nineTables(cold.db);
            expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(nineTables(cold.db)).toEqual(beforeField);
            await cold.adapter.saveData(landed);
            cold.db.close(); databases.splice(databases.indexOf(cold.db), 1);
        }
        const featureHost = await open(path);
        const feature = await featureHost.adapter.getData();
        feature.settings.gtd = landed.settings.gtd;
        feature.settings.features = { priorities: false };
        await featureHost.adapter.saveData(feature);
        featureHost.db.close(); databases.splice(databases.indexOf(featureHost.db), 1);
        const changedFeature = await open(path);
        const beforeFeature = nineTables(changedFeature.db);
        expect(await changedFeature.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(changedFeature.db)).toEqual(beforeFeature);
        const independent = await changedFeature.adapter.getData();
        independent.settings.features = landed.settings.features;
        independent.settings.syncPreferencesUpdatedAt!.gtd = '2026-09-02T00:00:00.000Z';
        await changedFeature.adapter.saveData(independent);
        changedFeature.db.close(); databases.splice(databases.indexOf(changedFeature.db), 1);
        const sameTarget = await open(path);
        const beforeSame = nineTables(sameTarget.db);
        expect(await sameTarget.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(sameTarget.db)).toEqual(beforeSame);
    }, 20_000);
});

describe('GTD Task Editor field visibility uses the composite v1 receipt', () => {
    it('retries failed COMMIT, preserves other raw tables, and cold-replays the exact hidden selection', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-field-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const seed = initial(); seed.settings.features = { priorities: false, timeEstimates: false };
        const first = await open(path, true, seed);
        const before = nineTables(first.db);
        const beforeSettings = (await first.adapter.getData()).settings;
        const envelope = await planField(first.host, 'description', false);
        expect(envelope.prepared.after.selected?.hidden.value).toContain('description');
        first.fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const saved = nineTables(first.db);
        for (const table of tables.filter((name) => name !== 'settings')) expect(saved[table]).toEqual(before[table]);
        const settings = (await first.adapter.getData()).settings;
        expect(settings.gtd?.taskEditor?.hidden).toEqual(envelope.prepared.after.selected?.hidden.value);
        expect(settings.gtd?.taskEditor?.order).toEqual(envelope.prepared.after.selected?.order.value);
        expect(settings.gtd?.taskEditor?.sections).toEqual(beforeSettings.gtd?.taskEditor?.sections);
        expect(settings.gtd?.taskEditor?.sectionOpen).toEqual(beforeSettings.gtd?.taskEditor?.sectionOpen);
        expect(settings.features).toEqual(beforeSettings.features);
        expect(settings.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(saved);
    }, 20_000);
});

describe('GTD Task Editor field section uses the composite v1 SQLite receipt', () => {
    it('retries failed COMMIT without raw row changes and cold-replays only the exact section assignment', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-field-section-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const seed = initial(); seed.settings.features = { priorities: false, timeEstimates: true };
        seed.settings.gtd = { ...seed.settings.gtd, taskEditor: { sectionOpen: { details: true } } };
        const first = await open(path, true, seed);
        const before = nineTables(first.db);
        const beforeSettings = (await first.adapter.getData()).settings;
        const envelope = await planFieldSection(first.host, 'scheduling');
        expect(envelope.prepared.after.selected?.sections.value).toEqual({ description: 'scheduling' });
        first.fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const saved = nineTables(first.db);
        for (const table of tables.filter((name) => name !== 'settings')) expect(saved[table]).toEqual(before[table]);
        const settings = (await first.adapter.getData()).settings;
        expect(settings.gtd?.taskEditor?.sections).toEqual({ description: 'scheduling' });
        expect(settings.gtd?.taskEditor?.sectionOpen).toEqual(beforeSettings.gtd?.taskEditor?.sectionOpen);
        expect(settings.features).toEqual(beforeSettings.features);
        expect(settings.gtd?.legacySibling).toBe('keep');
        expect(settings.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(saved);
    }, 20_000);
});

describe('GTD Task Editor field order uses the composite v1 SQLite receipt', () => {
    it('preserves nine raw tables through failed COMMIT, then exact-retries and cold-replays the full order', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-field-order-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const before = nineTables(first.db);
        const beforeSettings = (await first.adapter.getData()).settings;
        const envelope = await planOrder(first.host);
        expect(envelope.prepared.after.selected?.order.value).toEqual(envelope.request.edit.value);
        first.fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const saved = nineTables(first.db);
        for (const table of tables.filter((name) => name !== 'settings')) expect(saved[table]).toEqual(before[table]);
        const settings = (await first.adapter.getData()).settings;
        expect(settings.gtd?.taskEditor?.order).toEqual(envelope.request.edit.value);
        expect(settings.gtd?.legacySibling).toBe(beforeSettings.gtd?.legacySibling);
        expect(settings.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(saved);
    }, 20_000);

    it('cold-refuses an independently saved identical target with a different GTD stamp', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-field-order-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const envelope = await planOrder(first.host);
        const independent = await first.adapter.getData();
        const update = buildGtdSettingsUpdate(independent.settings, envelope.request.edit);
        if (!update) throw new Error('Expected shared order update');
        independent.settings = { ...independent.settings, ...update };
        independent.settings.syncPreferencesUpdatedAt = { ...independent.settings.syncPreferencesUpdatedAt,
            gtd: '2026-09-02T00:00:00.000Z' };
        await first.adapter.saveData(independent);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        const before = nineTables(cold.db);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(cold.db)).toEqual(before);
    });
});

describe('GTD Task Editor reset uses the composite v1 SQLite receipt', () => {
    it('preserves nine raw tables through failed COMMIT, exact-retries, and cold-replays the reset', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-reset-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const seed = initial(); seed.settings.gtd = { ...seed.settings.gtd, taskEditor: {
            order: ['description', 'status'], hidden: ['status'], sections: { description: 'basic' },
            sectionOpen: { details: true }, defaultsVersion: 5 } as never };
        seed.settings.features = { priorities: true, timeEstimates: true, legacy: 'keep' } as never;
        const first = await open(path, true, seed);
        const before = nineTables(first.db);
        const envelope = await planReset(first.host);
        expect(Object.keys(envelope.prepared.after).sort()).toEqual(['selected', 'stamp']);
        expect(envelope.prepared.result).toEqual({ type: 'taskEditorReset', changed: true });
        first.fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        const saved = nineTables(first.db);
        for (const table of tables.filter((name) => name !== 'settings')) expect(saved[table]).toEqual(before[table]);
        const settings = (await first.adapter.getData()).settings;
        expect(settings.gtd?.taskEditor).toMatchObject({ order: envelope.prepared.after.selected?.order.value,
            hidden: envelope.prepared.after.selected?.hidden.value, sections: {}, sectionOpen: {},
            defaultsVersion: 5 });
        expect(settings.features).toEqual({ priorities: false, timeEstimates: false, legacy: 'keep' });
        expect(settings.gtd?.legacySibling).toBe('keep');
        expect(settings.syncPreferencesUpdatedAt?.gtd).toBe(envelope.prepared.after.stamp);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(saved);
        const later = await cold.adapter.getData(); later.settings.language = 'ko';
        later.tasks = later.tasks.map((row) => ({ ...row, title: 'later edit' }));
        await cold.adapter.saveData(later);
        cold.db.close(); databases.splice(databases.indexOf(cold.db), 1);
        const replay = await open(path);
        const beforeReplay = nineTables(replay.db);
        expect(await replay.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: envelope.prepared.result });
        expect(nineTables(replay.db)).toEqual(beforeReplay);
    }, 20_000);

    it('cold-refuses an independently saved identical reset with another GTD stamp', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-editor-reset-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const envelope = await planReset(first.host);
        const independent = await first.adapter.getData();
        const update = buildGtdSettingsUpdate(independent.settings, envelope.request.edit);
        if (!update) throw new Error('Expected shared reset update');
        independent.settings = { ...independent.settings, ...update,
            syncPreferencesUpdatedAt: { ...independent.settings.syncPreferencesUpdatedAt,
                gtd: '2026-09-02T00:00:00.000Z' } };
        await first.adapter.saveData(independent);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        const before = nineTables(cold.db);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(cold.db)).toEqual(before);
    });
});


describe('Pomodoro Settings SQLite durability', () => {
    it.each([
        { type: 'pomodoro', value: false },
        { type: 'pomodoroLinkTask', value: true },
        { type: 'pomodoroAutoStartBreaks', value: true },
        { type: 'pomodoroAutoStartFocus', value: true },
        { type: 'pomodoroCompletionAlert', value: false },
        { type: 'pomodoroDurations', value: { focusMinutes: 33, breakMinutes: 8 } },
    ] as const)('retries raw failed saves and cold-replays the exact $type receipt', async (edit) => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-pomodoro-')); directories.push(dir);
        const path = join(dir, 'library.db'); const start = initial();
        start.settings.features = { pomodoro: true, priorities: true };
        start.settings.gtd = { ...start.settings.gtd, pomodoro: { customDurations: { focusMinutes: 25 },
            legacy: 'raw sibling' } } as never;
        start.settings.local = { pomodoroSession: 'opaque active session', pomodoroTaskId: 'raw selection' } as never;
        const first = await open(path, true, start); const envelope = await planPomodoro(first.host, edit);
        const before = nineTables(first.db); first.fault.commits = 10;
        for (let retry = 0; retry < 2; retry += 1) {
            expect(await first.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(nineTables(first.db)).toEqual(before);
        }
        first.fault.commits = 0;
        expect(await first.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: envelope.prepared.result });
        const landed = nineTables(first.db); const saved = await first.adapter.getData();
        for (const table of tables.filter((table) => table !== 'settings')) expect(landed[table]).toEqual(before[table]);
        expect(saved.settings.local).toEqual(start.settings.local);
        expect(saved.settings.gtd).toMatchObject({ legacySibling: 'keep', pomodoro: { legacy: 'raw sibling' } });
        expect(saved.settings.syncPreferencesUpdatedAt?.language).toBe(AT);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(landed);
        expect(cold.host.probeGtdWorkflowOutcome(envelope.request)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    }, 20_000);

    it('cold-applies the captured pair before any save, then permits owed settlement after the feature is disabled', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-pomodoro-')); directories.push(dir);
        const path = join(dir, 'library.db'); const start = initial(); start.settings.features = { pomodoro: true };
        const first = await open(path, true, start);
        const envelope = await planPomodoro(first.host, { type: 'pomodoroDurations', value: { focusMinutes: 33, breakMinutes: 8 } });
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: envelope.prepared.result });
        const disabled = await cold.adapter.getData(); disabled.settings.features!.pomodoro = false;
        // A feature edit is not this selected leaf's receipt; it cannot block
        // settlement of an already durable exact leaf/stamp/device receipt.
        await cold.adapter.saveData(disabled); const after = nineTables(cold.db);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: envelope.prepared.result });
        expect(nineTables(cold.db)).toEqual(after);
    });

    it.each(['gate', 'stamp', 'device', 'selected'] as const)('cold-refuses a changed %s baseline without touching any table', async (race) => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-pomodoro-')); directories.push(dir);
        const path = join(dir, 'library.db'); const start = initial(); start.settings.features = { pomodoro: true };
        const first = await open(path, true, start);
        const envelope = await planPomodoro(first.host, { type: 'pomodoroDurations', value: { focusMinutes: 33, breakMinutes: 8 } });
        const changed = await first.adapter.getData();
        if (race === 'gate') changed.settings.features!.pomodoro = false;
        if (race === 'stamp') changed.settings.syncPreferencesUpdatedAt!.gtd = '2026-09-02T00:00:00.000Z';
        if (race === 'device') changed.settings.deviceId = 'other';
        if (race === 'selected') changed.settings.gtd!.pomodoro = { customDurations: { focusMinutes: 7, breakMinutes: 3 } };
        await first.adapter.saveData(changed); first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path); const before = nineTables(cold.db);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(nineTables(cold.db)).toEqual(before);
    });

    it('rejects an independently saved identical target without the frozen group stamp', async () => {
        const dir = mkdtempSync(join(tempRoot, 'gtd-pomodoro-')); directories.push(dir);
        const path = join(dir, 'library.db'); const start = initial(); start.settings.features = { pomodoro: true };
        const first = await open(path, true, start);
        const envelope = await planPomodoro(first.host, { type: 'pomodoroDurations', value: { focusMinutes: 33, breakMinutes: 8 } });
        const changed = await first.adapter.getData(); changed.settings.gtd!.pomodoro = { customDurations: { focusMinutes: 33, breakMinutes: 8 } };
        await first.adapter.saveData(changed); first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path); const before = nineTables(cold.db);
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } }); expect(nineTables(cold.db)).toEqual(before);
    });
});
