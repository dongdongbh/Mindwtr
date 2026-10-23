import type { Project, Section, Task } from './types';
import type { TaskStore } from './store-types';
import { ensureDeviceId, createProjectOrderReserver, nextRevision } from './store-helpers';
import { compareTasksByProjectOrder, getProjectFlowMode } from './task-utils';
import { projectSectionOrderMax, buildNewSection, sameSectionDeleteJson } from './store-projects/section-actions';
import { generateUUID } from './uuid';
import { buildTaskMovePatch } from './task-container-rules';

type ConversionState = Pick<TaskStore, '_allProjects' | '_allSections' | '_allTasks'>;
type PreparationState = ConversionState & Pick<TaskStore, 'settings'>;

export type ProjectToSectionBlockReason =
    | 'missing-source' | 'source-inactive' | 'source-sequential' | 'source-sections'
    | 'source-attachments' | 'source-dates' | 'source-tags' | 'source-focus'
    | 'source-sort' | 'source-view-sections' | 'source-lifecycle'
    | 'same-project' | 'missing-destination' | 'destination-inactive'
    | 'destination-sequential' | 'destination-section-sequence' | 'invalid-title';

export type ProjectToSectionPreview = {
    ok: true;
    sourceTitle: string;
    destinationTitle: string;
    defaultTitle: string;
    taskCount: number;
    completedCount: number;
    archivedCount: number;
    colorWillBeLost: true;
};

type Blocked = { ok: false; reason: ProjectToSectionBlockReason };
type RowChange<T> = { before: T; after: T };

/** Frozen confirmation authority and exact retry footprint. No synced receipt field. */
export type PreparedProjectToSection = {
    sourceProjectId: string;
    destinationProjectId: string;
    sectionId: string;
    preview: ProjectToSectionPreview;
    source: RowChange<Project>;
    destination: Project;
    sourceSections: Section[];
    destinationSections: Section[];
    sourceTasks: Task[];
    destinationTasks: Task[];
    section: Section;
    tasks: RowChange<Task>[];
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    preparedAt: string;
};

export type ProjectToSectionReceipt = PreparedProjectToSection;
export type ProjectToSectionPreparation = Blocked | { ok: true;
    preview: ProjectToSectionPreview; command: PreparedProjectToSection };

/** Preserve array order, including checklist order; compare object member order independently. */
export const sameProjectToSectionValue = sameSectionDeleteJson;

const oneProject = (projects: readonly Project[], id: string): Project | undefined => {
    const matches = projects.filter((project) => project.id === id);
    return matches.length === 1 ? matches[0] : undefined;
};

export const getProjectToSectionEligibility = (state: ConversionState, sourceProjectId: string):
    { ok: true } | Blocked => {
    const source = oneProject(state._allProjects, sourceProjectId);
    if (!source) return { ok: false, reason: 'missing-source' };
    if (source.deletedAt || source.purgedAt || source.status !== 'active')
        return { ok: false, reason: 'source-inactive' };
    if (state._allSections.some((section) => section.projectId === source.id && !section.deletedAt))
        return { ok: false, reason: 'source-sections' };
    if (source.attachments?.some((attachment) => !attachment.deletedAt))
        return { ok: false, reason: 'source-attachments' };
    if (source.startDate || source.dueDate || source.reviewAt)
        return { ok: false, reason: 'source-dates' };
    if (source.tagIds?.length) return { ok: false, reason: 'source-tags' };
    if (source.isFocused) return { ok: false, reason: 'source-focus' };
    if (source.taskSortBy && source.taskSortBy !== 'default')
        return { ok: false, reason: 'source-sort' };
    if (source.viewSectionIds && Object.values(source.viewSectionIds).some(Boolean))
        return { ok: false, reason: 'source-view-sections' };
    if (source.archivedAt || source.cancelledAt)
        return { ok: false, reason: 'source-lifecycle' };
    if (state._allTasks.some((task) => task.projectId === source.id && !task.deletedAt && !task.purgedAt
        && (task.projectArchivedAt || task.statusBeforeProjectArchive !== undefined
            || task.completedAtBeforeProjectArchive !== undefined
            || task.isFocusedTodayBeforeProjectArchive !== undefined)))
        return { ok: false, reason: 'source-lifecycle' };
    return { ok: true };
};

const destinationBlock = (source: Project, destination: Project | undefined): Blocked | null => {
    if (!destination) return { ok: false, reason: 'missing-destination' };
    if (destination.deletedAt || destination.purgedAt || destination.status !== 'active'
        || destination.archivedAt || destination.cancelledAt)
        return { ok: false, reason: 'destination-inactive' };
    // A sequence survives as a section sequence: "Sequential, within sections", or a
    // Per section destination where the new section becomes Sequential (#1429).
    if (source.isSequential) {
        if (getProjectFlowMode(destination) !== 'perSection'
            && (!destination.isSequential || destination.sequentialScope !== 'section'))
            return { ok: false, reason: 'destination-section-sequence' };
    } else if (destination.isSequential) return { ok: false, reason: 'destination-sequential' };
    return null;
};

export const previewProjectToSection = (state: ConversionState, sourceProjectId: string,
    destinationProjectId: string): ProjectToSectionPreview | Blocked => {
    const eligible = getProjectToSectionEligibility(state, sourceProjectId);
    if (!eligible.ok) return eligible;
    if (sourceProjectId === destinationProjectId) return { ok: false, reason: 'same-project' };
    const source = oneProject(state._allProjects, sourceProjectId)!;
    const destination = oneProject(state._allProjects, destinationProjectId);
    const blocked = destinationBlock(source, destination);
    if (blocked) return blocked;
    const tasks = state._allTasks.filter((task) => task.projectId === source.id && !task.deletedAt && !task.purgedAt);
    return { ok: true, sourceTitle: source.title, destinationTitle: destination!.title,
        defaultTitle: source.title, taskCount: tasks.length,
        completedCount: tasks.filter((task) => task.status === 'done').length,
        archivedCount: tasks.filter((task) => task.status === 'archived').length,
        colorWillBeLost: true };
};

/**
 * Destination-list form of previewProjectToSection: checks the source and counts its tasks once,
 * so each destination costs one lookup instead of a scan of every project, section, and task.
 * Each call returns what previewProjectToSection(state, sourceProjectId, destinationProjectId) returns.
 */
export const createProjectToSectionPreviewer = (state: ConversionState, sourceProjectId: string):
    ((destinationProjectId: string) => ProjectToSectionPreview | Blocked) => {
    const eligible = getProjectToSectionEligibility(state, sourceProjectId);
    if (!eligible.ok) return () => ({ ...eligible });
    // null marks a duplicated id, which oneProject treats as missing.
    const projects = new Map<string, Project | null>();
    for (const project of state._allProjects) projects.set(project.id, projects.has(project.id) ? null : project);
    const source = projects.get(sourceProjectId)!;
    let taskCount = 0;
    let completedCount = 0;
    let archivedCount = 0;
    for (const task of state._allTasks) {
        if (task.projectId !== source.id || task.deletedAt || task.purgedAt) continue;
        taskCount += 1;
        if (task.status === 'done') completedCount += 1;
        else if (task.status === 'archived') archivedCount += 1;
    }
    return (destinationProjectId) => {
        if (sourceProjectId === destinationProjectId) return { ok: false, reason: 'same-project' };
        const destination = projects.get(destinationProjectId) ?? undefined;
        const blocked = destinationBlock(source, destination);
        if (blocked) return blocked;
        return { ok: true, sourceTitle: source.title, destinationTitle: destination!.title,
            defaultTitle: source.title, taskCount, completedCount, archivedCount, colorWillBeLost: true };
    };
};

/** Deterministic planner; generated identity and clock are supplied by prepare. */
export const planProjectToSection = (state: PreparationState, sourceProjectId: string,
    destinationProjectId: string, title: string, sectionId: string, preparedAt: string,
    deviceIdBefore: string | null, deviceIdToInitialize: string | null): ProjectToSectionPreparation => {
    const preview = previewProjectToSection(state, sourceProjectId, destinationProjectId);
    if (!preview.ok) return preview;
    const sectionTitle = title.trim();
    if (!sectionTitle) return { ok: false, reason: 'invalid-title' };
    const source = oneProject(state._allProjects, sourceProjectId)!;
    const destination = oneProject(state._allProjects, destinationProjectId)!;
    const deviceId = deviceIdBefore ?? deviceIdToInitialize;
    if (!deviceId || state._allSections.some((section) => section.id === sectionId))
        return { ok: false, reason: 'invalid-title' };
    const sourceSections = state._allSections.filter((section) => section.projectId === source.id);
    const destinationSections = state._allSections.filter((section) => section.projectId === destination.id);
    const sourceTasks = state._allTasks.filter((task) => task.projectId === source.id);
    const destinationTasks = state._allTasks.filter((task) => task.projectId === destination.id);
    const liveTasks = sourceTasks.filter((task) => !task.deletedAt && !task.purgedAt)
        .sort(compareTasksByProjectOrder);
    const reserveOrder = createProjectOrderReserver(state._allTasks);
    const section = buildNewSection({ id: sectionId, projectId: destination.id, title: sectionTitle,
        initialProps: { description: source.supportNotes,
            ...(getProjectFlowMode(destination) === 'perSection' ? { isSequential: source.isSequential === true } : {}) },
        orderMax: projectSectionOrderMax(state._allSections, destination.id), deviceId, now: preparedAt });
    const assignment = buildTaskMovePatch({ kind: 'project', id: destination.id },
        { projectId: destination.id, sectionId: section.id });
    const tasks = liveTasks.map((before) => {
        const order = reserveOrder(destination.id);
        return { before, after: { ...before, ...assignment, order, orderNum: order,
            updatedAt: preparedAt, rev: nextRevision(before.rev), revBy: deviceId } };
    });
    const command: PreparedProjectToSection = {
        sourceProjectId: source.id, destinationProjectId: destination.id, sectionId: section.id,
        preview, source: { before: source, after: { ...source, deletedAt: preparedAt,
            updatedAt: preparedAt, rev: nextRevision(source.rev), revBy: deviceId } },
        destination, sourceSections, destinationSections, sourceTasks, destinationTasks,
        section, tasks, deviceIdBefore, deviceIdToInitialize, preparedAt,
    };
    // A prepared dialog can outlive a store update; never retain mutable store row references.
    return { ok: true, preview, command: JSON.parse(JSON.stringify(command)) as PreparedProjectToSection };
};

export const prepareProjectToSection = (state: PreparationState, sourceProjectId: string,
    destinationProjectId: string, title: string): ProjectToSectionPreparation => {
    const device = ensureDeviceId(state.settings);
    return planProjectToSection(state, sourceProjectId, destinationProjectId, title,
        generateUUID(), new Date().toISOString(), state.settings.deviceId ?? null,
        device.updated ? device.deviceId : null);
};
