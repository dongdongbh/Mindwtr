import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import type { AppData } from './types';

const require = createRequire(import.meta.url);
type BunStatement = {
    run: (params?: unknown[] | unknown) => unknown;
    all: (params?: unknown[] | unknown) => unknown[];
    get: (params?: unknown[] | unknown) => unknown;
};

type NodeStatement = {
    run: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
};

type Database = {
    exec: (sql: string) => void;
    close: () => void;
    query?: (sql: string) => BunStatement;
    prepare?: (sql: string) => NodeStatement;
};

type DatabaseCtor = new (filename: string) => Database;

const getStatement = (db: Database, sql: string): BunStatement | NodeStatement => {
    if (typeof db.prepare === 'function') return db.prepare(sql);
    if (typeof db.query === 'function') return db.query(sql);
    throw new Error('Unsupported sqlite runtime: missing prepare/query');
};

const runSql = (db: Database, sql: string, params: unknown[] = []) => {
    const statement = getStatement(db, sql);
    if ('prepare' in db && typeof db.prepare === 'function') {
        (statement as NodeStatement).run(...params);
        return;
    }
    (statement as BunStatement).run(params);
};

const allSql = <T = Record<string, unknown>>(db: Database, sql: string, params: unknown[] = []): T[] => {
    const statement = getStatement(db, sql);
    if ('prepare' in db && typeof db.prepare === 'function') {
        return (statement as NodeStatement).all(...params) as T[];
    }
    return (statement as BunStatement).all(params) as T[];
};

const getSql = <T = Record<string, unknown>>(db: Database, sql: string, params: unknown[] = []): T | undefined => {
    const statement = getStatement(db, sql);
    if ('prepare' in db && typeof db.prepare === 'function') {
        return (statement as NodeStatement).get(...params) as T | undefined;
    }
    return (statement as BunStatement).get(params) as T | undefined;
};

const loadDatabaseCtor = (): DatabaseCtor | null => {
    const bunGlobal = globalThis as typeof globalThis & { Bun?: unknown };
    if (typeof bunGlobal.Bun !== 'undefined') {
        try {
            const mod = require('bun:sqlite') as { Database: DatabaseCtor };
            return mod.Database;
        } catch {
            return null;
        }
    }
    try {
        const mod = require('node:sqlite') as { DatabaseSync: DatabaseCtor };
        return mod.DatabaseSync;
    } catch {
        return null;
    }
};

const RuntimeDatabase = loadDatabaseCtor();
const describeSqlite = RuntimeDatabase ? describe : describe.skip;

const createClient = (db: Database): SqliteClient => ({
    run: async (sql: string, params: unknown[] = []) => {
        runSql(db, sql, params);
    },
    all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        allSql<T>(db, sql, params),
    get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        getSql<T>(db, sql, params),
    exec: async (sql: string) => {
        db.exec(sql);
    },
});

describeSqlite('SqliteAdapter', () => {
    let db: Database;
    let adapter: SqliteAdapter;

    beforeEach(() => {
        if (!RuntimeDatabase) {
            throw new Error('No compatible sqlite runtime available for tests');
        }
        db = new RuntimeDatabase(':memory:');
        adapter = new SqliteAdapter(createClient(db));
    });

    afterEach(() => {
        db.close();
    });

    it('round-trips tasks, projects, areas, and settings', async () => {
        const now = new Date().toISOString();
        const data: AppData = {
            tasks: [
                {
                    id: 'task-1',
                    title: 'Write docs',
                    status: 'next',
                    rev: 5,
                    revBy: 'device-desktop',
                    tags: ['#docs', '#writing'],
                    contexts: ['@computer'],
                    recurrence: {
                        rule: 'weekly',
                        strategy: 'strict',
                        byDay: ['MO', 'WE'],
                        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
                    },
                    checklist: [{ id: 'c1', title: 'Outline', isCompleted: false }],
                    attachments: [
                        {
                            id: 'a1',
                            kind: 'file',
                            title: 'spec.pdf',
                            uri: '/tmp/spec.pdf',
                            createdAt: now,
                            updatedAt: now,
                            localStatus: 'available',
                        },
                    ],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [
                {
                    id: 'proj-1',
                    title: 'Mindwtr',
                    status: 'active',
                    color: '#1D4ED8',
                    order: 0,
                    tagIds: ['tag-1'],
                    isSequential: true,
                    isFocused: false,
                    dueDate: '2026-03-31',
                    rev: 7,
                    revBy: 'device-desktop',
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            sections: [
                {
                    id: 'section-1',
                    projectId: 'proj-1',
                    title: 'Milestones',
                    order: 0,
                    rev: 2,
                    revBy: 'device-desktop',
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            areas: [
                {
                    id: 'area-1',
                    name: 'Work',
                    order: 0,
                    rev: 3,
                    revBy: 'device-desktop',
                },
            ],
            settings: {
                gtd: { autoArchiveDays: 7 },
            },
        };

        await adapter.saveData(data);
        const loaded = await adapter.getData();

        expect(loaded.tasks).toHaveLength(1);
        expect(loaded.projects).toHaveLength(1);
        expect(loaded.sections).toHaveLength(1);
        expect(loaded.areas).toHaveLength(1);
        expect(loaded.settings.gtd?.autoArchiveDays).toBe(7);

        const task = loaded.tasks[0];
        expect(task.title).toBe('Write docs');
        expect(task.tags).toEqual(['#docs', '#writing']);
        expect(task.contexts).toEqual(['@computer']);
        expect(task.recurrence).toEqual({
            rule: 'weekly',
            strategy: 'strict',
            byDay: ['MO', 'WE'],
            rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
        });
        expect(task.checklist?.[0]?.title).toBe('Outline');
        expect(task.attachments?.[0]?.title).toBe('spec.pdf');
        expect(task.attachments?.[0]?.localStatus).toBe('available');
        expect(task.rev).toBe(5);
        expect(task.revBy).toBe('device-desktop');

        const project = loaded.projects[0];
        expect(project.title).toBe('Mindwtr');
        expect(project.tagIds).toEqual(['tag-1']);
        expect(project.isSequential).toBe(true);
        expect(project.isFocused).toBe(false);
        expect(project.dueDate).toBe('2026-03-31');
        expect(project.rev).toBe(7);
        expect(project.revBy).toBe('device-desktop');

        const section = loaded.sections[0];
        expect(section.title).toBe('Milestones');
        expect(section.rev).toBe(2);
        expect(section.revBy).toBe('device-desktop');

        const area = loaded.areas[0];
        expect(area.name).toBe('Work');
        expect(area.order).toBe(0);
        expect(area.rev).toBe(3);
        expect(area.revBy).toBe('device-desktop');
    });

    it('normalizes legacy string recurrence values when loading tasks', async () => {
        const now = new Date().toISOString();
        await adapter.saveData({
            tasks: [
                {
                    id: 'task-legacy-recurrence',
                    title: 'Legacy recurring task',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    recurrence: 'daily',
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        });

        const loaded = await adapter.getData();
        expect(loaded.tasks[0]?.recurrence).toEqual({ rule: 'daily' });
    });

    it('saves and deletes linked area, project, section, and task records without foreign key failures', async () => {
        const now = new Date().toISOString();
        const linkedData: AppData = {
            tasks: [
                {
                    id: 'task-linked-1',
                    title: 'Task in section',
                    status: 'next',
                    projectId: 'proj-linked-1',
                    sectionId: 'section-linked-1',
                    areaId: 'area-linked-1',
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [
                {
                    id: 'proj-linked-1',
                    title: 'Linked project',
                    status: 'active',
                    color: '#2563EB',
                    order: 0,
                    areaId: 'area-linked-1',
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            sections: [
                {
                    id: 'section-linked-1',
                    projectId: 'proj-linked-1',
                    title: 'Linked section',
                    order: 0,
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            areas: [
                {
                    id: 'area-linked-1',
                    name: 'Linked area',
                    order: 0,
                },
            ],
            settings: {},
        };

        await expect(adapter.saveData(linkedData)).resolves.toBeUndefined();

        const loaded = await adapter.getData();
        expect(loaded.tasks[0]?.projectId).toBe('proj-linked-1');
        expect(loaded.tasks[0]?.sectionId).toBe('section-linked-1');
        expect(loaded.tasks[0]?.areaId).toBe('area-linked-1');
        expect(loaded.projects[0]?.areaId).toBe('area-linked-1');
        expect(loaded.sections[0]?.projectId).toBe('proj-linked-1');

        await expect(adapter.saveData({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        })).resolves.toBeUndefined();

        const cleared = await adapter.getData();
        expect(cleared.tasks).toHaveLength(0);
        expect(cleared.projects).toHaveLength(0);
        expect(cleared.sections).toHaveLength(0);
        expect(cleared.areas).toHaveLength(0);
    });

    it('keeps task references consistent when a project row is hard-deleted', async () => {
        const now = new Date().toISOString();
        await adapter.saveData({
            tasks: [
                {
                    id: 'task-hard-delete-1',
                    title: 'Task in deleted project',
                    status: 'next',
                    projectId: 'proj-hard-delete-1',
                    sectionId: 'section-hard-delete-1',
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [
                {
                    id: 'proj-hard-delete-1',
                    title: 'Project to delete',
                    status: 'active',
                    color: '#2563EB',
                    order: 0,
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            sections: [
                {
                    id: 'section-hard-delete-1',
                    projectId: 'proj-hard-delete-1',
                    title: 'Section to delete',
                    order: 0,
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            areas: [],
            settings: {},
        });

        runSql(db, 'DELETE FROM projects WHERE id = ?', ['proj-hard-delete-1']);

        const taskRow = getSql<{ projectId: string | null; sectionId: string | null }>(
            db,
            'SELECT projectId, sectionId FROM tasks WHERE id = ?',
            ['task-hard-delete-1']
        );
        const remainingSections = allSql<{ id: string }>(db, 'SELECT id FROM sections');

        expect(taskRow).toEqual({
            projectId: null,
            sectionId: null,
        });
        expect(remainingSections).toHaveLength(0);
    });

    it('returns lightweight search results for FTS queries', async () => {
        const allMock = vi
            .fn()
            .mockResolvedValueOnce([
                {
                    id: 'task-search-1',
                    title: 'Searchable task',
                    status: 'archived',
                    startTime: '2025-01-01T08:00:00.000Z',
                    dueDate: '2025-01-02T00:00:00.000Z',
                    projectId: 'project-search-1',
                    areaId: 'area-1',
                    tags: JSON.stringify(['#search']),
                    contexts: JSON.stringify(['@desk']),
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'project-search-1',
                    title: 'Searchable project',
                    status: 'active',
                    areaId: 'area-1',
                },
            ]);
        const client: SqliteClient = {
            run: vi.fn().mockResolvedValue(undefined),
            get: vi.fn().mockResolvedValue(undefined),
            exec: vi.fn().mockResolvedValue(undefined),
            all: allMock,
        };
        const lightweightAdapter = new SqliteAdapter(client);
        (lightweightAdapter as unknown as { ensureSchema: () => Promise<void> }).ensureSchema = async () => {};

        const results = await lightweightAdapter.searchAll('Searchable');

        expect(allMock).toHaveBeenCalledTimes(2);
        expect(allMock.mock.calls[0]?.[0]).toContain('SELECT t.id AS id');
        expect(allMock.mock.calls[0]?.[0]).toContain('LIMIT ?');
        expect(allMock.mock.calls[0]?.[1]).toEqual(['Searchable*', 201]);
        expect(allMock.mock.calls[0]?.[0]).not.toContain('t.attachments');
        expect(allMock.mock.calls[0]?.[0]).not.toContain('t.description');
        expect(allMock.mock.calls[0]?.[0]).not.toContain("t.status != 'archived'");
        expect(allMock.mock.calls[1]?.[0]).toContain('SELECT p.id AS id');
        expect(allMock.mock.calls[1]?.[0]).toContain('LIMIT ?');
        expect(allMock.mock.calls[1]?.[1]).toEqual(['Searchable*', 201]);
        expect(allMock.mock.calls[1]?.[0]).not.toContain('p.supportNotes');

        expect(results.tasks).toHaveLength(1);
        expect(results.projects).toHaveLength(1);
        expect(results.tasks[0]).toMatchObject({
            id: 'task-search-1',
            title: 'Searchable task',
            status: 'archived',
            startTime: '2025-01-01T08:00:00.000Z',
            dueDate: '2025-01-02T00:00:00.000Z',
            projectId: 'project-search-1',
            areaId: 'area-1',
            tags: ['#search'],
            contexts: ['@desk'],
        });
        expect(results.projects[0]).toMatchObject({
            id: 'project-search-1',
            title: 'Searchable project',
            status: 'active',
        });
        expect(results.tasks[0]).not.toHaveProperty('description');
        expect(results.tasks[0]).not.toHaveProperty('attachments');
        expect(results.projects[0]).not.toHaveProperty('supportNotes');
    });

    it('derives stable fallback order when project/section orderNum is null', async () => {
        const now = new Date().toISOString();
        await adapter.saveData({
            tasks: [],
            projects: [
                {
                    id: 'proj-1',
                    title: 'One',
                    status: 'active',
                    color: '#111111',
                    order: 0,
                    tagIds: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'proj-2',
                    title: 'Two',
                    status: 'active',
                    color: '#222222',
                    order: 0,
                    tagIds: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            sections: [
                {
                    id: 'sec-1',
                    projectId: 'proj-1',
                    title: 'A',
                    order: 0,
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'sec-2',
                    projectId: 'proj-1',
                    title: 'B',
                    order: 0,
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            areas: [],
            settings: {},
        });

        runSql(db, 'UPDATE projects SET orderNum = NULL');
        runSql(db, 'UPDATE sections SET orderNum = NULL');

        const loaded = await adapter.getData();
        const projectOrders = loaded.projects.map((project) => project.order);
        const sectionOrders = loaded.sections.map((section) => section.order);

        expect(new Set(projectOrders).size).toBe(projectOrders.length);
        expect(projectOrders.every((order) => order > 0)).toBe(true);
        expect(new Set(sectionOrders).size).toBe(sectionOrders.length);
        expect(sectionOrders.every((order) => order > 0)).toBe(true);
    });

    it('preserves attachments with empty URIs when loading tasks', async () => {
        const now = new Date().toISOString();
        const data: AppData = {
            tasks: [
                {
                    id: 'task-empty-uri',
                    title: 'Task with invalid attachment',
                    status: 'inbox',
                    tags: [],
                    contexts: [],
                    attachments: [
                        {
                            id: 'att-empty',
                            kind: 'file',
                            title: 'empty',
                            uri: '   ',
                            createdAt: now,
                            updatedAt: now,
                        },
                    ],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };

        await adapter.saveData(data);
        const loaded = await adapter.getData();

        expect(loaded.tasks).toHaveLength(1);
        expect(loaded.tasks[0].attachments).toHaveLength(1);
        expect(loaded.tasks[0].attachments?.[0]?.id).toBe('att-empty');
        expect(loaded.tasks[0].attachments?.[0]?.uri).toBe('   ');
    });

    it('adds missing task columns on older schemas', async () => {
        db.exec(`
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL
            );
        `);
        db.exec(`
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                color TEXT NOT NULL
            );
        `);
        db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);`);
        db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);`);

        await adapter.ensureSchema();

        const columns = allSql<{ name: string }>(db, 'PRAGMA table_info(tasks)');
        const names = columns.map((col) => col.name);
        expect(names).toContain('orderNum');
        expect(names).toContain('areaId');
        expect(names).toContain('sectionId');
        expect(names).toContain('purgedAt');
        expect(names).toContain('rev');
        expect(names).toContain('revBy');
        const taskIndexes = allSql<{ name: string }>(db, 'PRAGMA index_list(tasks)');
        const taskIndexNames = new Set(taskIndexes.map((row) => row.name));
        expect(taskIndexNames.has('idx_tasks_dueDate')).toBe(true);
        expect(taskIndexNames.has('idx_tasks_status_deletedAt')).toBe(true);
        expect(taskIndexNames.has('idx_tasks_project_deletedAt')).toBe(true);

        const projectColumns = allSql<{ name: string }>(db, 'PRAGMA table_info(projects)');
        const projectColumnNames = projectColumns.map((col) => col.name);
        expect(projectColumnNames).toContain('dueDate');
        expect(projectColumnNames).toContain('rev');
        expect(projectColumnNames).toContain('revBy');
        const projectIndexes = allSql<{ name: string }>(db, 'PRAGMA index_list(projects)');
        expect(projectIndexes.map((row) => row.name)).toContain('idx_projects_dueDate');

        const sectionColumns = allSql<{ name: string }>(db, 'PRAGMA table_info(sections)');
        const sectionColumnNames = sectionColumns.map((col) => col.name);
        expect(sectionColumnNames).toContain('rev');
        expect(sectionColumnNames).toContain('revBy');
        const sectionIndexes = allSql<{ name: string }>(db, 'PRAGMA index_list(sections)');
        expect(sectionIndexes.map((row) => row.name)).toContain('idx_sections_project_deletedAt');

        const areaColumns = allSql<{ name: string }>(db, 'PRAGMA table_info(areas)');
        const areaColumnNames = areaColumns.map((col) => col.name);
        expect(areaColumnNames).toContain('rev');
        expect(areaColumnNames).toContain('revBy');
        expect(areaColumns.find((col) => col.name === 'createdAt')?.notnull).toBe(1);
        expect(areaColumns.find((col) => col.name === 'updatedAt')?.notnull).toBe(1);
    });

    it('rejects invalid task status values at the database layer', async () => {
        await adapter.ensureSchema();

        expect(() =>
            runSql(db, `
                INSERT INTO tasks (id, title, status, createdAt, updatedAt)
                VALUES ('bad-status', 'Bad status', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
            `)
        ).toThrow(/invalid_task_status/i);
    });

    it('rejects malformed json fields at the database layer', async () => {
        await adapter.ensureSchema();

        expect(() =>
            runSql(db, `
                INSERT INTO tasks (id, title, status, tags, createdAt, updatedAt)
                VALUES ('bad-json', 'Bad json', 'next', '{invalid', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
            `)
        ).toThrow(/invalid_tasks_tags_json/i);
    });

    it('creates composite indexes used by sync queries', async () => {
        await adapter.ensureSchema();

        const taskIndexes = allSql<{ name: string }>(db, 'PRAGMA index_list(tasks)');
        const projectIndexes = allSql<{ name: string }>(db, 'PRAGMA index_list(projects)');
        const sectionIndexes = allSql<{ name: string }>(db, 'PRAGMA index_list(sections)');
        const areaIndexes = allSql<{ name: string }>(db, 'PRAGMA index_list(areas)');
        const names = new Set([
            ...taskIndexes,
            ...projectIndexes,
            ...sectionIndexes,
            ...areaIndexes,
        ].map((index) => index.name));

        expect(names.has('idx_tasks_project_status_updatedAt')).toBe(true);
        expect(names.has('idx_tasks_updatedAt_rev')).toBe(true);
        expect(names.has('idx_projects_area_deletedAt')).toBe(true);
        expect(names.has('idx_projects_updatedAt_rev')).toBe(true);
        expect(names.has('idx_sections_updatedAt_rev')).toBe(true);
        expect(names.has('idx_areas_updatedAt_rev')).toBe(true);
        expect(names.has('idx_tasks_area_deletedAt')).toBe(true);
    });
});

describe('SqliteAdapter saveData pruning', () => {
    it('batches temp id table inserts and uses unique temp names', async () => {
        const run = vi.fn().mockResolvedValue(undefined);
        const client: SqliteClient = {
            run,
            get: vi.fn().mockResolvedValue(undefined),
            all: vi.fn().mockResolvedValue([]),
            exec: vi.fn().mockResolvedValue(undefined),
        };
        const lightweightAdapter = new SqliteAdapter(client);
        (lightweightAdapter as unknown as { ensureSchema: () => Promise<void> }).ensureSchema = async () => {};

        const now = '2026-03-04T12:00:00.000Z';
        const data: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: Array.from({ length: 1201 }, (_, index) => ({
                id: `area-${index}`,
                name: `Area ${index}`,
                order: index,
                createdAt: now,
                updatedAt: now,
            })),
            settings: {},
        };

        await lightweightAdapter.saveData(data);

        const tempCreateCalls = run.mock.calls
            .map(([sql]) => String(sql))
            .filter((sql) => sql.startsWith('CREATE TEMP TABLE temp_'));
        const tempNames = tempCreateCalls.map((sql) => sql.match(/CREATE TEMP TABLE (temp_[a-z0-9_]+)/)?.[1]);
        expect(new Set(tempNames).size).toBe(4);

        const tempAreaInsertCalls = run.mock.calls.filter(([sql]) =>
            String(sql).startsWith('INSERT OR IGNORE INTO temp_areas_ids_')
        );
        expect(tempAreaInsertCalls).toHaveLength(3);
        expect(tempAreaInsertCalls.map(([, params]) => (params as unknown[]).length)).toEqual([500, 500, 201]);
    });
});
