import type { historyRowLoadProjection } from './native-host-contract-task-checklist';
import type { NativeReceiptSqliteAdapter } from './native-request-receipts';
import type { AppData } from './types';


export type ReferenceBatchValidator = { validateEnvelope: () => boolean; authorityMatches: (data: AppData) => boolean };


export const referenceBatchModules: {
    shared?: { historyRowLoadProjection: typeof historyRowLoadProjection; NativeReceiptSqliteAdapter: typeof NativeReceiptSqliteAdapter };
    inboxRemoveTag?: (input: unknown) => ReferenceBatchValidator;
    inboxOrganize?: (input: unknown) => ReferenceBatchValidator;
    inboxOrganizeCreate?: (input: unknown) => ReferenceBatchValidator;
    inboxAddTag?: (input: unknown) => ReferenceBatchValidator;
    inboxMove?: (input: unknown) => ReferenceBatchValidator;
    move?: (input: unknown) => ReferenceBatchValidator;
    addTag?: (input: unknown) => ReferenceBatchValidator;
    removeTag?: (input: unknown) => ReferenceBatchValidator;
} = {};
