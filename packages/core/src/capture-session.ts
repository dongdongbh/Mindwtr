/**
 * Identifies one visible capture draft. A result may mutate UI only while its
 * session remains current.
 */
export type CaptureSessionId = number;

/**
 * Coordinates async capture submissions without owning UI or persistence.
 *
 * A platform begins a session whenever capture opens, invalidates it on close,
 * and captures the returned id before awaiting a write. `finishSubmission`
 * returns false for stale completions, including a completion from a sheet that
 * was closed and reopened while the write was in flight.
 */
export class CaptureSessionCoordinator {
    private currentSession = 0;
    private submittingSession: CaptureSessionId | null = null;

    beginSession(): CaptureSessionId {
        this.currentSession += 1;
        this.submittingSession = null;
        return this.currentSession;
    }

    invalidateSession(session: CaptureSessionId): void {
        if (!this.isCurrent(session)) return;
        this.currentSession += 1;
        this.submittingSession = null;
    }

    isCurrent(session: CaptureSessionId): boolean {
        return session === this.currentSession;
    }

    isSubmitting(session: CaptureSessionId): boolean {
        return this.isCurrent(session) && this.submittingSession === session;
    }

    tryBeginSubmission(session: CaptureSessionId): boolean {
        if (!this.isCurrent(session) || this.submittingSession !== null) return false;
        this.submittingSession = session;
        return true;
    }

    /**
     * Releases a current submission and reports whether its UI continuation is
     * still authoritative. A stale completion never changes a newer session.
     */
    finishSubmission(session: CaptureSessionId): boolean {
        if (!this.isCurrent(session)) return false;
        if (this.submittingSession === session) this.submittingSession = null;
        return true;
    }
}
