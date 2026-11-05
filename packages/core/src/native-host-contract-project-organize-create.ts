import type { NativeHostResult } from './native-host-contract';
import { createOrganizeDestinationCreateMethods, readOrganizeDestinationCreateEnvelope, organizeDestinationCreateAuthorityMatches,
    type NativeInboxOrganizeDestinationCreatePrepared, type NativeInboxOrganizeDestinationCreateResult } from './native-host-contract-inbox-organize-create';
import type { NativeProjectTasksMoveParams } from './native-host-contract-project-bulk-status';
import type { BulkOrganizeDraft } from './task-list-bulk-actions';
import { referenceBatchModules } from './store-reference-batch-modules';

export type NativeProjectOrganizeDestinationCreateRequest = { requestId: string; source: 'project'; kind: 'project' | 'area'; name: string;
    draft: BulkOrganizeDraft; offerRevision: string; taskIds: string[]; taskRevisions: Record<string, string>; params: NativeProjectTasksMoveParams };
export type NativeProjectOrganizeDestinationCreateResult = NativeInboxOrganizeDestinationCreateResult;
export type NativeProjectOrganizeDestinationCreatePrepared = Omit<NativeInboxOrganizeDestinationCreatePrepared, 'request'> & { request: NativeProjectOrganizeDestinationCreateRequest };
export type NativeProjectOrganizeDestinationCreateEnvelope = { request: NativeProjectOrganizeDestinationCreateRequest; prepared: NativeProjectOrganizeDestinationCreatePrepared };
export type NativeProjectOrganizeDestinationCreatePreparation = { kind: 'prepared'; prepared: NativeProjectOrganizeDestinationCreatePrepared };

export function createProjectOrganizeDestinationCreateMethods(deps: Parameters<typeof createOrganizeDestinationCreateMethods>[0]) {
    const methods = createOrganizeDestinationCreateMethods(deps, 'project');
    return {
        prepareProjectOrganizeDestinationCreate: (input: NativeProjectOrganizeDestinationCreateRequest) => methods.prepareOrganizeDestinationCreate(input) as Promise<NativeHostResult<NativeProjectOrganizeDestinationCreatePreparation>>,
        validatePreparedProjectOrganizeDestinationCreate: (input: NativeProjectOrganizeDestinationCreateEnvelope) => methods.validatePreparedOrganizeDestinationCreate(input),
        projectOrganizeDestinationCreateOutcome: (input: NativeProjectOrganizeDestinationCreateEnvelope) => methods.organizeDestinationCreateOutcome(input),
        commitPreparedProjectOrganizeDestinationCreate: (input: NativeProjectOrganizeDestinationCreateEnvelope) => methods.commitPreparedOrganizeDestinationCreate(input),
    };
}
referenceBatchModules.projectOrganizeCreate = input => {
    const prepared = input as NativeProjectOrganizeDestinationCreatePrepared;
    return { validateEnvelope: () => Boolean(readOrganizeDestinationCreateEnvelope({ request: prepared.request, prepared }, 'project')),
        authorityMatches: data => organizeDestinationCreateAuthorityMatches(prepared, data),
        temporal: { futureBoundary: prepared.futureBoundary, dates: new Map(prepared.dates.map(row => [row.value, row])) } };
};
