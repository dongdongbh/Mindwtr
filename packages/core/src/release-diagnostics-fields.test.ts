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
    // MCP view-section writes reuse operation below; entityType is task/project, never an ID.
    'entityType',
    // Android modal IME recovery and background reminder widget publication; no identifiers.
    'eventInset', 'nativeInset', 'widgetUpdated',
    // auto-archive-converge reuses releaseCheck/count; count = archive-twin task pairs joined in one merge pass.
    // gmail-capture reuses releaseCheck/count; gmail-capture-storage reuses stage/errorKind. Never account or mail content.
    // focus-area-selection: aggregate selected slots only.
    'globalCount', 'hiddenByAreaCount',
    // project-color reuses releaseCheck and mode; no identity or color values.
    // section-flow-mode reuses releaseCheck and mode; sectionDefaults is a count. No titles or identifiers.
    'sectionDefaults',

    // web-attachment-upload reuses releaseCheck, stage and count; only acknowledged PUTs.
    // android-widget-capture-status: bounded creation status and picker origin; kind/outcome below.
    'destination', 'selection',
    // quick-capture-description reuses releaseCheck, kind and outcome; no captured text.
    // app-search-owed-wipe reuses releaseCheck and outcome below.
    // native-app-search reuses releaseCheck and outcome below.
    // onboarding-waits-for-canonical-load reuses releaseCheck and outcome below.
    // restore-attachment-presence reuses releaseCheck and count below; no names or paths.
    // leftover-undo-hold reuses releaseCheck and outcome below.
    // large-library-no-undo reuses releaseCheck, operation and outcome below; no names or paths.
    // ios-reminder-actions reuses releaseCheck, stage, action, reason, and appState below.
    // ios-task-badge reuses releaseCheck, count, and enabled below.
    'result',
    // follow-up-idle-badge reuses releaseCheck and backend below.
    // ios-native-text-decode: bytes is the response body's size; no content or URL.
    'bytes',
    // local-change-upload reuses releaseCheck, source and delayMs; adaptiveWaitMs is the skipped adaptive wait.
    'adaptiveWaitMs',
    // windowless-sync: existing periodic timer timing and lifecycle gates only.
    'delayMs', 'latenessMs', 'runtimeActive', 'editorPause', 'minIntervalMs', 'success',
    // sync-field-merge reuses entity below; fields is a comma list of task/project field names, never values.
    'fields',
    // timeline-shared-order reuses releaseCheck, kind, and outcome below; no content or IDs.
    // mcp-access-controls: device-local grants, loopback port, fixed denied category; no payload.
    'allowWrite', 'allowArchive', 'allowDelete', 'port', 'category',
    // mcp-codex-copy reuses releaseCheck, operation, outcome, backend below.
    // linux-task-link-launcher reuses releaseCheck and outcome below; no executable paths.
    // sync-write-gate reuses backend below; step is the sync step name; gateWaitMs lists each save's wait for the gate.
    'step', 'gateWaitMs',
    // native-sync-slices reuses backend and gateWaitMs: each save's time in the gate, its publish (prepared or in-gate),
    // the slices that gave the engine back and the longest, the store's subscribers, and the requeue reason.
    'commitPublishMs', 'storePublish', 'slices', 'longestSliceMs', 'storeListeners', 'requeue',
    // sync-status-published (v1.2.7 line): storeRefresh=dropped when a sliced cycle skipped its end-of-cycle load.
    'storeRefresh',
    // linux-quick-add-focus reuses backend and outcome below; no window or input content.
    // inactive-sync-credential: fixed service category only; no endpoint or secret.
    'service',
    // webdav-settings-clear reuses backend and outcome below.
    // webdav-setup-probe: fixed posture/outcome categories and an optional validated HTTP status.
    'requireStrongEtag', 'httpStatus',
    // mobile-sync-follow-up: fixed request class, one aggregate comparison; no IDs, values or paths.
    'requestClass', 'comparison',
    'outgoingTasksSig', 'outgoingProjectsSig', 'outgoingSectionsSig', 'outgoingAreasSig', 'outgoingPeopleSig', 'outgoingSettingsSig',
    'priorRemoteTasksSig', 'priorRemoteProjectsSig', 'priorRemoteSectionsSig', 'priorRemoteAreasSig', 'priorRemotePeopleSig', 'priorRemoteSettingsSig',
    // native-large-transfer: Settings › Data's operation sizes and memory peaks in whole MiB, and its seconds (pass D1c).
    'sourceMiB', 'libraryMiB', 'seconds', 'nativePeakMiB', 'javaPeakMiB',
    // native-share-files reuses skipped below; counts only.
    'candidates', 'attached', 'unreadable',
    // webdav-weak-etag-adopt: per-pass counts only; no URL, cloud key or id.
    'adopted', 'refused',
    // reminder-boot-recovery: native scheduling acknowledgments, not a DB-row inventory count.
    'requested', 'rearmed', 'skipped', 'failed', 'bootEnabled', 'exactAllowed',
    // renderer-navigation: fixed route categories, a runtime token, and coarse library sizes.
    'rendererRun', 'navigationSequence', 'previousView', 'nextView', 'actualView',
    'taskCountBucket', 'projectCountBucket', 'trashCountBucket', 'historyCountBucket',
    'referenceCountBucket', 'boardCountBucket', 'density', 'showDetails', 'editorOpen', 'documentVisibility',
    // renderer-view-work: process-local owners and bounded effect aggregates only.
    'currentNavigationSequence', 'activitySequence', 'activity', 'attachMode', 'callbackCount', 'widthChangeCount',
    'width', 'measured', 'todayVisible', 'zoom', 'filteredCountBucket', 'visibleCountBucket',
    'sequentialProjectCountBucket', 'sequentialResultCountBucket',
    // task-link-open reuses releaseCheck and outcome below.
    // task-copy-diagnostics reuses releaseCheck and outcome below; source is the menu/shortcut category.
    'source', 'documentFocused', 'activationSupported', 'activationActive', 'clipboardAvailable', 'errorKind',
    // task-copy-input: click trust and coarse pointer/keyboard-or-assistive classification only.
    'inputTrusted', 'inputKind',
    // ios-process-inbox-undo reuses releaseCheck, kind, and outcome below.
    // ios-inbox-filters reuses releaseCheck, operation, and count below.
    // ios-inbox-bulk-trash reuses releaseCheck, count, and outcome below.
    // ios-inbox-group: fixed grouping choice and aggregate folded headings.
    'axis', 'collapsedCount',
    // ios-search-publication reuses releaseCheck, operation, outcome, enabled, and count below.
    // ios-search-snapshot reuses releaseCheck and count below.
    // pomodoro-alarm-rearm and pomodoro-credit-durable reuse releaseCheck and outcome below.
    // widget-context-selection reuses releaseCheck and count below; lists counts the built context/tag/filter lists.
    'lists',
    // widget-upcoming reuses releaseCheck, platform, and count below.
    // task-date-filter reuses releaseCheck, count, and outcome below; no content or IDs.
    // ios-entity-link reuses releaseCheck, kind, and outcome below.
    // obsidian-inline-tag reuses releaseCheck and count below.
    // webdav-host-upload-limit and webdav-host-download-limit reuse releaseCheck, operation, and outcome below.
    // ios-local-attachment-host, ios-attachment-draft-owned, ios-http-transport, ios-secure-storage, ios-sync-crypto, ios-device-storage and ios-legacy-secret-retirement reuse releaseCheck, operation, and outcome below.
    // automation concurrent-write replay; capture routing reuses outcome below.
    'enabled',
    'retryCount',
    // ios-reminders-run: aggregate acknowledged items and failures, never reminder content.
    'importedCount', 'failedCount',
    // ios-board-order: bounded aggregate affected rows, never identity/order/content.
    'affectedCount',
    // deferred-attachment-pass: which pass owes the deferred pre-sync phase's work.
    'owed',
    // native-android-calendar-feeds: which screen's external calendars loaded (calendar, weeklyReview, dailyReview); outcome and the counts are below.
    'slot',
    // candidate-ciphertext-probe: what the activation candidate's folder held (plaintext, encrypted or mixed).
    'found',
    // native-splash-cap reuses releaseCheck, stage, and durationMs below.
    // widget-publication-after-content: what ran the held widget publication (content, boot-timeout, resume-fallback).
    'trigger',
    // calendar-mirror-filter reuses releaseCheck, platform, stage, and count below.
    // calendar-date-color-diagnostics uses only aggregate counts; no dates, names, ids, or colors.
    'calendarCount', 'eventCount', 'allDayCount', 'timedCount',
    'allDayNonMidnightCount', 'localDayAheadCount', 'localDayBehindCount',
    'nativeColorCount', 'fallbackColorCount',
    // someday-section-move reuses releaseCheck, count, and operation below.
    // start-only-recurrence reuses releaseCheck, outcome, and count below; no task data.
    // archive-reactivation-validation reuses releaseCheck, outcome, and count below.
    // mcp-core-log-stderr: count of the first event actually forwarded.
    'forwardedEventCount',
    // shortcut-failure-privacy reuses releaseCheck and stage below.
    // share-handoff-route reuses releaseCheck, stage, and delivery below.
    // next-action-save-edit reuses releaseCheck and stage below.
    // legacy-capture-audio: HTTP method plus existing releaseCheck/operation/outcome.
    'method',
    // capture-token-revocation reuses releaseCheck and outcome below.
    // native-android-legacy-preflight reuses releaseCheck and outcome below.
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
    // android-backup-export: the exported file's kind (json, csv, tasknotes); it reuses route and releaseCheck.
    // android-backup-replay and android-export-cleanup reuse operation and outcome.
    'format',
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
    // android-installer-source (v1.3.5) reuses source above.
    'installer',
    // Android quick-capture IME observations (#1347): geometry and lifecycle only.
    'captureRun', 'captureAttempt', 'phase', 'appliedInset', 'avoidanceEnabled',
    'expanded', 'autoRecord', 'inputMounted', 'focusTracked',
    'windowWidth', 'windowHeight', 'screenWidth', 'screenHeight',
    'imeVisible', 'imeMetricsX', 'imeMetricsY', 'imeMetricsWidth', 'imeMetricsHeight',
    'imeEventX', 'imeEventY', 'imeEventWidth', 'imeEventHeight',
    'inputX', 'inputY', 'inputWidth', 'inputHeight', 'inputBottom',
    // sqlite-adapter-lock reuses operation above; waitMs is how long the caller waited for the lock.
    'waitMs',
    // attachment-remote-winner-pending and attachment-download-reuse (which reuses kind above): the attachment's own id, no title or path.
    'attachmentId',
    // Saved contexts and tags: catalogue kind only, never names.
    'taxonomyKind',
    // ios-background-sync-hold reuses releaseCheck, source and outcome; heldMs is how long iOS kept the app running.
    'heldMs',
];

describe('release diagnostics field names', () => {
    it('preserves the saved taxonomy persistence proof without token content', () => {
        const receipt = { releaseCheck: 'v1.3.7/saved-taxonomy', taxonomyKind: 'context', operation: 'create', outcome: 'persisted' };
        expect(sanitizeLogContext(receipt)).toEqual(receipt);
    });
    it('preserves the content-free iOS background sync hold receipt', () => {
        const started = { releaseCheck: 'v1.3.7/ios-background-sync-hold', source: 'app-left' };
        const ended = { releaseCheck: 'v1.3.7/ios-background-sync-hold', outcome: 'expired', heldMs: '29000' };
        expect(sanitizeLogContext(started)).toEqual(started);
        expect(sanitizeLogContext(ended)).toEqual(ended);
    });
    it('preserves the content-free windowless sync timer receipt', () => {
        const receipt = {
            releaseCheck: 'v1.3.7/windowless-sync', documentVisibility: 'hidden', delayMs: '900000',
            latenessMs: '25000', runtimeActive: 'true', editorPause: 'false', outcome: 'requested',
        };
        expect(sanitizeLogContext(receipt)).toEqual(receipt);
    });
    it('preserves the bounded WebDAV setup probe receipt', () => {
        const receipt = {
            releaseCheck: 'v1.3.5/webdav-setup-probe', phase: 'compatibility', outcome: 'failed',
            reason: 'http', requireStrongEtag: 'false', httpStatus: '401',
        };
        expect(sanitizeLogContext(receipt)).toEqual(receipt);
    });
    it('preserves the content-free start-only recurrence receipt', () => {
        const receipt = { releaseCheck: 'v1.3.5/start-only-recurrence', outcome: 'generated', count: 1 };
        expect(sanitizeLogContext(receipt)).toEqual({ ...receipt, count: '1' });
    });

    it.each(['deleted', 'restored'])('preserves content-free Inbox bulk Trash %s acknowledgement fields', outcome => {
        const receipt = { releaseCheck: 'v1.3.5/ios-inbox-bulk-trash', count: 2, outcome };
        expect(sanitizeLogContext(receipt)).toEqual({ ...receipt, count: '2' });
    });

    it('preserves the content-free native Pomodoro SQL confirmation', () => {
        const receipt = { releaseCheck: 'v1.3.5/ios-pomodoro-credit', outcome: 'confirmed' };
        expect(sanitizeLogContext(receipt)).toEqual(receipt);
    });
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
