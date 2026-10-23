import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { resolveTaskEditorBackdatedCompletion } from './task-editor-model';
import type { NativeReferenceTaskBackdateEnvelope, NativeReferenceTaskBackdateRequest } from './native-host-contract-task-checklist';
import type { AppData, Task } from './types';
import { retainTaxonomyEffects } from './taxonomy-catalog';
// Raw-byte preservation cases catalog existing labels before their baseline; legacy RN/native parity cases remain uncatalogued.

const uuidState = vi.hoisted(() => ({ count: 0 }));
vi.mock('./uuid', async original => ({ ...await original<typeof import('./uuid')>(),
    generateUUID: () => `00000000-0000-4000-8000-${String(300 + uuidState.count++).padStart(12, '0')}` }));
const NOW = '2026-10-03T13:00:00.000Z';
const CHOSEN = '2026-10-02T09:12:34.789Z';
const ID = 'reference-backdate';
const UUID = '00000000-0000-4000-8000-000000000189';
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (patch: Partial<Task> = {}): Task => ({
    id: ID, title: '  Reference completion  ', status: 'reference', description: 'Retain memo and metadata',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z', rev: 3, revBy: 'device-a',
    tags: ['#first', '#second'], contexts: ['@home'], projectId: 'parent', sectionId: 'section',
    order: 2, orderNum: 2, boardOrder: 7, timeSpentMinutes: 45,
    checklist: [{ id: 'duplicate', title: 'Keep', isCompleted: true }, { id: 'duplicate', title: '  ', isCompleted: false }],
    attachments: [{ id: 'attachment', kind: 'file', title: 'proof.txt', uri: 'file:///proof.txt', createdAt: NOW, updatedAt: NOW }],
    ...patch,
});
const seed = (source = task(), enabled = false): Partial<AppData> => ({
    tasks: [source],
    projects: [{ id: 'parent', title: 'Parent', status: 'active', color: '#94a3b8', order: 0, tagIds: [],
        createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a' }],
    sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }],
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: NOW, updatedAt: NOW }],
    people: [{ id: 'person', name: 'Person', createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: UUID, features: { pomodoro: enabled },
        gtd: { autoArchiveDays: 1, focusTaskLimit: 1, pomodoro: { linkTask: enabled } } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const tables = ['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'];
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(tables.map(async table => [table,
    { schema: await sqlite.sql(`PRAGMA table_info(${table})`), rows: await sqlite.sql(`SELECT rowid AS evidenceRowid,* FROM ${table} ORDER BY rowid`) }])));
const rows = () => { const s = useTaskStore.getState(); return JSON.parse(JSON.stringify({ tasks: s._allTasks, projects: s._allProjects,
    sections: s._allSections, areas: s._allAreas, people: s._allPeople, settings: s.settings })) as AppData; };
const displayed = () => ({ id: ID, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!) });
const request = (timeSpentText: string | null = null, completedAt = CHOSEN): NativeReferenceTaskBackdateRequest => ({
    ...displayed(), requestId: UUID, source: 'reference', completedAt, timeSpentText,
});
const prepare = async (sqlite: Sqlite, input = request()): Promise<NativeReferenceTaskBackdateEnvelope> => {
    const result = value(await sqlite.host.prepareReferenceTaskBackdate(input));
    return { request: input, prepared: result.prepared };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('Reference backdate uses the exact RN row-completion patch without Undo', () => {
    it('returns null current-time seed and normalized minutes without any write or device initialization', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ completedAt: CHOSEN, timeSpentMinutes: 100_005 }), true));
        try {
            useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, deviceId: undefined } });
            const before = await raw(sqlite); const options = value(sqlite.host.getReferenceTaskBackdateOptions(displayed()));
            expect(Object.keys(options).sort()).toEqual(['title', 'saveLabel', 'cancelLabel', 'taskId', 'taskRevision', 'initialValue',
                'initialEpochMilliseconds', 'showTimeSpent', 'initialTimeSpentMinutes', 'timeSpentLabel', 'timeSpentPlaceholder'].sort());
            expect(options).toMatchObject({ taskId: ID, initialValue: null, initialEpochMilliseconds: null, showTimeSpent: true, initialTimeSpentMinutes: 100_000 });
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each([
        ['hidden preserves', null, false], ['blank clears', '', true], ['leading zero', '00073', true],
        ['clamps', '100001', true], ['zero clears', '0', true], ['shared digit extraction', '1a2', true],
    ] as const)('matches actual RN full content and all nine raw tables: %s', async (_name, text, enabled) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const source = task({ isFocusedToday: true, focusOrder: 2, completedAt: '2020-01-01T00:00:00.123Z' });
        const rn = await openSqliteHost(seed(source, enabled)); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try {
            const patch = resolveTaskEditorBackdatedCompletion({ completedAt: CHOSEN, ...(text !== null ? { timeSpentText: text } : {}) })!;
            expect(await useTaskStore.getState().updateTask(ID, patch)).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed(source, enabled));
        try {
            const envelope = await prepare(native, request(text));
            expect(Object.keys(envelope.prepared).sort()).toEqual(['version', 'kind', 'request', 'rawBefore', 'checklist', 'result'].sort());
            expect(envelope.prepared).toMatchObject({ version: 2, kind: 'referenceBackdate', result: { id: ID }, checklist: { request: { intent: 'referenceBackdate' } } });
            expect(value(native.host.validatePreparedReferenceTaskBackdate(envelope))).toEqual({ id: ID });
            expect(value(await native.host.commitPreparedReferenceTaskBackdate(envelope))).toEqual({ id: ID });
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect(rows().tasks.find(row => row.id === ID)).toMatchObject({ status: 'done', completedAt: CHOSEN, isFocusedToday: false });
            expect(envelope.prepared.result).not.toHaveProperty('completion');
            if (text === '') expect(envelope.prepared.checklist.witness.directClears).toContain('timeSpentMinutes');
        } finally { await native.close(); }
    });
    it.each([
        ['strict date-only', { recurrence: { rule: 'daily', strategy: 'strict', seriesId: ID }, dueDate: '2026-10-01' }],
        ['after-completion date-only', { recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01' }],
        ['after-completion datetime DST', { recurrence: { rule: 'weekly', strategy: 'after-completion', seriesId: ID }, startTime: '2026-09-01T09:12:34.789Z', dueDate: '2026-09-02T09:12:34.789Z' }],
        ['COUNT exhausted', { recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID, count: 1 } }],
    ] as const)('anchors recurrence to selected time and matches actual RN all rows: %s', async (_name, patch) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); uuidState.count = 0;
        const source = task(patch as Partial<Task>); const rn = await openSqliteHost(seed(source));
        let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try { expect(await useTaskStore.getState().updateTask(ID, { status: 'done', completedAt: CHOSEN })).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); } finally { await rn.close(); }
        uuidState.count = 0; const native = await openSqliteHost(seed(source));
        try { const envelope = await prepare(native); value(await native.host.commitPreparedReferenceTaskBackdate(envelope));
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect(new Set(rows().tasks.map(row => row.id)).size).toBe(rows().tasks.length);
            value(await native.host.commitPreparedReferenceTaskBackdate(envelope)); expect(rows()).toEqual(expected!);
        } finally { await native.close(); }
    });
    it.each(['2026-11-01T05:30:00.789Z', '+020000-01-01T00:00:00.123Z'])('commits exact canonical milliseconds/extended instant %s', async instant => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const envelope = await prepare(sqlite, request(null, instant)); value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope));
            expect(useTaskStore.getState()._tasksById.get(ID)?.completedAt).toBe(instant);
        } finally { await sqlite.close(); }
    });
    it('rejects noncanonical, oversized, omitted, unknown and feature-mismatched requests before any effect', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const valid = request(); const { timeSpentText: _removed, ...missing } = valid; void _removed;
            const before = await raw(sqlite);
            for (const malformed of [missing, { ...valid, completedAt: '2026-10-02' }, { ...valid, completedAt: '2026-10-02T09:12:34.789+00:00' },
                { ...valid, timeSpentText: '1' }, { ...valid, timeSpentText: '1'.repeat(201) }, { ...valid, source: 'done' },
                { ...valid, requestId: 'AAAAAAAA-0000-4000-8000-000000000189' }, { ...valid, editorDraftId: UUID }])
                expect(await sqlite.host.prepareReferenceTaskBackdate(malformed as NativeReferenceTaskBackdateRequest)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('binds current enabled flag at preparation and durable commit, preserving harmless settings changes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed(task(), true));
        try {
            expect(await sqlite.host.prepareReferenceTaskBackdate(request(null))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const envelope = await prepare(sqlite, request('25'));
            const [settingsRow] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1');
            const settings = retainTaxonomyEffects(JSON.parse(settingsRow.data), rows().tasks.map(row => ({ before: row, after: row }))); settings.features.pomodoro = false;
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            settings.features.pomodoro = true; settings.gtd.autoArchiveDays = 99; settings.showCompleted = true;
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope));
            const [after] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); expect(JSON.parse(after.data)).toEqual(settings);
        } finally { await sqlite.close(); }
    });
    it('rejects stale display and effective archived Section parent without any SQL mutation', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const before = await raw(sqlite);
            expect(sqlite.host.getReferenceTaskBackdateOptions({ ...displayed(), taskRevision: 'old' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            useTaskStore.setState({ _allProjects: useTaskStore.getState()._allProjects.map(row => ({ ...row, status: 'archived' as const })) });
            expect(sqlite.host.getReferenceTaskBackdateOptions(displayed())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.host.prepareReferenceTaskBackdate(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each(['missing-to-empty', 'empty-to-missing'] as const)('binds exact raw attachment member presence across true recoveryLoad: %s', async direction => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const attachment = { id: 'attachment', kind: 'file', title: 'proof.txt', uri: 'file:///proof.txt', createdAt: NOW };
            const initial = direction === 'missing-to-empty' ? attachment : { ...attachment, updatedAt: '' };
            const changed = direction === 'missing-to-empty' ? { ...attachment, updatedAt: '' } : attachment;
            await sqlite.client().run('UPDATE tasks SET attachments=? WHERE id=?', [JSON.stringify([initial]), ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const envelope = await prepare(sqlite);
            await sqlite.client().run('UPDATE tasks SET attachments=? WHERE id=?', [JSON.stringify([changed]), ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('preserves raw siblings/settings/filters through repeated COMMIT failures, exact retry and cold replay', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); uuidState.count = 0;
        const fault = { commits: 0 }; const sqlite = await openSqliteHost({ ...seed(task({ recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01' })),
            tasks: [task({ recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01' }), task({ id: 'raw-sibling', order: 8 })] },
            client => ({ ...client, run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('owned COMMIT failure'); } return client.run(sql, params); } }));
        try {
            await sqlite.client().run('UPDATE tasks SET pushCount=NULL,focusOrder=2,attachments=? WHERE id=?',
                ['[{"id":"legacy","kind":"file","title":"old.txt","uri":"file:///old.txt","createdAt":"2026-10-03T13:00:00.000Z"}]', 'raw-sibling']);
            const [saved] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = retainTaxonomyEffects(JSON.parse(saved.data), rows().tasks.map(row => ({ before: row, after: row })));
            settings.savedFilters = [{ id: 'raw-filter', name: 'Raw', view: 'tasks', criteria: { tags: ['#first'] }, createdAt: NOW, updatedAt: NOW }];
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings, null, 2)]);
            await sqlite.client().run('INSERT INTO saved_filters (id,name,view,criteria,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
                ['raw-filter', 'Raw', 'tasks', '{ "tags" : [ "#first" ] }', NOW, NOW]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const envelope = await prepare(sqlite);
            const checkpoint = join(sqlite.dir, 'before-backdate.sqlite'); await sqlite.client().run('VACUUM INTO ?', [checkpoint]);
            const before = await raw(sqlite); value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope));
            const expected = await raw(sqlite); const receipts = await sqlite.sql('SELECT rowid,* FROM native_request_receipts ORDER BY rowid');
            expect(expected.settings).toEqual(before.settings); expect(expected.saved_filters).toEqual(before.saved_filters);
            expect(expected.tasks.rows.find((row: Record<string, unknown>) => row.id === 'raw-sibling')).toEqual(before.tasks.rows.find((row: Record<string, unknown>) => row.id === 'raw-sibling'));
            await sqlite.restart(checkpoint, { recoveryLoad: true }); fault.commits = 10;
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            fault.commits = 10; expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); fault.commits = 0;
            value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)); expect(await raw(sqlite)).toEqual(expected);
            expect(await sqlite.sql('SELECT rowid,* FROM native_request_receipts ORDER BY rowid')).toEqual(receipts);
            await sqlite.restart(checkpoint, { recoveryLoad: true }); fault.commits = 10;
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.commits = 0;
            resetForTests(); await sqlite.restart(undefined, { recoveryLoad: true }); value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope));
            expect(await raw(sqlite)).toEqual(expected); expect(await sqlite.sql('SELECT rowid,* FROM native_request_receipts ORDER BY rowid')).toEqual(receipts);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);
    it('uses exact durable receipt before later edits/feature changes and never treats equal AFTER as proof', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed(task(), true));
        try {
            const envelope = await prepare(sqlite, request('25')); value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope));
            const unused = JSON.parse(JSON.stringify(envelope)); unused.request.requestId = '00000000-0000-4000-8000-000000000998';
            unused.prepared.request.requestId = unused.request.requestId; unused.prepared.checklist.request.requestId = unused.request.requestId;
            const equalAfter = await raw(sqlite);
            expect(value(sqlite.host.referenceTaskBackdateOutcome(unused))).toBeNull();
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(unused)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(equalAfter); expect(await sqlite.receiptIds()).toEqual([UUID]);
            await sqlite.client().run('UPDATE tasks SET status=?,description=?,rev=rev+1 WHERE id=?', ['reference', 'Later edit', ID]);
            const [saved] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = JSON.parse(saved.data); settings.features.pomodoro = false;
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(value(sqlite.host.referenceTaskBackdateOutcome(envelope))).toEqual({ id: ID });
            expect(value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope))).toEqual({ id: ID });
            expect(await raw(sqlite)).toEqual(before);
            const forged = JSON.parse(JSON.stringify(envelope)); forged.request.requestId = '00000000-0000-4000-8000-000000000999';
            forged.prepared.request.requestId = forged.request.requestId; forged.prepared.checklist.request.requestId = forged.request.requestId;
            expect(value(sqlite.host.referenceTaskBackdateOutcome(forged))).toBeNull();
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(forged)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { await sqlite.close(); }
    });
    it('rejects malformed prepared patches/clears/child bindings before SQL or receipt', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed(task(), true));
        try {
            const envelope = await prepare(sqlite, request('')); const before = await raw(sqlite);
            for (const mutate of [
                (x: NativeReferenceTaskBackdateEnvelope) => { x.prepared.result.id = 'other'; },
                (x: NativeReferenceTaskBackdateEnvelope) => { x.prepared.checklist.witness.directClears = []; },
                (x: NativeReferenceTaskBackdateEnvelope) => { x.prepared.checklist.request.patch.completedAt = NOW; },
                (x: NativeReferenceTaskBackdateEnvelope) => { x.prepared.rawBefore.tasks[0].before!.focusOrder = 99; },
                (x: NativeReferenceTaskBackdateEnvelope) => { x.prepared.checklist.witness.settings.features = { pomodoro: false }; },
            ]) { const forged = JSON.parse(JSON.stringify(envelope)); mutate(forged);
                expect(sqlite.host.validatePreparedReferenceTaskBackdate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await sqlite.host.commitPreparedReferenceTaskBackdate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('rechecks the minutes feature on an owned failed-save retry and can save only after the exact gate returns', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(task(), true), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('owned COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            const envelope = await prepare(sqlite, request('25')); fault.commits = 10;
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.commits = 0;
            const [saved] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = retainTaxonomyEffects(JSON.parse(saved.data), rows().tasks.map(row => ({ before: row, after: row })));
            settings.gtd.pomodoro.linkTask = false; await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(sqlite.host.referenceTaskBackdateOutcome(envelope))).toBeNull();
            settings.gtd.pomodoro.linkTask = true; settings.features.priorities = false; settings.features.timeline = true;
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope));
            expect(await sqlite.receiptIds()).toEqual([UUID]); expect(useTaskStore.getState()._tasksById.get(ID)?.timeSpentMinutes).toBe(25);
            const [final] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); expect(JSON.parse(final.data)).toEqual(settings);
        } finally { fault.commits = 0; await sqlite.close(); }
    });
    it('binds missing-device initialization once across failed COMMIT and a recreated host', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('owned COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            const [saved] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = JSON.parse(saved.data); delete settings.deviceId;
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            await sqlite.restart(undefined, { recoveryLoad: true }); uuidState.count = 0;
            const envelope = await prepare(sqlite); expect(envelope.prepared.checklist.effect.deviceIdBefore).toBeNull();
            const device = envelope.prepared.checklist.effect.deviceIdToInitialize; expect(device).toMatch(/^[0-9a-f-]{36}$/);
            const checkpoint = join(sqlite.dir, 'before-device.sqlite'); await sqlite.client().run('VACUUM INTO ?', [checkpoint]);
            value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)); const expected = await raw(sqlite);
            const receipts = await sqlite.sql('SELECT rowid,* FROM native_request_receipts ORDER BY rowid');
            expect(useTaskStore.getState().settings.deviceId).toBe(device);
            await sqlite.restart(checkpoint, { recoveryLoad: true }); const before = await raw(sqlite); fault.commits = 10;
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); fault.commits = 0; resetForTests();
            await sqlite.restart(undefined, { recoveryLoad: true }); value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope));
            expect(await raw(sqlite)).toEqual(expected); expect(useTaskStore.getState().settings.deviceId).toBe(device);
            expect(await sqlite.sql('SELECT rowid,* FROM native_request_receipts ORDER BY rowid')).toEqual(receipts);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 15_000);
    it('refuses a same-revision raw source drift or device conflict without accepting an unused UUID', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed(task({ focusOrder: 2 })));
        try {
            const envelope = await prepare(sqlite); await sqlite.client().run('UPDATE tasks SET focusOrder=3 WHERE id=?', [ID]);
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('UPDATE tasks SET focusOrder=2 WHERE id=?', [ID]);
            const [saved] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = JSON.parse(saved.data); settings.deviceId = 'other-device';
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]); const changed = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(changed); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('refuses a current archived effective Section parent and generated-ID collision before any overwrite', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); uuidState.count = 0;
        const sqlite = await openSqliteHost(seed(task({ projectId: undefined, recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01' })));
        try {
            const envelope = await prepare(sqlite); await sqlite.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'parent']);
            const archived = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(archived); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('UPDATE projects SET status=? WHERE id=?', ['active', 'parent']);
            const child = envelope.prepared.rawBefore.tasks.find(row => row.before === null)!; expect(child).toBeDefined();
            await sqlite.client().run('INSERT INTO tasks (id,title,status,createdAt,updatedAt,rev,revBy,tags,contexts) VALUES (?,?,?,?,?,?,?,?,?)',
                [child.id, 'Existing different child', 'next', NOW, NOW, 99, 'other-device', '[]', '[]']); const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
});
