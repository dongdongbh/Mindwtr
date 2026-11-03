import type { Area, Project, ProjectFlowMode, Section, Task, TaskSortBy } from './types';
import { isTaskActionable } from './task-status';

import { compareAreasByOrder, compareProjectsByOrder, getProjectFlowMode, getSequentialFirstTaskIds, getTaskSequencing, getTaskSequenceKey, isSequentialChainStatus } from './task-utils';

export function normalizeProjectSequentialScope(value: unknown): Project['sequentialScope'] {
    if (value === 'section' || value === 'project') return value;
    return undefined;
}


export const TASK_SORT_BY_VALUES = [
    'default', 'due', 'start', 'review', 'title', 'timeEstimate', 'created', 'created-desc', 'completed',
] as const;


type SharedListOnlyTaskSortBy = 'priority';

export const TASK_SORT_BY_VALUE_SET: ReadonlySet<TaskSortBy> =
    new Set<TaskSortBy>(TASK_SORT_BY_VALUES);


type _TaskSortByValuesAreExhaustive =
    Exclude<TaskSortBy, (typeof TASK_SORT_BY_VALUES)[number] | SharedListOnlyTaskSortBy> extends never ? true : never;
const _assertTaskSortByValuesAreExhaustive: _TaskSortByValuesAreExhaustive = true;
void _assertTaskSortByValuesAreExhaustive;


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

    sections: Array<{ id: string; isSequential: boolean }>;
};


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


export function getSequentialProjectTaskCues(
    project: Pick<Project, 'id' | 'isSequential' | 'sequentialScope' | 'perSectionFlow'> | null | undefined,
    tasks: readonly Task[],
    sections: readonly Section[],
): Map<string, ProjectSequenceTaskCue> {
    const cues = new Map<string, ProjectSequenceTaskCue>();
    if (!project || getProjectFlowMode(project) === 'parallel') return cues;


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


type PickerProject = Pick<Project, 'title'> & Partial<Pick<Project, 'status' | 'areaId' | 'order'>>;

export function groupProjectsForPicker<T extends PickerProject>(
    projects: readonly T[],
    areas: readonly Area[],
): { active: T[]; deferred: T[] } {
    const areaRank = new Map(areas.filter((area) => !area.deletedAt).sort(compareAreasByOrder).map((area, index) => [area.id, index]));
    const rankOf = (project: PickerProject) => (project.areaId ? areaRank.get(project.areaId) : undefined) ?? areaRank.size;
    const sorted = [...projects].sort((a, b) => rankOf(a) - rankOf(b) || compareProjectsByOrder(a, b));
    const active: T[] = [];
    const deferred: T[] = [];
    for (const project of sorted) {
        (project.status === 'someday' || project.status === 'waiting' ? deferred : active).push(project);
    }
    return { active, deferred };
}


export function sortProjectsForPicker<T extends PickerProject>(projects: readonly T[], areas: readonly Area[]): T[] {
    const { active, deferred } = groupProjectsForPicker(projects, areas);
    return [...active, ...deferred];
}

export const getProjectsByTag = (projects: Project[], tagId: string): Project[] => {
    return projects
        .filter(p => !p.deletedAt && (p.tagIds || []).includes(tagId))
        .sort((a, b) => a.title.localeCompare(b.title));
};
