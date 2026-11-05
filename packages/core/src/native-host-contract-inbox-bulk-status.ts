import type { NativeHostResult } from './native-host-contract';
import { createTasksMoveMethods, readTasksMoveEnvelope, referenceTasksMoveAuthorityMatches,
    type NativeReferenceTasksMovePrepared } from './native-host-contract-reference-bulk-status';
import type { ListFilterState } from './list-filter-state';
import type { TaskGroupBy } from './task-group-sections';
import type { SomedayGroupBy } from './menu-views-model';
import type { TaskSortBy, TaskStatus } from './types';
import { referenceBatchModules } from './store-reference-batch-modules';

export type NativeInboxTasksMoveStatus = 'next' | 'waiting' | 'someday' | 'done' | 'reference';
export type NativeInboxTasksMoveParams = { groupBy?: TaskGroupBy; collapsedGroupIds?: string[]; filters?: Partial<ListFilterState> };
export type NativeInboxTasksMoveRequest = { requestId: string; taskIds: string[]; taskRevisions: Record<string, string>;
    source: 'inbox'; status: NativeInboxTasksMoveStatus; params: NativeInboxTasksMoveParams };
export type NativeInboxTasksMoveResult = { count: number; status: NativeInboxTasksMoveStatus };
export type NativeStatusListTasksMoveRequest = { requestId: string; taskIds: string[]; taskRevisions: Record<string, string> } & (
    | { source: 'waiting'; status: Exclude<TaskStatus, 'waiting' | 'archived'>; params: { person?: string } }
    | { source: 'someday'; status: Exclude<TaskStatus, 'someday' | 'archived'>; params: { sortBy?: TaskSortBy; groupBy?: SomedayGroupBy;
        showDetails?: boolean; projectsInSections?: boolean; filters?: Partial<ListFilterState> } });
export type NativeInboxTasksMovePrepared = Omit<NativeReferenceTasksMovePrepared, 'request' | 'result'> & {
    request: NativeInboxTasksMoveRequest; result: NativeInboxTasksMoveResult;
};
export type NativeInboxTasksMoveEnvelope = { request: NativeInboxTasksMoveRequest; prepared: NativeInboxTasksMovePrepared };
export type NativeInboxTasksMovePreparation = { kind: 'prepared'; prepared: NativeInboxTasksMovePrepared };

export function createInboxTasksMoveMethods(deps: Parameters<typeof createTasksMoveMethods>[0]) {
    const methods = createTasksMoveMethods(deps, 'inbox');
    return {
        prepareInboxTasksMove: (input: NativeInboxTasksMoveRequest) => methods.prepareTasksMove(input) as Promise<NativeHostResult<NativeInboxTasksMovePreparation>>,
        validatePreparedInboxTasksMove: (input: NativeInboxTasksMoveEnvelope) => methods.validatePreparedTasksMove(input) as NativeHostResult<NativeInboxTasksMoveResult>,
        inboxTasksMoveOutcome: (input: NativeInboxTasksMoveEnvelope) => methods.tasksMoveOutcome(input) as NativeHostResult<NativeInboxTasksMoveResult | null>,
        commitPreparedInboxTasksMove: (input: NativeInboxTasksMoveEnvelope) => methods.commitPreparedTasksMove(input) as Promise<NativeHostResult<NativeInboxTasksMoveResult>>,
    };
}

referenceBatchModules.inboxMove = (input) => {
    const prepared = input as NativeInboxTasksMovePrepared;
    return {
        validateEnvelope: () => Boolean(readTasksMoveEnvelope({ request: prepared.request, prepared }, 'inbox')),
        authorityMatches: (data) => referenceTasksMoveAuthorityMatches(prepared, data),
    };
};
