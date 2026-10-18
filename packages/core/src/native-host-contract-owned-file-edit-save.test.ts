import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeHostContract } from './native-host-contract';
import { prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftRemoveV3, type NativeAttachmentDraftOperationV3 } from './native-attachment-draft';
import { ASSOCIATIONS, RECURRENCE, SCHEDULE, getNativeTaskRecurrenceBase, getNativeTaskScheduleBase } from './native-host-contract-task-save';
import { createOwnedEditorFileEditTaskDraftSaveMethods, type OwnedEditorFileEditSaveRequest, type OwnedEditorFileEditSaveEnvelope } from './native-host-contract-owned-file-edit-save';
import { NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { SqliteClient } from './sqlite-adapter';
import * as persistence from './store';
import { mergeTaskDraftAttachments } from './attachment-editor-model';
import { planAttachmentDraftSettlement } from './attachment-draft-settlement';
import { createTaskDraft, type TaskDraft, type TaskDraftField } from './task-draft';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeTimeSpentMinutes } from './time-spent';
import { getTaskEditorDailyInterval } from './task-editor-model';
import { getTaskEditorRecurrenceInputValues, getTaskEditorRelativeStart, getTaskEditorTimeEstimate } from './task-editor-schedule';
import { taskEditValuesEqual } from './json-value-equality';
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
const validateField = (field: TaskDraftField, value: unknown): boolean => {
    if (field === 'timeSpentMinutes') return value === undefined || typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (field === 'relativeStartOffset') return value === undefined || typeof value === 'object' && value !== null;
    if ((field === 'showFutureRecurrence' || field === 'preserveChecklistOnRepeat') || field === 'focusedToday') return typeof value === 'boolean';
    return typeof value === 'string';
};
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
    const baseHost = createNativeHostContract();
    expect(await baseHost.activate({ writeSafetyReady: true, recoveryLoad: true })).toMatchObject({ ok: true });
    await flushPendingSave(); writes.mockClear();
    const control = { blocked: false };
    const host = createOwnedEditorFileEditTaskDraftSaveMethods({
        readiness: () => {
            if (control.blocked) return { ok: false, error: { code: 'NOT_READY', message: 'fixed unavailable' } };
            const ready = baseHost.getDataSettings();
            return ready.ok ? { ok: true, value: null } : ready;
        },
        save: async () => {
            try { await flushPendingSave(); return { ok: true, value: null }; }
            catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'fixed failure' } }; }
        }, validateField,
    });
    return { db, host, baseHost, fault, writes, adapter, client, control };
}
type Environment = Awaited<ReturnType<typeof open>>;
let env: Environment, path: string;
async function request(base = task().attachments!, events: readonly string[] = ['baseline-file'], edits: Partial<TaskDraft> = {}): Promise<OwnedEditorFileEditSaveRequest> {
    const raw = (await env.adapter.getData({ rawTasks: true })).tasks.find((item) => item.id === 'edit')!;
    const draft = createTaskDraft({ ...raw, recurrence: normalizeRecurrenceForLoad(raw.recurrence), timeSpentMinutes: normalizeTimeSpentMinutes(raw.timeSpentMinutes) });
    const edited: Record<string, unknown> = Object.fromEntries(Object.entries(edits).map(([field, value]) => [field, value ?? null]));
    for (const group of [SCHEDULE, RECURRENCE, ASSOCIATIONS]) if (group.some((field) => Object.hasOwn(edited, field)))
        for (const field of group) if (!Object.hasOwn(edited, field)) edited[field] = draft[field] ?? null;
    const touched = Object.keys(edited), touchedBase = Object.fromEntries(touched.map((field) => [field, draft[field as keyof TaskDraft] ?? null]));
    const current = { ...draft, ...edited } as TaskDraft;
    const scheduleOwned = SCHEDULE.some((field) => touched.includes(field)), recurrenceOwned = RECURRENCE.some((field) => touched.includes(field));
    const tokens = Object.fromEntries(['contexts', 'tags', 'assignedTo'].filter((field) => touched.includes(field)).map((field) => [field, edited[field]]));
    const relative = scheduleOwned ? getTaskEditorRelativeStart(current, (key) => key) : null;
    const recurrence = getTaskEditorRecurrenceInputValues(current, getTaskEditorDailyInterval(current.recurrence, current.recurrenceRRule));
    const estimate = touched.includes('timeEstimate') ? getTaskEditorTimeEstimate(current.timeEstimate, (key) => key).customText : '';
    const timeSpent = touched.includes('timeSpentMinutes') && current.timeSpentMinutes != null ? String(current.timeSpentMinutes) : '';
    const initialPayloadJSON = JSON.stringify({ version: 2, taskID: 'edit', tab: 'task', touchedBase, edited,
        raw: { title: touched.includes('title') ? edited.title : '', note: touched.includes('description') ? edited.description : '',
            location: touched.includes('location') ? edited.location : '', estimate, estimateResolved: estimate, timeSpent, timeSpentResolved: timeSpent,
            tokens: clone(tokens), tokenCanonical: clone(tokens), tokenResolved: clone(tokens), tokenEdited: Object.keys(tokens),
            checklistInputs: {}, checklistAppend: '', relativeAmount: relative ? String(relative.amount) : '', relativeUnit: relative?.unit ?? '',
            relativeOwned: false, relativeCommitRequested: false, recurrenceInputs: recurrenceOwned ? { interval: String(recurrence.interval), count: String(recurrence.count) } : {},
            recurrenceOwned: [], recurrenceCommitRequested: [] },
        scheduleEdits: [], scheduleFailedID: null, attachmentsOwned: true, attachmentsBase: base, attachments: base, linkSheet: {},
        ...(scheduleOwned ? { scheduleBase: getNativeTaskScheduleBase(raw) } : {}),
        ...(recurrenceOwned ? { recurrenceBase: getNativeTaskRecurrenceBase({ ...raw, recurrence: normalizeRecurrenceForLoad(raw.recurrence) }) } : {}) });
    const priorOperations: NativeAttachmentDraftOperationV3[] = [];
    let beforePayloadJSON = initialPayloadJSON, lastAddID = '';
    for (let index = 0; index < events.length; index++) {
        const requestId = `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`;
        const lineage = { version: 3 as const, taskID: 'edit', initialPayloadJSON, beforePayloadJSON,
            priorOperations, managedDirectoryURI: ROOT };
        if (events[index] === 'add') {
            const added = await prepareNativeAttachmentDraftAddV3({ ...lineage, requestId,
                picked: { uri: `file:///cache/${index}.pdf`, name: 'Report.pdf', mimeType: null, size: 3 }, measuredSize: 3 },
            { assertEditable: () => {}, t: (key) => key });
            if (added.kind !== 'prepared') throw new Error('Fixture Add refused');
            priorOperations.push({ kind: 'add', operation: added }); lastAddID = requestId;
            beforePayloadJSON = added.afterPayloadJSON;
        } else {
            const removed = prepareNativeAttachmentDraftRemoveV3({ ...lineage, requestId,
                attachmentId: events[index] === 'added' ? lastAddID : events[index] }, { assertEditable: () => {}, t: (key) => key });
            priorOperations.push({ kind: 'remove', operation: removed }); beforePayloadJSON = removed.afterPayloadJSON;
        }
    }
    const changed = new Set(touched.filter((field) => !taskEditValuesEqual(touchedBase[field], edited[field])));
    for (const group of [ASSOCIATIONS, RECURRENCE]) if (group.some((field) => changed.has(field))) group.forEach((field) => changed.add(field));
    return clone({ version: 1, kind: 'owned-editor-file-edit-save', checkpoint: { version: 1, sessionID: SESSION, taskID: 'edit', generation: events.length + 1,
        payloadJSON: beforePayloadJSON }, ownedDraft: { version: 3, taskID: 'edit', initialPayloadJSON, beforePayloadJSON,
        priorOperations, managedDirectoryURI: ROOT }, saveRequest: { id: 'edit',
        base: Object.fromEntries([...changed].map((field) => [field, touchedBase[field]])), patch: Object.fromEntries([...changed].map((field) => [field, edited[field]])),
        scheduleBase: getNativeTaskScheduleBase(raw), ...(recurrenceOwned && RECURRENCE.some((field) => changed.has(field))
            ? { recurrenceBase: getNativeTaskRecurrenceBase({ ...raw, recurrence: normalizeRecurrenceForLoad(raw.recurrence) }) } : {}),
        attachments: { base, value: JSON.parse(beforePayloadJSON).attachments } } }) as OwnedEditorFileEditSaveRequest;
}
async function plan(value?: OwnedEditorFileEditSaveRequest): Promise<OwnedEditorFileEditSaveEnvelope> {
    const input = value ?? await request();
    const prepared = await env.host.prepareOwnedEditorFileEditTaskDraftSave(input);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    return clone({ request: input, prepared: prepared.value.prepared });
}
const rows = () => env.db.prepare('SELECT * FROM tasks ORDER BY id').all();
const reject = (result: unknown) => expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
const effect = (envelope: OwnedEditorFileEditSaveEnvelope) => envelope.prepared.decision.kind === 'changed'
    ? envelope.prepared.decision.prepared.effect : envelope.prepared.decision.effect;
async function noopPlan(device = true) {
    const input = await request();
    const data = seed({ attachments: input.saveRequest.attachments.value });
    if (!device) data.settings = {};
    await env.adapter.saveData(data); env.writes.mockClear();
    const envelope = await plan(input);
    expect(envelope.prepared.decision.kind).toBe('noop');
    return envelope;
}
beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT);
    const directory = mkdtempSync(join(root, 'owned-file-edit-')); directories.push(directory);
    path = join(directory, 'data.sqlite'); env = await open(path, seed());
});
afterEach(async () => {
    for (const fault of faults.splice(0)) { fault.commits = 0; fault.after = 0; }
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts(); vi.restoreAllMocks(); vi.useRealTimers();
    for (const db of databases.splice(0)) db.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('unbound mixed ordinary owned file-edit Save', () => {
    it.each(['\n', '\r\n'])('refuses a UUID trailing line terminator %j before IO', async (suffix) => {
        const input = await request(); input.checkpoint.sessionID += suffix;
        const reads = vi.spyOn(env.adapter, 'getData');
        reject(await env.host.prepareOwnedEditorFileEditTaskDraftSave(input));
        expect(reads).not.toHaveBeenCalled(); expect(env.writes).not.toHaveBeenCalled();
    });
    it.each([['baseline-file'], ['add', 'added'], ['add', 'baseline-file', 'add', 'added']])(
        'commits mixed history %j with ordinary fields and exact cold replay', async (...events) => {
            const input = await request(undefined, events, { title: 'Edited', description: 'New notes' });
            const envelope = await plan(input), checked = env.host.validatePreparedOwnedEditorFileEditTaskDraftSave(envelope);
            expect(checked).toMatchObject({ ok: true });
            expect(effect(envelope).task.after).toMatchObject({ title: 'Edited', description: 'New notes', rev: 9 });
            expect(effect(envelope).task.after.attachments).toEqual(mergeTaskDraftAttachments(task().attachments!,
                input.saveRequest.attachments.base, input.saveRequest.attachments.value));
            expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope))
                .toEqual(checked.ok ? { ok: true, value: checked.value.result } : null);
            const saved = rows(); env = await open(path);
            vi.setSystemTime('2026-12-01T00:00:00.000Z');
            expect(env.host.validatePreparedOwnedEditorFileEditTaskDraftSave(envelope)).toEqual(checked);
            expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: true });
            expect(rows()).toEqual(saved); expect(env.writes).not.toHaveBeenCalled();
        });

    it('saves ordinary link gaps around real file operations with file-only settlement and cold replay', async () => {
        const base = [file, link];
        await env.adapter.saveData(seed({ attachments: base })); env.writes.mockClear();
        const input = await request(base, ['baseline-file'], { title: 'Edited' });
        const addedLink: Attachment = { id: '99999999-1111-4111-8111-111111111111', kind: 'link', title: 'New link',
            uri: 'https://example.test/new', createdAt: AT, updatedAt: AT };
        const opening = JSON.parse(input.ownedDraft.initialPayloadJSON);
        const initial = JSON.stringify({ ...opening, attachments: [...base, addedLink] });
        const lineage = { ...input.ownedDraft, initialPayloadJSON: initial, beforePayloadJSON: initial, priorOperations: [] };
        const first = await prepareNativeAttachmentDraftAddV3({ ...lineage, requestId: ID,
            picked: { uri: 'file:///cache/report.pdf', name: 'Report.pdf', mimeType: null, size: 3 }, measuredSize: 3 },
        { assertEditable: () => {}, t: (key) => key });
        if (first.kind !== 'prepared') throw new Error('Fixture Add refused');
        const after = JSON.parse(first.afterPayloadJSON), nextRows: Attachment[] = after.attachments;
        nextRows[1] = { ...link, title: 'Edited link', uri: 'https://example.test/edited' };
        const before = JSON.stringify({ ...after, attachments: nextRows });
        const removed = prepareNativeAttachmentDraftRemoveV3({ ...lineage, beforePayloadJSON: before,
            priorOperations: [{ kind: 'add', operation: first }], requestId: '22222222-1111-4111-8111-111111111111',
            attachmentId: first.requestId }, { assertEditable: () => {}, t: (key) => key });
        const last = JSON.parse(removed.afterPayloadJSON);
        const current = JSON.stringify({ ...last, attachments: last.attachments.map((row: Attachment) => row.id === addedLink.id
            ? { ...row, deletedAt: AT, updatedAt: AT } : row) });
        input.ownedDraft = { ...lineage, beforePayloadJSON: current,
            priorOperations: [{ kind: 'add', operation: first }, { kind: 'remove', operation: removed }] };
        input.checkpoint = { ...input.checkpoint, generation: 5, payloadJSON: current };
        input.saveRequest.attachments.value = JSON.parse(current).attachments;
        const envelope = await plan(input), checked = env.host.validatePreparedOwnedEditorFileEditTaskDraftSave(envelope);
        if (!checked.ok) throw new Error('Fixture validation refused');
        expect(checked.value.settlementPlan).toEqual([{ attachment: { ...first.attachment, deletedAt: AT, updatedAt: AT },
            reason: 'uncommitted-draft' }]);
        expect(effect(envelope).task.after).toMatchObject({ title: 'Edited' });
        expect(effect(envelope).task.after.attachments?.filter((row) => row.kind === 'link'))
            .toEqual([nextRows[1], { ...addedLink, deletedAt: AT, updatedAt: AT }]);
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toEqual({ ok: true, value: checked.value.result });
        const saved = rows(); env = await open(path);
        expect(env.host.validatePreparedOwnedEditorFileEditTaskDraftSave(envelope)).toEqual(checked);
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toEqual({ ok: true, value: checked.value.result });
        expect(rows()).toEqual(saved); expect(env.writes).not.toHaveBeenCalled();
    });

    it.each(['metadata', 'tombstone', 'missing', 'unrelated', 'content'])('matches actual RN merge for stored %s', async (mode) => {
        const input = await request(undefined, ['baseline-file']);
        const base = task().attachments!;
        let latest = clone(base);
        if (mode === 'metadata') latest[0] = { ...latest[0], cloudKey: 'new/cloud', pendingContentUpload: true };
        if (mode === 'content') latest[0] = { ...latest[0], fileHash: 'new-hash', contentRev: 7, cloudKey: 'new/cloud', contentSize: 7 };
        if (mode === 'tombstone') latest[0] = { ...latest[0], deletedAt: '2026-10-04T00:00:00.000Z' };
        if (mode === 'missing') latest.shift();
        if (mode === 'unrelated') latest.push({ ...file, id: 'concurrent', uri: ROOT + 'concurrent.pdf' });
        await env.adapter.saveData(seed({ attachments: latest })); env.writes.mockClear();
        const envelope = await plan(input), expected = mergeTaskDraftAttachments(latest, base, input.saveRequest.attachments.value);
        expect(effect(envelope).task.after.attachments).toEqual(expected);
        const checked = env.host.validatePreparedOwnedEditorFileEditTaskDraftSave(envelope);
        expect(checked).toMatchObject({ ok: true });
        if (!checked.ok) throw new Error('Fixture validation');
        expect(checked.value.settlementPlan).toEqual(planAttachmentDraftSettlement({ baselineAttachments: base,
            draftAttachments: input.saveRequest.attachments.value, committedAttachments: expected }));
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: true });
        expect((await env.adapter.getData({ rawTasks: true })).tasks.find((row) => row.id === 'edit')!.attachments).toEqual(expected);
    });

    it('returns the complete plan including more than 128 pre-existing baseline tombstones', async () => {
        const base = [file, ...Array.from({ length: 180 }, (_, n) => ({ ...file, id: `old-${n}`, uri: ROOT + `old-${n}.pdf`, deletedAt: AT }))];
        await env.adapter.saveData(seed({ attachments: base })); env.writes.mockClear();
        const input = await request(base), envelope = await plan(input), result = env.host.validatePreparedOwnedEditorFileEditTaskDraftSave(envelope);
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('Fixture');
        expect(result.value.settlementPlan).toHaveLength(181);
        expect(result.value.settlementPlan).toEqual(planAttachmentDraftSettlement({ baselineAttachments: base,
            draftAttachments: input.saveRequest.attachments.value, committedAttachments: effect(envelope).task.after.attachments }));
        expect(env.writes).not.toHaveBeenCalled();
    });

    it.each([true, false])('freezes and cold confirms a real no-op, stored device=%s, without any writes', async (device) => {
        const envelope = await noopPlan(device), decision = envelope.prepared.decision;
        if (decision.kind !== 'noop') throw new Error('Fixture');
        expect(decision.effect.task.before).toEqual(decision.effect.task.after);
        expect(decision.effect.task.after).toMatchObject({ rev: 8, updatedAt: AT, revBy: 'before-device' });
        expect(decision.deviceIdBefore).toBe(device ? 'owned-save-device' : null);
        expect(decision).not.toHaveProperty('deviceIdToInitialize');
        const before = rows(), settings = (await env.adapter.getData()).settings;
        const changedWriter = vi.spyOn(useTaskStore.getState(), 'commitPreparedTaskDraftV2');
        const retry = vi.spyOn(useTaskStore.getState(), 'retryPersistence');
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: true });
        expect(changedWriter).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
        expect(rows()).toEqual(before); expect((await env.adapter.getData()).settings).toEqual(settings);
        expect(env.writes).not.toHaveBeenCalled();
        env = await open(path); vi.setSystemTime('2026-12-01T00:00:00.000Z');
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: true });
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });

    it('captures no-op at the single preparation raw read, not an unbound second read', async () => {
        const input = await request(); await env.adapter.saveData(seed({ attachments: input.saveRequest.attachments.value }));
        env.writes.mockClear();
        const reads = vi.spyOn(env.adapter, 'getData');
        const envelope = await plan(input);
        expect(envelope.prepared.decision.kind).toBe('noop'); expect(reads).toHaveBeenCalledTimes(1);
        expect(reads).toHaveBeenCalledWith({ rawTasks: true }); expect(env.writes).not.toHaveBeenCalled();
    });

    it.each(['row', 'device', 'scope'])('refuses an intervening no-op %s witness without writing', async (mode) => {
        const envelope = await noopPlan();
        if (mode === 'row') env.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Different', 'edit');
        if (mode === 'device') env.db.prepare('UPDATE settings SET data = ? WHERE id = ?').run(JSON.stringify({ deviceId: 'different' }), 1);
        if (mode === 'scope') env.db.prepare('UPDATE projects SET rev = ? WHERE id = ?').run(99, 'project');
        const before = rows();
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });

    it.each(['adapter', 'generation', 'readiness', 'failure'])('refuses %s changes during no-op durable read', async (mode) => {
        const envelope = await noopPlan(), before = rows(), original = env.adapter.getData.bind(env.adapter);
        vi.spyOn(env.adapter, 'getData').mockImplementationOnce(async (options) => {
            const data = await original(options);
            if (mode === 'adapter') setStorageAdapter({ getData: original, saveData: vi.fn() });
            if (mode === 'generation') {
                const status = persistence.getPersistenceStatus();
                vi.spyOn(persistence, 'getPersistenceStatus').mockReturnValue({ ...status, generation: status.generation + 1 });
            }
            if (mode === 'readiness') env.control.blocked = true;
            if (mode === 'failure') useTaskStore.setState({ persistenceFailure: { message: 'fixed failure' } } as never);
            return data;
        });
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: false });
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
        if (mode === 'failure') expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
    });

    it.each(['queued', 'inFlight', 'immediate', 'retrying', 'failed'])('refuses unresolved %s at no-op completion', async (flag) => {
        const envelope = await noopPlan(), before = rows(), original = env.adapter.getData.bind(env.adapter);
        vi.spyOn(env.adapter, 'getData').mockImplementationOnce(async (options) => {
            const data = await original(options), status = persistence.getPersistenceStatus();
            vi.spyOn(persistence, 'getPersistenceStatus').mockReturnValue({ ...status, [flag]: flag === 'queued' ? 1 : true });
            return data;
        });
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });

    it.each(['effect', 'rev', 'scope', 'deviceType', 'timestamp', 'extra', 'request'])('refuses forged no-op %s before IO', async (mode) => {
        const envelope = await noopPlan(), decision = envelope.prepared.decision;
        if (decision.kind !== 'noop') throw new Error('Fixture');
        if (mode === 'effect') decision.effect.task.after.description = 'Forged';
        if (mode === 'rev') decision.effect.task.after.rev = 99;
        if (mode === 'scope') decision.scope.nextProjectOrder = 4;
        if (mode === 'deviceType') decision.deviceIdBefore = 42 as never;
        if (mode === 'timestamp') decision.preparedAt = 'invalid';
        if (mode === 'extra') Object.assign(decision, { deviceIdToInitialize: 'fabricated' });
        if (mode === 'request') envelope.request.checkpoint.generation++;
        const reads = vi.spyOn(env.adapter, 'getData');
        reject(env.host.validatePreparedOwnedEditorFileEditTaskDraftSave(envelope));
        reject(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope));
        expect(reads).not.toHaveBeenCalled(); expect(env.writes).not.toHaveBeenCalled();
    });

    it('validates historical no-op without checking current task or current policy', async () => {
        const envelope = await noopPlan(), before = env.host.validatePreparedOwnedEditorFileEditTaskDraftSave(envelope);
        env.db.prepare('UPDATE tasks SET status = ?, title = ? WHERE id = ?').run('archived', 'Later', 'edit');
        env.control.blocked = true; vi.setSystemTime('2027-01-01T00:00:00.000Z');
        expect(env.host.validatePreparedOwnedEditorFileEditTaskDraftSave(envelope)).toEqual(before);
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: false });
    });

    it('keeps every legacy public prepared grammar sealed', async () => {
        const input = await request(), envelope = await plan(input);
        reject(await env.baseHost.prepareTaskDraftSaveV2(input.saveRequest));
        reject(env.baseHost.prepareTaskDraftSave(input.saveRequest));
        reject(env.baseHost.validatePreparedTaskDraftSave({ request: input.saveRequest, prepared: envelope.prepared } as never));
        reject(await env.baseHost.commitPreparedTaskDraftSave({ request: input.saveRequest, prepared: envelope.prepared } as never));
        expect(env.writes).not.toHaveBeenCalled();
    });

    it.each(['raw', 'half', 'history', 'lifecycle', 'checklist', 'sheet', 'extra'])('refuses incomplete correspondence/grammar %s', async (mode) => {
        const input = await request(undefined, ['baseline-file'], { title: 'Edited' });
        if (mode === 'raw' || mode === 'sheet') {
            const p = JSON.parse(input.checkpoint.payloadJSON);
            if (mode === 'raw') p.raw.note = 'Unrepresented'; else p.linkSheet = { visible: true };
            input.checkpoint.payloadJSON = JSON.stringify(p); input.ownedDraft.beforePayloadJSON = input.checkpoint.payloadJSON;
        }
        if (mode === 'half') input.saveRequest.attachments.value = input.saveRequest.attachments.base;
        if (mode === 'history') input.ownedDraft.priorOperations = [];
        if (mode === 'lifecycle') {
            Object.assign(input.saveRequest.base, { status: 'next' });
            Object.assign(input.saveRequest.patch, { status: 'done' });
        }
        if (mode === 'checklist') Object.assign(input.saveRequest, { checklist: [] });
        if (mode === 'extra') Object.assign(input, { ownsFiles: true });
        reject(await env.host.prepareOwnedEditorFileEditTaskDraftSave(input)); expect(env.writes).not.toHaveBeenCalled();
    });

    it('captures the complete request before awaiting authoritative data', async () => {
        const input = await request(undefined, ['baseline-file'], { title: 'Edited' }), expected = clone(input);
        const original = env.adapter.getData.bind(env.adapter);
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
        vi.spyOn(env.adapter, 'getData').mockImplementationOnce(async (options) => { entered(); await gate; return original(options); });
        const preparing = env.host.prepareOwnedEditorFileEditTaskDraftSave(input); await started;
        input.saveRequest.patch.title = 'Changed caller'; input.checkpoint.generation++;
        release(); const response = await preparing;
        expect(response).toMatchObject({ ok: true }); if (!response.ok) throw new Error('Fixture');
        expect(response.value.prepared.request).toEqual(expected); expect(env.writes).not.toHaveBeenCalled();
    });

    it('refuses getters, inherited hooks, aliased graphs and UTF8/list bounds before IO', async () => {
        const input = await request(), reads = vi.spyOn(env.adapter, 'getData'), getter = vi.fn(() => input.saveRequest);
        const bad = { ...input }; Object.defineProperty(bad, 'saveRequest', { enumerable: true, get: getter });
        reject(await env.host.prepareOwnedEditorFileEditTaskDraftSave(bad)); expect(getter).not.toHaveBeenCalled();
        const inherited = clone(input), hook = vi.fn();
        Object.setPrototypeOf(inherited.ownedDraft.priorOperations, Object.create(Array.prototype, { toJSON: { get: hook } }));
        reject(await env.host.prepareOwnedEditorFileEditTaskDraftSave(inherited)); expect(hook).not.toHaveBeenCalled();
        let graph: unknown = { leaf: true }; for (let n = 0; n < 30; n++) graph = { left: graph, right: graph };
        reject(await env.host.prepareOwnedEditorFileEditTaskDraftSave({ ...input, graph } as never));
        const huge = clone(input); huge.checkpoint.payloadJSON = '界'.repeat(333_334);
        reject(await env.host.prepareOwnedEditorFileEditTaskDraftSave(huge));
        const rows = clone(input); rows.saveRequest.attachments.value = Array.from({ length: 1001 }, (_, n) => ({ ...file, id: String(n) }));
        reject(await env.host.prepareOwnedEditorFileEditTaskDraftSave(rows));
        expect(reads).not.toHaveBeenCalled(); expect(env.writes).not.toHaveBeenCalled();
    });

    it('retains full envelope failed-save identity across retry', async () => {
        const envelope = await plan(), before = rows(); env.fault.commits = 10;
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(rows()).toEqual(before); env.fault.commits = 0;
        const other = clone(envelope); other.request.checkpoint.sessionID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        other.prepared.request = clone(other.request);
        expect(env.host.validatePreparedOwnedEditorFileEditTaskDraftSave(other)).toMatchObject({ ok: true });
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(other)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(rows()).toEqual(before);
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: true });
    }, 30_000);

    it('cold-replays a reached COMMIT with lost acknowledgment and refuses a later raw edit', async () => {
        const envelope = await plan(); env.fault.after = 10;
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        env.fault.after = 0; const saved = rows(); env = await open(path);
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: true });
        expect(rows()).toEqual(saved); expect(env.writes).not.toHaveBeenCalled();
        env.db.prepare('UPDATE tasks SET title = ?, rev = ? WHERE id = ?').run('Intervening', 99, 'edit');
        const changed = rows(); env = await open(path);
        expect(await env.host.commitPreparedOwnedEditorFileEditTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(rows()).toEqual(changed); expect(env.writes).not.toHaveBeenCalled();
    }, 30_000);
});
