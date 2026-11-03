import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setTimeout as waitFor } from 'timers/promises';

import type { AppData, Person, Project, Task } from '@mindwtr/core';

import { createMindwtrAutomationStorage } from './mindwtr-automation-storage';
import { createMindwtrAutomationService } from './mindwtr-automation-core';

const tempDirs: string[] = [];

const makeProfile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mindwtr-automation-storage-'));
    tempDirs.push(dir);
    return { dataPath: join(dir, 'data.json'), dbPath: join(dir, 'mindwtr.db') };
};

const readRow = (dbPath: string, sql: string, id: string) => {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db.prepare(sql).get(id) as Record<string, unknown> | null;
    } finally {
        db.close();
    }
};

const readRows = (dbPath: string, sql: string, ...params: unknown[]) => {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    } finally {
        db.close();
    }
};

const emptyData = (): AppData => ({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} });

const project = (id: string, title: string, status: Project['status'] = 'active'): Project => ({
    id,
    title,
    status,
    color: '#3b82f6',
    order: 0,
    tagIds: [],
    rev: 1,
    revBy: 'seed',
    createdAt: '2026-09-22T12:00:00.000Z',
    updatedAt: '2026-09-22T12:00:00.000Z',
});

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe('automation script sqlite writes', () => {
    test('preserves people and their notes while migrating JSON into SQLite and its mirror', async () => {
        const { dataPath, dbPath } = makeProfile();
        const now = '2026-09-22T12:00:00.000Z';
        const person: Person = {
            id: 'person-json-migration',
            name: 'Alex',
            note: 'Design lead\nKeeps **project context**.',
            referenceLink: 'https://example.com/alex',
            createdAt: now,
            updatedAt: now,
        };
        writeFileSync(dataPath, JSON.stringify({
            ...emptyData(),
            people: [person],
        }, null, 2));

        const stdoutSpy = spyOn(console, 'info').mockImplementation(() => undefined);
        const stderrLines: string[] = [];
        const stderrTarget = process.stderr as unknown as { write: (chunk: string) => boolean };
        const stderrSpy = spyOn(stderrTarget, 'write').mockImplementation((chunk) => {
            stderrLines.push(chunk);
            return true;
        });
        try {
            const storage = createMindwtrAutomationStorage({ dataPath, dbPath });
            const loaded = await storage.getData();

            expect(loaded.people).toEqual([person]);
            expect(readRow(dbPath, 'SELECT id, name, note, referenceLink FROM people WHERE id = ?', person.id))
                .toEqual({ id: person.id, name: person.name, note: person.note, referenceLink: person.referenceLink });
            expect((JSON.parse(readFileSync(dataPath, 'utf8')) as AppData).people).toEqual([person]);
            expect(stdoutSpy).not.toHaveBeenCalled();
            expect(JSON.parse(stderrLines.join('').trim())).toMatchObject({
                level: 'info',
                scope: 'automation-storage',
                message: 'Automation people preserved during storage migration',
                context: {
                    releaseCheck: 'v1.3.2/automation-people-preserved',
                    count: 1,
                },
            });
        } finally {
            stderrSpy.mockRestore();
            stdoutSpy.mockRestore();
        }
    });

    test('stores every task column the API accepts, not just the ones it once listed', async () => {
        const { dataPath, dbPath } = makeProfile();
        const service = await createMindwtrAutomationService({ dataPath, dbPath });

        const created = await service.createTask({
            title: 'Call Bob',
            props: { status: 'waiting', assignedTo: 'Bob', energyLevel: 'high', timeSpentMinutes: 12 },
        });
        expect(created).toMatchObject({ assignedTo: 'Bob', energyLevel: 'high', timeSpentMinutes: 12 });

        expect(readRow(dbPath, 'SELECT assignedTo, energyLevel, timeSpentMinutes FROM tasks WHERE id = ?', created.id))
            .toEqual({ assignedTo: 'Bob', energyLevel: 'high', timeSpentMinutes: 12 });
    });

    test('creates and durably routes a quick-add project while explicit props win', async () => {
        const { dataPath, dbPath } = makeProfile();
        const service = await createMindwtrAutomationService({ dataPath, dbPath });
        const stderrLines: string[] = [];
        const stderrTarget = process.stderr as unknown as { write: (chunk: string) => boolean };
        const stderrSpy = spyOn(stderrTarget, 'write').mockImplementation((chunk) => {
            stderrLines.push(chunk);
            return true;
        });
        const created = await (async () => {
            try {
                return await service.createTask({
                    input: 'Prepare brief +Launch /due:2026-10-02',
                    props: { status: 'waiting', dueDate: '2026-10-01' },
                });
            } finally {
                stderrSpy.mockRestore();
            }
        })();

        expect(readRow(dbPath, `
            SELECT tasks.title, tasks.status, tasks.dueDate, projects.title AS projectTitle
            FROM tasks JOIN projects ON projects.id = tasks.projectId
            WHERE tasks.id = ?
        `, created.id)).toEqual({
            title: 'Prepare brief',
            status: 'waiting',
            dueDate: '2026-10-01',
            projectTitle: 'Launch',
        });
        const mirror = JSON.parse(readFileSync(dataPath, 'utf8')) as AppData;
        expect(mirror.tasks.find((task) => task.id === created.id)).toMatchObject({
            status: 'waiting',
            dueDate: '2026-10-01',
            projectId: mirror.projects.find((item) => item.title === 'Launch')?.id,
        });
        expect(JSON.parse(stderrLines.join('').trim())).toMatchObject({
            level: 'info',
            scope: 'automation-storage',
            message: 'Automation quick-add project routing completed',
            context: {
                releaseCheck: 'v1.3.2/automation-capture-project-routing',
                outcome: 'created',
            },
        });
    });

    test('preserves store status inference when capture status is omitted', async () => {
        const { dataPath, dbPath } = makeProfile();
        const service = await createMindwtrAutomationService({ dataPath, dbPath });
        const stderrLines: string[] = [];
        const stderrTarget = process.stderr as unknown as { write: (chunk: string) => boolean };
        const stderrSpy = spyOn(stderrTarget, 'write').mockImplementation((chunk) => {
            stderrLines.push(chunk);
            return true;
        });

        let started: Task;
        let cancelled: Task;
        let explicitInbox: Task;
        try {
            started = await service.createTask({
                title: 'Started without status',
                props: { startTime: '2026-10-01' },
            });
            cancelled = await service.createTask({
                title: 'Cancelled without status',
                props: { cancelledAt: '2026-09-22T12:00:00.000Z' },
            });
            explicitInbox = await service.createTask({
                title: 'Explicit inbox with start',
                props: { status: 'inbox', startTime: '2026-10-01' },
            });
        } finally {
            stderrSpy.mockRestore();
        }

        expect([started!.status, cancelled!.status, explicitInbox!.status]).toEqual([
            'next',
            'archived',
            'inbox',
        ]);
        expect(cancelled!.cancelledAt).toBe('2026-09-22T12:00:00.000Z');
        expect(readRow(dbPath, 'SELECT cancelledAt FROM tasks WHERE id = ?', cancelled!.id)).toEqual({
            cancelledAt: '2026-09-22T12:00:00.000Z',
        });
        expect(readRows(dbPath, 'SELECT title, status FROM tasks ORDER BY title')).toEqual([
            { title: 'Cancelled without status', status: 'archived' },
            { title: 'Explicit inbox with start', status: 'inbox' },
            { title: 'Started without status', status: 'next' },
        ]);
        expect((JSON.parse(readFileSync(dataPath, 'utf8')) as AppData).tasks
            .map((task) => ({ title: task.title, status: task.status }))
            .sort((a, b) => a.title.localeCompare(b.title))).toEqual([
            { title: 'Cancelled without status', status: 'archived' },
            { title: 'Explicit inbox with start', status: 'inbox' },
            { title: 'Started without status', status: 'next' },
        ]);
        expect(stderrLines.filter((line) => line.includes('v1.3.2/automation-capture-implicit-status')))
            .toHaveLength(2);
    });

    test('reuses an active project named by quick add', async () => {
        const { dataPath, dbPath } = makeProfile();
        const existing = project('active-roadmap', 'Roadmap');
        await createMindwtrAutomationStorage({ dataPath, dbPath }).saveData({
            ...emptyData(),
            projects: [existing],
        });
        const service = await createMindwtrAutomationService({ dataPath, dbPath });
        const stderrLines: string[] = [];
        const stderrTarget = process.stderr as unknown as { write: (chunk: string) => boolean };
        const stderrSpy = spyOn(stderrTarget, 'write').mockImplementation((chunk) => {
            stderrLines.push(chunk);
            return true;
        });

        const created = await (async () => {
            try {
                return await service.createTask({ input: 'Draft plan +Roadmap' });
            } finally {
                stderrSpy.mockRestore();
            }
        })();

        expect(created.projectId).toBe(existing.id);
        expect(readRows(dbPath, 'SELECT id FROM projects WHERE title = ?', existing.title)).toEqual([{ id: existing.id }]);
        const mirror = JSON.parse(readFileSync(dataPath, 'utf8')) as AppData;
        expect(mirror.tasks.find((task) => task.id === created.id)?.projectId).toBe(existing.id);
        expect(mirror.projects).toHaveLength(1);
        expect(JSON.parse(stderrLines.join('').trim())).toMatchObject({
            context: {
                releaseCheck: 'v1.3.2/automation-capture-project-routing',
                outcome: 'reused',
            },
        });
    });

    test('lets an explicit project override a parsed quick-add project', async () => {
        const { dataPath, dbPath } = makeProfile();
        const explicit = project('explicit-project', 'Explicit');
        await createMindwtrAutomationStorage({ dataPath, dbPath }).saveData({
            ...emptyData(),
            projects: [explicit],
        });
        const service = await createMindwtrAutomationService({ dataPath, dbPath });

        const created = await service.createTask({
            input: 'Draft plan +Parsed',
            props: { projectId: explicit.id },
        });

        expect(created.projectId).toBe(explicit.id);
        expect(readRows(dbPath, 'SELECT id, title FROM projects')).toEqual([{ id: explicit.id, title: explicit.title }]);
        const mirror = JSON.parse(readFileSync(dataPath, 'utf8')) as AppData;
        expect(mirror.tasks.find((task) => task.id === created.id)?.projectId).toBe(explicit.id);
        expect(mirror.projects).toEqual([expect.objectContaining({ id: explicit.id, title: explicit.title })]);
    });

    test('creates a fresh active project instead of assigning to an archived name match', async () => {
        const { dataPath, dbPath } = makeProfile();
        const archived = project('archived-roadmap', 'Roadmap', 'archived');
        await createMindwtrAutomationStorage({ dataPath, dbPath }).saveData({
            ...emptyData(),
            projects: [archived],
        });
        const service = await createMindwtrAutomationService({ dataPath, dbPath });

        const created = await service.createTask({ input: 'Restart planning +Roadmap' });

        expect(created.projectId).not.toBe(archived.id);
        expect(readRows(dbPath, 'SELECT id, status FROM projects WHERE title = ? ORDER BY id', archived.title))
            .toEqual(expect.arrayContaining([
                { id: archived.id, status: 'archived' },
                { id: created.projectId, status: 'active' },
            ]));
        const mirror = JSON.parse(readFileSync(dataPath, 'utf8')) as AppData;
        expect(mirror.projects).toHaveLength(2);
        expect(mirror.tasks.find((task) => task.id === created.id)?.projectId).toBe(created.projectId);
    });

    test('rejects an invalid quick-add date before creating either project or task', async () => {
        const { dataPath, dbPath } = makeProfile();
        const service = await createMindwtrAutomationService({ dataPath, dbPath });
        const stderrLines: string[] = [];
        const stderrTarget = process.stderr as unknown as { write: (chunk: string) => boolean };
        const stderrSpy = spyOn(stderrTarget, 'write').mockImplementation((chunk) => {
            stderrLines.push(chunk);
            return true;
        });

        try {
            await expect(service.createTask({ input: 'Broken capture +Orphan /due:notadate' }))
                .rejects.toThrow('Invalid date command: /due:notadate');
        } finally {
            stderrSpy.mockRestore();
        }

        expect(readRows(dbPath, 'SELECT id FROM projects')).toEqual([]);
        expect(readRows(dbPath, 'SELECT id FROM tasks')).toEqual([]);
        const mirror = JSON.parse(readFileSync(dataPath, 'utf8')) as AppData;
        expect(mirror.projects).toEqual([]);
        expect(mirror.tasks).toEqual([]);
        expect(stderrLines.join('')).not.toContain('v1.3.2/automation-capture-project-routing');
    });

    test('writes into the installed data/ layout instead of orphaning a database at a pinned flat path', async () => {
        const { dataPath, dbPath } = makeProfile();
        const root = join(dataPath, '..');
        const movedData = join(root, 'data', 'data.json');
        const movedDb = join(root, 'data', 'mindwtr.db');


        const moved = createMindwtrAutomationStorage({ dataPath: movedData, dbPath: movedDb });
        await moved.saveData(emptyData());
        expect(existsSync(movedDb)).toBe(true);

        const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const pinned = createMindwtrAutomationStorage({ dataPath, dbPath });
            expect(pinned.paths).toEqual({ dataPath: movedData, dbPath: movedDb });
            await pinned.saveData({
                ...emptyData(),
                tasks: [{
                    id: 'pinned-path-task',
                    title: 'Captured through a pinned flat path',
                    status: 'inbox',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-09-18T12:00:00.000Z',
                    updatedAt: '2026-09-18T12:00:00.000Z',
                } as Task],
            });
        } finally {
            errorSpy.mockRestore();
        }

        expect(readRow(movedDb, 'SELECT title FROM tasks WHERE id = ?', 'pinned-path-task'))
            .toEqual({ title: 'Captured through a pinned flat path' });
        expect(existsSync(dbPath)).toBe(false);
        expect(existsSync(dataPath)).toBe(false);
    });

    test('never rewrites an unrelated data.json that merely shares the name', async () => {
        const { dataPath } = makeProfile();
        const root = join(dataPath, '..');
        const unrelated = join(root, 'data.json');
        const contents = '{"someOtherTool":true}';
        writeFileSync(unrelated, contents);


        const pinnedData = join(root, 'data', 'data.json');
        const pinnedDb = join(root, 'data', 'mindwtr.db');
        const storage = createMindwtrAutomationStorage({ dataPath: pinnedData, dbPath: pinnedDb });
        await storage.saveData(emptyData());

        expect(storage.paths).toEqual({ dataPath: pinnedData, dbPath: pinnedDb });
        expect(readFileSync(unrelated, 'utf8')).toBe(contents);
        expect(existsSync(pinnedDb)).toBe(true);
    });

    test('refuses to overwrite a newer row with an older revision', async () => {
        const { dataPath, dbPath } = makeProfile();
        const now = '2026-09-18T12:00:00.000Z';
        const task = (rev: number, title: string): Task => ({
            id: 'rev-guard-task',
            title,
            status: 'next',
            tags: [],
            contexts: [],
            rev,
            createdAt: now,
            updatedAt: now,
        } as Task);

        const seed = createMindwtrAutomationStorage({ dataPath, dbPath });
        await seed.saveData({ ...emptyData(), tasks: [task(5, 'Newer desktop write')] });


        const stale = createMindwtrAutomationStorage({ dataPath, dbPath });
        await stale.saveData({ ...emptyData(), tasks: [task(4, 'Stale automation write')] });

        expect(readRow(dbPath, 'SELECT rev, title FROM tasks WHERE id = ?', 'rev-guard-task'))
            .toEqual({ rev: 5, title: 'Newer desktop write' });
        const mirror = JSON.parse(readFileSync(dataPath, 'utf8')) as AppData;
        expect(mirror.tasks.find((item) => item.id === 'rev-guard-task')?.title)
            .toBe('Newer desktop write');
    });

    test('rejects an equal-revision write after another storage instance commits', async () => {
        const { dataPath, dbPath } = makeProfile();
        const createdAt = '2026-09-22T12:00:00.000Z';
        const updatedAt = '2026-09-22T12:01:00.000Z';
        const original: Task = {
            id: 'equal-revision-race',
            title: 'Original',
            status: 'next',
            tags: [],
            contexts: [],
            rev: 1,
            revBy: 'seed',
            createdAt,
            updatedAt: createdAt,
        };
        const seed = createMindwtrAutomationStorage({ dataPath, dbPath });
        await seed.saveData({ ...emptyData(), tasks: [original] });

        const stale = createMindwtrAutomationStorage({ dataPath, dbPath });
        const current = createMindwtrAutomationStorage({ dataPath, dbPath });
        const staleSnapshot = await stale.getData();
        const currentSnapshot = await current.getData();
        await current.saveData({
            ...currentSnapshot,
            tasks: [{ ...currentSnapshot.tasks[0], title: 'Current writer', rev: 2, revBy: 'shared', updatedAt }],
        });

        await expect(stale.saveData({
            ...staleSnapshot,
            tasks: [{ ...staleSnapshot.tasks[0], title: 'Stale writer', rev: 2, revBy: 'shared', updatedAt }],
        })).rejects.toThrow('SQLITE_BUSY: database changed after the automation snapshot was loaded');
        expect(readRow(dbPath, 'SELECT rev, title FROM tasks WHERE id = ?', original.id))
            .toEqual({ rev: 2, title: 'Current writer' });
        const mirror = JSON.parse(readFileSync(dataPath, 'utf8')) as AppData;
        expect(mirror.tasks.find((task) => task.id === original.id)?.title).toBe('Current writer');
    });

    test('preserves concurrent service operations in SQLite and the mirror', async () => {
        const { dataPath, dbPath } = makeProfile();
        const gatePath = join(dataPath, '..', 'start');
        const workerCode = `
            import { existsSync, writeFileSync } from 'fs';
            import { createMindwtrAutomationService } from './mindwtr-automation-core.ts';
            const service = await createMindwtrAutomationService({
                dataPath: process.env.TEST_DATA_PATH,
                dbPath: process.env.TEST_DB_PATH,
            });
            writeFileSync(process.env.TEST_READY_PATH, 'ready');
            while (!existsSync(process.env.TEST_GATE_PATH)) {
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
            await service.createTask({ title: process.env.TEST_TASK_TITLE });
        `;
        const stderr: string[] = ['', ''];
        const workers = ['First concurrent task', 'Second concurrent task'].map((title, index) => {
            const worker = spawn(process.execPath, ['-e', workerCode], {
                cwd: import.meta.dir,
                env: {
                    ...process.env,
                    TEST_DATA_PATH: dataPath,
                    TEST_DB_PATH: dbPath,
                    TEST_GATE_PATH: gatePath,
                    TEST_READY_PATH: join(dataPath, '..', `ready-${index}`),
                    TEST_TASK_TITLE: title,
                },
                stdio: ['ignore', 'ignore', 'pipe'],
            });
            worker.stderr?.on('data', (chunk) => {
                stderr[index] += String(chunk);
            });
            return worker;
        });
        const exits = workers.map((worker) => new Promise<number | null>((resolve, reject) => {
            worker.once('error', reject);
            worker.once('close', resolve);
        }));
        try {
            const readyDeadline = Date.now() + 10_000;
            while (!workers.every((_, index) => existsSync(join(dataPath, '..', `ready-${index}`)))) {
                if (Date.now() > readyDeadline) {
                    throw new Error(`Timed out waiting for automation workers: ${stderr.join('\n')}`);
                }
                await waitFor(5);
            }
            writeFileSync(gatePath, 'start');

            expect(await Promise.all(exits)).toEqual([0, 0]);
            const db = new Database(dbPath, { readonly: true });
            try {
                expect(db.prepare('SELECT title FROM tasks ORDER BY title').all()).toEqual([
                    { title: 'First concurrent task' },
                    { title: 'Second concurrent task' },
                ]);
            } finally {
                db.close();
            }
            expect((JSON.parse(readFileSync(dataPath, 'utf8')) as AppData).tasks.map((task) => task.title).sort())
                .toEqual(['First concurrent task', 'Second concurrent task']);
        } finally {
            workers.forEach((worker) => worker.kill());
        }
    }, 30_000);

    test('retries a service operation after an external commit lands between read and save', async () => {
        const { dataPath, dbPath } = makeProfile();
        const afterReadPath = join(dataPath, '..', 'after-read');
        const continuePath = join(dataPath, '..', 'continue');
        const workerCode = `
            import { existsSync, writeFileSync } from 'fs';
            import { createMindwtrAutomationService } from './mindwtr-automation-core.ts';
            const service = await createMindwtrAutomationService({
                dataPath: process.env.TEST_DATA_PATH,
                dbPath: process.env.TEST_DB_PATH,
            });
            const props = {
                get status() {
                    writeFileSync(process.env.TEST_AFTER_READ_PATH, 'ready');
                    while (!existsSync(process.env.TEST_CONTINUE_PATH)) Bun.sleepSync(1);
                    return 'inbox';
                },
            };
            await service.createTask({ title: 'Retried service task', props });
        `;
        let stderr = '';
        const worker = spawn(process.execPath, ['-e', workerCode], {
            cwd: import.meta.dir,
            env: {
                ...process.env,
                TEST_DATA_PATH: dataPath,
                TEST_DB_PATH: dbPath,
                TEST_AFTER_READ_PATH: afterReadPath,
                TEST_CONTINUE_PATH: continuePath,
            },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        worker.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
        });
        const exit = new Promise<number | null>((resolve, reject) => {
            worker.once('error', reject);
            worker.once('close', resolve);
        });
        try {
            const readDeadline = Date.now() + 10_000;
            while (!existsSync(afterReadPath)) {
                if (Date.now() > readDeadline) throw new Error(`Timed out waiting for service read: ${stderr}`);
                await waitFor(5);
            }
            const external = createMindwtrAutomationStorage({ dataPath, dbPath });
            const current = await external.getData();
            await external.saveData({
                ...current,
                tasks: [{
                    id: 'external-writer-task',
                    title: 'External writer task',
                    status: 'inbox',
                    tags: [],
                    contexts: [],
                    rev: 1,
                    revBy: 'external',
                    createdAt: '2026-09-22T12:00:00.000Z',
                    updatedAt: '2026-09-22T12:00:00.000Z',
                } as Task],
            });
            writeFileSync(continuePath, 'continue');

            expect(await exit).toBe(0);
            const db = new Database(dbPath, { readonly: true });
            try {
                expect(db.prepare('SELECT title FROM tasks ORDER BY title').all()).toEqual([
                    { title: 'External writer task' },
                    { title: 'Retried service task' },
                ]);
            } finally {
                db.close();
            }
            expect((JSON.parse(readFileSync(dataPath, 'utf8')) as AppData).tasks.map((task) => task.title).sort())
                .toEqual(['External writer task', 'Retried service task']);
            expect(stderr).toContain('v1.3.2/automation-concurrent-write-retry');
        } finally {
            worker.kill();
        }
    }, 30_000);

    test('keeps concurrent same-process services bound to their own profiles', async () => {
        const first = makeProfile();
        const second = makeProfile();
        const firstService = await createMindwtrAutomationService(first);
        const secondService = await createMindwtrAutomationService(second);

        await Promise.all([
            firstService.createTask({ title: 'First profile task' }),
            secondService.createTask({ title: 'Second profile task' }),
        ]);

        expect(readRow(first.dbPath, 'SELECT title FROM tasks')).toEqual({ title: 'First profile task' });
        expect(readRow(second.dbPath, 'SELECT title FROM tasks')).toEqual({ title: 'Second profile task' });
        expect((JSON.parse(readFileSync(first.dataPath, 'utf8')) as AppData).tasks.map((task) => task.title))
            .toEqual(['First profile task']);
        expect((JSON.parse(readFileSync(second.dataPath, 'utf8')) as AppData).tasks.map((task) => task.title))
            .toEqual(['Second profile task']);
    });

    test('settles a failed operation before another profile can use the singleton store', async () => {
        const first = makeProfile();
        const second = makeProfile();
        const firstService = await createMindwtrAutomationService(first);
        const secondService = await createMindwtrAutomationService(second);
        await firstService.createTask({ title: 'First profile private task' });
        await secondService.createTask({ title: 'Second profile private task' });
        const stderrLines: string[] = [];
        const stderrTarget = process.stderr as unknown as { write: (chunk: string) => boolean };
        const stderrSpy = spyOn(stderrTarget, 'write').mockImplementation((chunk) => {
            stderrLines.push(chunk);
            return true;
        });

        let secondTasks: Task[];
        try {
            await expect(firstService.createTask({
                input: 'Rejected capture +FirstProfileProject',
                props: { sectionId: 'missing-section' },
            })).rejects.toThrow('Section not found');
            secondTasks = await secondService.listTasks({ includeAll: true });
        } finally {
            stderrSpy.mockRestore();
        }

        expect(secondTasks!.map((task) => task.title)).toEqual(['Second profile private task']);
        expect(readRows(second.dbPath, 'SELECT title FROM tasks ORDER BY title')).toEqual([
            { title: 'Second profile private task' },
        ]);
        expect(readRows(second.dbPath, 'SELECT title FROM projects ORDER BY title')).toEqual([]);
        const secondMirror = JSON.parse(readFileSync(second.dataPath, 'utf8')) as AppData;
        expect(secondMirror.tasks.map((task) => task.title)).toEqual(['Second profile private task']);
        expect(secondMirror.projects).toEqual([]);
        expect(readRows(first.dbPath, 'SELECT title FROM projects ORDER BY title')).toEqual([
            { title: 'FirstProfileProject' },
        ]);
        expect((JSON.parse(readFileSync(first.dataPath, 'utf8')) as AppData).projects.map((item) => item.title))
            .toEqual(['FirstProfileProject']);
        expect(stderrLines.join('')).toContain('v1.3.2/automation-failed-operation-settled');
    });


    test('preserves the operation error when failed settlement is terminal', async () => {
        const firstRoot = mkdtempSync(join(tmpdir(), 'mindwtr-automation-storage-'));
        tempDirs.push(firstRoot);
        const firstDataDir = join(firstRoot, 'json');
        const first = {
            dataPath: join(firstDataDir, 'data.json'),
            dbPath: join(firstRoot, 'sqlite', 'mindwtr.db'),
        };
        const second = makeProfile();
        const firstService = await createMindwtrAutomationService(first);
        const secondService = await createMindwtrAutomationService(second);
        await firstService.createTask({ title: 'First profile private task' });
        await secondService.createTask({ title: 'Second profile private task' });
        const stderrLines: string[] = [];
        const stderrTarget = process.stderr as unknown as { write: (chunk: string) => boolean };
        const stderrSpy = spyOn(stderrTarget, 'write').mockImplementation((chunk) => {
            stderrLines.push(chunk);
            return true;
        });

        chmodSync(firstDataDir, 0o555);
        let secondTasks: Task[];
        try {
            await expect(firstService.createTask({
                input: 'Rejected capture +FirstProfileProject',
                props: { sectionId: 'missing-section' },
            })).rejects.toThrow('Section not found');
            secondTasks = await secondService.listTasks({ includeAll: true });
        } finally {
            chmodSync(firstDataDir, 0o755);
            stderrSpy.mockRestore();
        }

        expect(stderrLines.join('')).not.toContain('v1.3.2/automation-failed-operation-settled');
        expect(secondTasks!.map((task) => task.title)).toEqual(['Second profile private task']);
        expect(readRows(second.dbPath, 'SELECT title FROM tasks ORDER BY title')).toEqual([
            { title: 'Second profile private task' },
        ]);
        const secondMirror = JSON.parse(readFileSync(second.dataPath, 'utf8')) as AppData;
        expect(secondMirror.tasks.map((task) => task.title)).toEqual(['Second profile private task']);
        expect(secondMirror.projects).toEqual([]);
    }, 15_000);
});
