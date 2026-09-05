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
    'releaseCheck', 'backend', 'statusPublished', 'lastSyncAt', 'lastSyncStatus',
    'artifact', 'cloudProvider', 'scheme', 'host', 'delivery', 'deduped',
    'platform', 'total', 'multiDay', 'allDay', 'spanning',
    'presenceDue', 'hasScope', 'check', 'skipped', 'publication',
    // background-sync-registration (apps/mobile/lib/background-sync-task.ts)
    'decision', 'registered', 'storedInterval', 'interval', 'appState',
    // desktop-reminder-fired / desktop-notification-path (apps/desktop/src/lib/notification-service.tsx)
    'kind', 'entity', 'fireAt', 'path', 'error',
    'deferred', 'ids',
    // attachment-only-task-replace (packages/core/src/store-settings.ts)
    'count',
    // android-http-connect-timeout (apps/mobile/hooks/root-layout/use-root-layout-startup.ts)
    'connectTimeoutMs',
    // fence-mutation-horizon (packages/core/src/sync-remote-fence.ts)
    'horizonMs', 'remainingMs',
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
