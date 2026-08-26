import type { AppData, Area, Person, Project, SavedFilter, Task, Section } from './types';

export type CalendarSyncEntry = {
    taskId: string;
    calendarEventId: string;
    calendarId: string;
    platform: string;
    lastSyncedAt: string;
};
import { SEARCH_RESULT_LIMIT, type SearchProjectResult, type SearchResults, type SearchTaskResult, type TaskQueryOptions } from './storage';
import { buildTaskWhere } from './task-query';
import { FTS_MAINTENANCE_TRIGGERS, SQLITE_BASE_SCHEMA, SQLITE_FTS_SCHEMA, SQLITE_INDEX_SCHEMA } from './sqlite-schema';
import { normalizeTaskStatus } from './task-status';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeRelativeStartOffset } from './task-relative-start';
import { logWarn } from './logger';
import { normalizeSavedFilter, normalizeSavedFilters } from './saved-filters';
import { sleep } from './async-utils';
import { TASK_SQLITE_COLUMNS, TASK_SQLITE_MIGRATION_COLUMNS, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';
import {
    normalizeProjectStatus,
    PROJECT_SQLITE_COLUMNS,
    PROJECT_SQLITE_MIGRATION_COLUMNS,
    projectFromSqliteRow,
    projectToSqliteRow,
} from './project-sync-schema';
import { SECTION_SQLITE_COLUMNS, SECTION_SQLITE_MIGRATION_COLUMNS, sectionFromSqliteRow, sectionToSqliteRow } from './section-sync-schema';
import { AREA_SQLITE_COLUMNS, AREA_SQLITE_MIGRATION_COLUMNS, areaFromSqliteRow, areaToSqliteRow } from './area-sync-schema';
import { PERSON_SQLITE_COLUMNS, PERSON_SQLITE_MIGRATION_COLUMNS, personFromSqliteRow, personToSqliteRow } from './person-sync-schema';
import { fromJson, toJson, toStringArray } from './entity-sync-schema';

export interface SqliteClient {
    run(sql: string, params?: unknown[]): Promise<void>;
    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
    exec?(sql: string): Promise<void>;
}

const SQL_WORD_CHAR = /[A-Za-z0-9_]/;

// Splits a multi-statement SQL script for engines whose execute() prepares a
// single statement at a time (op-sqlite). A naive split on ';' breaks
// CREATE TRIGGER bodies apart ("incomplete input"), so track quoted strings,
// comments, and BEGIN/CASE...END blocks and only split at top-level ';'.
export const splitSqlStatements = (sql: string): string[] => {
    const statements: string[] = [];
    let current = '';
    let blockDepth = 0;
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (ch === "'" || ch === '"') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === ch) {
                    if (sql[j + 1] === ch) {
                        j += 2;
                        continue;
                    }
                    j += 1;
                    break;
                }
                j += 1;
            }
            current += sql.slice(i, j);
            i = j;
            continue;
        }
        if (ch === '-' && next === '-') {
            let j = sql.indexOf('\n', i);
            if (j === -1) j = sql.length;
            current += sql.slice(i, j);
            i = j;
            continue;
        }
        if (ch === '/' && next === '*') {
            let j = sql.indexOf('*/', i + 2);
            j = j === -1 ? sql.length : j + 2;
            current += sql.slice(i, j);
            i = j;
            continue;
        }
        if (SQL_WORD_CHAR.test(ch)) {
            let j = i + 1;
            while (j < sql.length && SQL_WORD_CHAR.test(sql[j])) j += 1;
            const word = sql.slice(i, j).toUpperCase();
            // A statement-leading BEGIN is transaction control and terminates at
            // its own ';'. Mid-statement BEGIN (trigger body) opens a block.
            if (word === 'CASE' || (word === 'BEGIN' && current.trim() !== '')) {
                blockDepth += 1;
            } else if (word === 'END') {
                blockDepth = Math.max(0, blockDepth - 1);
            }
            current += sql.slice(i, j);
            i = j;
            continue;
        }
        if (ch === ';' && blockDepth === 0) {
            const statement = current.trim();
            if (statement) statements.push(statement);
            current = '';
            blockDepth = 0;
            i += 1;
            continue;
        }
        current += ch;
        i += 1;
    }
    const tail = current.trim();
    if (tail) statements.push(tail);
    return statements;
};

type SqliteReferenceIssue = {
    kind: string;
    id: string;
    missingId: string;
};

const optionalId = (value: unknown): string | undefined => (
    typeof value === 'string' && value.trim().length > 0 ? value : undefined
);

const collectSqliteReferenceIssues = (data: AppData): SqliteReferenceIssue[] => {
    const areaIds = new Set(data.areas.map((area) => area.id));
    const projectIds = new Set(data.projects.map((project) => project.id));
    const sectionIds = new Set(data.sections.map((section) => section.id));
    const issues: SqliteReferenceIssue[] = [];
    const addIssue = (kind: string, id: string, missingId: string) => {
        issues.push({ kind, id, missingId });
    };

    data.projects.forEach((project) => {
        const areaId = optionalId(project.areaId);
        if (areaId && !areaIds.has(areaId)) {
            addIssue('project.areaId', project.id, areaId);
        }
    });
    data.sections.forEach((section) => {
        const projectId = optionalId(section.projectId);
        if (projectId && !projectIds.has(projectId)) {
            addIssue('section.projectId', section.id, projectId);
        }
    });
    data.tasks.forEach((task) => {
        const projectId = optionalId(task.projectId);
        if (projectId && !projectIds.has(projectId)) {
            addIssue('task.projectId', task.id, projectId);
        }
        const sectionId = optionalId(task.sectionId);
        if (sectionId && !sectionIds.has(sectionId)) {
            addIssue('task.sectionId', task.id, sectionId);
        }
        const areaId = optionalId(task.areaId);
        if (areaId && !areaIds.has(areaId)) {
            addIssue('task.areaId', task.id, areaId);
        }
    });

    return issues;
};

const buildSqliteSaveFailureContext = (data: AppData, step: string): Record<string, unknown> => {
    const referenceIssues = collectSqliteReferenceIssues(data);
    return {
        step,
        tasks: data.tasks.length,
        projects: data.projects.length,
        sections: data.sections.length,
        areas: data.areas.length,
        people: Array.isArray(data.people) ? data.people.length : 0,
        taskAttachments: data.tasks.reduce((count, task) => count + (task.attachments?.length ?? 0), 0),
        projectAttachments: data.projects.reduce((count, project) => count + (project.attachments?.length ?? 0), 0),
        referenceIssues: referenceIssues.length,
        referenceIssueSamples: referenceIssues.slice(0, 8),
    };
};

// TASK_SQLITE_COLUMNS and TASK_SQLITE_MIGRATION_COLUMNS are generated from
// TASK_SYNC_FIELD_SCHEMA in task-sync-schema.ts (see the comment there for why the
// derivation itself lives in that dependency-free file rather than here). Re-exported here
// under their existing names/values for this module's existing consumers
// (index.ts, apps/mcp-server/src/queries.ts).
export { TASK_SQLITE_COLUMNS, TASK_SQLITE_MIGRATION_COLUMNS };
// Same generation story as tasks (see the comment above), for projects and sections.
export { PROJECT_SQLITE_COLUMNS, PROJECT_SQLITE_MIGRATION_COLUMNS };
export { SECTION_SQLITE_COLUMNS, SECTION_SQLITE_MIGRATION_COLUMNS };
// Same generation story, for areas and people (area-sync-schema.ts / person-sync-schema.ts).
export { AREA_SQLITE_COLUMNS, AREA_SQLITE_MIGRATION_COLUMNS };
export { PERSON_SQLITE_COLUMNS, PERSON_SQLITE_MIGRATION_COLUMNS };

const TASK_UPSERT_COLUMNS = TASK_SQLITE_COLUMNS;

// `id` is the upsert conflict target, so it's excluded from the SET clause.
export const TASK_UPSERT_UPDATE_CLAUSE = `${TASK_SQLITE_COLUMNS
    .filter((column) => column !== 'id')
    .map((column) => `${column}=excluded.${column}`)
    .join(',\n')}
WHERE tasks.rev IS NULL OR tasks.rev <= excluded.rev`;

const PROJECT_UPSERT_COLUMNS = PROJECT_SQLITE_COLUMNS;
export const PROJECT_UPSERT_UPDATE_CLAUSE = `${PROJECT_SQLITE_COLUMNS
    .filter((column) => column !== 'id')
    .map((column) => `${column}=excluded.${column}`)
    .join(',\n')}
WHERE projects.rev IS NULL OR projects.rev <= excluded.rev`;

const SECTION_UPSERT_COLUMNS = SECTION_SQLITE_COLUMNS;
export const SECTION_UPSERT_UPDATE_CLAUSE = `${SECTION_SQLITE_COLUMNS
    .filter((column) => column !== 'id')
    .map((column) => `${column}=excluded.${column}`)
    .join(',\n')}
WHERE sections.rev IS NULL OR sections.rev <= excluded.rev`;

const AREA_UPSERT_COLUMNS = AREA_SQLITE_COLUMNS;
export const AREA_UPSERT_UPDATE_CLAUSE = `${AREA_SQLITE_COLUMNS
    .filter((column) => column !== 'id')
    .map((column) => `${column}=excluded.${column}`)
    .join(',\n')}
WHERE areas.rev IS NULL OR areas.rev <= excluded.rev`;

const PERSON_UPSERT_COLUMNS = PERSON_SQLITE_COLUMNS;
export const PERSON_UPSERT_UPDATE_CLAUSE = `${PERSON_SQLITE_COLUMNS
    .filter((column) => column !== 'id')
    .map((column) => `${column}=excluded.${column}`)
    .join(',\n')}
WHERE people.rev IS NULL OR people.rev <= excluded.rev`;

// taskToSqliteRow is now generated from TASK_SYNC_FIELD_SCHEMA (task-sync-schema.ts) — see the
// comment there. Re-exported under its existing name for this module's existing consumers.
export { taskToSqliteRow };

// Serialized row + fingerprint cache keyed by task object identity. Store and
// sync updates are immutable — a changed task is a new object — and
// taskToSqliteRow is pure, so an unchanged object always serializes to the
// same row. The attachment transfer lifecycle (attachment-transfer.ts) upholds
// this by never mutating in place: it returns patches that applyAttachmentPatches
// folds into fresh owner objects, so only genuinely changed rows re-serialize.
// This turns the per-save serialization/fingerprint pass over every
// task into a lookup for unchanged rows, which dominated saveData time on
// large mobile libraries (#766).
type TaskRowEntry = { row: unknown[]; fingerprint: string };
const taskRowEntryCache = new WeakMap<Task, TaskRowEntry>();
const getTaskRowEntry = (task: Task): TaskRowEntry => {
    const cached = taskRowEntryCache.get(task);
    if (cached) return cached;
    const row = taskToSqliteRow(task);
    const entry: TaskRowEntry = { row, fingerprint: JSON.stringify(row) };
    taskRowEntryCache.set(task, entry);
    return entry;
};

const isFts5SyntaxError = (error: unknown): boolean => (
    error instanceof Error && /fts5: syntax error/i.test(error.message)
);

const READ_PAGE_SIZE = 1000;
const FTS_LOCK_TTL_MS = 5 * 60 * 1000;
const FTS_LOCK_REFRESH_INTERVAL_MS = Math.max(15_000, Math.floor(FTS_LOCK_TTL_MS / 3));
// Bump when the indexed projection changes so existing content is rebuilt once.
const FTS_TRIGGER_MIGRATION_VERSION = 3;
const SQLITE_ROW_VERSION_INSERT_BATCH_SIZE = 200;
const SEARCH_TASK_SELECT = [
    't.id AS id',
    't.title AS title',
    't.status AS status',
    't.startTime AS startTime',
    't.dueDate AS dueDate',
    't.projectId AS projectId',
    't.areaId AS areaId',
    't.tags AS tags',
    't.contexts AS contexts',
    't.location AS location',
].join(', ');
const SEARCH_PROJECT_SELECT = [
    'p.id AS id',
    'p.title AS title',
    'p.status AS status',
    'p.areaId AS areaId',
].join(', ');

let tempIdTableCounter = 0;

type SqliteEntityTable = 'tasks' | 'projects' | 'sections' | 'areas' | 'people' | 'saved_filters';

type SqliteKnownRowVersion = {
    rowId: number | null;
    rev: number | null;
    updatedAt: string | null;
};

const createTempIdTableName = (table: SqliteEntityTable): string => {
    tempIdTableCounter = (tempIdTableCounter + 1) % Number.MAX_SAFE_INTEGER;
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 10) || '0';
    return `temp_${table}_ids_${timestamp}_${tempIdTableCounter.toString(36)}_${random}`;
};

// mapSqliteTaskRow layers the three normalizers taskFromSqliteRow (task-sync-schema.ts) can't
// perform itself — normalizeTaskStatus, normalizeRecurrenceForLoad, and
// normalizeRelativeStartOffset all transitively import date-fns, which task-sync-schema.ts may
// not depend on (see the zero-dependency comment there). Every other field comes back from
// taskFromSqliteRow unchanged, so this produces byte-for-byte the same Task the previous
// hand-written mapSqliteTaskRow did.
export function mapSqliteTaskRow(row: Record<string, unknown>): Task {
    const base = taskFromSqliteRow(row);
    return {
        ...base,
        status: normalizeTaskStatus(row.status),
        recurrence: normalizeRecurrenceForLoad(base.recurrence),
        relativeStartOffset: normalizeRelativeStartOffset(base.relativeStartOffset),
    };
}

/**
 * Emitted when an incremental save rewrites a suspiciously large share of a
 * table — the fingerprint of a sync-rewrite loop (#766). Names the columns
 * that actually differed on a small sample, so a user log can identify the
 * oscillating field (the rc.2 loop would have shown `changedColumns:
 * ["pushCount"]`, `purgedChangedRows` ≈ all) without a repro environment.
 */
export type SqliteRewriteDiagnostic = {
    table: string;
    changedRows: number;
    tableRows: number;
    /** Rows in the changed set whose purgedAt column is set (tombstones). */
    purgedChangedRows?: number;
    /** Union of differing column names across the sampled changed rows. */
    changedColumns: string[];
    sampleSize: number;
};

const REWRITE_DIAGNOSTIC_MIN_ROWS = 100;
const REWRITE_DIAGNOSTIC_MIN_SHARE = 0.05;
const REWRITE_DIAGNOSTIC_SAMPLE = 3;

export type SqliteSaveDataStats = {
    incremental: boolean;
    writtenRows: number;
    removedRows: number;
    totalRows: number;
    settingsWritten: boolean;
    /** Present only when a table tripped the large-rewrite threshold. */
    rewriteDiagnostics?: SqliteRewriteDiagnostic[];
    /** Await time spent on BEGIN IMMEDIATE (long values point at writer-lock contention). */
    beginMs: number;
    /** Await time spent on COMMIT (long values point at fsync/checkpoint cost). */
    commitMs: number;
    /** Total await time across all SQL statements in this save, including begin/commit. */
    sqlMs: number;
    /** Number of SQL statements executed (per-statement average separates bridge latency from statement volume). */
    sqlCount: number;
};

export type SqliteAdapterOptions = {
    /**
     * Reject a write when another connection changed the snapshot since getData().
     * Long-lived app processes normally merge concurrent state above this layer;
     * short-lived automation clients use this guard so retry can reload first.
     */
    rejectConcurrentWrites?: boolean;
};

export class SqliteAdapter {
    private client: SqliteClient;
    private rejectConcurrentWrites: boolean;
    private schemaReadyPromise: Promise<void> | null = null;
    // Fingerprints of rows submitted by this adapter's last committed save.
    // Revision-guarded upserts make it safe for another process to advance a row;
    // this cache is nulled whenever a transaction fails, and only repopulated
    // after a successful COMMIT.
    private lastSavedFingerprints: { tables: Map<string, Map<string, string>>; settingsJson: string | null } | null = null;
    // Rows this adapter has actually observed or successfully written. Snapshot
    // omission may physically delete only one of these rows, and only while its
    // database version still matches. This keeps a stale full snapshot from
    // deleting rows added or advanced by another process between read and save.
    private lastKnownRowVersions: Map<SqliteEntityTable, Map<string, SqliteKnownRowVersion>> | null = null;
    // PRAGMA data_version is a connection-local epoch that advances when another
    // connection commits. It gives guarded automation writes an O(1) stale-read
    // check without scanning every persisted row under BEGIN IMMEDIATE.
    private lastObservedExternalChangeEpoch: number | undefined;
    private lastSaveDataStats: SqliteSaveDataStats | null = null;

    constructor(client: SqliteClient, options: SqliteAdapterOptions = {}) {
        this.client = client;
        this.rejectConcurrentWrites = options.rejectConcurrentWrites === true;
    }

    private async loadAllRows(table: 'tasks' | 'projects' | 'sections' | 'areas' | 'people'): Promise<Record<string, unknown>[]> {
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
                    if (typeof row._rowid === 'number') {
                        lastRowId = row._rowid;
                    }
                    rows.push(row);
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
            const page = await this.client.all<Record<string, unknown> & { _rowid: number }>(
                `SELECT rowid as _rowid, * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`,
                [READ_PAGE_SIZE, offset]
            );
            rows.push(...page);
            if (page.length < READ_PAGE_SIZE) break;
            offset += READ_PAGE_SIZE;
        }
        return rows;
    }

    private knownRowVersionsFromRows(rows: Record<string, unknown>[]): Map<string, SqliteKnownRowVersion> {
        const versions = new Map<string, SqliteKnownRowVersion>();
        for (const row of rows) {
            const rawRev = row.rev;
            const parsedRev = rawRev === null || rawRev === undefined ? null : Number(rawRev);
            versions.set(String(row.id), {
                rowId: typeof row._rowid === 'number' ? row._rowid : null,
                rev: parsedRev !== null && Number.isFinite(parsedRev) ? parsedRev : null,
                updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
            });
        }
        return versions;
    }

    private async readExternalChangeEpoch(): Promise<number> {
        const row = await this.client.get<Record<string, unknown>>('PRAGMA data_version');
        const rawValue = row?.data_version ?? (row ? Object.values(row)[0] : undefined);
        const epoch = Number(rawValue);
        if (!Number.isFinite(epoch)) {
            throw new Error('SQLite did not return a valid PRAGMA data_version value');
        }
        return epoch;
    }

    private concurrentWriteError(detail: string): Error {
        return new Error(`SQLITE_BUSY: database changed after the automation snapshot was loaded (${detail})`);
    }

    private async assertObservedSnapshotUnchanged(): Promise<void> {
        if (!this.rejectConcurrentWrites) return;
        if (!this.lastKnownRowVersions || this.lastObservedExternalChangeEpoch === undefined) {
            throw this.concurrentWriteError('no read baseline');
        }
        const currentEpoch = await this.readExternalChangeEpoch();
        if (currentEpoch !== this.lastObservedExternalChangeEpoch) {
            throw this.concurrentWriteError('external commit');
        }
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

    private async refreshFtsLock(owner: string): Promise<void> {
        await this.client.run('UPDATE fts_lock SET acquiredAt = ? WHERE id = 1 AND owner = ?', [Date.now(), owner]);
    }

    private startFtsLockHeartbeat(owner: string): ReturnType<typeof setInterval> {
        const timer = setInterval(() => {
            void this.refreshFtsLock(owner).catch((error) => {
                logWarn('Failed to refresh FTS rebuild lock', {
                    scope: 'sqlite',
                    category: 'fts',
                    error,
                });
            });
        }, FTS_LOCK_REFRESH_INTERVAL_MS);
        const unref = (timer as { unref?: () => void }).unref;
        if (typeof unref === 'function') {
            unref.call(timer);
        }
        return timer;
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
        await this.ensurePeopleTable();
        await this.ensureSavedFilterTable();
        if (this.client.exec) {
            await this.client.exec(SQLITE_FTS_SCHEMA);
            await this.client.exec(SQLITE_INDEX_SCHEMA);
        } else {
            await this.client.run(SQLITE_FTS_SCHEMA);
            await this.client.run(SQLITE_INDEX_SCHEMA);
        }
        // FTS operations are optional - don't block startup if they fail
        try {
            const schemaChanged = await this.ensureFtsSchema();
            const triggersChanged = await this.ensureFtsTriggers(schemaChanged);
            await this.ensureFtsPopulated(schemaChanged || triggersChanged);
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

    private async ensureFtsSchema(): Promise<boolean> {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(tasks_fts)');
        const hasChecklist = columns.some((column) => column.name === 'checklist');
        const hasAssignedTo = columns.some((column) => column.name === 'assignedTo');
        if (hasChecklist && hasAssignedTo) return false;

        // These DROPs run outside ensureFtsTriggers' BEGIN IMMEDIATE (deliberately —
        // widening that transaction to cover this DROP TABLE is a bigger change than
        // this method warrants), so a crash or SQLITE_BUSY here can leave the task
        // triggers gone. That's fine: ensureSchemaInternal always calls
        // ensureFtsTriggers(schemaChanged) right after this returns true, and
        // ensureFtsTriggers now verifies each trigger against sqlite_master before
        // trusting the migration marker — restoration is guaranteed by that check,
        // not by hoping this ran back-to-back with SQLITE_FTS_SCHEMA's blanket
        // CREATE TRIGGER IF NOT EXISTS re-exec on the next launch.
        await this.client.run('DROP TRIGGER IF EXISTS tasks_ai');
        await this.client.run('DROP TRIGGER IF EXISTS tasks_ad');
        await this.client.run('DROP TRIGGER IF EXISTS tasks_au');
        await this.client.run('DROP TABLE IF EXISTS tasks_fts');
        await this.client.run(`
            CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
              id UNINDEXED,
              title,
              description,
              tags,
              contexts,
              checklist,
              location,
              assignedTo,
              content=''
            )
        `);
        return true;
    }

    /** Trigger names from FTS_MAINTENANCE_TRIGGERS actually present in sqlite_master. */
    private async getExistingFtsTriggerNames(): Promise<Set<string>> {
        const names = FTS_MAINTENANCE_TRIGGERS.map((trigger) => trigger.name);
        const placeholders = names.map(() => '?').join(', ');
        const rows = await this.client.all<{ name?: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${placeholders})`,
            names
        );
        return new Set(rows.map((row) => row.name).filter((name): name is string => Boolean(name)));
    }

    private async ensureFtsTriggers(force = false): Promise<boolean> {
        if (!force) {
            const hasCurrentTriggers = await this.client.get<{ applied?: number }>(
                'SELECT 1 as applied FROM schema_migrations WHERE version = ? LIMIT 1',
                [FTS_TRIGGER_MIGRATION_VERSION]
            );
            if (hasCurrentTriggers?.applied === 1) {
                // Don't trust the marker alone: a mid-migration SQLITE_BUSY from a
                // concurrent MCP/CLI writer could leave triggers missing while
                // schema_migrations still records this version as applied. Verify
                // against sqlite_master and force a re-migration if anything is gone.
                const existingTriggers = await this.getExistingFtsTriggerNames();
                const allTriggersPresent = FTS_MAINTENANCE_TRIGGERS.every(
                    (trigger) => existingTriggers.has(trigger.name)
                );
                if (allTriggersPresent) return false;
                force = true;
            }
        }

        try {
            // DDL is transactional in SQLite. BEGIN IMMEDIATE keeps another app/MCP
            // writer from changing rows while the maintenance triggers are absent.
            await this.client.run('BEGIN IMMEDIATE');
            try {
                const alreadyMigrated = await this.client.get<{ applied?: number }>(
                    'SELECT 1 as applied FROM schema_migrations WHERE version = ? LIMIT 1',
                    [FTS_TRIGGER_MIGRATION_VERSION]
                );
                if (!force && alreadyMigrated?.applied === 1) {
                    await this.client.run('COMMIT');
                    return false;
                }

                for (const trigger of FTS_MAINTENANCE_TRIGGERS) {
                    await this.client.run(`DROP TRIGGER IF EXISTS ${trigger.name}`);
                }
                for (const trigger of FTS_MAINTENANCE_TRIGGERS) {
                    await this.client.run(trigger.sql);
                }

                await this.client.run(
                    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
                    [FTS_TRIGGER_MIGRATION_VERSION]
                );
                await this.client.run('COMMIT');
                return true;
            } catch (error) {
                await this.client.run('ROLLBACK');
                throw error;
            }
        } catch (error) {
            logWarn('Failed to migrate FTS triggers', {
                scope: 'sqlite',
                category: 'fts',
                error,
            });
            // Continue without migrating - triggers may still work or will fail gracefully
            return false;
        }
    }

    private async ensureTaskColumns() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(tasks)');
        const names = new Set(columns.map((col) => col.name));
        const definitions = TASK_SQLITE_MIGRATION_COLUMNS;
        for (const definition of definitions) {
            if (!names.has(definition.name)) {
                await this.client.run(definition.sql);
            }
        }
        const taskIndexes = [
            'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_projectId ON tasks(projectId)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_deletedAt ON tasks(deletedAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_dueDate ON tasks(dueDate)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_startTime ON tasks(startTime)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_reviewAt ON tasks(reviewAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_completedAt ON tasks(completedAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_createdAt ON tasks(createdAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_updatedAt ON tasks(updatedAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_updatedAt_rev ON tasks(updatedAt, rev)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_updatedAt_deletedAt ON tasks(updatedAt, deletedAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_status_deletedAt ON tasks(status, deletedAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_project_deletedAt ON tasks(projectId, deletedAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_project_status_deletedAt ON tasks(projectId, status, deletedAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_project_status_updatedAt ON tasks(projectId, status, updatedAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_projectId_orderNum ON tasks(projectId, orderNum)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_area_deletedAt ON tasks(areaId, deletedAt)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_area_id ON tasks(areaId)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_section_id ON tasks(sectionId)',
        ];
        for (const sql of taskIndexes) {
            await this.client.run(sql);
        }
    }

    private async ensureProjectColumns() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(projects)');
        const names = new Set(columns.map((col) => col.name));
        const definitions = PROJECT_SQLITE_MIGRATION_COLUMNS;
        for (const definition of definitions) {
            if (!names.has(definition.name)) {
                await this.client.run(definition.sql);
            }
        }
        await this.client.run(
            'CREATE INDEX IF NOT EXISTS idx_projects_area_deletedAt ON projects(areaId, deletedAt)'
        );
        await this.client.run(
            'CREATE INDEX IF NOT EXISTS idx_projects_area_order ON projects(areaId, orderNum)'
        );
        await this.client.run(
            'CREATE INDEX IF NOT EXISTS idx_projects_dueDate ON projects(dueDate)'
        );
        await this.client.run(
            'CREATE INDEX IF NOT EXISTS idx_projects_updatedAt_rev ON projects(updatedAt, rev)'
        );
    }

    private async ensureSectionColumns() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(sections)');
        const names = new Set(columns.map((col) => col.name));
        const definitions = SECTION_SQLITE_MIGRATION_COLUMNS;
        for (const definition of definitions) {
            if (!names.has(definition.name)) {
                await this.client.run(definition.sql);
            }
        }
        await this.client.run(
            'CREATE INDEX IF NOT EXISTS idx_sections_project_deletedAt ON sections(projectId, deletedAt)'
        );
        await this.client.run(
            'CREATE INDEX IF NOT EXISTS idx_sections_updatedAt_rev ON sections(updatedAt, rev)'
        );
    }

    private async ensureAreaColumns() {
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(areas)');
        const names = new Set(columns.map((col) => col.name));
        const definitions = AREA_SQLITE_MIGRATION_COLUMNS;
        for (const definition of definitions) {
            if (!names.has(definition.name)) {
                await this.client.run(definition.sql);
            }
        }
        await this.client.run(
            'CREATE INDEX IF NOT EXISTS idx_areas_updatedAt_rev ON areas(updatedAt, rev)'
        );
    }

    private async ensurePeopleTable() {
        await this.client.run(`
            CREATE TABLE IF NOT EXISTS people (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              note TEXT,
              referenceLink TEXT,
              rev INTEGER,
              revBy TEXT,
              createdAt TEXT NOT NULL,
              updatedAt TEXT NOT NULL,
              deletedAt TEXT
            )
        `);
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(people)');
        const names = new Set(columns.map((col) => col.name));
        const definitions = PERSON_SQLITE_MIGRATION_COLUMNS;
        for (const definition of definitions) {
            if (!names.has(definition.name)) {
                await this.client.run(definition.sql);
            }
        }
        await this.client.run('CREATE INDEX IF NOT EXISTS idx_people_updatedAt_rev ON people(updatedAt, rev)');
    }

    private async ensureSavedFilterTable() {
        await this.client.run(`
            CREATE TABLE IF NOT EXISTS saved_filters (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              icon TEXT,
              view TEXT NOT NULL,
              criteria TEXT NOT NULL,
              sortBy TEXT,
              sortOrder TEXT,
              groupBy TEXT,
              createdAt TEXT NOT NULL,
              updatedAt TEXT NOT NULL,
              deletedAt TEXT
            )
        `);
        const columns = await this.client.all<{ name?: string }>('PRAGMA table_info(saved_filters)');
        const columnNames = new Set(columns.map((column) => column.name));
        if (!columnNames.has('groupBy')) {
            await this.client.run('ALTER TABLE saved_filters ADD COLUMN groupBy TEXT');
        }
        if (!columnNames.has('deletedAt')) {
            await this.client.run('ALTER TABLE saved_filters ADD COLUMN deletedAt TEXT');
        }
        await this.client.run('CREATE INDEX IF NOT EXISTS idx_saved_filters_view ON saved_filters(view)');
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
                    (SELECT COUNT(*) FROM (SELECT rowid FROM tasks EXCEPT SELECT rowid FROM tasks_fts)) as task_missing,
                    (SELECT COUNT(*) FROM (SELECT rowid FROM tasks_fts EXCEPT SELECT rowid FROM tasks)) as task_extra,
                    (SELECT COUNT(*) FROM projects_fts) as project_count,
                    (SELECT COUNT(*) FROM (SELECT rowid FROM projects EXCEPT SELECT rowid FROM projects_fts)) as project_missing,
                    (SELECT COUNT(*) FROM (SELECT rowid FROM projects_fts EXCEPT SELECT rowid FROM projects)) as project_extra
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

            const lockHeartbeat = this.startFtsLockHeartbeat(lockOwner);
            try {
                await this.client.run('BEGIN');
                try {
                    if (needsTaskRebuild) {
                        // Use FTS5 delete-all command for contentless tables (content='')
                        await this.client.run("INSERT INTO tasks_fts(tasks_fts) VALUES('delete-all')");
                        await this.client.run(
                            `INSERT INTO tasks_fts (rowid, title, description, tags, contexts, checklist, location, assignedTo)
                             SELECT rowid, title, coalesce(description, ''), coalesce(tags, ''), coalesce(contexts, ''), coalesce((SELECT group_concat(json_extract(value, '$.title'), ' ') FROM json_each(tasks.checklist)), ''), coalesce(location, ''), coalesce(assignedTo, '') FROM tasks`
                        );
                    }
                    if (needsProjectRebuild) {
                        // Use FTS5 delete-all command for contentless tables (content='')
                        await this.client.run("INSERT INTO projects_fts(projects_fts) VALUES('delete-all')");
                        await this.client.run(
                            `INSERT INTO projects_fts (rowid, title, supportNotes, tagIds, areaTitle)
                             SELECT rowid, title, coalesce(supportNotes, ''), coalesce(tagIds, ''), coalesce(areaTitle, '') FROM projects`
                        );
                    }
                    await this.client.run('COMMIT');
                } catch (error) {
                    await this.client.run('ROLLBACK');
                    throw error;
                }
            } finally {
                clearInterval(lockHeartbeat);
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
        return mapSqliteTaskRow(row);
    }

    private mapSearchTaskRow(row: Record<string, unknown>): SearchTaskResult {
        return {
            id: String(row.id),
            title: String(row.title ?? ''),
            status: normalizeTaskStatus(row.status),
            startTime: row.startTime as string | undefined,
            dueDate: row.dueDate as string | undefined,
            projectId: row.projectId as string | undefined,
            areaId: row.areaId as string | undefined,
            tags: toStringArray(fromJson<unknown>(row.tags, [])),
            contexts: toStringArray(fromJson<unknown>(row.contexts, [])),
            location: row.location as string | undefined,
        };
    }

    private mapSearchProjectRow(row: Record<string, unknown>): SearchProjectResult {
        return {
            id: String(row.id),
            title: String(row.title ?? ''),
            status: normalizeProjectStatus(row.status),
            areaId: row.areaId as string | undefined,
        };
    }

    private mapSavedFilterRow(row: Record<string, unknown>): SavedFilter | null {
        return normalizeSavedFilter({
            id: row.id,
            name: row.name,
            icon: row.icon,
            view: row.view,
            criteria: fromJson<unknown>(row.criteria, {}),
            sortBy: row.sortBy,
            sortOrder: row.sortOrder,
            groupBy: row.groupBy,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
        });
    }

    async getData(): Promise<AppData> {
        await this.ensureSchema();
        const loadSnapshotRows = () => Promise.all([
            this.loadAllRows('tasks'),
            this.loadAllRows('projects'),
            this.loadAllRows('sections'),
            this.loadAllRows('areas'),
            this.loadAllRows('people'),
            this.client.get<Record<string, unknown>>('SELECT data FROM settings WHERE id = 1'),
            this.client.all<Record<string, unknown>>('SELECT rowid as _rowid, * FROM saved_filters ORDER BY createdAt, name'),
        ]);
        let snapshotRows: Awaited<ReturnType<typeof loadSnapshotRows>> | null = null;
        if (this.rejectConcurrentWrites) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const beforeEpoch = await this.readExternalChangeEpoch();
                const candidateRows = await loadSnapshotRows();
                const afterEpoch = await this.readExternalChangeEpoch();
                if (beforeEpoch === afterEpoch) {
                    snapshotRows = candidateRows;
                    this.lastObservedExternalChangeEpoch = afterEpoch;
                    break;
                }
            }
            if (!snapshotRows) {
                throw this.concurrentWriteError('database changed while loading');
            }
        } else {
            snapshotRows = await loadSnapshotRows();
        }
        const [tasksRows, projectsRows, sectionsRows, areasRows, peopleRows, settingsRow, savedFilterRows] = snapshotRows;

        const tasks: Task[] = tasksRows.map((row) => this.mapTaskRow(row));
        const projects: Project[] = projectsRows.map((row) => projectFromSqliteRow(row));
        const sections: Section[] = sectionsRows.map((row) => sectionFromSqliteRow(row));
        const nowIso = new Date().toISOString();

        // areaFromSqliteRow/personFromSqliteRow share one nowIso per read, matching the
        // original inline mapping's behaviour (every area/person in this read falls back to
        // the same timestamp, not a fresh one per row).
        const areas: Area[] = areasRows.map((row) => areaFromSqliteRow(row, nowIso));
        const people: Person[] = peopleRows.map((row) => personFromSqliteRow(row, nowIso));

        const settings = settingsRow?.data ? fromJson<AppData['settings']>(settingsRow.data, {}) : {};
        const savedFiltersFromTable = savedFilterRows
            .map((row) => this.mapSavedFilterRow(row))
            .filter((item): item is SavedFilter => Boolean(item));
        if (!Array.isArray(settings.savedFilters) && savedFiltersFromTable.length > 0) {
            settings.savedFilters = savedFiltersFromTable;
        } else if (Array.isArray(settings.savedFilters)) {
            settings.savedFilters = normalizeSavedFilters(settings.savedFilters);
        }

        // A read is the deletion baseline for this adapter. Retain exact row
        // versions so later snapshot omissions can use compare-and-swap deletion.
        this.lastKnownRowVersions = new Map<SqliteEntityTable, Map<string, SqliteKnownRowVersion>>([
            ['tasks', this.knownRowVersionsFromRows(tasksRows)],
            ['projects', this.knownRowVersionsFromRows(projectsRows)],
            ['sections', this.knownRowVersionsFromRows(sectionsRows)],
            ['areas', this.knownRowVersionsFromRows(areasRows)],
            ['people', this.knownRowVersionsFromRows(peopleRows)],
            ['saved_filters', this.knownRowVersionsFromRows(savedFilterRows)],
        ]);

        return { tasks, projects, sections, areas, people, settings };
    }

    async queryTasks(options: TaskQueryOptions): Promise<Task[]> {
        await this.ensureSchema();
        const { sql: where, params } = buildTaskWhere(options);
        const sql = `SELECT * FROM tasks ${where ? `WHERE ${where}` : ''}`;
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
        // Quoted so a token that survived cleaning with a leading '#'/'@' (contexts,
        // tags) is a valid FTS5 string literal instead of punctuation FTS5 rejects
        // as a syntax error (e.g. bare `@home*`).
        const ftsQuery = tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' ');
        const runSearch = async (): Promise<SearchResults> => {
            const [taskRows, projectRows] = await Promise.all([
                this.client.all<Record<string, unknown>>(
                    `SELECT ${SEARCH_TASK_SELECT} FROM tasks_fts f JOIN tasks t ON f.rowid = t.rowid WHERE tasks_fts MATCH ? AND t.deletedAt IS NULL ORDER BY bm25(tasks_fts) LIMIT ?`,
                    [ftsQuery, SEARCH_RESULT_LIMIT + 1]
                ),
                this.client.all<Record<string, unknown>>(
                    `SELECT ${SEARCH_PROJECT_SELECT} FROM projects_fts f JOIN projects p ON f.rowid = p.rowid WHERE projects_fts MATCH ? AND p.deletedAt IS NULL ORDER BY bm25(projects_fts) LIMIT ?`,
                    [ftsQuery, SEARCH_RESULT_LIMIT + 1]
                ),
            ]);
            const limited = taskRows.length > SEARCH_RESULT_LIMIT || projectRows.length > SEARCH_RESULT_LIMIT;
            return {
                tasks: taskRows.slice(0, SEARCH_RESULT_LIMIT).map((row) => this.mapSearchTaskRow(row)),
                projects: projectRows.slice(0, SEARCH_RESULT_LIMIT).map((row) => this.mapSearchProjectRow(row)),
                limited: limited || undefined,
                limit: limited ? SEARCH_RESULT_LIMIT : undefined,
            };
        };

        try {
            return await runSearch();
        } catch (error) {
            if (isFts5SyntaxError(error)) {
                // Quoting above makes this impossible by construction; if it still
                // happens, it's a bad query, not a corrupt index — rebuilding
                // (full delete-and-reinsert) would just repeat the same error.
                logWarn('Search failed', { scope: 'sqlite', category: 'fts', error });
                return { tasks: [], projects: [] };
            }
            try {
                await this.ensureFtsPopulated(true);
                return await runSearch();
            } catch (retryError) {
                logWarn('Search failed', { scope: 'sqlite', category: 'fts', error: retryError });
                return { tasks: [], projects: [] };
            }
        }
    }

    getLastSaveDataStats(): SqliteSaveDataStats | null {
        return this.lastSaveDataStats;
    }

    async saveTask(task: Task): Promise<void> {
        await this.ensureSchema();
        await this.client.run('BEGIN IMMEDIATE');
        try {
            await this.assertObservedSnapshotUnchanged();
            const columnList = TASK_UPSERT_COLUMNS.join(', ');
            const placeholders = TASK_UPSERT_COLUMNS.map(() => '?').join(', ');
            const entry = getTaskRowEntry(task);
            await this.client.run(
                `INSERT INTO tasks (${columnList}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${TASK_UPSERT_UPDATE_CLAUSE}`,
                entry.row
            );
            const savedRow = await this.client.get<Record<string, unknown>>(
                'SELECT rowid as _rowid, * FROM tasks WHERE id = ?',
                [task.id],
            );
            await this.client.run('COMMIT');
            this.lastSavedFingerprints?.tables.get('tasks')?.set(String(entry.row[0]), entry.fingerprint);
            const knownTables = new Map(this.lastKnownRowVersions ?? []);
            const knownTasks = new Map(knownTables.get('tasks') ?? []);
            if (savedRow) {
                const savedVersion = this.knownRowVersionsFromRows([savedRow]).get(task.id);
                if (savedVersion) knownTasks.set(task.id, savedVersion);
            }
            knownTables.set('tasks', knownTasks);
            this.lastKnownRowVersions = knownTables;
        } catch (error) {
            this.lastSavedFingerprints = null;
            await this.client.run('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }

    async saveData(data: AppData): Promise<void> {
        await this.ensureSchema();
        // A snapshot with zero entities while the database still holds rows
        // means the caller lost its in-memory state: real mass-deletions keep
        // tombstoned rows in the snapshot (#852). Desktop's Rust storage layer
        // refuses this at its own layer; this is the same backstop for every
        // consumer of the shared adapter (mobile, MCP local mode).
        const incomingEntityCount = (data.tasks?.length ?? 0)
            + (data.projects?.length ?? 0)
            + (data.sections?.length ?? 0)
            + (data.areas?.length ?? 0)
            + (data.people?.length ?? 0);
        if (incomingEntityCount === 0) {
            let storedEntityCount = 0;
            for (const table of ['tasks', 'projects', 'sections', 'areas', 'people'] as const) {
                const rows = await this.client.all<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
                storedEntityCount += Number(rows[0]?.count ?? 0);
                if (storedEntityCount > 0) break;
            }
            if (storedEntityCount > 0) {
                throw new Error('Refusing to overwrite existing data with an empty snapshot; local data left untouched');
            }
        }
        const previousSave = this.lastSavedFingerprints;
        const previousKnownRows = this.lastKnownRowVersions;
        const nextSave: { tables: Map<string, Map<string, string>>; settingsJson: string | null } = {
            tables: new Map(),
            settingsJson: null,
        };
        const nextKnownRows = new Map<SqliteEntityTable, Map<string, SqliteKnownRowVersion>>();
        const stats: SqliteSaveDataStats = {
            incremental: previousSave !== null,
            writtenRows: 0,
            removedRows: 0,
            totalRows: 0,
            settingsWritten: false,
            beginMs: 0,
            commitMs: 0,
            sqlMs: 0,
            sqlCount: 0,
        };
        const runTimed = async (sql: string, args?: unknown[]) => {
            const statementStartedAt = Date.now();
            try {
                return await this.client.run(sql, args);
            } finally {
                stats.sqlMs += Date.now() - statementStartedAt;
                stats.sqlCount += 1;
            }
        };
        this.lastSavedFingerprints = null;
        const beginStartedAt = Date.now();
        await runTimed('BEGIN IMMEDIATE');
        stats.beginMs = Date.now() - beginStartedAt;
        let saveStep = 'begin';
        try {
            saveStep = 'concurrent-write-check';
            await this.assertObservedSnapshotUnchanged();
            const nowIso = new Date().toISOString();
            const chunkArray = <T>(items: T[], size: number): T[][] => {
                const chunks: T[][] = [];
                for (let i = 0; i < items.length; i += size) {
                    chunks.push(items.slice(i, i + size));
                }
                return chunks;
            };

            const upsertBatch = async (
                table: SqliteEntityTable,
                columns: string[],
                rows: unknown[][],
                updateClause: string,
                chunkSize = 200,
                precomputedFingerprints?: string[],
                versionColumns?: { rev?: number; updatedAt: number },
            ) => {
                const previousRows = previousSave?.tables.get(table);
                const previousVersions = previousKnownRows?.get(table);
                const fingerprints = new Map<string, string>();
                const knownVersions = new Map<string, SqliteKnownRowVersion>();
                const changedRows: unknown[][] = [];
                const changedSamples: Array<{ row: unknown[]; previous: string }> = [];
                for (let i = 0; i < rows.length; i += 1) {
                    const row = rows[i];
                    const id = String(row[0]);
                    const fingerprint = precomputedFingerprints?.[i] ?? JSON.stringify(row);
                    fingerprints.set(id, fingerprint);
                    if (versionColumns) {
                        const rawRev = versionColumns.rev === undefined ? null : row[versionColumns.rev];
                        const parsedRev = rawRev === null || rawRev === undefined ? null : Number(rawRev);
                        const rawUpdatedAt = row[versionColumns.updatedAt];
                        knownVersions.set(id, {
                            rowId: previousVersions?.get(id)?.rowId ?? null,
                            rev: parsedRev !== null && Number.isFinite(parsedRev) ? parsedRev : null,
                            updatedAt: typeof rawUpdatedAt === 'string' ? rawUpdatedAt : null,
                        });
                    }
                    const previousFingerprint = previousRows?.get(id);
                    if (previousFingerprint !== fingerprint) {
                        changedRows.push(row);
                        if (previousFingerprint !== undefined && changedSamples.length < REWRITE_DIAGNOSTIC_SAMPLE) {
                            changedSamples.push({ row, previous: previousFingerprint });
                        }
                    }
                }
                nextSave.tables.set(table, fingerprints);
                nextKnownRows.set(table, knownVersions);
                stats.totalRows += rows.length;
                stats.writtenRows += changedRows.length;
                // A large-share rewrite of pre-existing rows is the fingerprint
                // of a sync-rewrite loop (#766): name the oscillating columns
                // from a small sample so a single user log can identify the
                // field. Zero cost below the threshold.
                if (
                    changedRows.length >= REWRITE_DIAGNOSTIC_MIN_ROWS
                    && changedRows.length >= rows.length * REWRITE_DIAGNOSTIC_MIN_SHARE
                    && changedSamples.length > 0
                ) {
                    const changedColumns = new Set<string>();
                    for (const sample of changedSamples) {
                        try {
                            const previousRow = JSON.parse(sample.previous) as unknown[];
                            for (let c = 0; c < columns.length; c += 1) {
                                if (JSON.stringify(sample.row[c]) !== JSON.stringify(previousRow[c])) {
                                    changedColumns.add(columns[c]);
                                }
                            }
                        } catch {
                            // A malformed previous fingerprint only costs the sample.
                        }
                    }
                    const purgedIndex = columns.indexOf('purgedAt');
                    const diagnostic: SqliteRewriteDiagnostic = {
                        table,
                        changedRows: changedRows.length,
                        tableRows: rows.length,
                        changedColumns: [...changedColumns].sort(),
                        sampleSize: changedSamples.length,
                        ...(purgedIndex >= 0
                            ? {
                                purgedChangedRows: changedRows.reduce(
                                    (count, row) => count + (row[purgedIndex] ? 1 : 0),
                                    0,
                                ),
                            }
                            : {}),
                    };
                    (stats.rewriteDiagnostics ??= []).push(diagnostic);
                }
                if (changedRows.length === 0) return;
                const columnList = columns.join(', ');
                const placeholders = `(${columns.map(() => '?').join(', ')})`;
                for (const batch of chunkArray(changedRows, chunkSize)) {
                    const values: unknown[] = [];
                    const valuePlaceholders = batch
                        .map((row) => {
                            values.push(...row);
                            return placeholders;
                        })
                        .join(', ');
                    await runTimed(
                        `INSERT INTO ${table} (${columnList}) VALUES ${valuePlaceholders} ON CONFLICT(id) DO UPDATE SET ${updateClause}`,
                        values
                    );
                }
            };

            const syncIds = async (table: SqliteEntityTable, ids: string[]) => {
                const knownRows = previousKnownRows?.get(table);
                if (!knownRows) return;
                const keptIds = new Set(ids);
                const removedRows: Array<[string, number | null, number | null, string | null]> = [];
                for (const [id, version] of knownRows) {
                    if (!keptIds.has(id)) {
                        removedRows.push([id, version.rowId, version.rev, version.updatedAt]);
                    }
                }
                if (removedRows.length === 0) return;
                stats.removedRows += removedRows.length;
                const tempTable = createTempIdTableName(table);
                try {
                    await runTimed(`CREATE TEMP TABLE ${tempTable} (id TEXT PRIMARY KEY, rowId INTEGER, rev INTEGER, updatedAt TEXT)`);
                    for (const batch of chunkArray(removedRows, SQLITE_ROW_VERSION_INSERT_BATCH_SIZE)) {
                        const placeholders = batch.map(() => '(?, ?, ?, ?)').join(', ');
                        await runTimed(
                            `INSERT OR IGNORE INTO ${tempTable} (id, rowId, rev, updatedAt) VALUES ${placeholders}`,
                            batch.flat()
                        );
                    }
                    const revGuard = table === 'saved_filters'
                        ? ''
                        : `AND known.rev IS ${table}.rev`;
                    await runTimed(
                        `DELETE FROM ${table}
                         WHERE EXISTS (
                           SELECT 1 FROM ${tempTable} known
                           WHERE known.id = ${table}.id
                             AND (known.rowId IS NULL OR known.rowId = ${table}.rowid)
                             ${revGuard}
                             AND known.updatedAt IS ${table}.updatedAt
                         )`
                    );
                } finally {
                    try {
                        await runTimed(`DROP TABLE ${tempTable}`);
                    } catch (dropError) {
                        logWarn(`Failed to drop temp table ${tempTable}`, {
                            scope: 'sqlite',
                            category: 'storage',
                            error: dropError,
                        });
                    }
                }
            };

            saveStep = 'areas';
            await upsertBatch(
                'areas',
                [...AREA_UPSERT_COLUMNS],
                data.areas.map((area) => areaToSqliteRow(area, nowIso)),
                AREA_UPSERT_UPDATE_CLAUSE,
                200,
                undefined,
                {
                    rev: AREA_UPSERT_COLUMNS.indexOf('rev'),
                    updatedAt: AREA_UPSERT_COLUMNS.indexOf('updatedAt'),
                },
            );

            saveStep = 'projects';
            await upsertBatch(
                'projects',
                [...PROJECT_UPSERT_COLUMNS],
                data.projects.map((project) => projectToSqliteRow(project)),
                PROJECT_UPSERT_UPDATE_CLAUSE,
                200,
                undefined,
                {
                    rev: PROJECT_UPSERT_COLUMNS.indexOf('rev'),
                    updatedAt: PROJECT_UPSERT_COLUMNS.indexOf('updatedAt'),
                },
            );

            const people = Array.isArray(data.people) ? data.people : [];
            saveStep = 'people';
            await upsertBatch(
                'people',
                [...PERSON_UPSERT_COLUMNS],
                people.map((person) => personToSqliteRow(person, nowIso)),
                PERSON_UPSERT_UPDATE_CLAUSE,
                200,
                undefined,
                {
                    rev: PERSON_UPSERT_COLUMNS.indexOf('rev'),
                    updatedAt: PERSON_UPSERT_COLUMNS.indexOf('updatedAt'),
                },
            );

            saveStep = 'sections';
            await upsertBatch(
                'sections',
                [...SECTION_UPSERT_COLUMNS],
                data.sections.map((section) => sectionToSqliteRow(section)),
                SECTION_UPSERT_UPDATE_CLAUSE,
                200,
                undefined,
                {
                    rev: SECTION_UPSERT_COLUMNS.indexOf('rev'),
                    updatedAt: SECTION_UPSERT_COLUMNS.indexOf('updatedAt'),
                },
            );

            saveStep = 'tasks';
            const taskRowEntries = data.tasks.map(getTaskRowEntry);
            await upsertBatch(
                'tasks',
                [...TASK_UPSERT_COLUMNS],
                taskRowEntries.map((entry) => entry.row),
                TASK_UPSERT_UPDATE_CLAUSE,
                200,
                taskRowEntries.map((entry) => entry.fingerprint),
                {
                    rev: TASK_UPSERT_COLUMNS.indexOf('rev'),
                    updatedAt: TASK_UPSERT_COLUMNS.indexOf('updatedAt'),
                },
            );

            saveStep = 'sync-task-ids';
            await syncIds('tasks', data.tasks.map((task) => task.id));
            saveStep = 'sync-section-ids';
            await syncIds('sections', data.sections.map((section) => section.id));
            saveStep = 'sync-project-ids';
            await syncIds('projects', data.projects.map((project) => project.id));
            saveStep = 'sync-area-ids';
            await syncIds('areas', data.areas.map((area) => area.id));
            saveStep = 'sync-people-ids';
            await syncIds('people', people.map((person) => person.id));

            const rawSavedFilters = data.settings?.savedFilters;
            const savedFilters = normalizeSavedFilters(rawSavedFilters);
            saveStep = 'saved-filters';
            await upsertBatch(
                'saved_filters',
                [
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
                ],
                savedFilters.map((filter) => [
                    filter.id,
                    filter.name,
                    filter.icon ?? null,
                    filter.view,
                    toJson(filter.criteria),
                    filter.sortBy ?? null,
                    filter.sortOrder ?? null,
                    filter.groupBy ?? null,
                    filter.createdAt,
                    filter.updatedAt,
                    filter.deletedAt ?? null,
                ]),
                `name=excluded.name,
                 icon=excluded.icon,
                 view=excluded.view,
                 criteria=excluded.criteria,
                 sortBy=excluded.sortBy,
                 sortOrder=excluded.sortOrder,
                 groupBy=excluded.groupBy,
                 createdAt=excluded.createdAt,
                 updatedAt=excluded.updatedAt,
                 deletedAt=excluded.deletedAt`,
                200,
                undefined,
                { updatedAt: 9 },
            );
            saveStep = 'sync-saved-filter-ids';
            await syncIds('saved_filters', savedFilters.map((filter) => filter.id));

            const settingsForSave = { ...(data.settings ?? {}) };
            if (Array.isArray(rawSavedFilters)) {
                settingsForSave.savedFilters = savedFilters;
            } else {
                delete settingsForSave.savedFilters;
            }

            saveStep = 'settings';
            const settingsJson = toJson(settingsForSave);
            nextSave.settingsJson = settingsJson;
            if (previousSave?.settingsJson !== settingsJson) {
                stats.settingsWritten = true;
                await runTimed(
                    'INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
                    [settingsJson]
                );
            }

            saveStep = 'commit';
            const commitStartedAt = Date.now();
            await runTimed('COMMIT');
            stats.commitMs = Date.now() - commitStartedAt;
            this.lastSavedFingerprints = nextSave;
            this.lastKnownRowVersions = nextKnownRows;
            this.lastSaveDataStats = stats;
        } catch (error) {
            await this.client.run('ROLLBACK').catch((rollbackError) => {
                logWarn('SQLite saveData rollback failed', {
                    scope: 'sqlite',
                    category: 'storage',
                    error: rollbackError,
                    context: { step: saveStep },
                });
            });
            logWarn('SQLite saveData failed', {
                scope: 'sqlite',
                category: 'storage',
                error,
                context: buildSqliteSaveFailureContext(data, saveStep),
            });
            throw error;
        }
    }

    // MARK: - Calendar Sync CRUD

    async getCalendarSyncEntry(taskId: string, platform: string): Promise<CalendarSyncEntry | null> {
        await this.ensureSchema();
        const row = await this.client.get<{
            task_id: string;
            calendar_event_id: string;
            calendar_id: string;
            platform: string;
            last_synced_at: string;
        }>('SELECT * FROM calendar_sync WHERE task_id = ? AND platform = ?', [taskId, platform]);
        if (!row) return null;
        return {
            taskId: row.task_id,
            calendarEventId: row.calendar_event_id,
            calendarId: row.calendar_id,
            platform: row.platform,
            lastSyncedAt: row.last_synced_at,
        };
    }

    async upsertCalendarSyncEntry(entry: CalendarSyncEntry): Promise<void> {
        await this.ensureSchema();
        await this.client.run(
            `INSERT INTO calendar_sync (task_id, calendar_event_id, calendar_id, platform, last_synced_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(task_id, platform) DO UPDATE SET
               calendar_event_id = excluded.calendar_event_id,
               calendar_id = excluded.calendar_id,
               last_synced_at = excluded.last_synced_at`,
            [entry.taskId, entry.calendarEventId, entry.calendarId, entry.platform, entry.lastSyncedAt]
        );
    }

    async deleteCalendarSyncEntry(taskId: string, platform: string): Promise<void> {
        await this.ensureSchema();
        await this.client.run(
            'DELETE FROM calendar_sync WHERE task_id = ? AND platform = ?',
            [taskId, platform]
        );
    }

    async getAllCalendarSyncEntries(platform: string): Promise<CalendarSyncEntry[]> {
        await this.ensureSchema();
        const rows = await this.client.all<{
            task_id: string;
            calendar_event_id: string;
            calendar_id: string;
            platform: string;
            last_synced_at: string;
        }>('SELECT * FROM calendar_sync WHERE platform = ?', [platform]);
        return rows.map((row) => ({
            taskId: row.task_id,
            calendarEventId: row.calendar_event_id,
            calendarId: row.calendar_id,
            platform: row.platform,
            lastSyncedAt: row.last_synced_at,
        }));
    }
}
