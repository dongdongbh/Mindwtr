import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const BUN_BIN = Bun.which('bun') || process.execPath;
const tempDirs: string[] = [];

type CliResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

const makeTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cli-'));
    tempDirs.push(dir);
    return dir;
};

const runCli = (dataPath: string, args: string[]): CliResult => {
    const result = Bun.spawnSync({
        cmd: [BUN_BIN, 'scripts/mindwtr-cli.ts', '--', '--data', dataPath, ...args],
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
};

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe('mindwtr-cli', () => {
    test('repairs JSON-only task writes into sqlite storage', () => {
        const dir = makeTempDir();
        const dataPath = join(dir, 'data.json');
        const dbPath = join(dir, 'mindwtr.db');

        const added = runCli(dataPath, ['add', 'First task']);
        expect(added.exitCode).toBe(0);
        expect(existsSync(dataPath)).toBe(true);
        expect(existsSync(dbPath)).toBe(true);

        const data = JSON.parse(readFileSync(dataPath, 'utf8')) as { tasks: Array<Record<string, unknown>> };
        const baseTask = data.tasks[0];
        expect(baseTask).toBeDefined();
        const secondTask = {
            ...baseTask,
            id: 'json-only-task',
            title: 'JSON only task',
            createdAt: new Date('2026-03-09T12:00:00.000Z').toISOString(),
            updatedAt: new Date('2026-03-09T12:00:01.000Z').toISOString(),
            rev: Number(baseTask?.rev || 0) + 1,
        };
        data.tasks.push(secondTask);
        writeFileSync(dataPath, JSON.stringify(data, null, 2));

        const listed = runCli(dataPath, ['list', '--all']);
        expect(listed.exitCode).toBe(0);
        expect(listed.stdout).toContain('First task');
        expect(listed.stdout).toContain('JSON only task');

        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get('json-only-task') as { title: string } | null;
        db.close();
        expect(row?.title).toBe('JSON only task');
    });

    test('preserves projectId when repairing JSON-only project tasks', () => {
        const dir = makeTempDir();
        const dataPath = join(dir, 'data.json');
        const dbPath = join(dir, 'mindwtr.db');
        const now = '2026-04-27T12:00:00.000Z';
        const projectId = '11111111-1111-4111-8111-111111111111';
        const taskId = '22222222-2222-4222-8222-222222222222';

        writeFileSync(dataPath, JSON.stringify({
            tasks: [{
                id: taskId,
                title: 'Project task',
                status: 'next',
                tags: [],
                contexts: [],
                projectId,
                createdAt: now,
                updatedAt: now,
            }],
            projects: [{
                id: projectId,
                title: 'Alpha Project',
                status: 'active',
                color: '#94a3b8',
                order: 0,
                tagIds: [],
                createdAt: now,
                updatedAt: now,
            }],
            sections: [],
            areas: [],
            settings: {},
        }, null, 2));

        const fetched = runCli(dataPath, ['get', taskId]);
        expect(fetched.exitCode).toBe(0);
        const task = JSON.parse(fetched.stdout) as { projectId?: string };
        expect(task.projectId).toBe(projectId);

        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare('SELECT projectId FROM tasks WHERE id = ?').get(taskId) as { projectId: string } | null;
        db.close();
        expect(row?.projectId).toBe(projectId);
    });

    test('supports lifecycle commands and reference status updates', () => {
        const dir = makeTempDir();
        const dataPath = join(dir, 'data.json');

        const added = runCli(dataPath, ['add', 'Lifecycle task']);
        expect(added.exitCode).toBe(0);
        const taskId = added.stdout.trim();

        const updated = runCli(dataPath, ['update', taskId, '{"status":"reference"}']);
        expect(updated.exitCode).toBe(0);
        expect(updated.stdout).toContain('"status": "reference"');

        const deleted = runCli(dataPath, ['delete', taskId]);
        expect(deleted.exitCode).toBe(0);
        expect(deleted.stdout.trim()).toBe('ok');

        const listedDeleted = runCli(dataPath, ['list', '--all', '--deleted']);
        expect(listedDeleted.exitCode).toBe(0);
        expect(listedDeleted.stdout).toContain('[deleted]');

        const restored = runCli(dataPath, ['restore', taskId]);
        expect(restored.exitCode).toBe(0);
        expect(restored.stdout.trim()).toBe('ok');

        const archived = runCli(dataPath, ['archive', taskId]);
        expect(archived.exitCode).toBe(0);
        expect(archived.stdout.trim()).toBe('ok');

        const fetched = runCli(dataPath, ['get', taskId]);
        expect(fetched.exitCode).toBe(0);
        expect(fetched.stdout).toContain('"status": "archived"');

        const addedSecond = runCli(dataPath, ['add', 'Completable task']);
        expect(addedSecond.exitCode).toBe(0);
        const secondId = addedSecond.stdout.trim();

        const completed = runCli(dataPath, ['complete', secondId]);
        expect(completed.exitCode).toBe(0);
        expect(completed.stdout.trim()).toBe('ok');

        const completedTask = runCli(dataPath, ['get', secondId]);
        expect(completedTask.exitCode).toBe(0);
        expect(completedTask.stdout).toContain('"status": "done"');
    });

    test('rejects invalid task statuses', () => {
        const dir = makeTempDir();
        const dataPath = join(dir, 'data.json');

        const added = runCli(dataPath, ['add', 'Status task']);
        expect(added.exitCode).toBe(0);
        const taskId = added.stdout.trim();

        const invalid = runCli(dataPath, ['update', taskId, '{"status":"todo"}']);
        expect(invalid.exitCode).toBe(1);
        expect(invalid.stderr).toContain('Invalid status: todo');
    });
});
