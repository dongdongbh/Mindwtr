import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import {
    SqliteAdapter,
    mergeAppData,
    normalizeAppData,
    type AppData,
    type SearchResults,
    type StorageAdapter,
    type Task,
    type TaskQueryOptions,
} from '@mindwtr/core';

import { resolveMindwtrStoragePaths } from './mindwtr-paths';

type AutomationStorageOptions = {
    dataPath?: string;
    dbPath?: string;
};

type AutomationStorage = StorageAdapter & {
    paths: {
        dataPath: string;
        dbPath: string;
    };
};

const hasAnyAppData = (data: AppData): boolean => (
    data.tasks.length > 0
    || data.projects.length > 0
    || data.sections.length > 0
    || data.areas.length > 0
    || Object.keys(data.settings).length > 0
);

const serializeComparable = (data: AppData): string => {
    const normalizeTask = (task: Task) => ({
        ...task,
        tags: [...(task.tags || [])].sort(),
        contexts: [...(task.contexts || [])].sort(),
        checklist: task.checklist
            ? [...task.checklist].map((item) => ({ ...item })).sort((a, b) => a.id.localeCompare(b.id))
            : undefined,
        attachments: task.attachments
            ? [...task.attachments].map((item) => ({ ...item })).sort((a, b) => a.id.localeCompare(b.id))
            : undefined,
    });

    return JSON.stringify({
        tasks: [...data.tasks].map(normalizeTask).sort((a, b) => a.id.localeCompare(b.id)),
        projects: [...data.projects]
            .map((project) => ({
                ...project,
                tagIds: [...(project.tagIds || [])].sort(),
                attachments: project.attachments
                    ? [...project.attachments].map((item) => ({ ...item })).sort((a, b) => a.id.localeCompare(b.id))
                    : undefined,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        sections: [...data.sections].map((section) => ({ ...section })).sort((a, b) => a.id.localeCompare(b.id)),
        areas: [...data.areas].map((area) => ({ ...area })).sort((a, b) => a.id.localeCompare(b.id)),
        settings: data.settings,
    });
};

const loadJsonData = (path: string): AppData | null => {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppData>;
    return normalizeAppData({
        tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as AppData['tasks']) : [],
        projects: Array.isArray(parsed.projects) ? (parsed.projects as AppData['projects']) : [],
        sections: Array.isArray(parsed.sections) ? (parsed.sections as AppData['sections']) : [],
        areas: Array.isArray(parsed.areas) ? (parsed.areas as AppData['areas']) : [],
        settings: typeof parsed.settings === 'object' && parsed.settings ? (parsed.settings as AppData['settings']) : {},
    });
};

const writeJsonData = (path: string, data: AppData) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    if (process.platform === 'win32' && existsSync(path)) {
        unlinkSync(path);
    }
    renameSync(tmpPath, path);
};

function openSqliteDatabase(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const sqlite = require('bun:sqlite') as {
        Database: new (path: string) => {
            exec: (sql: string) => void;
            prepare: (sql: string) => {
                run: (...params: unknown[]) => unknown;
            };
            query: (sql: string) => {
                all: (params?: unknown[]) => unknown[];
                get: (params?: unknown[]) => unknown;
            };
            close: () => void;
        };
    };
    const db = new sqlite.Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    return db;
}

function createSqliteClient(dbPath: string) {
    const db = openSqliteDatabase(dbPath);

    return {
        db,
        client: {
            run: async (sql: string, params: unknown[] = []) => {
                db.prepare(sql).run(...params);
            },
            all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                return db.query(sql).all(params) as T[];
            },
            get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                return db.query(sql).get(params) as T | undefined;
            },
            exec: async (sql: string) => {
                db.exec(sql);
            },
        },
        close: () => db.close(),
    };
}

export function createMindwtrAutomationStorage(options: AutomationStorageOptions = {}): AutomationStorage {
    const paths = resolveMindwtrStoragePaths(options);
    const { client } = createSqliteClient(paths.dbPath);
    const sqlite = new SqliteAdapter(client);
    let initPromise: Promise<void> | null = null;

    const persistSqliteSnapshot = async (data: AppData) => {
        const nowIso = new Date().toISOString();
        const toJson = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
        const toBool = (value?: boolean) => (value ? 1 : 0);

        await sqlite.ensureSchema();
        const writeDb = openSqliteDatabase(paths.dbPath);
        try {
            writeDb.exec('BEGIN IMMEDIATE;');
            writeDb.exec('PRAGMA defer_foreign_keys = ON;');

            for (const task of data.tasks) {
                const taskOrder = Number.isFinite(task.order) ? task.order : task.orderNum;
                writeDb.prepare(
                    `INSERT INTO tasks (
                        id, title, status, priority, taskMode, startTime, dueDate, recurrence, pushCount,
                        tags, contexts, checklist, description, textDirection, attachments, location,
                        projectId, sectionId, areaId, orderNum, isFocusedToday, timeEstimate, reviewAt,
                        completedAt, rev, revBy, createdAt, updatedAt, deletedAt, purgedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title = excluded.title,
                        status = excluded.status,
                        priority = excluded.priority,
                        taskMode = excluded.taskMode,
                        startTime = excluded.startTime,
                        dueDate = excluded.dueDate,
                        recurrence = excluded.recurrence,
                        pushCount = excluded.pushCount,
                        tags = excluded.tags,
                        contexts = excluded.contexts,
                        checklist = excluded.checklist,
                        description = excluded.description,
                        textDirection = excluded.textDirection,
                        attachments = excluded.attachments,
                        location = excluded.location,
                        projectId = excluded.projectId,
                        sectionId = excluded.sectionId,
                        areaId = excluded.areaId,
                        orderNum = excluded.orderNum,
                        isFocusedToday = excluded.isFocusedToday,
                        timeEstimate = excluded.timeEstimate,
                        reviewAt = excluded.reviewAt,
                        completedAt = excluded.completedAt,
                        rev = excluded.rev,
                        revBy = excluded.revBy,
                        createdAt = excluded.createdAt,
                        updatedAt = excluded.updatedAt,
                        deletedAt = excluded.deletedAt,
                        purgedAt = excluded.purgedAt`,
                ).run(
                    task.id,
                    task.title,
                    task.status,
                    task.priority ?? null,
                    task.taskMode ?? null,
                    task.startTime ?? null,
                    task.dueDate ?? null,
                    toJson(task.recurrence),
                    task.pushCount ?? null,
                    toJson(task.tags ?? []),
                    toJson(task.contexts ?? []),
                    toJson(task.checklist),
                    task.description ?? null,
                    task.textDirection ?? null,
                    toJson(task.attachments),
                    task.location ?? null,
                    task.projectId ?? null,
                    task.sectionId ?? null,
                    task.areaId ?? null,
                    taskOrder ?? null,
                    toBool(task.isFocusedToday),
                    task.timeEstimate ?? null,
                    task.reviewAt ?? null,
                    task.completedAt ?? null,
                    task.rev ?? null,
                    task.revBy ?? null,
                    task.createdAt || nowIso,
                    task.updatedAt || task.createdAt || nowIso,
                    task.deletedAt ?? null,
                    task.purgedAt ?? null,
                );
            }

            for (const project of data.projects) {
                writeDb.prepare(
                    `INSERT INTO projects (
                        id, title, status, color, orderNum, tagIds, isSequential, isFocused, supportNotes,
                        attachments, reviewAt, areaId, areaTitle, rev, revBy, createdAt, updatedAt, deletedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title = excluded.title,
                        status = excluded.status,
                        color = excluded.color,
                        orderNum = excluded.orderNum,
                        tagIds = excluded.tagIds,
                        isSequential = excluded.isSequential,
                        isFocused = excluded.isFocused,
                        supportNotes = excluded.supportNotes,
                        attachments = excluded.attachments,
                        reviewAt = excluded.reviewAt,
                        areaId = excluded.areaId,
                        areaTitle = excluded.areaTitle,
                        rev = excluded.rev,
                        revBy = excluded.revBy,
                        createdAt = excluded.createdAt,
                        updatedAt = excluded.updatedAt,
                        deletedAt = excluded.deletedAt`,
                ).run(
                    project.id,
                    project.title,
                    project.status,
                    project.color ?? '#94a3b8',
                    Number.isFinite(project.order) ? project.order : 0,
                    toJson(project.tagIds ?? []),
                    toBool(project.isSequential),
                    toBool(project.isFocused),
                    project.supportNotes ?? null,
                    toJson(project.attachments),
                    project.reviewAt ?? null,
                    project.areaId ?? null,
                    project.areaTitle ?? null,
                    project.rev ?? null,
                    project.revBy ?? null,
                    project.createdAt || nowIso,
                    project.updatedAt || project.createdAt || nowIso,
                    project.deletedAt ?? null,
                );
            }

            for (const section of data.sections) {
                writeDb.prepare(
                    `INSERT INTO sections (
                        id, projectId, title, description, orderNum, isCollapsed, rev, revBy, createdAt, updatedAt, deletedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        projectId = excluded.projectId,
                        title = excluded.title,
                        description = excluded.description,
                        orderNum = excluded.orderNum,
                        isCollapsed = excluded.isCollapsed,
                        rev = excluded.rev,
                        revBy = excluded.revBy,
                        createdAt = excluded.createdAt,
                        updatedAt = excluded.updatedAt,
                        deletedAt = excluded.deletedAt`,
                ).run(
                    section.id,
                    section.projectId,
                    section.title,
                    section.description ?? null,
                    Number.isFinite(section.order) ? section.order : 0,
                    toBool(section.isCollapsed),
                    section.rev ?? null,
                    section.revBy ?? null,
                    section.createdAt || nowIso,
                    section.updatedAt || section.createdAt || nowIso,
                    section.deletedAt ?? null,
                );
            }

            for (const area of data.areas) {
                writeDb.prepare(
                    `INSERT INTO areas (
                        id, name, color, icon, orderNum, rev, revBy, createdAt, updatedAt, deletedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        color = excluded.color,
                        icon = excluded.icon,
                        orderNum = excluded.orderNum,
                        rev = excluded.rev,
                        revBy = excluded.revBy,
                        createdAt = excluded.createdAt,
                        updatedAt = excluded.updatedAt,
                        deletedAt = excluded.deletedAt`,
                ).run(
                    area.id,
                    area.name,
                    area.color ?? null,
                    area.icon ?? null,
                    Number.isFinite(area.order) ? area.order : 0,
                    area.rev ?? null,
                    area.revBy ?? null,
                    area.createdAt || area.updatedAt || nowIso,
                    area.updatedAt || area.createdAt || nowIso,
                    area.deletedAt ?? null,
                );
            }

            writeDb.prepare(
                'INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
            ).run(JSON.stringify(data.settings ?? {}));
            writeDb.exec('COMMIT;');
        } catch (error) {
            try {
                writeDb.exec('ROLLBACK;');
            } catch {
                // Ignore rollback errors when SQLite has already closed the transaction.
            }
            throw error;
        } finally {
            writeDb.close();
        }
    };

    const saveNormalizedData = async (data: AppData) => {
        const normalized = normalizeAppData(data);
        await persistSqliteSnapshot(normalized);
        writeJsonData(paths.dataPath, normalized);
    };

    const ensureReady = async () => {
        if (initPromise) {
            await initPromise;
            return;
        }

        initPromise = (async () => {
            const sqliteData = normalizeAppData(await sqlite.getData());
            const jsonData = loadJsonData(paths.dataPath);
            const merged = jsonData ? normalizeAppData(mergeAppData(sqliteData, jsonData)) : sqliteData;
            const sqliteMatchesMerged = serializeComparable(sqliteData) === serializeComparable(merged);
            const jsonMatchesMerged = jsonData ? serializeComparable(jsonData) === serializeComparable(merged) : false;
            const shouldRepairMirror = !jsonData || !sqliteMatchesMerged || !jsonMatchesMerged;

            if (shouldRepairMirror && (hasAnyAppData(merged) || jsonData || existsSync(paths.dbPath))) {
                await saveNormalizedData(merged);
            }
        })();

        await initPromise;
    };

    return {
        paths,
        getData: async () => {
            await ensureReady();
            return normalizeAppData(await sqlite.getData());
        },
        saveData: async (data) => {
            await ensureReady();
            await saveNormalizedData(data);
        },
        queryTasks: async (query) => {
            await ensureReady();
            return sqlite.queryTasks ? sqlite.queryTasks(query as TaskQueryOptions) : [];
        },
        searchAll: async (query) => {
            await ensureReady();
            return sqlite.searchAll ? sqlite.searchAll(query) : ({ tasks: [], projects: [] } satisfies SearchResults);
        },
    };
}
