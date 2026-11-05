import type { NativeHostResult } from './native-host-contract';
import { createTasksOrganizeMethods, readTasksOrganizeEnvelope, tasksOrganizeAuthorityMatches,
    type NativeInboxTasksOrganizePrepared, type NativeInboxTasksOrganizeResult } from './native-host-contract-inbox-bulk-organize';
import type { NativeProjectTasksMoveParams } from './native-host-contract-project-bulk-status';
import type { BulkOrganizeDraft } from './task-list-bulk-actions';
import { referenceBatchModules } from './store-reference-batch-modules';

export type NativeProjectTasksOrganizeRequest = { requestId: string; source: 'project'; taskIds: string[];
    taskRevisions: Record<string, string>; draft: BulkOrganizeDraft; params: NativeProjectTasksMoveParams };
export type NativeProjectTasksOrganizeResult = NativeInboxTasksOrganizeResult;
export type NativeProjectTasksOrganizePrepared = Omit<NativeInboxTasksOrganizePrepared, 'request'> & { request: NativeProjectTasksOrganizeRequest };
export type NativeProjectTasksOrganizeEnvelope = { request: NativeProjectTasksOrganizeRequest; prepared: NativeProjectTasksOrganizePrepared };
export type NativeProjectTasksOrganizePreparation = { kind: 'noop'; result: { count: 0; changed: false } }
    | { kind: 'prepared'; prepared: NativeProjectTasksOrganizePrepared };

export function createProjectTasksOrganizeMethods(deps: Parameters<typeof createTasksOrganizeMethods>[0]) {
    const methods = createTasksOrganizeMethods(deps, 'project');
    return {
        prepareProjectTasksOrganize: (input: NativeProjectTasksOrganizeRequest) => methods.prepareTasksOrganize(input) as Promise<NativeHostResult<NativeProjectTasksOrganizePreparation>>,
        validatePreparedProjectTasksOrganize: (input: NativeProjectTasksOrganizeEnvelope) => methods.validatePreparedTasksOrganize(input),
        projectTasksOrganizeOutcome: (input: NativeProjectTasksOrganizeEnvelope) => methods.tasksOrganizeOutcome(input),
        commitPreparedProjectTasksOrganize: (input: NativeProjectTasksOrganizeEnvelope) => methods.commitPreparedTasksOrganize(input),
    };
}
referenceBatchModules.projectOrganize = input => {
    const prepared = input as NativeProjectTasksOrganizePrepared;
    return { validateEnvelope: () => Boolean(readTasksOrganizeEnvelope({ request: prepared.request, prepared }, 'project')),
        temporal: { futureBoundary: prepared.futureBoundary, dates: new Map(prepared.dates.map(row => [row.value, row])) },
        authorityMatches: data => tasksOrganizeAuthorityMatches(prepared, data) };
};
