// packages/core barrel: every module in this package is re-exported here with `export *`,
// uniformly, so that anything published from a `.ts` file under src/ is reachable both as a
// named import from '@mindwtr/core' and as '@mindwtr/core/<module>'.
//
// Mobile's Metro resolver collapses EVERY '@mindwtr/core/<module>' subpath onto this file and
// ignores package.json "exports" entirely (see apps/mobile/metro.config.js). A module that
// isn't re-exported here is `undefined` at runtime on a real device even though vitest (Node
// resolution, which does honour package.json exports) resolves it fine and every test passes.
// The uniform `export *` convention below exists specifically to make that bug class impossible:
// a module reachable from src/ is barrel-reachable by construction. Guarded by
// index-exports.test.ts.
//
// One deliberate exception: toStableSyncJson is also exported under its old alias
// toStableJson. This preserves the public name without duplicating its implementation.

export * from './types';
export { isSettingsSyncGroupEnabled } from './settings-options';
export * from './async-utils';
export * from './storage';
export * from './range-selection';
export * from './task-metadata-filter-visibility';
export { buildTaskMovePatch, type TaskMoveDestination } from './task-container-rules';
export * from './resolve-feature-flags';
export * from './bulk-organize';
export * from './bulk-organize-create';
export * from './announcements';
export * from './app-store-update';
export * from './user-prompts';
export * from './share-card';
export * from './process-inbox-workflow';
export * from './process-inbox-session';
export * from './process-inbox-plan';
export * from './process-inbox-model';
export * from './speech-to-task';
export * from './data-transfer-transaction';
export * from './feedback';
export * from './feedback-diagnostics';
export * from './about-settings-model';
export * from './sandbox';
export * from './sandbox-data';
export * from './store';
export * from './native-host-contract';
export * from './native-host-contract-calendar';
export * from './native-host-contract-saved-search-write';
export * from './native-host-contract-attachments';
export * from './native-host-contract-area-rename';
export * from './native-host-contract-person-create';
export * from './native-host-contract-person-delete';
export * from './native-host-contract-project-focus';
export * from './native-host-contract-task-focus';
export * from './native-host-contract-project-rename';
export * from './native-host-contract-project-flow';
export * from './native-host-contract-project-notes';
export * from './native-host-contract-project-tags';
export * from './native-host-contract-project-attachments';
export * from './native-host-contract-project-file-add';
export * from './project-tags';
export * from './native-host-contract-project-status';
export * from './native-host-contract-project-date';
export * from './native-host-contract-project-section';
export * from './native-host-contract-project-section-rename';
export * from './native-host-contract-project-section-delete';
export * from './native-host-contract-project-section-order';
export * from './native-host-contract-quick-capture';
export * from './native-host-contract-task-save';
export * from './task-creation';
export { taskRevisionOf, NATIVE_UNJOURNALED_COMMANDS, NativeReceiptSqliteAdapter, loadNativeRequestReceipts, pruneNativeRequestReceipts, setNativeReplayTokens, type NativeReplayTokens } from './native-request-receipts';
export * from './legacy-json-import';
export { buildNewProject, MAX_FOCUSED_PROJECTS } from './store-projects/project-actions';
export { nameNotifyListener } from './store-notify-profiler';
export * from './store-types';
export * from './project-to-section';
export * from './area-rename';
export * from './store-helpers';
export * from './sync';
export * from './tombstone-compaction';
export * from './task-date-coherence';
export * from './timeline-date-edit';
export * from './sync-normalization';
export * from './sync-document';
export * from './sync-helpers';
export { toStableSyncJson as toStableJson } from './sync-helpers'; // preserved alias; the plain name is also re-exported via `export *` above
export * from './sync-log-utils';
export * from './sync-client-helpers';
export * from './sync-runtime-utils';
export * from './sync-orchestrator';
export * from './auto-sync-controller';
export * from './sync-configuration-transaction';
export * from './sync-service-utils';
export * from './sync-run';
export * from './sync-run-ports';
export * from './sync-payload-trace';
export * from './sync-backend-io';
export * from './sync-fast-sync';
export * from './sync-crypto';
export * from './sync-encryption';
export * from './sync-encryption-diagnostics';
export * from './sync-remote-fence';
export * from './sync-remote-fence-providers';
export * from './sync-storage-keys';
export * from './sync-rate-limit';
export * from './sync-secret-storage';
export * from './dropbox-auth-tokens';
export * from './base64-bytes';
export * from './sync-encryption-local-state';
export * from './sync-encryption-service';
export * from './mobile-sync-utils';
export * from './mobile-sync-service';
export * from './mobile-background-sync';
export * from './mobile-sync-triggers';
export * from './mobile-reminder-alarms';
export * from './mobile-notification-open';
export * from './mobile-attachment-files';
export * from './mobile-attachment-installer';
export * from './mobile-attachment-common';
export * from './mobile-attachment-availability';
export * from './mobile-attachment-cleanup';
export * from './mobile-attachment-backends';
export * from './attachment-editor-model';
export * from './mobile-sync-configuration-transaction';
export * from './sync-settings-model';
export * from './sync-settings-transport';
export * from './sync-encryption-card';
export * from './pending-captures';
export * from './context-automation';
export * from './diceware';
export * from './task-utils';
export * from './task-similarity';
export * from './task-list-sort-options';
export * from './view-sections';
export * from './task-speech';
export * from './completion-grouping';
export * from './filter-criteria';
export * from './task-filter-selections';
export * from './task-draft';
export * from './task-share';
export {
    type TaskTokenUsage,
    createTaskTokenUsageAccumulator,
    collectTaskTokenUsage,
    getUsedTaskTokens,
    getUsedTaskTokensFromUsage,
    getTaskContextMatches,
    getRetainedTaskContexts,
    getFrequentTaskTokens,
    getFrequentTaskTokensFromUsage,
    getRecentTaskTokens,
} from './task-token-usage';
export * from './people';
export * from './bulk-task-tokens';
export * from './task-list-bulk-actions';
export * from './contexts';
export * from './i18n';
export * from './i18n/i18n-storage';
export * from './i18n/i18n-loader';
export * from './i18n/i18n-constants';
export * from './recurrence';
export * from './recurrence-constants';
export * from './review-utils';
export * from './review-views-model';
export * from './board-view-model';
export * from './project-utils';
export * from './project-details-presentation';
export * from './project-row-meta';
export * from './project-task-list-model';
export * from './project-task-reorder';
export * from './task-row-meta';
export * from './list-filter-state';
export * from './list-count';
export * from './menu-views-model';
export * from './someday-sections-model';
export * from './native-host-contract-someday-section-create';
export * from './native-host-contract-someday-section-rename';
export * from './native-host-contract-unassigned-area-color';
export * from './native-host-contract-someday-section-delete';
export * from './native-host-contract-someday-section-order';
export * from './native-host-contract-someday-section-task';
export * from './native-host-contract-someday-section-move';
export * from './settings-menu-model';
export * from './general-settings-model';
export * from './manage-settings-model';
export * from './gtd-settings-model';
export * from './data-settings-model';
export * from './native-backup-document';
export * from './more-menu-model';
export * from './reference';
export * from './project-grouping';
export * from './focus-utils';
export * from './undo-task-completion';
export * from './undo-task-cancellation';
export * from './undo-project-delete';
export * from './uuid';
export * from './date';
export * from './quick-add';
export * from './area-filter';
export * from './area-utils';
export { areaOrderIdsForIntent, type AreaOrderIntent } from './area-ordering';
export { countLiveProjectsByArea } from './area-project-usage';
export * from './calendar-scheduling';
export * from './calendar-push-run';
export * from './calendar-push-service';
export * from './calendar-settings-model';
export * from './external-calendar-ingestion';
export * from './external-calendar-feeds';
export * from './schedule-utils';
export * from './time-spent';
export * from './digest-utils';
export * from './search';
export * from './search-highlight';
export * from './saved-filters';
export * from './saved-filter-labels';
export * from './hierarchy-utils';
export * from './markdown';
export * from './markdown-links';
export * from './markdown-blocks';
export * from './obsidian-parser';
export * from './tasknotes-parser';
export * from './webdav';
export * from './webdav-attachment-inventory';
export * from './webdav-capability-proof';
export * from './cloud';
export * from './http-utils';
export * from './retry-utils';
export * from './async-queue';
export * from './attachment-hash';
export * from './attachment-link-utils';
export * from './cloudkit-attachments';
export * from './attachment-validation';
export * from './attachment-change-detection';
export * from './attachment-progress';
export * from './attachment-transfer';
export * from './attachment-presence-repair';
export * from './attachment-paths';
export * from './attachment-draft-settlement';
export * from './attachment-cleanup';
export * from './native-attachment-cleanup';
export * from './ics';
export * from './external-calendar-colors';
export * from './task-relative-start';
export * from './task-status';
export * from './project-status';
export * from './text-direction';
export * from './ai/ai-service';
export * from './ai/utils';
export * from './ai/types';
export * from './ai/catalog';
export * from './ai/model-list';
export * from './ai-config';
export * from './ai-settings-model';
export * from './ai-task-actions';
export * from './sqlite-schema';
export * from './task-sync-schema';
export * from './project-sync-schema';
export * from './section-sync-schema';
export * from './sqlite-adapter';
export * from './logger';
export * from './diagnostics-log';
export * from './performance-log';
export * from './log-breadcrumbs';
export * from './pomodoro';
export * from './color-constants';
export * from './task-accent-color';
export * from './analytics-heartbeat';
export * from './dropbox-sync-utils';
export * from './dropbox';
export * from './backup-transfer';
export * from './todoist-import';
export * from './ticktick-import';
export * from './dgt-import';
export * from './omnifocus-import';
export * from './mindwtr-csv-import';
export * from './mindwtr-csv-export';
export * from './tasknotes-export';
export * from './mind-sweep';
export * from './mind-sweep-view-model';
export * from './saved-search-view-model';
export * from './focus-star';
export * from './focus-grouping';
export * from './focus-sections';
export * from './focus-controls';
export * from './focus-widget-selection';
export * from './context-color';
export * from './capture';
export * from './capture-session';
export * from './quick-capture-model';
export * from './capture-deeplink';
export * from './dropbox-auth-callback';
export * from './entry-points';
export * from './capture-modal-model';
export * from './session-restore';
export * from './whisper-models';
export * from './import-apply';
export * from './import-diagnostics';
export * from './import-runner';
export * from './global-search-filter';
export * from './global-search-model';
export * from './task-group-sections';
export * from './contexts-view-model';
export * from './archive-view-model';
export * from './archive-retention';
export * from './trash-view-model';
export * from './calendar-composer';
export * from './calendar-day-items';
export * from './calendar-view-model';
export * from './calendar-feed';
export * from './calendar-push-scheduler';
export * from './date-draft';
export * from './i18n/i18n-locales';
export * from './theme-scheme';
export * from './theme-presets';
export * from './focus-widget-filter';
export * from './widget-completion-token';
export * from './widget-lists';
export * from './widget-payload';
export * from './widget-list-destination';
export * from './startup-prompts';
export * from './area-sync-schema';
export * from './person-sync-schema';
export * from './import-source-reader';
export * from './settings-search-keys';
export * from './task-recurrence-fields';
export * from './task-editor-layout';
export * from './task-editor-model';
export * from './task-checklist-model';
export * from './task-view-model';
export * from './task-editor-schedule';
export * from './shared-api-write-limits';
export * from './task-query';
export * from './onboarding-guidance';
export * from './docs-guidance';
export { afterPaint } from './after-paint';
export { isGettingStartedProject } from './getting-started-seed';

export * from './native-host-contract-person-edit';
export * from './native-host-contract-taxonomy';
export * from './native-host-contract-general-preference';
export * from './native-host-contract-device-calendar-settings';
export * from './calendar-subscription-settings-witness';
export * from './native-host-contract-calendar-subscription-settings';
export { createCalendarSubscriptionAddMethods } from './native-host-contract-calendar-subscription-add';
export type { CalendarSubscriptionAddRequest, PreparedCalendarSubscriptionAdd, CalendarSubscriptionAddEnvelope,
    CalendarSubscriptionAddResult, CalendarSubscriptionAddPreparation } from './native-host-contract-calendar-subscription-add';
export { buildCalendarSubscriptionSettingsModel } from './native-host-contract-settings-calendar';
export * from './taxonomy-policy';

export type { NativeReferenceTasksMoveRequest, NativeReferenceTasksMovePrepared, NativeReferenceTasksMoveEnvelope,
    NativeReferenceTasksMoveResult, NativeReferenceTasksMovePreparation, NativeReferenceTasksMoveParams } from './native-host-contract-reference-bulk-status';

export type { NativeReferenceTasksAddTagRequest, NativeReferenceTasksAddTagPrepared, NativeReferenceTasksAddTagEnvelope,
    NativeReferenceTasksAddTagResult, NativeReferenceTasksAddTagPreparation } from './native-host-contract-reference-bulk-tag';

export type { NativeReferenceTasksRemoveTagRequest, NativeReferenceTasksRemoveTagPrepared, NativeReferenceTasksRemoveTagEnvelope,
    NativeReferenceTasksRemoveTagResult, NativeReferenceTasksRemoveTagPreparation } from './native-host-contract-reference-bulk-remove-tag';

export { validateNativeAttachmentDraftBegin, validateNativeAttachmentDraftLineage, prepareNativeAttachmentDraftAdd,
    completeNativeAttachmentDraftAdd, validateNativeAttachmentDraftBeginV2, validateNativeAttachmentDraftLineageV2,
    prepareNativeAttachmentDraftAddV2, validateNativeAttachmentDraftBeginV3, validateNativeAttachmentDraftLineageV3,
    prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftRemoveV3, readNativeAttachmentDraftRemoveFrozen } from './native-attachment-draft';
export type { NativeAttachmentDraftLineageInputV3, NativeAttachmentDraftOperationV3,
    NativeAttachmentDraftRemovePrepared } from './native-attachment-draft';

export { prepareNativeAttachmentDraftDiscardCandidates, prepareNativeAttachmentDraftDiscardCandidatesV3 } from './native-attachment-draft-discard';
export type { NativeAttachmentDraftDiscardInput, NativeAttachmentDraftDiscardPhase,
    NativeAttachmentDraftDiscardCandidates, NativeAttachmentDraftDiscardInputV3,
    NativeAttachmentDraftDiscardCandidatesV3 } from './native-attachment-draft-discard';

export type { OwnedFileAddSaveRequest, PreparedOwnedFileAddSave } from './native-host-contract-owned-file-save';

export type { OwnedEditorFileAddSaveRequest, PreparedOwnedEditorFileAddSave } from './native-host-contract-owned-editor-save';

export { validateNativeAttachmentDraftBeginV4, validateNativeAttachmentDraftLineageV4, prepareNativeAttachmentDraftAddV4,
    prepareNativeAttachmentDraftRemoveV4, completeNativeAttachmentDraftAddV4, readNativeAttachmentDraftFrozenV2 } from './native-attachment-draft';
export type { NativeAttachmentDraftPreparedV2, NativeAttachmentDraftAddedV2, NativeAttachmentDraftHashedFile,
    NativeAttachmentDraftOperationV4, NativeAttachmentDraftLineageInputV4, NativeAttachmentDraftLineageV4 } from './native-attachment-draft';
export { prepareNativeAttachmentDraftDiscardCandidatesV4 } from './native-attachment-draft-discard';
export type { NativeAttachmentDraftDiscardInputV4, NativeAttachmentDraftDiscardCandidatesV4 } from './native-attachment-draft-discard';

export { prepareNativeAttachmentDraftAvailability, readNativeAttachmentDraftAvailabilityFrozen,
    validateNativeAttachmentDraftBeginV5, validateNativeAttachmentDraftLineageV5 } from './native-attachment-draft';
export type { NativeAttachmentDraftAvailabilityInput, NativeAttachmentDraftAvailabilityPrepared, NativeAttachmentDraftOperationV5,
    NativeAttachmentDraftLineageInputV5, NativeAttachmentDraftLineageV5 } from './native-attachment-draft';
export { prepareNativeAttachmentDraftDiscardCandidatesV5 } from './native-attachment-draft-discard';
export type { NativeAttachmentDraftDiscardInputV5, NativeAttachmentDraftDiscardCandidatesV5 } from './native-attachment-draft-discard';

export { checklistProjectBlockReason, prepareChecklistProjectConversion } from './checklist-project-conversion';
export type { ChecklistProjectConversion } from './checklist-project-conversion';
