import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMindwtrAutomationService } from './mindwtr-automation-core';
import { createMindwtrAutomationStorage } from './mindwtr-automation-storage';
import { HELPER_RECEIPT_CAPACITY, helperDigest, helperTaskVersion } from './mindwtr-helper-reliability';
import { flushPendingSave, getPersistenceStatus, useTaskStore } from '@mindwtr/core';

const directories: string[] = [];
const profile = () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindwtr-helper-reliability-'));
    directories.push(directory);
    return { dataPath: join(directory, 'data.json'), dbPath: join(directory, 'mindwtr.db') };
};
const controls = { idempotencyKey: 'create-once', credential: 'test-credential' };
const startProcess = (code: string, paths: ReturnType<typeof profile>, extra: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, '-e', code], {
        cwd: import.meta.dir, env: { ...process.env, TEST_DATA_PATH: paths.dataPath, TEST_DB_PATH: paths.dbPath, ...extra },
        stdout: 'pipe', stderr: 'pipe',
    });
    const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { child, result };
};
const waitForFile = async (path: string) => {
    const deadline = Date.now() + 20_000;
    while (!existsSync(path)) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for helper process');
        await Bun.sleep(5);
    }
};

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('helper reliability through core and SQLite', () => {
    test('uses the canonical sorted JSON SHA-256 contract', () => {
        expect(helperDigest({ b: 2, a: 1 })).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
        expect(helperDigest({ b: { d: 4, c: 3 }, a: 1 })).toBe(helperDigest({ a: 1, b: { c: 3, d: 4 } }));
        expect(helperDigest({ '10': 1e-7, '2': 0.000001, text: '两个 🐢' }))
            .toBe(helperDigest({ text: '两个 🐢', '2': 0.000001, '10': 1e-7 }));
    });
    test('replays the original keyed task after a later edit and service restart', async () => {
        const paths = profile();
        const first = await createMindwtrAutomationService(paths);
        const created = await first.createTask({ title: 'Original' }, controls);
        await first.updateTask(created.id, { title: 'Later edit' });
        const restarted = await createMindwtrAutomationService(paths);
        expect(await restarted.createTask({ title: 'Original' }, controls)).toEqual(created);
        expect((await restarted.listTasks({ includeAll: true })).map((task) => task.title)).toEqual(['Later edit']);
    });

    test('rejects changed keyed input and keeps credential scopes independent', async () => {
        const service = await createMindwtrAutomationService(profile());
        await service.createTask({ title: 'Original' }, controls);
        await expect(service.createTask({ title: 'Changed' }, controls)).rejects.toThrow('idempotency_conflict');
        await service.createTask({ title: 'Other scope' }, { ...controls, credential: 'other-credential' });
        expect(await service.listTasks({ includeAll: true })).toHaveLength(2);
    });

    test('rejects stale patch and lifecycle actions without altering the saved rows', async () => {
        const paths = profile();
        const service = await createMindwtrAutomationService(paths);
        const created = await service.createTask({ title: 'Original' });
        const version = `sha256-${'0'.repeat(64)}`;
        for (const action of [
            () => service.updateTask(created.id, { title: 'Wrong' }, { expectedVersion: version }),
            () => service.completeTask(created.id, { expectedVersion: version }),
            () => service.archiveTask(created.id, { expectedVersion: version }),
        ]) await expect(action()).rejects.toThrow('task_version_conflict');
        expect(await service.getTask(created.id)).toEqual(created);
        const db = new Database(paths.dbPath, { readonly: true });
        try { expect(db.query('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 }); }
        finally { db.close(); }
    });

    test('does not stamp an unchanged patch but preserves derived date changes', async () => {
        const service = await createMindwtrAutomationService(profile());
        const created = await service.createTask({ title: 'Original', props: { dueDate: '2026-11-20' } });
        expect(await service.updateTask(created.id, { title: created.title, dueDate: created.dueDate })).toEqual(created);
        const changed = await service.updateTask(created.id, { dueDate: '2026-11-21' });
        expect(changed.dueDate).toBe('2026-11-21');
        expect(changed.rev).not.toBe(created.rev);
    });

    test('checks recurring completion before successor creation and archive never creates another successor', async () => {
        const service = await createMindwtrAutomationService(profile());
        const task = await service.createTask({ title: 'Recurring', props: {
            status: 'next', dueDate: '2026-11-10', recurrence: { rule: 'daily' },
        } });
        await expect(service.completeTask(task.id, { expectedVersion: `sha256-${'0'.repeat(64)}` }))
            .rejects.toThrow('task_version_conflict');
        expect(await service.listTasks({ includeAll: true })).toHaveLength(1);
        const completed = await service.completeTask(task.id, { expectedVersion: helperTaskVersion(task) });
        expect(completed.status).toBe('done');
        const tasks = await service.listTasks({ includeAll: true });
        expect(tasks).toHaveLength(2);
        const successor = tasks.find((item) => item.id !== task.id);
        expect(successor).toBeDefined();
        if (!successor) throw new Error('Missing recurring successor');
        expect((await service.archiveTask(successor.id, { expectedVersion: helperTaskVersion(successor) })).status).toBe('archived');
        expect(await service.listTasks({ includeAll: true })).toHaveLength(2);
    });

    test('persists a required derived change even when the explicitly supplied field is unchanged', async () => {
        const paths = profile();
        const service = await createMindwtrAutomationService(paths);
        const original = await service.createTask({ title: 'Inherited reminders' });
        expect(original.reminderPolicy).toBe('inherit');
        expect(original.suppressMindwtrReminders).toBe(false);
        const storage = createMindwtrAutomationStorage(paths);
        const data = await storage.getData();
        await storage.saveData({ ...data, settings: { ...data.settings, taskReminderDefault: 'skip' } });
        const changed = await service.updateTask(original.id, { reminderPolicy: original.reminderPolicy });
        expect(changed.reminderPolicy).toBe(original.reminderPolicy);
        expect(changed.suppressMindwtrReminders).toBe(true);
        expect(changed.rev).not.toBe(original.rev);
        expect((await storage.getData()).tasks[0].suppressMindwtrReminders).toBe(true);
    });

    test('does not mint a task receipt from an intermediate project-only capture save', async () => {
        const paths = profile();
        const service = await createMindwtrAutomationService(paths);
        const state = useTaskStore.getState();
        const addProject = state.addProject;
        const db = new Database(paths.dbPath, { readonly: true });
        let intermediateSaves = 0;
        const projectSave = spyOn(state, 'addProject').mockImplementation(async (...args) => {
            const result = await addProject(...args);
            await flushPendingSave();
            expect(db.query('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 1 });
            expect(db.query('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
            expect(db.query('SELECT COUNT(*) AS count FROM automation_create_receipts').get()).toEqual({ count: 0 });
            intermediateSaves += 1;
            return result;
        });
        try {
            const task = await service.createTask({ input: 'Task after project +Intermediate Project' }, controls);
            expect(intermediateSaves).toBe(1);
            expect(db.query('SELECT task_id FROM automation_create_receipts').get()).toEqual({ task_id: task.id });
        } finally {
            projectSave.mockRestore();
            useTaskStore.setState({ addProject });
            db.close();
        }
    });

    test('rolls back task and receipt together, then clears the failed operation context', async () => {
        const paths = profile();
        const service = await createMindwtrAutomationService(paths);
        const db = new Database(paths.dbPath);
        try {
            db.exec("CREATE TRIGGER reject_receipt AFTER INSERT ON automation_create_receipts BEGIN SELECT RAISE(ABORT, 'receipt refused'); END;");
            await expect(service.createTask({ title: 'Rollback' }, controls)).rejects.toThrow('receipt refused');
            expect(getPersistenceStatus()).toMatchObject({ queued: 0, inFlight: false, immediate: 0, retrying: false, failed: true });
            expect(db.query('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
            expect(db.query('SELECT COUNT(*) AS count FROM automation_create_receipts').get()).toEqual({ count: 0 });
            db.exec('DROP TRIGGER reject_receipt');
            const unrelated = await service.createTask({ title: 'Unrelated unkeyed task' });
            await Bun.sleep(200);
            expect(db.query('SELECT id FROM tasks').all()).toEqual([{ id: unrelated.id }]);
            expect(db.query('SELECT COUNT(*) AS count FROM automation_create_receipts').get()).toEqual({ count: 0 });
            const created = await service.createTask({ title: 'Rollback' }, controls);
            expect(db.query('SELECT task_id FROM automation_create_receipts').get()).toEqual({ task_id: created.id });
            expect(db.query('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 2 });
        } finally { db.close(); }
    }, 30_000);

    test('replays committed creation after the JSON mirror fails without attributing a project save', async () => {
        const paths = profile();
        const service = await createMindwtrAutomationService(paths);
        mkdirSync(`${paths.dataPath}.tmp`);
        await expect(service.createTask({ input: 'Receipt task +Receipt Project' }, controls)).rejects.toThrow();
        const db = new Database(paths.dbPath, { readonly: true });
        let taskId = '';
        try {
            const receipts = db.query('SELECT task_id FROM automation_create_receipts').all() as { task_id: string }[];
            expect(receipts).toHaveLength(1);
            taskId = receipts[0].task_id;
            expect(db.query('SELECT title FROM tasks WHERE id = ?').get(taskId)).toEqual({ title: 'Receipt task' });
            expect(db.query('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 1 });
        } finally { db.close(); }
        rmSync(`${paths.dataPath}.tmp`, { recursive: true });
        const restarted = await createMindwtrAutomationService(paths);
        const replay = await restarted.createTask({ input: 'Receipt task +Receipt Project' }, controls);
        expect(replay.id).toBe(taskId);
        expect(await restarted.listTasks({ includeAll: true })).toHaveLength(1);
    }, 30_000);

    test('keeps live receipts at capacity and permits expiry to start a new creation', async () => {
        const paths = profile();
        const service = await createMindwtrAutomationService(paths);
        const original = await service.createTask({ title: 'Original' }, controls);
        const db = new Database(paths.dbPath);
        try {
            db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < ?)
                INSERT INTO automation_create_receipts (scope, token, fingerprint, task_id, reply, expires_at)
                SELECT 'capacity', CAST(i AS TEXT), 'unused', 'unused', '{}', ? FROM n`).run(HELPER_RECEIPT_CAPACITY - 1, Date.now() + 60_000);
            expect(await service.createTask({ title: 'Original' }, controls)).toEqual(original);
            await expect(service.createTask({ title: 'Full' }, { ...controls, idempotencyKey: 'full' })).rejects.toThrow('idempotency_capacity');
            expect(db.query('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
            db.exec('UPDATE automation_create_receipts SET expires_at = 0');
            const next = await service.createTask({ title: 'Original' }, controls);
            expect(next.id).not.toBe(original.id);
            expect(db.query('SELECT COUNT(*) AS count FROM automation_create_receipts').get()).toEqual({ count: 1 });
            expect(db.query('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 2 });
        } finally { db.close(); }
    }, 30_000);

    test('two independently started processes commit only one task for a shared receipt', async () => {
        const paths = profile();
        await createMindwtrAutomationService(paths);
        const gate = join(paths.dataPath, '..', 'release');
        const code = `
            import { existsSync, writeFileSync } from 'node:fs';
            import { createMindwtrAutomationService } from './mindwtr-automation-core.ts';
            const service = await createMindwtrAutomationService({ dataPath: process.env.TEST_DATA_PATH, dbPath: process.env.TEST_DB_PATH });
            const props = { get status() {
                writeFileSync(process.env.TEST_READY, 'ready');
                while (!existsSync(process.env.TEST_GATE)) Bun.sleepSync(1);
                return 'inbox';
            } };
            const task = await service.createTask({ title: 'Concurrent receipt', props }, { credential: 'shared', idempotencyKey: 'shared' });
            console.log('RESULT:' + task.id);
        `;
        const workers = ['one', 'two'].map((name) => startProcess(code, paths, { TEST_READY: `${gate}-${name}`, TEST_GATE: gate }));
        try {
            await Promise.all(['one', 'two'].map((name) => waitForFile(`${gate}-${name}`)));
            writeFileSync(gate, 'release');
            const results = await Promise.all(workers.map((worker) => worker.result));
            for (const [status, _output, error] of results) expect({ status, error: status === 0 ? '' : error }).toEqual({ status: 0, error: '' });
            const ids = results.map(([, output]) => output.match(/RESULT:([^\s]+)/)?.[1]);
            expect(ids[0]).toBeTruthy();
            expect(ids[1]).toBe(ids[0]);
            const storage = createMindwtrAutomationStorage(paths);
            expect((await storage.getData()).tasks).toHaveLength(1);
            const db = new Database(paths.dbPath, { readonly: true });
            try { expect(db.query('SELECT COUNT(*) AS count FROM automation_create_receipts').get()).toEqual({ count: 1 }); }
            finally { db.close(); }
        } finally { for (const worker of workers) worker.child.kill(); }
    }, 45_000);

    test.each(['patch', 'complete', 'archive'])('rechecks %s conditions after an external write wins between refresh and save', async (action) => {
        const paths = profile();
        const service = await createMindwtrAutomationService(paths);
        const original = await service.createTask({ title: 'Original' });
        const ready = join(paths.dataPath, '..', 'ready');
        const release = join(paths.dataPath, '..', 'release');
        const code = `
            import { existsSync, writeFileSync } from 'node:fs';
            import { createMindwtrAutomationService } from './mindwtr-automation-core.ts';
            const service = await createMindwtrAutomationService({ dataPath: process.env.TEST_DATA_PATH, dbPath: process.env.TEST_DB_PATH });
            let paused = false;
            const controls = { get expectedVersion() {
                if (!paused) {
                    paused = true; writeFileSync(process.env.TEST_READY, 'ready');
                    while (!existsSync(process.env.TEST_RELEASE)) Bun.sleepSync(1);
                }
                return process.env.TEST_VERSION;
            } };
            try {
                if (process.env.TEST_ACTION === 'patch') await service.updateTask(process.env.TEST_ID, { title: 'Stale edit' }, controls);
                else if (process.env.TEST_ACTION === 'complete') await service.completeTask(process.env.TEST_ID, controls);
                else await service.archiveTask(process.env.TEST_ID, controls);
                throw new Error('Stale action unexpectedly succeeded');
            } catch (error) {
                if (error.message !== 'task_version_conflict') throw error;
                console.log('RESULT:conflict');
            }
        `;
        const worker = startProcess(code, paths, {
            TEST_READY: ready, TEST_RELEASE: release, TEST_VERSION: helperTaskVersion(original), TEST_ACTION: action, TEST_ID: original.id,
        });
        try {
            await waitForFile(ready);
            const storage = createMindwtrAutomationStorage(paths);
            const current = await storage.getData();
            await storage.saveData({ ...current, tasks: current.tasks.map((task) => ({ ...task, title: 'External edit', rev: (task.rev ?? 0) + 1 })) });
            writeFileSync(release, 'release');
            const [status, output, error] = await worker.result;
            expect({ status, error: status === 0 ? '' : error }).toEqual({ status: 0, error: '' });
            expect(output).toContain('RESULT:conflict');
            const saved = (await storage.getData()).tasks;
            expect(saved).toHaveLength(1);
            expect(saved[0]).toMatchObject({ title: 'External edit', status: 'inbox' });
        } finally { worker.child.kill(); }
    }, 45_000);
});
