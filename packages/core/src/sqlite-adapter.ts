import type { AppData, Area, Attachment, Project, Task, Section } from './types';
import type { TaskQueryOptions, SearchResults } from './storage';
import { SQLITE_BASE_SCHEMA, SQLITE_FTS_SCHEMA, SQLITE_INDEX_SCHEMA } from './sqlite-schema';
import { normalizeTaskStatus } from './task-status';
import { logWarn } from './logger';

export interface SqliteClient {
    run(sql: string, params?: unknown[]): Promise<void>;
    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
    exec?(sql: string): Promise<void>;
}

const toJson = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
const fromJson = <T>(value: unknown, fallback: T): T => {
    if (value === null || value === undefined || value === '') return fallback;
    try {
        const parsed = JSON.parse(String(value));
        if (fallback === undefined) {
            return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
        }
        if (Array.isArray(fallback)) {
            return Array.isArray(parsed) ? (parsed as T) : fallback;
        }
        if (typeof fallback === 'object' && fallback !== null) {
            return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
        }
        return parsed as T;
    } catch (error) {
        logWarn('Failed to parse JSON value, falling back to defaults', {
            scope: 'sqlite',
            category: 'storage',
            error,
        });
        return fallback;
    }
};

const toBool = (value?: boolean) => (value ? 1 : 0);
const fromBool = (value: unknown) => Boolean(value);
const READ_PAGE_SIZE = 1000;
const FTS_LOCK_TTL_MS = 5 * 60 * 1000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeProjectStatus = (value: unknown): Project['status'] => {
    if (value === 'active' || value === 'someday' || value === 'waiting' || value === 'archived') {
        return value;
    }
    if (typeof value === 'string') {
        const lowered = value.toLowerCase().trim();
        if (lowered === 'active' || lowered === 'someday' || lowered === 'waiting' || lowered === 'archived') {
            return lowered as Project['status'];
        }
    }
    return 'active';
};

const toStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
};

const toChecklist = (value: unknown): Task['checklist'] => {
    if (!Array.isArray(value)) return undefined;
    const cleaned = value
        .filter(isRecord)
        .filter((item) => typeof item.id === 'string' && typeof item.title === 'string')
        .map((item) => ({
            id: item.id as string,
            title: item.title as string,
            isCompleted: Boolean(item.isCompleted),
        }));
    return cleaned.length > 0 ? cleaned : undefined;
};

const toAttachments = (value: unknown): Attachment[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const allowedStatuses = new Set<Attachment['localStatus']>([
        'available',
        'missing',
        'uploading',
        'downloading',
    ]);
    const cleaned = value
        .filter(isRecord)
        .filter(
            (item) =>
                typeof item.id === 'string' &&
                typeof item.kind === 'string' &&
                typeof item.title === 'string' &&
                typeof item.uri === 'string'
        )
        .map((item) => ({
            id: item.id as string,
            kind: item.kind as Attachment['kind'],
            title: item.title as string,
            uri: item.uri as string,
            mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
            size: typeof item.size === 'number' ? item.size : undefined,
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
            updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
            deletedAt: typeof item.deletedAt === 'string' ? item.deletedAt : undefined,
            cloudKey: typeof item.cloudKey === 'string' ? item.cloudKey : undefined,
            fileHash: typeof item.fileHash === 'string' ? item.fileHash : undefined,
            localStatus: typeof item.localStatus === 'string' && allowedStatuses.has(item.localStatus as Attachment['localStatus'])
                ? (item.localStatus as Attachment['localStatus'])
                : undefined,
        }));
    return cleaned.length > 0 ? cleaned : undefined;
};

export class SqliteAdapter {
    private client: SqliteClient;
    private schemaReadyPromise: Promise<void> | null = null;

    constructor(client: SqliteClient) {
        this.client = client;
    }

    private async loadAllRows(table: 'tasks' | 'projects' | 'sections' | 'areas'): Promise<Record<string, unknown>[]> {
        const rows: Record<string, unknown>[] = [];
        try {
            let lastRowId = 0;
            while (true) {
                const page = await this.client.all<Record<string, unknown> & { _rowid: number }>(
                    `SELECT rowid as _rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
                    [lastRowId, READ_PAGE_SIZE]
                );
                if (page.length === 0) break;
                page.forEach((row) => {
                    const { _rowid, ...rest } = row;
                    if (typeof _rowid === 'number') {
                        lastRowId = _rowid;
                    }
                    rows.push(rest);
                });
                if (page.length < READ_PAGE_SIZE) break;
            }
            return rows;
        } catch (error) {
            logWarn('Failed to page with rowid, falling back to offset pagination', {
                scope: 'sqlite',
                category: 'storage',
                error,
            });
        }
        let offset = 0;
        while (true) {
            const page = await this.client.all<Record<string, unknown>>(
                `SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`,
                [READ_PAGE_SIZE, offset]
            );
            rows.push(...page);
            if (page.length < READ_PAGE_SIZE) break;
            offset += READ_PAGE_SIZE;
        }
        return rows;
    }

    private async acquireFtsLock(): Promise<string | null> {
        const owner = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = Date.now();
        const staleBefore = now - FTS_LOCK_TTL_MS;
        await this.client.run(
            'CREATE TABLE IF NOT EXISTS fts_lock (id INTEGER PRIMARY KEY, owner TEXT, acquiredAt INTEGER)'
        );
        const row = await this.client.get<{ owner?: string }>(
            `INSERT INTO fts_lock (id, owner, acquiredAt)
             VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               owner = excluded.owner,
               acquiredAt = excluded.acquiredAt
             WHERE fts_lock.acquiredAt < ?
             RETURNING owner`,
            [owner, now, staleBefore]
        );
        return row?.owner === owner ? owner : null;
    }

    private async releaseFtsLock(owner: string): Promise<void> {
        await this.client.run('DELETE FROM fts_lock WHERE id = 1 AND owner = ?', [owner]);
    }

    private async ensureSchemaInternal(): Promise<void> {
        if (this.client.exec) {
            await this.client.exec(SQLITE_BASE_SCHEMA);
        } else {
            await this.client.run(SQLITE_BASE_SCHEMA);
        }
        await this.ensureTaskColumns();
        await this.ensureProjectColumns();
        await this.ensureSectionColumns();
        await this.ensureAreaColumns();
        if (this.client.exec) {
            await this.client.exec(SQLITE_FTS_SCHEMA);
            await this.client.exec(SQLITE_INDEX_SCHEMA);
        } else {
            await this.client.run(SQLITE_FTS_SCHEMA);
            await this.client.run(SQLITE_INDEX_SCHEMA);
        }
        // FTS operations are optional - don't block startup if they fail
        try {
            await this.ensureFtsTriggers();
            await this.ensureFtsPopulated();
        } catch (error) {
            logWarn('FTS setup failed, search may not work', {
                scope: 'sqlite',
                category: 'fts',
                error,
            });
        }
    }

    async ensureSchema(): Promise<void> {
        if (!this.schemaReadyPromise) {
            this.schemaReadyPromise = this.ensureSchemaInternal().catch((error) => {
                this.schemaReadyPromise = null;
                throw error;
            });
        }
        await this.schemaReadyPromise;
    }

    private async ensureFtsTriggers() {
        // Recreate FTS triggers to use proper contentless FTS5 delete syntax
        // Old triggers used "DELETE FROM tasks_fts WHERE id = ..." which fails on contentless tables
        try {
            const migrations = await this.client.all<{ version: number }>('SELECT version FROM schema_migrations');
            const hasV2 = migrations.some((m) => m.version === 2);
            if (hasV2) return;

            // Drop old triggers and recreate with correct syntax
            await this.client.run('DROP TRIGGER IF EXISTS tasks_ad');
            await this.client.run('DROP TRIGGER IF EXISTS tasks_au');
            await this.client.run('DROP TRIGGER IF EXISTS projects_ad');
            await this.client.run('DROP TRIGGER IF EXISTS projects_au');

            await this.client.run(`
                CREATE TRIGGER tasks_ad AFTER DELETE ON tasks BEGIN
                  INSERT INTO tasks_fts (tasks_fts, id, title, description, tags, contexts)
                  VALUES ('delete', old.id, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''));
                END
            `);
            await this.client.run(`
                CREATE TRIGGER tasks_au AFTER UPDATE ON tasks BEGIN
                  INSERT INTO tasks_fts (tasks_fts, id, title, description, tags, contexts)
                  VALUES ('delete', old.id, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''));
                  INSERT INTO tasks_fts (id, title, description, tags, contexts)
                  VALUES (new.id, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''));
                END
            `);
            await this.client.run(`
                CREATE TRIGGER projects_ad AFTER DELETE ON projects BEGIN
                  INSERT INTO projects_fts (projects_fts, id, title, supportNotes, tagIds, areaTitle)
                  VALUES ('delete', old.id, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
                END
            `);
            await this.client.run(`
                CREATE TRIGGER projects_au AFTER UPDATE ON projects BEGIN
                  INSERT INTO projects_fts (projects_fts, id, title, supportNotes, tagIds, areaTitle)
                  VALUES ('delete', old.id, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
                  INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
                  VALUES (new.id, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
                END
            `);

            await this.client.run('INSERT OR IGNORE INTO schema_migrations (version) VALUES (2)');
        } catch (error) {
            logWarn('Failed to migrate FTS triggers', {
                scope: 'sqlite',
                category: 'fts',
                error,
            });
            // Continue without migrating - triggers may still work or will fail gracefully
        }
    }

    private async ensureTaskColumns() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(tasks)');
        const names = new Set(columns.map((col) => col.name));
        const definitions: Array<{ name: string; sql: string }> = [
            { name: 'priority', sql: 'ALTER TABLE tasks ADD COLUMN priority TEXT' },
            { name: 'taskMode', sql: 'ALTER TABLE tasks ADD COLUMN taskMode TEXT' },
            { name: 'startTime', sql: 'ALTER TABLE tasks ADD COLUMN startTime TEXT' },
            { name: 'dueDate', sql: 'ALTER TABLE tasks ADD COLUMN dueDate TEXT' },
            { name: 'recurrence', sql: 'ALTER TABLE tasks ADD COLUMN recurrence TEXT' },
            { name: 'pushCount', sql: 'ALTER TABLE tasks ADD COLUMN pushCount INTEGER' },
            { name: 'tags', sql: 'ALTER TABLE tasks ADD COLUMN tags TEXT' },
            { name: 'contexts', sql: 'ALTER TABLE tasks ADD COLUMN contexts TEXT' },
            { name: 'checklist', sql: 'ALTER TABLE tasks ADD COLUMN checklist TEXT' },
            { name: 'description', sql: 'ALTER TABLE tasks ADD COLUMN description TEXT' },
            { name: 'textDirection', sql: 'ALTER TABLE tasks ADD COLUMN textDirection TEXT' },
            { name: 'attachments', sql: 'ALTER TABLE tasks ADD COLUMN attachments TEXT' },
            { name: 'location', sql: 'ALTER TABLE tasks ADD COLUMN location TEXT' },
            { name: 'projectId', sql: 'ALTER TABLE tasks ADD COLUMN projectId TEXT' },
            { name: 'sectionId', sql: 'ALTER TABLE tasks ADD COLUMN sectionId TEXT' },
            { name: 'areaId', sql: 'ALTER TABLE tasks ADD COLUMN areaId TEXT' },
            { name: 'orderNum', sql: 'ALTER TABLE tasks ADD COLUMN orderNum INTEGER' },
            { name: 'isFocusedToday', sql: 'ALTER TABLE tasks ADD COLUMN isFocusedToday INTEGER' },
            { name: 'timeEstimate', sql: 'ALTER TABLE tasks ADD COLUMN timeEstimate TEXT' },
            { name: 'reviewAt', sql: 'ALTER TABLE tasks ADD COLUMN reviewAt TEXT' },
            { name: 'completedAt', sql: 'ALTER TABLE tasks ADD COLUMN completedAt TEXT' },
            { name: 'rev', sql: 'ALTER TABLE tasks ADD COLUMN rev INTEGER' },
            { name: 'revBy', sql: 'ALTER TABLE tasks ADD COLUMN revBy TEXT' },
            { name: 'createdAt', sql: 'ALTER TABLE tasks ADD COLUMN createdAt TEXT' },
            { name: 'updatedAt', sql: 'ALTER TABLE tasks ADD COLUMN updatedAt TEXT' },
            { name: 'deletedAt', sql: 'ALTER TABLE tasks ADD COLUMN deletedAt TEXT' },
            { name: 'purgedAt', sql: 'ALTER TABLE tasks ADD COLUMN purgedAt TEXT' },
        ];
        for (const definition of definitions) {
            if (!names.has(definition.name)) {
                await this.client.run(definition.sql);
            }
        }
    }

    private async ensureProjectColumns() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(projects)');
        const names = new Set(columns.map((col) => col.name));
        const definitions: Array<{ name: string; sql: string }> = [
            { name: 'orderNum', sql: 'ALTER TABLE projects ADD COLUMN orderNum INTEGER' },
            { name: 'tagIds', sql: 'ALTER TABLE projects ADD COLUMN tagIds TEXT' },
            { name: 'isSequential', sql: 'ALTER TABLE projects ADD COLUMN isSequential INTEGER' },
            { name: 'isFocused', sql: 'ALTER TABLE projects ADD COLUMN isFocused INTEGER' },
            { name: 'supportNotes', sql: 'ALTER TABLE projects ADD COLUMN supportNotes TEXT' },
            { name: 'attachments', sql: 'ALTER TABLE projects ADD COLUMN attachments TEXT' },
            { name: 'reviewAt', sql: 'ALTER TABLE projects ADD COLUMN reviewAt TEXT' },
            { name: 'areaId', sql: 'ALTER TABLE projects ADD COLUMN areaId TEXT' },
            { name: 'areaTitle', sql: 'ALTER TABLE projects ADD COLUMN areaTitle TEXT' },
            { name: 'rev', sql: 'ALTER TABLE projects ADD COLUMN rev INTEGER' },
            { name: 'revBy', sql: 'ALTER TABLE projects ADD COLUMN revBy TEXT' },
            { name: 'createdAt', sql: 'ALTER TABLE projects ADD COLUMN createdAt TEXT' },
            { name: 'updatedAt', sql: 'ALTER TABLE projects ADD COLUMN updatedAt TEXT' },
            { name: 'deletedAt', sql: 'ALTER TABLE projects ADD COLUMN deletedAt TEXT' },
        ];
        for (const definition of definitions) {
            if (!names.has(definition.name)) {
                await this.client.run(definition.sql);
            }
        }
        await this.client.run(
            'CREATE INDEX IF NOT EXISTS idx_projects_area_order ON projects(areaId, orderNum)'
        );
    }

    private async ensureSectionColumns() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(sections)');
        const names = new Set(columns.map((col) => col.name));
        const definitions: Array<{ name: string; sql: string }> = [
            { name: 'description', sql: 'ALTER TABLE sections ADD COLUMN description TEXT' },
            { name: 'orderNum', sql: 'ALTER TABLE sections ADD COLUMN orderNum INTEGER' },
            { name: 'isCollapsed', sql: 'ALTER TABLE sections ADD COLUMN isCollapsed INTEGER' },
            { name: 'rev', sql: 'ALTER TABLE sections ADD COLUMN rev INTEGER' },
            { name: 'revBy', sql: 'ALTER TABLE sections ADD COLUMN revBy TEXT' },
            { name: 'createdAt', sql: 'ALTER TABLE sections ADD COLUMN createdAt TEXT' },
            { name: 'updatedAt', sql: 'ALTER TABLE sections ADD COLUMN updatedAt TEXT' },
            { name: 'deletedAt', sql: 'ALTER TABLE sections ADD COLUMN deletedAt TEXT' },
        ];
        for (const definition of definitions) {
            if (!names.has(definition.name)) {
                await this.client.run(definition.sql);
            }
        }
    }

    private async ensureAreaColumns() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(areas)');
        const names = new Set(columns.map((col) => col.name));
        const definitions: Array<{ name: string; sql: string }> = [
            { name: 'color', sql: 'ALTER TABLE areas ADD COLUMN color TEXT' },
            { name: 'icon', sql: 'ALTER TABLE areas ADD COLUMN icon TEXT' },
            { name: 'orderNum', sql: 'ALTER TABLE areas ADD COLUMN orderNum INTEGER' },
            { name: 'rev', sql: 'ALTER TABLE areas ADD COLUMN rev INTEGER' },
            { name: 'revBy', sql: 'ALTER TABLE areas ADD COLUMN revBy TEXT' },
            { name: 'createdAt', sql: 'ALTER TABLE areas ADD COLUMN createdAt TEXT' },
            { name: 'updatedAt', sql: 'ALTER TABLE areas ADD COLUMN updatedAt TEXT' },
            { name: 'deletedAt', sql: 'ALTER TABLE areas ADD COLUMN deletedAt TEXT' },
        ];
        for (const definition of definitions) {
            if (!names.has(definition.name)) {
                await this.client.run(definition.sql);
            }
        }
    }

    private async ensureFtsPopulated(forceRebuild = false) {
        try {
            const totals = await this.client.get<{
                tasks_total?: number;
                tasks_fts_total?: number;
                projects_total?: number;
                projects_fts_total?: number;
            }>(
                `SELECT
                    (SELECT COUNT(*) FROM tasks) as tasks_total,
                    (SELECT COUNT(*) FROM tasks_fts) as tasks_fts_total,
                    (SELECT COUNT(*) FROM projects) as projects_total,
                    (SELECT COUNT(*) FROM projects_fts) as projects_fts_total
                `
            );
            const tasksTotal = Number(totals?.tasks_total ?? 0);
            const tasksFtsTotal = Number(totals?.tasks_fts_total ?? 0);
            const projectsTotal = Number(totals?.projects_total ?? 0);
            const projectsFtsTotal = Number(totals?.projects_fts_total ?? 0);

            if (!forceRebuild && tasksTotal === tasksFtsTotal && projectsTotal === projectsFtsTotal && tasksTotal > 0) {
                return;
            }

            const counts = await this.client.get<{
                task_count?: number;
                task_missing?: number;
                task_extra?: number;
                project_count?: number;
                project_missing?: number;
                project_extra?: number;
            }>(
                `SELECT
                    (SELECT COUNT(*) FROM tasks_fts) as task_count,
                    (SELECT COUNT(*) FROM (SELECT id FROM tasks EXCEPT SELECT id FROM tasks_fts)) as task_missing,
                    (SELECT COUNT(*) FROM (SELECT id FROM tasks_fts EXCEPT SELECT id FROM tasks)) as task_extra,
                    (SELECT COUNT(*) FROM projects_fts) as project_count,
                    (SELECT COUNT(*) FROM (SELECT id FROM projects EXCEPT SELECT id FROM projects_fts)) as project_missing,
                    (SELECT COUNT(*) FROM (SELECT id FROM projects_fts EXCEPT SELECT id FROM projects)) as project_extra
                `
            );
            const taskCount = Number(counts?.task_count ?? tasksFtsTotal ?? 0);
            const taskMissing = Number(counts?.task_missing ?? 0);
            const taskExtra = Number(counts?.task_extra ?? 0);
            const needsTaskRebuild = forceRebuild || taskCount === 0 || taskMissing > 0 || taskExtra > 0;

            const projectCount = Number(counts?.project_count ?? projectsFtsTotal ?? 0);
            const projectMissing = Number(counts?.project_missing ?? 0);
            const projectExtra = Number(counts?.project_extra ?? 0);
            const needsProjectRebuild = forceRebuild || projectCount === 0 || projectMissing > 0 || projectExtra > 0;

            if (!needsTaskRebuild && !needsProjectRebuild) return;

            const maxAttempts = 3;
            let lockOwner = await this.acquireFtsLock();
            for (let attempt = 1; !lockOwner && attempt < maxAttempts; attempt += 1) {
                const baseDelayMs = Math.min(2000, 200 * Math.pow(2, attempt - 1));
                const jitterMs = Math.floor(Math.random() * (baseDelayMs * 0.5));
                const delayMs = baseDelayMs + jitterMs;
                logWarn('FTS rebuild lock unavailable, retrying', {
                    scope: 'sqlite',
                    category: 'fts',
                    context: {
                        attempt: attempt + 1,
                        baseDelayMs,
                        jitterMs,
                        delayMs,
                    },
                });
                await sleep(delayMs);
                lockOwner = await this.acquireFtsLock();
            }
            if (!lockOwner) {
                logWarn('FTS rebuild skipped: lock unavailable after retries', {
                    scope: 'sqlite',
                    category: 'fts',
                    context: {
                        attempts: maxAttempts,
                    },
                });
                return;
            }

            try {
                await this.client.run('BEGIN');
                try {
                    if (needsTaskRebuild) {
                        // Use FTS5 delete-all command for contentless tables (content='')
                        await this.client.run("INSERT INTO tasks_fts(tasks_fts) VALUES('delete-all')");
                        await this.client.run(
                            `INSERT INTO tasks_fts (id, title, description, tags, contexts)
                             SELECT id, title, coalesce(description, ''), coalesce(tags, ''), coalesce(contexts, '') FROM tasks`
                        );
                    }
                    if (needsProjectRebuild) {
                        // Use FTS5 delete-all command for contentless tables (content='')
                        await this.client.run("INSERT INTO projects_fts(projects_fts) VALUES('delete-all')");
                        await this.client.run(
                            `INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
                             SELECT id, title, coalesce(supportNotes, ''), coalesce(tagIds, ''), coalesce(areaTitle, '') FROM projects`
                        );
                    }
                    await this.client.run('COMMIT');
                } catch (error) {
                    await this.client.run('ROLLBACK');
                    throw error;
                }
            } finally {
                await this.releaseFtsLock(lockOwner);
            }
        } catch (error) {
            logWarn('Failed to populate FTS index', {
                scope: 'sqlite',
                category: 'fts',
                error,
            });
            // Continue without FTS - search will fail gracefully
        }
    }

    private mapTaskRow(row: Record<string, unknown>): Task {
        return {
            id: String(row.id),
            title: String(row.title ?? ''),
            status: normalizeTaskStatus(row.status),
            priority: row.priority as Task['priority'] | undefined,
            taskMode: row.taskMode as Task['taskMode'] | undefined,
            startTime: row.startTime as string | undefined,
            dueDate: row.dueDate as string | undefined,
            recurrence: ((): Task['recurrence'] => {
                const parsed = fromJson<Task['recurrence']>(row.recurrence, undefined);
                return parsed && typeof parsed === 'object' ? parsed : undefined;
            })(),
            pushCount: row.pushCount === null || row.pushCount === undefined ? undefined : Number(row.pushCount),
            tags: toStringArray(fromJson<unknown>(row.tags, [])),
            contexts: toStringArray(fromJson<unknown>(row.contexts, [])),
            checklist: toChecklist(fromJson<unknown>(row.checklist, undefined)),
            description: row.description as string | undefined,
            textDirection: row.textDirection as Task['textDirection'] | undefined,
            attachments: toAttachments(fromJson<unknown>(row.attachments, undefined)),
            location: row.location as string | undefined,
            projectId: row.projectId as string | undefined,
            sectionId: row.sectionId as string | undefined,
            areaId: row.areaId as string | undefined,
            orderNum: row.orderNum === null || row.orderNum === undefined ? undefined : Number(row.orderNum),
            isFocusedToday: fromBool(row.isFocusedToday),
            timeEstimate: row.timeEstimate as Task['timeEstimate'] | undefined,
            reviewAt: row.reviewAt as string | undefined,
            completedAt: row.completedAt as string | undefined,
            rev: row.rev === null || row.rev === undefined ? undefined : Number(row.rev),
            revBy: row.revBy as string | undefined,
            createdAt: String(row.createdAt ?? ''),
            updatedAt: String(row.updatedAt ?? ''),
            deletedAt: row.deletedAt as string | undefined,
            purgedAt: row.purgedAt as string | undefined,
        };
    }

    private mapProjectRow(row: Record<string, unknown>): Project {
        return {
            id: String(row.id),
            title: String(row.title ?? ''),
            status: normalizeProjectStatus(row.status),
            color: String(row.color ?? '#6B7280'),
            order: row.orderNum === null || row.orderNum === undefined ? 0 : Number(row.orderNum),
            tagIds: toStringArray(fromJson<unknown>(row.tagIds, [])),
            isSequential: fromBool(row.isSequential),
            isFocused: fromBool(row.isFocused),
            supportNotes: row.supportNotes as string | undefined,
            attachments: toAttachments(fromJson<unknown>(row.attachments, undefined)),
            reviewAt: row.reviewAt as string | undefined,
            areaId: row.areaId as string | undefined,
            areaTitle: row.areaTitle as string | undefined,
            rev: row.rev === null || row.rev === undefined ? undefined : Number(row.rev),
            revBy: row.revBy as string | undefined,
            createdAt: String(row.createdAt ?? ''),
            updatedAt: String(row.updatedAt ?? ''),
            deletedAt: row.deletedAt as string | undefined,
        };
    }

    private mapSectionRow(row: Record<string, unknown>): Section {
        return {
            id: String(row.id),
            projectId: String(row.projectId ?? ''),
            title: String(row.title ?? ''),
            description: row.description as string | undefined,
            order: row.orderNum === null || row.orderNum === undefined ? 0 : Number(row.orderNum),
            isCollapsed: fromBool(row.isCollapsed),
            rev: row.rev === null || row.rev === undefined ? undefined : Number(row.rev),
            revBy: row.revBy as string | undefined,
            createdAt: String(row.createdAt ?? ''),
            updatedAt: String(row.updatedAt ?? ''),
            deletedAt: row.deletedAt as string | undefined,
        };
    }

    async getData(): Promise<AppData> {
        await this.ensureSchema();
        const [tasksRows, projectsRows, sectionsRows, areasRows, settingsRow] = await Promise.all([
            this.loadAllRows('tasks'),
            this.loadAllRows('projects'),
            this.loadAllRows('sections'),
            this.loadAllRows('areas'),
            this.client.get<Record<string, unknown>>('SELECT data FROM settings WHERE id = 1'),
        ]);

        const tasks: Task[] = tasksRows.map((row) => this.mapTaskRow(row));
        const projects: Project[] = projectsRows.map((row) => this.mapProjectRow(row));
        const sections: Section[] = sectionsRows.map((row) => this.mapSectionRow(row));

        const areas: Area[] = areasRows.map((row) => ({
            id: String(row.id),
            name: String(row.name ?? ''),
            color: row.color as string | undefined,
            icon: row.icon as string | undefined,
            order: Number(row.orderNum ?? 0),
            rev: row.rev === null || row.rev === undefined ? undefined : Number(row.rev),
            revBy: row.revBy as string | undefined,
            createdAt: row.createdAt as string | undefined,
            updatedAt: row.updatedAt as string | undefined,
            deletedAt: row.deletedAt as string | undefined,
        }));

        const settings = settingsRow?.data ? fromJson<AppData['settings']>(settingsRow.data, {}) : {};

        return { tasks, projects, sections, areas, settings };
    }

    async queryTasks(options: TaskQueryOptions): Promise<Task[]> {
        await this.ensureSchema();
        const where: string[] = [];
        const params: unknown[] = [];
        const includeDeleted = options.includeDeleted === true;
        const includeArchived = options.includeArchived === true;

        if (!includeDeleted) {
            where.push('deletedAt IS NULL');
        }
        if (!includeArchived) {
            where.push("status != 'archived'");
        }
        if (options.status && options.status !== 'all') {
            where.push('status = ?');
            params.push(options.status);
        }
        if (options.excludeStatuses && options.excludeStatuses.length > 0) {
            where.push(`status NOT IN (${options.excludeStatuses.map(() => '?').join(', ')})`);
            params.push(...options.excludeStatuses);
        }
        if (options.projectId) {
            where.push('projectId = ?');
            params.push(options.projectId);
        }

        const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
        const rows = await this.client.all<Record<string, unknown>>(sql, params);
        return rows.map((row) => this.mapTaskRow(row));
    }

    async searchAll(query: string): Promise<SearchResults> {
        await this.ensureSchema();
        const safeQuery = typeof query === 'string' ? query : '';
        const cleaned = safeQuery
            .replace(/[^\p{L}\p{N}#@]+/gu, ' ')
            .trim();
        if (!cleaned) {
            return { tasks: [], projects: [] };
        }
        const reservedTokens = new Set(['AND', 'OR', 'NOT', 'NEAR']);
        const tokens = cleaned
            .split(/\s+/)
            .filter(Boolean)
            .filter((token) => !reservedTokens.has(token.toUpperCase()));
        if (tokens.length === 0) {
            return { tasks: [], projects: [] };
        }
        const ftsQuery = tokens.map((token) => `${token}*`).join(' ');
        const runSearch = async (): Promise<SearchResults> => {
            const taskRows = await this.client.all<Record<string, unknown>>(
                `SELECT t.* FROM tasks_fts f JOIN tasks t ON f.id = t.id WHERE tasks_fts MATCH ? AND t.deletedAt IS NULL`,
                [ftsQuery]
            );
            const projectRows = await this.client.all<Record<string, unknown>>(
                `SELECT p.* FROM projects_fts f JOIN projects p ON f.id = p.id WHERE projects_fts MATCH ? AND p.deletedAt IS NULL`,
                [ftsQuery]
            );
            return {
                tasks: taskRows.map((row) => this.mapTaskRow(row)),
                projects: projectRows.map((row) => this.mapProjectRow(row)),
            };
        };

        try {
            return await runSearch();
        } catch (error) {
            try {
                await this.ensureFtsPopulated(true);
                return await runSearch();
            } catch (retryError) {
                logWarn('Search failed', { scope: 'sqlite', category: 'fts', error: retryError });
                return { tasks: [], projects: [] };
            }
        }
    }

    async saveData(data: AppData): Promise<void> {
        await this.ensureSchema();
        await this.client.run('BEGIN IMMEDIATE');
        try {
            const chunkArray = <T>(items: T[], size: number): T[][] => {
                const chunks: T[][] = [];
                for (let i = 0; i < items.length; i += size) {
                    chunks.push(items.slice(i, i + size));
                }
                return chunks;
            };

            const upsertBatch = async (
                table: string,
                columns: string[],
                rows: unknown[][],
                updateClause: string,
                chunkSize = 200,
            ) => {
                if (rows.length === 0) return;
                const columnList = columns.join(', ');
                const placeholders = `(${columns.map(() => '?').join(', ')})`;
                for (const batch of chunkArray(rows, chunkSize)) {
                    const values: unknown[] = [];
                    const valuePlaceholders = batch
                        .map((row) => {
                            values.push(...row);
                            return placeholders;
                        })
                        .join(', ');
                    await this.client.run(
                        `INSERT INTO ${table} (${columnList}) VALUES ${valuePlaceholders} ON CONFLICT(id) DO UPDATE SET ${updateClause}`,
                        values
                    );
                }
            };

            const syncIds = async (table: 'tasks' | 'projects' | 'sections' | 'areas', ids: string[]) => {
                const tempTable = `temp_${table}_ids_${Date.now()}`;
                try {
                    await this.client.run(`CREATE TEMP TABLE ${tempTable} (id TEXT PRIMARY KEY)`);
                    for (const id of ids) {
                        await this.client.run(`INSERT OR IGNORE INTO ${tempTable} (id) VALUES (?)`, [id]);
                    }
                    await this.client.run(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${tempTable})`);
                } finally {
                    try {
                        await this.client.run(`DROP TABLE ${tempTable}`);
                    } catch (dropError) {
                        logWarn(`Failed to drop temp table ${tempTable}`, {
                            scope: 'sqlite',
                            category: 'storage',
                            error: dropError,
                        });
                    }
                }
            };

            await syncIds('tasks', data.tasks.map((task) => task.id));
            await syncIds('projects', data.projects.map((project) => project.id));
            await syncIds('sections', data.sections.map((section) => section.id));
            await syncIds('areas', data.areas.map((area) => area.id));

            await upsertBatch(
                'tasks',
                [
                    'id',
                    'title',
                    'status',
                    'priority',
                    'taskMode',
                    'startTime',
                    'dueDate',
                    'recurrence',
                    'pushCount',
                    'tags',
                    'contexts',
                    'checklist',
                    'description',
                    'textDirection',
                    'attachments',
                    'location',
                    'projectId',
                    'sectionId',
                    'areaId',
                    'orderNum',
                    'isFocusedToday',
                    'timeEstimate',
                    'reviewAt',
                    'completedAt',
                    'rev',
                    'revBy',
                    'createdAt',
                    'updatedAt',
                    'deletedAt',
                    'purgedAt',
                ],
                data.tasks.map((task) => [
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
                    task.orderNum ?? null,
                    toBool(task.isFocusedToday),
                    task.timeEstimate ?? null,
                    task.reviewAt ?? null,
                    task.completedAt ?? null,
                    task.rev ?? null,
                    task.revBy ?? null,
                    task.createdAt,
                    task.updatedAt,
                    task.deletedAt ?? null,
                    task.purgedAt ?? null,
                ]),
                `title=excluded.title,
                 status=excluded.status,
                 priority=excluded.priority,
                 taskMode=excluded.taskMode,
                 startTime=excluded.startTime,
                 dueDate=excluded.dueDate,
                 recurrence=excluded.recurrence,
                 pushCount=excluded.pushCount,
                 tags=excluded.tags,
                 contexts=excluded.contexts,
                 checklist=excluded.checklist,
                 description=excluded.description,
                 textDirection=excluded.textDirection,
                 attachments=excluded.attachments,
                 location=excluded.location,
                 projectId=excluded.projectId,
                 sectionId=excluded.sectionId,
                 areaId=excluded.areaId,
                 orderNum=excluded.orderNum,
                 isFocusedToday=excluded.isFocusedToday,
                 timeEstimate=excluded.timeEstimate,
                 reviewAt=excluded.reviewAt,
                 completedAt=excluded.completedAt,
                 rev=excluded.rev,
                 revBy=excluded.revBy,
                 createdAt=excluded.createdAt,
                 updatedAt=excluded.updatedAt,
                 deletedAt=excluded.deletedAt,
                 purgedAt=excluded.purgedAt`,
            );

            await upsertBatch(
                'projects',
                [
                    'id',
                    'title',
                    'status',
                    'color',
                    'orderNum',
                    'tagIds',
                    'isSequential',
                    'isFocused',
                    'supportNotes',
                    'attachments',
                    'reviewAt',
                    'areaId',
                    'areaTitle',
                    'rev',
                    'revBy',
                    'createdAt',
                    'updatedAt',
                    'deletedAt',
                ],
                data.projects.map((project) => [
                    project.id,
                    project.title,
                    project.status,
                    project.color,
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
                    project.createdAt,
                    project.updatedAt,
                    project.deletedAt ?? null,
                ]),
                `title=excluded.title,
                 status=excluded.status,
                 color=excluded.color,
                 orderNum=excluded.orderNum,
                 tagIds=excluded.tagIds,
                 isSequential=excluded.isSequential,
                 isFocused=excluded.isFocused,
                 supportNotes=excluded.supportNotes,
                 attachments=excluded.attachments,
                 reviewAt=excluded.reviewAt,
                 areaId=excluded.areaId,
                 areaTitle=excluded.areaTitle,
                 rev=excluded.rev,
                 revBy=excluded.revBy,
                 createdAt=excluded.createdAt,
                 updatedAt=excluded.updatedAt,
                 deletedAt=excluded.deletedAt`,
            );

            await upsertBatch(
                'sections',
                [
                    'id',
                    'projectId',
                    'title',
                    'description',
                    'orderNum',
                    'isCollapsed',
                    'rev',
                    'revBy',
                    'createdAt',
                    'updatedAt',
                    'deletedAt',
                ],
                data.sections.map((section) => [
                    section.id,
                    section.projectId,
                    section.title,
                    section.description ?? null,
                    Number.isFinite(section.order) ? section.order : 0,
                    toBool(section.isCollapsed),
                    section.rev ?? null,
                    section.revBy ?? null,
                    section.createdAt,
                    section.updatedAt,
                    section.deletedAt ?? null,
                ]),
                `projectId=excluded.projectId,
                 title=excluded.title,
                 description=excluded.description,
                 orderNum=excluded.orderNum,
                 isCollapsed=excluded.isCollapsed,
                 rev=excluded.rev,
                 revBy=excluded.revBy,
                 createdAt=excluded.createdAt,
                 updatedAt=excluded.updatedAt,
                 deletedAt=excluded.deletedAt`,
            );

            await upsertBatch(
                'areas',
                [
                    'id',
                    'name',
                    'color',
                    'icon',
                    'orderNum',
                    'rev',
                    'revBy',
                    'createdAt',
                    'updatedAt',
                    'deletedAt',
                ],
                data.areas.map((area) => [
                    area.id,
                    area.name,
                    area.color ?? null,
                    area.icon ?? null,
                    area.order,
                    area.rev ?? null,
                    area.revBy ?? null,
                    area.createdAt ?? null,
                    area.updatedAt ?? null,
                    area.deletedAt ?? null,
                ]),
                `name=excluded.name,
                 color=excluded.color,
                 icon=excluded.icon,
                 orderNum=excluded.orderNum,
                 rev=excluded.rev,
                 revBy=excluded.revBy,
                 createdAt=excluded.createdAt,
                 updatedAt=excluded.updatedAt,
                 deletedAt=excluded.deletedAt`,
            );

            await this.client.run(
                'INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
                [toJson(data.settings ?? {})]
            );

            await this.client.run('COMMIT');
        } catch (error) {
            await this.client.run('ROLLBACK');
            throw error;
        }
    }
}
