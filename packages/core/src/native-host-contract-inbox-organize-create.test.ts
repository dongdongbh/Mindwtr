import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost as openHost } from './screen-parity.replay';
import { NativeReceiptSqliteAdapter } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { buildSaveSnapshot } from './store-helpers';
import { EMPTY_BULK_ORGANIZE_DRAFT, BULK_ORGANIZE_KEEP, BULK_ORGANIZE_NONE, type BulkOrganizeDraft } from './task-list-bulk-actions';
import { createBulkOrganizeArea, createBulkOrganizeProject } from './bulk-organize-create';
import { DEFAULT_AREA_COLOR, DEFAULT_PROJECT_COLOR } from './color-constants';
import { referenceBatchModules } from './store-reference-batch-modules';
import type { AppData, Task } from './types';
import type { NativeInboxOrganizeDestinationCreateRequest as Request, NativeInboxOrganizeDestinationCreateEnvelope as Envelope } from './native-host-contract-inbox-organize-create';
import * as uuid from './uuid';
import * as logger from './logger';
const open: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
type Sqlite = Awaited<ReturnType<typeof open>>;
const NOW = '2026-10-18T12:00:00.000Z'; const OLD = '2026-10-17T10:00:00.000Z';
const ID = '00000000-0000-4000-8000-000000000743'; const DEVICE = 'create-device'; const TZ = process.env.TZ;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const value = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!r.ok) throw new Error(r.error.code + ': ' + r.error.message); return r.value;
};
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'inbox', tags: [], contexts: [],
    createdAt: OLD, updatedAt: OLD, rev: 1, revBy: DEVICE, ...extra });
const seed = (restore = false): Partial<AppData> => ({
    tasks: [task('selected'), task('sentinel'), ...(restore ? [task('restored-task', { status: 'next', projectId: 'old-project',
        areaId: 'old-area', sectionId: 'old-section', deletedAt: OLD })] : [])],
    projects: [{ id: 'project', title: 'Existing', color: '#ef4444', status: 'active', order: 2,
        tagIds: [], createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE }, ...(restore ? [{ id: 'old-project', title: 'Old',
        areaId: 'old-area', areaTitle: 'Old area', color: '#ef4444', status: 'active' as const, order: 0,
        tagIds: [], deletedAt: OLD, createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE }] : [])],
    sections: restore ? [{ id: 'old-section', projectId: 'old-project', title: 'Old section', order: 0,
        deletedAt: OLD, createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE }] : [],
    areas: [{ id: 'area', name: 'Home', color: '#ef4444', order: 3, createdAt: OLD, updatedAt: OLD, rev: 1, revBy: DEVICE },
        ...(restore ? [{ id: 'old-area', name: 'Restored', color: '#ef4444', order: 1, deletedAt: OLD,
            createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE }] : [])],
    settings: { deviceId: DEVICE, analyticsProfileId: ID, gtd: { defaultProjectFlowMode: 'sequential' } },
});
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const raw = async (db: Sqlite) => Object.fromEntries(await Promise.all(['tasks', 'projects', 'sections', 'areas', 'people', 'settings',
    'saved_filters', 'schema_migrations', 'calendar_sync'].map(async name => [name, await db.sql('SELECT rowid AS _rowid,* FROM ' + name + ' ORDER BY rowid')])));
const receipts = (db: Sqlite) => db.sql('SELECT * FROM native_request_receipts ORDER BY rowid');
const request = (db: Sqlite, kind: 'project' | 'area' = 'project', name = 'New destination', edit: Partial<BulkOrganizeDraft> = {}): Request => {
    const draft = { ...EMPTY_BULK_ORGANIZE_DRAFT, ...edit }; const params = {}; const taskIds = ['selected'];
    const view = value(db.host.getBulkActions({ list: 'inbox', taskIds, params, organize: { draft }, picker: { kind, query: name, offset: 0, limit: 100 } }));
    return { requestId: ID, source: 'inbox', kind, name, draft, offerRevision: view.revision, taskIds,
        taskRevisions: view.taskRevisions, params };
};
const prepare = async (db: Sqlite, input = request(db)): Promise<Envelope> => {
    const p = value(await db.host.prepareInboxOrganizeDestinationCreate(input)); expect(p.kind).toBe('prepared');
    return clone({ request: input, prepared: p.prepared });
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers();
    if (TZ === undefined) delete process.env.TZ; else process.env.TZ = TZ; });

describe('Inbox Organize destination creation parity', () => {
    it.each([
        ['project', 'Garden', { areaChoice: 'area' }, false],
        ['project', 'Garden', { areaChoice: BULK_ORGANIZE_KEEP }, false],
        ['project', 'Garden', { areaChoice: BULK_ORGANIZE_NONE }, false],
        ['area', 'New area', {}, false],
        ['area', 'Restored', {}, true],
    ] as const)('matches actual RN factory/full data/SQL effects for %s %s %j restore=%s', async (kind, name, draft, restore) => {
        clock(); const initial = seed(restore); let expected; let sql;
        const direct = await open(initial);
        try {
            await canonical(); vi.spyOn(uuid, 'generateUUID').mockReturnValue(ID);
            const created = kind === 'project' ? await createBulkOrganizeProject(name, draft.areaChoice === 'area' ? 'area' : undefined)
                : await createBulkOrganizeArea(name);
            expect(created).not.toBeNull(); await flushPendingSave(); expected = rows(); sql = await raw(direct); vi.restoreAllMocks();
        } finally { await direct.close(); }
        const db = await open(initial);
        try {
            await canonical(); const command = await prepare(db, request(db, kind, name, draft));
            const beforeTasks = clone(useTaskStore.getState()._allTasks); const logs = vi.spyOn(logger, 'logInfo');
            expect(value(db.host.validatePreparedInboxOrganizeDestinationCreate(command))).toEqual(command.prepared.result);
            expect(value(db.host.inboxOrganizeDestinationCreateOutcome(command))).toBeNull();
            const result = value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command));
            expect(result).toEqual({ id: restore ? 'old-area' : ID, changed: true });
            expect(rows()).toEqual(expected); expect(await raw(db)).toEqual(sql); expect(await db.receiptIds()).toEqual([ID]);
            if (!restore) expect(useTaskStore.getState()._allTasks).toEqual(beforeTasks); // Create then Cancel does not apply tasks.
            if (kind === 'project') expect(useTaskStore.getState()._projectsById.get(ID)).toMatchObject({
                color: initial.areas?.find((area) => area.id === draft.areaChoice)?.color ?? DEFAULT_PROJECT_COLOR,
                isSequential: true, rev: 1,
            });
            else expect(useTaskStore.getState()._areasById.get(result.id)).toMatchObject({ color: DEFAULT_AREA_COLOR });
            expect(logs).toHaveBeenCalledWith('Native Inbox Organize destination confirmed', expect.objectContaining({ context: {
                releaseCheck: 'v1.3.5/ios-inbox-organize-stable-offer', kind, outcome: 'saved' } }));
        } finally { await db.close(); }
    });
    it('allows incomplete Waiting during creation but preserves all nine draft fields in the witness', async () => {
        clock(); const db = await open(seed());
        try { const command = await prepare(db, request(db, 'area', 'Next area', { status: 'waiting', delegateWho: '' }));
            expect(command.request.draft.delegateWho).toBe(''); expect(Object.keys(command.request.draft)).toHaveLength(9);
            expect(value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command))).toEqual({ id: ID, changed: true });
        } finally { await db.close(); }
    });
    it.each([['project', 'Existing'], ['area', 'Home']] as const)('exact live %s name is picker edit, never creation noop', async (kind, name) => {
        clock(); const db = await open(seed());
        try { const input = request(db, kind, name); const before = await raw(db);
            expect(await db.host.prepareInboxOrganizeDestinationCreate(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
        } finally { await db.close(); }
    });
});

describe('creation receipt ownership and stale witnesses', () => {
    it.each(['renamed', 'archived', 'deleted', 'purged'] as const)('cold receipt remains exact after project %s; never reconstructs or restores', async change => {
        clock(); const db = await open(seed());
        try { const command = await prepare(db); const result = value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command));
            await db.client().run(change === 'purged' ? 'DELETE FROM projects WHERE id = ?' : 'UPDATE projects SET ' +
                (change === 'renamed' ? 'title' : change === 'archived' ? 'status' : 'deletedAt') + ' = ? WHERE id = ?',
            change === 'purged' ? [ID] : [change === 'renamed' ? 'Later title' : change === 'archived' ? 'archived' : NOW, ID]);
            await db.restart(undefined, { recoveryLoad: true }); const before = await raw(db); const saved = await receipts(db);
            expect(value(db.host.inboxOrganizeDestinationCreateOutcome(command))).toEqual(result);
            expect(value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command))).toEqual(result);
            expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual(saved);
        } finally { await db.close(); }
    });
    it('restored Area receipt does not restore it a second time after later deletion', async () => {
        clock(); const db = await open(seed(true));
        try { const command = await prepare(db, request(db, 'area', 'Restored'));
            expect(value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command))).toEqual({ id: 'old-area', changed: true });
            await db.client().run('UPDATE areas SET deletedAt = ?, rev = rev + 1 WHERE id = ?', [NOW, 'old-area']);
            await db.restart(undefined, { recoveryLoad: true }); const before = await raw(db);
            expect(value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command))).toEqual({ id: 'old-area', changed: true });
            expect(await raw(db)).toEqual(before);
        } finally { await db.close(); }
    });
    it.each(['warm', 'cold'] as const)('failed COMMIT keeps exact debt for %s retry; no receipt or diagnostic until durable', async recovery => {
        clock(); const fault = { commits: 0 }; const db = await open(seed(), client => ({ ...client, run: async (sql, args) => {
            if (sql === 'COMMIT' && fault.commits) { fault.commits--; throw new Error('Injected create COMMIT failure'); }
            return client.run(sql, args);
        } }));
        try { const command = await prepare(db); const before = await raw(db); const logs = vi.spyOn(logger, 'logInfo'); fault.commits = 10;
            expect(await db.host.commitPreparedInboxOrganizeDestinationCreate(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
            expect(logs.mock.calls.filter(([message]) => message === 'Native Inbox Organize destination confirmed')).toEqual([]);
            fault.commits = 0; if (recovery === 'cold') await db.restart(undefined, { recoveryLoad: true });
            expect(value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command))).toEqual({ id: ID, changed: true });
            expect(await db.receiptIds()).toEqual([ID]); expect(useTaskStore.getState()._allProjects.filter(row => row.id === ID)).toHaveLength(1);
            expect(value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command))).toEqual({ id: ID, changed: true });
            expect(await db.receiptIds()).toEqual([ID]);
        } finally { await db.close(); }
    }, 30_000);
    it.each([
        ['unselected Inbox', 'UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?', ['Later', 'sentinel']],
        ['offered project', 'UPDATE projects SET title = ?, rev = rev + 1 WHERE id = ?', ['Later', 'project']],
        ['chosen Area', 'UPDATE areas SET name = ?, rev = rev + 1 WHERE id = ?', ['Later', 'area']],
        ['flow setting', "UPDATE settings SET data = json_set(data, '$.gtd.defaultProjectFlowMode', ?) WHERE id = 1", ['parallel']],
    ] as const)('rejects changed raw saved %s after prepare with no own SQL or receipt', async (_name, sql, args) => {
        clock(); const db = await open(seed());
        try { const command = await prepare(db, request(db, 'project', 'Garden', { areaChoice: 'area' }));
            await db.client().run(sql, [...args]);
            if (_name === 'unselected Inbox') expect(await db.sql('SELECT title FROM tasks WHERE id = ?', ['sentinel'])).toEqual([{ title: 'Later' }]);
            await db.restart(undefined, { recoveryLoad: true }); const before = await raw(db);
            if (_name === 'unselected Inbox') {
                expect(command.prepared.scope.inbox.tasks.map(row => row.id)).toContain('sentinel');
                expect(useTaskStore.getState()._tasksById.get('sentinel')?.title).toBe('Later');
            }
            expect(await db.host.commitPreparedInboxOrganizeDestinationCreate(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
        } finally { await db.close(); }
    });
    it('stale opaque revision and selected revisions reject before preparing', async () => {
        clock(); const db = await open(seed());
        try { const input = request(db); const before = await raw(db);
            expect(await db.host.prepareInboxOrganizeDestinationCreate({ ...input, offerRevision: input.offerRevision + ':wrong' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await db.host.prepareInboxOrganizeDestinationCreate({ ...input, taskRevisions: { selected: 'wrong' } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
        } finally { await db.close(); }
    });
    it('pure validator kills extra/missing fields, wrong identity/effect/defaults and current-row forgery', async () => {
        clock(); const db = await open(seed());
        try { const command = await prepare(db); const before = await raw(db);
            const mutants: Array<(e: Envelope) => void> = [
                e => { Object.assign(e.request, { extra: true }); Object.assign(e.prepared.request, { extra: true }); },
                e => { delete (e.request.draft as Partial<BulkOrganizeDraft>).tags; delete (e.prepared.request.draft as Partial<BulkOrganizeDraft>).tags; },
                e => { e.prepared.result.id = 'other'; },
                e => { e.prepared.effect.projects[0].after.color = '#ef4444'; },
                e => { e.prepared.effect.projects[0].after.rev = 0; },
                e => { e.prepared.scope.defaultProjectFlowMode = 'parallel'; },
                e => { e.prepared.effect.tasks.push({ before: task('sentinel'), after: task('sentinel', { title: 'Forged' }) }); },
            ];
            for (const mutate of mutants) { const forged = clone(command); mutate(forged);
                expect(db.host.validatePreparedInboxOrganizeDestinationCreate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await db.host.commitPreparedInboxOrganizeDestinationCreate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); }
            expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
        } finally { await db.close(); }
    });
    it('store refuses adapter switch after its yield and keeps raw BEFORE CAS even if registry is forged', async () => {
        clock(); const db = await open(seed()); const adapter = getStorageAdapter(); const family = referenceBatchModules.inboxOrganizeCreate;
        try { const command = await prepare(db); const read = value(await readAreaDurableData(false, true)); const before = await raw(db);
            const changing = useTaskStore.getState().commitPreparedInboxOrganizeDestinationCreate(command.prepared, read.authority);
            setStorageAdapter(new NativeReceiptSqliteAdapter(db.client(), { rejectConcurrentWrites: true }));
            expect(await changing).toMatchObject({ success: false }); setStorageAdapter(adapter); expect(await raw(db)).toEqual(before);
            referenceBatchModules.inboxOrganizeCreate = () => ({ validateEnvelope: () => true, authorityMatches: () => true });
            const forged = clone(command.prepared); forged.effect.projects[0].before = clone(useTaskStore.getState()._allProjects[0]);
            const exact = value(await readAreaDurableData(false, true));
            expect(await useTaskStore.getState().commitPreparedInboxOrganizeDestinationCreate(forged, exact.authority)).toMatchObject({ success: false });
            expect(await raw(db)).toEqual(before); expect(exact.authority.saveBoundary).toBeUndefined();
        } finally { referenceBatchModules.inboxOrganizeCreate = family; setStorageAdapter(adapter); await db.close(); }
    });
});

describe('creation boundary regressions', () => {
    describe('creation offer stability', () => {
        it.each(['project', 'area'] as const)('creates %s after the offer crosses a minute with unchanged authority', async kind => {
            clock(); const db = await open(seed());
            try {
                const input = request(db, kind); vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
                const command = await prepare(db, input);
                expect(value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command))).toEqual({ id: ID, changed: true });
                expect(await db.receiptIds()).toEqual([ID]);
            } finally { await db.close(); }
        });
        it('keeps the offer valid when the real FK probe crosses a minute', async () => {
            clock(); const db = await open(seed());
            try {
                const input = request(db); const before = await raw(db); const adapter = getStorageAdapter() as NativeReceiptSqliteAdapter;
                let release!: () => void; let entered!: () => void;
                const held = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
                vi.spyOn(adapter, 'hasForeignKeyViolations').mockImplementationOnce(async () => { entered(); await held; return false; });
                const pending = db.host.prepareInboxOrganizeDestinationCreate(input); await started;
                vi.setSystemTime(new Date(Date.parse(NOW) + 60_000)); release();
                expect(await pending).toMatchObject({ ok: true, value: { kind: 'prepared' } });
                expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
            } finally { await db.close(); }
        });
        it.each(['project', 'area'] as const)('pages the same %s offer across a minute and rejects changed picker context', async kind => {
            clock(); const db = await open(seed());
            try {
                const input = { list: 'inbox' as const, taskIds: ['selected'], params: {},
                    organize: { draft: { ...EMPTY_BULK_ORGANIZE_DRAFT } }, picker: { kind, query: ' New destination ', offset: 0, limit: 1 } };
                const first = value(db.host.getBulkActions(input));
                vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
                const page = { ...input, picker: { ...input.picker, offset: 1, revision: first.revision } };
                expect(value(db.host.getBulkActions(page)).revision).toBe(first.revision);
                expect(await db.host.prepareInboxOrganizeDestinationCreate({ requestId: ID, source: 'inbox', kind,
                    name: first.picker!.create!.name, draft: first.organize!.draft, offerRevision: first.revision,
                    taskIds: first.selectedIds, taskRevisions: first.taskRevisions, params: {} })).toMatchObject({ ok: true });
                for (const changed of [
                    { ...page, picker: { ...page.picker, query: 'Different destination' } },
                    { ...page, organize: { draft: { ...input.organize.draft, contexts: '@desk' } } },
                    { ...page, taskIds: ['sentinel'] },
                    { ...page, params: { filters: { searchQuery: 'sentinel' } } },
                ]) expect(db.host.getBulkActions(changed)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await receipts(db)).toEqual([]);
            } finally { await db.close(); }
        });
        it.each(['task', 'destination', 'settings'] as const)('still rejects a real %s change after the offer', async changed => {
            clock(); const db = await open(seed());
            try {
                const input = request(db);
                if (changed === 'task') await useTaskStore.getState().updateTask('selected', { title: 'Changed' });
                else if (changed === 'destination') await useTaskStore.getState().updateProject('project', { title: 'Changed' });
                else await useTaskStore.getState().updateSettings({ gtd: { defaultProjectFlowMode: 'parallel' } });
                await flushPendingSave(); const before = await raw(db);
                expect(await db.host.prepareInboxOrganizeDestinationCreate(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
            } finally { await db.close(); }
        });
    });
    it('refuses memory/offer changes while the real FK probe is awaiting, before returning a prepared creation', async () => {
        clock(); const db = await open(seed());
        try { const input = request(db); const before = await raw(db); const adapter = getStorageAdapter() as NativeReceiptSqliteAdapter;
            let release!: () => void; let entered!: () => void;
            const held = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
            vi.spyOn(adapter, 'hasForeignKeyViolations').mockImplementationOnce(async () => { entered(); await held; return false; });
            const pending = db.host.prepareInboxOrganizeDestinationCreate(input); await started;
            useTaskStore.setState(state => ({ _allTasks: state._allTasks.map(row => row.id === 'sentinel' ? { ...row, title: 'New visible value' } : row) }));
            release(); expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
        } finally { await db.close(); }
    });
    it('rejects a fabricated unselected Inbox witness against real saved authority, not only structurally', async () => {
        clock(); const db = await open(seed());
        try { const command = await prepare(db); const forged = clone(command);
            forged.prepared.scope.inbox.tasks.push(task('invented')); // A coherent additional unselected row, with no planned task effects.
            expect(value(db.host.validatePreparedInboxOrganizeDestinationCreate(forged))).toEqual({ id: ID, changed: true });
            const before = await raw(db);
            expect(await db.host.commitPreparedInboxOrganizeDestinationCreate(forged)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
        } finally { await db.close(); }
    });
    it('rejects a newly changed restored descendant without restoring any Area/project/task', async () => {
        clock(); const db = await open(seed(true));
        try { const command = await prepare(db, request(db, 'area', 'Restored')); const old = command.prepared.scope.restoration;
            expect(old?.tasks.map(row => row.id)).toContain('restored-task');
            await db.client().run('UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?', ['Later descendant', 'restored-task']);
            await db.restart(undefined, { recoveryLoad: true }); const before = await raw(db);
            expect(await db.host.commitPreparedInboxOrganizeDestinationCreate(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
        } finally { await db.close(); }
    });
    it('target equality without an original receipt is not confirmation and never replays a create', async () => {
        clock(); const db = await open(seed());
        try { const command = await prepare(db); const expected = command.prepared.effect.projects[0].after;
            await useTaskStore.getState().addProject(expected.title, expected.color, { id: ID }); await flushPendingSave();
            expect(await receipts(db)).toEqual([]); const before = await raw(db);
            expect(value(db.host.inboxOrganizeDestinationCreateOutcome(command))).toBeNull();
            expect(await db.host.commitPreparedInboxOrganizeDestinationCreate(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(db)).toEqual(before);
        } finally { await db.close(); }
    });
    it('family-specific immutable receipt refuses a second operation with the same UUID', async () => {
        clock(); const db = await open(seed());
        try { const command = await prepare(db); value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command));
            expect((await receipts(db))[0]).toMatchObject({ method: expect.stringMatching(/^inboxOrganizeDestinationCreate:/), reply: JSON.stringify({ id: ID, changed: true }) });
            const draft = { ...EMPTY_BULK_ORGANIZE_DRAFT, tags: '#new' }; const taskIds = ['selected'];
            const bulk = value(db.host.getBulkActions({ list: 'inbox', taskIds, params: {}, organize: { draft } }));
            const next = { requestId: ID, source: 'inbox' as const, taskIds, taskRevisions: bulk.taskRevisions, draft, params: {} };
            const plan = value(await db.host.prepareInboxTasksOrganize(next)); expect(plan.kind).toBe('prepared');
            if (plan.kind !== 'prepared') throw new Error('Expected actual Apply work'); const before = await raw(db);
            expect(await db.host.commitPreparedInboxTasksOrganize({ request: next, prepared: plan.prepared })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(db)).toEqual(before); expect(await db.receiptIds()).toEqual([ID]);
        } finally { await db.close(); }
    });
    it('does not adopt an unrelated failed save as creation debt ownership', async () => {
        clock(); const fault = { commits: 0 }; const db = await open(seed(), client => ({ ...client, run: async (sql, args) => {
            if (sql === 'COMMIT' && fault.commits) { fault.commits--; throw new Error('Failed owned save'); } return client.run(sql, args);
        } }));
        try { const command = await prepare(db); const before = await raw(db); fault.commits = 10;
            expect(await db.host.commitPreparedInboxOrganizeDestinationCreate(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.commits = 10; await useTaskStore.getState().updateTask('sentinel', { title: 'Unrelated newer intent' });
            await expect(flushPendingSave()).rejects.toThrow('Failed owned save');
            fault.commits = 10; expect(await db.host.commitPreparedInboxOrganizeDestinationCreate(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(db)).toEqual(before); expect(value(db.host.inboxOrganizeDestinationCreateOutcome(command))).toBeNull();
            expect(await receipts(db)).toEqual([]);
        } finally { fault.commits = 0; await db.close(); }
    }, 30_000);
    it.each([['America/New_York', 'Asia/Tokyo'], ['Asia/Tokyo', 'America/New_York']] as const)('retains frozen preparation through %s to %s clock/TZ drift', async (from, to) => {
        process.env.TZ = from; clock(); const initial = seed(); initial.tasks![0].startTime = '2026-10-18T23:00:00-04:00';
        initial.tasks![0].isFocusedToday = true; const db = await open(initial);
        try { const command = await prepare(db); const frozen = clone(command); process.env.TZ = to;
            vi.setSystemTime(new Date('2028-04-01T12:00:00.000Z')); await db.restart(undefined, { recoveryLoad: true });
            expect(value(db.host.validatePreparedInboxOrganizeDestinationCreate(command))).toEqual({ id: ID, changed: true });
            expect(value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command))).toEqual({ id: ID, changed: true });
            expect(command).toEqual(frozen); expect(useTaskStore.getState()._projectsById.get(ID)?.createdAt).toBe(NOW);
        } finally { await db.close(); }
    });
});

it('preserves an Area restore witness when a live Inbox descendant follows a deleted descendant in saved order', async () => {
    clock(); const initial = seed(true); const [selected, sentinel, deleted] = initial.tasks!;
    initial.tasks = [deleted, { ...selected, areaId: 'old-area' }, sentinel];
    const db = await open(initial);
    try { await db.client().run('UPDATE tasks SET areaId = ? WHERE id = ?', ['old-area', 'selected']);
        const command = await prepare(db, request(db, 'area', 'Restored'));
        expect(command.prepared.scope.restoration?.tasks.map(row => row.id)).toEqual(['restored-task', 'selected']);
        const patched = clone(command); patched.prepared.scope.restoration!.tasks[1].title = 'Forged overlap';
        expect(db.host.validatePreparedInboxOrganizeDestinationCreate(patched)).toMatchObject({ ok: false });
        const omitted = clone(command); omitted.prepared.scope.restoration!.tasks.pop();
        expect(db.host.validatePreparedInboxOrganizeDestinationCreate(omitted)).toMatchObject({ ok: false });
        const reversed = clone(command); reversed.prepared.scope.restoration!.tasks.reverse();
        expect(await db.host.commitPreparedInboxOrganizeDestinationCreate(reversed)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await receipts(db)).toEqual([]);

        expect(value(await db.host.commitPreparedInboxOrganizeDestinationCreate(command))).toEqual({ id: 'old-area', changed: true });
        expect(useTaskStore.getState()._tasksById.get('restored-task')?.deletedAt).toBeUndefined();
    } finally { await db.close(); }
});

it('rejects Area creation from a disabled control and rejects a coherently forged prepared envelope', async () => {
    clock(); const db = await open(seed());
    try { const allowed = await prepare(db, request(db, 'area', 'Another area'));
        const input = request(db, 'area', 'Another area', { projectChoice: 'project' });
        const offered = value(db.host.getBulkActions({ list: 'inbox', taskIds: input.taskIds, params: input.params,
            organize: { draft: input.draft }, picker: { kind: 'area', query: input.name, offset: 0, limit: 100 } }));
        expect(offered.organize?.area.disabled).toBe(true);
        expect(offered.picker?.create?.name).toBe('Another area'); // Generic picker behavior remains compatible.
        const before = await raw(db);
        expect(await db.host.prepareInboxOrganizeDestinationCreate(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const forged = clone(allowed); forged.request = input; forged.prepared.request = input;
        expect(db.host.validatePreparedInboxOrganizeDestinationCreate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await db.host.commitPreparedInboxOrganizeDestinationCreate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await raw(db)).toEqual(before); expect(await receipts(db)).toEqual([]);
    } finally { await db.close(); }
});
