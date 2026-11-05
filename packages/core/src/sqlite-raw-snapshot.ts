import type { AppData, Area, SavedFilter, Task, Project } from './types';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from './task-sync-schema';
import { PROJECT_SQLITE_COLUMNS, projectToSqliteRow } from './project-sync-schema';
import { AREA_SQLITE_COLUMNS, areaToSqliteRow } from './area-sync-schema';
import { isRecord, toJson } from './entity-sync-schema';

type TaskRowEntry = { row: unknown[]; fingerprint: string };


const rawReadRowEntries = new WeakMap<object, TaskRowEntry & { projection: string }>();
const rawReadSettings = new WeakMap<AppData['settings'], { projection: string; json: string | null }>();
export const rememberRawReadRow = (entity: object, row: Record<string, unknown>, columns: readonly string[], projection: unknown[]) => {
    const values = columns.map((column) => row[column]);
    rawReadRowEntries.set(entity, { row: values, fingerprint: JSON.stringify(values), projection: JSON.stringify(projection) });
};
export const rawReadRow = (entity: object, projection: unknown[]): TaskRowEntry => {
    const cached = rawReadRowEntries.get(entity); const fingerprint = JSON.stringify(projection);
    if (cached?.projection === fingerprint) return cached;
    const entry = { row: projection, fingerprint, projection: fingerprint };
    if (cached) rawReadRowEntries.set(entity, entry);
    return entry;
};

export const rawReadTaskSnapshot = (task: Task): Task | null => {
    const snapshot = JSON.parse(JSON.stringify(task)) as Task;
    const entry = rawReadRowEntries.get(task);
    if (!entry || entry.projection !== JSON.stringify(taskToSqliteRow(task))) return snapshot;
    try {
        for (const field of ['recurrence', 'tags', 'contexts', 'checklist', 'attachments', 'viewSectionIds'] as const) {
            const value = entry.row[TASK_SQLITE_COLUMNS.indexOf(field)];
            if (value === null || value === undefined) delete snapshot[field];
            else Object.assign(snapshot, { [field]: JSON.parse(String(value)) });
        }
        return snapshot;
    } catch { return null; }
};

export const rawReadProjectSnapshot = (project: Project): Project | null => {
    const snapshot = JSON.parse(JSON.stringify(project)) as Project;
    const entry = rawReadRowEntries.get(project);
    if (!entry || entry.projection !== JSON.stringify(projectToSqliteRow(project))) return snapshot;
    try {
        for (const field of ['tagIds', 'attachments', 'viewSectionIds'] as const) {
            const value = entry.row[PROJECT_SQLITE_COLUMNS.indexOf(field)];
            if (value === null || value === undefined) delete snapshot[field];
            else Object.assign(snapshot, { [field]: JSON.parse(String(value)) });
        }
        return snapshot;
    } catch { return null; }
};

export const rawReadAreaSnapshot = (area: Area): Area => {
    const snapshot = JSON.parse(JSON.stringify(area)) as Area;
    const entry = rawReadRowEntries.get(area);
    if (!entry || entry.projection !== JSON.stringify(areaToSqliteRow(area, ''))) return snapshot;
    for (const field of ['createdAt', 'updatedAt'] as const)
        snapshot[field] = entry.row[AREA_SQLITE_COLUMNS.indexOf(field)] as string;
    return snapshot;
};
export const savedFilterSqliteRow = (filter: SavedFilter): unknown[] => {
    const textOr = <T>(value: unknown, fallback: T) => typeof value === 'string' ? value : fallback;
    return [filter.id, textOr(filter.name, ''), textOr(filter.icon, null), textOr(filter.view, ''),
        toJson(filter.criteria ?? {}), textOr(filter.sortBy, null), textOr(filter.sortOrder, null),
        textOr(filter.groupBy, null), textOr(filter.createdAt, ''), textOr(filter.updatedAt, ''), textOr(filter.deletedAt, null)];
};

export const retainRawReadSettingsSnapshot = (source: AppData['settings'], sanitized: AppData['settings']): void => {
    const settings = rawReadSettings.get(source);
    if (settings && JSON.stringify(source) === settings.projection && JSON.stringify(sanitized) === settings.projection)
        rawReadSettings.set(sanitized, settings);


    const sourceFilters = Array.isArray(source?.savedFilters) ? source.savedFilters : [];
    if (!sourceFilters.some((filter) => isRecord(filter) && rawReadRowEntries.has(filter))) return;
    const clones = Array.isArray(sanitized?.savedFilters) ? sanitized.savedFilters : [];
    const filters = new Map(clones.filter((filter) => isRecord(filter) && typeof filter.id === 'string').map((filter) => [filter.id, filter]));
    for (const filter of sourceFilters) {
        if (!isRecord(filter)) continue;
        const captured = rawReadRowEntries.get(filter); const clone = filters.get(filter.id);
        if (captured && clone && captured.projection === JSON.stringify(savedFilterSqliteRow(filter))
            && captured.projection === JSON.stringify(savedFilterSqliteRow(clone))) rawReadRowEntries.set(clone, captured);
    }
};

export const hasRawReadRow = (entity: object): boolean => rawReadRowEntries.has(entity);
export const rememberRawReadSettings = (settings: AppData['settings'], json: string | null): void => {
    rawReadSettings.set(settings, { projection: JSON.stringify(settings), json });
};
export const rawReadSettingsJson = (settings: AppData['settings'], projection: string | null): string | null | undefined => {
    const captured = rawReadSettings.get(settings);
    return captured?.projection === projection ? captured.json : undefined;
};
