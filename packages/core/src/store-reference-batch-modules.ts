import type { historyRowLoadProjection } from './native-host-contract-task-checklist';
import type { NativeReceiptSqliteAdapter } from './native-request-receipts';
import type { AppData } from './types';
import type { TaskLoadTemporalContext } from './task-status';

/** One Reference batch family's checks, bound to the prepared input the store action holds. */
export type ReferenceBatchValidator = { validateEnvelope: () => boolean; authorityMatches: (data: AppData) => boolean;
    temporal?: TaskLoadTemporalContext };


export const referenceBatchModules: {
    shared?: { historyRowLoadProjection: typeof historyRowLoadProjection; NativeReceiptSqliteAdapter: typeof NativeReceiptSqliteAdapter };
    inboxRemoveTag?: (input: unknown) => ReferenceBatchValidator;
    projectRemoveTag?: (input: unknown) => ReferenceBatchValidator;
    projectOrganize?: (input: unknown) => ReferenceBatchValidator;
    inboxOrganize?: (input: unknown) => ReferenceBatchValidator;
    inboxOrganizeCreate?: (input: unknown) => ReferenceBatchValidator;
    projectOrganizeCreate?: (input: unknown) => ReferenceBatchValidator;
    inboxAddTag?: (input: unknown) => ReferenceBatchValidator;
    projectAddTag?: (input: unknown) => ReferenceBatchValidator;
    inboxMove?: (input: unknown) => ReferenceBatchValidator;
    projectMove?: (input: unknown) => ReferenceBatchValidator;
    move?: (input: unknown) => ReferenceBatchValidator;
    addTag?: (input: unknown) => ReferenceBatchValidator;
    removeTag?: (input: unknown) => ReferenceBatchValidator;
} = {};
