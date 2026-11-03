import { areaToSqliteRow } from './area-sync-schema';
import { validateBackupJson } from './backup-transfer';
import { personToSqliteRow } from './person-sync-schema';
import { projectToSqliteRow } from './project-sync-schema';
import { keepSavedFilters } from './saved-filters';
import { sectionToSqliteRow } from './section-sync-schema';
import type { SqliteClient } from './sqlite-adapter';
import { repairAppDataForSqlite, type SqliteCopyRepairCounts } from './sqlite-copy-repair';
import { mergeAppDataWithStats } from './sync';
import { toStableSyncJson } from './sync-helpers';
import { taskToSqliteRow } from './task-sync-schema';
import type { AppData } from './types';


export const LEGACY_JSON_BACKUP_VERSION = '2';


export const LEGACY_JSON_IMPORT_DATA_TABLES = [
    'tasks', 'projects', 'sections', 'areas', 'people', 'saved_filters', 'settings',
] as const;

export type LegacyJsonImportState = {

    jsonAhead: boolean;

    reconciled: boolean;

    backupVersion: string | null;

    backupJson: string | null;
};

export type LegacyJsonImportPlan = {

    outcome: 'imported' | 'abandoned' | 'none';

    path?: 'json-ahead' | 'reconcile' | 'migrate';
    reason?: 'backup-missing' | 'backup-corrupt' | 'backup-version';

    merged?: AppData;

    clearJsonAhead: boolean;

    setReconciled: boolean;

    counts?: { backupTasks: number; sqliteTasks: number; mergedTasks: number; tasksFromBackup: number };

    repairs?: SqliteCopyRepairCounts;
};


export type LegacyJsonCopyMove = NonNullable<LegacyJsonImportPlan['path']>;


export function mergeLegacyJsonCopy(current: AppData, rawCopy: AppData, move: LegacyJsonCopyMove) {
    const { data: copy, counts: repairs } = repairAppDataForSqlite(rawCopy, current);
    const result = mergeAppDataWithStats(current, copy);
    if (move !== 'reconcile') {
        const copySettings = { ...copy.settings, savedFilters: keepSavedFilters(copy.settings?.savedFilters) };
        if (Object.keys(current.settings ?? {}).length === 0) {
            result.data.settings = copySettings;
        } else if (move === 'migrate') {
            result.data.settings = { ...copySettings, ...result.data.settings };
        }
    }
    return { ...result, repairs };
}


export function parseLegacyJsonBackup(json: string): AppData {
    const data = JSON.parse(json) as AppData;
    return {
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        projects: Array.isArray(data.projects) ? data.projects : [],
        sections: Array.isArray(data.sections) ? data.sections : [],
        areas: Array.isArray(data.areas) ? data.areas : [],
        people: Array.isArray(data.people) ? data.people : [],
        settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
    };
}


export function assertNativeLegacyBackupSafe(state: Pick<LegacyJsonImportState, 'jsonAhead' | 'backupJson'>): void {
    if (state.backupJson === null && !state.jsonAhead) return;
    try {
        if (state.backupJson === null) throw new Error();
        const raw = JSON.parse(state.backupJson);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.tasks)) throw new Error();
        for (const table of ['tasks', 'projects', 'sections', 'areas', 'people'] as const) {
            if (raw[table] !== undefined && !Array.isArray(raw[table])) throw new Error();
        }
        const parsed = parseLegacyJsonBackup(state.backupJson);

        if (validatesWhole(state.backupJson, parsed)) return;
        const repaired = repairAppDataForSqlite(parsed).data;
        if (!validatesWhole(JSON.stringify(repaired), repaired)) throw new Error();
    } catch {

        throw new Error('Legacy backup requires recovery before native upgrade');
    }
}


const validatesWhole = (json: string, source: AppData): boolean => {
    const validated = validateBackupJson(json);
    if (!validated.valid || !validated.data) return false;
    for (const table of ['tasks', 'projects', 'sections', 'areas', 'people'] as const) {
        const rows = source[table] ?? [];
        if (rows.length !== (validated.data[table] ?? []).length
            || new Set(rows.map((row) => row.id)).size !== rows.length) return false;
    }
    return !legacyImportMismatch(source, validated.data);
};


export async function sqliteHasAnyData(client: Pick<SqliteClient, 'get'>): Promise<boolean> {
    for (const table of LEGACY_JSON_IMPORT_DATA_TABLES) {
        const row = await client.get<{ count?: number }>(`SELECT COUNT(*) as count FROM ${table}`);
        if (Number(row?.count ?? 0) > 0) return true;
    }
    return false;
}


export function planLegacyJsonImport(
    state: LegacyJsonImportState,
    current: AppData,
    sqliteHasData: boolean,
): LegacyJsonImportPlan {
    let backup: AppData | null = null;
    let reason: LegacyJsonImportPlan['reason'];
    if (state.backupJson === null) {
        reason = 'backup-missing';
    } else {
        try {
            backup = parseLegacyJsonBackup(state.backupJson);
        } catch {
            reason = 'backup-corrupt';
        }
    }
    const imported = (path: LegacyJsonCopyMove, source: AppData) => {
        const { data: merged, stats, repairs } = mergeLegacyJsonCopy(current, source, path);
        return {
            outcome: 'imported' as const,
            path,
            merged,
            repairs,
            counts: {
                backupTasks: source.tasks.length,
                sqliteTasks: current.tasks.length,
                mergedTasks: merged.tasks.length,
                tasksFromBackup: (stats.tasks?.incomingOnly ?? 0) + (stats.tasks?.resolvedUsingIncoming ?? 0),
            },
        };
    };

    if (state.jsonAhead) {
        if (backup) {


            return { ...imported('json-ahead', backup), clearJsonAhead: true, setReconciled: !state.reconciled };
        }


        return {
            outcome: 'abandoned', path: 'json-ahead', reason,
            clearJsonAhead: true, setReconciled: sqliteHasData && !state.reconciled,
        };
    }
    if (sqliteHasData) {
        if (state.reconciled) return { outcome: 'none', clearJsonAhead: false, setReconciled: false };

        if (state.backupVersion !== LEGACY_JSON_BACKUP_VERSION) reason = 'backup-version';
        if (reason || !backup) {
            return { outcome: 'abandoned', path: 'reconcile', reason, clearJsonAhead: false, setReconciled: true };
        }
        return { ...imported('reconcile', backup), clearJsonAhead: false, setReconciled: true };
    }
    if (!backup) {

        return reason === 'backup-corrupt'
            ? { outcome: 'abandoned', path: 'migrate', reason, clearJsonAhead: false, setReconciled: false }
            : { outcome: 'none', clearJsonAhead: false, setReconciled: false };
    }
    return { ...imported('migrate', backup), clearJsonAhead: false, setReconciled: !state.reconciled };
}


const ENTITY_ROWS = {
    tasks: taskToSqliteRow,
    projects: projectToSqliteRow,
    sections: sectionToSqliteRow,
    areas: areaToSqliteRow,
    people: personToSqliteRow,
} as const;

const FIXED_NOW = '1970-01-01T00:00:00.000Z';


const withoutNulls = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutNulls);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined)
        .map(([name, item]) => [name, withoutNulls(item)]));
};
const comparableSettings = (settings: AppData['settings'] | undefined): string => {
    const copy = withoutNulls(settings ?? {}) as Record<string, unknown>;
    if (Array.isArray(copy.savedFilters) && copy.savedFilters.length === 0) delete copy.savedFilters;
    return toStableSyncJson(copy);
};


export function legacyImportMismatch(merged: AppData, saved: AppData): string | null {
    for (const [table, toRow] of Object.entries(ENTITY_ROWS) as [keyof typeof ENTITY_ROWS, (item: never, nowIso: string) => unknown[]][]) {
        const rows = (data: AppData) => new Map((data[table] ?? []).map((item) => [item.id, JSON.stringify(toRow(item as never, FIXED_NOW))]));
        const want = rows(merged);
        const have = rows(saved);
        if (want.size !== have.size || [...want].some(([id, row]) => have.get(id) !== row)) return table;
    }
    return comparableSettings(merged.settings) === comparableSettings(saved.settings) ? null : 'settings';
}
