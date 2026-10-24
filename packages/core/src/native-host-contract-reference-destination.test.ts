import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { buildTaskMovePatch, type TaskMoveDestination } from './task-container-rules';
import type { NativeReferenceTaskDestinationEnvelope } from './native-host-contract-task-checklist';
import type { AppData, Task } from './types';

const NOW = '2026-10-03T13:00:00.000Z';
const ID = 'reference-destination';
const UUID = '00000000-0000-4000-8000-000000000190';
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (patch: Partial<Task> = {}): Task => ({
    id: ID, title: '  Reference filing  ', status: 'reference', description: 'Retain memo and metadata',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z', rev: 3, revBy: 'device-a',
    tags: ['#first', '#second'], contexts: ['@home'], projectId: 'parent', sectionId: 'section',
    order: 2, orderNum: 2, boardOrder: 7, timeSpentMinutes: 45, isFocusedToday: true, focusOrder: 2,
    recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01',
    checklist: [{ id: 'duplicate', title: 'Keep', isCompleted: true }, { id: 'duplicate', title: '  ', isCompleted: false }],
    attachments: [{ id: 'attachment', kind: 'file', title: 'proof.txt', uri: 'file:///proof.txt', createdAt: NOW, updatedAt: NOW }],
    ...patch,
});
const seed = (source = task()): Partial<AppData> => ({
    tasks: [source, task({ id: 'ranked', status: 'next', projectId: 'other', sectionId: undefined, order: 11, orderNum: 11 })],
    projects: ['parent', 'other'].map((id, order) => ({ id, title: id, status: 'active', color: '#94a3b8', order, tagIds: [],
        createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a' })),
    sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }],
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: NOW, updatedAt: NOW }],
    people: [{ id: 'person', name: 'Person', createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: UUID, gtd: { autoArchiveDays: 1, focusTaskLimit: 1 } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const tables = ['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'];
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(tables.map(async table => [table,
    { schema: await sqlite.sql(`PRAGMA table_info(${table})`), rows: await sqlite.sql(`SELECT rowid AS evidenceRowid,* FROM ${table} ORDER BY rowid`) }])));
const rows = () => { const s = useTaskStore.getState(); return JSON.parse(JSON.stringify({ tasks: s._allTasks, projects: s._allProjects,
    sections: s._allSections, areas: s._allAreas, people: s._allPeople, settings: s.settings })) as AppData; };
const displayed = () => ({ id: ID, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!) });
const request = (destination: TaskMoveDestination = { kind: 'none' }) => ({ ...displayed(), requestId: UUID, source: 'reference' as const, destination });
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });
const cases: Array<[string, Partial<Task>, TaskMoveDestination]> = [
    ['none', {}, { kind: 'none' }], ['area', {}, { kind: 'area', id: 'area' }],
    ['different project', {}, { kind: 'project', id: 'other' }],
    ['missing order project', { order: undefined, orderNum: undefined }, { kind: 'project', id: 'other' }],
    ['same project retains section', {}, { kind: 'project', id: 'parent' }],
    ['same area', { projectId: undefined, sectionId: undefined, areaId: 'area' }, { kind: 'area', id: 'area' }],
    ['current None', { projectId: undefined, sectionId: undefined, areaId: undefined }, { kind: 'none' }],
];
describe('Reference destination uses actual RN row filing', () => {
    it.each(cases)('actual RN selected-choice revision semantics: %s', async (_name, patch, destination) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed(task(patch)));
        try {
            const source = useTaskStore.getState()._tasksById.get(ID)!;
            expect(await useTaskStore.getState().updateTask(ID, buildTaskMovePatch(destination, source))).toEqual({ success: true });
            await flushPendingSave(); const after = useTaskStore.getState()._tasksById.get(ID)!;
            expect(after.rev).toBe(source.rev! + 1); expect(after.updatedAt).toBe(NOW); expect(after.status).toBe('reference');
            expect(useTaskStore.getState()._allTasks).toHaveLength(2);
            if (destination.kind === 'project' && destination.id === 'parent') expect(after.sectionId).toBe('section');
        } finally { await sqlite.close(); }
    });
    it.each(cases)('matches actual RN full content/all nine tables: %s', async (_name, patch, destination) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const source = task(patch);
        const rn = await openSqliteHost(seed(source)); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try { const loaded = useTaskStore.getState()._tasksById.get(ID)!;
            expect(await useTaskStore.getState().updateTask(ID, buildTaskMovePatch(destination, loaded))).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed(source));
        try { const input = request(destination); const prepared = value(await native.host.prepareReferenceTaskDestination(input)).prepared;
            const envelope = { request: input, prepared };
            if (process.env.TASK190_EXPORT_DIR && ['none', 'area', 'different project'].includes(_name)) {
                const path = join(process.env.TASK190_EXPORT_DIR, `private-envelope-${destination.kind}.json`);
                expect(existsSync(path)).toBe(false); writeFileSync(path, JSON.stringify(envelope, null, 2));
            }
            expect(value(native.host.validatePreparedReferenceTaskDestination(envelope))).toEqual({ id: ID });
            expect(value(await native.host.commitPreparedReferenceTaskDestination(envelope))).toEqual({ id: ID });
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!); expect(await native.receiptIds()).toEqual([UUID]);
        } finally { await native.close(); }
    });
    it('returns RN choice order/search/selection with more than 100 choices and no read-side writes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fixture = seed(task({ projectId: undefined, sectionId: undefined, areaId: 'area' })); const parent = fixture.projects![0];
        fixture.projects = [...fixture.projects!, ...Array.from({ length: 133 }, (_, i) => ({ ...parent,
            id: `project-${i}`, title: i === 132 ? 'Café terminal' : `Project ${i}`, order: 200 - i, areaId: 'late-area' })),
            { ...parent, id: 'project-e\u0301', title: 'Unicode exact' }, { ...parent, id: 'project-é', title: 'Unicode exact' }];
        fixture.areas = [...fixture.areas!, { ...fixture.areas![0], id: 'late-area', name: 'Zone 10', order: 10 },
            { ...fixture.areas![0], id: 'early-area', name: 'Zone 2', order: -1 },
            { ...fixture.areas![0], id: 'deleted-area', deletedAt: NOW }];
        fixture.settings = { ...fixture.settings, gtd: { ...fixture.settings?.gtd, taskEditor: { defaultsVersion: 5, hidden: ['project', 'area'] } } };
        const sqlite = await openSqliteHost(fixture);
        try {
            const before = await raw(sqlite); const first = value(sqlite.host.getReferenceTaskDestinationOptions({ ...displayed(), query: '', offset: 0, limit: 100 }));
            expect(Object.keys(first).sort()).toEqual(['version', 'id', 'taskRevision', 'query', 'offset', 'limit', 'total', 'hasMore', 'nextOffset', 'choices', 'labels'].sort());
            expect(Object.keys(first.labels).sort()).toEqual(['title', 'search', 'projects', 'areas', 'cancel', 'more', 'retry', 'noMatches'].sort());
            expect(first.choices[0]).toMatchObject({ kind: 'none', id: '', selected: false });
            expect(first.choices[1]).toMatchObject({ kind: 'project', id: 'parent', selected: false });
            expect(first.choices[2]).toMatchObject({ kind: 'project', id: 'other' });
            expect(first.nextOffset).toBe(100); expect(first.hasMore).toBe(true);
            const last = value(sqlite.host.getReferenceTaskDestinationOptions({ ...displayed(), query: '', offset: 100, limit: 100 }));
            expect(last.choices.every(c => c.kind !== 'none')).toBe(true); expect(last.hasMore).toBe(false); expect(last.nextOffset).toBeNull();
            expect(last.choices.filter(c => c.kind === 'area').map(c => c.id)).toEqual(['early-area', 'area', 'late-area']);
            expect(last.choices.find(c => c.id === 'area')?.selected).toBe(true);
            expect(last.choices.map(c => c.id)).toContain('project-e\u0301'); expect(last.choices.map(c => c.id)).toContain('project-é');
            const found = value(sqlite.host.getReferenceTaskDestinationOptions({ ...displayed(), query: '  CAFÉ  ', offset: 0, limit: 100 }));
            expect(found.query).toBe('  CAFÉ  '); expect(found.choices.map(c => c.id)).toEqual(['', 'project-132']);
            const noAccent = value(sqlite.host.getReferenceTaskDestinationOptions({ ...displayed(), query: 'cafe', offset: 0, limit: 100 }));
            expect(noAccent.choices.map(c => c.id)).toEqual(['']);
            expect(value(sqlite.host.getReferenceTaskDestinationOptions({ ...displayed(), query: '', offset: 10_000, limit: 1 })).choices).toEqual([]);
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each([
        ['active', {}, true], ['waiting', { status: 'waiting' }, true], ['someday', { status: 'someday' }, true],
        ['archived', { status: 'archived' }, false], ['cancelled', { status: 'archived', cancelledAt: NOW }, false], ['deleted', { deletedAt: NOW }, false],
        ['purged', { deletedAt: NOW, purgedAt: NOW }, false],
    ] as const)('uses actual RN project availability: %s', async (_name, patch, available) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fixture = seed(); fixture.projects![1] = { ...fixture.projects![1], ...patch };
        const rn = await openSqliteHost(fixture); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try { const source = useTaskStore.getState()._tasksById.get(ID)!;
            // RN's row picker never offers unavailable destinations. The
            // programmatic updater may reactivate archived Projects; that is
            // a different entry path and must not invent a row picker choice.
            if (available) expect((await useTaskStore.getState().updateTask(ID, buildTaskMovePatch({ kind: 'project', id: 'other' }, source))).success).toBe(true);
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const native = await openSqliteHost(fixture);
        try {
            const options = value(native.host.getReferenceTaskDestinationOptions({ ...displayed(), query: '', offset: 0, limit: 100 }));
            expect(options.choices.some(c => c.kind === 'project' && c.id === 'other')).toBe(available);
            const input = request({ kind: 'project', id: 'other' }); const result = await native.host.prepareReferenceTaskDestination(input);
            expect(result.ok).toBe(available);
            if (result.ok) value(await native.host.commitPreparedReferenceTaskDestination({ request: input, prepared: result.value.prepared }));
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect(await native.receiptIds()).toHaveLength(available ? 1 : 0);
        } finally { await native.close(); }
    });
    it('rejects malformed/oversized request and page shapes without mutations or receipts', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const before = await raw(sqlite); const page = { ...displayed(), query: '', offset: 0, limit: 100 };
            for (const bad of [{ ...page, extra: true }, { ...page, query: 'x'.repeat(2001) }, { ...page, offset: -1 },
                { ...page, offset: Number.MAX_SAFE_INTEGER + 1 }, { ...page, limit: 101 }, { ...page, limit: 0 }, { ...page, offset: 0.5 }])
                expect(sqlite.host.getReferenceTaskDestinationOptions(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const valid = request();
            for (const bad of [{ ...valid, extra: true }, { ...valid, destination: { kind: 'none', id: '' } },
                { ...valid, destination: { kind: 'section', id: 'section' } }, { ...valid, destination: { kind: 'area', id: '' } },
                { ...valid, destination: { kind: 'project', id: 'x'.repeat(501) } }, { ...valid, source: 'done' },
                { ...valid, requestId: 'AAAAAAAA-0000-4000-8000-000000000190' },
                { ...valid, id: '\u0001'.repeat(500), taskRevision: '\u0001'.repeat(200), destination: { kind: 'project', id: '\u0001'.repeat(500) } }])
                expect(await sqlite.host.prepareReferenceTaskDestination(bad as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.host.prepareReferenceTaskDestination({ ...valid, taskRevision: 'old' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each(['none', 'same-project'] as const)('binds missing/deleted/reparented source Section for %s, without unrelated Section sensitivity', async choice => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const input = request(choice === 'none' ? { kind: 'none' } : { kind: 'project', id: 'parent' });
            const envelope = { request: input, prepared: value(await sqlite.host.prepareReferenceTaskDestination(input)).prepared };
            const [section] = await sqlite.sql<Record<string, unknown>>('SELECT * FROM sections WHERE id=?', ['section']);
            for (const change of ['delete', 'reparent', 'remove']) {
                if (change === 'delete') await sqlite.client().run('UPDATE sections SET deletedAt=? WHERE id=?', [NOW, 'section']);
                if (change === 'reparent') await sqlite.client().run('UPDATE sections SET projectId=? WHERE id=?', ['other', 'section']);
                if (change === 'remove') await sqlite.client().run('DELETE FROM sections WHERE id=?', ['section']);
                const before = await raw(sqlite);
                expect(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
                if (change === 'remove') await sqlite.client().run('INSERT INTO sections (id,projectId,title,orderNum,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
                    ['section', section.projectId, section.title, section.orderNum, section.createdAt, section.updatedAt]);
                if (change === 'remove') await sqlite.client().run('UPDATE tasks SET sectionId=? WHERE id=?', ['section', ID]);
                else await sqlite.client().run('UPDATE sections SET deletedAt=NULL,projectId=? WHERE id=?', ['parent', 'section']);
            }
            await sqlite.client().run('INSERT INTO sections (id,projectId,title,orderNum,createdAt,updatedAt) VALUES (?,?,?,?,?,?)', ['unrelated', 'other', 'Different', 0, NOW, NOW]);
            value(await sqlite.host.commitPreparedReferenceTaskDestination(envelope));
        } finally { await sqlite.close(); }
    });
    it('rechecks selected Project/Area and derived order semantics but permits unrelated task-order/settings changes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            for (const destination of [{ kind: 'project', id: 'other' }, { kind: 'area', id: 'area' }] as const) {
                const input = request(destination); const envelope = { request: input, prepared: value(await sqlite.host.prepareReferenceTaskDestination(input)).prepared };
                const table = destination.kind === 'project' ? 'projects' : 'areas';
                await sqlite.client().run(`UPDATE ${table} SET orderNum=orderNum+1 WHERE id=?`, [destination.id]); const before = await raw(sqlite);
                expect(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
                await sqlite.client().run(`UPDATE ${table} SET orderNum=orderNum-1 WHERE id=?`, [destination.id]);
                await sqlite.client().run(`UPDATE ${table} SET deletedAt=? WHERE id=?`, [NOW, destination.id]); const deleted = await raw(sqlite);
                expect(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(deleted); expect(await sqlite.receiptIds()).toEqual([]);
                await sqlite.client().run(`UPDATE ${table} SET deletedAt=NULL WHERE id=?`, [destination.id]);

            }
            const input = request({ kind: 'project', id: 'other' }); const envelope = { request: input, prepared: value(await sqlite.host.prepareReferenceTaskDestination(input)).prepared };
            await sqlite.client().run('UPDATE tasks SET orderNum=99 WHERE id=?', ['ranked']);
            const [saved] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = JSON.parse(saved.data);
            settings.gtd.autoArchiveDays = 99; settings.gtd.focusTaskLimit = 500; settings.showCompleted = true;
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            value(await sqlite.host.commitPreparedReferenceTaskDestination(envelope));
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({ projectId: 'other', order: 2, orderNum: 2 });
            const [after] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); expect(JSON.parse(after.data)).toEqual(settings);
        } finally { await sqlite.close(); }
    });
    it.each(['missing-to-empty', 'empty-to-missing'] as const)('refuses exact raw same-revision member drift after true recoveryLoad: %s', async direction => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const attachment = { id: 'attachment', kind: 'file', title: 'proof.txt', uri: 'file:///proof.txt', createdAt: NOW };
            const initial = direction === 'missing-to-empty' ? attachment : { ...attachment, updatedAt: '' };
            const changed = direction === 'missing-to-empty' ? { ...attachment, updatedAt: '' } : attachment;
            await sqlite.client().run('UPDATE tasks SET attachments=? WHERE id=?', [JSON.stringify([initial]), ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const input = request();
            const envelope = { request: input, prepared: value(await sqlite.host.prepareReferenceTaskDestination(input)).prepared };
            await sqlite.client().run('UPDATE tasks SET attachments=? WHERE id=?', [JSON.stringify([changed]), ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('preserves all raw siblings/settings/filters across failed COMMIT, owned retry and recreated recovery host', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('owned COMMIT failure'); } return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET pushCount=NULL,focusOrder=2,attachments=? WHERE id=?',
                ['[{"id":"legacy","kind":"file","title":"old.txt","uri":"file:///old.txt","createdAt":"2026-10-03T13:00:00.000Z"}]', 'ranked']);
            const [saved] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = JSON.parse(saved.data);
            delete settings.deviceId; settings.savedFilters = [{ id: 'raw-filter', name: 'Raw', view: 'tasks', criteria: { tags: ['#first'] }, createdAt: NOW, updatedAt: NOW }];
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings, null, 2)]);
            await sqlite.client().run('INSERT INTO saved_filters (id,name,view,criteria,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
                ['raw-filter', 'Raw', 'tasks', '{ "tags" : [ "#first" ] }', NOW, NOW]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const input = request({ kind: 'project', id: 'other' });
            const envelope = { request: input, prepared: value(await sqlite.host.prepareReferenceTaskDestination(input)).prepared };
            expect(envelope.prepared.checklist.effect.deviceIdBefore).toBeNull();
            const checkpoint = join(sqlite.dir, 'before-filing.sqlite'); await sqlite.client().run('VACUUM INTO ?', [checkpoint]);
            const before = await raw(sqlite); value(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)); const expected = await raw(sqlite);
            const receipts = await sqlite.sql('SELECT rowid,* FROM native_request_receipts ORDER BY rowid');
            expect(expected.saved_filters).toEqual(before.saved_filters);
            expect(expected.tasks.rows.find((row: Record<string, unknown>) => row.id === 'ranked')).toEqual(before.tasks.rows.find((row: Record<string, unknown>) => row.id === 'ranked'));
            expect(useTaskStore.getState().settings.deviceId).toBe(envelope.prepared.checklist.effect.deviceIdToInitialize);
            await sqlite.restart(checkpoint, { recoveryLoad: true }); fault.commits = 10;
            expect(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            fault.commits = 10; expect(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); fault.commits = 0;
            value(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)); expect(await raw(sqlite)).toEqual(expected);
            expect(await sqlite.sql('SELECT rowid,* FROM native_request_receipts ORDER BY rowid')).toEqual(receipts);
            await sqlite.restart(checkpoint, { recoveryLoad: true }); fault.commits = 10;
            expect(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.commits = 0;
            resetForTests(); await sqlite.restart(undefined, { recoveryLoad: true }); value(await sqlite.host.commitPreparedReferenceTaskDestination(envelope));
            expect(await raw(sqlite)).toEqual(expected); expect(await sqlite.sql('SELECT rowid,* FROM native_request_receipts ORDER BY rowid')).toEqual(receipts);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);
    it('uses exact receipt before later source/container edits and refuses equal-AFTER unused UUID', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const input = request(); const envelope = { request: input, prepared: value(await sqlite.host.prepareReferenceTaskDestination(input)).prepared };
            value(await sqlite.host.commitPreparedReferenceTaskDestination(envelope));
            const receipts = await sqlite.sql('SELECT rowid,* FROM native_request_receipts ORDER BY rowid');
            const unused = JSON.parse(JSON.stringify(envelope)); unused.request.requestId = '00000000-0000-4000-8000-000000000998';
            unused.prepared.request.requestId = unused.request.requestId; unused.prepared.checklist.request.requestId = unused.request.requestId;
            const equalAfter = await raw(sqlite); expect(value(sqlite.host.referenceTaskDestinationOutcome(unused))).toBeNull();
            expect(await sqlite.host.commitPreparedReferenceTaskDestination(unused)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(equalAfter);
            await sqlite.client().run('UPDATE tasks SET status=?,description=?,rev=rev+1 WHERE id=?', ['reference', 'Later edit', ID]);
            await sqlite.client().run('UPDATE projects SET deletedAt=? WHERE id=?', [NOW, 'parent']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(value(sqlite.host.referenceTaskDestinationOutcome(envelope))).toEqual({ id: ID });
            expect(value(await sqlite.host.commitPreparedReferenceTaskDestination(envelope))).toEqual({ id: ID });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.sql('SELECT rowid,* FROM native_request_receipts ORDER BY rowid')).toEqual(receipts);
            const forged = JSON.parse(JSON.stringify(envelope)); forged.prepared.rawBefore.tasks[0].before!.title = 'Different bound payload';
            expect(sqlite.host.referenceTaskDestinationOutcome(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally { await sqlite.close(); }
    });
    it('purely refuses forged filing/status/recurrence effects before any SQL mutation', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const input = request(); const envelope = { request: input, prepared: value(await sqlite.host.prepareReferenceTaskDestination(input)).prepared };
            const before = await raw(sqlite);
            for (const mutate of [
                (x: NativeReferenceTaskDestinationEnvelope) => { x.prepared.result.id = 'other'; },
                (x: NativeReferenceTaskDestinationEnvelope) => { x.prepared.checklist.witness.directClears = []; },
                (x: NativeReferenceTaskDestinationEnvelope) => { x.prepared.checklist.request.patch.status = 'done'; },
                (x: NativeReferenceTaskDestinationEnvelope) => { x.prepared.rawBefore.tasks[0].before!.focusOrder = 99; },
                (x: NativeReferenceTaskDestinationEnvelope) => { x.prepared.checklist.effect.tasks.push({ before: null, after: task({ id: 'extra-child' }) }); },
            ]) { const forged = JSON.parse(JSON.stringify(envelope)); mutate(forged);
                expect(sqlite.host.validatePreparedReferenceTaskDestination(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await sqlite.host.commitPreparedReferenceTaskDestination(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('refuses stale/raw scalar/device and effective archived-parent or deleted-Section sources', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const input = request(); const envelope = { request: input, prepared: value(await sqlite.host.prepareReferenceTaskDestination(input)).prepared };
            await sqlite.client().run('UPDATE tasks SET focusOrder=3 WHERE id=?', [ID]); const drift = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(drift); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('UPDATE tasks SET focusOrder=2 WHERE id=?', [ID]);
            const [saved] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = JSON.parse(saved.data);
            settings.deviceId = 'other-device'; await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]); const changed = await raw(sqlite);
            expect(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(changed); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('UPDATE tasks SET projectId=NULL WHERE id=?', [ID]);
            await sqlite.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'parent']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const readOnly = await raw(sqlite);
            expect(sqlite.host.getReferenceTaskDestinationOptions({ ...displayed(), query: '', offset: 0, limit: 100 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.host.prepareReferenceTaskDestination(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(readOnly); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('UPDATE projects SET status=? WHERE id=?', ['active', 'parent']);
            await sqlite.client().run('UPDATE sections SET deletedAt=? WHERE id=?', [NOW, 'section']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const deletedSection = await raw(sqlite);
            expect(await sqlite.host.prepareReferenceTaskDestination(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(deletedSection); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('a prewrite durable-read failure never lands a receipt and exact retry writes only after the read succeeds', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { reads: false };
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, all: async (sql, params) => {
            if (fault.reads && /FROM tasks/i.test(sql)) throw new Error('owned durable read failure'); return client.all(sql, params);
        } }));
        try {
            const input = request(); const envelope = { request: input, prepared: value(await sqlite.host.prepareReferenceTaskDestination(input)).prepared };
            const before = await raw(sqlite); fault.reads = true;
            expect(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(sqlite.host.referenceTaskDestinationOutcome(envelope))).toBeNull(); fault.reads = false;
            value(await sqlite.host.commitPreparedReferenceTaskDestination(envelope)); expect(await sqlite.receiptIds()).toEqual([UUID]);
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({ rev: 4, status: 'reference' });
        } finally { fault.reads = false; await sqlite.close(); }
    });

    it.each(['project-é', 'project-e\u0301'])('writes the exact Unicode destination identity through actual RN and native: %s', async id => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fixture = seed();
        fixture.projects = [...fixture.projects!, ...['project-é', 'project-e\u0301'].map(id => ({ ...fixture.projects![1], id, title: 'Same visible title' }))];
        const rn = await openSqliteHost(fixture); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try {
            const source = useTaskStore.getState()._tasksById.get(ID)!;
            expect(await useTaskStore.getState().updateTask(ID, buildTaskMovePatch({ kind: 'project', id }, source))).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
            expect(expected.tasks.find(t => t.id === ID)?.projectId).toBe(id);
        } finally { await rn.close(); }
        const native = await openSqliteHost(fixture);
        try {
            const input = request({ kind: 'project', id }); const prepared = value(await native.host.prepareReferenceTaskDestination(input)).prepared;
            value(await native.host.commitPreparedReferenceTaskDestination({ request: input, prepared }));
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect(rows().tasks.find(t => t.id === ID)?.projectId).toBe(id);
        } finally { await native.close(); }
    });

});
