


export type CaptureSessionId = number;


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


    finishSubmission(session: CaptureSessionId): boolean {
        if (!this.isCurrent(session)) return false;
        if (this.submittingSession === session) this.submittingSession = null;
        return true;
    }
}
