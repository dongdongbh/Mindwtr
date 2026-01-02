
import type { AppData, Attachment, Project, Task, Area } from './types';
import { normalizeTaskForLoad } from './task-status';

export interface EntityMergeStats {
    localTotal: number;
    incomingTotal: number;
    mergedTotal: number;
    localOnly: number;
    incomingOnly: number;
    conflicts: number;
    resolvedUsingLocal: number;
    resolvedUsingIncoming: number;
    deletionsWon: number;
    conflictIds: string[];
}

export interface MergeStats {
    tasks: EntityMergeStats;
    projects: EntityMergeStats;
}

export interface MergeResult {
    data: AppData;
    stats: MergeStats;
}

/**
 * Merge entities with soft-delete support using Last-Write-Wins (LWW) strategy.
 * 
 * Rules:
 * 1. If an item exists only in one source, include it
 * 2. If an item exists in both, take the one with newer updatedAt
 * 3. Deleted items (deletedAt set) are preserved - deletion syncs across devices
 * 4. If one version is deleted and one is not, the newer version wins
 */
function createEmptyEntityStats(localTotal: number, incomingTotal: number): EntityMergeStats {
    return {
        localTotal,
        incomingTotal,
        mergedTotal: 0,
        localOnly: 0,
        incomingOnly: 0,
        conflicts: 0,
        resolvedUsingLocal: 0,
        resolvedUsingIncoming: 0,
        deletionsWon: 0,
        conflictIds: [],
    };
}

function mergeEntitiesWithStats<T extends { id: string; updatedAt: string; deletedAt?: string }>(
    local: T[],
    incoming: T[],
    mergeConflict?: (localItem: T, incomingItem: T, winner: T) => T
): { merged: T[]; stats: EntityMergeStats } {
    const localMap = new Map<string, T>(local.map((item) => [item.id, item]));
    const incomingMap = new Map<string, T>(incoming.map((item) => [item.id, item]));
    const allIds = new Set<string>([...localMap.keys(), ...incomingMap.keys()]);

    const stats = createEmptyEntityStats(local.length, incoming.length);
    const merged: T[] = [];

    for (const id of allIds) {
        const localItem = localMap.get(id);
        const incomingItem = incomingMap.get(id);

        if (localItem && !incomingItem) {
            stats.localOnly += 1;
            stats.resolvedUsingLocal += 1;
            merged.push(localItem);
            continue;
        }
        if (incomingItem && !localItem) {
            stats.incomingOnly += 1;
            stats.resolvedUsingIncoming += 1;
            merged.push(incomingItem);
            continue;
        }

        if (!localItem || !incomingItem) continue;

        const localTime = localItem.updatedAt ? new Date(localItem.updatedAt).getTime() : 0;
        const incomingTime = incomingItem.updatedAt ? new Date(incomingItem.updatedAt).getTime() : 0;
        const safeLocalTime = isNaN(localTime) ? 0 : localTime;
        const safeIncomingTime = isNaN(incomingTime) ? 0 : incomingTime;

        const differs =
            safeLocalTime !== safeIncomingTime ||
            !!localItem.deletedAt !== !!incomingItem.deletedAt;

        if (differs) {
            stats.conflicts += 1;
            if (stats.conflictIds.length < 20) stats.conflictIds.push(id);
        }

        const winner = safeIncomingTime > safeLocalTime ? incomingItem : localItem;
        if (winner === incomingItem) stats.resolvedUsingIncoming += 1;
        else stats.resolvedUsingLocal += 1;

        if (winner.deletedAt && (!localItem.deletedAt || !incomingItem.deletedAt || differs)) {
            stats.deletionsWon += 1;
        }

        merged.push(mergeConflict ? mergeConflict(localItem, incomingItem, winner) : winner);
    }

    stats.mergedTotal = merged.length;

    return { merged, stats };
}

function mergeEntities<T extends { id: string; updatedAt: string; deletedAt?: string }>(
    local: T[],
    incoming: T[]
): T[] {
    return mergeEntitiesWithStats(local, incoming).merged;
}

function mergeAreas(local: Area[], incoming: Area[]): Area[] {
    const localMap = new Map<string, Area>(local.map(area => [area.id, area]));
    const incomingMap = new Map<string, Area>(incoming.map(area => [area.id, area]));
    const allIds = new Set<string>([...localMap.keys(), ...incomingMap.keys()]);
    const merged: Area[] = [];

    const resolveTime = (area?: Area): number => {
        const timestamp = area?.updatedAt || area?.createdAt;
        const parsed = timestamp ? new Date(timestamp).getTime() : 0;
        return Number.isFinite(parsed) ? parsed : 0;
    };

    for (const id of allIds) {
        const localArea = localMap.get(id);
        const incomingArea = incomingMap.get(id);

        if (localArea && !incomingArea) {
            merged.push(localArea);
            continue;
        }
        if (incomingArea && !localArea) {
            merged.push(incomingArea);
            continue;
        }
        if (!localArea || !incomingArea) continue;

        const localTime = resolveTime(localArea);
        const incomingTime = resolveTime(incomingArea);
        const winner = incomingTime > localTime ? incomingArea : localArea;
        merged.push(winner);
    }

    return merged
        .map((area, index) => ({
            ...area,
            order: Number.isFinite(area.order) ? area.order : index,
        }))
        .sort((a, b) => a.order - b.order);
}

/**
 * Filter out soft-deleted items for display purposes.
 * Call this when loading data for the UI.
 */
export function filterDeleted<T extends { deletedAt?: string }>(items: T[]): T[] {
    return items.filter(item => !item.deletedAt);
}

/**
 * Merge two AppData objects for synchronization.
 * Uses Last-Write-Wins for tasks and projects.
 * Preserves local settings (device-specific preferences).
 */
export function mergeAppDataWithStats(local: AppData, incoming: AppData): MergeResult {
    const nowIso = new Date().toISOString();
    const localNormalized: AppData = {
        ...local,
        tasks: (local.tasks || []).map((t) => normalizeTaskForLoad(t, nowIso)),
        projects: local.projects || [],
        areas: local.areas || [],
    };
    const incomingNormalized: AppData = {
        ...incoming,
        tasks: (incoming.tasks || []).map((t) => normalizeTaskForLoad(t, nowIso)),
        projects: incoming.projects || [],
        areas: incoming.areas || [],
    };

    const mergeAttachments = (a?: Attachment[], b?: Attachment[]): Attachment[] | undefined => {
        const aList = a || [];
        const bList = b || [];
        if (aList.length === 0 && bList.length === 0) return undefined;
        const merged = mergeEntities(aList, bList);
        return merged.length > 0 ? merged : undefined;
    };

    const tasksResult = mergeEntitiesWithStats(localNormalized.tasks, incomingNormalized.tasks, (localTask: Task, incomingTask: Task, winner: Task) => {
        if (winner.deletedAt) return winner;
        const loser = winner === incomingTask ? localTask : incomingTask;
        const attachments = mergeAttachments(winner.attachments, loser.attachments);
        return attachments ? { ...winner, attachments } : winner;
    });

    const projectsResult = mergeEntitiesWithStats(localNormalized.projects, incomingNormalized.projects, (localProject: Project, incomingProject: Project, winner: Project) => {
        if (winner.deletedAt) return winner;
        const loser = winner === incomingProject ? localProject : incomingProject;
        const attachments = mergeAttachments(winner.attachments, loser.attachments);
        return attachments ? { ...winner, attachments } : winner;
    });

    return {
        data: {
            tasks: tasksResult.merged,
            projects: projectsResult.merged,
            areas: mergeAreas(localNormalized.areas, incomingNormalized.areas),
            settings: localNormalized.settings,
        },
        stats: {
            tasks: tasksResult.stats,
            projects: projectsResult.stats,
        },
    };
}

export function mergeAppData(local: AppData, incoming: AppData): AppData {
    return mergeAppDataWithStats(local, incoming).data;
}
