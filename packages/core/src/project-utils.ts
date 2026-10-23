import type { Project, ProjectFlowMode, Section, Task, TaskSortBy } from './types';
import { isTaskActionable } from './task-status';
// task-utils imports this file too; both only call across at run time, so the cycle is safe.
import { getProjectFlowMode, getSequentialFirstTaskIds, getTaskSequencing, getTaskSequenceKey, isSequentialChainStatus } from './task-utils';

export function normalizeProjectSequentialScope(value: unknown): Project['sequentialScope'] {
    if (value === 'section' || value === 'project') return value;
    return undefined;
}

/** Every task sort mode a project may store, including 'default' (= manual project order).
 *  Wire-level allowlist: the cloud server validates project taskSortBy against this, so it
 *  must stay a superset of what any client can persist on a project. 'priority' is left out
 *  on purpose: it is a shared-list sort only (settings.taskSortBy), because older clients
 *  normalize an unknown project sort to undefined and would erase it (#1415). */
export const TASK_SORT_BY_VALUES = [
    'default', 'due', 'start', 'review', 'title', 'timeEstimate', 'created', 'created-desc', 'completed',
] as const;

/** Task sorts a project never stores; see TASK_SORT_BY_VALUES. */
type SharedListOnlyTaskSortBy = 'priority';

export const TASK_SORT_BY_VALUE_SET: ReadonlySet<TaskSortBy> =
    new Set<TaskSortBy>(TASK_SORT_BY_VALUES);

// Compile-time exhaustiveness assertion: adding a member to the TaskSortBy
// union in types.ts without updating TASK_SORT_BY_VALUES (or naming it shared-list
// only) is a typecheck error.
type _TaskSortByValuesAreExhaustive =
    Exclude<TaskSortBy, (typeof TASK_SORT_BY_VALUES)[number] | SharedListOnlyTaskSortBy> extends never ? true : never;
const _assertTaskSortByValuesAreExhaustive: _TaskSortByValuesAreExhaustive = true;
void _assertTaskSortByValuesAreExhaustive;

// 'default' means "no explicit sort" — normalizing it to undefined is what
// keeps sync signatures stable between a client that writes 'default' and
// one that omits the field (sync-signatures.ts:158).
const PROJECT_TASK_SORT_BY_VALUES = new Set<TaskSortBy>(
    TASK_SORT_BY_VALUES.filter((value) => value !== 'default'),
);

export function normalizeProjectTaskSortBy(value: unknown): TaskSortBy | undefined {
    if (typeof value === 'string' && PROJECT_TASK_SORT_BY_VALUES.has(value as TaskSortBy)) {
        return value as TaskSortBy;
    }
    return undefined;
}

const compareProjectSections = (a: Section, b: Section): number => {
    const aOrder = Number.isFinite(a.order) ? a.order : 0;
    const bOrder = Number.isFinite(b.order) ? b.order : 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.title.localeCompare(b.title);
};

/**
 * Sections shown inside one project workspace.
 *
 * Active projects use the normal visible projection. Archiving a project
 * intentionally tombstones its then-visible sections so sync and Reactivate
 * remain reversible; an archived historical workspace may read those marked
 * tombstones from the all-entity collection without changing their state.
 * Sections deleted before the project archive remain omitted.
 */
export function getProjectSectionsForView(
    project: Pick<Project, 'id' | 'status'> | null | undefined,
    visibleSections: readonly Section[],
    allSections: readonly Section[] = visibleSections,
): Section[] {
    if (!project) return [];
    const archivedHistory = project.status === 'archived';
    const source = archivedHistory ? allSections : visibleSections;
    return source
        .filter((section) => {
            if (section.projectId !== project.id) return false;
            if (!section.deletedAt) return true;
            return archivedHistory
                && section.projectArchivedAt === section.deletedAt
                && section.deletedAtBeforeProjectArchive == null;
        })
        .sort(compareProjectSections);
}

export type ProjectFlowModeChange = {
    project: Pick<Project, 'isSequential'> & Partial<Pick<Project, 'perSectionFlow'>>;
    /** Sections that get a stored choice now; every other section is left as it is. */
    sections: Array<{ id: string; isSequential: boolean }>;
};

/**
 * The writes that switch a project's Flow mode (#1429), or null when it is
 * already in that mode.
 * - Sequential keeps the stored within/across sections choice.
 * - Leaving Per section writes perSectionFlow false (never absent), so the
 *   old-client keep rule in sync cannot bring it back.
 * - Entering Per section gives every live section without a stored choice an
 *   explicit one: Sequential from "Sequential, within sections", Parallel from any
 *   other mode. Nothing changes for the user, and a later trip through "within
 *   sections" cannot flip those sections to Sequential.
 * - Stored section choices are never touched; they come back on return.
 */
export function planProjectFlowModeChange(
    project: Pick<Project, 'id' | 'isSequential' | 'perSectionFlow' | 'sequentialScope'>,
    sections: readonly Section[],
    mode: ProjectFlowMode,
): ProjectFlowModeChange | null {
    const current = getProjectFlowMode(project);
    if (current === mode) return null;
    if (mode !== 'perSection') {
        return {
            project: { isSequential: mode === 'sequential', ...(project.perSectionFlow === true ? { perSectionFlow: false } : {}) },
            sections: [],
        };
    }
    const fromWithinSections = current === 'sequential'
        && normalizeProjectSequentialScope(project.sequentialScope) === 'section';
    return {
        project: { isSequential: false, perSectionFlow: true },
        sections: sections
            .filter((section) => section.projectId === project.id && !section.deletedAt && section.isSequential === undefined)
            .map((section) => ({ id: section.id, isSequential: fromWithinSections })),
    };
}

export type ProjectSequenceTaskCue = 'available' | 'later';

/**
 * The "available next" / "later in sequence" cue on a sequential project's
 * Next tasks: the task's turn in the sequence. The available task is the one
 * getSequentialFirstTaskIds picks (the Next list's rule, also used by Review:
 * manual order within section order, and a waiting step holds its slot), so
 * the cue never depends on the order the caller lists the tasks in. Pass the
 * project's sections so section order ranks as it does there.
 *
 * Focus is different on purpose: getFocusSequentialFirstTaskIds lets a task
 * due today or starred take the project's Focus slot out of turn, so Focus
 * may show a task this cue marks "later".
 */
export function getSequentialProjectTaskCues(
    project: Pick<Project, 'id' | 'isSequential' | 'sequentialScope' | 'perSectionFlow'> | null | undefined,
    tasks: readonly Task[],
    sections: readonly Section[],
): Map<string, ProjectSequenceTaskCue> {
    const cues = new Map<string, ProjectSequenceTaskCue>();
    if (!project || getProjectFlowMode(project) === 'parallel') return cues;

    // Per section (#1429): only tasks in a Sequential section get a cue.
    const sequencing = getTaskSequencing([{ ...project, deletedAt: undefined,
        sequentialScope: normalizeProjectSequentialScope(project.sequentialScope) }], sections);
    const firstTaskIds = getSequentialFirstTaskIds(
        tasks.filter((task) => !task.deletedAt && isSequentialChainStatus(task.status)),
        sequencing.sequentialProjectIds,
        {
            sectionScopedProjectIds: sequencing.sectionScopedProjectIds,
            sequentialSectionKeys: sequencing.sequentialSectionKeys,
            sections,
        },
    );
    tasks.forEach((task) => {
        if (task.deletedAt || task.status !== 'next' || task.projectId !== project.id) return;
        if (getTaskSequenceKey(task, sequencing) === null) return;
        cues.set(task.id, firstTaskIds.has(task.id) ? 'available' : 'later');
    });

    return cues;
}

const getTaskProjectOrder = (task: Task): number => {
    if (Number.isFinite(task.order)) return task.order as number;
    if (Number.isFinite(task.orderNum)) return task.orderNum as number;
    return Number.POSITIVE_INFINITY;
};

const isOpenProjectTask = (task: Task): boolean => {
    return !task.deletedAt && isTaskActionable(task);
};

export function isSelectableProjectForTaskAssignment(project: Project): boolean {
    const status = String(project.status);
    return !project.deletedAt && status !== 'archived' && status !== 'completed';
}

export function findSelectableProjectByTitleAndArea(
    projects: readonly Project[],
    title: string,
    areaId?: string
): Project | undefined {
    const normalizedTitle = title.trim().toLowerCase();
    if (!normalizedTitle) return undefined;
    const targetAreaId = areaId ?? undefined;
    return projects.find((project) => (
        isSelectableProjectForTaskAssignment(project)
        && typeof project.title === 'string'
        && project.title.trim().toLowerCase() === normalizedTitle
        && (project.areaId ?? undefined) === targetAreaId
    ));
}

export function isTaskInActiveProject(
    task: Task,
    projectLookup: Map<string, Project> | Record<string, Project>
): boolean {
    if (!task.projectId) return true;
    const project =
        projectLookup instanceof Map
            ? projectLookup.get(task.projectId)
            : projectLookup[task.projectId];
    if (!project) return true;
    if (project.deletedAt) return false;
    return project.status === 'active' || project.isFocused === true;
}

/**
 * Project visibility for the Calendar's completed look-back (#955).
 *
 * Historical tasks from an archived project still describe work that happened,
 * while tasks in deferred projects do not belong on the active calendar.
 * Missing projects retain the existing loose-task behavior; deleted projects
 * remain hidden.
 */
export function isTaskInCalendarHistoryProject(
    task: Task,
    projectLookup: Map<string, Project> | Record<string, Project>
): boolean {
    if (!task.projectId) return true;
    const project =
        projectLookup instanceof Map
            ? projectLookup.get(task.projectId)
            : projectLookup[task.projectId];
    if (!project) return true;
    if (project.deletedAt) return false;
    return project.status === 'active' || project.status === 'archived' || project.isFocused === true;
}

export function projectHasNextAction(project: Project, tasks: Task[], excludeTaskId?: string): boolean {
    return tasks.some(t =>
        t.id !== excludeTaskId &&
        t.projectId === project.id &&
        !t.deletedAt &&
        t.status === 'next'
    );
}

export function filterProjectsNeedingNextAction(projects: Project[], tasks: Task[]): Project[] {
    return projects.filter(p => p.status === 'active' && !p.deletedAt && !projectHasNextAction(p, tasks));
}

export function getProjectNextActionCandidates(
    projectId: string,
    tasks: Task[],
    excludeTaskId?: string
): Task[] {
    return tasks
        .filter((task) => (
            task.id !== excludeTaskId &&
            task.projectId === projectId &&
            isOpenProjectTask(task) &&
            task.status !== 'next'
        ))
        .sort((a, b) => {
            const orderDiff = getTaskProjectOrder(a) - getTaskProjectOrder(b);
            if (Number.isFinite(orderDiff) && orderDiff !== 0) return orderDiff;
            const createdDiff = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
            if (createdDiff !== 0) return createdDiff;
            return a.title.localeCompare(b.title);
        });
}

export function getProjectNextActionPromptData(
    completedTask: Task,
    tasks: Task[],
    projects: Project[],
    /** Needed only for Per section projects; without it they prompt per project. */
    sections?: readonly Section[],
): { project: Project; candidates: Task[]; scope: 'project' | 'section' } | null {
    if (!completedTask.projectId || completedTask.deletedAt || completedTask.status !== 'done') {
        return null;
    }

    const project = projects.find((candidate) => candidate.id === completedTask.projectId);
    if (!project || project.deletedAt || project.status !== 'active') {
        return null;
    }

    if (!projectHasNextAction(project, tasks, completedTask.id)) {
        return {
            project,
            candidates: getProjectNextActionCandidates(project.id, tasks, completedTask.id),
            scope: 'project',
        };
    }

    // Section-scoped sequential projects run one sequence per section, so a
    // section left without a next action is stalled even while other sections
    // still have live next actions (#911).
    // A Sequential section of a Per section project is its own sequence too (#1429).
    const completedSection = completedTask.sectionId
        ? sections?.find((section) => section.id === completedTask.sectionId && section.projectId === project.id)
        : undefined;
    if ((project.isSequential && normalizeProjectSequentialScope(project.sequentialScope) === 'section')
        || (getProjectFlowMode(project) === 'perSection' && completedSection?.isSequential === true
            && !completedSection.deletedAt)) {
        const sectionKey = completedTask.sectionId ?? undefined;
        const inSameSection = (task: Task) => (task.sectionId ?? undefined) === sectionKey;
        const sectionHasNext = tasks.some((task) =>
            task.id !== completedTask.id &&
            task.projectId === project.id &&
            !task.deletedAt &&
            task.status === 'next' &&
            inSameSection(task)
        );
        if (!sectionHasNext) {
            return {
                project,
                candidates: getProjectNextActionCandidates(project.id, tasks, completedTask.id).filter(inSameSection),
                scope: 'section',
            };
        }
    }

    return null;
}

export function shouldPromptForProjectNextAction(
    completedTask: Task,
    tasks: Task[],
    projects: Project[],
    sections?: readonly Section[],
): boolean {
    return getProjectNextActionPromptData(completedTask, tasks, projects, sections) !== null;
}

export function getProjectsByArea(projects: Project[], areaId: string): Project[] {
    return projects
        .filter(p => !p.deletedAt && p.areaId === areaId)
        .sort((a, b) => a.title.localeCompare(b.title));
}

export function filterProjectsBySelectedArea(projects: Project[], selectedAreaId?: string): Project[] {
    return projects.filter((project) => {
        if (!isSelectableProjectForTaskAssignment(project)) return false;
        if (!selectedAreaId) return true;
        return project.areaId === selectedAreaId;
    });
}

export type ProjectChoiceState = {
    filteredProjects: Project[];
    exactMatch?: Project;
    canCreate: boolean;
};

/** The mobile project pickers' order: each project's `order` (0 when unset); ties keep the order they came in. */
export const compareProjectsByPickerOrder = (a: Project, b: Project): number =>
    (Number.isFinite(a.order) ? a.order : 0) - (Number.isFinite(b.order) ? b.order : 0);

export function getProjectChoiceState(
    browseProjects: readonly Project[],
    query: string,
    searchProjects: readonly Project[] = browseProjects,
): ProjectChoiceState {
    const normalizedQuery = query.trim().toLowerCase();
    const selectableBrowseProjects = browseProjects.filter(isSelectableProjectForTaskAssignment);
    if (!normalizedQuery) {
        return { filteredProjects: selectableBrowseProjects, canCreate: false };
    }

    const selectableSearchProjects = searchProjects.filter(isSelectableProjectForTaskAssignment);
    const normalizedTitle = (project: Project) => project.title.trim().toLowerCase();
    const exactMatch = selectableSearchProjects.find((project) => normalizedTitle(project) === normalizedQuery);
    return {
        filteredProjects: selectableSearchProjects.filter((project) => normalizedTitle(project).includes(normalizedQuery)),
        exactMatch,
        canCreate: !exactMatch,
    };
}

export const getProjectsByTag = (projects: Project[], tagId: string): Project[] => {
    return projects
        .filter(p => !p.deletedAt && (p.tagIds || []).includes(tagId))
        .sort((a, b) => a.title.localeCompare(b.title));
};
