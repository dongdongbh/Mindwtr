import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeHostContract } from './native-host-contract';
import { prepareNativeAttachmentDraftAddV2, type NativeAttachmentDraftPrepared } from './native-attachment-draft';
import { ASSOCIATIONS, RECURRENCE, SCHEDULE, getNativeTaskRecurrenceBase, getNativeTaskScheduleBase, readNativeTaskDraftSaveRequest } from './native-host-contract-task-save';
import type { OwnedEditorFileAddSaveRequest, PreparedOwnedEditorFileAddSave } from './native-host-contract-owned-editor-save';
import { NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { SqliteClient } from './sqlite-adapter';
import * as upload from './attachment-validation';
import { createTaskDraft, type TaskDraft } from './task-draft';
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
const root = join(process.cwd(), '../../.orchestrator/tmp');
mkdirSync(root, { recursive: true });
const directories: string[] = [], databases: Database[] = [];
const faults: { commits: number; after: number }[] = [];
async function open(path: string, initial?: AppData) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA synchronous = OFF');
    databases.push(db);
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
async function request(base = task().attachments!, count = 1, edits: Partial<TaskDraft> = {}): Promise<OwnedEditorFileAddSaveRequest> {
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
    const priorAdditions: NativeAttachmentDraftPrepared[] = [];
    let beforePayloadJSON = initialPayloadJSON;
    for (let index = 0; index < count; index++) {
        const requestId = index === 0 ? ID : `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;
        const result = await prepareNativeAttachmentDraftAddV2({ version: 2, taskID: 'edit', initialPayloadJSON, beforePayloadJSON,
            priorAdditions, managedDirectoryURI: ROOT, requestId, picked: { uri: `file:///cache/${index}.pdf`, name: 'Report.pdf', mimeType: null, size: 3 },
            measuredSize: 3 }, { assertEditable: () => {}, t: (key) => key });
        if (result.kind !== 'prepared') throw new Error('Fixture preparation refused');
        priorAdditions.push(result); beforePayloadJSON = result.afterPayloadJSON;
    }
    const changed = new Set(touched.filter((field) => !taskEditValuesEqual(touchedBase[field], edited[field])));
    for (const group of [ASSOCIATIONS, RECURRENCE]) if (group.some((field) => changed.has(field))) group.forEach((field) => changed.add(field));
    return clone({ version: 1, kind: 'owned-editor-file-add-save', checkpoint: { version: 1, sessionID: SESSION, taskID: 'edit', generation: count + 1,
        payloadJSON: beforePayloadJSON }, ownedDraft: { version: 2, taskID: 'edit', initialPayloadJSON, beforePayloadJSON,
        priorAdditions, managedDirectoryURI: ROOT }, saveRequest: { id: 'edit',
        base: Object.fromEntries([...changed].map((field) => [field, touchedBase[field]])), patch: Object.fromEntries([...changed].map((field) => [field, edited[field]])),
        scheduleBase: getNativeTaskScheduleBase(raw), ...(recurrenceOwned && RECURRENCE.some((field) => changed.has(field))
            ? { recurrenceBase: getNativeTaskRecurrenceBase({ ...raw, recurrence: normalizeRecurrenceForLoad(raw.recurrence) }) } : {}),
        attachments: { base, value: JSON.parse(beforePayloadJSON).attachments } } }) as OwnedEditorFileAddSaveRequest;
}
async function plan(value?: OwnedEditorFileAddSaveRequest) {
    const input = value ?? await request();
    const result = await env.host.prepareOwnedEditorFileAddTaskDraftSave(input);
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

const changeCheckpoint = (input: OwnedEditorFileAddSaveRequest, mutate: (payload: Record<string, unknown>) => void) => {
    const payload = JSON.parse(input.checkpoint.payloadJSON) as Record<string, unknown>; mutate(payload);
    input.checkpoint.payloadJSON = JSON.stringify(payload); input.ownedDraft.beforePayloadJSON = input.checkpoint.payloadJSON;
};
describe('unbound full ordinary owned-editor file Add Save authority', () => {
    it('saves a real combined ordinary editor checkpoint and replays the exact frozen ordinary effect cold', async () => {
        const data = seed();
        data.projects.push({ id: 'target', title: 'Target', status: 'active', color: '#000000', order: 1, createdAt: AT, updatedAt: AT });
        data.sections.push({ id: 'section', projectId: 'target', title: 'Section', order: 0, createdAt: AT, updatedAt: AT });
        await env.adapter.saveData(data); env.writes.mockClear();
        const input = await request(undefined, 2, { title: 'Edited', description: 'New notes\nTwo', location: 'Office', assignedTo: 'Literal person',
            timeEstimate: 'custom:45', timeSpentMinutes: 12, contexts: '@x, @office', tags: '#one, #two', priority: 'high', energyLevel: 'low',
            projectId: 'target', sectionId: 'section', areaId: '', dueDate: '2026-10-10', relativeStartOffset: { amount: -2, unit: 'day' },
            recurrence: 'weekly', recurrenceStrategy: 'strict', recurrenceRRule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4', showFutureRecurrence: true });
        const envelope = await plan(input);
        const expected = env.host.validatePreparedOwnedEditorFileAddTaskDraftSave(envelope); expect(expected).toMatchObject({ ok: true });
        expect(envelope.prepared.effect.task.after).toMatchObject({ title: 'Edited', description: 'New notes\nTwo', location: 'Office',
            assignedTo: 'Literal person', timeEstimate: 'custom:45', timeSpentMinutes: 12, projectId: 'target', sectionId: 'section',
            recurrence: { rule: 'weekly', strategy: 'strict', rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;X-MINDWTR-SERIES-ID=edit' }, rev: 9 });
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope)).toEqual(expected.ok ? { ok: true, value: expected.value.result } : null);
        const saved = rows(); env = await open(path);
        expect(env.host.validatePreparedOwnedEditorFileAddTaskDraftSave(envelope)).toEqual(expected);
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope)).toEqual(expected.ok ? { ok: true, value: expected.value.result } : null);
        expect(rows()).toEqual(saved); expect(env.writes).not.toHaveBeenCalled();
    });

    it('preserves normalized no-op ownership and refuses stale opening despite an empty field patch', async () => {
        await env.adapter.saveData(seed({ timeSpentMinutes: 17.6 }));
        const input = await request(undefined, 1, { title: 'Saved task', timeSpentMinutes: 18 });
        expect(input.saveRequest.patch).toEqual({}); expect(await env.host.prepareOwnedEditorFileAddTaskDraftSave(input)).toMatchObject({ ok: true });
        env.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Intervening title', 'edit'); env.writes.mockClear();
        const before = rows(); reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(input));
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });

    it('retains latest opaque ordinary checkpoint bytes instead of claiming metadata history represents every editor edit', async () => {
        const input = await request(undefined, 1, { title: 'Edited' });
        changeCheckpoint(input, (payload) => { payload.raw = { ...(payload.raw as object), note: 'Unrepresented raw note' }; });
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(input)); expect(env.writes).not.toHaveBeenCalled();
    });

    it.each(['rawTitle', 'rawMinutes', 'tokenPending', 'longToken', 'relativePending', 'recurrencePending', 'queue', 'sheet',
        'checklist', 'lifecycle', 'unknown', 'missing', 'noOpInjection', 'changedOmission', 'wrongBase', 'scheduleWitness', 'unownedField'])(
        'refuses complete-lineage editor/request mismatch without mutation: %s', async (kind) => {
            const input = await request(undefined, 1, { title: 'Edited' });
            changeCheckpoint(input, (payload) => {
                const raw = payload.raw as Record<string, unknown>;
                if (kind === 'rawTitle') raw.title = 'Wrong';
                if (kind === 'rawMinutes') raw.timeSpent = '12';
                if (kind === 'tokenPending') raw.tokenEdited = ['tags'];
                if (kind === 'longToken') {
                    const text = 'raw duplicate '.repeat(160);
                    (payload.touchedBase as Record<string, unknown>).tags = '#legacy'; (payload.edited as Record<string, unknown>).tags = text;
                    raw.tokens = { tags: text }; raw.tokenCanonical = { tags: text }; raw.tokenResolved = { tags: text }; raw.tokenEdited = ['tags'];
                    input.saveRequest.base.tags = '#legacy'; input.saveRequest.patch.tags = text;
                }
                if (kind === 'relativePending') raw.relativeOwned = true;
                if (kind === 'recurrencePending') raw.recurrenceInputs = { interval: '3' };
                if (kind === 'queue') payload.scheduleEdits = [{}];
                if (kind === 'sheet') payload.linkSheet = { title: 'Pending' };
                if (kind === 'checklist') payload.checklistBase = [];
                if (kind === 'lifecycle') { (payload.touchedBase as Record<string, unknown>).status = 'next'; (payload.edited as Record<string, unknown>).status = 'done'; }
                if (kind === 'unknown') payload.future = true;
                if (kind === 'missing') delete raw.estimate;
            });
            if (kind === 'noOpInjection') { input.saveRequest.base.location = ''; input.saveRequest.patch.location = ''; }
            if (kind === 'changedOmission') { delete input.saveRequest.base.title; delete input.saveRequest.patch.title; }
            if (kind === 'wrongBase') input.saveRequest.base.title = 'Forged';
            if (kind === 'scheduleWitness') input.saveRequest.scheduleBase.dueDate = '2026-11-05';
            if (kind === 'unownedField') { input.saveRequest.base.location = ''; input.saveRequest.patch.location = 'Injected'; }
            const before = rows(); expect(await env.host.prepareOwnedEditorFileAddTaskDraftSave(input)).toMatchObject({ ok: false });
            expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
        });

    it('refuses coherent tampered raw checkpoint on every prepared read and never degrades to a partial Save', async () => {
        const envelope = await plan(await request(undefined, 1, { title: 'Edited' }));
        changeCheckpoint(envelope.request, (payload) => { (payload.raw as Record<string, unknown>).note = 'Unsaved'; });
        envelope.prepared.request = clone(envelope.request);
        reject(env.host.validatePreparedOwnedEditorFileAddTaskDraftSave(envelope));
        const before = rows(); reject(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope));
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });

    it('keeps Task230 minimal full-UI admission sealed even when ordinary fields are empty', async () => {
        const input = await request();
        const minimum = clone(input) as unknown as Record<string, unknown>; minimum.kind = 'owned-file-add-save';
        (minimum.ownedDraft as Record<string, unknown>).version = 1;
        reject(await env.host.prepareOwnedFileAddTaskDraftSave(minimum as never));
        const envelope = await plan(input);
        reject(env.host.validatePreparedOwnedFileAddTaskDraftSave(envelope as never));
        reject(await env.host.commitPreparedOwnedFileAddTaskDraftSave(envelope as never)); expect(env.writes).not.toHaveBeenCalled();
    });

    it('saves ordered frozen additions through actual SQLite and replays cold without writes', async () => {
        const input = await request(undefined, 2), before = rows();
        const policy = vi.spyOn(upload, 'validateAttachmentForUpload').mockRejectedValue(new Error('must not run'));
        const prepared = await plan(input);
        const expected = env.host.validatePreparedOwnedEditorFileAddTaskDraftSave(prepared);
        expect(expected).toMatchObject({ ok: true, value: { version: 1, kind: 'owned-editor-file-add-save', result: { id: 'edit' } } });
        vi.setSystemTime('2026-11-05T00:00:00.000Z');
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(prepared)).toEqual(expected.ok ? { ok: true, value: expected.value.result } : null);
        const after = rows(); expect(after).not.toEqual(before);
        expect(after.find((row) => (row as Task).id === 'other')).toEqual(before.find((row) => (row as Task).id === 'other'));
        const saved = (await env.adapter.getData({ rawTasks: true })).tasks.find((item) => item.id === 'edit')!;
        expect(saved.attachments).toEqual(input.saveRequest.attachments.value);
        expect(saved).toMatchObject({ rev: 9, updatedAt: AT, revBy: 'owned-save-device', description: 'Retained notes' });
        expect(policy).not.toHaveBeenCalled();
        env = await open(path);
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(prepared)).toMatchObject({ ok: true });
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
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(prepared)).toMatchObject({ ok: true });
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

    it.each([
        (x: OwnedEditorFileAddSaveRequest) => { x.checkpoint.sessionID = SESSION.toUpperCase(); },
        (x: OwnedEditorFileAddSaveRequest) => { x.checkpoint.version = 2 as never; },
        (x: OwnedEditorFileAddSaveRequest) => { x.checkpoint.generation = 1; },
        (x: OwnedEditorFileAddSaveRequest) => { x.checkpoint.generation = 1.5; },
        (x: OwnedEditorFileAddSaveRequest) => { x.checkpoint.taskID = 'other'; },
        (x: OwnedEditorFileAddSaveRequest) => { x.checkpoint.payloadJSON += ' '; },
        (x: OwnedEditorFileAddSaveRequest) => { x.ownedDraft.taskID = 'other'; },
        (x: OwnedEditorFileAddSaveRequest) => { x.ownedDraft.priorAdditions = []; },
        (x: OwnedEditorFileAddSaveRequest) => { x.ownedDraft.priorAdditions = [...x.ownedDraft.priorAdditions, ...x.ownedDraft.priorAdditions]; },
        (x: OwnedEditorFileAddSaveRequest) => { x.ownedDraft.managedDirectoryURI = 'file:///private/../attachments/'; },
        (x: OwnedEditorFileAddSaveRequest) => { x.saveRequest.id = 'other'; },
        (x: OwnedEditorFileAddSaveRequest) => { x.saveRequest.attachments.value.pop(); },
        (x: OwnedEditorFileAddSaveRequest) => { x.saveRequest.attachments.base.reverse(); },
        (x: OwnedEditorFileAddSaveRequest) => { Object.assign(x.saveRequest, { ownership: true }); },
        (x: OwnedEditorFileAddSaveRequest) => { Object.assign(x.checkpoint, { raw: {} }); },
        (x: OwnedEditorFileAddSaveRequest) => { Object.assign(x, { ownership: true }); },
    ])('refuses mismatched identity/lineage/half/field grammar %#', async (mutate) => {
        const input = await request(); mutate(input);
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(input)); expect(env.writes).not.toHaveBeenCalled();
    });

    it.each([false, true])('never adopts an existing owned ID, even when metadata is identical=%s', async (identical) => {
        const input = await request(), added = input.ownedDraft.priorAdditions[0].attachment;
        await env.adapter.saveData(seed({ attachments: [...task().attachments!, identical ? added : { ...added, title: 'Foreign' }] }));
        env.writes.mockClear(); reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(input));
        expect(env.writes).not.toHaveBeenCalled();
    });

    it.each([
        (p: PreparedOwnedEditorFileAddSave) => { p.version = 2 as never; },
        (p: PreparedOwnedEditorFileAddSave) => { p.kind = 'other' as never; },
        (p: PreparedOwnedEditorFileAddSave) => { p.preparedAt = 'bad'; },
        (p: PreparedOwnedEditorFileAddSave) => { p.deviceIdToInitialize = 'both'; },
        (p: PreparedOwnedEditorFileAddSave) => { p.scope.sourceProject = { id: 'x' } as never; },
        (p: PreparedOwnedEditorFileAddSave) => { p.scope.nextProjectOrder = 4; },
        (p: PreparedOwnedEditorFileAddSave) => { p.effect.task.after.description = 'Forgery'; },
        (p: PreparedOwnedEditorFileAddSave) => { p.effect.task.after.attachments![0].title = 'Forgery'; },
        (p: PreparedOwnedEditorFileAddSave) => { p.effect.task.after.rev = 100; },
        (p: PreparedOwnedEditorFileAddSave) => { p.effect.task.before.id = 'other'; },
        (p: PreparedOwnedEditorFileAddSave) => { Object.assign(p.effect, { other: {} }); },
        (p: PreparedOwnedEditorFileAddSave) => { Object.assign(p, { extra: true }); },
        (p: PreparedOwnedEditorFileAddSave) => { p.request.checkpoint.generation++; },
    ])('strictly rederives every frozen boundary before mutation %#', async (mutate) => {
        const envelope = await plan(); mutate(envelope.prepared);
        reject(env.host.validatePreparedOwnedEditorFileAddTaskDraftSave(envelope));
        reject(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope)); expect(env.writes).not.toHaveBeenCalled();
    });

    it('captures before awaits, refuses a replaced adapter, and preserves wrong-workspace refusal', async () => {
        const input = await request();
        const original = env.adapter.getData.bind(env.adapter);
        const foreign = { getData: original, saveData: vi.fn() };
        vi.spyOn(env.adapter, 'getData').mockImplementation(async (options) => { setStorageAdapter(foreign); return original(options); });
        expect(await env.host.prepareOwnedEditorFileAddTaskDraftSave(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.writes).not.toHaveBeenCalled();
        const locked = createNativeHostContract();
        expect(await locked.prepareOwnedEditorFileAddTaskDraftSave(input)).toMatchObject({ ok: false });
        expect(foreign.saveData).not.toHaveBeenCalled();
    });

    it.each(['archived', 'deleted', 'scope', 'schedule'])('refuses changed %s before applying and preserves exact durable data', async (kind) => {
        const envelope = await plan();
        if (kind === 'archived') env.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('archived', 'edit');
        if (kind === 'deleted') env.db.prepare('UPDATE tasks SET deletedAt = ? WHERE id = ?').run(AT, 'edit');
        if (kind === 'schedule') env.db.prepare('UPDATE tasks SET dueDate = ? WHERE id = ?').run('2026-12-01', 'edit');
        if (kind === 'scope') env.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('archived', 'project');
        const before = rows(); env.writes.mockClear();
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });

    it('captures the complete request before an authoritative asynchronous read', async () => {
        const input = await request(undefined, 1, { title: 'Edited', description: 'New notes' }), originalInput = clone(input);
        let release!: () => void, entered!: () => void;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const originalRead = env.adapter.getData.bind(env.adapter);
        vi.spyOn(env.adapter, 'getData').mockImplementationOnce(async (options) => {
            entered(); await barrier; return originalRead(options);
        });
        const preparing = env.host.prepareOwnedEditorFileAddTaskDraftSave(input);
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
        expect(await env.host.prepareOwnedEditorFileAddTaskDraftSave(input)).toMatchObject({ ok: false, error: {
            code: kind === 'deleted' ? 'TASK_NOT_FOUND' : kind === 'readonly' ? 'INVALID_INPUT' : 'STALE_REVISION' } });
        expect(rows()).toEqual(before); expect(env.writes).not.toHaveBeenCalled();
    });

    it('rejects getters, sparse arrays, nonfinite values and unknown envelope keys before IO', async () => {
        const input = await request(), getter = vi.fn(() => input.saveRequest);
        const accessor = { ...input }; Object.defineProperty(accessor, 'saveRequest', { enumerable: true, get: getter });
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(accessor)); expect(getter).not.toHaveBeenCalled();
        const sparse = clone(input); sparse.saveRequest.attachments.value = new Array(3);
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(sparse));
        const infinite = clone(input); infinite.checkpoint.generation = Infinity;
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(infinite));
        const envelope = await plan(); Object.assign(envelope, { ownership: true });
        reject(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope)); expect(env.writes).not.toHaveBeenCalled();
    });

    it('refuses inherited array toJSON accessors before hooks or durable IO', async () => {
        const input = await request(), reads = vi.spyOn(env.adapter, 'getData'), hook = vi.fn(() => []);
        const inherited = Object.create(Array.prototype);
        Object.defineProperty(inherited, 'toJSON', { get: hook });
        Object.setPrototypeOf(input.ownedDraft.priorAdditions, inherited);
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(input));
        expect(hook).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(env.writes).not.toHaveBeenCalled();
    });

    it('bounds aliased object traversal before serialization or durable IO', async () => {
        const input = await request();
        let repeated: unknown = { leaf: true };
        for (let depth = 0; depth < 30; depth++) repeated = { left: repeated, right: repeated };
        const reads = vi.spyOn(env.adapter, 'getData');
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave({ ...input, extra: repeated } as never));
        expect(reads).not.toHaveBeenCalled();
        expect(env.writes).not.toHaveBeenCalled();
    });

    it('repairs exact failed SQLite Save only with the full original ownership envelope', async () => {
        const envelope = await plan(await request(undefined, 1, { title: 'Edited', description: 'New notes', timeSpentMinutes: 12 })), before = rows(); env.fault.commits = 10;
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(rows()).toEqual(before); expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
        env.fault.commits = 0;
        const other = clone(envelope); other.request.checkpoint.sessionID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        other.prepared.request = clone(other.request);
        expect(env.host.validatePreparedOwnedEditorFileAddTaskDraftSave(other)).toMatchObject({ ok: true });
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(other)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(rows()).toEqual(before);
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope)).toMatchObject({ ok: true });
        expect(useTaskStore.getState().persistenceFailure).toBeNull();
    }, 30_000);

    it('cold-replays actual COMMIT acknowledgment loss, then refuses intervening edits without rewriting', async () => {
        const envelope = await plan(await request(undefined, 1, { title: 'Edited', description: 'New notes', timeSpentMinutes: 12 })); env.fault.after = 10;
        const outcome = await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope);
        expect(outcome).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        env.fault.after = 0;
        const committed = rows();
        env = await open(path);
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope)).toMatchObject({ ok: true });
        expect(rows()).toEqual(committed); expect(env.writes).not.toHaveBeenCalled();
        env.db.prepare('UPDATE tasks SET title = ?, rev = ? WHERE id = ?').run('Intervening edit', 99, 'edit');
        const changed = rows(); env = await open(path);
        expect(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(rows()).toEqual(changed); expect(env.writes).not.toHaveBeenCalled();
    }, 30_000);

    it('refuses UTF8 payload, operation, list and full prepared ceilings before writes', async () => {
        const input = await request();
        const huge = clone(input); huge.checkpoint.payloadJSON = '界'.repeat(333_334);
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(huge));
        const tooMany = clone(input); tooMany.ownedDraft.priorAdditions = Array(129).fill(input.ownedDraft.priorAdditions[0]);
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(tooMany));
        const hugeList = clone(input); hugeList.saveRequest.attachments.value = Array.from({ length: 1001 }, (_, index) => ({ ...file, id: String(index) }));
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(hugeList));
        const envelope = await plan(); envelope.prepared.effect.task.before.description = '界'.repeat(6_000_000);
        reject(await env.host.commitPreparedOwnedEditorFileAddTaskDraftSave(envelope));
        env.db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run('界'.repeat(3_000_000), 'edit');
        reject(await env.host.prepareOwnedEditorFileAddTaskDraftSave(input));
        expect(env.writes).not.toHaveBeenCalled();
    });
});
