import type { Project, Section, Task } from './types';
import {
    FOCUS_ELIGIBILITY_ACTIVE_STATUSES,
    getTaskFocusEligibility,
    isTaskFutureFocusCandidate,
    isTaskFutureFocusCandidateBeforeBoundary,
    type FocusDateLookup,
} from './task-utils';
import { formatFocusTaskLimitText } from './focus-utils';
import { isTaskCountedAsFocused } from './store-helpers';
import { tFallback } from './i18n';
import { isTaskActionable } from './task-status';
import { taskDraftToUpdatePatch, type TaskDraft } from './task-draft';

/**
 * The Today's Focus star as one module: every surface that toggles a task's
 * star (row star, quick-action menu, editor, review modals, mobile swipe)
 * resolves the same action here, so eligibility, the cap, labels, and the
 * update patch cannot drift per surface. Status promotion on starring is
 * normally NOT part of the patch — the store's star↔status rules own it at the
 * write path. The one exception is resolveRowFocusStarAction (a row's swipe
 * Focus): an allowed star on an Inbox task carries status next in its patch.
 */
export type FocusStarBlockedReason = 'deferred' | 'sequential' | 'clarify' | 'limit' | null;

export type FocusStarContext = {
    tasks: Task[];
    projects: readonly Project[] | Map<string, Project>;
    sections: readonly Section[];
    focusedCount: number;
    focusTaskLimit: number;
    sequentialProjectIds?: Set<string>;
    sectionScopedProjectIds?: Set<string>;
    sequentialSectionKeys?: Set<string>;
    now?: Date;
    endOfTodayIso?: string;
    frozenDates?: FocusDateLookup;
    /** The task editor is a clarifying surface: it may star unclarified tasks. */
    allowUnclarified?: boolean;
};

export type FocusStarAction = {
    isFocused: boolean;
    /** False only when adding is blocked; removing a star is always allowed. */
    canToggle: boolean;
    blockedReason: FocusStarBlockedReason;
    /** i18n key for the control label. */
    labelKey: 'agenda.addToFocus' | 'agenda.removeFromFocus';
    /** Patch to apply when toggling; store rules handle status promotion. Only the row's Inbox star carries a status. */
    patch: Pick<Task, 'isFocusedToday'> & Partial<Pick<Task, 'status'>>;
};

export type TaskFocusCreationOutcome =
    | 'not-requested'
    | 'focused'
    | 'refused-ineligible'
    | 'refused-limit';

export type TaskFocusCreationDecision = {
    status: Task['status'];
    isFocusedToday: boolean;
    outcome: TaskFocusCreationOutcome;
};

export function resolveFocusStarAction(task: Task, context: FocusStarContext): FocusStarAction {
    const isFocused = task.isFocusedToday === true;
    if (isFocused) {
        return {
            isFocused,
            canToggle: true,
            blockedReason: null,
            labelKey: 'agenda.removeFromFocus',
            patch: { isFocusedToday: false },
        };
    }

    const queued = context.endOfTodayIso && context.frozenDates !== undefined
        ? isTaskFutureFocusCandidateBeforeBoundary(task, context.endOfTodayIso, context.frozenDates)
        : isTaskFutureFocusCandidate(task, context.now);
    const eligibility = getTaskFocusEligibility(task, {
        tasks: context.tasks,
        projects: context.projects,
        now: context.now,
        endOfTodayIso: context.endOfTodayIso,
        frozenDates: context.frozenDates,
        sequentialProjectIds: context.sequentialProjectIds,
        sectionScopedProjectIds: context.sectionScopedProjectIds,
        sequentialSectionKeys: context.sequentialSectionKeys,
        sections: context.sections,
        allowFutureStart: queued,
    });
    const eligible = eligibility.eligible
        || (context.allowUnclarified === true && eligibility.reason === 'clarify');

    const blockedReason: FocusStarBlockedReason = !eligible
        ? (eligibility.reason === 'eligible' ? 'clarify' : eligibility.reason)
        : !queued && context.focusedCount >= context.focusTaskLimit
            ? 'limit'
            : null;

    return {
        isFocused,
        canToggle: blockedReason === null,
        blockedReason,
        labelKey: 'agenda.addToFocus',
        patch: { isFocusedToday: true },
    };
}

const withCandidate = (tasks: Task[], candidate: Task): Task[] => (
    tasks.some((item) => item.id === candidate.id)
        ? tasks.map((item) => item.id === candidate.id ? candidate : item)
        : [...tasks, candidate]
);

/**
 * A task row's swipe Focus action (#1464), not the row star. An unstarred Inbox task is judged as Next, the editor's rule
 * (resolveTaskEditorFocusStar), and an allowed star writes status next in the same patch. A refused one
 * writes nothing, so the task stays in Inbox. Every other task gets resolveFocusStarAction unchanged.
 */
export function resolveRowFocusStarAction(task: Task, context: FocusStarContext): FocusStarAction {
    if (task.status !== 'inbox' || task.isFocusedToday === true) return resolveFocusStarAction(task, context);
    const candidate: Task = { ...task, status: 'next' };
    const action = resolveFocusStarAction(candidate, { ...context, tasks: withCandidate(context.tasks, candidate) });
    return action.canToggle ? { ...action, patch: { ...action.patch, status: 'next' } } : action;
}

/** Resolve an editor's unsaved values against the same Focus rules as a task row. */
export function resolveTaskEditorFocusStar(
    task: Task,
    draft: TaskDraft,
    context: FocusStarContext,
): FocusStarAction & { queued: boolean } {
    const candidate: Task = {
        ...task,
        ...(taskDraftToUpdatePatch(draft, task) ?? {}),
        status: draft.status === 'inbox' ? 'next' : draft.status,
        isFocusedToday: false,
    };
    const add = resolveFocusStarAction(candidate, {
        ...context,
        tasks: withCandidate(context.tasks, candidate),
        focusedCount: Math.max(0, context.focusedCount - (task.isFocusedToday && !isTaskFutureFocusCandidate(task, context.now) ? 1 : 0)),
    });
    const available = !task.deletedAt && isTaskActionable(draft.status);
    return {
        ...add,
        ...(!available ? { canToggle: false, blockedReason: 'clarify' as const } : {}),
        ...(draft.focusedToday ? {
            isFocused: true,
            canToggle: true,
            blockedReason: null,
            labelKey: 'agenda.removeFromFocus' as const,
            patch: { isFocusedToday: false },
        } : {}),
        queued: isTaskFutureFocusCandidate(candidate, context.now),
    };
}

/**
 * Resolve a task's initial Focus state before it is persisted. A starred Inbox
 * capture is evaluated as Next, but that promotion is committed only when the
 * star is accepted. This keeps a refused capture at its requested status.
 */
export function resolveTaskFocusCreation(
    task: Task,
    context: Pick<FocusStarContext, 'tasks' | 'projects' | 'sections' | 'focusedCount' | 'focusTaskLimit' | 'now'>
        & { endOfTodayIso?: string; frozenDates?: FocusStarContext['frozenDates'] },
): TaskFocusCreationDecision {
    if (task.isFocusedToday !== true) {
        return {
            status: task.status,
            isFocusedToday: false,
            outcome: 'not-requested',
        };
    }

    const promotedStatus: Task['status'] = task.status === 'inbox' ? 'next' : task.status;
    const candidate: Task = {
        ...task,
        status: promotedStatus,
        isFocusedToday: false,
    };
    const queued = context.endOfTodayIso
        ? isTaskFutureFocusCandidateBeforeBoundary(candidate, context.endOfTodayIso, context.frozenDates)
        : isTaskFutureFocusCandidate(candidate, context.now);
    const eligibility = getTaskFocusEligibility(candidate, {
        tasks: [...context.tasks, candidate],
        projects: context.projects,
        sections: context.sections,
        now: context.now,
        endOfTodayIso: context.endOfTodayIso,
        frozenDates: context.frozenDates,
        allowFutureStart: queued,
    });

    if (!eligibility.eligible) {
        return {
            status: task.status,
            isFocusedToday: false,
            outcome: 'refused-ineligible',
        };
    }
    if (!queued && context.focusedCount >= context.focusTaskLimit) {
        return {
            status: task.status,
            isFocusedToday: false,
            outcome: 'refused-limit',
        };
    }

    return {
        status: promotedStatus,
        isFocusedToday: true,
        outcome: 'focused',
    };
}

export type TaskFocusUpdateDecision =
    | { outcome: 'unchanged' | 'focused' | 'queued' }
    | { outcome: 'refused-limit'; message: string };

/**
 * Decide whether a normalized task update may take a Focus slot. Any write
 * that makes the task newly count as Focus takes one, refused at the cap: a
 * new star, and also clearing or moving the future start of a queued star. A
 * new star on a later-day start is queued and takes no slot. Writers keep
 * their own count source, error shape, and logs.
 */
export function resolveTaskFocusUpdate(
    before: Task,
    after: Task,
    context: { focusedCount: number; focusTaskLimit: number; now: Date },
): TaskFocusUpdateDecision {
    if (!isTaskCountedAsFocused(before, context.now) && isTaskCountedAsFocused(after, context.now)) {
        return context.focusedCount >= context.focusTaskLimit
            ? { outcome: 'refused-limit', message: `Focus limit of ${context.focusTaskLimit} reached` }
            : { outcome: 'focused' };
    }
    return before.isFocusedToday !== true && after.isFocusedToday === true
        && isTaskFutureFocusCandidate(after, context.now)
        ? { outcome: 'queued' }
        : { outcome: 'unchanged' };
}

/** Quick-add capture star: no task exists yet, only the cap applies. */
export function canStarNewCapture(context: Pick<FocusStarContext, 'focusedCount' | 'focusTaskLimit'>): boolean {
    return context.focusedCount < context.focusTaskLimit;
}

/**
 * Human text for a blocked star (tooltip or toast), or null when not blocked.
 * Keys live in the core locales, so both platforms resolve them with their t.
 */
export function getFocusStarBlockedText(
    t: (key: string) => string,
    action: Pick<FocusStarAction, 'blockedReason'>,
    focusTaskLimit: number,
): string | null {
    switch (action.blockedReason) {
        case 'limit':
            return formatFocusTaskLimitText(
                tFallback(t, 'agenda.maxFocusItems', 'Max {{count}} focus items.'),
                focusTaskLimit,
            );
        case 'deferred':
            return tFallback(t, 'agenda.focusUnavailableDeferred', 'This task is deferred; change its start date before focusing it.');
        case 'sequential':
            return tFallback(t, 'agenda.focusUnavailableSequential', 'Complete the earlier sequential action before focusing this task.');
        case 'clarify':
            return tFallback(t, 'agenda.focusUnavailableClarifyFirst', 'Clarify this task before adding it to Focus.');
        default:
            return null;
    }
}

/** The active-status pool eligibility is judged against. */
export function collectFocusEligibilityTasks(activeTasksByStatus: Map<Task['status'], Task[]>): Task[] {
    return FOCUS_ELIGIBILITY_ACTIVE_STATUSES.flatMap((status) => activeTasksByStatus.get(status) ?? []);
}
