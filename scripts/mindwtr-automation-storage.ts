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

import { withMcpWriteLock } from '../apps/mcp-server/src/db-write-lock';
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

const logPeopleMigrationDiagnostic = (count: number): void => {
    process.stderr.write(`${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        scope: 'automation-storage',
        message: 'Automation people preserved during storage migration',
        context: {
            releaseCheck: 'v1.3.2/automation-people-preserved',
            count,
        },
    })}\n`);
};

const hasAnyAppData = (data: AppData): boolean => (
    data.tasks.length > 0
    || data.projects.length > 0
    || data.sections.length > 0
    || data.areas.length > 0
    || (data.people?.length ?? 0) > 0
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
        people: [...(data.people ?? [])].map((person) => ({ ...person })).sort((a, b) => a.id.localeCompare(b.id)),
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
        people: Array.isArray(parsed.people) ? (parsed.people as AppData['people']) : [],
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
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    return db;
}

function createSqliteClient(dbPath: string) {
    let db: ReturnType<typeof openSqliteDatabase> | null = null;
    const getDb = () => {
        db ??= openSqliteDatabase(dbPath);
        return db;
    };

    return {
        client: {
            run: async (sql: string, params: unknown[] = []) => {
                getDb().prepare(sql).run(...params);
            },
            all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                return getDb().query(sql).all(params) as T[];
            },
            get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                return getDb().query(sql).get(params) as T | undefined;
            },
            exec: async (sql: string) => {
                getDb().exec(sql);
            },
        },
        close: () => db?.close(),
    };
}

export function createMindwtrAutomationStorage(options: AutomationStorageOptions = {}): AutomationStorage {
    const paths = resolveMindwtrStoragePaths(options);
    mkdirSync(dirname(paths.dbPath), { recursive: true });
    const { client } = createSqliteClient(paths.dbPath);
    const sqlite = new SqliteAdapter(client, { rejectConcurrentWrites: true });
    let initPromise: Promise<void> | null = null;

    const saveNormalizedData = async (data: AppData) => {
        const normalized = normalizeAppData(data);


        await sqlite.saveData(normalized);
        const committed = normalizeAppData(await sqlite.getData());
        writeJsonData(paths.dataPath, committed);
        return committed;
    };

    const ensureReady = async () => {
        initPromise ??= (async () => {
            const sqliteData = normalizeAppData(await sqlite.getData());
            const jsonData = loadJsonData(paths.dataPath);
            const merged = jsonData ? normalizeAppData(mergeAppData(sqliteData, jsonData)) : sqliteData;
            const sqlitePersonIds = new Set((sqliteData.people ?? []).map((person) => person.id));
            const mergedPersonIds = new Set((merged.people ?? []).map((person) => person.id));
            const retainedPersonCount = (jsonData?.people ?? [])
                .filter((person) => !sqlitePersonIds.has(person.id) && mergedPersonIds.has(person.id)).length;
            const sqliteMatchesMerged = serializeComparable(sqliteData) === serializeComparable(merged);
            const jsonMatchesMerged = jsonData ? serializeComparable(jsonData) === serializeComparable(merged) : false;
            const shouldRepairMirror = !jsonData || !sqliteMatchesMerged || !jsonMatchesMerged;

            if (shouldRepairMirror && (hasAnyAppData(merged) || jsonData || existsSync(paths.dbPath))) {
                await saveNormalizedData(merged);
                if (retainedPersonCount > 0) {
                    logPeopleMigrationDiagnostic(retainedPersonCount);
                }
            }
        })();

        try {
            await initPromise;
        } catch (error) {
            initPromise = null;
            throw error;
        }
    };

    const withStorageLock = <T>(operation: () => Promise<T>): Promise<T> => (
        withMcpWriteLock(paths.dbPath, operation)
    );

    return {
        paths,
        getData: () => withStorageLock(async () => {
            await ensureReady();
            return normalizeAppData(await sqlite.getData());
        }),
        saveData: (data) => withStorageLock(async () => {
            await ensureReady();
            await saveNormalizedData(data);
        }),
        queryTasks: (query) => withStorageLock(async () => {
            await ensureReady();
            return sqlite.queryTasks ? sqlite.queryTasks(query as TaskQueryOptions) : [];
        }),
        searchAll: (query) => withStorageLock(async () => {
            await ensureReady();
            return sqlite.searchAll ? sqlite.searchAll(query) : ({ tasks: [], projects: [] } satisfies SearchResults);
        }),
    };
}
