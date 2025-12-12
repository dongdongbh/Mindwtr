
import { AppData } from './types';

/**
 * Merge entities with soft-delete support using Last-Write-Wins (LWW) strategy.
 * 
 * Rules:
 * 1. If an item exists only in one source, include it
 * 2. If an item exists in both, take the one with newer updatedAt
 * 3. Deleted items (deletedAt set) are preserved - deletion syncs across devices
 * 4. If one version is deleted and one is not, the newer version wins
 */
function mergeEntities<T extends { id: string; updatedAt: string; deletedAt?: string }>(
    local: T[],
    incoming: T[]
): T[] {
    const map = new Map<string, T>();

    // Add all local entities first
    for (const item of local) {
        map.set(item.id, item);
    }

    // Merge incoming
    for (const item of incoming) {
        const existing = map.get(item.id);
        if (!existing) {
            // New item from incoming
            map.set(item.id, item);
        } else {
            // Conflict: Compare timestamps (LWW)
            const localTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
            const incomingTime = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;

            // Handle invalid dates safe guard
            const safeLocalTime = isNaN(localTime) ? 0 : localTime;
            const safeIncomingTime = isNaN(incomingTime) ? 0 : incomingTime;

            if (safeIncomingTime > safeLocalTime) {
                // Incoming is newer, use it (including its deletedAt status)
                map.set(item.id, item);
            }
            // If local is newer or equal, keep local (including its deletedAt status)
        }
    }

    return Array.from(map.values());
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
export function mergeAppData(local: AppData, incoming: AppData): AppData {
    const mergedTasks = mergeEntities(local.tasks, incoming.tasks);
    const mergedProjects = mergeEntities(local.projects, incoming.projects);

    return {
        tasks: mergedTasks,
        projects: mergedProjects,
        settings: local.settings, // Keep local settings to preserve device preferences
    };
}
