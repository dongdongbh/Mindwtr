import type { historyRowLoadProjection } from './native-host-contract-task-checklist';
import type { NativeReceiptSqliteAdapter } from './native-request-receipts';
import type { AppData } from './types';

/** One Reference batch family's checks, bound to the prepared input the store action holds. */
export type ReferenceBatchValidator = { validateEnvelope: () => boolean; authorityMatches: (data: AppData) => boolean };

/**
 * What the store's Reference batch actions need from modules that import the store: each module registers itself here when
 * it loads, and the actions read the slots when they run. A static import from the store would be an initialization cycle,
 * and a dynamic import() made esbuild wrap every module of the native bundle lazily (1,300 of them; about 70 ms more to the
 * Android app's first content on the S23). A slot nobody filled leaves the action failing closed.
 */
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
