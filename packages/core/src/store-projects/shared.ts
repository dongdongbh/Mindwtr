import type { AppData, Area, Person, Project, Section, Task, TaskStatus } from '../types';
import type { StoreActionResult, TaskStore } from '../store-types';
import {
    ensureDeviceId,
    getNextDataChangeAt,
    nextRevision,
    normalizeTagId,
    persist,
    replaceEntitiesInArray,
} from '../store-helpers';

export type ProjectActions = Pick<
    TaskStore,
    | 'addProject'
    | 'commitPreparedProjectCreate'
    | 'commitPreparedProjectFocus'
    | 'commitPreparedProjectRename'
    | 'commitPreparedProjectFlow'
    | 'commitPreparedProjectTaskSort'
    | 'commitPreparedProjectNotesWrite'
    | 'commitPreparedProjectTagsWrite'
    | 'commitPreparedProjectAttachmentWrite'
    | 'commitPreparedProjectFileRemoveWrite'
    | 'commitPreparedProjectFileAddWrite'
    | 'commitSelectedProjectAvailability'
    | 'commitPreparedProjectFileAvailability'
    | 'commitPreparedProjectStatus'
    | 'commitPreparedTrashProjectRestore'
    | 'commitPreparedProjectDelete'
    | 'commitPreparedProjectDeleteUndo'
    | 'commitPreparedProjectDuplicate'
    | 'commitPreparedProjectLifecycle'
    | 'commitPreparedProjectDate'
    | 'commitPreparedProjectArea'
    | 'commitPreparedProjectSectionCreate'
    | 'commitPreparedProjectSectionRename'
    | 'commitPreparedProjectSectionDelete'
    | 'commitPreparedProjectSectionOrder'
    | 'commitPreparedProjectTaskOrder'
    | 'commitPreparedAreaCreate'
    | 'commitPreparedAreaColor'
    | 'commitPreparedAreaRename'
    | 'commitPreparedAreaOrder'
    | 'commitPreparedAreaDelete'
    | 'commitPreparedTaxonomy'
    | 'updateProject'
    | 'cancelProject'
    | 'deleteProject'
    | 'restoreProject'
    | 'purgeProject'
    | 'purgeDeletedProjects'
    | 'duplicateProject'
    | 'toggleProjectFocus'
    | 'convertProjectToSection'
    | 'undoProjectToSection'
    | 'addSection'
    | 'updateSection'
    | 'deleteSection'
    | 'reorderSections'
    | 'addArea'
    | 'updateArea'
    | 'deleteArea'
    | 'restoreArea'
    | 'reorderAreas'
    | 'reorderProjects'
    | 'reorderProjectTasks'
    | 'reorderBoardTasks'
    | 'addPerson'
    | 'commitPreparedPersonCreate'
    | 'commitPreparedPersonEdit'
    | 'commitPreparedPersonDelete'
    | 'updatePerson'
    | 'renamePerson'
    | 'deletePerson'
    | 'restorePerson'
    | 'deleteTag'
    | 'renameTag'
    | 'deleteContext'
    | 'renameContext'
>;

export type ProjectActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
    flushPendingSave: () => Promise<void>;
    getSaveGeneration: () => number;
};

export type ProjectCoreActions = Pick<
    ProjectActions,
    | 'addProject'
    | 'commitPreparedProjectCreate'
    | 'commitPreparedProjectFocus'
    | 'commitPreparedProjectRename'
    | 'commitPreparedProjectFlow'
    | 'commitPreparedProjectTaskSort'
    | 'commitPreparedProjectNotesWrite'
    | 'commitPreparedProjectTagsWrite'
    | 'commitPreparedProjectAttachmentWrite'
    | 'commitPreparedProjectFileRemoveWrite'
    | 'commitPreparedProjectFileAddWrite'
    | 'commitSelectedProjectAvailability'
    | 'commitPreparedProjectFileAvailability'
    | 'commitPreparedProjectStatus'
    | 'commitPreparedTrashProjectRestore'
    | 'commitPreparedProjectDelete'
    | 'commitPreparedProjectDeleteUndo'
    | 'commitPreparedProjectDuplicate'
    | 'commitPreparedProjectLifecycle'
    | 'commitPreparedProjectDate'
    | 'commitPreparedProjectArea'
    | 'updateProject'
    | 'cancelProject'
    | 'deleteProject'
    | 'restoreProject'
    | 'purgeProject'
    | 'purgeDeletedProjects'
    | 'duplicateProject'
    | 'toggleProjectFocus'
>;

export type SectionActions = Pick<ProjectActions, 'addSection' | 'commitPreparedProjectSectionCreate' | 'commitPreparedProjectSectionRename' | 'commitPreparedProjectSectionDelete' | 'updateSection' | 'deleteSection'>;
export type ProjectToSectionActions = Pick<ProjectActions, 'convertProjectToSection' | 'undoProjectToSection'>;

export type AreaActions = Pick<ProjectActions, 'addArea' | 'commitPreparedAreaCreate' | 'commitPreparedAreaColor' | 'commitPreparedAreaRename' | 'commitPreparedAreaOrder' | 'commitPreparedAreaDelete' | 'updateArea' | 'deleteArea' | 'restoreArea' | 'reorderAreas'>;

export type OrderingActions = Pick<ProjectActions, 'reorderProjects' | 'reorderProjectTasks' | 'reorderBoardTasks' | 'reorderSections' | 'commitPreparedProjectSectionOrder' | 'commitPreparedProjectTaskOrder'>;

export type PeopleActions = Pick<ProjectActions, 'addPerson' | 'commitPreparedPersonCreate' | 'commitPreparedPersonDelete' | 'commitPreparedPersonEdit' | 'updatePerson' | 'renamePerson' | 'deletePerson' | 'restorePerson'>;

export type TaxonomyActions = Pick<ProjectActions, 'deleteTag' | 'renameTag' | 'deleteContext' | 'renameContext' | 'commitPreparedTaxonomy'>;

export type { AppData, Area, Person, Project, Section, Task, TaskStatus };

export type DetachedProjectTask = { id: string; sectionId?: string };

/** RN Undo's eligible-current-Task rule, shared with the native prepared effect. */
export function projectDeleteUndoReattachments(projectId: string, links: readonly DetachedProjectTask[],
    sections: readonly Section[], tasks: readonly Task[]): { id: string; updates: Pick<Task, 'projectId' | 'sectionId'> }[] {
    const liveSectionIds = new Set(sections
        .filter((section) => section.projectId === projectId && !section.deletedAt)
        .map((section) => section.id));
    const linkById = new Map(links.map((link) => [link.id, link]));
    return tasks.filter((task) => linkById.has(task.id) && !task.deletedAt && !task.projectId && !task.areaId)
        .map((task) => {
            const sectionId = linkById.get(task.id)?.sectionId;
            return { id: task.id,
                updates: { projectId, sectionId: sectionId && liveSectionIds.has(sectionId) ? sectionId : undefined } };
        });
}

export const actionOk = (extra?: Omit<StoreActionResult, 'success'>): StoreActionResult => ({ success: true, ...extra });
export const actionFail = (error: string): StoreActionResult => ({ success: false, error });

type EntityCollection = 'projects' | 'sections' | 'areas' | 'people';

type EntityByCollection = {
    projects: Project;
    sections: Section;
    areas: Area;
    people: Person;
};

type MutateEntitiesOptions<K extends EntityCollection> = {
    collection: K;
    select: (state: TaskStore) => EntityByCollection[K][];
    buildUpdates: (
        entity: EntityByCollection[K],
        context: { now: string; state: TaskStore },
    ) => Partial<EntityByCollection[K]> | null;
    buildSettings?: (
        state: TaskStore,
        context: { now: string },
    ) => Partial<TaskStore['settings']> | undefined;
    missingMessage?: string;
};

const collectionStateKeys = {
    projects: '_allProjects',
    sections: '_allSections',
    areas: '_allAreas',
    people: '_allPeople',
} as const;

export const mutateEntities = async <K extends EntityCollection>(
    { set, debouncedSave }: Pick<ProjectActionContext, 'set' | 'debouncedSave'>,
    options: MutateEntitiesOptions<K>,
): Promise<StoreActionResult> => {
    const changeAt = Date.now();
    const now = new Date().toISOString();
    let missing = false;
    set((state) => {
        const selectedEntities = options.select(state);
        if (selectedEntities.length === 0) {
            missing = Boolean(options.missingMessage);
            return state;
        }
        const pendingUpdates = selectedEntities
            .map((entity) => ({
                entity,
                updates: options.buildUpdates(entity, { now, state }),
            }))
            .filter((entry) => entry.updates !== null);
        const settingsUpdates = options.buildSettings?.(state, { now });
        if (pendingUpdates.length === 0 && settingsUpdates === undefined) return state;

        const deviceState = ensureDeviceId(state.settings);
        const changedEntities = pendingUpdates.map(({ entity, updates }) => ({
            ...entity,
            ...updates,
            updatedAt: now,
            rev: nextRevision(entity.rev),
            revBy: deviceState.deviceId,
        })) as EntityByCollection[K][];
        const allKey = collectionStateKeys[options.collection];
        const allEntities = state[allKey] as EntityByCollection[K][];
        const nextAllEntities = replaceEntitiesInArray(allEntities, changedEntities);
        const nextSettings = settingsUpdates === undefined
            ? deviceState.settings
            : { ...deviceState.settings, ...settingsUpdates };
        const settingsChanged = settingsUpdates !== undefined || deviceState.updated;

        persist(set, debouncedSave, state, {
            [options.collection]: nextAllEntities,
            ...(settingsChanged ? { settings: nextSettings } : {}),
        });
        return {
            [allKey]: nextAllEntities,
            lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
            ...(settingsChanged ? { settings: nextSettings } : {}),
        } as Partial<TaskStore>;
    });
    return missing ? actionFail(options.missingMessage ?? 'Entity not found') : actionOk();
};

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
