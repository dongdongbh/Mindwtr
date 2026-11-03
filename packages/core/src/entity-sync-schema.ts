


import type { Attachment } from './types';
import { logWarn } from './logger';


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


export const fromPresentBool = (value: unknown): true | undefined => (value ? true : undefined);
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


export const fromOptional = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);


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
            staleContentHash: typeof item.staleContentHash === 'string' && /^[0-9a-f]{64}$/i.test(item.staleContentHash)
                ? item.staleContentHash.toLowerCase()
                : undefined,
        }));
    return cleaned.length > 0 ? cleaned : undefined;
};

export type EntityFieldNullability = 'required' | 'optional' | 'optional-nullable';


export type EntityCloudWriteSemantics = 'create-patch' | 'patch' | 'managed';

export type EntitySqliteColumnType = 'TEXT' | 'INTEGER';

export type EntitySyncFieldSpec = {
    name: string;
    nullability: EntityFieldNullability;


    cloudSynced: boolean;
    cloudWrite: EntityCloudWriteSemantics;
    sqliteColumn: string | null;


    sqliteOrder: number | null;


    sqliteType: EntitySqliteColumnType | null;
};

export type EntitySqliteColumnEntry = {
    column: string;
    order: number;
    sqlType: EntitySqliteColumnType | null;
};


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


export function sqliteRowFromColumnValues(columns: readonly string[], values: Record<string, unknown>): unknown[] {
    return columns.map((column) => values[column]);
}


export function sqliteMigrationColumnsFromEntries(
    entries: readonly EntitySqliteColumnEntry[],
    table: string,
): readonly { name: string; sql: string }[] {
    return entries
        .filter((entry) => entry.sqlType !== null)
        .map((entry) => ({ name: entry.column, sql: `ALTER TABLE ${table} ADD COLUMN ${entry.column} ${entry.sqlType}` }));
}
