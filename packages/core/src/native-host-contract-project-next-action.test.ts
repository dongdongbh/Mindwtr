import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost, value } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, getPersistenceStatus, resetForTests, useTaskStore } from './store';
import { parseProjectNextActionInput, isNaturalLanguageDatesEnabled } from './quick-add';
import { configureDateFormatting, normalizeClockTimeInput } from './date';
import { readAreaDurableData } from './native-host-contract-area-durable';
import * as uuid from './uuid';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppData, Task } from './types';

const NOW = '2026-10-03T13:00:00.000Z';
const ORIGIN = '00000000-0000-4000-8000-000000000191';
const WRITE = '00000000-0000-4000-8000-000000000192';
const task = (id: string, status: Task['status']): Task => ({ id, title: id, status,
    createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a', projectId: 'project',
    tags: [], contexts: [], pushCount: 0 });
const seed = (): Partial<AppData> => ({ tasks: [task('source', 'reference'), task('candidate', 'waiting')],
    projects: [{ id: 'project', title: 'Project', status: 'active', order: 0, color: '#94a3b8',
        tagIds: [], createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a' }],
    settings: { deviceId: 'device-a', analyticsProfileId: ORIGIN, gtd: { focusTaskLimit: 3 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const tables = ['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'];
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(tables.map(async table => [table,
    { schema: await sqlite.sql(`PRAGMA table_info(${table})`), rows: await sqlite.sql(`SELECT rowid AS evidenceRowid,* FROM ${table} ORDER BY rowid`) }])));
const rows = () => { const s = useTaskStore.getState(); return JSON.parse(JSON.stringify({ tasks: s._allTasks, projects: s._allProjects,
    sections: s._allSections, areas: s._allAreas, people: s._allPeople, settings: s.settings })) as AppData; };
const origin = async (sqlite: Sqlite) => {
    const request = { id: 'source', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('source')!),
        requestId: ORIGIN, source: 'reference' as const };
    const prepared = value(await sqlite.host.prepareTaskCompletion(request)).prepared;
    const envelope = { request, prepared }; value(await sqlite.host.commitPreparedTaskCompletion(envelope));
    return { kind: 'completion' as const, envelope };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('Reference project next action', () => {
    it('reads shared prompt candidates and input without writing and requires exact origin proof', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const proof = await origin(sqlite); const before = await raw(sqlite);
            const options = value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }));
            expect(options).toMatchObject({ scope: 'project', candidates: { total: 1, items: [{ id: 'candidate', status: 'waiting' }] } });
            expect(value(sqlite.host.referenceProjectNextActionInput('   '))).toEqual({ canSave: false });
            expect(value(sqlite.host.referenceProjectNextActionInput(' next '))).toEqual({ canSave: true });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([ORIGIN]);
            await sqlite.client().run('DELETE FROM native_request_receipts'); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        } finally { await sqlite.close(); }
    });
    it.each([
        'Plain next action',
        'Call @phone #family /due:tomorrow /priority:urgent /note:Keep note',
        'Review /start:tomorrow 2pm /review:friday /waiting',
        'Read /link:Source | https://example.com/docs#section',
        'Retarget +Other #tag /inbox',
        'Unknown +Missing /reference /*',
        'Focused /* /next',
        'Review due /waiting /review:2026-10-03 /*',
        'Sequential review predecessor /*',
        'Café e\u0301 /due:10/8',
    ])('matches actual parse + RN addTask all nine tables: %s', async input => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fixture = seed(); fixture.projects!.push({ ...fixture.projects![0], id: 'other', title: 'Other', order: 1 });
        if (input === 'Sequential review predecessor /*') { fixture.projects![0].isSequential = true; fixture.tasks![1].reviewAt = '2026-10-03'; fixture.tasks![1].order = 0; fixture.tasks![1].orderNum = 0; }
        const ids = ['00000000-0000-4000-8000-000000000193', '00000000-0000-4000-8000-000000000194'];
        const rn = await openSqliteHost(fixture); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try { await origin(rn); let index = 0; const allocation = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { if (!ids[index]) throw new Error('Unexpected allocation'); return ids[index++]; });
            const state = useTaskStore.getState(); const parsed = parseProjectNextActionInput(input, { projectId: 'project',
                projects: state._allProjects, areas: state._allAreas, parseOptions: { defaultScheduleTime: normalizeClockTimeInput(state.settings.gtd?.defaultScheduleTime) || undefined,
                    preserveText: state.settings.quickAddAutoClean !== true, naturalLanguageDates: isNaturalLanguageDatesEnabled(state.settings) } });
            expect((await useTaskStore.getState().addTask(parsed.title, parsed.props)).success).toBe(true);
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); allocation.mockRestore();
        } finally { await rn.close(); }
        const native = await openSqliteHost(fixture);
        try { const proof = await origin(native); const options = value(await native.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }))!;
            let index = 0; const allocation = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { if (!ids[index]) throw new Error('Unexpected allocation'); return ids[index++]; });
            const request = { requestId: WRITE, origin: options.origin, promptRevision: options.promptRevision, action: 'add' as const, text: input, openAfterSave: true };
            const prepared = value(await native.host.prepareReferenceProjectNextAction({ request, origin: proof })).prepared;
            const count = index; const envelope = { request, prepared };
            if (process.env.TASK191_EXPORT_DIR && input === 'Plain next action') { const p = join(process.env.TASK191_EXPORT_DIR, 'private-envelope-add.json'); expect(existsSync(p)).toBe(false); writeFileSync(p, JSON.stringify(envelope, null, 2)); }
            expect(value(native.host.validatePreparedReferenceProjectNextAction(envelope))).toEqual(prepared.result);
            expect(value(await native.host.commitPreparedReferenceProjectNextAction(envelope))).toEqual(prepared.result);
            expect(index).toBe(count); expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!); allocation.mockRestore();
        } finally { await native.close(); }
    });
    it.each(['choose', 'completeProject'] as const)('matches actual RN %s full state and all nine tables', async action => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const rn = await openSqliteHost(seed()); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try { await origin(rn);
            if (action === 'choose') expect(await useTaskStore.getState().updateTask('candidate', { status: 'next' })).toEqual({ success: true });
            else await useTaskStore.getState().updateProject('project', { status: 'archived' });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed());
        try { const proof = await origin(native); const options = value(await native.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }))!;
            const request = { requestId: WRITE, origin: options.origin, promptRevision: options.promptRevision, action,
                ...(action === 'choose' ? { candidateId: 'candidate', candidateRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('candidate')!) } : {}) };
            const prepared = value(await native.host.prepareReferenceProjectNextAction({ request, origin: proof })).prepared;
            const envelope = { request, prepared };
            if (process.env.TASK191_EXPORT_DIR) { const p = join(process.env.TASK191_EXPORT_DIR, `private-envelope-${action}.json`); expect(existsSync(p)).toBe(false); writeFileSync(p, JSON.stringify(envelope, null, 2));
                if (action === 'choose') writeFileSync(join(process.env.TASK191_EXPORT_DIR, 'private-origin-completion.json'), JSON.stringify(proof.envelope, null, 2)); }
            expect(value(native.host.validatePreparedReferenceProjectNextAction(envelope))).toEqual(prepared.result);
            expect(value(await native.host.commitPreparedReferenceProjectNextAction(envelope))).toEqual(prepared.result);
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!); expect(await native.receiptIds()).toEqual([ORIGIN, WRITE]);
        } finally { await native.close(); }
    });
});

const followup = async (sqlite: Sqlite, proof: Awaited<ReturnType<typeof origin>>, action: 'choose' | 'add' | 'completeProject') => {
    const options = value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }))!;
    const request = { requestId: WRITE, origin: options.origin, promptRevision: options.promptRevision, action,
        ...(action === 'choose' ? { candidateId: 'candidate', candidateRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('candidate')!) }
            : action === 'add' ? { text: 'Immutable new action', openAfterSave: true } : {}) };
    const prepared = value(await sqlite.host.prepareReferenceProjectNextAction({ request, origin: proof } as never)).prepared;
    return { request, prepared };
};
describe('Reference prompt frozen authority and durable retry', () => {
    it.each(['choose', 'add', 'completeProject'] as const)('preserves legacy siblings, full receipts, exact UUID through repeated failure/retry/cold: %s', async action => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { commits: 0 };
        const fixture = seed(); fixture.tasks!.push({ ...task('raw-sibling', 'reference'), projectId: undefined });
        const sqlite = await openSqliteHost(fixture, client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('owned COMMIT failure'); } return client.run(sql, params);
        } }));
        try { const proof = await origin(sqlite);
            await sqlite.client().run('UPDATE tasks SET pushCount=NULL,focusOrder=2,attachments=? WHERE id=?',
                ['[{"id":"legacy","kind":"file","title":"fixture.txt","uri":"file:///fixture.txt","createdAt":"2026-10-03T13:00:00.000Z"}]', 'raw-sibling']);
            const [setting] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1');
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(JSON.parse(setting.data), null, 2)]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const envelope = await followup(sqlite, proof, action); const before = await raw(sqlite);
            const beforeReceipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            const checkpoint = join(sqlite.dir, 'before.db'); copyFileSync(join(sqlite.dir, 'mindwtr.db'), checkpoint);
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never));
            const uninterrupted = await raw(sqlite); const fullReceipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            expect((uninterrupted.tasks.rows as Record<string, unknown>[]).find(r => r.id === 'raw-sibling')).toEqual((before.tasks.rows as Record<string, unknown>[]).find(r => r.id === 'raw-sibling'));
            expect(uninterrupted.settings).toEqual(before.settings);
            await sqlite.restart(checkpoint, { recoveryLoad: true }); fault.commits = 10;
            expect(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(beforeReceipts);
            fault.commits = 10; expect(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); fault.commits = 0;
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never));
            expect(await raw(sqlite)).toEqual(uninterrupted); expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(fullReceipts);
            await sqlite.restart(checkpoint, { recoveryLoad: true }); fault.commits = 10;
            expect(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.commits = 0; resetForTests(); await sqlite.restart(undefined, { recoveryLoad: true });
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never));
            expect(await raw(sqlite)).toEqual(uninterrupted); expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(fullReceipts);
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [ORIGIN]);
            await sqlite.client().run('UPDATE tasks SET title=? WHERE id=?', ['later edited', 'source']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const later = await raw(sqlite); const laterReceipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)); expect(await raw(sqlite)).toEqual(later);
            expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(laterReceipts);
            const unused = JSON.parse(JSON.stringify(envelope)); unused.request.requestId = '00000000-0000-4000-8000-000000000199'; unused.prepared.request.requestId = unused.request.requestId;
            if (unused.prepared.operation.kind === 'completeProject') unused.prepared.operation.lifecycle.request.requestId = unused.request.requestId;
            expect(await sqlite.host.commitPreparedReferenceProjectNextAction(unused)).toMatchObject({ ok: false }); expect(await raw(sqlite)).toEqual(later);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 15_000);
    it('raw lifecycle membership refusal keeps original memory references/content and all SQL unchanged', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const proof = await origin(sqlite); const envelope = await followup(sqlite, proof, 'completeProject');
            if (envelope.prepared.operation.kind !== 'completeProject') throw new Error('wrong fixture');
            await sqlite.client().run('INSERT INTO tasks (id,title,status,tags,contexts,createdAt,updatedAt,projectId) VALUES (?,?,?,?,?,?,?,?)',
                ['late', 'Late fixture', 'inbox', '[]', '[]', NOW, NOW, 'project']);
            const read = value(await readAreaDurableData(false, true)); const state = useTaskStore.getState(); const contents = rows(); const before = await raw(sqlite);
            const result = await state.commitPreparedProjectLifecycle(envelope.prepared.operation.lifecycle,
                { requireBefore: true, authority: read.authority, rawBefore: envelope.prepared.rawBefore });
            expect(result.success).toBe(false); expect(useTaskStore.getState()._allTasks).toBe(state._allTasks);
            expect(useTaskStore.getState()._allProjects).toBe(state._allProjects); expect(useTaskStore.getState().settings).toBe(state.settings);
            expect(useTaskStore.getState()._allSections).toBe(state._allSections);
            expect(useTaskStore.getState()._tasksById).toBe(state._tasksById); expect(useTaskStore.getState()._projectsById).toBe(state._projectsById);
            expect(useTaskStore.getState().lastDataChangeAt).toBe(state.lastDataChangeAt);
            expect(getPersistenceStatus().queued).toBe(0); expect(getPersistenceStatus().inFlight).toBe(false);
            expect(rows()).toEqual(contents); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    it.each(['source', 'candidate', 'parent', 'section'] as const)('refuses raw same-revision consumed %s drift without SQL/receipt', async role => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fixture = seed();
        fixture.sections = [{ id: 'section', title: 'Section', projectId: 'project', order: 0, createdAt: NOW, updatedAt: NOW }];
        fixture.tasks![0].sectionId = 'section'; fixture.tasks![1].sectionId = 'section'; const sqlite = await openSqliteHost(fixture);
        try { const proof = await origin(sqlite); const envelope = await followup(sqlite, proof, 'choose');
            if (role === 'source' || role === 'candidate') await sqlite.client().run('UPDATE tasks SET focusOrder=2 WHERE id=?', [role]);
            else if (role === 'parent') await sqlite.client().run('UPDATE projects SET title=? WHERE id=?', ['Changed', 'project']);
            else await sqlite.client().run('UPDATE sections SET title=? WHERE id=?', ['Changed', 'section']);
            const before = await raw(sqlite); expect(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([ORIGIN]);
        } finally { await sqlite.close(); }
    });
});

describe('Reference prompt shared policy and exact schema', () => {
    it('paginates every candidate in actual shared order, validates accepted content revision, and preserves Unicode identities', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fixture = seed();
        fixture.tasks = [fixture.tasks![0], ...Array.from({ length: 132 }, (_, index) => ({ ...task(`candidate-${index}`, 'waiting'), order: 132 - index, orderNum: 132 - index })),
            task('e\u0301', 'inbox'), task('é', 'inbox')]; const sqlite = await openSqliteHost(fixture);
        try { const proof = await origin(sqlite); const before = await raw(sqlite);
            const first = value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }))!;
            expect(first.candidates.total).toBe(134); expect(first.candidates.items).toHaveLength(100); expect(first.candidates.hasMore).toBe(true);
            const last = value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 100, revision: first.promptRevision } }))!;
            expect(last.candidates.items).toHaveLength(34); expect(last.candidates.hasMore).toBe(false);
            expect(last.candidates.items.map(r => r.id)).toContain('e\u0301'); expect(last.candidates.items.map(r => r.id)).toContain('é');
            expect(value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: Number.MAX_SAFE_INTEGER, revision: first.promptRevision } }))!.candidates.items).toEqual([]);
            expect(await raw(sqlite)).toEqual(before); await sqlite.client().run('UPDATE tasks SET status=? WHERE id=?', ['someday', 'candidate-0']);
            expect(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 100, revision: first.promptRevision } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        } finally { await sqlite.close(); }
    });
    it.each(['empty', 'next', 'future-next', 'section', 'unsectioned'] as const)('uses actual RN prompt scope and suppression: %s', async kind => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fixture = seed();
        if (kind === 'empty') fixture.tasks = [fixture.tasks![0]];
        if (kind === 'next' || kind === 'future-next') fixture.tasks!.push({ ...task('other-next', 'next'), ...(kind === 'future-next' ? { startTime: '2026-10-05T12:00:00.000Z' } : {}) });
        if (kind === 'section' || kind === 'unsectioned') {
            fixture.projects![0].isSequential = true; fixture.projects![0].sequentialScope = 'section';
            fixture.sections = [{ id: 'section', projectId: 'project', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW },
                { id: 'other-section', projectId: 'project', title: 'Other', order: 1, createdAt: NOW, updatedAt: NOW }];
            if (kind === 'section') { fixture.tasks![0].sectionId = 'section'; fixture.tasks![1].sectionId = 'section'; }
            fixture.tasks!.push({ ...task('other-next', 'next'), sectionId: 'other-section' });
        }
        const sqlite = await openSqliteHost(fixture);
        try { const proof = await origin(sqlite); const before = await raw(sqlite);
            const options = value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }));
            if (kind === 'next' || kind === 'future-next') expect(options).toBeNull();
            else if (kind === 'empty') expect(options).toMatchObject({ scope: 'project', candidates: { total: 0 }, completeProject: { label: expect.any(String) } });
            else expect(options).toMatchObject({ scope: 'section', section: kind === 'section' ? { id: 'section' } : null, completeProject: null, candidates: { total: 1 } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    it('malformed/forged variants reject before SQL and missing origin refuses fresh writes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const proof = await origin(sqlite); const envelope = await followup(sqlite, proof, 'add'); const before = await raw(sqlite);
            for (const mutate of [
                (e: any) => { e.extra = true; }, (e: any) => { e.prepared.extra = true; },
                (e: any) => { e.prepared.operation.creation.intent.props.recurrence = { rule: 'daily' }; },
                (e: any) => { e.prepared.operation.creation.intent.props.sectionId = 'arbitrary'; },
                (e: any) => { e.prepared.operation.task.rev = 20; }, (e: any) => { e.prepared.result.openAfterSave = false; },
                (e: any) => { e.prepared.rawBefore.tasks[0].before = task('candidate', 'waiting'); },
            ]) { const bad = JSON.parse(JSON.stringify(envelope)); mutate(bad);
                expect(sqlite.host.validatePreparedReferenceProjectNextAction(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await sqlite.host.commitPreparedReferenceProjectNextAction(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([ORIGIN]);
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [ORIGIN]); await sqlite.restart(undefined, { recoveryLoad: true }); const missing = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(missing); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each(['choose', 'add', 'completeProject'] as const)('initializes an absent saved device only at durable %s, preserving no-write options', async action => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const proof = await origin(sqlite); const [saved] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = JSON.parse(saved.data); delete settings.deviceId;
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]); await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite); const envelope = await followup(sqlite, proof, action); expect(await raw(sqlite)).toEqual(before);
            const op = envelope.prepared.operation; const device = op.kind === 'completeProject' ? op.lifecycle : op;
            expect(device.deviceIdBefore).toBeNull(); expect(device.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)); expect(useTaskStore.getState().settings.deviceId).toBe(device.deviceIdToInitialize);
            await sqlite.restart(undefined, { recoveryLoad: true }); const after = await raw(sqlite); value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)); expect(await raw(sqlite)).toEqual(after);
        } finally { await sqlite.close(); }
    });
});

describe('Reference prompt exact Project JSON BEFORE', () => {
    it.each(['missing-to-empty', 'empty-to-missing'] as const)('rejects same-revision Project attachment member change: %s', async direction => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const proof = await origin(sqlite); const attachment = { id: 'project-attachment', kind: 'file', title: 'fixture', uri: 'file:///fixture', createdAt: NOW };
            const missing = JSON.stringify([attachment]); const empty = JSON.stringify([{ ...attachment, updatedAt: '' }]);
            await sqlite.client().run('UPDATE projects SET attachments=? WHERE id=?', [direction === 'missing-to-empty' ? missing : empty, 'project']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const envelope = await followup(sqlite, proof, 'completeProject');
            await sqlite.client().run('UPDATE projects SET attachments=? WHERE id=?', [direction === 'missing-to-empty' ? empty : missing, 'project']);
            const before = await raw(sqlite); const state = useTaskStore.getState(); const persistence = getPersistenceStatus();
            expect(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([ORIGIN]);
            expect(useTaskStore.getState()._allTasks).toBe(state._allTasks); expect(useTaskStore.getState()._allProjects).toBe(state._allProjects);
            expect(useTaskStore.getState().settings).toBe(state.settings); expect(getPersistenceStatus()).toEqual(persistence);
        } finally { await sqlite.close(); }
    });
});

describe('Reference prompt captured parser authority and old durable bytes', () => {
    it('archives on normal load after a real backdated write and still reads forced-Done shared policy', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fixture = seed(); fixture.settings!.gtd!.autoArchiveDays = 1;
        const sqlite = await openSqliteHost(fixture);
        try { const source = useTaskStore.getState()._tasksById.get('source')!;
            const request = { id: source.id, taskRevision: taskRevisionOf(source), requestId: ORIGIN, source: 'reference' as const,
                completedAt: '2026-09-20T12:00:00.000Z', timeSpentText: null };
            const prepared = value(await sqlite.host.prepareReferenceTaskBackdate(request)).prepared; const envelope = { request, prepared };
            value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope)); expect(useTaskStore.getState()._tasksById.get('source')?.status).toBe('done');
            await sqlite.restart(); expect(useTaskStore.getState()._tasksById.get('source')?.status).toBe('archived');
            const proof = { kind: 'backdate' as const, envelope }; const options = value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }))!;
            expect(options).toMatchObject({ scope: 'project', candidates: { total: 1, items: [{ id: 'candidate' }] } });
            const write = { requestId: WRITE, origin: options.origin, promptRevision: options.promptRevision, action: 'choose' as const,
                candidateId: 'candidate', candidateRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('candidate')!) };
            const operation = { request: write, prepared: value(await sqlite.host.prepareReferenceProjectNextAction({ request: write, origin: proof })).prepared };
            if (process.env.TASK191_EXPORT_DIR) { const file = join(process.env.TASK191_EXPORT_DIR, 'private-envelope-backdate.json'); expect(existsSync(file)).toBe(false);
                writeFileSync(file, JSON.stringify(operation, null, 2)); writeFileSync(join(process.env.TASK191_EXPORT_DIR, 'private-origin-backdate.json'), JSON.stringify(envelope, null, 2)); }
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(operation)); expect(useTaskStore.getState()._tasksById.get('source')?.status).toBe('archived');
        } finally { await sqlite.close(); }
    });
    it('captured resolved dates/IDs survive language/date-format changes without parse or allocation on retry', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const proof = await origin(sqlite); const options = value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }))!;
            const request = { requestId: WRITE, origin: options.origin, promptRevision: options.promptRevision, action: 'add' as const,
                text: 'Resolved /due:10/8 /link:Fixture | https://example.com', openAfterSave: false };
            configureDateFormatting({ dateFormat: 'mdy', language: 'en' });
            const prepared = value(await sqlite.host.prepareReferenceProjectNextAction({ request, origin: proof })).prepared; const envelope = { request, prepared };
            if (prepared.operation.kind !== 'add') throw new Error('Expected Add'); const target = JSON.parse(JSON.stringify(prepared.operation.task));
            const allocate = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Retry must not allocate'); });
            configureDateFormatting({ dateFormat: 'dmy', language: 'fr' });
            expect(value(sqlite.host.validatePreparedReferenceProjectNextAction(envelope))).toEqual(prepared.result);
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope)); expect(JSON.parse(JSON.stringify(useTaskStore.getState()._tasksById.get(target.id)))).toEqual(target);
            expect(allocate).not.toHaveBeenCalled(); allocate.mockRestore();
            await sqlite.restart(undefined, { recoveryLoad: true }); const replayAllocation = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Replay must not allocate'); });
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope)); expect(replayAllocation).not.toHaveBeenCalled(); replayAllocation.mockRestore();
        } finally { configureDateFormatting({ dateFormat: 'iso', language: 'en' }); await sqlite.close(); }
    });
    it('preserves exact existing Completion/Backdate/Capture/Lifecycle payload tuples with no extra fields', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const canonical = (v: unknown) => JSON.stringify(v, (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
        for (const kind of ['completion', 'backdate', 'capture', 'lifecycle', 'ordinaryCompletion', 'ordinaryUndo'] as const) {
            const fixture = seed(); if (kind.startsWith('ordinary')) fixture.tasks![0].status = 'next';
            const sqlite = await openSqliteHost(fixture);
            try { let envelope: unknown; let prefix: string;
                if (kind === 'ordinaryCompletion' || kind === 'ordinaryUndo') {
                    const source = useTaskStore.getState()._tasksById.get('source')!;
                    const request = { id: source.id, taskRevision: taskRevisionOf(source), requestId: ORIGIN };
                    const completion = { request, prepared: value(await sqlite.host.prepareTaskCompletion(request)).prepared };
                    expect(completion.prepared.version).toBe(1); value(await sqlite.host.commitPreparedTaskCompletion(completion));
                    envelope = completion; prefix = 'taskCompletion';
                    if (kind === 'ordinaryUndo') { const undoRequest = { requestId: WRITE, completionRequestId: ORIGIN };
                        const undo = value(await sqlite.host.prepareTaskCompletionUndo({ request: undoRequest, completion })).prepared;
                        expect(undo.version).toBe(1); expect(Object.keys(undo).sort()).toEqual(['version','kind','request','completion','witness','effect','result'].sort());
                        envelope = { request: undoRequest, prepared: undo }; prefix = 'taskCompletionUndo';
                        value(await sqlite.host.commitPreparedTaskCompletionUndo(envelope as never)); }
                } else if (kind === 'completion') { const proof = await origin(sqlite); envelope = proof.envelope; prefix = 'referenceTaskCompletion'; }
                else if (kind === 'backdate') { const source = useTaskStore.getState()._tasksById.get('source')!;
                    const request = { id: source.id, taskRevision: taskRevisionOf(source), requestId: ORIGIN, source: 'reference' as const, completedAt: NOW, timeSpentText: null };
                    const prepared = value(await sqlite.host.prepareReferenceTaskBackdate(request)).prepared; envelope = { request, prepared }; prefix = 'referenceTaskBackdate';
                    value(await sqlite.host.commitPreparedReferenceTaskBackdate(envelope as never)); }
                else if (kind === 'capture') { const options = value(sqlite.host.openQuickCapture()).options;
                    const planned = value(sqlite.host.prepareQuickCapture({ text: 'Old capture contract', options, captureId: ORIGIN }));
                    if (planned.kind !== 'prepared') throw new Error('Capture fixture'); envelope = { request: planned.prepared.request, prepared: planned.prepared }; prefix = 'preparedQuickCapture';
                    value(await sqlite.host.commitPreparedQuickCapture(envelope as never)); }
                else { const detail = value(sqlite.host.getProjectDetail({ projectId: 'project', offset: 0, limit: 50 }));
                    const request = { requestId: ORIGIN, projectId: 'project', projectRevision: detail.projectRevision, action: 'complete' as const };
                    const prepared = value(sqlite.host.prepareProjectLifecycle(request)).prepared; envelope = { request, prepared }; prefix = 'preparedProjectLifecycle';
                    value(await sqlite.host.commitPreparedProjectLifecycle(envelope as never)); }
                const [receipt] = await sqlite.sql<{ method: string }>('SELECT method FROM native_request_receipts WHERE request_id=?', [kind === 'ordinaryUndo' ? WRITE : ORIGIN]);
                if (kind === 'capture') {
                    // Existing prepared capture is intentionally not a durable
                    // request-receipt endpoint. Its unchanged default commit
                    // remains task-ID replay; the new prompt never calls it.
                    expect(receipt).toBeUndefined();
                    expect(Object.keys((envelope as { prepared: object }).prepared).sort()).toEqual(['version','request','task','project','deviceIdToInitialize','result'].sort());
                } else expect(receipt.method).toBe(`${prefix}:${uuid.deterministicHash128Hex(canonical([prefix, envelope]))}`);
                const before = await sqlite.sql('SELECT * FROM native_request_receipts'); await sqlite.restart(undefined, { recoveryLoad: true });
                expect(await sqlite.sql('SELECT * FROM native_request_receipts')).toEqual(before);
            } finally { await sqlite.close(); }
        }
    }, 10_000);
});

describe('Reference frozen Review Focus recovery', () => {
    it('retains exact reviewed-star intent through failed save/cold, refuses stale pending timezone, and ACKs saved proof before environment', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const timezone = process.env.TZ; const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('owned review failure'); } return client.run(sql, params);
        } }));
        try { const proof = await origin(sqlite); const options = value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }))!;
            const request = { requestId: WRITE, origin: options.origin, promptRevision: options.promptRevision, action: 'add' as const,
                text: 'Review due /waiting /review:2026-10-03 /*', openAfterSave: false };
            const prepared = value(await sqlite.host.prepareReferenceProjectNextAction({ request, origin: proof })).prepared;
            if (prepared.operation.kind !== 'add' || !prepared.operation.creation.focus) throw new Error('Expected frozen Focus');
            const envelope = { request, prepared }; expect(prepared.operation.task.isFocusedToday).toBe(true);
            expect(prepared.operation.creation.focus.dates.map(r => r.value)).toContain('2026-10-03');
            const before = await raw(sqlite); fault.commits = 10;
            expect(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await raw(sqlite)).toEqual(before);
            fault.commits = 0; resetForTests(); await sqlite.restart(undefined, { recoveryLoad: true });
            process.env.TZ = new Date(NOW).getTimezoneOffset() === 0 ? 'America/New_York' : 'UTC';
            expect(value(sqlite.host.validatePreparedReferenceProjectNextAction(envelope))).toEqual(prepared.result);
            const stale = await sqlite.host.commitPreparedReferenceProjectNextAction(envelope);
            expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([ORIGIN]);
            if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone;
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope)); const after = await raw(sqlite);
            expect(useTaskStore.getState()._tasksById.get(prepared.operation.task.id)?.isFocusedToday).toBe(true);
            const receipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            process.env.TZ = new Date(NOW).getTimezoneOffset() === 0 ? 'America/New_York' : 'UTC';
            configureDateFormatting({ language: 'fr', dateFormat: 'dmy' });
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope)); expect(await raw(sqlite)).toEqual(after);
            expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(receipts);
        } finally { if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone;
            configureDateFormatting({ language: 'en', dateFormat: 'iso' }); fault.commits = 0; await sqlite.close(); }
    }, 10_000);
});


describe('Reference prompt consumed Choose scope and strict resolved intent', () => {
    it('keeps large unrelated rows/settings out of Choose and preserves later harmless edits', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fixture = seed();
        fixture.tasks!.push(...Array.from({ length: 230 }, (_, index) => ({ ...task(`unrelated-${index}`, 'reference'), projectId: undefined, description: 'x'.repeat(10_000) })));
        fixture.settings = { ...fixture.settings, quickAddAutoClean: true, language: 'fr' };
        const sqlite = await openSqliteHost(fixture);
        try { const proof = await origin(sqlite); const envelope = await followup(sqlite, proof, 'choose');
            const op = envelope.prepared.operation; if (op.kind !== 'choose') throw new Error('Choose fixture');
            expect(op.lists.tasks.map(r => r.id)).toEqual(['candidate']); expect(op.lists.projects.map(r => r.id)).toEqual(['project']);
            expect(op.lists.sections).toEqual([]); expect(op.lists.areas).toEqual([]);
            expect(op.settings).toEqual({ deviceId: 'device-a', gtd: { focusTaskLimit: 3 } });
            expect(JSON.stringify(envelope).length).toBeLessThan(25_000);
            const [saved] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = JSON.parse(saved.data);
            settings.quickAddAutoClean = false; settings.language = 'de'; settings.gtd.autoArchiveDays = 99;
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            await sqlite.client().run('UPDATE tasks SET title=? WHERE id=?', ['unrelated later title', 'unrelated-0']);
            const before = await raw(sqlite); value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never));
            const after = await raw(sqlite); expect(after.settings).toEqual(before.settings);
            expect(after.tasks.rows.filter((r: any) => r.id.startsWith('unrelated-'))).toEqual(before.tasks.rows.filter((r: any) => r.id.startsWith('unrelated-')));
        } finally { await sqlite.close(); }
    }, 15_000);
    it('does not bind unrelated counted Focus rows when Choose does not fill a slot', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fixture = seed();
        fixture.tasks![1].isFocusedToday = true;
        fixture.tasks!.push({ ...task('counted-focus', 'next'), projectId: undefined, isFocusedToday: true },
            { ...task('not-counted', 'reference'), projectId: undefined, isFocusedToday: true });
        const sqlite = await openSqliteHost(fixture);
        try { const proof = await origin(sqlite); const envelope = await followup(sqlite, proof, 'choose');
            const op = envelope.prepared.operation; if (op.kind !== 'choose') throw new Error('Choose fixture');
            expect(op.effect.guards.focusCount).toBeNull(); expect(op.lists.tasks.map(r => r.id)).toEqual(['candidate']);
            await sqlite.client().run('UPDATE tasks SET isFocusedToday=0 WHERE id=?', ['counted-focus']);
            const before = await raw(sqlite); value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never));
            expect((await raw(sqlite)).tasks.rows.find((r: any) => r.id === 'counted-focus')).toEqual(before.tasks.rows.find((r: any) => r.id === 'counted-focus'));
            expect(await sqlite.receiptIds()).toEqual([ORIGIN, WRITE]);
        } finally { await sqlite.close(); }
    });
    it('rejects coherent padded or over-budget resolved intent before any SQL', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); let reads = 0;
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, all: async (...args) => { reads++; return client.all(...args); } }));
        try { const proof = await origin(sqlite); const envelope = await followup(sqlite, proof, 'add'); const before = await raw(sqlite);
            for (const field of ['title', 'description', 'assignedTo'] as const) { const bad = JSON.parse(JSON.stringify(envelope)); const op = bad.prepared.operation;
                const value = field === 'title' ? ' padded ' : 'x'.repeat(100_001);
                if (field === 'title') op.creation.intent.title = value; else op.creation.intent.props[field] = value;
                op.task[field] = value; const readBefore = reads;
                expect(sqlite.host.validatePreparedReferenceProjectNextAction(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await sqlite.host.commitPreparedReferenceProjectNextAction(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(reads).toBe(readBefore);
            }
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([ORIGIN]);
        } finally { await sqlite.close(); }
    });
});


describe('Reference prompt creation clocks and prewrite failure', () => {
    it('preserves independently sampled link and factory clocks against actual RN all nine tables', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const input = 'Clock /link:Fixture | https://example.com';
        const ids = ['00000000-0000-4000-8000-000000000193', '00000000-0000-4000-8000-000000000194'];
        const creationAt = '2026-10-03T13:00:00.017Z'; let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        const rn = await openSqliteHost(seed());
        try { await origin(rn); let index = 0; const allocation = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => {
                if (index === 0) vi.setSystemTime(new Date(creationAt)); if (!ids[index]) throw new Error('Unexpected allocation'); return ids[index++]; });
            const state = useTaskStore.getState(); const parsed = parseProjectNextActionInput(input, { projectId: 'project', projects: state._allProjects, areas: state._allAreas });
            expect((await useTaskStore.getState().addTask(parsed.title, parsed.props)).success).toBe(true); await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); allocation.mockRestore();
            const created = expected.tasks.find(r => r.id === ids[1])!; expect(created.createdAt).toBe(creationAt); expect(created.attachments![0].createdAt).toBe(NOW);
        } finally { await rn.close(); }
        vi.setSystemTime(new Date(NOW)); const native = await openSqliteHost(seed());
        try { const proof = await origin(native); const options = value(await native.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }))!;
            let index = 0; const allocation = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => {
                if (index === 0) vi.setSystemTime(new Date(creationAt)); if (!ids[index]) throw new Error('Unexpected allocation'); return ids[index++]; });
            const request = { requestId: WRITE, origin: options.origin, promptRevision: options.promptRevision, action: 'add' as const, text: input, openAfterSave: false };
            const prepared = value(await native.host.prepareReferenceProjectNextAction({ request, origin: proof })).prepared;
            value(await native.host.commitPreparedReferenceProjectNextAction({ request, prepared })); expect(index).toBe(2);
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!); allocation.mockRestore();
        } finally { await native.close(); }
    });
    it('does not reserve a written receipt on prewrite durable read failure, then exact retry applies once', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); let fault = false;
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, all: async (...args) => {
            if (fault && args[0].startsWith('SELECT')) throw new Error('fixture prewrite read failure'); return client.all(...args);
        } }));
        try { const proof = await origin(sqlite); const envelope = await followup(sqlite, proof, 'choose'); const before = await raw(sqlite);
            fault = true; expect(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault = false;
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([ORIGIN]);
            expect(value(sqlite.host.referenceProjectNextActionOutcome(envelope as never))).toBeNull();
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)); expect(useTaskStore.getState()._tasksById.get('candidate')?.status).toBe('next');
            expect(await sqlite.receiptIds()).toEqual([ORIGIN, WRITE]); const after = await raw(sqlite);
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)); expect(await raw(sqlite)).toEqual(after);
        } finally { fault = false; await sqlite.close(); }
    });
});


describe('Reference prompt current durable origin proof', () => {
    it.each(['delete', 'method', 'reply', 'savedAt'] as const)('rejects a warm cached origin after durable %s drift without writes', async drift => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); let mutations = 0;
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => { mutations++; return client.run(...args); } }));
        try { const proof = await origin(sqlite); const envelope = await followup(sqlite, proof, 'choose');
            if (drift === 'delete') await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [ORIGIN]);
            else if (drift === 'method') await sqlite.client().run('UPDATE native_request_receipts SET method=? WHERE request_id=?', ['referenceTaskCompletion:00000000000000000000000000000000', ORIGIN]);
            else if (drift === 'reply') await sqlite.client().run('UPDATE native_request_receipts SET reply=? WHERE request_id=?', [JSON.stringify({ id: 'foreign' }), ORIGIN]);
            else await sqlite.client().run('UPDATE native_request_receipts SET saved_at=? WHERE request_id=?', ['not-an-instant', ORIGIN]);
            // The old outcome cache still proves the landed origin, so this
            // specifically tests new-family current durable authority.
            expect(value(sqlite.host.taskCompletionOutcome(proof.envelope))).not.toBeNull();
            const before = await raw(sqlite); const receipts = await sqlite.sql('SELECT * FROM native_request_receipts'); const beforeMutations = mutations;
            expect(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(mutations).toBe(beforeMutations); expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.sql('SELECT * FROM native_request_receipts')).toEqual(receipts);
            expect(value(sqlite.host.referenceProjectNextActionOutcome(envelope as never))).toBeNull();
        } finally { await sqlite.close(); }
    });
    it('fails closed on durable receipt query errors without claiming a landed write, then retries once', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); let fault = false;
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, all: async (...args) => {
            if (fault && args[0].includes('FROM native_request_receipts WHERE request_id')) throw new Error('fixture receipt read failure'); return client.all(...args);
        } }));
        try { const proof = await origin(sqlite); const envelope = await followup(sqlite, proof, 'choose'); const before = await raw(sqlite);
            fault = true; expect(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault = false;
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([ORIGIN]);
            expect(value(sqlite.host.referenceProjectNextActionOutcome(envelope as never))).toBeNull();
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)); const after = await raw(sqlite); expect(await sqlite.receiptIds()).toEqual([ORIGIN, WRITE]);
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [ORIGIN]);
            fault = true; value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)); fault = false;
            expect(await raw(sqlite)).toEqual(after); expect(await sqlite.receiptIds()).toEqual([WRITE]);
        } finally { fault = false; await sqlite.close(); }
    });
});


describe('Reference prompt transactional receipt prerequisite', () => {
    it.each(['delete', 'replace', 'queryError'] as const)('rolls back domain and followup receipt when origin %s races after preflight, then retries exact owned write', async drift => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); let race = false; let preflightRead = false; let transactionReadFailure = false; let inTransaction = false; let transactionProofReads = 0;
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, all: async (...args) => {
            const prerequisiteQuery = args[0].includes('FROM native_request_receipts WHERE request_id');
            if (prerequisiteQuery && inTransaction) transactionProofReads++;
            if (transactionReadFailure && prerequisiteQuery) throw new Error('fixture transactional prerequisite read failure');
            const result = await client.all(...args); if (race && prerequisiteQuery) preflightRead = true; return result;
        }, run: async (sql, params) => {
            if (race && preflightRead && sql === 'BEGIN IMMEDIATE') { race = false;
                if (drift === 'delete') await client.run('DELETE FROM native_request_receipts WHERE request_id=?', [ORIGIN]);
                else if (drift === 'replace') await client.run('UPDATE native_request_receipts SET reply=? WHERE request_id=?', [JSON.stringify({ id: 'foreign' }), ORIGIN]);
                else transactionReadFailure = true;
            } const result = await client.run(sql, params);
            if (sql === 'BEGIN IMMEDIATE') inTransaction = true; else if (sql === 'COMMIT' || sql === 'ROLLBACK') inTransaction = false;
            return result;
        } }));
        try { const proof = await origin(sqlite); const envelope = await followup(sqlite, proof, 'choose');
            const [original] = await sqlite.sql<{ request_id: string; method: string; reply: string; saved_at: string }>('SELECT * FROM native_request_receipts WHERE request_id=?', [ORIGIN]);
            await sqlite.sql('PRAGMA wal_checkpoint(TRUNCATE)');
            const checkpoint = join(sqlite.dir, 'transaction-before.db'); copyFileSync(join(sqlite.dir, 'mindwtr.db'), checkpoint);
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)); const normal = await raw(sqlite); const normalReceipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            await sqlite.restart(checkpoint, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await sqlite.receiptIds()).toEqual([ORIGIN]); expect(value(sqlite.host.taskCompletionOutcome(proof.envelope))).not.toBeNull();
            transactionProofReads = 0; race = true;
            const raced = await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never);
            expect(raced).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).not.toContain(WRITE);
            expect(value(sqlite.host.referenceProjectNextActionOutcome(envelope as never))).toBeNull(); transactionReadFailure = false;
            expect(preflightRead).toBe(true); expect(race).toBe(false); expect(transactionProofReads).toBeGreaterThan(0); expect(inTransaction).toBe(false);
            await sqlite.client().run('INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET method=excluded.method,reply=excluded.reply,saved_at=excluded.saved_at',
                [original.request_id, original.method, original.reply, original.saved_at]);
            value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)); expect(await raw(sqlite)).toEqual(normal);
            expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(normalReceipts);
            // Proven commit releases the prerequisite. An unrelated ordinary
            // writer succeeds after original proof deletion, without checking it.
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [ORIGIN]);
            expect(await useTaskStore.getState().updateTask('candidate', { title: 'Later unrelated edit' })).toEqual({ success: true }); await flushPendingSave();
            expect(useTaskStore.getState()._tasksById.get('candidate')?.title).toBe('Later unrelated edit');
            const later = await raw(sqlite); value(await sqlite.host.commitPreparedReferenceProjectNextAction(envelope as never)); expect(await raw(sqlite)).toEqual(later);
        } finally { race = false; transactionReadFailure = false; await sqlite.close(); }
    }, 15_000);
    it('creates the Add row under Skip as RN addTask does, and replays an earlier Send row unchanged', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try { const proof = await origin(sqlite); const options = value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }))!;
            const add = (requestId: string) => ({ requestId, origin: options.origin, promptRevision: options.promptRevision, action: 'add' as const, text: 'Reminder default', openAfterSave: false });
            const sendRequest = add('00000000-0000-4000-8000-000000000195');
            const sent = value(await sqlite.host.prepareReferenceProjectNextAction({ request: sendRequest, origin: proof })).prepared;
            if (sent.operation.kind !== 'add') throw new Error('Expected Add');
            expect(sent.operation.task.suppressMindwtrReminders).toBe(false);
            await useTaskStore.getState().updateSettings({ taskReminderDefault: 'skip' }); await flushPendingSave();
            const request = add(WRITE);
            const prepared = value(await sqlite.host.prepareReferenceProjectNextAction({ request, origin: proof })).prepared;
            if (prepared.operation.kind !== 'add') throw new Error('Expected Add');
            expect(prepared.operation.task.suppressMindwtrReminders).toBe(true);
            expect(value(await sqlite.host.commitPreparedReferenceProjectNextAction({ request, prepared }))).toEqual(prepared.result);
            expect(useTaskStore.getState()._tasksById.get(prepared.operation.task.id)?.suppressMindwtrReminders).toBe(true);
            expect(value(sqlite.host.validatePreparedReferenceProjectNextAction({ request: sendRequest, prepared: sent }))).toEqual(sent.result);
            const ordinary = await useTaskStore.getState().addTask('Reference', { projectId: 'project' });
            expect(useTaskStore.getState()._tasksById.get(ordinary.id!)?.suppressMindwtrReminders).toBe(true);
        } finally { await sqlite.close(); }
    });
    it('parses Add with the shared quick-add options: feature gates, time estimates and known people, as the RN prompt does', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const start = seed(); start.settings = { ...start.settings!, features: { priorities: false, timeEstimates: true } };
        start.people = [{ id: 'person-john', name: 'John Smith', createdAt: NOW, updatedAt: NOW }];
        const sqlite = await openSqliteHost(start);
        try { const proof = await origin(sqlite); const options = value(await sqlite.host.getReferenceProjectNextActionOptions({ origin: proof, params: { offset: 0, revision: null } }))!;
            const prepare = async (requestId: string, text: string) => {
                const request = { requestId, origin: options.origin, promptRevision: options.promptRevision, action: 'add' as const, text, openAfterSave: false };
                const prepared = value(await sqlite.host.prepareReferenceProjectNextAction({ request, origin: proof })).prepared;
                if (prepared.operation.kind !== 'add') throw new Error('Expected Add');
                expect(value(sqlite.host.validatePreparedReferenceProjectNextAction({ request, prepared }))).toEqual(prepared.result);
                return prepared.operation.creation.intent;
            };
            const gated = await prepare('00000000-0000-4000-8000-000000000196', 'Call /priority:high');
            expect(gated.props.priority).toBeUndefined(); expect(gated.title).toBe('Call /priority:high');
            const estimated = await prepare('00000000-0000-4000-8000-000000000197', 'Draft /estimate:30m');
            expect(estimated.props.timeEstimate).toBe('30min'); expect(estimated.title).toBe('Draft');
            const assigned = await prepare('00000000-0000-4000-8000-000000000198', 'Ask %John Smith');
            expect(assigned.props.assignedTo).toBe('John Smith'); expect(assigned.title).toBe('Ask');
        } finally { await sqlite.close(); }
    });
});
