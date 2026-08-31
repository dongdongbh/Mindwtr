import { describe, expect, it } from 'vitest';

import { CaptureSessionCoordinator } from './capture-session';

describe('CaptureSessionCoordinator', () => {
    it('allows only one submission in the active session', () => {
        const coordinator = new CaptureSessionCoordinator();
        const session = coordinator.beginSession();

        expect(coordinator.tryBeginSubmission(session)).toBe(true);
        expect(coordinator.tryBeginSubmission(session)).toBe(false);
        expect(coordinator.isSubmitting(session)).toBe(true);

        expect(coordinator.finishSubmission(session)).toBe(true);
        expect(coordinator.isSubmitting(session)).toBe(false);
        expect(coordinator.tryBeginSubmission(session)).toBe(true);
    });

    it('rejects an invalidated session and identifies its completion as stale', () => {
        const coordinator = new CaptureSessionCoordinator();
        const session = coordinator.beginSession();
        expect(coordinator.tryBeginSubmission(session)).toBe(true);

        coordinator.invalidateSession(session);

        expect(coordinator.isCurrent(session)).toBe(false);
        expect(coordinator.tryBeginSubmission(session)).toBe(false);
        expect(coordinator.finishSubmission(session)).toBe(false);
    });

    it('keeps a reopened session authoritative when the previous submission finishes', () => {
        const coordinator = new CaptureSessionCoordinator();
        const first = coordinator.beginSession();
        expect(coordinator.tryBeginSubmission(first)).toBe(true);

        const reopened = coordinator.beginSession();
        expect(reopened).not.toBe(first);
        expect(coordinator.tryBeginSubmission(reopened)).toBe(true);

        expect(coordinator.finishSubmission(first)).toBe(false);
        expect(coordinator.isSubmitting(reopened)).toBe(true);
        expect(coordinator.finishSubmission(reopened)).toBe(true);
    });

    it('does not let stale invalidation close a newer session', () => {
        const coordinator = new CaptureSessionCoordinator();
        const first = coordinator.beginSession();
        const reopened = coordinator.beginSession();

        coordinator.invalidateSession(first);

        expect(coordinator.isCurrent(reopened)).toBe(true);
        expect(coordinator.tryBeginSubmission(reopened)).toBe(true);
    });
});
