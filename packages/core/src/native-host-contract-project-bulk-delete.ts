import type { NativeHostResult } from './native-host-contract';
import { createTasksDeleteMethods, type NativeArchivedTasksDeleteResult, type NativeArchivedTasksDeleteUndoRequest,
    type NativeArchivedTasksDeleteUndoResult, type NativeArchivedTasksDeleteUndoScope } from './native-host-contract-archive-bulk-delete';
import type { NativeProjectTasksMoveParams } from './native-host-contract-project-bulk-status';
import type { NativeReferenceTasksMoveScope } from './native-host-contract-reference-bulk-status';
import type { FocusDateProjection } from './task-utils';
import type { Task } from './types';

export type NativeProjectTasksDeleteRequest = { requestId: string; source: 'project'; taskIds: string[];
    taskRevisions: Record<string, string>; params: NativeProjectTasksMoveParams };
export type NativeProjectTasksDeleteResult = NativeArchivedTasksDeleteResult;
type Frozen = { preparedLocalDay: string; preparedOffsetMinutes: number; boundaryOffsetMinutes: number;
    futureBoundary: string; dates: FocusDateProjection[] };
export type NativeProjectTasksDeletePrepared = Frozen & { version: 1; request: NativeProjectTasksDeleteRequest;
    before: Task[]; after: Task[]; scope: NativeReferenceTasksMoveScope;
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string; result: NativeProjectTasksDeleteResult };
export type NativeProjectTasksDeleteEnvelope = { request: NativeProjectTasksDeleteRequest; prepared: NativeProjectTasksDeletePrepared };
export type NativeProjectTasksDeletePreparation = { kind: 'prepared'; prepared: NativeProjectTasksDeletePrepared };
export type NativeProjectTasksDeleteUndoRequest = NativeArchivedTasksDeleteUndoRequest;
export type NativeProjectTasksDeleteUndoResult = NativeArchivedTasksDeleteUndoResult;
export type NativeProjectTasksDeleteUndoPrepared = Frozen & { version: 1; request: NativeProjectTasksDeleteUndoRequest;
    delete: NativeProjectTasksDeleteEnvelope; before: Task[]; after: Task[]; scope: NativeArchivedTasksDeleteUndoScope;
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string; result: NativeProjectTasksDeleteUndoResult };
export type NativeProjectTasksDeleteUndoEnvelope = { request: NativeProjectTasksDeleteUndoRequest; prepared: NativeProjectTasksDeleteUndoPrepared };
export type NativeProjectTasksDeleteUndoPreparation = { kind: 'prepared'; prepared: NativeProjectTasksDeleteUndoPrepared };
export type NativeProjectTasksDeleteUndoPrepareRequest = { request: NativeProjectTasksDeleteUndoRequest; delete: NativeProjectTasksDeleteEnvelope };

export function createProjectTasksDeleteMethods(deps: Parameters<typeof createTasksDeleteMethods>[0]) {
    const methods = createTasksDeleteMethods(deps, 'project');
    return {
        prepareProjectTasksDelete: (input: NativeProjectTasksDeleteRequest) => methods.prepareArchivedTasksDelete(input) as Promise<NativeHostResult<NativeProjectTasksDeletePreparation>>,
        validatePreparedProjectTasksDelete: (input: NativeProjectTasksDeleteEnvelope) => methods.validatePreparedArchivedTasksDelete(input),
        projectTasksDeleteOutcome: (input: NativeProjectTasksDeleteEnvelope) => methods.archivedTasksDeleteOutcome(input),
        commitPreparedProjectTasksDelete: (input: NativeProjectTasksDeleteEnvelope) => methods.commitPreparedArchivedTasksDelete(input),
        prepareProjectTasksDeleteUndo: (input: NativeProjectTasksDeleteUndoPrepareRequest) => methods.prepareArchivedTasksDeleteUndo(input) as Promise<NativeHostResult<NativeProjectTasksDeleteUndoPreparation>>,
        validatePreparedProjectTasksDeleteUndo: (input: NativeProjectTasksDeleteUndoEnvelope) => methods.validatePreparedArchivedTasksDeleteUndo(input),
        projectTasksDeleteUndoOutcome: (input: NativeProjectTasksDeleteUndoEnvelope) => methods.archivedTasksDeleteUndoOutcome(input),
        commitPreparedProjectTasksDeleteUndo: (input: NativeProjectTasksDeleteUndoEnvelope) => methods.commitPreparedArchivedTasksDeleteUndo(input),
    };
}
