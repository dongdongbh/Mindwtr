import { sameShallowRecord } from './shallow-identity';
import { normalizeCancellationTimestamp } from './task-status';
import type { Project } from './types';

const hasOwnField = (value: object, field: PropertyKey): boolean => (
    Object.prototype.hasOwnProperty.call(value, field)
);

export function isProjectCancelled(
    project: Pick<Project, 'status' | 'cancelledAt'> | undefined,
): boolean {
    return project?.status === 'archived'
        && normalizeCancellationTimestamp(project.cancelledAt) !== undefined;
}


export function normalizeProjectLifecycleFields(project: Project): Project {
    const cancelledAt = project.status === 'archived'
        ? normalizeCancellationTimestamp(project.cancelledAt)
        : undefined;
    const cancellationChanged = cancelledAt !== project.cancelledAt;
    const focusChanged = project.status === 'archived' && project.isFocused !== false;
    if (!cancellationChanged && !focusChanged) return project;
    const next: Project = {
        ...project,
        ...(cancellationChanged ? { cancelledAt } : {}),
        ...(focusChanged ? { isFocused: false } : {}),
    };
    return sameShallowRecord(project, next) ? project : next;
}


export function normalizeProjectUpdate(
    project: Project,
    updates: Partial<Project>,
): Partial<Project> {

    let adjustedUpdates = { ...updates };
    delete adjustedUpdates.archivedAt;
    if (hasOwnField(updates, 'cancelledAt')) {
        const cancelledAt = normalizeCancellationTimestamp(updates.cancelledAt);
        adjustedUpdates = {
            ...adjustedUpdates,
            cancelledAt,
            ...(cancelledAt && !hasOwnField(updates, 'status') ? { status: 'archived' as const } : {}),
        };
    }

    const resolvedStatus = hasOwnField(adjustedUpdates, 'status')
        ? adjustedUpdates.status
        : project.status;
    if (resolvedStatus !== 'archived') {
        adjustedUpdates = {
            ...adjustedUpdates,
            cancelledAt: undefined,
        };
    }
    const explicitlyEnteredNonActiveStatus = hasOwnField(adjustedUpdates, 'status')
        && resolvedStatus !== project.status
        && resolvedStatus !== 'active';
    if (resolvedStatus === 'archived' || explicitlyEnteredNonActiveStatus) {
        adjustedUpdates = {
            ...adjustedUpdates,
            isFocused: false,
        };
    }
    return adjustedUpdates;
}
