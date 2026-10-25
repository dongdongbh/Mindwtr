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

/**
 * The React Native app's startup import of its AsyncStorage JSON backup
 * (`prepareSqliteData` in apps/mobile/lib/storage-adapter.ts), as one pure
 * decision, so a native host that replaces the RN app imports that backup
 * exactly as RN's next launch would have. The host reads the RN state, calls
 * {@link planLegacyJsonImport}, saves `merged` through its SqliteAdapter, checks
 * the re-read with {@link legacyImportMismatch}, and only then applies
 * `clearJsonAhead` and `setReconciled` to AsyncStorage.
 *
 * RN runs three steps at every launch:
 * - (a) the json-ahead marker is set: merge the backup into SQLite, then clear
 *   the marker; an absent or corrupt backup only clears the marker (#964);
 * - (b) SQLite has data and the one-time reconcile flag is unset: merge the
 *   backup once when it is a version-2 backup, then set the flag;
 * - (c) SQLite is empty: merge the backup over the empty data and set the flag.
 */

/** AsyncStorage `mindwtr-data:startup-backup-version` of a backup the SQLite-era app maintains. */
export const LEGACY_JSON_BACKUP_VERSION = '2';

/** The tables RN counts to tell an empty SQLite database from one with data. */
export const LEGACY_JSON_IMPORT_DATA_TABLES = [
    'tasks', 'projects', 'sections', 'areas', 'people', 'saved_filters', 'settings',
] as const;

export type LegacyJsonImportState = {
    /** `mindwtr-data:json-ahead-of-sqlite` is present. */
    jsonAhead: boolean;
    /** `mindwtr-data:sqlite-json-reconcile-v1` is present. */
    reconciled: boolean;
    /** `mindwtr-data:startup-backup-version`, or null when absent. */
    backupVersion: string | null;
    /** The first present of `mindwtr-data`, `focus-gtd-data`, `gtd-todo-data`, `gtd-data`; null when none is. */
    backupJson: string | null;
};

export type LegacyJsonImportPlan = {
    /** `imported`: save `merged`. `abandoned`: the backup was absent, corrupt, or not a version-2 backup. */
    outcome: 'imported' | 'abandoned' | 'none';
    /** The RN step that acted: (a) `json-ahead`, (b) `reconcile`, (c) `migrate`. */
    path?: 'json-ahead' | 'reconcile' | 'migrate';
    reason?: 'backup-missing' | 'backup-corrupt' | 'backup-version';
    /** Present only for `imported`: the full snapshot to save. */
    merged?: AppData;
    /** Delete the json-ahead marker, after `merged` is saved. */
    clearJsonAhead: boolean;
    /** Set the reconcile flag to '1', after `merged` is saved. */
    setReconciled: boolean;
    /** RN's own diagnostic counts for an import. */
    counts?: { backupTasks: number; sqliteTasks: number; mergedTasks: number; tasksFromBackup: number };
    /** Present only for `imported`: what {@link mergeLegacyJsonCopy} repaired, per class. */
    repairs?: SqliteCopyRepairCounts;
};

/** The three moves of RN's JSON copy into SQLite (RN's (a) json-ahead recovery, (b) reconcile, (c) first move). */
export type LegacyJsonCopyMove = NonNullable<LegacyJsonImportPlan['path']>;

/**
 * One move of RN's JSON copy into SQLite, as RN's storage adapter makes it and
 * a native host replacing RN must too: the copy is repaired first (rows SQLite
 * always rejects; see repairAppDataForSqlite, which fills from `current`
 * first), then merged over `current`. The sync merge starts from SQLite's
 * settings and drops the copy's device-local and unstamped ones, so into a
 * SQLite with no settings the copy's settings move whole, minus filters SQLite
 * cannot store; the first move also keeps the copy's keys beside settings a
 * second process wrote meanwhile. The reconcile merges settings as sync does.
 */
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

/** RN's `parseStoredAppDataJson`. Throws on JSON that does not parse, and on `null`. */
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

/**
 * A replacement client must not turn unreadable backup authority into an empty
 * library. Run before opening its database. The import repairs what SQLite
 * always rejects (mergeLegacyJsonCopy), so a copy is also safe when its repaired
 * form passes; a copy the repair cannot make whole (lossy validation, duplicate
 * ids) is still refused.
 */
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
        // A host may run this at every start, so a copy that passes as it is costs no repair pass.
        if (validatesWhole(state.backupJson, parsed)) return;
        const repaired = repairAppDataForSqlite(parsed).data;
        if (!validatesWhole(JSON.stringify(repaired), repaired)) throw new Error();
    } catch {
        // Never include backup contents or parser errors in the native UI/log.
        throw new Error('Legacy backup requires recovery before native upgrade');
    }
}

// Backup validation keeps every row, with unique ids, and changes no field of `source`.
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

/** RN's `sqliteHasAnyData`: any row in any of {@link LEGACY_JSON_IMPORT_DATA_TABLES}. */
export async function sqliteHasAnyData(client: Pick<SqliteClient, 'get'>): Promise<boolean> {
    for (const table of LEGACY_JSON_IMPORT_DATA_TABLES) {
        const row = await client.get<{ count?: number }>(`SELECT COUNT(*) as count FROM ${table}`);
        if (Number(row?.count ?? 0) > 0) return true;
    }
    return false;
}

/**
 * RN's startup decision for `state`, given the validated SQLite load `current`
 * and whether SQLite held any row before the import (`sqliteHasData`).
 *
 * Idempotent: planning again after `merged` is saved (for example when the
 * AsyncStorage update failed) merges the same backup into data that already
 * holds it, which changes nothing and adds no task.
 */
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
            // Saving `merged` always writes the settings row, so RN's next step sees
            // data and runs the reconcile: it merges the same backup again (no change)
            // or skips a non-version-2 backup, and sets the flag either way.
            return { ...imported('json-ahead', backup), clearJsonAhead: true, setReconciled: !state.reconciled };
        }
        // Absent or corrupt: nothing to recover. SQLite is unchanged, so the
        // reconcile sees the same backup and sets its flag; step (c) does nothing.
        return {
            outcome: 'abandoned', path: 'json-ahead', reason,
            clearJsonAhead: true, setReconciled: sqliteHasData && !state.reconciled,
        };
    }
    if (sqliteHasData) {
        if (state.reconciled) return { outcome: 'none', clearJsonAhead: false, setReconciled: false };
        // An old, unmarked snapshot may be stale; RN checks the version before it reads the backup.
        if (state.backupVersion !== LEGACY_JSON_BACKUP_VERSION) reason = 'backup-version';
        if (reason || !backup) {
            return { outcome: 'abandoned', path: 'reconcile', reason, clearJsonAhead: false, setReconciled: true };
        }
        return { ...imported('reconcile', backup), clearJsonAhead: false, setReconciled: true };
    }
    if (!backup) {
        // RN logs a backup that does not parse and leaves every AsyncStorage key alone.
        return reason === 'backup-corrupt'
            ? { outcome: 'abandoned', path: 'migrate', reason, clearJsonAhead: false, setReconciled: false }
            : { outcome: 'none', clearJsonAhead: false, setReconciled: false };
    }
    return { ...imported('migrate', backup), clearJsonAhead: false, setReconciled: !state.reconciled };
}

// The adapter's own row writers: a row compares equal exactly when saveData would persist the same values.
const ENTITY_ROWS = {
    tasks: taskToSqliteRow,
    projects: projectToSqliteRow,
    sections: sectionToSqliteRow,
    areas: areaToSqliteRow,
    people: personToSqliteRow,
} as const;
// Only fills a missing area or person timestamp, and the merge has already filled those.
const FIXED_NOW = '1970-01-01T00:00:00.000Z';

// SQLite stores null and missing alike, and core saves an absent savedFilters list as [].
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

/**
 * The first table, or `settings`, where `saved` (a SQLite re-read) does not hold
 * `merged` exactly; null when every entity row and the settings match. Rows are
 * compared as the adapter persists them, so null and missing are the same value.
 */
export function legacyImportMismatch(merged: AppData, saved: AppData): string | null {
    for (const [table, toRow] of Object.entries(ENTITY_ROWS) as [keyof typeof ENTITY_ROWS, (item: never, nowIso: string) => unknown[]][]) {
        const rows = (data: AppData) => new Map((data[table] ?? []).map((item) => [item.id, JSON.stringify(toRow(item as never, FIXED_NOW))]));
        const want = rows(merged);
        const have = rows(saved);
        if (want.size !== have.size || [...want].some(([id, row]) => have.get(id) !== row)) return table;
    }
    return comparableSettings(merged.settings) === comparableSettings(saved.settings) ? null : 'settings';
}
