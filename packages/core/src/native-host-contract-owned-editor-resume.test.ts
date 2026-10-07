import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createNativeHostContract } from './native-host-contract';
import { createOwnedTaskEditorResumeMethods } from './native-host-contract-task-editor-resume';
import { prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftRemoveV3, prepareNativeAttachmentDraftAddV4, prepareNativeAttachmentDraftRemoveV4,
    type NativeAttachmentDraftOperationV3, type NativeAttachmentDraftOperationV4 } from './native-attachment-draft';
import { prepareNativeAttachmentDraftAvailability } from './native-attachment-draft';
import { getAttachmentDownloadIdentity } from './mobile-attachment-availability';
import { NativeReceiptSqliteAdapter } from './native-request-receipts';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { createTaskDraft, type TaskDraftField } from './task-draft';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeTimeSpentMinutes } from './time-spent';
import { normalizeRelativeStartOffset } from './task-relative-start';
import { getNativeTaskRecurrenceBase, getNativeTaskScheduleBase, LIFECYCLE, RECURRENCE, SCHEDULE } from './native-host-contract-task-save';
import type { AppData, Attachment, Task } from './types';
import type { SqliteClient } from './sqlite-adapter';

const require = createRequire(import.meta.url);
type Database = { exec: (sql: string) => void; prepare: (sql: string) => { run: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[] }; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
const AT = '2026-10-05T10:00:00.000Z', ROOT = 'file:///private/documents/attachments/';
const SESSION = '26900000-0000-4000-8000-000000000001';
const file: Attachment = { id: 'file', kind: 'file', title: 'File', uri: ROOT + 'file.pdf', size: 3, localStatus: 'available', createdAt: AT, updatedAt: AT };
const link: Attachment = { id: 'link', kind: 'link', title: 'Link', uri: 'https://example.test', createdAt: AT, updatedAt: AT };
const task = (patch: Partial<Task> = {}): Task => ({ id: 'owned-resume', title: 'Opening', status: 'next', taskMode: 'list',
    tags: [], contexts: ['home'], description: 'Notes', checklist: [{ id: 'duplicate', title: 'One', isCompleted: false },
        { id: 'duplicate', title: 'Two', isCompleted: true }], attachments: [file, link, { ...file, id: 'old', uri: ROOT + 'old.pdf', deletedAt: AT }],
    createdAt: AT, updatedAt: AT, rev: 8, revBy: 'before', ...patch });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const validateField = (field: TaskDraftField, value: unknown) => field === 'relativeStartOffset'
    ? value === undefined || normalizeRelativeStartOffset(value) !== undefined
    : ['focusedToday', 'showFutureRecurrence'].includes(field) ? typeof value === 'boolean'
        : field === 'timeSpentMinutes' ? value === undefined || typeof value === 'number' && Number.isFinite(value) && value >= 0
            : typeof value === 'string';
const databases: Database[] = [];
async function open(initial = task(), settings: AppData['settings'] = { deviceId: 'existing' }) {
    await flushPendingSave(); resetForTests();
    const db = new DatabaseSync(':memory:'); databases.push(db);
    let writes = 0, reads = 0;
    const client: SqliteClient = { run: async (sql, params = []) => { db.prepare(sql).run(...params); if (/^(INSERT|UPDATE|DELETE)/.test(sql)) writes++; },
        all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
        get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params)[0] as T | undefined,
        exec: async (sql) => { db.exec(sql); } };
    await new NativeReceiptSqliteAdapter(client).saveData({ tasks: [initial], projects: [], sections: [], areas: [], people: [], settings });
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    const control = { onRead: null as (() => Promise<void>) | null, blocked: false, readOnly: false };
    const read = adapter.getData.bind(adapter);
    adapter.getData = async (options) => { reads++; await control.onRead?.(); return read(options); };
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    const ordinary = createNativeHostContract(); expect(await ordinary.activate({ writeSafetyReady: true, recoveryLoad: true })).toMatchObject({ ok: true });
    const owned = createOwnedTaskEditorResumeMethods({ validateField, isReadOnly: () => control.readOnly,
        readiness: () => control.blocked ? { ok: false, error: { code: 'NOT_READY', message: 'Fixed unavailable' } }
            : ordinary.getDataSettings().ok ? { ok: true, value: null } : { ok: false, error: { code: 'NOT_READY', message: 'Fixed inactive' } } });
    await flushPendingSave(); writes = 0; reads = 0;
    return { db, adapter, ordinary, owned, control, writes: () => writes, reads: () => reads,
        raw: async () => (await read({ rawTasks: true })).tasks[0], rows: () => db.prepare('SELECT * FROM tasks ORDER BY id').all(),
        external: (patch: Partial<Task>) => {
            for (const [field, value] of Object.entries(patch)) db.prepare(`UPDATE tasks SET ${field} = ? WHERE id = ?`)
                .run(field === 'attachments' || field === 'checklist' || field === 'recurrence' ? JSON.stringify(value) : value, initial.id);
        } };
}
let env: Awaited<ReturnType<typeof open>>;
async function request({ events = ['add', 'file'], groups = [] as string[], checklist = false, historyVersion = 3 as 3 | 4 } = {}) {
    const raw = await env.raw(), draft = createTaskDraft({ ...raw, recurrence: normalizeRecurrenceForLoad(raw.recurrence), timeSpentMinutes: normalizeTimeSpentMinutes(raw.timeSpentMinutes) });
    const fields = [...new Set(['title', ...groups.flatMap((group) => group === 'schedule' ? SCHEDULE : group === 'recurrence' ? RECURRENCE : LIFECYCLE)])];
    const payload = { version: 2, taskID: raw.id, tab: 'task', touchedBase: Object.fromEntries(fields.map((field) => [field, draft[field as keyof typeof draft] ?? null])),
        edited: {}, raw: { title: 'Unresolved raw title 🧪\n', note: 'Unresolved note', location: '', estimate: '12.', estimateResolved: '',
            timeSpent: '-', timeSpentResolved: '', tokens: { tags: '#half' }, tokenCanonical: { tags: '' }, tokenResolved: { tags: '' }, tokenEdited: ['tags'],
            checklistInputs: { duplicate: 'half row' }, checklistAppend: 'pending row', relativeAmount: '-', relativeUnit: 'day', relativeOwned: true,
            relativeCommitRequested: true, recurrenceInputs: { interval: '-' }, recurrenceOwned: ['interval'], recurrenceCommitRequested: ['interval'] },
        scheduleEdits: [{ id: 'pending', field: 'dueDate', value: '2026-10-10' }], scheduleFailedID: 'pending',
        attachmentsOwned: true, attachmentsBase: raw.attachments ?? [], attachments: raw.attachments ?? [], linkSheet: { text: 'https://[' },
        ...(groups.includes('schedule') ? { scheduleBase: getNativeTaskScheduleBase(raw) } : {}),
        ...(groups.includes('recurrence') ? { recurrenceBase: getNativeTaskRecurrenceBase({ ...raw, recurrence: normalizeRecurrenceForLoad(raw.recurrence) }) } : {}),
        ...(checklist ? { checklistBase: raw.checklist } : {}) };
    const initialPayloadJSON = JSON.stringify(payload, null, 2); let beforePayloadJSON = initialPayloadJSON;
    const priorOperations: (NativeAttachmentDraftOperationV3 | NativeAttachmentDraftOperationV4)[] = [];
    for (const [index, event] of events.entries()) {
        const lineage = { version: historyVersion, taskID: raw.id, initialPayloadJSON, beforePayloadJSON, priorOperations, managedDirectoryURI: ROOT };
        const requestId = `26900000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
        if (event === 'add') {
            const added = await (historyVersion === 4 ? prepareNativeAttachmentDraftAddV4 : prepareNativeAttachmentDraftAddV3)({ ...lineage, requestId,
                ...(historyVersion === 4 ? { sourceSha256: 'a'.repeat(64) } : {}),
                picked: { uri: 'file:///cache/picked.pdf', name: 'Report.pdf', mimeType: null, size: 3 }, measuredSize: 3 }, { assertEditable: () => {}, t: (key) => key });
            if (added.kind !== 'prepared') throw new Error('Fixture Add refused');
            priorOperations.push({ kind: 'add', operation: added } as NativeAttachmentDraftOperationV3 | NativeAttachmentDraftOperationV4); beforePayloadJSON = added.afterPayloadJSON;
        } else {
            const removed = (historyVersion === 4 ? prepareNativeAttachmentDraftRemoveV4 : prepareNativeAttachmentDraftRemoveV3)({ ...lineage, requestId, attachmentId: event }, { assertEditable: () => {}, t: (key) => key });
            priorOperations.push({ kind: 'remove', operation: removed }); beforePayloadJSON = removed.afterPayloadJSON;
        }
    }
    return { version: historyVersion === 4 ? 2 : 1, kind: 'owned-editor-resume', checkpoint: { version: 1, sessionID: SESSION, taskID: raw.id,
        generation: priorOperations.length + 1, payloadJSON: beforePayloadJSON }, ownedDraft: { version: historyVersion, taskID: raw.id,
        initialPayloadJSON, beforePayloadJSON, priorOperations, managedDirectoryURI: ROOT } };
}
beforeEach(async () => { env = await open(); });
afterEach(async () => { await flushPendingSave(); resetForTests(); for (const db of databases.splice(0)) db.close(); });

describe('selected owned editor resume', () => {
    it('selects Resume2/history4 without altering raw buffers and rejects crosswired hashes before reads', async () => {
        for (const events of [[], ['add', 'file']]) {
            const input = await request({ historyVersion: 4, events }), frozen = JSON.stringify(input), rows = env.rows(), status = getPersistenceStatus();
            expect(input.version).toBe(2); expect(input.ownedDraft.version).toBe(4);
            expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: true, value: { kind: 'ready' } });
            expect(JSON.stringify(input)).toBe(frozen); expect(env.rows()).toEqual(rows); expect(env.writes()).toBe(0);
            expect(getPersistenceStatus()).toEqual(status);
            const before = env.reads(), wrongPair = clone(input); wrongPair.version = 1;
            expect(await env.owned.checkOwnedTaskEditorResume(wrongPair)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            if (events.length) {
                const wrongHash = clone(input), operation = wrongHash.ownedDraft.priorOperations[0].operation;
                Object.assign(operation, { sourceSha256: 'b'.repeat(64) });
                expect(await env.owned.checkOwnedTaskEditorResume(wrongHash)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(JSON.parse(input.checkpoint.payloadJSON).attachments.find((row: Attachment) => row.id.startsWith('26900000')).fileHash).toBe('a'.repeat(64));
            }
            expect(env.reads()).toBe(before); expect(env.writes()).toBe(0);
        }
    });
    it('resumes empty and mixed histories with unresolved raw buffers and queues byte-for-byte intact', async () => {
        for (const events of [[], ['add', 'file']]) {
            const input = await request({ events }), before = JSON.stringify(input), rows = env.rows(), status = getPersistenceStatus();
            expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: true, value: { kind: 'ready', freshDraft: { title: 'Opening' } } });
            expect(JSON.stringify(input)).toBe(before); expect(env.rows()).toEqual(rows); expect(env.writes()).toBe(0); expect(getPersistenceStatus()).toEqual(status);
            expect(JSON.parse(input.checkpoint.payloadJSON).raw.title).toBe('Unresolved raw title 🧪\n');
            expect(JSON.parse(input.checkpoint.payloadJSON).scheduleEdits).toHaveLength(1);
        }
    });
    it('retains full touched schedule, recurrence, lifecycle and duplicate checklist opening witnesses', async () => {
        env = await open(task({ dueDate: '2026-10-05', recurrence: { rule: 'daily', strategy: 'strict' }, timeSpentMinutes: 17.6 }));
        const input = await request({ groups: ['schedule', 'recurrence', 'lifecycle'], checklist: true });
        expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: true, value: { freshDraft: { timeSpentMinutes: 18 },
            freshChecklistBase: [{ id: 'duplicate', title: 'One' }, { id: 'duplicate', title: 'Two' }] } });
        for (const [patch, code] of [[{ dueDate: '2026-10-06' }, 'STALE_REVISION'], [{ recurrence: { rule: 'weekly', strategy: 'strict' } }, 'STALE_REVISION'],
            [{ status: 'done' }, 'STALE_REVISION'], [{ checklist: [{ id: 'duplicate', title: 'Changed', isCompleted: false }] }, 'STALE_REVISION']] as const) {
            const raw = await env.raw(); env.external(patch as Partial<Task>);
            expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: false, error: { code } });
            const field = Object.keys(patch)[0] as keyof Task; env.external({ [field]: raw[field] });
        }
        expect(env.writes()).toBe(0);
    });
    it('returns current stored attachment bases with concurrent cloud metadata and tombstones, without rebasing the owned payload', async () => {
        const input = await request(), original = input.checkpoint.payloadJSON;
        const fresh = (await env.raw()).attachments!.map((row) => row.id === 'file' ? { ...row, cloudKey: 'concurrent', deletedAt: '2026-10-06T10:00:00.000Z' } : row);
        env.external({ attachments: fresh, description: 'External note' }); const rows = env.rows();
        expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: true, value: { freshDraft: { description: 'External note' }, freshAttachmentsBase: clone(fresh) } });
        expect(input.checkpoint.payloadJSON).toBe(original); expect(env.rows()).toEqual(rows); expect(env.writes()).toBe(0);
    });
    it('does not initialize a device or persistence generation while resuming an empty owner', async () => {
        env = await open(task(), {}); const input = await request({ events: [] }), status = getPersistenceStatus();
        const before = env.db.prepare('SELECT * FROM settings').all();
        expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: true });
        expect(env.db.prepare('SELECT * FROM settings').all()).toEqual(before); expect(getPersistenceStatus()).toEqual(status); expect(env.writes()).toBe(0);
    });
    it('rejects checkpoint and historical crosswiring before any storage read', async () => {
        const input = await request(); const before = env.reads();
        const changes: Array<(value: typeof input) => void> = [
            (value) => { value.checkpoint.sessionID += '\n'; }, (value) => { value.checkpoint.sessionID = value.checkpoint.sessionID.toUpperCase().replace('269', 'ABC'); },
            (value) => { value.checkpoint.taskID = 'other'; }, (value) => { value.checkpoint.generation = 1; },
            (value) => { value.checkpoint.generation = Number.MAX_SAFE_INTEGER + 1; }, (value) => { value.checkpoint.payloadJSON += ' '; },
            (value) => { value.version = 2; }, (value) => { value.ownedDraft.version = 2; },
            (value) => { Object.assign(value, { touchedBase: { title: 'Caller base' } }); },
            (value) => { Object.assign(value.checkpoint, { permission: true }); },
            (value) => { value.ownedDraft.priorOperations[0].operation.requestId += '\n'; },
        ];
        for (const change of changes) { const wrong = clone(input); change(wrong); expect(await env.owned.checkOwnedTaskEditorResume(wrong)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); }
        expect(env.reads()).toBe(before); expect(env.writes()).toBe(0);
    });
    it('requires payload version, owned attachment projection and object opening bases while keeping raw shapes opaque', async () => {
        const input = await request({ events: [] });
        for (const patch of [{ version: 1 }, { attachmentsOwned: false }, { touchedBase: [] }, { attachments: [] }]) {
            const wrong = clone(input), payload = JSON.stringify({ ...JSON.parse(wrong.checkpoint.payloadJSON), ...patch });
            wrong.checkpoint.payloadJSON = payload; wrong.ownedDraft.initialPayloadJSON = payload; wrong.ownedDraft.beforePayloadJSON = payload;
            expect(await env.owned.checkOwnedTaskEditorResume(wrong)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(env.reads()).toBe(0);
    });
    it('captures a bounded plain request without executing getters or accepting oversized UTF8', async () => {
        const input = await request({ events: [] }); let getters = 0;
        const accessor = clone(input); Object.defineProperty(accessor, 'checkpoint', { enumerable: true, get() { getters++; throw Error('private getter'); } });
        expect(await env.owned.checkOwnedTaskEditorResume(accessor)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const nested = clone(input); Object.defineProperty(nested.ownedDraft, 'beforePayloadJSON', { enumerable: true, get() { getters++; return input.checkpoint.payloadJSON; } });
        expect(await env.owned.checkOwnedTaskEditorResume(nested)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const large = clone(input); large.checkpoint.payloadJSON = '界'.repeat(3 * 1024 * 1024);
        expect(await env.owned.checkOwnedTaskEditorResume(large)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(getters).toBe(0); expect(env.reads()).toBe(0); expect(env.writes()).toBe(0);
    });
    it('rejects incomplete touched groups and matching raw witnesses that contradict their draft bases', async () => {
        const input = await request({ events: [], groups: ['schedule'] });
        for (const mutate of [(payload: Record<string, any>) => { delete payload.touchedBase.reviewAt; },
            (payload: Record<string, any>) => { payload.touchedBase.startTime = '2026-10-12'; },
            (payload: Record<string, any>) => { delete payload.scheduleBase; }]) {
            const wrong = clone(input), payload = JSON.parse(wrong.checkpoint.payloadJSON); mutate(payload); const json = JSON.stringify(payload);
            wrong.checkpoint.payloadJSON = json; wrong.ownedDraft.initialPayloadJSON = json; wrong.ownedDraft.beforePayloadJSON = json;
            expect(await env.owned.checkOwnedTaskEditorResume(wrong)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(env.writes()).toBe(0);
    });
    it('refuses a stale row or archived current parent without writes', async () => {
        const input = await request(); env.external({ title: 'External title' });
        expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.db.prepare('INSERT INTO projects (id, title, status, color, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run('archived', 'Archived', 'archived', '#000000', AT, AT);
        env.external({ title: 'Opening', projectId: 'archived' });
        expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(env.writes()).toBe(0);
    });
    it('refuses queued persistence without flushing or reading saved data', async () => {
        const input = await request(); expect((await useTaskStore.getState().updateTask('owned-resume', { description: 'Queued' })).success).toBe(true);
        const reads = env.reads(), writes = env.writes();
        expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.reads()).toBe(reads); expect(env.writes()).toBe(writes);
    });
    it('reads the actual changed SQLite row after an awaited read and rejects its old opening base', async () => {
        const input = await request(); let release!: () => void, entered!: () => void;
        const waiting = new Promise<void>((resolve) => { release = resolve; }), reached = new Promise<void>((resolve) => { entered = resolve; });
        env.control.onRead = async () => { entered(); await waiting; };
        const result = env.owned.checkOwnedTaskEditorResume(input); await reached; env.external({ title: 'Changed during read' }); const changed = env.rows(); release();
        expect(await result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(env.rows()).toEqual(changed); expect(env.writes()).toBe(0);
    });
    it('captures input before await and retains the existing array and adapter freshness fences', async () => {
        const input = await request(); let enter!: () => void, release!: () => void;
        const reached = new Promise<void>((resolve) => { enter = resolve; }), waiting = new Promise<void>((resolve) => { release = resolve; });
        env.control.onRead = async () => { enter(); await waiting; }; const result = env.owned.checkOwnedTaskEditorResume(input); await reached;
        input.checkpoint.taskID = 'changed caller input'; release(); expect(await result).toMatchObject({ ok: true });
        env.control.onRead = async () => { useTaskStore.setState({ _allProjects: [] }); };
        expect(await env.owned.checkOwnedTaskEditorResume(await request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        env.control.onRead = async () => { setStorageAdapter({ getData: () => env.adapter.getData(), saveData: async () => {} }); };
        expect(await env.owned.checkOwnedTaskEditorResume(await request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); setStorageAdapter(env.adapter); expect(env.writes()).toBe(0);
    });
    it('keeps ordinary link-only resume sealed against valid owned file mutations', async () => {
        const input = await request(), payload = JSON.parse(input.checkpoint.payloadJSON);
        expect(await env.ordinary.checkTaskEditorResume({ id: input.checkpoint.taskID, touchedBase: payload.touchedBase,
            attachmentsBase: payload.attachmentsBase, attachments: payload.attachments })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: true });
        expect(await env.ordinary.checkTaskEditorResume({ id: input.checkpoint.taskID, touchedBase: payload.touchedBase,
            attachmentsBase: payload.attachmentsBase, attachments: payload.attachmentsBase })).toMatchObject({ ok: true }); expect(env.writes()).toBe(0);
    });
});


const missingFile: Attachment = { ...file, uri: '', localStatus: 'missing', cloudKey: 'attachments/file.pdf', fileHash: 'a'.repeat(64), contentRev: 7 };
async function availabilityResume(status: 'available' | 'unrecoverable' | 'empty' = 'available') {
    const input = await request({ events: [], groups: ['schedule', 'recurrence', 'lifecycle'], checklist: true });
    const initialPayloadJSON = input.checkpoint.payloadJSON, selected: Attachment = JSON.parse(initialPayloadJSON).attachments[0];
    const operation = status === 'empty' ? null : prepareNativeAttachmentDraftAvailability({ version: 1, taskID: 'owned-resume',
        requestId: '35500000-2222-4222-8222-222222222222', attachmentId: selected.id, identity: getAttachmentDownloadIdentity(selected),
        beforePayloadJSON: initialPayloadJSON, status, resolvedAttachmentJSON: JSON.stringify(status === 'available'
            ? { ...selected, uri: ROOT + 'downloaded.pdf', localStatus: 'available' }
            : { ...selected, cloudKey: undefined, fileHash: undefined, localStatus: 'missing', deletedAt: '2026-10-07T01:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z' }) });
    const payloadJSON = operation?.afterPayloadJSON ?? initialPayloadJSON;
    return { ...input, version: 3, checkpoint: { ...input.checkpoint, generation: operation ? 2 : 1, payloadJSON }, ownedDraft: {
        version: 5, taskID: 'owned-resume', initialPayloadJSON, beforePayloadJSON: payloadJSON, managedDirectoryURI: ROOT,
        priorOperations: operation ? [{ kind: 'availability', operation }] : [] } };
}
describe('Resume3/history5 availability selection', () => {
    beforeEach(async () => { env = await open(task({ attachments: [missingFile, link, { ...file, id: 'old', uri: ROOT + 'old.pdf', deletedAt: AT }] })); });
    it.each(['available', 'unrecoverable', 'empty'] as const)('resumes %s with all unresolved raw/checklist/schedule buffers byte-exact and zero writes', async (status) => {
        const input = await availabilityResume(status), retained = JSON.stringify(input), rows = env.rows(), persistence = getPersistenceStatus();
        expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: true, value: { kind: 'ready', freshDraft: { title: 'Opening' },
            freshChecklistBase: [{ id: 'duplicate', title: 'One' }, { id: 'duplicate', title: 'Two' }] } });
        expect(JSON.stringify(input)).toBe(retained); expect(env.rows()).toEqual(rows); expect(env.writes()).toBe(0); expect(getPersistenceStatus()).toEqual(persistence);
        expect(JSON.parse(input.checkpoint.payloadJSON).raw.title).toBe('Unresolved raw title 🧪\n');
        expect(JSON.parse(input.checkpoint.payloadJSON).scheduleFailedID).toBe('pending');
    });
    it.each(['tombstone', 'H2'] as const)('reads current %s metadata without replacing the retained availability checkpoint', async (mode) => {
        const input = await availabilityResume(), retained = input.checkpoint.payloadJSON;
        const fresh = { ...missingFile, ...(mode === 'tombstone' ? { deletedAt: '2026-10-06T00:00:00.000Z' }
            : { cloudKey: 'attachments/H2.pdf', fileHash: 'b'.repeat(64), contentRev: 8 }) };
        env.external({ attachments: [fresh, link], description: 'Fresh external notes' }); const before = env.rows();
        expect(await env.owned.checkOwnedTaskEditorResume(input)).toMatchObject({ ok: true, value: { freshDraft: { description: 'Fresh external notes' }, freshAttachmentsBase: [fresh, link] } });
        expect(input.checkpoint.payloadJSON).toBe(retained); expect(env.rows()).toEqual(before); expect(env.writes()).toBe(0);
    });
    it('rejects crosswired versions, checkpoint and repeated/count proofs before storage reads', async () => {
        const input = await availabilityResume(), reads = env.reads();
        for (const change of [(value: any) => { value.version = 1; }, (value: any) => { value.version = 2; },
            (value: any) => { value.ownedDraft.version = 4; }, (value: any) => { value.checkpoint.generation = 1; },
            (value: any) => { value.checkpoint.payloadJSON += ' '; }, (value: any) => { value.checkpoint.taskID = 'other'; },
            (value: any) => { value.ownedDraft.priorOperations.push(clone(value.ownedDraft.priorOperations[0])); },
            (value: any) => { value.ownedDraft.priorOperations = Array.from({ length: 129 }, () => clone(value.ownedDraft.priorOperations[0])); }]) {
            const wrong = clone(input); change(wrong); expect(await env.owned.checkOwnedTaskEditorResume(wrong)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(env.reads()).toBe(reads); expect(env.writes()).toBe(0);
    });
    it('retains actual awaited-row freshness and ordinary link-only refusal for an availability file change', async () => {
        const input = await availabilityResume(), payload = JSON.parse(input.checkpoint.payloadJSON);
        expect(await env.ordinary.checkTaskEditorResume({ id: 'owned-resume', touchedBase: payload.touchedBase,
            attachmentsBase: payload.attachmentsBase, attachments: payload.attachments })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        let release!: () => void, entered!: () => void;
        const waiting = new Promise<void>((resolve) => { release = resolve; }), reached = new Promise<void>((resolve) => { entered = resolve; });
        env.control.onRead = async () => { entered(); await waiting; };
        const result = env.owned.checkOwnedTaskEditorResume(input); await reached; env.external({ title: 'Changed during read' }); const before = env.rows(); release();
        expect(await result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(env.rows()).toEqual(before); expect(env.writes()).toBe(0);
    });
});
