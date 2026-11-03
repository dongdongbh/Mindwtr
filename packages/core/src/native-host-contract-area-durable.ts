import type { NativeHostResult } from './native-host-contract';
import { flushPendingSave, getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import { taskEditValuesEqual } from './json-value-equality';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary, TaskStore } from './store-types';

const failure = (code: 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });


export async function readAreaDurableData(allowFailedSave = false, rawTasks = false): Promise<NativeHostResult<{
    adapter: ReturnType<typeof getStorageAdapter>; authority: PreparedAreaAuthority;
}>> {
    const adapter = getStorageAdapter();
    const state = useTaskStore.getState();
    let snapshot;
    try {
        if (!allowFailedSave || !state.persistenceFailure) await flushPendingSave();
        snapshot = await adapter.getData(rawTasks ? { rawTasks: true } : undefined);
    } catch { return failure('SAVE_FAILED', 'Area operation could not read saved data'); }
    const current = useTaskStore.getState();
    if (getStorageAdapter() !== adapter || current._allTasks !== state._allTasks
        || current._allAreas !== state._allAreas || current._allProjects !== state._allProjects
        || current._allSections !== state._allSections || current._allPeople !== state._allPeople
        || current.settings !== state.settings || current.lastDataChangeAt !== state.lastDataChangeAt)
        return failure('STALE_REVISION', 'Area data changed while reading saved data');
    return { ok: true, value: { adapter, authority: { snapshot, state } } };
}


export function createAreaSaveGuard(save: () => Promise<NativeHostResult<null>>) {
    let failedSave: { prepared: unknown; adapter: ReturnType<typeof getStorageAdapter>;
        failure: NonNullable<TaskStore['persistenceFailure']>; generation: number;
        lastDataChangeAt: number; taskReference: TaskStore['_allTasks'] } | null = null;
    const owns = (prepared: unknown, adapter: ReturnType<typeof getStorageAdapter>, state: TaskStore) => {
        const status = getPersistenceStatus();
        return Boolean(failedSave && taskEditValuesEqual(failedSave.prepared, prepared)
            && failedSave.adapter === adapter && failedSave.failure === state.persistenceFailure
            && failedSave.generation === status.generation && failedSave.lastDataChangeAt === state.lastDataChangeAt
            && failedSave.taskReference === state._allTasks && !status.queued && !status.inFlight
            && !status.immediate && !status.retrying);
    };
    return {
        mayApply(prepared: unknown, adapter: ReturnType<typeof getStorageAdapter>): boolean {
            const state = useTaskStore.getState();
            return !state.persistenceFailure || owns(prepared, adapter, state);
        },
        async finish(prepared: unknown, adapter: ReturnType<typeof getStorageAdapter>, replayed: boolean,
            boundary: PreparedNativeSaveBoundary | undefined): Promise<NativeHostResult<null>> {
            const savingState = useTaskStore.getState();
            const savingStatus = getPersistenceStatus();
            const ownWrite = boundary && getStorageAdapter() === adapter
                && boundary.taskReference === savingState._allTasks && boundary.lastDataChangeAt === savingState.lastDataChangeAt
                && boundary.generation === savingStatus.generation && boundary.failure === savingState.persistenceFailure;
            if (replayed && savingState.persistenceFailure) {
                if (!owns(prepared, adapter, savingState))
                    return failure('SAVE_FAILED', 'Area operation has an unresolved persistence failure');
                useTaskStore.setState({ persistenceFailure: null });
                failedSave = null;
            }

            const saved = await save();
            const after = useTaskStore.getState();
            const status = getPersistenceStatus();
            if (ownWrite && !saved.ok && saved.error.code === 'SAVE_FAILED' && after.persistenceFailure
                && after.persistenceFailure !== savingState.persistenceFailure && getStorageAdapter() === adapter
                && status.generation === savingStatus.generation
                && after.lastDataChangeAt === savingState.lastDataChangeAt && after._allTasks === savingState._allTasks) {
                failedSave = { prepared, adapter, failure: after.persistenceFailure, generation: status.generation,
                    lastDataChangeAt: after.lastDataChangeAt, taskReference: after._allTasks };
            } else if (saved.ok) failedSave = null;
            return saved;
        },
    };
}
