import { isDueForReview } from './date';

export type ProcessInboxCandidate = {
    id: string;
};

export type ProcessInboxQueueCandidate = ProcessInboxCandidate & {
    status: string;
    deletedAt?: unknown;
    reviewAt?: string | null;
};

/**
 * An incubated item whose return date has arrived (#1089). It never moves back
 * to the Inbox — it stays Someday until the user decides something — but it
 * belongs in the clarify pass, because "park this and bring it back so I can
 * decide again" is the question that pass answers. Deferring an item you have
 * already clarified is the other concept, and that one keeps writing
 * Next + a start date.
 */
export function isProcessInboxReturningTask(
    candidate: Pick<ProcessInboxQueueCandidate, 'status' | 'reviewAt'>,
    now: Date = new Date(),
): boolean {
    return candidate.status === 'someday' && isDueForReview(candidate.reviewAt, now);
}

export type ProcessInboxSession<Step extends string = string> = {
    currentTaskId: string | null;
    skippedTaskIds: ReadonlySet<string>;
    visitedTaskIds: ReadonlySet<string>;
    currentStep: Step | null;
    stepHistory: readonly Step[];
};

export type ProcessInboxTaskTransitionOptions<Step extends string> = {
    entryStep?: Step;
};

export function selectProcessInboxCandidates<Candidate extends ProcessInboxQueueCandidate>(
    candidates: readonly Candidate[],
    isVisible: (candidate: Candidate) => boolean = () => true,
    now: Date = new Date(),
): Candidate[] {
    return candidates.filter((candidate) => (
        !candidate.deletedAt
        && (candidate.status === 'inbox' || isProcessInboxReturningTask(candidate, now))
        && isVisible(candidate)
    ));
}

export function createProcessInboxSession<Step extends string = string>(
    initialStep?: Step,
): ProcessInboxSession<Step> {
    return {
        currentTaskId: null,
        skippedTaskIds: new Set(),
        visitedTaskIds: new Set(),
        currentStep: initialStep ?? null,
        stepHistory: [],
    };
}

export function openProcessInboxTask<Step extends string>(
    session: ProcessInboxSession<Step>,
    taskId: string,
    entryStep?: Step,
): ProcessInboxSession<Step> {
    const visitedTaskIds = new Set(session.visitedTaskIds);
    visitedTaskIds.add(taskId);
    return {
        ...session,
        currentTaskId: taskId,
        visitedTaskIds,
        currentStep: entryStep ?? session.currentStep,
        stepHistory: [],
    };
}

export function startProcessInboxSession<
    Candidate extends ProcessInboxCandidate,
    Step extends string = string,
>(
    candidates: readonly Candidate[],
    options: ProcessInboxTaskTransitionOptions<Step> = {},
): ProcessInboxSession<Step> {
    const session = createProcessInboxSession(options.entryStep);
    const first = candidates[0];
    return first
        ? openProcessInboxTask(session, first.id, options.entryStep)
        : session;
}

export function getProcessInboxRemainingCandidates<Candidate extends ProcessInboxCandidate>(
    session: ProcessInboxSession,
    candidates: readonly Candidate[],
): Candidate[] {
    return candidates.filter(({ id }) => (
        !session.skippedTaskIds.has(id)
        && (id === session.currentTaskId || !session.visitedTaskIds.has(id))
    ));
}

export function getProcessInboxCurrentCandidate<Candidate extends ProcessInboxCandidate>(
    session: ProcessInboxSession,
    candidates: readonly Candidate[],
): Candidate | null {
    if (!session.currentTaskId) return null;
    return candidates.find(({ id }) => id === session.currentTaskId) ?? null;
}

export function advanceProcessInboxSession<
    Candidate extends ProcessInboxCandidate,
    Step extends string,
>(
    session: ProcessInboxSession<Step>,
    candidates: readonly Candidate[],
    options: ProcessInboxTaskTransitionOptions<Step> = {},
): ProcessInboxSession<Step> {
    const currentIndex = session.currentTaskId
        ? candidates.findIndex(({ id }) => id === session.currentTaskId)
        : -1;
    const remainingCandidates = currentIndex >= 0
        ? candidates.slice(currentIndex + 1)
        : candidates;
    const next = remainingCandidates.find(({ id }) => (
        !session.skippedTaskIds.has(id)
        && !session.visitedTaskIds.has(id)
    ));

    if (!next) {
        return {
            ...session,
            currentTaskId: null,
            currentStep: options.entryStep ?? session.currentStep,
            stepHistory: [],
        };
    }

    return openProcessInboxTask(session, next.id, options.entryStep);
}

export function skipCurrentProcessInboxTask<
    Candidate extends ProcessInboxCandidate,
    Step extends string,
>(
    session: ProcessInboxSession<Step>,
    candidates: readonly Candidate[],
    options: ProcessInboxTaskTransitionOptions<Step> = {},
): ProcessInboxSession<Step> {
    if (!session.currentTaskId) return session;

    const skippedTaskIds = new Set(session.skippedTaskIds);
    skippedTaskIds.add(session.currentTaskId);
    return advanceProcessInboxSession(
        { ...session, skippedTaskIds },
        candidates,
        options,
    );
}

export function enterProcessInboxStep<Step extends string>(
    session: ProcessInboxSession<Step>,
    nextStep: Step,
): ProcessInboxSession<Step> {
    return {
        ...session,
        currentStep: nextStep,
        stepHistory: session.currentStep
            ? [...session.stepHistory, session.currentStep]
            : session.stepHistory,
    };
}

export function goBackProcessInboxStep<Step extends string>(
    session: ProcessInboxSession<Step>,
): ProcessInboxSession<Step> {
    const previousStep = session.stepHistory[session.stepHistory.length - 1];
    if (!previousStep) return session;

    return {
        ...session,
        currentStep: previousStep,
        stepHistory: session.stepHistory.slice(0, -1),
    };
}
