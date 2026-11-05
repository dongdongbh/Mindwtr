import type { NativeHostResult } from './native-host-contract';
import { createTasksAddTagMethods, readTasksAddTagEnvelope, referenceTasksAddTagAuthorityMatches,
    type NativeReferenceTasksAddTagPrepared, type NativeReferenceTasksAddTagResult } from './native-host-contract-reference-bulk-tag';
import type { NativeProjectTasksMoveParams } from './native-host-contract-project-bulk-status';
import { referenceBatchModules } from './store-reference-batch-modules';

export type NativeProjectTasksAddTagRequest = { requestId: string; source: 'project'; taskIds: string[];
    taskRevisions: Record<string, string>; tag: string; params: NativeProjectTasksMoveParams };
export type NativeProjectTasksAddTagResult = NativeReferenceTasksAddTagResult;
export type NativeProjectTasksAddTagPrepared = Omit<NativeReferenceTasksAddTagPrepared, 'request'> & { request: NativeProjectTasksAddTagRequest };
export type NativeProjectTasksAddTagEnvelope = { request: NativeProjectTasksAddTagRequest; prepared: NativeProjectTasksAddTagPrepared };
export type NativeProjectTasksAddTagPreparation = { kind: 'noop'; result: { count: 0; changed: false } }
    | { kind: 'prepared'; prepared: NativeProjectTasksAddTagPrepared };

export function createProjectTasksAddTagMethods(deps: Parameters<typeof createTasksAddTagMethods>[0]) {
    const methods = createTasksAddTagMethods(deps, 'project');
    return {
        prepareProjectTasksAddTag: (input: NativeProjectTasksAddTagRequest) => methods.prepareTasksAddTag(input) as Promise<NativeHostResult<NativeProjectTasksAddTagPreparation>>,
        validatePreparedProjectTasksAddTag: (input: NativeProjectTasksAddTagEnvelope) => methods.validatePreparedTasksAddTag(input),
        projectTasksAddTagOutcome: (input: NativeProjectTasksAddTagEnvelope) => methods.tasksAddTagOutcome(input),
        commitPreparedProjectTasksAddTag: (input: NativeProjectTasksAddTagEnvelope) => methods.commitPreparedTasksAddTag(input),
    };
}
referenceBatchModules.projectAddTag = (input) => {
    const prepared = input as NativeProjectTasksAddTagPrepared;
    return { validateEnvelope: () => Boolean(readTasksAddTagEnvelope({ request: prepared.request, prepared }, 'project')),
        temporal: { futureBoundary: prepared.futureBoundary, dates: new Map(prepared.dates.map(row => [row.value, row])) },
        authorityMatches: (data) => referenceTasksAddTagAuthorityMatches(prepared, data) };
};
