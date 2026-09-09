import { resolveCaptureAreaQuery } from './capture';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { flushPendingSave, useTaskStore } from './store';
import type { Area, Project } from './types';

/** A failed creation can be visible in memory before it is durable. */
export async function ensureBulkOrganizeDestinationSaved(): Promise<void> {
    if (useTaskStore.getState().persistenceFailure) {
        await useTaskStore.getState().retryPersistence();
    }
    await flushPendingSave();
    const failure = useTaskStore.getState().persistenceFailure;
    if (failure) throw new Error(failure.message);
}

// Destination creation is independent of applying the bulk task changes.
// Core actions own identity/defaults; the picker must wait for durable storage.
async function saveDestination<T>(create: () => Promise<T | null>): Promise<T | null> {
    if (useTaskStore.getState().persistenceFailure) {
        // A prior failed creation may exist in memory. Persist that snapshot
        // before allowing the core action to return its deduplicated entity.
        await ensureBulkOrganizeDestinationSaved();
    }
    const created = await create();
    if (!created) return null;
    await ensureBulkOrganizeDestinationSaved();
    return created;
}

export async function createBulkOrganizeProject(title: string, areaId?: string): Promise<Project | null> {
    const trimmed = title.trim();
    if (!trimmed) return null;
    return saveDestination(() => useTaskStore.getState().addProject(
        trimmed,
        DEFAULT_PROJECT_COLOR,
        areaId ? { areaId } : undefined,
    ));
}

export async function createBulkOrganizeArea(name: string): Promise<Area | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    return saveDestination(async () => {
        const state = useTaskStore.getState();
        const choice = resolveCaptureAreaQuery(state.areas, trimmed);
        if (choice.kind === 'select') return choice.area;
        if (choice.kind === 'empty') return null;
        return state.addArea(choice.areaToCreate.name, { color: choice.areaToCreate.color });
    });
}
