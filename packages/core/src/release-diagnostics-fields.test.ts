import { describe, expect, it } from 'vitest';

import { sanitizeLogContext } from './log-sanitize';

/**
 * Every field name a release-diagnostics line uses (`docs/release-notes/diagnostics-ledger.md`).
 *
 * `shouldRedactKey` matches by SUBSTRING, so a plausible-looking field name is silently
 * replaced with `[redacted]` and the tester's log proves nothing: `skippedPasses` contains
 * `pass`, `monkeyIndex` contains `key`, `userAgent` contains `user`. That is invisible at
 * the call site and only shows up in a log nobody re-reads until the release is out.
 *
 * Update this list when the ledger's version section changes.
 */
const RELEASE_CHECK_FIELD_NAMES = [
    // task-copy-diagnostics reuses releaseCheck and outcome below; source is the menu/shortcut category.
    'source', 'documentFocused', 'activationSupported', 'activationActive', 'clipboardAvailable', 'errorKind',
    // ios-search-publication reuses releaseCheck, operation, outcome, enabled, and count below.
    // ios-search-snapshot reuses releaseCheck and count below.
    // ios-entity-link reuses releaseCheck, kind, and outcome below.
    // obsidian-inline-tag reuses releaseCheck and count below.
    // webdav-host-upload-limit and webdav-host-download-limit reuse releaseCheck, operation, and outcome below.
    // ios-local-attachment-host, ios-attachment-draft-owned, ios-http-transport, ios-secure-storage, ios-sync-crypto, ios-device-storage and ios-legacy-secret-retirement reuse releaseCheck, operation, and outcome below.
    // automation concurrent-write replay; capture routing reuses outcome below.
    'enabled',
    'retryCount',
    // deferred-attachment-pass: which pass owes the deferred pre-sync phase's work.
    'owed',
    // candidate-ciphertext-probe: what the activation candidate's folder held (plaintext, encrypted or mixed).
    'found',
    // widget-publication-after-content: what ran the held widget publication (content, boot-timeout, resume-fallback).
    'trigger',
    // calendar-mirror-filter reuses releaseCheck, platform, stage, and count below.
    // calendar-date-color-diagnostics uses only aggregate counts; no dates, names, ids, or colors.
    'calendarCount', 'eventCount', 'allDayCount', 'timedCount',
    'allDayNonMidnightCount', 'localDayAheadCount', 'localDayBehindCount',
    'nativeColorCount', 'fallbackColorCount',
    // someday-section-move reuses releaseCheck, count, and operation below.
    // archive-reactivation-validation reuses releaseCheck, outcome, and count below.
    // mcp-core-log-stderr: count of the first event actually forwarded.
    'forwardedEventCount',
    // shortcut-failure-privacy reuses releaseCheck and stage below.
    // share-handoff-route reuses releaseCheck, stage, and delivery below.
    // next-action-save-edit reuses releaseCheck and stage below.
    // legacy-capture-audio: HTTP method plus existing releaseCheck/operation/outcome.
    'method',
    // capture-token-revocation reuses releaseCheck and outcome below.
    // cloud-attachment-gc-retention reuses releaseCheck, count, operation, and outcome below.
    // archive-section-retention: number of restorable sections kept during timed cleanup.
    'retainedSectionCount',
    // archive-retention: counts from a durably saved expiration batch.
    'taskCount', 'projectCount', 'sectionCount',
    // ios-readonly-task-preview: saved viewer cache counts, never task content.
    'checklistCount', 'attachmentCount',
    // Apple development evaluations (#915, #1194, #1214, #1195).
    // apple-pcc-evaluation: fixed synthetic fixture identifier and elapsed request time.
    'fixtureId', 'durationMs',
    'statusIncluded', 'associationCount', 'dateCount', 'failureClass',
    'matchCount', 'acceptedCount', 'droppedCount',
    'snapshotVersion', 'publishedCount', 'omittedCount', 'exactLinkCount',
    // local-crash-capture: bounded app/build and technical exception metadata.
    'appVersion', 'buildVersion', 'exceptionType',
    // ios-scene-lifecycle: fixed native scene/delivery categories, never URLs or task content.
    'deliveryKind',
    // feedback-diagnostics: opt-in snapshot of bounded session and saved logs.
    'captureMode', 'diagnosticTruncated', 'debugLoggingEnabled', 'breadcrumbCount', 'breadcrumbs',
    // share-card-export (local PNG export adapters)
    'cardKind', 'exportMethod', 'failureStage', 'errorType', 'nativeCode',
    // file-sync-attachment-failure reuses errorType/nativeCode and stage/backend/operation/releaseCheck below.
    // android-system-bars reuses releaseCheck/backend/outcome below.
    // sandbox-workspace (desktop/mobile entry drain and immutable workspace bootstrap)
    'workspace', 'stage',
    // watcher-property-order reuses releaseCheck below.
    // storage-baseline-equality reuses releaseCheck below.
    // derived-token-timestamps reuses releaseCheck below.
    // sqlite-snapshot-append reuses releaseCheck and count below.
    // sqlite-snapshot-statements reuses releaseCheck and count below.
    // sqlite-kept-omitted-live-rows: SQLite table name; reuses releaseCheck and count below.
    // project-attachment-open-no-write reuses releaseCheck below.
    // editor-attachment-save-merge reuses releaseCheck and outcome below.
    // webdav-download-not-found reuses releaseCheck below (the attachment log adds error).
    'table',
    // pending-capture-unfinished: owed or queued; reuses releaseCheck.
    'state',
    // ai-request-stop-once (desktop/mobile AI configuration adapters)
    'provider', 'timeoutMs',
    // sync-attachment-copy-elision reuses releaseCheck and count below.
    // project-lifecycle-sync reuses releaseCheck and count below.
    // sync-signature-pruning reuses releaseCheck, elapsedMs, and count below.
    // pomodoro-alert-delivery reuses releaseCheck, reason, outcome, and count below.
    // reminder-withdrawn-clears-tray reuses releaseCheck, reason, and count below.
    // stale-reminder-guard reuses releaseCheck, reason, and count below.
    // delivered-reminder-withdrawn reuses releaseCheck and count below.
    // denied-resume-cleanup reuses releaseCheck below.
    // daily-digest-independent proves the explicit daily switches reconcile with task reminders off.
    'taskRemindersEnabled', 'morningDigestEnabled', 'eveningDigestEnabled',
    // settings-lazy-resources (desktop SettingsView)
    'page', 'integrationsLoadEnabled', 'syncLoadEnabled', 'advancedLoadEnabled',
    // startup-readiness (mobile and desktop)
    'route', 'elapsedMs', 'moduleElapsedMs',
    // Global shortcut startup: bounded configured and applied shortcut names.
    'requestedShortcut', 'appliedShortcut',
    // cleanup-batch-fresh-first: batch size and how many targets still had work (with total below).
    'limit', 'fresh',
    // ios-reminder-apply: confirmed native effect counts.
    'scheduled', 'cancelled',
    // PR1348 native reminder replacement fields.
    'tagged', 'replaced', 'taggedRemoved',
    'releaseCheck', 'backend', 'statusPublished', 'lastSyncAt', 'lastSyncStatus',
    'artifact', 'cloudProvider', 'scheme', 'host', 'delivery', 'deduped',
    // UpNote handoff diagnostics contain only the surface, scheme and outcome.
    'surface',
    'platform', 'total', 'multiDay', 'allDay', 'spanning',
    'presenceDue', 'hasScope', 'check', 'skipped', 'publication',
    // webdav-presence-proof (desktop/mobile WebDAV attachment adapters)
    'checked', 'cleared', 'complete',
    // Mobile background sync registration checked (General, apps/mobile/lib/background-sync-task.ts)
    'decision', 'registered', 'storedInterval', 'interval', 'appState',
    // desktop-reminder-fired / desktop-notification-path (apps/desktop/src/lib/notification-service.tsx)
    'kind', 'entity', 'fireAt', 'path', 'error',
    'deferred', 'ids',
    // cloud-data-body-limit reuses status below: the sync data size and the server's limit, in bytes.
    'limitBytes', 'bodyBytes',
    // streamed-upload-head-fallback (core WebDAV attachment pass): the attachment id only.
    'id',
    // webdav-activation-batches (core activation coordinator)
    'batches',
    // attachment-only-task-replace (store-settings.ts) / section-conversion-canonical (store-tasks.ts)
    'count',
    // someday-sections-keep-others reuses releaseCheck and count: stored entries this build cannot show, kept.
    'hiddenCount',
    // saved-filters-kept-as-stored reuses releaseCheck, count and hiddenCount: whose list order the merge kept.
    // local-api-scheduled-focus reuses releaseCheck, operation, outcome, and count below.
    'order',
    // android-http-connect-timeout (apps/mobile/hooks/root-layout/use-root-layout-startup.ts)
    'connectTimeoutMs',
    // fence-mutation-horizon (packages/core/src/sync-remote-fence.ts)
    'horizonMs', 'remainingMs',
    // Sync cycle requeued (General trail, #1170)
    'reason', 'detail',
    // android-native-widget (apps/mobile/lib/widget-service.ts) / android-widget-checkoff (pending-captures.ts)
    'items', 'outcome',
    // calendar-timed-deadlines: display mode only; count and outcome are above.
    'mode',
    // webkit-renderer-recovery: fixed native window kind, never page contents.
    'window',
    // android-widget-provider-compat (apps/mobile/lib/widget-service.ts)
    'legacyWidgetCount',
    // widget-focus-today (curated Android widget publication, #1173)
    'focusItems', 'todayItems', 'totalItems',
    // android-widget-lists (bounded GTD snapshots and Compact fallback, #1211)
    'nextItems', 'inboxItems', 'listKind', 'available',
    // Android widget list budget (measured direct RemoteViews collection size)
    'collectionBytes',
    // Apple Watch capture, command and Focus/timer snapshot (#1175)
    'action', 'focusCount', 'timerPhase', 'timerRunning',
    // Cloud Focus creation and PATCH policy (apps/cloud/src/server.ts)
    'operation',
    // cloudkit-retry-hint (desktop and mobile cloudkit-sync.ts)
    'retryAfterMs',
    // fetch-redirect-refused (core http-utils.ts) reuses method above: the refused redirect's HTTP status.
    'status',
    // font-family-applied (apps/desktop/src/App.tsx, #1244) — the chosen font's name, and
    // whether the renderer found a real bold face for it or is faking one.
    'family', 'boldFace',
    // native-android-legacy-json-import reuses releaseCheck, outcome, path, and reason above.
    'rnState', 'backupTasks', 'sqliteTasks', 'mergedTasks', 'tasksFromBackup',
    // calendar-push-owned-only (core calendar-push-service.ts) reuses releaseCheck, outcome and error above.
    // ios-share-capture (mobile incoming share host and capture form)
    'stage', 'type', 'providerReady', 'dataReady', 'disabled',
    'fileCount', 'candidateCount', 'attachedCount', 'skippedCount',
    // native-about-update-check, native-about-feedback, native-analytics-heartbeat, native-analytics-opt-out and
    // native-store-review (v1.3.5) reuse releaseCheck, mode and outcome above.
    'source', 'play', 'badge', 'notice', 'diagnostics', 'channel', 'request', 'optedOut',
];

describe('release diagnostics field names', () => {
    it('preserves the fixed iOS legacy secret retirement receipt', () => {
        const receipt = { releaseCheck: 'v1.3.5/ios-legacy-secret-retirement', operation: 'legacy-secret-retirement', outcome: 'delivered' };
        expect(sanitizeLogContext(receipt)).toEqual(receipt);
    });

    it('preserves the fixed iOS device storage delivery receipt', () => {
        const receipt = { releaseCheck: 'v1.3.5/ios-device-storage', operation: 'device-storage', outcome: 'delivered' };
        expect(sanitizeLogContext(receipt)).toEqual(receipt);
    });

    it('survive the log sanitizer intact', () => {
        const probe = Object.fromEntries(RELEASE_CHECK_FIELD_NAMES.map((name) => [name, 'probe-value']));
        const sanitized = sanitizeLogContext(probe) ?? {};
        const redacted = RELEASE_CHECK_FIELD_NAMES.filter((name) => sanitized[name] !== 'probe-value');
        expect(redacted).toEqual([]);
    });

    it('fails for a name the sanitizer redacts by substring', () => {
        expect(sanitizeLogContext({ skippedPasses: 'a,b' })?.skippedPasses).toBe('[redacted]');
    });
});
