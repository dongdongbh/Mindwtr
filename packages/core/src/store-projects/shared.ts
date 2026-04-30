import type { AppData, Area, Project, Section, Task, TaskStatus } from '../types';
import type { StoreActionResult, TaskStore } from '../store-types';
import { normalizeTagId } from '../store-helpers';

export type ProjectActions = Pick<
    TaskStore,
    | 'addProject'
    | 'updateProject'
    | 'deleteProject'
    | 'restoreProject'
    | 'duplicateProject'
    | 'toggleProjectFocus'
    | 'addSection'
    | 'updateSection'
    | 'deleteSection'
    | 'addArea'
    | 'updateArea'
    | 'deleteArea'
    | 'restoreArea'
    | 'reorderAreas'
    | 'reorderProjects'
    | 'reorderProjectTasks'
    | 'deleteTag'
    | 'renameTag'
    | 'deleteContext'
    | 'renameContext'
>;

export type ProjectActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
};

export type ProjectCoreActions = Pick<
    ProjectActions,
    | 'addProject'
    | 'updateProject'
    | 'deleteProject'
    | 'restoreProject'
    | 'duplicateProject'
    | 'toggleProjectFocus'
>;

export type SectionActions = Pick<ProjectActions, 'addSection' | 'updateSection' | 'deleteSection'>;

export type AreaActions = Pick<ProjectActions, 'addArea' | 'updateArea' | 'deleteArea' | 'restoreArea' | 'reorderAreas'>;

export type OrderingActions = Pick<ProjectActions, 'reorderProjects' | 'reorderProjectTasks'>;

export type TaxonomyActions = Pick<ProjectActions, 'deleteTag' | 'renameTag' | 'deleteContext' | 'renameContext'>;

export type { AppData, Area, Project, Section, Task, TaskStatus };

export const actionOk = (extra?: Omit<StoreActionResult, 'success'>): StoreActionResult => ({ success: true, ...extra });
export const actionFail = (error: string): StoreActionResult => ({ success: false, error });

export const formatTagIdPreservingCase = (value: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
};

export const dedupeTagValuesLastWins = (values: string[], preferredValue?: string): string[] => {
    const preferredNormalized = preferredValue ? normalizeTagId(preferredValue) : '';
    const seen = new Set<string>();
    const dedupedReversed: string[] = [];
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        const normalized = normalizeTagId(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        dedupedReversed.push(normalized === preferredNormalized ? preferredValue! : value);
    }
    return dedupedReversed.reverse();
};
