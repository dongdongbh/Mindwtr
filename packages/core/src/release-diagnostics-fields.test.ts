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
    // share-card-export (local PNG export adapters)
    'cardKind', 'exportMethod', 'failureStage', 'errorType', 'nativeCode',
    // sandbox-workspace (desktop/mobile entry drain and immutable workspace bootstrap)
    'workspace', 'stage',
    // watcher-property-order reuses releaseCheck below.
    // storage-baseline-equality reuses releaseCheck below.
    // derived-token-timestamps reuses releaseCheck below.
    // sqlite-snapshot-append reuses releaseCheck and count below.
    // sqlite-snapshot-statements reuses releaseCheck and count below.
    // ai-request-stop-once (desktop/mobile AI configuration adapters)
    'provider', 'timeoutMs',
    // sync-attachment-copy-elision reuses releaseCheck and count below.
    // project-lifecycle-sync reuses releaseCheck and count below.
    // sync-signature-pruning reuses releaseCheck, elapsedMs, and count below.
    // pomodoro-alert-delivery reuses releaseCheck, reason, outcome, and count below.
    // settings-lazy-resources (desktop SettingsView)
    'page', 'integrationsLoadEnabled', 'syncLoadEnabled', 'advancedLoadEnabled',
    // startup-readiness (mobile and desktop)
    'route', 'elapsedMs', 'moduleElapsedMs',
    'releaseCheck', 'backend', 'statusPublished', 'lastSyncAt', 'lastSyncStatus',
    'artifact', 'cloudProvider', 'scheme', 'host', 'delivery', 'deduped',
    'platform', 'total', 'multiDay', 'allDay', 'spanning',
    'presenceDue', 'hasScope', 'check', 'skipped', 'publication',
    // webdav-presence-proof (desktop/mobile WebDAV attachment adapters)
    'checked', 'cleared', 'complete',
    // Mobile background sync registration checked (General, apps/mobile/lib/background-sync-task.ts)
    'decision', 'registered', 'storedInterval', 'interval', 'appState',
    // desktop-reminder-fired / desktop-notification-path (apps/desktop/src/lib/notification-service.tsx)
    'kind', 'entity', 'fireAt', 'path', 'error',
    'deferred', 'ids',
    // webdav-activation-batches (core activation coordinator)
    'batches',
    // attachment-only-task-replace (store-settings.ts) / section-conversion-canonical (store-tasks.ts)
    'count',
    // android-http-connect-timeout (apps/mobile/hooks/root-layout/use-root-layout-startup.ts)
    'connectTimeoutMs',
    // fence-mutation-horizon (packages/core/src/sync-remote-fence.ts)
    'horizonMs', 'remainingMs',
    // Sync cycle requeued (General trail, #1170)
    'reason', 'detail',
    // android-native-widget (apps/mobile/lib/widget-service.ts) / android-widget-checkoff (pending-captures.ts)
    'items', 'outcome',
    // android-widget-provider-compat (apps/mobile/lib/widget-service.ts)
    'legacyWidgetCount',
    // widget-focus-today (curated Android widget publication, #1173)
    'focusItems', 'todayItems', 'totalItems',
    // Apple Watch capture, command and Focus/timer snapshot (#1175)
    'action', 'focusCount', 'timerPhase', 'timerRunning',
    // Cloud Focus creation and PATCH policy (apps/cloud/src/server.ts)
    'operation',
];

describe('release diagnostics field names', () => {
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
