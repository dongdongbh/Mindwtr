import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { SQLITE_BASE_SCHEMA, SQLITE_FTS_SCHEMA } from './sqlite-schema';
import type { AppData, Task } from './types';
import { prepareRestoredBackupDataForSync } from './backup-transfer';
import { mergeAppDataWithStats, performSyncCycle } from './sync';
import { runSharedSyncCycle } from './sync-run';
import type {
    SyncBackendIO,
    SyncRunNotifier,
    SyncRunPlatformHooks,
    SyncRunPolicy,
    SyncRunStorage,
    SyncRunStoreBridge,
} from './sync-run-ports';
import { areSyncPayloadsEqual } from './sync-helpers';
import { computeRemoteSyncDocumentFingerprint, toRemoteSyncDocument } from './sync-document';
import { restoreSectionFromProjectArchive, restoreTaskFromProjectArchive } from './store-helpers';

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

// `describe.skip` above passes silently if no sqlite runtime is found - this bare
// top-level check fails loudly instead, so the persistence-adapter suite can't
// vanish unnoticed on a runtime that lacks both bun:sqlite and node:sqlite.
it('has a sqlite runtime available to run the adapter suite', () => {
    expect(RuntimeDatabase).not.toBeNull();
});

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
    let databaseDir: string;
    let databasePath: string;
    let additionalConnections: Database[];
    let adapter: SqliteAdapter;

    beforeEach(() => {
        if (!RuntimeDatabase) {
            throw new Error('No compatible sqlite runtime available for tests');
        }
        databaseDir = mkdtempSync(join(tmpdir(), 'mindwtr-sqlite-adapter-'));
        databasePath = join(databaseDir, 'mindwtr.db');
        additionalConnections = [];
        db = new RuntimeDatabase(databasePath);
        adapter = new SqliteAdapter(createClient(db));
    });

    afterEach(() => {
        additionalConnections.forEach((connection) => connection.close());
        db.close();
        rmSync(databaseDir, { recursive: true, force: true });
    });

    const createAdditionalConnection = (): Database => {
        if (!RuntimeDatabase) throw new Error('No compatible sqlite runtime available for tests');
        const connection = new RuntimeDatabase(databasePath);
        additionalConnections.push(connection);
        return connection;
    };

    it('round-trips tasks, projects, areas, people, and settings', async () => {
        const now = new Date().toISOString();
        const archivedAt = '2026-05-12T09:00:00.000Z';
        const data: AppData = {
            tasks: [
                {
                    id: 'task-1',
                    title: 'Write docs',
                    status: 'done',
                    completedAt: archivedAt,
                    statusBeforeProjectArchive: 'next',
                    completedAtBeforeProjectArchive: null,
                    isFocusedTodayBeforeProjectArchive: true,
                    projectArchivedAt: archivedAt,
                    rev: 5,
                    revBy: 'device-desktop',
                    boardOrder: 4,
                    focusOrder: 7,
                    repeatReminderMinutes: 30,
                    timeSpentMinutes: 95,
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
                            cloudKey: 'attachments/a1.pdf',
                            fileHash: 'abc123',
                            contentRev: 3,
                            contentMtimeMs: 1_700_000_000_000,
                            contentSize: 2048,
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
                    sequentialScope: 'section',
                    isFocused: false,
                    dueDate: '2026-03-31',
                    startDate: '2026-03-01',
                    rev: 7,
                    revBy: 'device-desktop',
                    createdAt: now,
                    updatedAt: now,
                    deletedAt: archivedAt,
                    purgedAt: archivedAt,
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
                    deletedAt: archivedAt,
                    deletedAtBeforeProjectArchive: null,
                    projectArchivedAt: archivedAt,
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
            people: [
                {
                    id: 'person-1',
                    name: 'Alex',
                    note: 'Design lead',
                    referenceLink: 'https://example.com/alex',
                    rev: 6,
                    revBy: 'device-desktop',
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'person-deleted',
                    name: 'Jordan',
                    rev: 7,
                    revBy: 'device-mobile',
                    createdAt: now,
                    updatedAt: archivedAt,
                    deletedAt: archivedAt,
                },
            ],
            settings: {
                gtd: { autoArchiveDays: 7 },
                savedFilters: [
                    {
                        id: 'filter-1',
                        name: 'Desk focus',
                        view: 'focus',
                        criteria: { contexts: ['@desk'], priority: ['high'] },
                        createdAt: now,
                        updatedAt: now,
                        deletedAt: '2026-05-03T00:00:00.000Z',
                    },
                ],
            },
        };

        await adapter.saveData(data);
        const loaded = await adapter.getData();

        expect(loaded.tasks).toHaveLength(1);
        expect(loaded.projects).toHaveLength(1);
        expect(loaded.sections).toHaveLength(1);
        expect(loaded.areas).toHaveLength(1);
        expect(loaded.people).toHaveLength(2);
        expect(loaded.people?.[0]).toMatchObject({
            id: 'person-1',
            name: 'Alex',
            note: 'Design lead',
            referenceLink: 'https://example.com/alex',
            rev: 6,
            revBy: 'device-desktop',
        });
        expect(loaded.people?.[1]).toMatchObject({
            id: 'person-deleted',
            name: 'Jordan',
            rev: 7,
            revBy: 'device-mobile',
            deletedAt: archivedAt,
        });
        expect(loaded.settings.gtd?.autoArchiveDays).toBe(7);
        expect(loaded.settings.savedFilters?.[0]).toMatchObject({
            id: 'filter-1',
            name: 'Desk focus',
            view: 'focus',
            criteria: { contexts: ['@desk'], priority: ['high'] },
            deletedAt: '2026-05-03T00:00:00.000Z',
        });
        expect(allSql(db, 'SELECT id, view, deletedAt FROM saved_filters')).toEqual([{
            id: 'filter-1',
            view: 'focus',
            deletedAt: '2026-05-03T00:00:00.000Z',
        }]);

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
        // #1057: content-tracking fields (SQLite -> AppData round trip).
        expect(task.attachments?.[0]?.cloudKey).toBe('attachments/a1.pdf');
        expect(task.attachments?.[0]?.fileHash).toBe('abc123');
        expect(task.attachments?.[0]?.contentRev).toBe(3);
        expect(task.attachments?.[0]?.contentMtimeMs).toBe(1_700_000_000_000);
        expect(task.attachments?.[0]?.contentSize).toBe(2048);
        expect(task.completedAt).toBe(archivedAt);
        expect(task.statusBeforeProjectArchive).toBe('next');
        expect(task.completedAtBeforeProjectArchive).toBeUndefined();
        expect(task.isFocusedTodayBeforeProjectArchive).toBe(true);
        expect(task.projectArchivedAt).toBe(archivedAt);
        expect(task.rev).toBe(5);
        expect(task.revBy).toBe('device-desktop');
        expect(task.boardOrder).toBe(4);
        expect(task.focusOrder).toBe(7);
        expect(task.repeatReminderMinutes).toBe(30);
        expect(task.timeSpentMinutes).toBe(95);

        const project = loaded.projects[0];
        expect(project.title).toBe('Mindwtr');
        expect(project.tagIds).toEqual(['tag-1']);
        expect(project.isSequential).toBe(true);
        expect(project.sequentialScope).toBe('section');
        expect(project.isFocused).toBe(false);
        expect(project.dueDate).toBe('2026-03-31');
        expect(project.startDate).toBe('2026-03-01');
        expect(project.deletedAt).toBe(archivedAt);
        expect(project.purgedAt).toBe(archivedAt);
        expect(project.rev).toBe(7);
        expect(project.revBy).toBe('device-desktop');

        const section = loaded.sections[0];
        expect(section.title).toBe('Milestones');
        expect(section.deletedAt).toBe(archivedAt);
        expect(section.deletedAtBeforeProjectArchive).toBeUndefined();
        expect(section.projectArchivedAt).toBe(archivedAt);
        expect(section.rev).toBe(2);
        expect(section.revBy).toBe('device-desktop');

        const area = loaded.areas[0];
        expect(area.name).toBe('Work');
        expect(area.order).toBe(0);
        expect(area.rev).toBe(3);
        expect(area.revBy).toBe('device-desktop');
    });

    it('settles legacy null archive metadata across SQLite and self-hosted sync (#1156)', async () => {
        const archivedAt = '2026-09-01T12:00:00.000Z';
        const previousCompletion = '2026-08-31T12:00:00.000Z';
        const restoredAt = '2026-09-05T13:00:00.000Z';
        const attachment = {
            id: 'attachment-1',
            kind: 'link' as const,
            title: 'Reference',
            uri: 'https://example.com/reference',
            createdAt: archivedAt,
            updatedAt: archivedAt,
        };
        const canonical: AppData = {
            tasks: [
                {
                    id: 'task-legacy-null',
                    title: 'Legacy null task',
                    status: 'done',
                    completedAt: archivedAt,
                    statusBeforeProjectArchive: 'next',
                    projectArchivedAt: archivedAt,
                    projectId: 'project-1',
                    attachments: [attachment],
                    tags: [],
                    contexts: [],
                    rev: 4,
                    revBy: 'device-a',
                    createdAt: archivedAt,
                    updatedAt: archivedAt,
                },
                {
                    id: 'task-explicit-state',
                    title: 'Explicit archive state task',
                    status: 'done',
                    completedAt: archivedAt,
                    statusBeforeProjectArchive: 'waiting',
                    completedAtBeforeProjectArchive: previousCompletion,
                    isFocusedTodayBeforeProjectArchive: false,
                    projectArchivedAt: archivedAt,
                    projectId: 'project-1',
                    tags: [],
                    contexts: [],
                    rev: 5,
                    revBy: 'device-a',
                    createdAt: archivedAt,
                    updatedAt: archivedAt,
                },
            ],
            projects: [{
                id: 'project-1',
                title: 'Archived project',
                status: 'archived',
                color: '#6B7280',
                order: 0,
                tagIds: [],
                rev: 3,
                revBy: 'device-a',
                createdAt: archivedAt,
                updatedAt: archivedAt,
            }],
            sections: [
                {
                    id: 'section-legacy-null',
                    projectId: 'project-1',
                    title: 'Legacy null section',
                    order: 0,
                    isCollapsed: false,
                    deletedAt: archivedAt,
                    projectArchivedAt: archivedAt,
                    rev: 2,
                    revBy: 'device-a',
                    createdAt: archivedAt,
                    updatedAt: archivedAt,
                },
                {
                    id: 'section-pre-deleted',
                    projectId: 'project-1',
                    title: 'Pre-deleted section',
                    order: 1,
                    isCollapsed: false,
                    deletedAt: previousCompletion,
                    deletedAtBeforeProjectArchive: previousCompletion,
                    projectArchivedAt: archivedAt,
                    rev: 2,
                    revBy: 'device-a',
                    createdAt: archivedAt,
                    updatedAt: archivedAt,
                },
            ],
            areas: [],
            people: [],
            settings: { syncPreferences: { gtd: true } },
        };
        await adapter.saveData(canonical);

        let inMemory = await adapter.getData();
        let remote = structuredClone(canonical);
        remote.tasks[0].completedAtBeforeProjectArchive = null;
        remote.tasks[0].isFocusedTodayBeforeProjectArchive = null;
        remote.sections[0].deletedAtBeforeProjectArchive = null;
        let localContentWrites = 0;
        let remoteContentWrites = 0;
        let fastState: Awaited<ReturnType<SyncRunStorage['readFastSyncState']>> = null;

        const io: SyncBackendIO = {
            readRemote: async () => structuredClone(remote),
            writeRemote: async (incoming) => {
                remoteContentWrites += 1;
                const merged = mergeAppDataWithStats(remote, incoming, { nowIso: restoredAt }).data;
                const incomingOnly = mergeAppDataWithStats({
                    tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
                }, incoming, { nowIso: restoredAt }).data;
                remote = structuredClone(merged);
                return {
                    fingerprint: computeRemoteSyncDocumentFingerprint(toRemoteSyncDocument(remote)),
                    serverMergedRemoteData: !areSyncPayloadsEqual(merged, incomingOnly),
                };
            },
            readRemoteFingerprint: async () =>
                computeRemoteSyncDocumentFingerprint(toRemoteSyncDocument(remote)),
        };
        const storage: SyncRunStorage = {
            readPersistedLocal: () => adapter.getData(),
            persistLocal: async (data) => {
                localContentWrites += 1;
                await adapter.saveData(data);
                inMemory = await adapter.getData();
                return inMemory;
            },
            persistSyncStatus: async () => {},
            readFastSyncState: async () => fastState,
            writeFastSyncState: async (state) => { fastState = state; },
            injectExternalCalendars: async (data) => data,
            persistExternalCalendars: async () => {},
        };
        const notifier: SyncRunNotifier = {
            setStep: () => {},
            logInfo: () => {},
            logWarning: () => {},
            logWarningExtra: () => {},
            sanitizeLogMessage: (message) => message,
            logSyncError: async () => null,
            logMergeSummary: () => {},
        };
        const store: SyncRunStoreBridge = {
            getLastDataChangeAt: () => 1,
            getInMemorySnapshot: () => structuredClone(inMemory),
            flushPendingSave: async () => {},
            setUiError: () => {},
            getSettings: () => inMemory.settings,
        };
        const hooks: SyncRunPlatformHooks = {
            setupCycle: async () => ({
                kind: 'ready',
                backend: 'cloud',
                cloudProvider: 'selfhosted',
                io,
                fastSyncScope: 'issue-1156',
            }),
            requestFollowUp: () => {},
            requestFollowUpAfter: () => {},
            formatErrorMessage: (error) => String(error),
            finalizeErrorStatus: async () => {},
            finalizeSuccess: async () => {},
        };
        const policy: SyncRunPolicy = {
            preSyncAttachmentsBeforeFastCheck: false,
            enableReadCheckSkip: false,
            postMergeAttachmentErrorPolicy: 'warn',
            attachmentPhasesEnabled: false,
        };
        const run = () => runSharedSyncCycle({
            options: { manual: true },
            storage,
            notifier,
            store,
            hooks,
            policy,
            now: () => new Date(restoredAt),
            performSyncCycle,
        });

        const first = await run();
        expect(first.success).toBe(true);
        expect(first.stats?.tasks.conflicts).toBe(0);
        expect(first.stats?.sections.conflicts).toBe(0);
        expect(remote.tasks[0].completedAtBeforeProjectArchive).toBeUndefined();
        expect(remote.tasks[0].isFocusedTodayBeforeProjectArchive).toBeUndefined();
        expect(remote.sections[0].deletedAtBeforeProjectArchive).toBeUndefined();

        const firstLocalWrites = localContentWrites;
        const firstRemoteWrites = remoteContentWrites;
        inMemory = await adapter.getData();
        const second = await run();

        expect(second.success).toBe(true);
        expect(second.stats?.tasks.conflicts).toBe(0);
        expect(second.stats?.sections.conflicts).toBe(0);
        expect(localContentWrites).toBe(firstLocalWrites);
        expect(remoteContentWrites).toBe(firstRemoteWrites);
        expect(inMemory.tasks.map((task) => task.id).sort()).toEqual([
            'task-explicit-state',
            'task-legacy-null',
        ]);
        expect(inMemory.sections.map((section) => section.id).sort()).toEqual([
            'section-legacy-null',
            'section-pre-deleted',
        ]);
        expect(inMemory.tasks[0].attachments?.map((item) => item.id)).toEqual(['attachment-1']);

        const taskById = new Map(inMemory.tasks.map((task) => [task.id, task]));
        const sectionById = new Map(inMemory.sections.map((section) => [section.id, section]));
        const restoredLegacyTask = restoreTaskFromProjectArchive(
            taskById.get('task-legacy-null')!, restoredAt, 'device-b',
        );
        const restoredExplicitTask = restoreTaskFromProjectArchive(
            taskById.get('task-explicit-state')!, restoredAt, 'device-b',
        );
        const restoredLegacySection = restoreSectionFromProjectArchive(
            sectionById.get('section-legacy-null')!, restoredAt, 'device-b',
        );
        const retainedPreDeletedSection = restoreSectionFromProjectArchive(
            sectionById.get('section-pre-deleted')!, restoredAt, 'device-b',
        );

        expect(restoredLegacyTask).toMatchObject({ status: 'next', isFocusedToday: false });
        expect(restoredLegacyTask.completedAt).toBeUndefined();
        expect(restoredExplicitTask).toMatchObject({
            status: 'waiting',
            completedAt: previousCompletion,
            isFocusedToday: false,
        });
        expect(restoredLegacySection.deletedAt).toBeUndefined();
        expect(retainedPreDeletedSection).toBe(sectionById.get('section-pre-deleted'));
    });

    it('round-trips project taskSortBy and stores default as absent', async () => {
        const now = '2026-07-19T12:00:00.000Z';
        const project = (id: string, taskSortBy: 'due' | 'default'): AppData['projects'][number] => ({
            id,
            title: `Project ${id}`,
            status: 'active',
            color: '#6B7280',
            order: 0,
            tagIds: [],
            taskSortBy,
            createdAt: now,
            updatedAt: now,
        });
        const data: AppData = {
            tasks: [],
            projects: [project('project-due', 'due'), project('project-default', 'default')],
            sections: [],
            areas: [],
            settings: {},
        };

        await adapter.saveData(data);
        const loaded = await adapter.getData();

        expect(loaded.projects.find((item) => item.id === 'project-due')?.taskSortBy).toBe('due');
        expect(loaded.projects.find((item) => item.id === 'project-default')?.taskSortBy).toBeUndefined();
        expect(allSql(db, 'SELECT id, taskSortBy FROM projects ORDER BY id')).toEqual([
            { id: 'project-default', taskSortBy: null },
            { id: 'project-due', taskSortBy: 'due' },
        ]);
    });

    it('declares repeat reminder minutes in the base task schema', () => {
        db.exec(SQLITE_BASE_SCHEMA);

        const taskColumns = allSql<{ name: string }>(db, 'PRAGMA table_info(tasks)')
            .map((column) => column.name);

        expect(taskColumns).toContain('repeatReminderMinutes');
        expect(taskColumns).toContain('timeSpentMinutes');
    });

    it('updates a single task row through saveTask while preserving unrelated data', async () => {
        const now = new Date().toISOString();
        const data: AppData = {
            tasks: [
                {
                    id: 'task-1',
                    title: 'Original task',
                    status: 'next',
                    tags: ['#focus'],
                    contexts: ['@desk'],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'task-2',
                    title: 'Unchanged task',
                    status: 'inbox',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [
                {
                    id: 'project-1',
                    title: 'Preserved project',
                    status: 'active',
                    color: '#2563EB',
                    order: 0,
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            sections: [],
            areas: [],
            settings: { gtd: { autoArchiveDays: 3 } },
        };

        await adapter.saveData(data);
        await adapter.saveTask({
            ...data.tasks[0],
            title: 'Updated task',
            status: 'done',
            completedAt: '2026-05-14T10:00:00.000Z',
            updatedAt: '2026-05-14T10:00:00.000Z',
        });

        const loaded = await adapter.getData();
        expect(loaded.tasks).toHaveLength(2);
        expect(loaded.tasks.find((task) => task.id === 'task-1')).toMatchObject({
            title: 'Updated task',
            status: 'done',
            completedAt: '2026-05-14T10:00:00.000Z',
        });
        expect(loaded.tasks.find((task) => task.id === 'task-2')).toMatchObject({
            title: 'Unchanged task',
            status: 'inbox',
        });
        expect(loaded.projects[0]?.title).toBe('Preserved project');
        expect(loaded.settings.gtd?.autoArchiveDays).toBe(3);

        const taskRows = allSql<{ id: string; title: string }>(db, 'SELECT id, title FROM tasks ORDER BY id');
        expect(taskRows).toEqual([
            { id: 'task-1', title: 'Updated task' },
            { id: 'task-2', title: 'Unchanged task' },
        ]);
    });

    it('does not let a stale full snapshot overwrite a newer task revision', async () => {
        const baseTask = {
            id: 'task-1',
            title: 'Original task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-06-10T08:00:00.000Z',
            updatedAt: '2026-06-10T08:00:00.000Z',
            rev: 4,
            revBy: 'device-old',
        };
        const baseData: AppData = {
            tasks: [baseTask],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };

        await adapter.saveData(baseData);
        await adapter.saveTask({
            ...baseTask,
            title: 'Newer incremental task',
            updatedAt: '2026-06-10T08:01:00.000Z',
            rev: 5,
            revBy: 'device-new',
        });
        await adapter.saveData({
            ...baseData,
            tasks: [{
                ...baseTask,
                title: 'Stale snapshot task',
                updatedAt: '2026-06-10T08:00:30.000Z',
            }],
        });

        const loaded = await adapter.getData();
        expect(loaded.tasks).toHaveLength(1);
        expect(loaded.tasks[0]).toMatchObject({
            id: 'task-1',
            title: 'Newer incremental task',
            rev: 5,
            revBy: 'device-new',
            updatedAt: '2026-06-10T08:01:00.000Z',
        });
    });

    it('persists an authoritative backup over higher-revision live rows and deletions', async () => {
        const currentAt = '2026-06-10T08:00:00.000Z';
        const restoredAt = '2026-06-10T09:00:00.000Z';
        const current: AppData = {
            tasks: [
                {
                    id: 'task-live',
                    title: 'Current live task',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: currentAt,
                    updatedAt: currentAt,
                    rev: 10,
                    revBy: 'current-device',
                },
                {
                    id: 'task-delete',
                    title: 'Current task to delete',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: currentAt,
                    updatedAt: currentAt,
                    rev: 12,
                    revBy: 'current-device',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        const backup: AppData = {
            ...current,
            tasks: [
                { ...current.tasks[0], title: 'Restored backup task', rev: 2, revBy: 'backup-device' },
                {
                    ...current.tasks[1],
                    title: 'Deleted in backup',
                    updatedAt: '2026-06-09T08:00:00.000Z',
                    deletedAt: '2026-06-09T08:00:00.000Z',
                    rev: 3,
                    revBy: 'backup-device',
                },
            ],
        };
        await adapter.saveData(current);

        const restored = prepareRestoredBackupDataForSync(backup, {
            previousData: await adapter.getData(),
            restoredAt,
        });
        await adapter.saveData(restored);

        const loaded = await adapter.getData();
        expect(loaded.tasks.find((task) => task.id === 'task-live')).toMatchObject({
            title: 'Restored backup task',
            rev: 11,
            updatedAt: restoredAt,
        });
        expect(loaded.tasks.find((task) => task.id === 'task-delete')).toMatchObject({
            title: 'Deleted in backup',
            deletedAt: restoredAt,
            rev: 13,
            updatedAt: restoredAt,
        });
    });

    it('does not let a stale snapshot delete a row added by another adapter', async () => {
        const now = '2026-07-21T08:00:00.000Z';
        const original: AppData = {
            tasks: [{
                id: 'task-original',
                title: 'Original',
                status: 'next',
                tags: [],
                contexts: [],
                createdAt: now,
                updatedAt: now,
                rev: 1,
                revBy: 'device-a',
            }],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        await adapter.saveData(original);

        const staleAdapter = new SqliteAdapter(createClient(db));
        const staleSnapshot = await staleAdapter.getData();
        const otherAdapter = new SqliteAdapter(createClient(db));
        await otherAdapter.saveTask({
            id: 'task-concurrent',
            title: 'Concurrent',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: now,
            updatedAt: now,
            rev: 1,
            revBy: 'device-b',
        });

        await staleAdapter.saveData(staleSnapshot);

        expect(allSql<{ id: string }>(db, 'SELECT id FROM tasks ORDER BY id')).toEqual([
            { id: 'task-concurrent' },
            { id: 'task-original' },
        ]);
    });

    it('rejects a guarded snapshot write after another connection changes settings', async () => {
        const now = '2026-07-21T08:00:00.000Z';
        await adapter.saveData({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: { theme: 'light' },
        });
        const automationAdapter = new SqliteAdapter(createClient(db), { rejectConcurrentWrites: true });
        const staleSnapshot = await automationAdapter.getData();
        const desktopAdapter = new SqliteAdapter(createClient(createAdditionalConnection()));
        const desktopSnapshot = await desktopAdapter.getData();
        await desktopAdapter.saveData({
            ...desktopSnapshot,
            settings: { ...desktopSnapshot.settings, theme: 'dark' },
        });

        await expect(automationAdapter.saveData({
            ...staleSnapshot,
            projects: [{
                id: 'project-mcp',
                title: 'Automation project',
                status: 'active',
                color: '#2563EB',
                order: 0,
                tagIds: [],
                createdAt: now,
                updatedAt: now,
                rev: 1,
                revBy: 'mcp',
            }],
        })).rejects.toThrow('SQLITE_BUSY: database changed after the automation snapshot was loaded (external commit)');

        const afterConflict = await desktopAdapter.getData();
        expect(afterConflict.settings.theme).toBe('dark');
        expect(afterConflict.projects).toEqual([]);

        const refreshed = await automationAdapter.getData();
        await automationAdapter.saveData({
            ...refreshed,
            projects: [{
                id: 'project-mcp',
                title: 'Automation project',
                status: 'active',
                color: '#2563EB',
                order: 0,
                tagIds: [],
                createdAt: now,
                updatedAt: now,
                rev: 1,
                revBy: 'mcp',
            }],
        });
        const afterRetry = await automationAdapter.getData();
        expect(afterRetry.settings.theme).toBe('dark');
        expect(afterRetry.projects.map((project) => project.id)).toEqual(['project-mcp']);
    });

    it('rejects a guarded equal-revision task write after another connection advances it', async () => {
        const task: Task = {
            id: 'task-race',
            title: 'Original',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-07-21T08:00:00.000Z',
            updatedAt: '2026-07-21T08:00:00.000Z',
            rev: 1,
            revBy: 'seed',
        };
        await adapter.saveData({
            tasks: [task],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        });
        const automationAdapter = new SqliteAdapter(createClient(db), { rejectConcurrentWrites: true });
        const staleSnapshot = await automationAdapter.getData();
        const desktopAdapter = new SqliteAdapter(createClient(createAdditionalConnection()));
        await desktopAdapter.saveTask({
            ...task,
            title: 'Desktop edit',
            updatedAt: '2026-07-21T08:01:00.000Z',
            rev: 2,
            revBy: 'desktop',
        });

        await expect(automationAdapter.saveTask({
            ...staleSnapshot.tasks[0],
            title: 'MCP edit',
            updatedAt: '2026-07-21T08:02:00.000Z',
            rev: 2,
            revBy: 'mcp',
        })).rejects.toThrow('SQLITE_BUSY: database changed after the automation snapshot was loaded (external commit)');

        expect((await desktopAdapter.getData()).tasks[0]).toMatchObject({
            title: 'Desktop edit',
            rev: 2,
            revBy: 'desktop',
        });
    });

    it('rejects a guarded full save after same-metadata content changes following saveTask', async () => {
        const timestamp = '2026-07-21T08:00:00.000Z';
        const original: Task = {
            id: 'task-same-metadata-race',
            title: 'Original',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: timestamp,
            updatedAt: timestamp,
            rev: 1,
            revBy: 'shared-device',
        };
        await adapter.saveData({
            tasks: [original],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        });

        const automationAdapter = new SqliteAdapter(createClient(db), { rejectConcurrentWrites: true });
        const automationSnapshot = await automationAdapter.getData();
        const automationTask: Task = {
            ...automationSnapshot.tasks[0],
            title: 'Automation edit',
            updatedAt: timestamp,
            rev: 2,
            revBy: 'shared-device',
        };
        await automationAdapter.saveTask(automationTask);

        const desktopAdapter = new SqliteAdapter(createClient(createAdditionalConnection()));
        await desktopAdapter.saveTask({
            ...automationTask,
            title: 'Desktop edit',
        });

        await expect(automationAdapter.saveData({
            ...automationSnapshot,
            tasks: [automationTask],
            projects: [{
                id: 'project-blocked-by-race',
                title: 'Must not be written',
                status: 'active',
                color: '#2563EB',
                order: 0,
                tagIds: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                rev: 1,
                revBy: 'shared-device',
            }],
        })).rejects.toThrow('SQLITE_BUSY: database changed after the automation snapshot was loaded (external commit)');

        const afterConflict = await desktopAdapter.getData();
        expect(afterConflict.tasks[0]).toMatchObject({
            title: 'Desktop edit',
            rev: 2,
            revBy: 'shared-device',
        });
        expect(afterConflict.projects).toEqual([]);
    });

    it('retries a guarded load when another connection commits during the snapshot read', async () => {
        const timestamp = '2026-07-21T08:00:00.000Z';
        await adapter.saveData({
            tasks: [{
                id: 'task-load-race',
                title: 'Before concurrent edit',
                status: 'next',
                tags: [],
                contexts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                rev: 1,
                revBy: 'seed',
            }],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        });
        const externalDb = createAdditionalConnection();
        const baseClient = createClient(db);
        let epochReads = 0;
        const guardedClient: SqliteClient = {
            ...baseClient,
            get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                if (sql === 'PRAGMA data_version') {
                    epochReads += 1;
                    if (epochReads === 2) {
                        runSql(
                            externalDb,
                            'UPDATE tasks SET title = ?, rev = ?, updatedAt = ? WHERE id = ?',
                            ['Concurrent edit', 2, timestamp, 'task-load-race'],
                        );
                    }
                }
                return baseClient.get<T>(sql, params);
            },
        };

        const guardedAdapter = new SqliteAdapter(guardedClient, { rejectConcurrentWrites: true });
        const loaded = await guardedAdapter.getData();

        expect(epochReads).toBe(4);
        expect(loaded.tasks[0]).toMatchObject({ title: 'Concurrent edit', rev: 2 });
    });

    it('uses an O(1) epoch check for a guarded one-row write in a 10k-task store', async () => {
        const timestamp = '2026-07-21T08:00:00.000Z';
        const tasks: Task[] = Array.from({ length: 10_000 }, (_, index) => ({
            id: `task-guard-scale-${index}`,
            title: `Task ${index}`,
            description: 'x'.repeat(200),
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: timestamp,
            updatedAt: timestamp,
            rev: 1,
            revBy: 'seed',
        }));
        await adapter.saveData({
            tasks,
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        });
        const observedSql: string[] = [];
        const baseClient = createClient(db);
        const recordingClient: SqliteClient = {
            ...baseClient,
            all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                observedSql.push(sql);
                return baseClient.all<T>(sql, params);
            },
            get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                observedSql.push(sql);
                return baseClient.get<T>(sql, params);
            },
        };
        const guardedAdapter = new SqliteAdapter(recordingClient, { rejectConcurrentWrites: true });
        const snapshot = await guardedAdapter.getData();
        observedSql.length = 0;

        await guardedAdapter.saveTask({
            ...snapshot.tasks[5_000],
            title: 'One changed task',
            rev: 2,
        });

        const fullEntityScans = observedSql.filter((sql) => (
            /^SELECT rowid as _rowid, \* FROM (tasks|projects|sections|areas|people|saved_filters)\s*$/.test(sql)
        ));
        expect(fullEntityScans).toEqual([]);
        expect(observedSql.filter((sql) => sql === 'PRAGMA data_version')).toHaveLength(1);
    });

    it('uses the observed row version when pruning after another adapter advances it', async () => {
        const now = '2026-07-21T08:00:00.000Z';
        const data: AppData = {
            tasks: [
                {
                    id: 'task-keep',
                    title: 'Keep',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                    rev: 1,
                    revBy: 'device-a',
                },
                {
                    id: 'task-remove',
                    title: 'Original',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                    rev: 1,
                    revBy: 'device-a',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        await adapter.saveData(data);

        const staleAdapter = new SqliteAdapter(createClient(db));
        const staleSnapshot = await staleAdapter.getData();
        const otherAdapter = new SqliteAdapter(createClient(db));
        await otherAdapter.saveTask({
            ...data.tasks[1],
            title: 'Advanced elsewhere',
            updatedAt: '2026-07-21T09:00:00.000Z',
            rev: 2,
            revBy: 'device-b',
        });

        await staleAdapter.saveData({
            ...staleSnapshot,
            tasks: staleSnapshot.tasks.filter((task) => task.id !== 'task-remove'),
        });
        expect(getSql<{ title: string; rev: number }>(db, 'SELECT title, rev FROM tasks WHERE id = ?', ['task-remove']))
            .toEqual({ title: 'Advanced elsewhere', rev: 2 });

        const refreshed = await staleAdapter.getData();
        await staleAdapter.saveData({
            ...refreshed,
            tasks: refreshed.tasks.filter((task) => task.id !== 'task-remove'),
        });
        expect(getSql(db, 'SELECT id FROM tasks WHERE id = ?', ['task-remove'])).toBeUndefined();
    });

    it('allows equal-revision task upserts for unchanged ordering semantics', async () => {
        const task = {
            id: 'task-1',
            title: 'Original task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-06-10T08:00:00.000Z',
            updatedAt: '2026-06-10T08:00:00.000Z',
            rev: 5,
            revBy: 'device-a',
        };

        await adapter.saveData({
            tasks: [task],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        });
        await adapter.saveTask({
            ...task,
            title: 'Equal revision task',
            updatedAt: '2026-06-10T08:02:00.000Z',
        });

        const loaded = await adapter.getData();
        expect(loaded.tasks[0]).toMatchObject({
            title: 'Equal revision task',
            rev: 5,
            updatedAt: '2026-06-10T08:02:00.000Z',
        });
    });

    it('guards container upserts with revision ordering', async () => {
        const now = '2026-06-10T08:00:00.000Z';
        const baseArea = {
            id: 'area-1',
            name: 'Current area',
            color: '#2563EB',
            icon: 'briefcase',
            order: 0,
            createdAt: now,
            updatedAt: now,
            rev: 10,
            revBy: 'device-new',
        };
        const baseProject = {
            id: 'project-1',
            title: 'Current project',
            status: 'active' as const,
            color: '#2563EB',
            order: 0,
            createdAt: now,
            updatedAt: now,
            rev: 10,
            revBy: 'device-new',
        };
        const baseSection = {
            id: 'section-1',
            projectId: 'project-1',
            title: 'Current section',
            description: 'current description',
            order: 0,
            createdAt: now,
            updatedAt: now,
            rev: 10,
            revBy: 'device-new',
        };
        const basePerson = {
            id: 'person-1',
            name: 'Current person',
            note: 'current note',
            referenceLink: 'https://example.com/current',
            createdAt: now,
            updatedAt: now,
            rev: 10,
            revBy: 'device-new',
        };
        const baseData: AppData = {
            tasks: [],
            projects: [baseProject],
            sections: [baseSection],
            areas: [baseArea],
            people: [basePerson],
            settings: {},
        };
        const loadContainers = async () => {
            const loaded = await adapter.getData();
            return {
                area: loaded.areas.find((area) => area.id === baseArea.id),
                project: loaded.projects.find((project) => project.id === baseProject.id),
                section: loaded.sections.find((section) => section.id === baseSection.id),
                person: loaded.people?.find((person) => person.id === basePerson.id),
            };
        };

        await adapter.saveData(baseData);
        await adapter.saveData({
            ...baseData,
            areas: [{ ...baseArea, name: 'Stale area', updatedAt: '2026-06-10T08:00:30.000Z', rev: 1, revBy: 'device-old' }],
            projects: [{ ...baseProject, title: 'Stale project', updatedAt: '2026-06-10T08:00:30.000Z', rev: 1, revBy: 'device-old' }],
            sections: [{ ...baseSection, title: 'Stale section', updatedAt: '2026-06-10T08:00:30.000Z', rev: 1, revBy: 'device-old' }],
            people: [{ ...basePerson, name: 'Stale person', updatedAt: '2026-06-10T08:00:30.000Z', rev: 1, revBy: 'device-old' }],
        });

        let loaded = await loadContainers();
        expect(loaded.area).toMatchObject({ name: 'Current area', rev: 10, revBy: 'device-new' });
        expect(loaded.project).toMatchObject({ title: 'Current project', rev: 10, revBy: 'device-new' });
        expect(loaded.section).toMatchObject({ title: 'Current section', rev: 10, revBy: 'device-new' });
        expect(loaded.person).toMatchObject({ name: 'Current person', rev: 10, revBy: 'device-new' });

        const equalUpdatedAt = '2026-06-10T08:02:00.000Z';
        const equalData: AppData = {
            ...baseData,
            areas: [{ ...baseArea, name: 'Equal area', updatedAt: equalUpdatedAt, revBy: 'device-equal' }],
            projects: [{ ...baseProject, title: 'Equal project', updatedAt: equalUpdatedAt, revBy: 'device-equal' }],
            sections: [{ ...baseSection, title: 'Equal section', updatedAt: equalUpdatedAt, revBy: 'device-equal' }],
            people: [{ ...basePerson, name: 'Equal person', updatedAt: equalUpdatedAt, revBy: 'device-equal' }],
        };
        await adapter.saveData(equalData);

        loaded = await loadContainers();
        expect(loaded.area).toMatchObject({ name: 'Equal area', rev: 10, revBy: 'device-equal', updatedAt: equalUpdatedAt });
        expect(loaded.project).toMatchObject({ title: 'Equal project', rev: 10, revBy: 'device-equal', updatedAt: equalUpdatedAt });
        expect(loaded.section).toMatchObject({ title: 'Equal section', rev: 10, revBy: 'device-equal', updatedAt: equalUpdatedAt });
        expect(loaded.person).toMatchObject({ name: 'Equal person', rev: 10, revBy: 'device-equal', updatedAt: equalUpdatedAt });

        await adapter.saveData({
            ...equalData,
            areas: [{ ...equalData.areas[0], name: 'Missing rev area', rev: undefined, revBy: undefined }],
            projects: [{ ...equalData.projects[0], title: 'Missing rev project', rev: undefined, revBy: undefined }],
            sections: [{ ...equalData.sections[0], title: 'Missing rev section', rev: undefined, revBy: undefined }],
            people: [{ ...equalData.people![0], name: 'Missing rev person', rev: undefined, revBy: undefined }],
        });

        loaded = await loadContainers();
        expect(loaded.area).toMatchObject({ name: 'Equal area', rev: 10, revBy: 'device-equal' });
        expect(loaded.project).toMatchObject({ title: 'Equal project', rev: 10, revBy: 'device-equal' });
        expect(loaded.section).toMatchObject({ title: 'Equal section', rev: 10, revBy: 'device-equal' });
        expect(loaded.person).toMatchObject({ name: 'Equal person', rev: 10, revBy: 'device-equal' });
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

        // Delete every linked row in one save (the area survives so the save
        // is not an all-empty snapshot, which the #852 backstop refuses).
        await expect(adapter.saveData({
            tasks: [],
            projects: [],
            sections: [],
            areas: linkedData.areas,
            settings: {},
        })).resolves.toBeUndefined();

        const cleared = await adapter.getData();
        expect(cleared.tasks).toHaveLength(0);
        expect(cleared.projects).toHaveLength(0);
        expect(cleared.sections).toHaveLength(0);
        expect(cleared.areas).toHaveLength(1);
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

    it('logs reference diagnostics when full snapshot persistence hits a foreign key failure', async () => {
        const now = '2026-06-18T23:21:00.000Z';
        const logs: LogPayload[] = [];
        setLogger((payload) => {
            logs.push(payload);
        });
        try {
            await expect(adapter.saveData({
                tasks: [],
                projects: [],
                sections: [
                    {
                        id: 'orphan-section',
                        projectId: 'missing-project',
                        title: 'Orphan section',
                        order: 0,
                        createdAt: now,
                        updatedAt: now,
                    },
                ],
                areas: [],
                settings: {},
            })).rejects.toThrow(/FOREIGN KEY/i);
        } finally {
            setLogger(consoleLogger);
        }

        expect(logs).toEqual(expect.arrayContaining([
            expect.objectContaining({
                level: 'warn',
                message: 'SQLite saveData failed',
                scope: 'sqlite',
                category: 'storage',
                context: expect.objectContaining({
                    step: 'sections',
                    referenceIssues: 1,
                    referenceIssueSamples: [
                        {
                            kind: 'section.projectId',
                            id: 'orphan-section',
                            missingId: 'missing-project',
                        },
                    ],
                }),
            }),
        ]));
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
        expect(allMock.mock.calls[0]?.[0]).toContain('ORDER BY bm25(tasks_fts)');
        expect(allMock.mock.calls[0]?.[0]).toContain('LIMIT ?');
        expect(allMock.mock.calls[0]?.[1]).toEqual(['"Searchable"*', 201]);
        expect(allMock.mock.calls[0]?.[0]).not.toContain('t.attachments');
        expect(allMock.mock.calls[0]?.[0]).not.toContain('t.description');
        expect(allMock.mock.calls[0]?.[0]).not.toContain("t.status != 'archived'");
        expect(allMock.mock.calls[1]?.[0]).toContain('SELECT p.id AS id');
        expect(allMock.mock.calls[1]?.[0]).toContain('ORDER BY bm25(projects_fts)');
        expect(allMock.mock.calls[1]?.[0]).toContain('LIMIT ?');
        expect(allMock.mock.calls[1]?.[1]).toEqual(['"Searchable"*', 201]);
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

    it('indexes task locations in full text search', async () => {
        const now = new Date().toISOString();
        await adapter.saveData({
            tasks: [
                {
                    id: 'task-location',
                    title: 'Unrelated task',
                    status: 'next',
                    contexts: [],
                    tags: [],
                    location: 'Main Office',
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [],
            areas: [],
            sections: [],
            settings: {},
        });

        const results = await adapter.searchAll('office');

        expect(results.tasks.map((task) => task.id)).toEqual(['task-location']);
        expect(results.tasks[0]?.location).toBe('Main Office');
    });

    it('indexes assigned people in full text search', async () => {
        const now = new Date().toISOString();
        await adapter.saveData({
            tasks: [
                {
                    id: 'task-assigned',
                    title: 'Unrelated task',
                    status: 'waiting',
                    contexts: [],
                    tags: [],
                    assignedTo: 'John Smith',
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [],
            areas: [],
            sections: [],
            settings: {},
        });

        const results = await adapter.searchAll('john');

        expect(results.tasks.map((task) => task.id)).toEqual(['task-assigned']);
    });

    it('indexes checklist item titles in full text search', async () => {
        const now = new Date().toISOString();
        await adapter.saveData({
            tasks: [
                {
                    id: 'task-checklist',
                    title: 'Travel prep',
                    status: 'next',
                    contexts: [],
                    tags: [],
                    checklist: [
                        { id: 'item-1', title: 'Book shuttle', isCompleted: false },
                        { id: 'item-2', title: 'Print ticket', isCompleted: false },
                    ],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [],
            areas: [],
            sections: [],
            settings: {},
        });

        const results = await adapter.searchAll('shuttle');

        expect(results.tasks.map((task) => task.id)).toEqual(['task-checklist']);
    });

    it('finds tasks by context and tag search terms', async () => {
        const now = new Date().toISOString();
        await adapter.saveData({
            tasks: [
                {
                    id: 'task-context',
                    title: 'Unrelated task',
                    status: 'next',
                    contexts: ['@home'],
                    tags: ['#errand'],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [],
            areas: [],
            sections: [],
            settings: {},
        });

        const byContext = await adapter.searchAll('@home');
        expect(byContext.tasks.map((task) => task.id)).toEqual(['task-context']);

        const byTag = await adapter.searchAll('#errand');
        expect(byTag.tasks.map((task) => task.id)).toEqual(['task-context']);
    });

    it('does not rebuild the FTS index for a search syntax-class failure', async () => {
        const allMock = vi.fn().mockRejectedValue(new Error('fts5: syntax error near "@"'));
        const client: SqliteClient = {
            run: vi.fn().mockResolvedValue(undefined),
            get: vi.fn().mockResolvedValue(undefined),
            exec: vi.fn().mockResolvedValue(undefined),
            all: allMock,
        };
        const lightweightAdapter = new SqliteAdapter(client);
        (lightweightAdapter as unknown as { ensureSchema: () => Promise<void> }).ensureSchema = async () => {};

        const results = await lightweightAdapter.searchAll('anything');

        expect(results).toEqual({ tasks: [], projects: [] });
        // A syntax-class failure must not retry via a rebuild: one attempt, two
        // parallel queries (tasks + projects), no second runSearch() pass.
        expect(allMock).toHaveBeenCalledTimes(2);

        // A second syntax-class failure behaves the same way — still no retry.
        const secondResults = await lightweightAdapter.searchAll('anything else');
        expect(secondResults).toEqual({ tasks: [], projects: [] });
        expect(allMock).toHaveBeenCalledTimes(4);
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
        expect(names).toContain('boardOrder');
        expect(names).toContain('focusOrder');
        expect(names).toContain('areaId');
        expect(names).toContain('sectionId');
        expect(names).toContain('purgedAt');
        expect(names).toContain('relativeStartOffset');
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
        expect(projectColumnNames).toContain('startDate');
        expect(projectColumnNames).toContain('rev');
        expect(projectColumnNames).toContain('revBy');
        const projectIndexes = allSql<{ name: string }>(db, 'PRAGMA index_list(projects)');
        expect(projectIndexes.map((row) => row.name)).toContain('idx_projects_dueDate');

        const peopleColumns = allSql<{ name: string }>(db, 'PRAGMA table_info(people)');
        const peopleColumnNames = peopleColumns.map((col) => col.name);
        expect(peopleColumnNames).toEqual(expect.arrayContaining([
            'id',
            'name',
            'note',
            'referenceLink',
            'rev',
            'revBy',
            'createdAt',
            'updatedAt',
            'deletedAt',
        ]));
        const peopleIndexes = allSql<{ name: string }>(db, 'PRAGMA index_list(people)');
        expect(peopleIndexes.map((row) => row.name)).toContain('idx_people_updatedAt_rev');

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

        const savedFilterColumns = allSql<{ name: string }>(db, 'PRAGMA table_info(saved_filters)');
        const savedFilterColumnNames = savedFilterColumns.map((col) => col.name);
        expect(savedFilterColumnNames).toEqual([
            'id',
            'name',
            'icon',
            'view',
            'criteria',
            'sortBy',
            'sortOrder',
            'groupBy',
            'createdAt',
            'updatedAt',
            'deletedAt',
        ]);
        const savedFilterIndexes = allSql<{ name: string }>(db, 'PRAGMA index_list(saved_filters)');
        expect(savedFilterIndexes.map((row) => row.name)).toContain('idx_saved_filters_view');
    });

    it('migrates FTS triggers atomically once and rebuilds aligned indexes', async () => {
        db.exec(SQLITE_BASE_SCHEMA);
        db.exec(SQLITE_FTS_SCHEMA);
        db.exec(`
            INSERT INTO tasks (id, title, status, tags, contexts, createdAt, updatedAt)
            VALUES ('task-fts-migration', 'Before migration', 'next', '[]', '[]', '2026-07-23', '2026-07-23')
        `);
        db.exec('DROP TRIGGER tasks_au');
        db.exec(`UPDATE tasks SET title = 'After trigger gap' WHERE id = 'task-fts-migration'`);
        db.exec('INSERT OR IGNORE INTO schema_migrations (version) VALUES (2)');
        expect(allSql(db, `SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'Before'`)).toHaveLength(1);
        expect(allSql(db, `SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'After'`)).toHaveLength(0);

        const statements: string[] = [];
        const baseClient = createClient(db);
        const trackingClient: SqliteClient = {
            ...baseClient,
            run: async (sql, params = []) => {
                statements.push(sql.trim());
                await baseClient.run(sql, params);
            },
        };

        await new SqliteAdapter(trackingClient).ensureSchema();

        const beginIndex = statements.indexOf('BEGIN IMMEDIATE');
        const dropIndex = statements.indexOf('DROP TRIGGER IF EXISTS tasks_ai');
        const commitIndex = statements.indexOf('COMMIT');
        expect(beginIndex).toBeGreaterThanOrEqual(0);
        expect(dropIndex).toBeGreaterThan(beginIndex);
        expect(commitIndex).toBeGreaterThan(dropIndex);
        expect(getSql<{ version: number }>(db, 'SELECT version FROM schema_migrations WHERE version = 3'))
            .toEqual({ version: 3 });
        expect(statements.some((sql) => sql.includes("INSERT INTO tasks_fts(tasks_fts) VALUES('delete-all')")))
            .toBe(true);
        expect(allSql(db, `SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'Before'`)).toHaveLength(0);
        expect(allSql(db, `SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'After'`)).toHaveLength(1);

        statements.length = 0;
        await new SqliteAdapter(trackingClient).ensureSchema();

        expect(statements).not.toContain('BEGIN IMMEDIATE');
        expect(statements).not.toContain('DROP TRIGGER IF EXISTS tasks_ai');
        expect(statements.some((sql) => sql.includes("INSERT INTO tasks_fts(tasks_fts) VALUES('delete-all')")))
            .toBe(false);
    });

    it('restores task FTS triggers when a marked database has an old FTS schema', async () => {
        db.exec(SQLITE_BASE_SCHEMA);
        db.exec(`
            CREATE VIRTUAL TABLE tasks_fts USING fts5(
              id UNINDEXED,
              title,
              description,
              tags,
              contexts,
              location,
              content=''
            )
        `);
        db.exec('INSERT OR IGNORE INTO schema_migrations (version) VALUES (3)');

        await adapter.ensureSchema();

        const triggerNames = allSql<{ name: string }>(
            db,
            `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('tasks_ai', 'tasks_ad', 'tasks_au')`
        ).map((row) => row.name);
        expect(triggerNames).toEqual(expect.arrayContaining(['tasks_ai', 'tasks_ad', 'tasks_au']));

        runSql(db, `
            INSERT INTO tasks (id, title, status, tags, contexts, checklist, createdAt, updatedAt)
            VALUES ('task-after-fts-repair', 'Search survives repair', 'next', '[]', '[]', '[]', '2026-07-23', '2026-07-23')
        `);
        expect(allSql(db, `SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'survives'`))
            .toHaveLength(1);
    });

    it('restores a dropped FTS trigger even when schema_migrations already records the current version', async () => {
        // Simulates the gap this item closes: ensureFtsSchema's DROPs run outside
        // ensureFtsTriggers' BEGIN IMMEDIATE, so a crash or SQLITE_BUSY between them
        // can leave a trigger missing while the migration marker still says applied.
        db.exec(SQLITE_BASE_SCHEMA);
        db.exec(SQLITE_FTS_SCHEMA);
        db.exec('DROP TRIGGER tasks_au');
        db.exec('INSERT OR IGNORE INTO schema_migrations (version) VALUES (3)');

        await adapter.ensureSchema();

        const triggerNames = allSql<{ name: string }>(
            db,
            `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN
                ('tasks_ai', 'tasks_ad', 'tasks_au', 'projects_ai', 'projects_ad', 'projects_au')`
        ).map((row) => row.name);
        expect(triggerNames).toEqual(expect.arrayContaining([
            'tasks_ai', 'tasks_ad', 'tasks_au', 'projects_ai', 'projects_ad', 'projects_au',
        ]));

        runSql(db, `
            INSERT INTO tasks (id, title, status, tags, contexts, checklist, createdAt, updatedAt)
            VALUES ('task-before-trigger-repair', 'Present before update', 'next', '[]', '[]', '[]', '2026-07-24', '2026-07-24')
        `);
        runSql(db, `UPDATE tasks SET title = 'Present after update' WHERE id = 'task-before-trigger-repair'`);
        expect(allSql(db, `SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'after'`)).toHaveLength(1);
    });

    it('forces a trigger re-migration via ensureFtsTriggers itself when sqlite_master disagrees with the marker', async () => {
        // Calls the private method directly (not ensureSchema()): ensureSchemaInternal
        // always execs SQLITE_FTS_SCHEMA's blanket CREATE TRIGGER IF NOT EXISTS first,
        // which would coincidentally restore a dropped trigger and mask a broken
        // sqlite_master check. Isolating ensureFtsTriggers proves its own guard works.
        db.exec(SQLITE_BASE_SCHEMA);
        db.exec(SQLITE_FTS_SCHEMA);
        db.exec('DROP TRIGGER tasks_au');
        db.exec('INSERT OR IGNORE INTO schema_migrations (version) VALUES (3)');

        const migrated = await (adapter as unknown as { ensureFtsTriggers: (force?: boolean) => Promise<boolean> })
            .ensureFtsTriggers();
        expect(migrated).toBe(true);

        const triggerNames = allSql<{ name: string }>(
            db,
            `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN
                ('tasks_ai', 'tasks_ad', 'tasks_au', 'projects_ai', 'projects_ad', 'projects_au')`
        ).map((row) => row.name);
        expect(triggerNames).toEqual(expect.arrayContaining([
            'tasks_ai', 'tasks_ad', 'tasks_au', 'projects_ai', 'projects_ad', 'projects_au',
        ]));
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

        expect(() =>
            runSql(db, `
                INSERT INTO tasks (id, title, status, relativeStartOffset, createdAt, updatedAt)
                VALUES ('bad-relative-start-json', 'Bad relative start json', 'next', '{invalid', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
            `)
        ).toThrow(/invalid_tasks_relative_start_offset_json/i);
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

describeSqlite('SqliteAdapter incremental saveData', () => {
    let db: Database;
    let adapter: SqliteAdapter;
    let statements: { sql: string; params: unknown[] }[];

    const baseData = (): AppData => {
        const now = '2026-07-01T08:00:00.000Z';
        return {
            tasks: [
                { id: 'task-1', title: 'First', status: 'next', tags: [], contexts: [], createdAt: now, updatedAt: now, rev: 1, revBy: 'dev-a' },
                { id: 'task-2', title: 'Second', status: 'inbox', tags: [], contexts: [], createdAt: now, updatedAt: now, rev: 1, revBy: 'dev-a' },
            ],
            projects: [
                { id: 'project-1', title: 'Project', status: 'active', color: '#2563EB', order: 0, createdAt: now, updatedAt: now, rev: 1, revBy: 'dev-a' },
            ],
            sections: [],
            areas: [],
            people: [],
            settings: { gtd: { autoArchiveDays: 3 } },
        };
    };

    beforeEach(() => {
        if (!RuntimeDatabase) {
            throw new Error('No compatible sqlite runtime available for tests');
        }
        db = new RuntimeDatabase(':memory:');
        statements = [];
        const base = createClient(db);
        adapter = new SqliteAdapter({
            ...base,
            run: async (sql: string, params: unknown[] = []) => {
                statements.push({ sql, params });
                return base.run(sql, params);
            },
        });
    });

    afterEach(() => {
        db.close();
    });

    it('performs no table writes when a second identical saveData runs', async () => {
        const data = baseData();
        await adapter.saveData(data);
        statements = [];
        await adapter.saveData(data);
        const writes = statements.filter(({ sql }) =>
            sql.startsWith('INSERT INTO') || sql.startsWith('DELETE FROM') || sql.startsWith('CREATE TEMP TABLE'));
        expect(writes).toEqual([]);
        expect(adapter.getLastSaveDataStats()).toMatchObject({
            incremental: true,
            writtenRows: 0,
            removedRows: 0,
            settingsWritten: false,
        });
    });

    it('writes only the rows that changed since the last save', async () => {
        const data = baseData();
        await adapter.saveData(data);
        statements = [];
        await adapter.saveData({
            ...data,
            tasks: [
                data.tasks[0],
                { ...data.tasks[1], title: 'Second edited', rev: 2, updatedAt: '2026-07-01T09:00:00.000Z' },
            ],
        });
        const taskInserts = statements.filter(({ sql }) => sql.startsWith('INSERT INTO tasks'));
        expect(taskInserts).toHaveLength(1);
        expect(taskInserts[0].params).toContain('task-2');
        expect(taskInserts[0].params).not.toContain('task-1');
        expect(statements.filter(({ sql }) => sql.startsWith('INSERT INTO projects'))).toEqual([]);
        expect(statements.filter(({ sql }) => sql.startsWith('INSERT INTO settings'))).toEqual([]);
        const rows = allSql<{ id: string; title: string }>(db, 'SELECT id, title FROM tasks ORDER BY id');
        expect(rows).toEqual([
            { id: 'task-1', title: 'First' },
            { id: 'task-2', title: 'Second edited' },
        ]);
        expect(adapter.getLastSaveDataStats()).toMatchObject({
            incremental: true,
            writtenRows: 1,
            removedRows: 0,
        });
    });

    it('names the oscillating columns when a save rewrites a large share of a table (#766)', async () => {
        const now = '2026-07-01T08:00:00.000Z';
        const manyTasks = Array.from({ length: 200 }, (_, i) => ({
            id: `bulk-${i}`,
            title: `Bulk ${i}`,
            status: 'next' as const,
            tags: [],
            contexts: [],
            createdAt: now,
            updatedAt: now,
            rev: 1,
            revBy: 'dev-a',
            ...(i < 120 ? { deletedAt: now, purgedAt: now } : {}),
        }));
        const data = { ...baseData(), tasks: manyTasks };
        await adapter.saveData(data);
        expect(adapter.getLastSaveDataStats().rewriteDiagnostics).toBeUndefined();

        // Flip one column on 150 pre-existing rows (120 purged + 30 live) —
        // the rc.2 sync-loop shape. The diagnostic must name the column and
        // count the tombstones.
        await adapter.saveData({
            ...data,
            tasks: manyTasks.map((task, i) => (i < 150 ? { ...task, pushCount: 1 } : task)),
        });
        const diagnostics = adapter.getLastSaveDataStats().rewriteDiagnostics;
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics?.[0]).toMatchObject({
            table: 'tasks',
            changedRows: 150,
            tableRows: 200,
            changedColumns: ['pushCount'],
            purgedChangedRows: 120,
        });

        // A handful of changed rows stays below the threshold: no diagnostic.
        await adapter.saveData({
            ...data,
            tasks: manyTasks.map((task, i) => (i < 150 ? { ...task, pushCount: 2 } : { ...task, title: `Renamed ${i}` })),
        });
        await adapter.saveData({
            ...data,
            tasks: manyTasks.map((task, i) => (i < 150 ? { ...task, pushCount: 2 } : { ...task, title: `Renamed again ${i}` })),
        });
        expect(adapter.getLastSaveDataStats().rewriteDiagnostics).toBeUndefined();
    });

    it('treats content-identical task clones as unchanged without relying on object identity (#766)', async () => {
        const data = baseData();
        await adapter.saveData(data);
        statements = [];
        await adapter.saveData({
            ...data,
            tasks: data.tasks.map((task) => ({ ...task })),
        });
        expect(statements.filter(({ sql }) => sql.startsWith('INSERT INTO tasks'))).toEqual([]);
        expect(adapter.getLastSaveDataStats()).toMatchObject({
            incremental: true,
            writtenRows: 0,
            removedRows: 0,
        });
    });

    it('removes dropped rows only when their observed database version still matches', async () => {
        const data = baseData();
        await adapter.saveData(data);
        statements = [];
        await adapter.saveData({ ...data, tasks: [data.tasks[0]] });
        const deletes = statements.filter(({ sql }) => sql.startsWith('DELETE FROM tasks'));
        expect(deletes).toHaveLength(1);
        expect(deletes[0].sql).toContain('known.rev IS tasks.rev');
        expect(deletes[0].sql).toContain('known.updatedAt IS tasks.updatedAt');
        expect(deletes[0].sql).not.toContain('NOT IN');
        const versionInsert = statements.find(({ sql }) =>
            sql.startsWith('INSERT OR IGNORE INTO temp_tasks_ids_')
        );
        expect(versionInsert?.params).toEqual([
            'task-2',
            null,
            1,
            '2026-07-01T08:00:00.000Z',
        ]);
        const rows = allSql<{ id: string }>(db, 'SELECT id FROM tasks');
        expect(rows).toEqual([{ id: 'task-1' }]);
    });

    it('prunes a task created through saveTask when a later snapshot omits it', async () => {
        const data = baseData();
        await adapter.saveData(data);
        await adapter.saveTask({
            id: 'task-3', title: 'Incremental', status: 'inbox', tags: [], contexts: [],
            createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-01T10:00:00.000Z', rev: 1, revBy: 'dev-a',
        });
        await adapter.saveData(data);
        const rows = allSql<{ id: string }>(db, 'SELECT id FROM tasks ORDER BY id');
        expect(rows).toEqual([{ id: 'task-1' }, { id: 'task-2' }]);
    });

    it('falls back to a full write after a failed save', async () => {
        const data = baseData();
        await adapter.saveData(data);
        await expect(adapter.saveData({
            ...data,
            tasks: [{ ...data.tasks[0], status: 'not-a-status', rev: 2 }],
        })).rejects.toThrow();
        statements = [];
        await adapter.saveData(data);
        const taskInserts = statements.filter(({ sql }) => sql.startsWith('INSERT INTO tasks'));
        expect(taskInserts).toHaveLength(1);
        expect(taskInserts[0].params).toContain('task-1');
        expect(taskInserts[0].params).toContain('task-2');
        const rows = allSql<{ id: string; status: string }>(db, 'SELECT id, status FROM tasks ORDER BY id');
        expect(rows).toEqual([
            { id: 'task-1', status: 'next' },
            { id: 'task-2', status: 'inbox' },
        ]);
    });

    it('still skips stale rows the revision guard would reject', async () => {
        const data = baseData();
        await adapter.saveData(data);
        await adapter.saveTask({ ...data.tasks[0], title: 'Newer', rev: 5, updatedAt: '2026-07-01T11:00:00.000Z' });
        await adapter.saveData(data);
        await adapter.saveData(data);
        const row = getSql<{ title: string; rev: number }>(db, 'SELECT title, rev FROM tasks WHERE id = ?', ['task-1']);
        expect(row).toMatchObject({ title: 'Newer', rev: 5 });
    });
});

describe('SqliteAdapter saveData pruning', () => {
    it('does not run complement deletes when the adapter has no read or write baseline', async () => {
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
            people: [],
            settings: {},
        };

        await lightweightAdapter.saveData(data);

        const tempCreateCalls = run.mock.calls
            .map(([sql]) => String(sql))
            .filter((sql) => sql.startsWith('CREATE TEMP TABLE temp_'));
        expect(tempCreateCalls).toEqual([]);
        expect(run.mock.calls
            .map(([sql]) => String(sql))
            .filter((sql) => sql.startsWith('DELETE FROM tasks')
                || sql.startsWith('DELETE FROM projects')
                || sql.startsWith('DELETE FROM sections')
                || sql.startsWith('DELETE FROM areas')
                || sql.startsWith('DELETE FROM people')
                || sql.startsWith('DELETE FROM saved_filters'))
        ).toEqual([]);
    });
});

describe('SqliteAdapter empty-snapshot backstop (#852)', () => {
    const emptyData: AppData = {
        tasks: [],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
    };

    const makeAdapter = (storedTaskCount: number) => {
        const run = vi.fn().mockResolvedValue(undefined);
        const all = vi.fn().mockImplementation(async (sql: string) => {
            if (String(sql).startsWith('SELECT COUNT(*)')) {
                return String(sql).includes('FROM tasks') ? [{ count: storedTaskCount }] : [{ count: 0 }];
            }
            return [];
        });
        const client: SqliteClient = {
            run,
            get: vi.fn().mockResolvedValue(undefined),
            all,
            exec: vi.fn().mockResolvedValue(undefined),
        };
        const adapter = new SqliteAdapter(client);
        (adapter as unknown as { ensureSchema: () => Promise<void> }).ensureSchema = async () => {};
        return { adapter, run };
    };

    it('refuses an all-empty snapshot while the database still holds entities', async () => {
        const { adapter, run } = makeAdapter(3);

        await expect(adapter.saveData(emptyData)).rejects.toThrow(/empty snapshot/);

        // Refusal happens before any write: no transaction, no deletes.
        expect(run).not.toHaveBeenCalled();
    });

    it('allows an empty snapshot when the database is empty too (first run)', async () => {
        const { adapter, run } = makeAdapter(0);

        await adapter.saveData(emptyData);

        expect(run.mock.calls.map(([sql]) => String(sql))).toContain('BEGIN IMMEDIATE');
    });
});
