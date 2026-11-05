import type { NativeHostResult } from './native-host-contract';
import { createTasksMoveMethods, readTasksMoveEnvelope, referenceTasksMoveAuthorityMatches,
    type NativeReferenceTasksMovePrepared } from './native-host-contract-reference-bulk-status';
import type { NativeProjectBulkParams } from './native-host-project-task-list';
import type { ListFilterState } from './list-filter-state';
import { referenceBatchModules } from './store-reference-batch-modules';

export type NativeProjectTasksMoveStatus = 'inbox' | 'next' | 'waiting' | 'someday' | 'done' | 'reference';
export type NativeProjectTasksMoveParams = Omit<NativeProjectBulkParams, 'filters' | 'filterSheetOpen'> & {
    filters: Partial<ListFilterState>; filterSheetOpen?: false;
};
export type NativeProjectTasksMoveRequest = { requestId: string; source: 'project'; taskIds: string[];
    taskRevisions: Record<string, string>; status: NativeProjectTasksMoveStatus; params: NativeProjectTasksMoveParams };
export type NativeProjectTasksMoveResult = { count: number; status: NativeProjectTasksMoveStatus };
export type NativeProjectTasksMovePrepared = Omit<NativeReferenceTasksMovePrepared, 'request' | 'result'> & {
    request: NativeProjectTasksMoveRequest; result: NativeProjectTasksMoveResult;
};
export type NativeProjectTasksMoveEnvelope = { request: NativeProjectTasksMoveRequest; prepared: NativeProjectTasksMovePrepared };
export type NativeProjectTasksMovePreparation = { kind: 'prepared'; prepared: NativeProjectTasksMovePrepared };

export function createProjectTasksMoveMethods(deps: Parameters<typeof createTasksMoveMethods>[0]) {
    const methods = createTasksMoveMethods(deps, 'project');
    return {
        prepareProjectTasksMove: (input: NativeProjectTasksMoveRequest) => methods.prepareTasksMove(input) as Promise<NativeHostResult<NativeProjectTasksMovePreparation>>,
        validatePreparedProjectTasksMove: (input: NativeProjectTasksMoveEnvelope) => methods.validatePreparedTasksMove(input) as NativeHostResult<NativeProjectTasksMoveResult>,
        projectTasksMoveOutcome: (input: NativeProjectTasksMoveEnvelope) => methods.tasksMoveOutcome(input) as NativeHostResult<NativeProjectTasksMoveResult | null>,
        commitPreparedProjectTasksMove: (input: NativeProjectTasksMoveEnvelope) => methods.commitPreparedTasksMove(input) as Promise<NativeHostResult<NativeProjectTasksMoveResult>>,
    };
}

referenceBatchModules.projectMove = input => {
    const prepared = input as NativeProjectTasksMovePrepared;
    return {
        validateEnvelope: () => Boolean(readTasksMoveEnvelope({ request: prepared.request, prepared }, 'project')),
        authorityMatches: data => referenceTasksMoveAuthorityMatches(prepared, data),
        temporal: { futureBoundary: prepared.futureBoundary, dates: new Map(prepared.dates.map(row => [row.value, row])) },
    };
};
