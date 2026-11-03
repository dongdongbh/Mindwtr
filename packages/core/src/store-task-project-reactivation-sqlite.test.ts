import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { applyProjectLifecycleTransition } from './store-helpers';
import { buildLoadContext, runLoadMigrations } from './store-load-migrations';
import { repairMergedSyncReferences } from './sync-normalization';
import type { AppData, Project, Section, Task } from './types';

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

type DatabaseConstructor = new (filename: string) => Database;

const require = createRequire(import.meta.url);

const loadDatabaseConstructor = (): DatabaseConstructor | null => {
    const bunGlobal = globalThis as typeof globalThis & { Bun?: unknown };
    if (typeof bunGlobal.Bun !== 'undefined') {
        try {
            return (require('bun:sqlite') as { Database: DatabaseConstructor }).Database;
        } catch {
            return null;
        }
    }
    try {
        return (require('node:sqlite') as { DatabaseSync: DatabaseConstructor }).DatabaseSync;
    } catch {
        return null;
    }
};

const RuntimeDatabase = loadDatabaseConstructor();
const describeSqlite = RuntimeDatabase ? describe : describe.skip;

it('has a sqlite runtime for the project-reactivation durability suite', () => {
    expect(RuntimeDatabase).not.toBeNull();
});

const getStatement = (database: Database, sql: string): BunStatement | NodeStatement => {
    if (typeof database.prepare === 'function') return database.prepare(sql);
    if (typeof database.query === 'function') return database.query(sql);
    throw new Error('Unsupported sqlite runtime: missing prepare/query');
};

const createClient = (database: Database): SqliteClient => ({
    run: async (sql, params = []) => {
        const statement = getStatement(database, sql);
        if (typeof database.prepare === 'function') {
            (statement as NodeStatement).run(...params);
            return;
        }
        (statement as BunStatement).run(params);
    },
    all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const statement = getStatement(database, sql);
        return typeof database.prepare === 'function'
            ? (statement as NodeStatement).all(...params) as T[]
            : (statement as BunStatement).all(params) as T[];
    },
    get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const statement = getStatement(database, sql);
        return typeof database.prepare === 'function'
            ? (statement as NodeStatement).get(...params) as T | undefined
            : (statement as BunStatement).get(params) as T | undefined;
    },
    exec: async (sql) => {
        database.exec(sql);
    },
});

const CREATED_AT = '2026-09-08T08:00:00.000Z';

const project = (): Project => ({
    id: 'project-1',
    title: 'SQLite lifecycle project',
    status: 'active',
    color: '#2563EB',
    order: 0,
    tagIds: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    rev: 1,
    revBy: 'device-a',
});

const section = (): Section => ({
    id: 'section-1',
    projectId: 'project-1',
    title: 'SQLite named section',
    order: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    rev: 1,
    revBy: 'device-a',
});

const task = (id: string, status: Task['status']): Task => ({
    id,
    title: `SQLite task ${id}`,
    status,
    projectId: 'project-1',
    sectionId: 'section-1',
    tags: [],
    contexts: [],
    pushCount: 0,
    ...(status === 'done' ? { completedAt: CREATED_AT } : {}),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    rev: 1,
    revBy: 'device-a',
});

const initialData = (): AppData => ({
    tasks: [task('selected', 'next'), task('archive-owned', 'waiting'), task('genuine-done', 'done')],
    projects: [project()],
    sections: [section()],
    areas: [],
    people: [],

    settings: { deviceId: 'device-a', gtd: { autoArchiveDays: 0 } },
});

describeSqlite('task-driven project reactivation SQLite durability', () => {
    beforeEach(() => {
        resetForTests();
        useTaskStore.setState({
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
            settings: {},
            isLoading: false,
            error: null,
            persistenceFailure: null,
            lastDataChangeAt: 0,
        });
    });

    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
    });

    it('survives a real database close and reopen after the archive save has flushed', async () => {
        if (!RuntimeDatabase) throw new Error('No compatible sqlite runtime available for tests');
        const databaseDir = mkdtempSync(join(tmpdir(), 'mindwtr-project-reactivation-'));
        const databasePath = join(databaseDir, 'mindwtr.db');
        let database: Database | null = new RuntimeDatabase(databasePath);
        try {
            let adapter = new SqliteAdapter(createClient(database));
            await adapter.saveData(initialData());
            setStorageAdapter(adapter);
            await useTaskStore.getState().fetchData({ silent: true });
            await flushPendingSave();
            expect(useTaskStore.getState()._allTasks.find((item) => item.id === 'genuine-done')).toMatchObject({
                status: 'done',
                completedAt: CREATED_AT,
            });

            await useTaskStore.getState().updateProject('project-1', { status: 'archived' });
            await flushPendingSave();
            const archived = await adapter.getData();
            const siblingAfterArchive = archived.tasks.find((item) => item.id === 'archive-owned')!;
            expect(archived.projects[0]?.status).toBe('archived');
            expect(archived.sections[0]?.deletedAt).toBeTruthy();

            await expect(useTaskStore.getState().moveTask('selected', 'next')).resolves.toEqual({ success: true });
            await flushPendingSave();

            database.close();
            database = new RuntimeDatabase(databasePath);
            adapter = new SqliteAdapter(createClient(database));
            const reloaded = await adapter.getData();

            expect(reloaded.projects[0]).toMatchObject({ status: 'active', cancelledAt: undefined });
            expect(reloaded.sections[0]).toMatchObject({
                id: 'section-1',
                deletedAt: undefined,
                projectArchivedAt: undefined,
            });
            expect(reloaded.tasks.find((item) => item.id === 'selected')).toMatchObject({
                status: 'next',
                projectId: 'project-1',
                sectionId: 'section-1',
            });
            expect(reloaded.tasks.find((item) => item.id === 'archive-owned')).toMatchObject({
                status: siblingAfterArchive.status,
                completedAt: siblingAfterArchive.completedAt,
                statusBeforeProjectArchive: undefined,
                projectArchivedAt: undefined,
            });
            expect(reloaded.tasks.find((item) => item.id === 'genuine-done')).toMatchObject({
                status: 'done',
                completedAt: CREATED_AT,
            });
        } finally {
            database?.close();
            rmSync(databaseDir, { recursive: true, force: true });
        }
    });

    it('keeps a cancelled project section, notes, and task placement after expiry and SQLite reload', async () => {
        if (!RuntimeDatabase) throw new Error('No compatible sqlite runtime available for tests');
        const archivedAt = '2026-01-01T12:00:00.000Z';
        const retentionAt = '2026-04-10T12:00:00.000Z';
        const reactivatedAt = '2026-04-11T12:00:00.000Z';
        const sourceProject: Project = {
            ...project(), createdAt: archivedAt, updatedAt: archivedAt,
        };
        const sourceSection: Section = {
            ...section(), description: 'Preparation notes', order: 4,
            createdAt: archivedAt, updatedAt: archivedAt,
        };
        const sourceTask: Task = {
            ...task('archive-owned', 'next'), createdAt: archivedAt, updatedAt: archivedAt,
        };
        const archived = applyProjectLifecycleTransition(
            sourceProject,
            { status: 'archived', cancelledAt: archivedAt },
            [sourceTask], [sourceSection], archivedAt, 'device-a',
        );
        const archivedData: AppData = {
            tasks: archived.tasks,
            projects: [{ ...sourceProject, ...archived.projectUpdates, updatedAt: archivedAt, rev: 2 }],
            sections: archived.sections,
            areas: [], people: [],
            settings: {
                deviceId: 'device-a',
                gtd: { autoArchiveDays: 0 },
                migrations: { version: 1, lastTombstoneCleanupAt: archivedAt },
            },
        };
        const databaseDir = mkdtempSync(join(tmpdir(), 'mindwtr-archive-retention-'));
        const databasePath = join(databaseDir, 'mindwtr.db');
        let database: Database | null = new RuntimeDatabase(databasePath);
        try {
            let adapter = new SqliteAdapter(createClient(database));
            await adapter.saveData(archivedData);
            const persistedArchive = await adapter.getData();
            const cleaned = runLoadMigrations(
                persistedArchive,
                buildLoadContext(persistedArchive.settings, false, retentionAt, Date.parse(retentionAt)),
            ).data;
            await adapter.saveData(cleaned);

            database.close();
            database = new RuntimeDatabase(databasePath);
            adapter = new SqliteAdapter(createClient(database));
            const reloaded = await adapter.getData();
            const sectionRow = await createClient(database).get<{
                id: string; title: string; description: string; orderNum: number; deletedAt: string;
            }>('SELECT id, title, description, orderNum, deletedAt FROM sections WHERE id = ?', ['section-1']);
            const taskRow = await createClient(database).get<{ sectionId: string }>(
                'SELECT sectionId FROM tasks WHERE id = ?', ['archive-owned'],
            );
            const secondLoad = runLoadMigrations(
                reloaded,
                buildLoadContext(reloaded.settings, false, retentionAt, Date.parse(retentionAt)),
            ).data;
            const canonical = repairMergedSyncReferences(secondLoad, retentionAt);
            const reopened = applyProjectLifecycleTransition(
                canonical.projects[0], { status: 'active' },
                canonical.tasks, canonical.sections, reactivatedAt, 'device-a',
            );
            await adapter.saveData({
                ...canonical,
                projects: [{ ...canonical.projects[0], ...reopened.projectUpdates, updatedAt: reactivatedAt, rev: 3 }],
                tasks: reopened.tasks,
                sections: reopened.sections,
            });
            const reactivatedReadback = await adapter.getData();

            expect(sectionRow).toEqual({
                id: 'section-1', title: 'SQLite named section',
                description: 'Preparation notes', orderNum: 4, deletedAt: archivedAt,
            });
            expect(taskRow).toEqual({ sectionId: 'section-1' });
            expect(secondLoad.sections).toEqual(reloaded.sections);
            expect(canonical.tasks).toEqual(secondLoad.tasks);
            expect(reactivatedReadback.sections[0]).toMatchObject({
                id: 'section-1', description: 'Preparation notes', order: 4,
                deletedAt: undefined,
            });
            expect(reactivatedReadback.tasks[0]).toMatchObject({
                status: 'next', projectId: 'project-1', sectionId: 'section-1',
            });
        } finally {
            database?.close();
            rmSync(databaseDir, { recursive: true, force: true });
        }
    });
});
