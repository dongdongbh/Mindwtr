// Shared, zero-external-dependency building blocks for the per-entity generative sync-field
// schemas (project-sync-schema.ts, section-sync-schema.ts, area-sync-schema.ts,
// person-sync-schema.ts, task-sync-schema.ts). Mirrors the derivation logic task-sync-schema.ts
// introduced for tasks, generalized so it isn't copy-pasted per entity.
//
// Nothing in this file may import a real npm dependency: scripts/check-synced-field-parity.ts
// (via project-sync-schema.ts / section-sync-schema.ts / etc.) runs in a "native-schema" CI job
// on a fresh checkout with no `bun install` step. `./logger` and `./types` are both
// dependency-free (the former only imports `./log-sanitize`, which has no imports of its own;
// the latter's imports are all `import type`, erased at compile time), so both are safe here.
import type { Attachment } from './types';
import { logWarn } from './logger';

// Generic per-column value marshalling shared by every entity's toRow/fromRow codec below.
// Moved here verbatim from sqlite-adapter.ts so the codecs can stay zero-dependency;
// sqlite-adapter.ts now imports these instead of defining its own copies, so there is exactly
// one implementation for both the generated codecs and its own remaining hand-written call
// sites (saved_filters, settings, search-result projections).
export const toJson = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

export const fromJson = <T,>(value: unknown, fallback: T): T => {
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

export const toBool = (value?: boolean) => (value ? 1 : 0);
export const fromBool = (value: unknown) => Boolean(value);
export const toNullableBool = (value?: boolean | null) => (value === null || value === undefined ? null : toBool(value));
export const fromNullableBool = (value: unknown): boolean | null | undefined => {
    if (value === null) return null;
    if (value === undefined) return undefined;
    return Boolean(value);
};

export const toStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
};

// A NULL SQLite column reads back as JS `null`, but a field declared `field?: T` (not
// `field?: T | null`) in types.ts promises `undefined`, never `null`, for "absent". `null` and
// `undefined` are NOT interchangeable here: `JSON.stringify` keeps a `null` key but drops an
// `undefined` one (a visible wire-shape difference over MCP), and a caller's `=== undefined`
// check silently stops matching. Use this for every optional-but-not-nullable field's read
// codec; do NOT use it for a field declared `T | null` in types.ts (there are exactly three:
// Task.completedAtBeforeProjectArchive, Task.isFocusedTodayBeforeProjectArchive,
// Section.deletedAtBeforeProjectArchive) — those must keep `null` as `null`.
export const fromOptional = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Shared between Task and Project (both have an `attachments` field with identical shape
// and identical permissive-parse rules).
export const toAttachments = (value: unknown): Attachment[] | undefined => {
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
            contentRev: typeof item.contentRev === 'number' && Number.isFinite(item.contentRev) ? item.contentRev : undefined,
            contentMtimeMs: typeof item.contentMtimeMs === 'number' && Number.isFinite(item.contentMtimeMs) ? item.contentMtimeMs : undefined,
            contentSize: typeof item.contentSize === 'number' && Number.isFinite(item.contentSize) ? item.contentSize : undefined,
            localStatus: typeof item.localStatus === 'string' && allowedStatuses.has(item.localStatus as Attachment['localStatus'])
                ? (item.localStatus as Attachment['localStatus'])
                : undefined,
            pendingContentUpload: item.pendingContentUpload === true ? true : undefined,
        }));
    return cleaned.length > 0 ? cleaned : undefined;
};

export type EntityFieldNullability = 'required' | 'optional' | 'optional-nullable';

// Whether a field can be written through the cloud API's generic create/patch prop bag:
// 'create-patch' = writable at both creation and patch time; 'patch' = writable via patch
// only (creation uses a dedicated param, or the field is never legitimately set at creation
// time, e.g. deletedAt); 'managed' = never client-writable through this mechanism.
export type EntityCloudWriteSemantics = 'create-patch' | 'patch' | 'managed';

export type EntitySqliteColumnType = 'TEXT' | 'INTEGER';

export type EntitySyncFieldSpec = {
    name: string;
    nullability: EntityFieldNullability;
    // Project/section CloudKit mappers (Swift/ObjC) are parity-checked by field name only
    // (no per-field storage-key/kind round-trip the way tasks need — see
    // TaskCloudKitFieldSpec in task-sync-schema.ts), so a boolean is enough here.
    cloudSynced: boolean;
    cloudWrite: EntityCloudWriteSemantics;
    sqliteColumn: string | null;
    /**
     * Position of `sqliteColumn` in the generated column list / upsert clause / migration
     * list. Required whenever sqliteColumn is set. SQL column order is load-bearing for
     * row-building call sites that zip the generated column list with positional row values.
     */
    sqliteOrder: number | null;
    /** SQL type for the ALTER TABLE migration. Null for base columns that ship in the
     *  CREATE TABLE itself and therefore never appear in the migration list. */
    sqliteType: EntitySqliteColumnType | null;
};

export type EntitySqliteColumnEntry = {
    column: string;
    order: number;
    sqlType: EntitySqliteColumnType | null;
};

// Derives the ordered, deduplicated-by-column-name list backing both the generated column
// list and the migration list, from a field schema. Fields that share a `sqliteColumn`
// collapse to one entry, keeping the position of whichever field is declared first.
export function deriveSqliteColumnEntries(
    fields: readonly EntitySyncFieldSpec[],
    schemaLabel: string,
): EntitySqliteColumnEntry[] {
    const seen = new Set<string>();
    const entries: EntitySqliteColumnEntry[] = [];
    for (const field of fields) {
        if (field.sqliteColumn === null || seen.has(field.sqliteColumn)) continue;
        if (field.sqliteOrder === null) {
            throw new Error(`${schemaLabel}: "${field.name}" declares sqliteColumn without sqliteOrder`);
        }
        seen.add(field.sqliteColumn);
        entries.push({ column: field.sqliteColumn, order: field.sqliteOrder, sqlType: field.sqliteType });
    }
    return entries.sort((a, b) => a.order - b.order);
}

export function sqliteColumnsFromEntries(entries: readonly EntitySqliteColumnEntry[]): readonly string[] {
    return entries.map((entry) => entry.column);
}

// Projects a name-keyed value map onto the generated column order. This is the piece that
// was missing before this file existed: every entity's toRow used to return a hand-written
// positional array that only coincidentally lined up with the (separately generated) column
// list. Building the row from a `column -> value` map instead means a column can never
// silently receive another column's value — a value missing from `values` (e.g. a schema
// field added without also updating its entity's column-values map) surfaces as `undefined`
// in that one slot, not a shift of every later column into the wrong place.
export function sqliteRowFromColumnValues(columns: readonly string[], values: Record<string, unknown>): unknown[] {
    return columns.map((column) => values[column]);
}

// The migration list an ensure*Columns() startup routine runs: every synced column except
// the base ones that ship in the CREATE TABLE itself (sqlType === null).
export function sqliteMigrationColumnsFromEntries(
    entries: readonly EntitySqliteColumnEntry[],
    table: string,
): readonly { name: string; sql: string }[] {
    return entries
        .filter((entry) => entry.sqlType !== null)
        .map((entry) => ({ name: entry.column, sql: `ALTER TABLE ${table} ADD COLUMN ${entry.column} ${entry.sqlType}` }));
}
