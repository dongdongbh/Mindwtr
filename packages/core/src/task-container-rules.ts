import type { AppData, Section, Task } from './types';

export type TaskContainerAssignment = {
    projectId?: string;
    sectionId?: string;
    areaId?: string;
};

export type TaskContainerResolution =
    | { ok: true; projectId?: string; sectionId?: string; areaId?: string }
    | { ok: false; error: string };

export type TaskContainerMovePatch = Partial<Pick<Task, 'projectId' | 'sectionId' | 'areaId' | 'order' | 'orderNum'>>;

export type TaskContainerOrderReserver = (projectId: string | undefined) => number | undefined;

const hasOwnField = (value: object, field: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, field);

export const normalizeOptionalContainerId = (value: unknown): string | undefined => (
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
);

export const validateExistingTaskProjectId = (
    projectId: unknown,
    allProjects: AppData['projects']
): { ok: true; projectId?: string } | { ok: false; error: string } => {
    const normalizedProjectId = normalizeOptionalContainerId(projectId);
    if (!normalizedProjectId) {
        return { ok: true, projectId: undefined };
    }
    const exists = allProjects.some((project) => project.id === normalizedProjectId && !project.deletedAt);
    if (exists) {
        return { ok: true, projectId: normalizedProjectId };
    }
    return { ok: false, error: 'Project not found' };
};

export const validateExistingTaskAreaId = (
    areaId: unknown,
    allAreas: AppData['areas']
): { ok: true; areaId?: string } | { ok: false; error: string } => {
    const normalizedAreaId = normalizeOptionalContainerId(areaId);
    if (!normalizedAreaId) {
        return { ok: true, areaId: undefined };
    }
    const exists = allAreas.some((area) => area.id === normalizedAreaId && !area.deletedAt);
    if (exists) {
        return { ok: true, areaId: normalizedAreaId };
    }
    return { ok: false, error: 'Area not found' };
};

export const resolveTaskContainerHierarchy = ({
    projectId,
    sectionId,
    areaId,
    sectionProjectId,
}: TaskContainerAssignment & { sectionProjectId?: string }): TaskContainerAssignment => {
    let nextProjectId = projectId;
    let nextSectionId = sectionId;
    let nextAreaId = areaId;

    if (nextSectionId) {
        if (!sectionProjectId) {
            nextSectionId = undefined;
        } else if (!nextProjectId) {
            nextProjectId = sectionProjectId;
            nextAreaId = undefined;
        } else if (sectionProjectId !== nextProjectId) {
            nextSectionId = undefined;
        }
    }

    if (nextAreaId && nextProjectId) {
        nextAreaId = undefined;
    }

    return {
        projectId: nextProjectId,
        sectionId: nextSectionId,
        areaId: nextAreaId,
    };
};

export type TaskMoveDestination =
    | { kind: 'none' }
    | { kind: 'project'; id: string }
    | { kind: 'area'; id: string };


export const buildTaskMovePatch = (
    destination: TaskMoveDestination,
    section?: { projectId?: string; sectionId?: string },
): { projectId: string | undefined; sectionId: string | undefined; areaId: string | undefined } => {
    if (destination.kind === 'project') {
        return {
            projectId: destination.id,
            sectionId: section?.projectId === destination.id ? section.sectionId : undefined,
            areaId: undefined,
        };
    }
    return {
        projectId: undefined,
        sectionId: undefined,
        areaId: destination.kind === 'area' ? destination.id : undefined,
    };
};

export const resolveTaskContainerAssignment = ({
    projectId,
    sectionId,
    areaId,
    allProjects,
    allSections,
    allAreas,
    isReactivatingProjectSection,
}: {
    projectId: unknown;
    sectionId: unknown;
    areaId: unknown;
    allProjects: AppData['projects'];
    allSections: AppData['sections'];
    allAreas: AppData['areas'];

    isReactivatingProjectSection?: (section: Readonly<Section>) => boolean;
}): TaskContainerResolution => {
    const projectValidation = validateExistingTaskProjectId(projectId, allProjects);
    if (!projectValidation.ok) return projectValidation;

    const resolvedProjectId = projectValidation.projectId;
    const resolvedSectionId = normalizeOptionalContainerId(sectionId);
    if (resolvedSectionId) {
        const section = allSections.find((candidate) => (
            candidate.id === resolvedSectionId
            && (!candidate.deletedAt || isReactivatingProjectSection?.(candidate))
        ));
        if (!section) {
            return { ok: false, error: 'Section not found' };
        }
        const liveProjectExists = allProjects.some((candidate) => candidate.id === section.projectId && !candidate.deletedAt);
        if (!liveProjectExists) {
            return { ok: false, error: 'Section not found' };
        }
        if (resolvedProjectId && section.projectId !== resolvedProjectId) {
            return { ok: false, error: 'Section does not belong to project' };
        }
        const resolved = resolveTaskContainerHierarchy({
            projectId: resolvedProjectId,
            sectionId: resolvedSectionId,
            areaId: areaId === undefined ? undefined : normalizeOptionalContainerId(areaId),
            sectionProjectId: section.projectId,
        });
        return {
            ok: true,
            projectId: resolved.projectId,
            sectionId: resolved.sectionId,
            areaId: resolved.areaId,
        };
    }

    if (resolvedProjectId) {
        const resolved = resolveTaskContainerHierarchy({
            projectId: resolvedProjectId,
            sectionId: undefined,
            areaId: areaId === undefined ? undefined : normalizeOptionalContainerId(areaId),
        });
        return {
            ok: true,
            projectId: resolved.projectId,
            sectionId: resolved.sectionId,
            areaId: resolved.areaId,
        };
    }

    const areaValidation = validateExistingTaskAreaId(areaId, allAreas);
    if (!areaValidation.ok) return areaValidation;
    const resolved = resolveTaskContainerHierarchy({
        projectId: undefined,
        sectionId: undefined,
        areaId: areaValidation.areaId,
    });
    return {
        ok: true,
        projectId: resolved.projectId,
        sectionId: resolved.sectionId,
        areaId: resolved.areaId,
    };
};

export const reserveTaskContainerProjectOrder = ({
    task,
    updates,
    projectOrderReserver,
}: {
    task: Pick<Task, 'projectId'>;
    updates: TaskContainerMovePatch;
    projectOrderReserver: TaskContainerOrderReserver;
}): TaskContainerMovePatch => {
    if (!hasOwnField(updates, 'projectId')) return updates;
    if (hasOwnField(updates, 'order') || hasOwnField(updates, 'orderNum')) return updates;
    const nextProjectId = normalizeOptionalContainerId(updates.projectId);
    if (!nextProjectId || (task.projectId ?? undefined) === nextProjectId) return updates;
    const nextOrder = projectOrderReserver(nextProjectId);
    if (nextOrder === undefined) return updates;
    return {
        ...updates,
        order: nextOrder,
        orderNum: nextOrder,
    };
};

export const buildTaskContainerMovePatch = ({
    task,
    updates,
    allProjects,
    allSections,
    allAreas,
    isReactivatingProjectSection,
    reserveProjectOrder = true,
    projectOrderReserver,
}: {
    task: Pick<Task, 'projectId' | 'sectionId' | 'areaId'>;
    updates: TaskContainerMovePatch;
    allProjects: AppData['projects'];
    allSections: AppData['sections'];
    allAreas: AppData['areas'];

    isReactivatingProjectSection?: (section: Readonly<Section>) => boolean;
    reserveProjectOrder?: boolean;
    projectOrderReserver?: TaskContainerOrderReserver;
}): { ok: true; updates: TaskContainerMovePatch } | { ok: false; error: string } => {
    const hasProjectUpdate = hasOwnField(updates, 'projectId');
    const nextProjectId = hasProjectUpdate
        ? normalizeOptionalContainerId(updates.projectId)
        : task.projectId;
    const projectChanged = (task.projectId ?? undefined) !== (nextProjectId ?? undefined);
    const candidateSectionId = hasOwnField(updates, 'sectionId')
        ? updates.sectionId
        : hasProjectUpdate && projectChanged
            ? undefined
            : task.sectionId;
    const candidateAreaId = hasOwnField(updates, 'areaId')
        ? updates.areaId
        : hasProjectUpdate && projectChanged && nextProjectId
            ? undefined
            : task.areaId;
    const containerResolution = resolveTaskContainerAssignment({
        projectId: nextProjectId,
        sectionId: candidateSectionId,
        areaId: candidateAreaId,
        allProjects,
        allSections,
        allAreas,
        isReactivatingProjectSection,
    });
    if (!containerResolution.ok) return containerResolution;

    let containerPatch: TaskContainerMovePatch = {
        projectId: containerResolution.projectId,
        sectionId: containerResolution.sectionId,
        areaId: containerResolution.areaId,
    };

    const resolvedProjectChanged = (task.projectId ?? undefined) !== (containerResolution.projectId ?? undefined);
    if (resolvedProjectChanged && !containerResolution.projectId) {
        containerPatch = {
            ...containerPatch,
            order: undefined,
            orderNum: undefined,
            sectionId: undefined,
        };
    } else if (
        resolvedProjectChanged
        && reserveProjectOrder
        && projectOrderReserver
        && !hasOwnField(updates, 'order')
        && !hasOwnField(updates, 'orderNum')
    ) {
        containerPatch = reserveTaskContainerProjectOrder({
            task,
            updates: containerPatch,
            projectOrderReserver,
        });
    }

    return { ok: true, updates: containerPatch };
};
