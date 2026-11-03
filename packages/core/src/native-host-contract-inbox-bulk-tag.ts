import type { NativeHostResult } from './native-host-contract';
import { createTasksAddTagMethods, readTasksAddTagEnvelope, referenceTasksAddTagAuthorityMatches,
    type NativeReferenceTasksAddTagPrepared, type NativeReferenceTasksAddTagResult } from './native-host-contract-reference-bulk-tag';
import type { NativeInboxTasksMoveParams } from './native-host-contract-inbox-bulk-status';
import { referenceBatchModules } from './store-reference-batch-modules';

export type NativeInboxTasksAddTagRequest = { requestId: string; source: 'inbox'; taskIds: string[];
    taskRevisions: Record<string, string>; tag: string; params: NativeInboxTasksMoveParams };
export type NativeInboxTasksAddTagResult = NativeReferenceTasksAddTagResult;
export type NativeInboxTasksAddTagPrepared = Omit<NativeReferenceTasksAddTagPrepared, 'request'> & { request: NativeInboxTasksAddTagRequest };
export type NativeInboxTasksAddTagEnvelope = { request: NativeInboxTasksAddTagRequest; prepared: NativeInboxTasksAddTagPrepared };
export type NativeInboxTasksAddTagPreparation = { kind: 'noop'; result: { count: 0; changed: false } }
    | { kind: 'prepared'; prepared: NativeInboxTasksAddTagPrepared };

export function createInboxTasksAddTagMethods(deps: Parameters<typeof createTasksAddTagMethods>[0]) {
    const methods = createTasksAddTagMethods(deps, 'inbox');
    return {
        prepareInboxTasksAddTag: (input: NativeInboxTasksAddTagRequest) => methods.prepareTasksAddTag(input) as Promise<NativeHostResult<NativeInboxTasksAddTagPreparation>>,
        validatePreparedInboxTasksAddTag: (input: NativeInboxTasksAddTagEnvelope) => methods.validatePreparedTasksAddTag(input),
        inboxTasksAddTagOutcome: (input: NativeInboxTasksAddTagEnvelope) => methods.tasksAddTagOutcome(input),
        commitPreparedInboxTasksAddTag: (input: NativeInboxTasksAddTagEnvelope) => methods.commitPreparedTasksAddTag(input),
    };
}
referenceBatchModules.inboxAddTag = (input) => {
    const prepared = input as NativeInboxTasksAddTagPrepared;
    return { validateEnvelope: () => Boolean(readTasksAddTagEnvelope({ request: prepared.request, prepared }, 'inbox')),
        authorityMatches: (data) => referenceTasksAddTagAuthorityMatches(prepared, data) };
};
