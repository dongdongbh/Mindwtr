import type { NativeHostResult } from './native-host-contract';
import { createTasksRemoveTagMethods, readTasksRemoveTagEnvelope, referenceTasksRemoveTagAuthorityMatches,
    type NativeReferenceTasksRemoveTagPrepared, type NativeReferenceTasksRemoveTagResult } from './native-host-contract-reference-bulk-remove-tag';
import type { NativeInboxTasksMoveParams } from './native-host-contract-inbox-bulk-status';
import { referenceBatchModules } from './store-reference-batch-modules';

export type NativeInboxTasksRemoveTagRequest = { requestId: string; source: 'inbox'; taskIds: string[];
    taskRevisions: Record<string, string>; tags: string[]; params: NativeInboxTasksMoveParams };
export type NativeInboxTasksRemoveTagResult = NativeReferenceTasksRemoveTagResult;
export type NativeInboxTasksRemoveTagPrepared = Omit<NativeReferenceTasksRemoveTagPrepared, 'request'> & { request: NativeInboxTasksRemoveTagRequest };
export type NativeInboxTasksRemoveTagEnvelope = { request: NativeInboxTasksRemoveTagRequest; prepared: NativeInboxTasksRemoveTagPrepared };
export type NativeInboxTasksRemoveTagPreparation = { kind: 'noop'; result: { count: 0; changed: false } }
    | { kind: 'prepared'; prepared: NativeInboxTasksRemoveTagPrepared };

export function createInboxTasksRemoveTagMethods(deps: Parameters<typeof createTasksRemoveTagMethods>[0]) {
    const methods = createTasksRemoveTagMethods(deps, 'inbox');
    return {
        prepareInboxTasksRemoveTag: (input: NativeInboxTasksRemoveTagRequest) => methods.prepareTasksRemoveTag(input) as Promise<NativeHostResult<NativeInboxTasksRemoveTagPreparation>>,
        validatePreparedInboxTasksRemoveTag: (input: NativeInboxTasksRemoveTagEnvelope) => methods.validatePreparedTasksRemoveTag(input),
        inboxTasksRemoveTagOutcome: (input: NativeInboxTasksRemoveTagEnvelope) => methods.tasksRemoveTagOutcome(input),
        commitPreparedInboxTasksRemoveTag: (input: NativeInboxTasksRemoveTagEnvelope) => methods.commitPreparedTasksRemoveTag(input),
    };
}
referenceBatchModules.inboxRemoveTag = (input) => {
    const prepared = input as NativeInboxTasksRemoveTagPrepared;
    return { validateEnvelope: () => Boolean(readTasksRemoveTagEnvelope({ request: prepared.request, prepared }, 'inbox')),
        authorityMatches: (data) => referenceTasksRemoveTagAuthorityMatches(prepared, data) };
};
