import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeHostContract } from './native-host-contract';
import { prepareNativeAttachmentDraftAdd, type NativeAttachmentDraftPrepared } from './native-attachment-draft';
import { getNativeTaskScheduleBase, readNativeTaskDraftSaveRequest } from './native-host-contract-task-save';
import type { OwnedFileAddSaveRequest, PreparedOwnedFileAddSave } from './native-host-contract-owned-file-save';
import { NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { SqliteClient } from './sqlite-adapter';
import * as upload from './attachment-validation';
import type { AppData, Attachment, Task } from './types';

const require = createRequire(import.meta.url);
type Statement = { run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[] };
type Database = { exec: (sql: string) => void; prepare: (sql: string) => Statement; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
const AT = '2026-10-05T00:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOT = 'file:///private/documents/attachments/';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const file: Attachment = { id: 'baseline-file', kind: 'file', title: 'Baseline', uri: ROOT + 'baseline-file.pdf',
    size: 3, createdAt: AT, updatedAt: AT, localStatus: 'available' };
const link: Attachment = { id: 'baseline-link', kind: 'link', title: 'Link', uri: 'https://example.test', createdAt: AT, updatedAt: AT };
const task = (extra: Partial<Task> = {}): Task => ({ id: 'edit', title: 'Saved task', status: 'next', projectId: 'project', tags: ['#legacy'], contexts: ['@x', '@x'],
    description: 'Retained notes', attachments: [file, link, { ...file, id: 'tombstone', deletedAt: AT }],
    createdAt: AT, updatedAt: AT, rev: 8, revBy: 'before-device', ...extra });
const seed = (extra: Partial<Task> = {}): AppData => ({ tasks: [task(extra), task({ id: 'other', title: 'Other' })], projects: [{ id: 'project', title: 'Project', status: 'active', color: '#000000', order: 0, createdAt: AT, updatedAt: AT }],
    sections: [], areas: [], people: [], settings: { deviceId: 'owned-save-device' } });
const root = join(process.cwd(), '../../.orchestrator/tmp');
mkdirSync(root, { recursive: true });
const directories: string[] = [], databases: Database[] = [];
const faults: { commits: number; after: number }[] = [];
async function open(path: string, initial?: AppData) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(path); databases.push(db);
    const fault = { commits: 0, after: 0 }; faults.push(fault);
    const writes = vi.fn();
    const client: SqliteClient = {
        run: async (sql, params = []) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('fixed injected failure'); }
            db.prepare(sql).run(...params);
            if (/^(INSERT|UPDATE|DELETE)/.test(sql)) writes(sql);
            if (sql === 'COMMIT' && fault.after > 0) { fault.after--; throw new Error('fixed acknowledgment failure'); }
        },
        all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
        get: async <T,>(sql: string, params: unknown[] = []) => {
            const rows = db.prepare(sql).all(...params); return rows[0] as T | undefined;
        }, exec: async (sql) => { db.exec(sql); },
    };
    if (initial) await new NativeReceiptSqliteAdapter(client).saveData(initial);
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    const host = createNativeHostContract();
    expect(await host.activate({ writeSafetyReady: true, recoveryLoad: true })).toMatchObject({ ok: true });
    await flushPendingSave(); writes.mockClear();
    return { db, host, fault, writes, adapter, client };
}
type Environment = Awaited<ReturnType<typeof open>>;
let env: Environment, path: string;
async function request(base = task().attachments!, count = 1): Promise<OwnedFileAddSaveRequest> {
    const initialPayloadJSON = JSON.stringify({ version: 2, taskID: 'edit', attachmentsOwned: true, attachmentsBase: base, attachments: base });
    const priorAdditions: NativeAttachmentDraftPrepared[] = [];
    let beforePayloadJSON = initialPayloadJSON;
    for (let index = 0; index < count; index++) {
        const requestId = index === 0 ? ID : `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;
        const result = await prepareNativeAttachmentDraftAdd({ version: 1, taskID: 'edit', initialPayloadJSON, beforePayloadJSON,
            priorAdditions, managedDirectoryURI: ROOT, requestId, picked: { uri: `file:///cache/${index}.pdf`, name: 'Report.pdf', mimeType: null, size: 3 },
            measuredSize: 3 }, { assertEditable: () => {}, t: (key) => key });
        if (result.kind !== 'prepared') throw new Error('Fixture preparation refused');
        priorAdditions.push(result); beforePayloadJSON = result.afterPayloadJSON;
    }
    const raw = (await env.adapter.getData({ rawTasks: true })).tasks.find((item) => item.id === 'edit')!;
    return { version: 1, kind: 'owned-file-add-save', checkpoint: { version: 1, sessionID: SESSION, taskID: 'edit', generation: count + 1,
        payloadJSON: beforePayloadJSON }, ownedDraft: { version: 1, taskID: 'edit', initialPayloadJSON, beforePayloadJSON,
        priorAdditions, managedDirectoryURI: ROOT }, saveRequest: { id: 'edit', base: {}, patch: {}, scheduleBase: getNativeTaskScheduleBase(raw),
        attachments: { base, value: JSON.parse(beforePayloadJSON).attachments } } };
}
async function plan(value?: OwnedFileAddSaveRequest) {
    const input = value ?? await request();
    const result = await env.host.prepareOwnedFileAddTaskDraftSave(input);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return clone({ request: input, prepared: result.value.prepared });
}
const rows = () => env.db.prepare('SELECT * FROM tasks ORDER BY id').all();
const reject = (result: unknown) => expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT);
    const directory = mkdtempSync(join(root, 'owned-file-save-')); directories.push(directory);
    path = join(directory, 'data.sqlite'); env = await open(path, seed());
});
afterEach(async () => {
    for (const fault of faults.splice(0)) { fault.commits = 0; fault.after = 0; }
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts(); vi.restoreAllMocks(); vi.useRealTimers();
    for (const db of databases.splice(0)) db.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('unbound shared owned-file Add Save authority', () => {
    it('saves ordered frozen additions through actual SQLite and replays cold without writes', async () => {
        const input = await request(undefined, 2), before = rows();
        const policy = vi.spyOn(upload, 'validateAttachmentForUpload').mockRejectedValue(new Error('must not run'));
        const prepared = await plan(input);
        const expected = env.host.validatePreparedOwnedFileAddTaskDraftSave(prepared);
        expect(expected).toMatchObject({ ok: true, value: { version: 1, kind: 'owned-file-add-save', result: { id: 'edit' } } });
        vi.setSystemTime('2026-11-05T00:00:00.000Z');
        expect(await env.host.commitPreparedOwnedFileAddTaskDraftSave(prepared)).toEqual(expected.ok ? { ok: true, value: expected.value.result } : null);
        const after = rows(); expect(after).not.toEqual(before);
        expect(after.find((row) => (row as Task).id === 'other')).toEqual(before.find((row) => (row as Task).id === 'other'));
        const saved = (await env.adapter.getData({ rawTasks: true })).tasks.find((item) => item.id === 'edit')!;
        expect(saved.attachments).toEqual(input.saveRequest.attachments.value);
        expect(saved).toMatchObject({ rev: 9, updatedAt: AT, revBy: 'owned-save-device', description: 'Retained notes' });
        expect(policy).not.toHaveBeenCalled();
        env = await open(path);
        expect(await env.host.commitPreparedOwnedFileAddTaskDraftSave(prepared)).toMatchObject({ ok: true });
        expect(rows()).toEqual(after); expect(env.writes).not.toHaveBeenCalled();
    });

    it('merges onto latest cloud metadata, tombstones and unrelated raw fields without changing old rows', async () => {
        const input = await request();
        const latest = { ...task(), title: 'Latest title', timeSpentMinutes: 1.5, recurrence: 'daily' as unknown as Task['recurrence'],
            attachments: [{ ...file, cloudKey: 'latest/object', title: 'Remote title' }, link, { ...file, id: 'tombstone', deletedAt: AT },
                { ...file, id: 'independent', cloudKey: 'unrelated/object' }] };
        await env.adapter.saveData(seed(latest));
        const prepared = await plan(input);
        expect(prepared.prepared.effect.task.after).toMatchObject({ title: 'Latest title', timeSpentMinutes: 1.5, recurrence: 'daily' });
        expect(prepared.prepared.effect.task.after.attachments).toEqual([...latest.attachments, input.ownedDraft.priorAdditions[0].attachment]);
        expect(await env.host.commitPreparedOwnedFileAddTaskDraftSave(prepared)).toMatchObject({ ok: true });
    });

    it('keeps every legacy V1/V2 request and prepared reader closed to file Add and tombstones', async () => {
        const input = await request(), frozen = await plan(input);
        expect(readNativeTaskDraftSaveRequest(input.saveRequest, () => true, false, true, true)).toBeNull();
        reject(await env.host.prepareTaskDraftSaveV2(input.saveRequest));
        reject(env.host.prepareTaskDraftSave(input.saveRequest));
        const old = { ...frozen.prepared, version: 2, request: input.saveRequest } as Record<string, unknown>; delete old.kind;
        reject(env.host.validatePreparedTaskDraftSave({ request: input.saveRequest, prepared: old } as never));
        reject(await env.host.commitPreparedTaskDraftSave({ request: input.saveRequest, prepared: old } as never));
        const changed = clone(input.saveRequest); changed.attachments.value = changed.attachments.base.map((item) => ({ ...item, deletedAt: AT }));
        reject(await env.host.prepareTaskDraftSaveV2(changed)); expect(env.writes).not.toHaveBeenCalled();
    });

    it.each(['raw', 'checklistBase', 'edited', 'unknown', 'touchedBase'])('refuses extra initial/UI payload %s without writes', async (name) => {
        const input = await request();

        const insert = (text: string) => JSON.stringify({ ...JSON.parse(text), [name]: {} });
        input.ownedDraft.initialPayloadJSON = insert(input.ownedDraft.initialPayloadJSON);
        input.ownedDraft.beforePayloadJSON = insert(input.ownedDraft.beforePayloadJSON);
        const op = clone(input.ownedDraft.priorAdditions[0]);
        input.ownedDraft.priorAdditions = [{ ...op, beforePayloadJSON: input.ownedDraft.initialPayloadJSON,
            afterPayloadJSON: input.ownedDraft.beforePayloadJSON }]; input.checkpoint.payloadJSON = input.ownedDraft.beforePayloadJSON;
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(input)); expect(env.writes).not.toHaveBeenCalled();
    });

    it.each([
        (x: OwnedFileAddSaveRequest) => { x.checkpoint.sessionID = SESSION.toUpperCase(); },
        (x: OwnedFileAddSaveRequest) => { x.checkpoint.version = 2 as never; },
        (x: OwnedFileAddSaveRequest) => { x.checkpoint.generation = 1; },
        (x: OwnedFileAddSaveRequest) => { x.checkpoint.generation = 1.5; },
        (x: OwnedFileAddSaveRequest) => { x.checkpoint.taskID = 'other'; },
        (x: OwnedFileAddSaveRequest) => { x.checkpoint.payloadJSON += ' '; },
        (x: OwnedFileAddSaveRequest) => { x.ownedDraft.taskID = 'other'; },
        (x: OwnedFileAddSaveRequest) => { x.ownedDraft.priorAdditions = []; },
        (x: OwnedFileAddSaveRequest) => { x.ownedDraft.priorAdditions = [...x.ownedDraft.priorAdditions, ...x.ownedDraft.priorAdditions]; },
        (x: OwnedFileAddSaveRequest) => { x.ownedDraft.managedDirectoryURI = 'file:///private/../attachments/'; },
        (x: OwnedFileAddSaveRequest) => { x.saveRequest.id = 'other'; },
        (x: OwnedFileAddSaveRequest) => { x.saveRequest.base = { title: 'X' } as never; x.saveRequest.patch = { title: 'Y' } as never; },
        (x: OwnedFileAddSaveRequest) => { x.saveRequest.attachments.value.pop(); },
        (x: OwnedFileAddSaveRequest) => { x.saveRequest.attachments.base.reverse(); },
        (x: OwnedFileAddSaveRequest) => { Object.assign(x.saveRequest, { ownership: true }); },
        (x: OwnedFileAddSaveRequest) => { Object.assign(x.checkpoint, { raw: {} }); },
        (x: OwnedFileAddSaveRequest) => { Object.assign(x, { ownership: true }); },
    ])('refuses mismatched identity/lineage/half/field grammar %#', async (mutate) => {
        const input = await request(); mutate(input);
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(input)); expect(env.writes).not.toHaveBeenCalled();
    });

    it('rejects coherent initial URL edits and accepts a non-one initial generation', async () => {
        const input = await request(); input.checkpoint.generation = 87;
        expect(await env.host.prepareOwnedFileAddTaskDraftSave(input)).toMatchObject({ ok: true });
        const opening = JSON.parse(input.ownedDraft.initialPayloadJSON); opening.attachments[1].title = 'Edited link';
        const initial = JSON.stringify(opening);
        const addition = await prepareNativeAttachmentDraftAdd({ ...input.ownedDraft, initialPayloadJSON: initial, beforePayloadJSON: initial,
            priorAdditions: [], requestId: ID, picked: { uri: 'file:///cache/new.pdf', name: 'Report.pdf', mimeType: null, size: 3 }, measuredSize: 3 },
        { assertEditable: () => {}, t: (key) => key });
        if (addition.kind !== 'prepared') throw new Error('fixture');
        input.ownedDraft = { ...input.ownedDraft, initialPayloadJSON: initial, beforePayloadJSON: addition.afterPayloadJSON, priorAdditions: [addition] };
        input.checkpoint.payloadJSON = addition.afterPayloadJSON; input.saveRequest.attachments.value = JSON.parse(addition.afterPayloadJSON).attachments;
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(input));
    });

    it.each([false, true])('never adopts an existing owned ID, even when metadata is identical=%s', async (identical) => {
        const input = await request(), added = input.ownedDraft.priorAdditions[0].attachment;
        await env.adapter.saveData(seed({ attachments: [...task().attachments!, identical ? added : { ...added, title: 'Foreign' }] }));
        env.writes.mockClear(); reject(await env.host.prepareOwnedFileAddTaskDraftSave(input));
        expect(env.writes).not.toHaveBeenCalled();
    });

    it.each([
        (p: PreparedOwnedFileAddSave) => { p.version = 2 as never; },
        (p: PreparedOwnedFileAddSave) => { p.kind = 'other' as never; },
        (p: PreparedOwnedFileAddSave) => { p.preparedAt = 'bad'; },
        (p: PreparedOwnedFileAddSave) => { p.deviceIdToInitialize = 'both'; },
        (p: PreparedOwnedFileAddSave) => { p.scope.sourceProject = { id: 'x' } as never; },
        (p: PreparedOwnedFileAddSave) => { p.scope.nextProjectOrder = 4; },
        (p: PreparedOwnedFileAddSave) => { p.effect.task.after.description = 'Forgery'; },
        (p: PreparedOwnedFileAddSave) => { p.effect.task.after.attachments![0].title = 'Forgery'; },
        (p: PreparedOwnedFileAddSave) => { p.effect.task.after.rev = 100; },
        (p: PreparedOwnedFileAddSave) => { p.effect.task.before.id = 'other'; },
        (p: PreparedOwnedFileAddSave) => { Object.assign(p.effect, { other: {} }); },
        (p: PreparedOwnedFileAddSave) => { Object.assign(p, { extra: true }); },
        (p: PreparedOwnedFileAddSave) => { p.request.checkpoint.generation++; },
    ])('strictly rederives every frozen boundary before mutation %#', async (mutate) => {
        const envelope = await plan(); mutate(envelope.prepared);
        reject(env.host.validatePreparedOwnedFileAddTaskDraftSave(envelope));
        reject(await env.host.commitPreparedOwnedFileAddTaskDraftSave(envelope)); expect(env.writes).not.toHaveBeenCalled();
    });

    it('captures before awaits, refuses a replaced adapter, and preserves wrong-workspace refusal', async () => {
        const input = await request();
        const original = env.adapter.getData.bind(env.adapter);
        const foreign = { getData: original, saveData: vi.fn() };
        vi.spyOn(env.adapter, 'getData').mockImplementation(async (options) => { setStorageAdapter(foreign); return original(options); });
        expect(await env.host.prepareOwnedFileAddTaskDraftSave(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.writes).not.toHaveBeenCalled();
        const locked = createNativeHostContract();
        expect(await locked.prepareOwnedFileAddTaskDraftSave(input)).toMatchObject({ ok: false });
        expect(foreign.saveData).not.toHaveBeenCalled();
    });

    it.each(['archived', 'deleted', 'scope', 'schedule'])('refuses changed %s before applying and preserves exact durable data', async (kind) => {
        const envelope = await plan();
        if (kind === 'archived') env.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('archived', 'edit');
        if (kind === 'deleted') env.db.prepare('UPDATE tasks SET deletedAt = ? WHERE id = ?').run(AT, 'edit');
        if (kind === 'schedule') env.db.prepare('UPDATE tasks SET dueDate = ? WHERE id = ?').run('2026-12-01', 'edit');
        if (kind === 'scope') env.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('archived', 'project');
        const before = rows(); env.writes.mockClear();
        expect(await env.host.commitPreparedOwnedFileAddTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });

    it('captures the complete request before an authoritative asynchronous read', async () => {
        const input = await request(), originalInput = clone(input);
        let release!: () => void, entered!: () => void;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const originalRead = env.adapter.getData.bind(env.adapter);
        vi.spyOn(env.adapter, 'getData').mockImplementationOnce(async (options) => {
            entered(); await barrier; return originalRead(options);
        });
        const preparing = env.host.prepareOwnedFileAddTaskDraftSave(input);
        await started;
        input.checkpoint.sessionID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        input.saveRequest.attachments.value.at(-1)!.title = 'Mutated while reading';
        release();
        const result = await preparing;
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('Fixture');
        expect(result.value.prepared.request).toEqual(originalInput);
        expect(env.writes).not.toHaveBeenCalled();
    });

    it.each(['deleted', 'readonly', 'schedule'])('checks preparation against actual durable %s authority', async (kind) => {
        const input = await request();
        if (kind === 'deleted') env.db.prepare('UPDATE tasks SET deletedAt = ? WHERE id = ?').run(AT, 'edit');
        if (kind === 'readonly') env.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('archived', 'project');
        if (kind === 'schedule') env.db.prepare('UPDATE tasks SET dueDate = ? WHERE id = ?').run('2026-12-01', 'edit');
        const before = rows();
        expect(await env.host.prepareOwnedFileAddTaskDraftSave(input)).toMatchObject({ ok: false, error: {
            code: kind === 'deleted' ? 'TASK_NOT_FOUND' : kind === 'readonly' ? 'INVALID_INPUT' : 'STALE_REVISION' } });
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });

    it('rejects getters, sparse arrays, nonfinite values and unknown envelope keys before IO', async () => {
        const input = await request(), getter = vi.fn(() => input.saveRequest);
        const accessor = { ...input }; Object.defineProperty(accessor, 'saveRequest', { enumerable: true, get: getter });
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(accessor)); expect(getter).not.toHaveBeenCalled();
        const sparse = clone(input); sparse.saveRequest.attachments.value = new Array(3);
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(sparse));
        const infinite = clone(input); infinite.checkpoint.generation = Infinity;
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(infinite));
        const envelope = await plan(); Object.assign(envelope, { ownership: true });
        reject(await env.host.commitPreparedOwnedFileAddTaskDraftSave(envelope)); expect(env.writes).not.toHaveBeenCalled();
    });

    it('bounds aliased object traversal before serialization or durable IO', async () => {
        const input = await request();
        let repeated: unknown = { leaf: true };
        for (let depth = 0; depth < 30; depth++) repeated = { left: repeated, right: repeated };
        const reads = vi.spyOn(env.adapter, 'getData');
        reject(await env.host.prepareOwnedFileAddTaskDraftSave({ ...input, extra: repeated } as never));
        expect(reads).not.toHaveBeenCalled();
        expect(env.writes).not.toHaveBeenCalled();
    });

    it('repairs exact failed SQLite Save only with the full original ownership envelope', async () => {
        const envelope = await plan(), before = rows(); env.fault.commits = 10;
        expect(await env.host.commitPreparedOwnedFileAddTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(rows()).toEqual(before); expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
        env.fault.commits = 0;
        const other = clone(envelope); other.request.checkpoint.sessionID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        other.prepared.request = clone(other.request);
        expect(env.host.validatePreparedOwnedFileAddTaskDraftSave(other)).toMatchObject({ ok: true });
        expect(await env.host.commitPreparedOwnedFileAddTaskDraftSave(other)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(rows()).toEqual(before);
        expect(await env.host.commitPreparedOwnedFileAddTaskDraftSave(envelope)).toMatchObject({ ok: true });
        expect(useTaskStore.getState().persistenceFailure).toBeNull();
    }, 30_000);

    it('cold-replays actual COMMIT acknowledgment loss, then refuses intervening edits without rewriting', async () => {
        const envelope = await plan(); env.fault.after = 10;
        const outcome = await env.host.commitPreparedOwnedFileAddTaskDraftSave(envelope);
        expect(outcome).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        env.fault.after = 0;
        const committed = rows();
        env = await open(path);
        expect(await env.host.commitPreparedOwnedFileAddTaskDraftSave(envelope)).toMatchObject({ ok: true });
        expect(rows()).toEqual(committed); expect(env.writes).not.toHaveBeenCalled();
        env.db.prepare('UPDATE tasks SET title = ?, rev = ? WHERE id = ?').run('Intervening edit', 99, 'edit');
        const changed = rows(); env = await open(path);
        expect(await env.host.commitPreparedOwnedFileAddTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(rows()).toEqual(changed); expect(env.writes).not.toHaveBeenCalled();
    }, 30_000);

    it('refuses UTF8 payload, operation, list and full prepared ceilings before writes', async () => {
        const input = await request();
        const huge = clone(input); huge.checkpoint.payloadJSON = '界'.repeat(333_334);
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(huge));
        const tooMany = clone(input); tooMany.ownedDraft.priorAdditions = Array(129).fill(input.ownedDraft.priorAdditions[0]);
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(tooMany));
        const hugeList = clone(input); hugeList.saveRequest.attachments.value = Array.from({ length: 1001 }, (_, index) => ({ ...file, id: String(index) }));
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(hugeList));
        const envelope = await plan(); envelope.prepared.effect.task.before.description = '界'.repeat(6_000_000);
        reject(await env.host.commitPreparedOwnedFileAddTaskDraftSave(envelope));
        env.db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run('界'.repeat(3_000_000), 'edit');
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(input));
        expect(env.writes).not.toHaveBeenCalled();
    });
});
