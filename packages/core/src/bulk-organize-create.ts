import { resolveCaptureAreaQuery } from './capture';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { flushPendingSave, useTaskStore } from './store';
import type { Area, Project } from './types';


export async function ensureBulkOrganizeDestinationSaved(): Promise<void> {
    if (useTaskStore.getState().persistenceFailure) {
        await useTaskStore.getState().retryPersistence();
    }
    await flushPendingSave();
    const failure = useTaskStore.getState().persistenceFailure;
    if (failure) throw new Error(failure.message);
}


async function saveDestination<T>(create: () => Promise<T | null>): Promise<T | null> {
    if (useTaskStore.getState().persistenceFailure) {


        await ensureBulkOrganizeDestinationSaved();
    }
    const created = await create();
    if (!created) return null;
    await ensureBulkOrganizeDestinationSaved();
    return created;
}


export function addBulkOrganizeProject(title: string, areaId?: string, id?: string): Promise<Project | null> {
    return useTaskStore.getState().addProject(
        title.trim(),
        DEFAULT_PROJECT_COLOR,
        areaId || id ? { ...(areaId ? { areaId } : {}), ...(id ? { id } : {}) } : undefined,
    );
}


export async function addBulkOrganizeArea(name: string, id?: string): Promise<Area | null> {
    const state = useTaskStore.getState();
    const choice = resolveCaptureAreaQuery(state.areas, name);
    if (choice.kind === 'select') return choice.area;
    if (choice.kind === 'empty') return null;
    const key = choice.areaToCreate.name.trim().toLowerCase();
    const named = state._allAreas.some((area) => area?.name?.trim().toLowerCase() === key);
    return state.addArea(choice.areaToCreate.name, { color: choice.areaToCreate.color, ...(id && !named ? { id } : {}) });
}

export async function createBulkOrganizeProject(title: string, areaId?: string): Promise<Project | null> {
    const trimmed = title.trim();
    if (!trimmed) return null;
    return saveDestination(() => addBulkOrganizeProject(trimmed, areaId));
}

export async function createBulkOrganizeArea(name: string): Promise<Area | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    return saveDestination(() => addBulkOrganizeArea(trimmed));
}
