import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeHostContract } from './native-host-contract';
import { NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { SqliteClient } from './sqlite-adapter';
import type { AppData, Task } from './types';

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
const AT = '2026-09-30T12:00:00.000Z';
const task: Task = { id: 'edit', title: 'Original', status: 'done', tags: [], contexts: [],
    recurrence: 'daily', showFutureRecurrence: false, focusOrder: 9,
    completedAt: AT, createdAt: AT, updatedAt: AT, rev: 7, revBy: 'original-device' };
const initial = (): AppData => ({ tasks: [task, { ...task, id: 'other', title: 'Untouched', status: 'next',
    focusOrder: undefined, recurrence: 'weekly' }],
    projects: [{ id: 'project', title: 'Project', status: 'active', color: '#94a3b8', order: 0,
        tagIds: [], createdAt: AT, updatedAt: AT }], sections: [],
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: AT, updatedAt: AT }], people: [],
    settings: { deviceId: 'editor-device' } });
const root = join(process.cwd(), '../../.orchestrator/tmp');
mkdirSync(root, { recursive: true });
const directories: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    for (const db of databases.splice(0)) db.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function open(path: string, seed = false) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(path); databases.push(db);
    const fault = { commits: 0 };
    const client = clientOf(db, fault);
    if (seed) await new NativeReceiptSqliteAdapter(client).saveData(initial());
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    await flushPendingSave();
    return { db, host, fault };
}

describe('native Task Editor v2 durable SQLite save', () => {
    it.each([
        { raw: 1.5, displayed: 2 },
        { raw: 100_005, displayed: 100_000 },
    ])('edits projected Time Spent from raw $raw with exact retry, replay and CAS', async ({ raw, displayed }) => {
        const directory = mkdtempSync(join(root, 'task-draft-v2-')); directories.push(directory);
        const path = join(directory, 'data.sqlite');
        const seed = await open(path, true);
        seed.db.prepare('UPDATE tasks SET timeSpentMinutes = ? WHERE id = ?').run(raw, 'edit');
        const { db, host, fault } = await open(path);
        expect(db.prepare('SELECT timeSpentMinutes FROM tasks WHERE id = ?').get('edit'))
            .toEqual({ timeSpentMinutes: raw });
        const opening = host.getTaskEditorModel({ id: 'edit' });
        if (!opening.ok) throw new Error(opening.error.message);
        expect(opening.value.draft.timeSpentMinutes).toBe(displayed);

        const title = { id: 'edit', base: { title: opening.value.draft.title },
            patch: { title: 'Unrelated title' }, scheduleBase: opening.value.scheduleBase };
        const titlePlan = await host.prepareTaskDraftSaveV2(title);
        if (!titlePlan.ok || titlePlan.value.kind !== 'prepared') throw new Error(JSON.stringify(titlePlan));
        expect(titlePlan.value.prepared.effect.task.after.timeSpentMinutes).toBe(raw);
        expect(await host.commitPreparedTaskDraftSave({ request: title, prepared: titlePlan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(db.prepare('SELECT timeSpentMinutes FROM tasks WHERE id = ?').get('edit'))
            .toEqual({ timeSpentMinutes: raw });

        const edited = host.getTaskEditorModel({ id: 'edit' });
        if (!edited.ok) throw new Error(edited.error.message);
        expect(edited.value.draft.timeSpentMinutes).toBe(displayed);
        const request = { id: 'edit', base: { timeSpentMinutes: displayed },
            patch: { timeSpentMinutes: 45 }, scheduleBase: edited.value.scheduleBase };
        const plan = await host.prepareTaskDraftSaveV2(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const prepared = plan.value.prepared;
        expect(prepared.effect.task.before.timeSpentMinutes).toBe(raw);
        expect(prepared.effect.task.after.timeSpentMinutes).toBe(45);
        const before = db.prepare('SELECT * FROM tasks ORDER BY id').all();
        fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            expect(await host.commitPreparedTaskDraftSave({ request, prepared }))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
        }
        fault.commits = 0;
        expect(await host.commitPreparedTaskDraftSave({ request, prepared })).toMatchObject({ ok: true });
        const committed = db.prepare('SELECT * FROM tasks ORDER BY id').all();
        expect(db.prepare('SELECT timeSpentMinutes, rev, updatedAt FROM tasks WHERE id = ?').get('edit'))
            .toEqual({ timeSpentMinutes: 45, rev: prepared.effect.task.after.rev,
                updatedAt: prepared.preparedAt });
        expect(committed.find((row) => (row as { id: string }).id === 'other'))
            .toEqual(before.find((row) => (row as { id: string }).id === 'other'));
        const cold = await open(path);
        expect(await cold.host.commitPreparedTaskDraftSave({ request, prepared })).toMatchObject({ ok: true });
        expect(cold.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(committed);
        cold.db.prepare('UPDATE tasks SET timeSpentMinutes = ?, rev = ?, revBy = ?, updatedAt = ? WHERE id = ?')
            .run(60, 80, 'other-device', '2026-09-30T13:00:00.000Z', 'edit');
        cold.db.prepare('UPDATE tasks SET timeSpentMinutes = ?, rev = ?, revBy = ?, updatedAt = ? WHERE id = ?')
            .run(45, 81, 'other-device', '2026-09-30T14:00:00.000Z', 'edit');
        const aba = cold.db.prepare('SELECT * FROM tasks ORDER BY id').all();
        const coldAgain = await open(path);
        expect(await coldAgain.host.commitPreparedTaskDraftSave({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(coldAgain.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(aba);
    }, 40_000);

    it('recovers an Assigned To save after two failed COMMITs and refuses a cold same-value ABA', async () => {
        const directory = mkdtempSync(join(root, 'task-draft-v2-')); directories.push(directory);
        const path = join(directory, 'data.sqlite');
        const { db, host, fault } = await open(path, true);
        const model = host.getTaskEditorModel({ id: 'edit' });
        if (!model.ok) throw new Error(model.error.message);
        const request = { id: 'edit', base: { assignedTo: model.value.draft.assignedTo },
            patch: { assignedTo: '  Casey  ' }, scheduleBase: model.value.scheduleBase };
        const plan = await host.prepareTaskDraftSaveV2(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const prepared = plan.value.prepared;
        const before = db.prepare('SELECT * FROM tasks ORDER BY id').all();
        fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            expect(await host.commitPreparedTaskDraftSave({ request, prepared }))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
        }
        fault.commits = 0;
        expect(await host.commitPreparedTaskDraftSave({ request, prepared }))
            .toMatchObject({ ok: true });
        const committed = db.prepare('SELECT * FROM tasks ORDER BY id').all();
        expect(db.prepare('SELECT assignedTo, rev, updatedAt FROM tasks WHERE id = ?').get('edit'))
            .toEqual({ assignedTo: 'Casey', rev: prepared.effect.task.after.rev, updatedAt: prepared.preparedAt });
        expect(committed.find((row) => (row as { id: string }).id === 'other'))
            .toEqual(before.find((row) => (row as { id: string }).id === 'other'));
        const cold = await open(path);
        expect(await cold.host.commitPreparedTaskDraftSave({ request, prepared })).toMatchObject({ ok: true });
        expect(cold.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(committed);
        cold.db.prepare('UPDATE tasks SET assignedTo = ?, rev = ?, revBy = ?, updatedAt = ? WHERE id = ?')
            .run('Other person', 80, 'other-device', '2026-09-30T13:00:00.000Z', 'edit');
        cold.db.prepare('UPDATE tasks SET assignedTo = ?, rev = ?, revBy = ?, updatedAt = ? WHERE id = ?')
            .run('Casey', 81, 'other-device', '2026-09-30T14:00:00.000Z', 'edit');
        const aba = cold.db.prepare('SELECT * FROM tasks ORDER BY id').all();
        const coldAgain = await open(path);
        expect(await coldAgain.host.commitPreparedTaskDraftSave({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(coldAgain.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(aba);
    }, 30_000);

    it('recovers a frozen Location save after failed COMMITs and refuses cold same-target ABA', async () => {
        const directory = mkdtempSync(join(root, 'task-draft-v2-')); directories.push(directory);
        const path = join(directory, 'data.sqlite');
        const { db, host, fault } = await open(path, true);
        db.prepare('UPDATE tasks SET recurrence = ?, focusOrder = ? WHERE id = ?').run('"daily"', 9, 'edit');
        const model = host.getTaskEditorModel({ id: 'edit' });
        if (!model.ok) throw new Error(model.error.message);
        const request = { id: 'edit', base: { location: model.value.draft.location },
            patch: { location: '  Clinic C  ' }, scheduleBase: model.value.scheduleBase };
        const plan = await host.prepareTaskDraftSaveV2(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const prepared = plan.value.prepared;
        const before = db.prepare('SELECT * FROM tasks ORDER BY id').all();
        fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            expect(await host.commitPreparedTaskDraftSave({ request, prepared }))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
        }
        fault.commits = 0;
        expect(await host.commitPreparedTaskDraftSave({ request, prepared })).toMatchObject({ ok: true });
        const committed = db.prepare('SELECT * FROM tasks ORDER BY id').all();
        expect(db.prepare('SELECT location, rev, updatedAt, focusOrder, recurrence FROM tasks WHERE id = ?').get('edit'))
            .toEqual({ location: 'Clinic C', rev: prepared.effect.task.after.rev,
                updatedAt: prepared.preparedAt, focusOrder: 9, recurrence: '"daily"' });
        const cold = await open(path);
        expect(await cold.host.commitPreparedTaskDraftSave({ request, prepared })).toMatchObject({ ok: true });
        expect(cold.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(committed);
        cold.db.prepare('UPDATE tasks SET location = ?, rev = ?, revBy = ?, updatedAt = ? WHERE id = ?')
            .run('Other', 80, 'other-device', '2026-09-30T13:00:00.000Z', 'edit');
        cold.db.prepare('UPDATE tasks SET location = ?, rev = ?, revBy = ?, updatedAt = ? WHERE id = ?')
            .run('Clinic C', 81, 'other-device', '2026-09-30T14:00:00.000Z', 'edit');
        const aba = db.prepare('SELECT * FROM tasks ORDER BY id').all();
        const coldAgain = await open(path);
        expect(await coldAgain.host.commitPreparedTaskDraftSave({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(coldAgain.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(aba);
    }, 30_000);

    it('keeps a literal JSON null recurrence distinct from SQL NULL on a title edit', async () => {
        const directory = mkdtempSync(join(root, 'task-draft-v2-')); directories.push(directory);
        const { db, host } = await open(join(directory, 'data.sqlite'), true);
        db.prepare('UPDATE tasks SET recurrence = ? WHERE id = ?').run('null', 'edit');
        const model = host.getTaskEditorModel({ id: 'edit' });
        if (!model.ok) throw new Error(model.error.message);
        const request = { id: 'edit', base: { title: model.value.draft.title }, patch: { title: 'Changed' },
            scheduleBase: model.value.scheduleBase };
        const plan = await host.prepareTaskDraftSaveV2(request);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(db.prepare('SELECT recurrence FROM tasks WHERE id = ?').get('edit')).toEqual({ recurrence: 'null' });
    });

    it('accepts the projected recurrence baseline while a date save keeps the legacy raw rule', async () => {
        const directory = mkdtempSync(join(root, 'task-draft-v2-')); directories.push(directory);
        const { db, host } = await open(join(directory, 'data.sqlite'), true);
        db.prepare('UPDATE tasks SET recurrence = ?, showFutureRecurrence = 0 WHERE id = ?').run('"daily"', 'edit');
        const opening = host.getTaskEditorModel({ id: 'edit' });
        if (!opening.ok) throw new Error(opening.error.message);
        const draft = opening.value.draft;
        const patch = { recurrence: draft.recurrence, recurrenceStrategy: draft.recurrenceStrategy,
            recurrenceRRule: draft.recurrenceRRule, showFutureRecurrence: draft.showFutureRecurrence,
            dueDate: '2036-10-05' };
        const request = { id: 'edit', patch, base: { ...patch, dueDate: draft.dueDate },
            scheduleBase: opening.value.scheduleBase, recurrenceBase: opening.value.recurrenceBase };
        const plan = await host.prepareTaskDraftSaveV2(request);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(db.prepare('SELECT recurrence, showFutureRecurrence, dueDate FROM tasks WHERE id = ?').get('edit'))
            .toEqual({ recurrence: '"daily"', showFutureRecurrence: 0, dueDate: '2036-10-05' });
    });

    it('leaves legacy blank checklist and inconsistent containers untouched on a title save', async () => {
        const directory = mkdtempSync(join(root, 'task-draft-v2-')); directories.push(directory);
        const { db, host } = await open(join(directory, 'data.sqlite'), true);
        const checklist = JSON.stringify([{ id: 'blank', title: ' ', isCompleted: false }]);
        db.prepare('UPDATE tasks SET checklist = ?, projectId = ?, areaId = ? WHERE id = ?')
            .run(checklist, 'project', 'area', 'edit');
        const model = host.getTaskEditorModel({ id: 'edit' });
        if (!model.ok) throw new Error(model.error.message);
        const request = { id: 'edit', base: { title: model.value.draft.title }, patch: { title: 'Changed' },
            scheduleBase: model.value.scheduleBase };
        const plan = await host.prepareTaskDraftSaveV2(request);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        const after = db.prepare('SELECT title, checklist, projectId, areaId FROM tasks WHERE id = ?').get('edit') as Record<string, unknown>;
        expect(after.title).toBe('Changed');
        expect(JSON.parse(after.checklist as string)).toEqual(JSON.parse(checklist));
        expect(after.projectId).toBe('project');
        expect(after.areaId).toBe('area');
    });

    it('preserves unrelated raw recurrence, false and terminal Focus columns on a title edit', async () => {
        const directory = mkdtempSync(join(root, 'task-draft-v2-')); directories.push(directory);
        const { db, host } = await open(join(directory, 'data.sqlite'), true);


        db.prepare('UPDATE tasks SET recurrence = ?, showFutureRecurrence = ?, focusOrder = ?, contexts = ? WHERE id = ?')
            .run('"daily"', 0, 9, '[ "@legacy" ]', 'edit');
        db.prepare('UPDATE tasks SET recurrence = ?, contexts = ? WHERE id = ?')
            .run('"weekly"', '[ "@untouched" ]', 'other');
        const before = db.prepare('SELECT recurrence, showFutureRecurrence, focusOrder, contexts FROM tasks WHERE id = ?').get('edit') as Record<string, unknown>;
        const otherBefore = db.prepare('SELECT recurrence, contexts FROM tasks WHERE id = ?').get('other');
        expect(before).toMatchObject({ recurrence: '"daily"', showFutureRecurrence: 0, focusOrder: 9 });
        const model = host.getTaskEditorModel({ id: 'edit' });
        if (!model.ok) throw new Error(model.error.message);
        const request = { id: 'edit', base: { title: model.value.draft.title }, patch: { title: 'Changed' },
            scheduleBase: model.value.scheduleBase };
        const prepared = await host.prepareTaskDraftSaveV2(request);
        expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!prepared.ok || prepared.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request, prepared: prepared.value.prepared })).toMatchObject({ ok: true });
        const after = db.prepare('SELECT recurrence, showFutureRecurrence, focusOrder, contexts FROM tasks WHERE id = ?').get('edit') as Record<string, unknown>;
        expect(after.recurrence).toBe(before.recurrence);
        expect(after.showFutureRecurrence).toBe(before.showFutureRecurrence);
        expect(after.focusOrder).toBe(before.focusOrder);

        expect(JSON.parse(after.contexts as string)).toEqual(JSON.parse(before.contexts as string));
        const otherAfter = db.prepare('SELECT recurrence, contexts FROM tasks WHERE id = ?').get('other') as Record<string, unknown>;
        expect(otherAfter.recurrence).toBe((otherBefore as Record<string, unknown>).recurrence);
        expect(JSON.parse(otherAfter.contexts as string)).toEqual(JSON.parse((otherBefore as Record<string, unknown>).contexts as string));
    });

    it('retries two failed COMMITs, then proves the exact frozen result after a cold reopen', async () => {
        const directory = mkdtempSync(join(root, 'task-draft-v2-')); directories.push(directory);
        const path = join(directory, 'data.sqlite');
        const { db, host, fault } = await open(path, true);
        db.prepare('UPDATE tasks SET recurrence = NULL WHERE id = ?').run('edit');
        const model = host.getTaskEditorModel({ id: 'edit' });
        if (!model.ok) throw new Error(model.error.message);
        const request = { id: 'edit', base: { title: model.value.draft.title }, patch: { title: 'Durable' },
            scheduleBase: model.value.scheduleBase };
        const plan = await host.prepareTaskDraftSaveV2(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const prepared = plan.value.prepared;
        const before = db.prepare('SELECT * FROM tasks ORDER BY id').all();


        fault.commits = 10;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            expect(await host.commitPreparedTaskDraftSave({ request, prepared }))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
        }
        fault.commits = 0;
        expect(await host.commitPreparedTaskDraftSave({ request, prepared })).toMatchObject({ ok: true });
        const committed = db.prepare('SELECT * FROM tasks ORDER BY id').all();
        expect(committed).not.toEqual(before);
        expect(db.prepare('SELECT title, rev, updatedAt FROM tasks WHERE id = ?').get('edit'))
            .toEqual({ title: 'Durable', rev: prepared.effect.task.after.rev, updatedAt: prepared.preparedAt });
        expect(db.prepare('SELECT recurrence FROM tasks WHERE id = ?').get('edit'))
            .toEqual({ recurrence: null });
        const cold = await open(path);
        expect(await cold.host.commitPreparedTaskDraftSave({ request, prepared })).toMatchObject({ ok: true });
        expect(cold.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(committed);
    }, 30_000);

    it('refuses an independently saved same title with a different revision and an ABA restore', async () => {
        const directory = mkdtempSync(join(root, 'task-draft-v2-')); directories.push(directory);
        const path = join(directory, 'data.sqlite');
        const { db, host } = await open(path, true);
        const model = host.getTaskEditorModel({ id: 'edit' });
        if (!model.ok) throw new Error(model.error.message);
        const request = { id: 'edit', base: { title: model.value.draft.title }, patch: { title: 'Same target' },
            scheduleBase: model.value.scheduleBase };
        const plan = await host.prepareTaskDraftSaveV2(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const prepared = plan.value.prepared;
        db.prepare('UPDATE tasks SET title = ?, rev = ?, revBy = ?, updatedAt = ? WHERE id = ?')
            .run('Same target', 80, 'other-device', '2026-09-30T13:00:00.000Z', 'edit');
        const changed = db.prepare('SELECT * FROM tasks ORDER BY id').all();
        const cold = await open(path);
        expect(await cold.host.commitPreparedTaskDraftSave({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(cold.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(changed);
        cold.db.prepare('UPDATE tasks SET title = ?, rev = ?, revBy = ?, updatedAt = ? WHERE id = ?')
            .run('Original', 81, 'other-device', '2026-09-30T14:00:00.000Z', 'edit');
        const aba = db.prepare('SELECT * FROM tasks ORDER BY id').all();
        const coldAgain = await open(path);
        expect(await coldAgain.host.commitPreparedTaskDraftSave({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(coldAgain.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(aba);
    });
});
