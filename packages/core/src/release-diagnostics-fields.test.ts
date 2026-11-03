import { describe, expect, it } from 'vitest';

import { sanitizeLogContext } from './log-sanitize';


const RELEASE_CHECK_FIELD_NAMES = [

    'staleTaskCount', 'staleProjectCount',
    'adopted', 'rowsBefore', 'rowsAfter',
    'section', 'grouping', 'collapsed', 'refresh',

    'entityType',

    'eventInset', 'nativeInset', 'widgetUpdated',


    'globalCount', 'hiddenByAreaCount',

    'entries', 'writes',

    'cleaned',


    'sectionDefaults',

    'missing',

    'restored',

    'job', 'reminders',

    'toast',

    'copied',


    'destination', 'selection',


    'result',


    'bytes',
    'version',
    'excludedProjectCount',
    'selectionStatusCount',

    'adaptiveWaitMs',

    'delayMs', 'latenessMs', 'runtimeActive', 'editorPause', 'minIntervalMs', 'success',

    'fields',


    'allowWrite', 'allowArchive', 'allowDelete', 'port', 'category',


    'step', 'gateWaitMs',

    'nullEntries', 'untitledTasks', 'untitledProjects', 'untitledSections', 'unnamedAreas', 'missingCreatedAt', 'orphanSections',


    'commitPublishMs', 'storePublish', 'slices', 'longestSliceMs', 'storeListeners', 'requeue',

    'storeRefresh',


    'service',


    'requireStrongEtag', 'httpStatus',

    'requestClass', 'comparison',
    'outgoingTasksSig', 'outgoingProjectsSig', 'outgoingSectionsSig', 'outgoingAreasSig', 'outgoingPeopleSig', 'outgoingSettingsSig',
    'priorRemoteTasksSig', 'priorRemoteProjectsSig', 'priorRemoteSectionsSig', 'priorRemoteAreasSig', 'priorRemotePeopleSig', 'priorRemoteSettingsSig',

    'sourceMiB', 'libraryMiB', 'seconds', 'nativePeakMiB', 'javaPeakMiB',

    'encrypted', 'retained',

    'candidates', 'attached', 'unreadable',

    'adopted', 'refused',

    'requested', 'rearmed', 'skipped', 'failed', 'bootEnabled', 'exactAllowed',

    'rendererRun', 'navigationSequence', 'previousView', 'nextView', 'actualView',
    'taskCountBucket', 'projectCountBucket', 'trashCountBucket', 'historyCountBucket',
    'referenceCountBucket', 'boardCountBucket', 'density', 'showDetails', 'editorOpen', 'documentVisibility',

    'currentNavigationSequence', 'activitySequence', 'activity', 'attachMode', 'callbackCount', 'widthChangeCount',
    'width', 'measured', 'todayVisible', 'zoom', 'filteredCountBucket', 'visibleCountBucket',
    'sequentialProjectCountBucket', 'sequentialResultCountBucket',


    'source', 'documentFocused', 'activationSupported', 'activationActive', 'clipboardAvailable', 'errorKind',

    'inputTrusted', 'inputKind',


    'axis', 'collapsedCount',


    'applied',

    'lists',


    'enabled',
    'retryCount',

    'importedCount', 'failedCount',

    'affectedCount',

    'owed',

    'slot',

    'found',


    'trigger',


    'calendarCount', 'eventCount', 'allDayCount', 'timedCount',
    'allDayNonMidnightCount', 'localDayAheadCount', 'localDayBehindCount',
    'nativeColorCount', 'fallbackColorCount',


    'forwardedEventCount',


    'method',


    'retainedSectionCount',

    'taskCount', 'projectCount', 'sectionCount',

    'checklistCount', 'attachmentCount',


    'fixtureId', 'durationMs',
    'statusIncluded', 'associationCount', 'dateCount', 'failureClass',
    'matchCount', 'acceptedCount', 'droppedCount',
    'snapshotVersion', 'publishedCount', 'omittedCount', 'exactLinkCount',

    'appVersion', 'buildVersion', 'exceptionType',

    'deliveryKind',

    'captureMode', 'diagnosticTruncated', 'debugLoggingEnabled', 'breadcrumbCount', 'breadcrumbs',

    'cardKind', 'exportMethod', 'failureStage', 'errorType', 'nativeCode',


    'workspace', 'stage',


    'table',

    'state',

    'provider', 'timeoutMs',


    'taskRemindersEnabled', 'morningDigestEnabled', 'eveningDigestEnabled',

    'page', 'integrationsLoadEnabled', 'syncLoadEnabled', 'advancedLoadEnabled',

    'route', 'elapsedMs', 'moduleElapsedMs',

    'requestedShortcut', 'appliedShortcut',

    'limit', 'fresh',

    'scheduled', 'cancelled',

    'tagged', 'replaced', 'taggedRemoved',
    'releaseCheck', 'backend', 'statusPublished', 'lastSyncAt', 'lastSyncStatus',
    'artifact', 'cloudProvider', 'scheme', 'host', 'delivery', 'deduped',

    'surface',
    'platform', 'total', 'multiDay', 'allDay', 'spanning',
    'presenceDue', 'hasScope', 'check', 'skipped', 'publication',

    'checked', 'cleared', 'complete',

    'decision', 'registered', 'storedInterval', 'interval', 'appState',

    'kind', 'entity', 'fireAt', 'path', 'error',
    'deferred', 'ids',

    'limitBytes', 'bodyBytes',

    'id',

    'batches',

    'count',

    'hiddenCount',


    'order',

    'connectTimeoutMs',

    'horizonMs', 'remainingMs',

    'reason', 'detail',

    'items', 'outcome',

    'mode',

    'window',

    'legacyWidgetCount',

    'focusItems', 'todayItems', 'totalItems',

    'nextItems', 'inboxItems', 'listKind', 'available',

    'collectionBytes',

    'action', 'focusCount', 'timerPhase', 'timerRunning',

    'operation',


    'format',

    'retryAfterMs',

    'status',


    'family', 'boldFace',

    'rnState', 'backupTasks', 'sqliteTasks', 'mergedTasks', 'tasksFromBackup',


    'stage', 'type', 'providerReady', 'dataReady', 'disabled',
    'fileCount', 'candidateCount', 'attachedCount', 'skippedCount',


    'source', 'play', 'badge', 'notice', 'diagnostics', 'channel', 'request', 'optedOut',

    'installer',

    'captureRun', 'captureAttempt', 'phase', 'appliedInset', 'avoidanceEnabled',
    'expanded', 'autoRecord', 'inputMounted', 'focusTracked',
    'windowWidth', 'windowHeight', 'screenWidth', 'screenHeight',
    'imeVisible', 'imeMetricsX', 'imeMetricsY', 'imeMetricsWidth', 'imeMetricsHeight',
    'imeEventX', 'imeEventY', 'imeEventWidth', 'imeEventHeight',
    'inputX', 'inputY', 'inputWidth', 'inputHeight', 'inputBottom',

    'waitMs',

    'attachmentId',

    'taxonomyKind',

    'heldMs',

    'overWork',
];

describe('release diagnostics field names', () => {
    it('preserves the content-free widget launch acknowledgement and recovery receipts', () => {
        for (const stage of ['acknowledged', 'fallback', 'cancelled']) {
            const receipt = { releaseCheck: 'v1.3.8/widget-launch-destination', stage, outcome: 'preserved-draft' };
            expect(sanitizeLogContext(receipt)).toEqual(receipt);
        }
    });
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
