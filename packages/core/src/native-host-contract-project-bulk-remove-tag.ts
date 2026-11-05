import type { NativeHostResult } from './native-host-contract';
import { createTasksRemoveTagMethods, readTasksRemoveTagEnvelope, referenceTasksRemoveTagAuthorityMatches,
    type NativeReferenceTasksRemoveTagPrepared, type NativeReferenceTasksRemoveTagResult } from './native-host-contract-reference-bulk-remove-tag';
import type { NativeProjectTasksMoveParams } from './native-host-contract-project-bulk-status';
import { referenceBatchModules } from './store-reference-batch-modules';

export type NativeProjectTasksRemoveTagRequest = { requestId: string; source: 'project'; taskIds: string[];
    taskRevisions: Record<string, string>; tags: string[]; params: NativeProjectTasksMoveParams };
export type NativeProjectTasksRemoveTagResult = NativeReferenceTasksRemoveTagResult;
export type NativeProjectTasksRemoveTagPrepared = Omit<NativeReferenceTasksRemoveTagPrepared, 'request'> & { request: NativeProjectTasksRemoveTagRequest };
export type NativeProjectTasksRemoveTagEnvelope = { request: NativeProjectTasksRemoveTagRequest; prepared: NativeProjectTasksRemoveTagPrepared };
export type NativeProjectTasksRemoveTagPreparation = { kind: 'noop'; result: { count: 0; changed: false } }
    | { kind: 'prepared'; prepared: NativeProjectTasksRemoveTagPrepared };

export function createProjectTasksRemoveTagMethods(deps: Parameters<typeof createTasksRemoveTagMethods>[0]) {
    const methods = createTasksRemoveTagMethods(deps, 'project');
    return {
        prepareProjectTasksRemoveTag: (input: NativeProjectTasksRemoveTagRequest) => methods.prepareTasksRemoveTag(input) as Promise<NativeHostResult<NativeProjectTasksRemoveTagPreparation>>,
        validatePreparedProjectTasksRemoveTag: (input: NativeProjectTasksRemoveTagEnvelope) => methods.validatePreparedTasksRemoveTag(input),
        projectTasksRemoveTagOutcome: (input: NativeProjectTasksRemoveTagEnvelope) => methods.tasksRemoveTagOutcome(input),
        commitPreparedProjectTasksRemoveTag: (input: NativeProjectTasksRemoveTagEnvelope) => methods.commitPreparedTasksRemoveTag(input),
    };
}
referenceBatchModules.projectRemoveTag = (input) => {
    const prepared = input as NativeProjectTasksRemoveTagPrepared;
    return { validateEnvelope: () => Boolean(readTasksRemoveTagEnvelope({ request: prepared.request, prepared }, 'project')),
        temporal: { futureBoundary: prepared.futureBoundary, dates: new Map(prepared.dates.map(row => [row.value, row])) },
        authorityMatches: (data) => referenceTasksRemoveTagAuthorityMatches(prepared, data) };
};
