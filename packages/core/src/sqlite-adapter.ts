import type { AppData, Area, Project, Task } from './types';
import type { TaskQueryOptions, SearchResults } from './storage';
import { SQLITE_SCHEMA } from './sqlite-schema';

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
        console.warn('[SQLite] Failed to parse JSON value, falling back to defaults.', error);
        return fallback;
    }
};

const toBool = (value?: boolean) => (value ? 1 : 0);
const fromBool = (value: unknown) => Boolean(value);

export class SqliteAdapter {
    private client: SqliteClient;

    constructor(client: SqliteClient) {
        this.client = client;
    }

    async ensureSchema() {
        if (this.client.exec) {
            await this.client.exec(SQLITE_SCHEMA);
        } else {
            await this.client.run(SQLITE_SCHEMA);
        }
        await this.ensureTaskPurgedAtColumn();
        await this.ensureTaskOrderColumn();
        await this.ensureProjectOrderColumn();
        await this.ensureFtsPopulated();
    }

    private async ensureTaskOrderColumn() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(tasks)');
        const hasOrder = columns.some((col) => col.name === 'orderNum');
        if (!hasOrder) {
            await this.client.run('ALTER TABLE tasks ADD COLUMN orderNum INTEGER');
        }
    }

    private async ensureTaskPurgedAtColumn() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(tasks)');
        const hasPurgedAt = columns.some((col) => col.name === 'purgedAt');
        if (!hasPurgedAt) {
            await this.client.run('ALTER TABLE tasks ADD COLUMN purgedAt TEXT');
        }
    }

    private async ensureProjectOrderColumn() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(projects)');
        const hasOrder = columns.some((col) => col.name === 'orderNum');
        if (!hasOrder) {
            await this.client.run('ALTER TABLE projects ADD COLUMN orderNum INTEGER');
        }
    }

    private async ensureFtsPopulated(forceRebuild = false) {
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
                (SELECT COUNT(*) FROM tasks WHERE id NOT IN (SELECT id FROM tasks_fts)) as task_missing,
                (SELECT COUNT(*) FROM tasks_fts WHERE id NOT IN (SELECT id FROM tasks)) as task_extra,
                (SELECT COUNT(*) FROM projects_fts) as project_count,
                (SELECT COUNT(*) FROM projects WHERE id NOT IN (SELECT id FROM projects_fts)) as project_missing,
                (SELECT COUNT(*) FROM projects_fts WHERE id NOT IN (SELECT id FROM projects)) as project_extra
            `
        );
        const taskCount = Number(counts?.task_count ?? 0);
        const taskMissing = Number(counts?.task_missing ?? 0);
        const taskExtra = Number(counts?.task_extra ?? 0);
        const needsTaskRebuild = forceRebuild || taskCount === 0 || taskMissing > 0 || taskExtra > 0;

        const projectCount = Number(counts?.project_count ?? 0);
        const projectMissing = Number(counts?.project_missing ?? 0);
        const projectExtra = Number(counts?.project_extra ?? 0);
        const needsProjectRebuild = forceRebuild || projectCount === 0 || projectMissing > 0 || projectExtra > 0;

        if (!needsTaskRebuild && !needsProjectRebuild) return;

        await this.client.run('BEGIN');
        try {
            if (needsTaskRebuild) {
                await this.client.run('DELETE FROM tasks_fts');
                await this.client.run(
                    `INSERT INTO tasks_fts (id, title, description, tags, contexts)
                     SELECT id, title, coalesce(description, ''), coalesce(tags, ''), coalesce(contexts, '') FROM tasks`
                );
            }
            if (needsProjectRebuild) {
                await this.client.run('DELETE FROM projects_fts');
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
    }

    private mapTaskRow(row: Record<string, unknown>): Task {
        return {
            id: String(row.id),
            title: String(row.title ?? ''),
            status: row.status as Task['status'],
            priority: row.priority as Task['priority'] | undefined,
            taskMode: row.taskMode as Task['taskMode'] | undefined,
            startTime: row.startTime as string | undefined,
            dueDate: row.dueDate as string | undefined,
            recurrence: fromJson<Task['recurrence']>(row.recurrence, undefined),
            pushCount: row.pushCount === null || row.pushCount === undefined ? undefined : Number(row.pushCount),
            tags: fromJson<string[]>(row.tags, []),
            contexts: fromJson<string[]>(row.contexts, []),
            checklist: fromJson<Task['checklist']>(row.checklist, undefined),
            description: row.description as string | undefined,
            attachments: fromJson<Task['attachments']>(row.attachments, undefined),
            location: row.location as string | undefined,
            projectId: row.projectId as string | undefined,
            orderNum: row.orderNum === null || row.orderNum === undefined ? undefined : Number(row.orderNum),
            isFocusedToday: fromBool(row.isFocusedToday),
            timeEstimate: row.timeEstimate as Task['timeEstimate'] | undefined,
            reviewAt: row.reviewAt as string | undefined,
            completedAt: row.completedAt as string | undefined,
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
            status: row.status as Project['status'],
            color: String(row.color ?? '#6B7280'),
            order: row.orderNum === null || row.orderNum === undefined ? 0 : Number(row.orderNum),
            tagIds: fromJson<string[]>(row.tagIds, []),
            isSequential: fromBool(row.isSequential),
            isFocused: fromBool(row.isFocused),
            supportNotes: row.supportNotes as string | undefined,
            attachments: fromJson<Project['attachments']>(row.attachments, undefined),
            reviewAt: row.reviewAt as string | undefined,
            areaId: row.areaId as string | undefined,
            areaTitle: row.areaTitle as string | undefined,
            createdAt: String(row.createdAt ?? ''),
            updatedAt: String(row.updatedAt ?? ''),
            deletedAt: row.deletedAt as string | undefined,
        };
    }

    async getData(): Promise<AppData> {
        await this.ensureSchema();
        const tasksRows = await this.client.all<Record<string, unknown>>('SELECT * FROM tasks');
        const projectsRows = await this.client.all<Record<string, unknown>>('SELECT * FROM projects');
        const areasRows = await this.client.all<Record<string, unknown>>('SELECT * FROM areas');
        const settingsRow = await this.client.get<Record<string, unknown>>('SELECT data FROM settings WHERE id = 1');

        const tasks: Task[] = tasksRows.map((row) => this.mapTaskRow(row));
        const projects: Project[] = projectsRows.map((row) => this.mapProjectRow(row));

        const areas: Area[] = areasRows.map((row) => ({
            id: String(row.id),
            name: String(row.name ?? ''),
            color: row.color as string | undefined,
            icon: row.icon as string | undefined,
            order: Number(row.orderNum ?? 0),
            createdAt: row.createdAt as string | undefined,
            updatedAt: row.updatedAt as string | undefined,
        }));

        const settings = settingsRow?.data ? fromJson<AppData['settings']>(settingsRow.data, {}) : {};

        return { tasks, projects, areas, settings };
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
        const cleaned = query
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
                console.warn('Search failed:', retryError);
                return { tasks: [], projects: [] };
            }
        }
    }

    async saveData(data: AppData): Promise<void> {
        await this.ensureSchema();
        await this.client.run('BEGIN IMMEDIATE');
        try {
            const syncIds = async (table: 'tasks' | 'projects' | 'areas', ids: string[]) => {
                const tempTable = `temp_${table}_ids`;
                try {
                    await this.client.run(`CREATE TEMP TABLE IF NOT EXISTS ${tempTable} (id TEXT PRIMARY KEY)`);
                    await this.client.run(`DELETE FROM ${tempTable}`);
                    for (const id of ids) {
                        await this.client.run(`INSERT OR IGNORE INTO ${tempTable} (id) VALUES (?)`, [id]);
                    }
                    await this.client.run(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${tempTable})`);
                } finally {
                    try {
                        await this.client.run(`DROP TABLE IF EXISTS ${tempTable}`);
                    } catch (dropError) {
                        console.warn(`Failed to drop temp table ${tempTable}`, dropError);
                    }
                }
            };

            await syncIds('tasks', data.tasks.map((task) => task.id));
            await syncIds('projects', data.projects.map((project) => project.id));
            await syncIds('areas', data.areas.map((area) => area.id));

            for (const task of data.tasks) {
                await this.client.run(
                    `INSERT INTO tasks (
                        id, title, status, priority, taskMode, startTime, dueDate, recurrence, pushCount,
                        tags, contexts, checklist, description, attachments, location, projectId, orderNum,
                        isFocusedToday, timeEstimate, reviewAt, completedAt, createdAt, updatedAt, deletedAt, purgedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title=excluded.title,
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
                        attachments=excluded.attachments,
                        location=excluded.location,
                        projectId=excluded.projectId,
                        orderNum=excluded.orderNum,
                        isFocusedToday=excluded.isFocusedToday,
                        timeEstimate=excluded.timeEstimate,
                        reviewAt=excluded.reviewAt,
                        completedAt=excluded.completedAt,
                        createdAt=excluded.createdAt,
                        updatedAt=excluded.updatedAt,
                        deletedAt=excluded.deletedAt,
                        purgedAt=excluded.purgedAt`,
                    [
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
                        toJson(task.attachments),
                        task.location ?? null,
                        task.projectId ?? null,
                        task.orderNum ?? null,
                        toBool(task.isFocusedToday),
                        task.timeEstimate ?? null,
                        task.reviewAt ?? null,
                        task.completedAt ?? null,
                        task.createdAt,
                        task.updatedAt,
                        task.deletedAt ?? null,
                        task.purgedAt ?? null,
                    ]
                );
            }

            for (const project of data.projects) {
                await this.client.run(
                    `INSERT INTO projects (
                        id, title, status, color, orderNum, tagIds, isSequential, isFocused, supportNotes, attachments,
                        reviewAt, areaId, areaTitle, createdAt, updatedAt, deletedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title=excluded.title,
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
                        createdAt=excluded.createdAt,
                        updatedAt=excluded.updatedAt,
                        deletedAt=excluded.deletedAt`,
                    [
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
                        project.createdAt,
                        project.updatedAt,
                        project.deletedAt ?? null,
                    ]
                );
            }

            for (const area of data.areas) {
                await this.client.run(
                    `INSERT INTO areas (
                        id, name, color, icon, orderNum, createdAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        name=excluded.name,
                        color=excluded.color,
                        icon=excluded.icon,
                        orderNum=excluded.orderNum,
                        createdAt=excluded.createdAt,
                        updatedAt=excluded.updatedAt`,
                    [
                        area.id,
                        area.name,
                        area.color ?? null,
                        area.icon ?? null,
                        area.order,
                        area.createdAt ?? null,
                        area.updatedAt ?? null,
                    ]
                );
            }

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
