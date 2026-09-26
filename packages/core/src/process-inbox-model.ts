import { formatTimeEstimateLabel, resolveTimeEstimateOptions } from './calendar-scheduling';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import {
    createDateFormatter,
    getQuickDate,
    hasTimeComponent,
    isDueForReview,
    isQuickDatePresetSelected,
    normalizeClockTimeInput,
    safeFormatDate,
    safeParseDate,
    type DateFormatter,
    type QuickDatePreset,
} from './date';
import { isTaskVisibleInInbox } from './area-filter';
import { formatI18nTemplate, tFallback } from './i18n';
import { stripMarkdown } from './markdown';
import { getPersonSuggestionNames } from './people';
import { buildQuickAddParseOptions, parseProcessInboxTitleInput } from './quick-add';
import type { ProcessInboxDecision, ProcessInboxPlan } from './process-inbox-plan';
import { prepareProcessInboxDecision } from './process-inbox-plan';
import {
    advanceProcessInboxSession,
    isProcessInboxReturningTask,
    selectProcessInboxCandidates,
    type ProcessInboxCandidate,
    type ProcessInboxSession,
} from './process-inbox-session';
import {
    commitProcessInboxWorkflowEvent,
    mergeParsedProcessInboxFields,
    type ProcessInboxWorkflowEvent,
    type ProcessInboxWorkflowFields,
} from './process-inbox-workflow';
import { filterProjectsBySelectedArea, getProjectChoiceState, isSelectableProjectForTaskAssignment } from './project-utils';
import type { StoreActionResult } from './store-types';
import { findSimilarTasks, type TaskSimilarityIndex } from './task-similarity';
import { collectTaskTokenUsage } from './task-token-usage';
import { formatTaskMarkedDoneMessage, formatTaskMovedMessage } from './undo-task-completion';
import { getSomedaySectionChoices } from './task-editor-model';
import { setTaskViewSectionId, sortViewSectionDefinitions } from './view-sections';
import type {
    AppSettings,
    Area,
    Person,
    Project,
    Task,
    TaskEnergyLevel,
    TaskPriority,
    TaskStatus,
    TimeEstimate,
} from './types';

/**
 * React Native's Process Inbox, without React: the step sequence, each step's
 * choices, the draft a user edits while clarifying, the suggestions, the store
 * writes each decision becomes, and the labels. The mobile modal and the native
 * host contract both run on these functions.
 */

type Translate = (key: string) => string;

export type ProcessInboxMode = 'guided' | 'quick';
export type ProcessInboxStep =
    | 'actionable'
    | 'decisions'
    | 'someday'
    | 'later'
    | 'incubate'
    | 'twoMinute'
    | 'execution'
    | 'oneAction'
    | 'waiting'
    | 'file';
export type ProcessInboxActionabilityChoice = 'actionable' | 'later' | 'incubate' | 'trash' | 'someday' | 'reference';
export type ProcessInboxTwoMinuteChoice = 'yes' | 'no';
export type ProcessInboxExecutionChoice = 'defer' | 'delegate';
export type ProcessInboxScheduleField = 'startTime' | 'dueDate' | 'reviewAt';
/** Which decision landed: it picks the Undo toast wording. */
export type ProcessInboxCommitted = 'trash' | Extract<TaskStatus, 'next' | 'waiting' | 'someday' | 'reference' | 'done'>;

/** The answers given so far for the task on screen. */
export type ProcessInboxAnswers = {
    actionability: ProcessInboxActionabilityChoice | null;
    twoMinute: ProcessInboxTwoMinuteChoice | null;
    execution: ProcessInboxExecutionChoice | null;
    /** "More than one step?" was answered for this task. */
    oneActionAnswered: boolean;
};

export const INITIAL_PROCESS_INBOX_ANSWERS: ProcessInboxAnswers = Object.freeze({
    actionability: null,
    twoMinute: null,
    execution: null,
    oneActionAnswered: false,
});

type FlowPlan = Pick<ProcessInboxPlan, 'twoMinuteEnabled' | 'twoMinuteFirst'> & {
    visibleFields: Pick<ProcessInboxPlan['visibleFields'], 'project'>;
};

// ---------------------------------------------------------------------------
// The queue and the title parser

/**
 * The processing queue: Inbox items plus Someday items whose return date has
 * come, in store order. Not the area-filtered visible tasks: the queue is global.
 */
export function selectProcessInboxQueue(tasks: readonly Task[], projects: readonly Project[], now: Date = new Date()): Task[] {
    const projectById = new Map(projects.map((project) => [project.id, project]));
    return selectProcessInboxCandidates(tasks, (task) => isTaskVisibleInInbox(task, { projectById }), now);
}

/** The processing title's quick-add parser, with the store's known tokens, people, projects and areas. */
export function createProcessInboxTitleParser(input: {
    settings: AppSettings | undefined;
    tasks: Task[];
    people: readonly Person[];
    projects: Project[];
    areas: Area[];
}): (title: string) => ProcessInboxParsedTitle {
    const parseOptions = buildQuickAddParseOptions(input.settings, { tasks: input.tasks, people: input.people });
    return (title) => parseProcessInboxTitleInput(title, { projects: input.projects, areas: input.areas, parseOptions });
}

// ---------------------------------------------------------------------------
// Steps

export function getProcessInboxEntryStep(mode: ProcessInboxMode, plan: FlowPlan): ProcessInboxStep {
    if (mode === 'quick') return 'decisions';
    return plan.twoMinuteEnabled && plan.twoMinuteFirst ? 'twoMinute' : 'actionable';
}

/** One question per screen. Quick mode replaces only the entry screen. */
export function resolveProcessInboxStep(
    answers: ProcessInboxAnswers,
    mode: ProcessInboxMode,
    plan: FlowPlan,
): ProcessInboxStep {
    const { actionability, twoMinute, execution } = answers;
    const { twoMinuteEnabled, twoMinuteFirst } = plan;
    if (actionability === 'someday') return 'someday';
    if (actionability === 'later') return 'later';
    if (actionability === 'incubate') return 'incubate';
    if (mode === 'quick') {
        if (actionability !== 'actionable') return 'decisions';
        if (twoMinuteEnabled && twoMinute === null) return 'decisions';
        if (execution === null) return 'decisions';
    } else {
        if (twoMinuteEnabled && twoMinuteFirst && twoMinute === null) return 'twoMinute';
        if (actionability !== 'actionable') return 'actionable';
        if (twoMinuteEnabled && !twoMinuteFirst && twoMinute === null) return 'twoMinute';
        if (execution === null) return 'execution';
    }
    if (execution === 'delegate') return 'waiting';
    if (plan.visibleFields.project && !answers.oneActionAnswered) return 'oneAction';
    return 'file';
}

export function isProcessInboxTerminalStep(step: ProcessInboxStep): boolean {
    return step === 'someday' || step === 'later' || step === 'incubate' || step === 'waiting' || step === 'file';
}

/** The destination the step's File it button commits, for the Undo toast. */
export function getProcessInboxTerminalOutcome(step: ProcessInboxStep): ProcessInboxCommitted {
    if (step === 'waiting') return 'waiting';
    return step === 'incubate' || step === 'someday' ? 'someday' : 'next';
}

export function chooseProcessInboxActionability(
    answers: ProcessInboxAnswers,
    choice: ProcessInboxActionabilityChoice,
    plan: FlowPlan,
): ProcessInboxAnswers {
    return {
        ...answers,
        actionability: choice,
        twoMinute: plan.twoMinuteFirst ? answers.twoMinute : null,
        execution: null,
    };
}

export function chooseProcessInboxTwoMinute(
    answers: ProcessInboxAnswers,
    choice: ProcessInboxTwoMinuteChoice,
): ProcessInboxAnswers {
    return { ...answers, twoMinute: choice, execution: null };
}

export function chooseProcessInboxExecution(
    answers: ProcessInboxAnswers,
    choice: ProcessInboxExecutionChoice | null,
): ProcessInboxAnswers {
    return { ...answers, execution: choice };
}

/**
 * Step back to an earlier question: clearing one answer clears everything the
 * flow derived from it, so the next step can never be reached out of order.
 */
export function clearProcessInboxDecision(
    answers: ProcessInboxAnswers,
    level: 'actionability' | 'twoMinute' | 'execution',
    plan: FlowPlan,
): ProcessInboxAnswers {
    return {
        ...answers,
        actionability: level === 'actionability' ? null : answers.actionability,
        twoMinute: level === 'twoMinute' || (level === 'actionability' && !plan.twoMinuteFirst) ? null : answers.twoMinute,
        execution: null,
    };
}

/** Quick mode answers the whole tree in one tap and lands on the follow-up, if any. */
export function chooseQuickProcessInboxDestination(
    answers: ProcessInboxAnswers,
    destination: 'next' | 'project' | 'later' | 'delegate',
    plan: FlowPlan,
): ProcessInboxAnswers {
    if (destination === 'later') return chooseProcessInboxActionability(answers, 'later', plan);
    // 'project' falls through to the one-action question so quick mode can
    // still split a capture into a project; the rest skip straight past it.
    return {
        actionability: 'actionable',
        twoMinute: 'no',
        execution: destination === 'delegate' ? 'delegate' : 'defer',
        oneActionAnswered: destination !== 'project',
    };
}

/** The Back button. `cancelProjectConversion` asks the caller to drop the project split. */
export function backProcessInboxStep(
    answers: ProcessInboxAnswers,
    mode: ProcessInboxMode,
    plan: FlowPlan,
): { answers: ProcessInboxAnswers; cancelProjectConversion: boolean } {
    const step = resolveProcessInboxStep(answers, mode, plan);
    if (mode === 'quick') {
        return {
            answers: { ...clearProcessInboxDecision(answers, 'actionability', plan), oneActionAnswered: false },
            cancelProjectConversion: false,
        };
    }
    if (step === 'file' && answers.oneActionAnswered) {
        return { answers: { ...answers, oneActionAnswered: false }, cancelProjectConversion: true };
    }
    const level = step === 'file' || step === 'waiting' || step === 'oneAction'
        ? 'execution'
        : (step === 'execution' && plan.twoMinuteEnabled && !plan.twoMinuteFirst)
            || (step === 'actionable' && plan.twoMinuteEnabled && plan.twoMinuteFirst)
            ? 'twoMinute'
            : 'actionability';
    return { answers: clearProcessInboxDecision(answers, level, plan), cancelProjectConversion: false };
}

// ---------------------------------------------------------------------------
// The task's starting values and the decision's store write

export type ProcessInboxTaskDefaults = {
    title: string;
    description: string;
    projectId: string | null;
    areaId: string | null;
    contexts: string[];
    tags: string[];
    priority: TaskPriority | undefined;
    energyLevel: TaskEnergyLevel | undefined;
    assignedTo: string;
    timeEstimate: TimeEstimate | undefined;
    somedaySectionId: string | undefined;
    /** "More options" starts open when the capture already carries any detail. */
    showAdvancedOptions: boolean;
    dates: Record<ProcessInboxScheduleField, { value: string | null; dateOnly: boolean }>;
};

export function getProcessInboxTaskDefaults(task: Task | null | undefined): ProcessInboxTaskDefaults {
    const dateDefault = (value: string | undefined) => ({
        value: value || null,
        dateOnly: Boolean(value) && !hasTimeComponent(value),
    });
    return {
        title: task?.title ?? '',
        description: task?.description ?? '',
        projectId: task?.projectId ?? null,
        // Keep an area assigned while the task sat in the Inbox; a project home
        // outranks the direct area (container exclusivity).
        areaId: task?.projectId ? null : (task?.areaId ?? null),
        contexts: task?.contexts ?? [],
        tags: task?.tags ?? [],
        priority: task?.priority,
        energyLevel: task?.energyLevel,
        assignedTo: task?.assignedTo ?? '',
        timeEstimate: task?.timeEstimate,
        somedaySectionId: task?.viewSectionIds?.someday,
        showAdvancedOptions: Boolean(
            task?.projectId
            || task?.areaId
            || task?.contexts?.length
            || task?.tags?.length
            || task?.priority
            || task?.energyLevel
            || task?.assignedTo
            || task?.timeEstimate
            || task?.startTime
            || task?.dueDate
            || task?.reviewAt
        ),
        dates: {
            startTime: dateDefault(task?.startTime),
            dueDate: dateDefault(task?.dueDate),
            reviewAt: dateDefault(task?.reviewAt),
        },
    };
}

export function getProcessInboxDefaultScheduleTime(settings: AppSettings | undefined): string {
    return normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || '';
}

/**
 * A picked date as the store value. Only the calendar day survives: the
 * default schedule time, unless the date is date-only, replaces any clock time.
 */
export function formatProcessInboxScheduleValue(
    value: Date | string,
    dateOnly: boolean,
    defaultScheduleTime: string,
): string {
    const dateOnlyValue = createDateFormatter({ calendarSystem: 'gregorian' })(value, 'yyyy-MM-dd');
    return defaultScheduleTime && !dateOnly ? `${dateOnlyValue}T${defaultScheduleTime}` : dateOnlyValue;
}

const formatProcessInboxStart = (date: ProcessInboxPendingDate, defaultTime: string, stored?: string): string | undefined => {
    if (!date.value) return undefined;
    if (!stored || date.dateOnly || date.useDefaultTime || !hasTimeComponent(stored)) {
        return formatProcessInboxScheduleValue(date.value, date.dateOnly, defaultTime);
    }
    const parsed = safeParseDate(stored);
    if (!parsed) return formatProcessInboxScheduleValue(date.value, date.dateOnly, defaultTime);
    const formatDate = createDateFormatter({ calendarSystem: 'gregorian' });
    const day = formatDate(date.value, 'yyyy-MM-dd');
    return day === formatDate(parsed, 'yyyy-MM-dd') ? stored : `${day}T${formatDate(parsed, 'HH:mm')}`;
};

export type ProcessInboxPendingDate = { value: Date | string | null; dateOnly: boolean; useDefaultTime?: boolean };

export function buildProcessInboxScheduleUpdates(
    plan: Pick<ProcessInboxPlan, 'visibleFields'>,
    dates: Record<ProcessInboxScheduleField, ProcessInboxPendingDate>,
    defaultScheduleTime: string,
    task?: Task,
    dirtyFields: ReadonlySet<ProcessInboxScheduleField> = new Set(),
): Partial<Task> {
    const updates: Partial<Task> = {};
    for (const field of ['startTime', 'dueDate', 'reviewAt'] as const) {
        if (!plan.visibleFields[field]) continue;
        const { value, dateOnly } = dates[field];
        updates[field] = field === 'startTime' && task?.startTime
            ? formatProcessInboxStart(dates.startTime, defaultScheduleTime, task.startTime)
            : !dirtyFields.has(field) && task?.[field]
                ? task[field]
                : value ? formatProcessInboxScheduleValue(value, dateOnly, defaultScheduleTime) : undefined;
    }
    return updates;
}

export type ProcessInboxParsedTitle = { title: string; props: Partial<Task>; invalidDateCommands?: string[] };

export type ProcessInboxSelection = {
    projectId: string | null;
    areaId: string | null;
    contexts: string[];
    tags: string[];
    priority: TaskPriority | undefined;
    energyLevel: TaskEnergyLevel | undefined;
    assignedTo: string;
    timeEstimate: TimeEstimate | undefined;
};

export type ProcessInboxCommitOptions = {
    fields?: ProcessInboxWorkflowFields;
    titleOverride?: string;
    fallbackTitle?: string;
    explicitDateFields?: Partial<Pick<ProcessInboxWorkflowFields, ProcessInboxScheduleField>>;
    clearStaleReviewAt?: boolean;
};

export type PreparedProcessInboxCommit =
    | { ok: false; reason: 'invalid-date-command'; invalidDateCommands: string[] }
    | { ok: false; reason: 'later-start-required' }
    | { ok: true; event: ProcessInboxWorkflowEvent; taskUpdates: Partial<Task> | undefined };

/**
 * Turn the draft into the decision's store write: the parsed title's tokens,
 * the picked fields, the dates the user touched, and the destination policy.
 */
export function prepareProcessInboxCommit(input: {
    task: Task;
    plan: ProcessInboxPlan;
    decision: ProcessInboxDecision;
    title: string;
    description: string;
    parseTitle: (input: string) => ProcessInboxParsedTitle;
    selection: ProcessInboxSelection;
    scheduleUpdates: Partial<Task>;
    dirtyScheduleFields: ReadonlySet<ProcessInboxScheduleField>;
    options?: ProcessInboxCommitOptions;
}): PreparedProcessInboxCommit {
    const { task, decision, selection, options = {} } = input;
    let edits: {
        taskUpdates: Partial<Task>;
        parsedFields: ProcessInboxWorkflowFields;
        explicitDateFields: Partial<Pick<ProcessInboxWorkflowFields, ProcessInboxScheduleField>>;
    } | undefined;
    if (decision.type !== 'discard') {
        const parsed = input.parseTitle(options.titleOverride ?? input.title);
        if (parsed.invalidDateCommands && parsed.invalidDateCommands.length > 0) {
            return { ok: false, reason: 'invalid-date-command', invalidDateCommands: parsed.invalidDateCommands };
        }
        const title = parsed.title.trim() || options.fallbackTitle?.trim() || task.title;
        const description = [input.description.trim(), parsed.props.description?.trim()]
            .filter(Boolean)
            .join('\n');
        edits = {
            taskUpdates: {
                title,
                description: description.length > 0 ? description : undefined,
                ...(parsed.props.attachments
                    ? { attachments: [...(task.attachments ?? []), ...parsed.props.attachments] }
                    : {}),
                ...(parsed.props.isFocusedToday ? { isFocusedToday: true } : {}),
            },
            parsedFields: parsed.props,
            explicitDateFields: {
                ...(parsed.props.startTime ? { startTime: parsed.props.startTime } : {}),
                ...(parsed.props.dueDate ? { dueDate: parsed.props.dueDate } : {}),
                ...(parsed.props.reviewAt ? { reviewAt: parsed.props.reviewAt } : {}),
            },
        };
    }
    const dirty = input.dirtyScheduleFields;
    const clearStaleReviewAt = options.clearStaleReviewAt && !edits?.explicitDateFields.reviewAt && !dirty.has('reviewAt');
    const fields = mergeParsedProcessInboxFields({
        projectId: selection.projectId ?? undefined,
        areaId: selection.areaId ?? undefined,
        contexts: selection.contexts,
        tags: selection.tags,
        priority: selection.priority,
        energyLevel: selection.energyLevel,
        assignedTo: selection.assignedTo.trim() || undefined,
        timeEstimate: selection.timeEstimate,
        ...input.scheduleUpdates,
        ...options.fields,
    }, edits?.parsedFields ?? {});
    const prepared = prepareProcessInboxDecision({
        task,
        draft: {
            fields,
            explicitDateFields: { ...edits?.explicitDateFields, ...options.explicitDateFields,
                ...(clearStaleReviewAt ? { reviewAt: undefined } : {}) },
            dateControlFields: {
                ...(dirty.has('startTime') ? { startTime: fields.startTime } : {}),
                ...(dirty.has('dueDate') ? { dueDate: fields.dueDate } : {}),
                ...(dirty.has('reviewAt') ? { reviewAt: fields.reviewAt } : {}),
            },
            taskUpdates: edits?.taskUpdates,
        },
        decision,
        plan: input.plan,
    });
    if (!prepared.ok) return { ok: false, reason: prepared.reason };
    return { ok: true, event: prepared.event, taskUpdates: prepared.taskUpdates };
}

export type ProcessInboxCommitKind =
    | 'trash'
    | 'someday'
    | 'reference'
    | 'complete'
    | 'later'
    | 'incubate'
    | 'waiting'
    | 'next'
    | 'skip';

/** Each destination's decision and the draft values it carries. */
export function buildProcessInboxDecisionRequest(
    kind: ProcessInboxCommitKind,
    input: {
        task: Task;
        defaultScheduleTime: string;
        somedaySectionId: string | undefined;
        startDate: ProcessInboxPendingDate;
        reviewDate: ProcessInboxPendingDate;
        followUpDate: ProcessInboxPendingDate;
        delegateWho: string;
        assignedTo: string;
        projectId: string | null;
        now?: Date;
    },
): { ok: true; decision: ProcessInboxDecision; options: ProcessInboxCommitOptions } | { ok: false; reason: 'incubate-date-required' } {
    const format = (date: ProcessInboxPendingDate) => (
        date.value ? formatProcessInboxScheduleValue(date.value, date.dateOnly, input.defaultScheduleTime) : undefined
    );
    const staleReviewDate = isDueForReview(input.task.reviewAt, input.now ?? new Date());
    const somedayFields = (): ProcessInboxWorkflowFields => ({
        viewSectionIds: setTaskViewSectionId(input.task.viewSectionIds, 'someday', input.somedaySectionId),
    });
    switch (kind) {
        case 'trash':
            return { ok: true, decision: { type: 'discard' }, options: {} };
        case 'someday': {
            const fields = somedayFields();
            return { ok: true, decision: { type: 'someday' }, options: { fields, clearStaleReviewAt: staleReviewDate } };
        }
        case 'reference':
            return { ok: true, decision: { type: 'reference' }, options: {} };
        case 'complete':
            return { ok: true, decision: { type: 'complete' }, options: {} };
        case 'skip':
            return { ok: true, decision: { type: 'skip' }, options: {} };
        case 'later':
            return { ok: true, decision: { type: 'later' }, options: { fields: { startTime: formatProcessInboxStart(input.startDate, input.defaultScheduleTime, input.task.startTime) } } };
        case 'incubate': {
            const reviewAt = format(input.reviewDate);
            if (!reviewAt) return { ok: false, reason: 'incubate-date-required' };
            return {
                ok: true,
                decision: { type: 'someday' },
                options: { fields: { ...somedayFields(), reviewAt }, explicitDateFields: { reviewAt } },
            };
        }
        case 'waiting': {
            const who = input.delegateWho.trim() || input.assignedTo.trim();
            return {
                ok: true,
                decision: { type: 'waiting', followUpAt: format(input.followUpDate) },
                options: { fields: { assignedTo: who || undefined } },
            };
        }
        case 'next':
            return { ok: true, decision: { type: 'next' }, options: { fields: { projectId: input.projectId ?? undefined } } };
    }
}

export type ProcessInboxProjectConversion =
    | { ok: false; reason: 'no-title' | 'next-action-required' }
    | {
        ok: true;
        projectTitle: string;
        nextAction: string;
        existingProject: Project | undefined;
        newProjectProps: Partial<Project> | undefined;
        extraActions: Array<{ draftValue: string; title: string }>;
    };

/** "Yes, make it a project": the project to find or create and the actions to add to it. */
export function prepareProcessInboxProjectConversion(input: {
    task: Task;
    parsedTitle: string;
    title: string;
    nextActionDraft: string;
    extraActionDrafts: readonly string[];
    projects: readonly Project[];
    showAreaField: boolean;
    areaId: string | null;
}): ProcessInboxProjectConversion {
    const projectTitle = input.parsedTitle.trim() || input.title.trim() || input.task.title;
    const nextAction = input.nextActionDraft.trim();
    if (!projectTitle) return { ok: false, reason: 'no-title' };
    if (!nextAction) return { ok: false, reason: 'next-action-required' };
    return {
        ok: true,
        projectTitle,
        nextAction,
        existingProject: input.projects.find((project) => (
            isSelectableProjectForTaskAssignment(project)
            && project.title.toLowerCase() === projectTitle.toLowerCase()
        )),
        newProjectProps: input.showAreaField && input.areaId ? { areaId: input.areaId } : undefined,
        extraActions: input.extraActionDrafts
            .map((draftValue) => ({ draftValue, title: draftValue.trim() }))
            .filter(({ title }) => Boolean(title)),
    };
}

/** Drop one committed extra action, so a retry cannot add it twice. */
export function removeProcessInboxExtraAction(drafts: readonly string[], draftValue: string): string[] {
    const committedIndex = drafts.indexOf(draftValue);
    return committedIndex < 0 ? [...drafts] : drafts.filter((_, index) => index !== committedIndex);
}

/**
 * The project split's action rows. Enter on the next action, or on the last
 * filled row, opens a new row; Add always does; each row has its own Remove.
 * Each value is the whole list after that control, or null when it does nothing.
 */
export function getProcessInboxConversionRows(nextAction: string, extraActions: readonly string[]): {
    add: string[];
    submitNextAction: string[] | null;
    rows: Array<{ value: string; submit: string[] | null; remove: string[] }>;
} {
    const add = [...extraActions, ''];
    return {
        add,
        submitNextAction: nextAction.trim() ? add : null,
        rows: extraActions.map((value, index) => ({
            value,
            submit: index === extraActions.length - 1 && value.trim() ? add : null,
            remove: extraActions.filter((_, current) => current !== index),
        })),
    };
}

/** Typing in one action row. */
export function replaceProcessInboxExtraAction(extraActions: readonly string[], index: number, value: string): string[] {
    return extraActions.map((current, currentIndex) => (currentIndex === index ? value : current));
}

export function startProcessInboxProjectConversion(input: {
    parsedTitle: string;
    title: string;
    taskTitle: string | undefined;
    nextActionDraft: string;
}): { convertToProject: true; nextActionDraft: string; projectId: null; projectSearch: '' } {
    const baseTitle = input.parsedTitle.trim() || input.title.trim() || input.taskTitle || '';
    return { convertToProject: true, nextActionDraft: input.nextActionDraft.trim() || baseTitle, projectId: null, projectSearch: '' };
}

/** A project chip: picking a project home drops a direct area and ends a project split. */
export function selectProcessInboxProject(projectId: string | null): {
    convertToProject: false;
    projectId: string | null;
    areaId?: null;
    projectSearch: '';
} {
    return { convertToProject: false, projectId, ...(projectId ? { areaId: null } : {}), projectSearch: '' };
}

/** The project search's submit: pick the exact match, or create the typed project. */
export function resolveProcessInboxProjectSearchSubmit(
    search: string,
    exactMatch: Project | undefined,
    areaId: string | null,
): { type: 'none' } | { type: 'select'; projectId: string } | {
    type: 'create';
    title: string;
    color: string;
    props: Partial<Project> | undefined;
} {
    const title = search.trim();
    if (!title) return { type: 'none' };
    if (exactMatch) return { type: 'select', projectId: exactMatch.id };
    return { type: 'create', title, color: DEFAULT_PROJECT_COLOR, props: areaId ? { areaId } : undefined };
}

// ---------------------------------------------------------------------------
// Suggestions

export const PROCESS_INBOX_SUGGESTION_LIMIT = 6;
export const PROCESS_INBOX_PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
export const PROCESS_INBOX_ENERGY_LEVEL_OPTIONS: TaskEnergyLevel[] = ['low', 'medium', 'high'];

/** Contexts and tags in use, most recently used first. */
export function getProcessInboxTokenPools(tasks: Task[]): { contexts: string[]; tags: string[] } {
    const pool = (selector: (task: Task) => string[] | undefined, prefix: string) => (
        collectTaskTokenUsage(tasks, selector, { prefix })
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.token.localeCompare(b.token))
            .map((entry) => entry.token)
    );
    return { contexts: pool((task) => task.contexts, '@'), tags: pool((task) => task.tags, '#') };
}

/** Words from the title, note and token input that hint at a context or tag. */
export function getProcessInboxSuggestionTerms(title: string, description: string, tokenInput: string): string[] {
    const raw = `${title} ${description} ${tokenInput}`.toLowerCase();
    const parts = raw
        .split(/[^a-z0-9@#]+/i)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .map((term) => term.replace(/^[@#]/, ''));
    return Array.from(new Set(parts)).slice(0, 10);
}

/**
 * Copilot token ranking: drop what is already selected, float the tokens the
 * typed terms hint at, keep the rest in pool order behind them.
 */
export function rankProcessInboxTokenSuggestions(
    pool: readonly string[],
    selected: Iterable<string>,
    terms: readonly string[],
    limit: number,
): string[] {
    const selectedTokens = new Set(selected);
    const candidates = pool.filter((token) => !selectedTokens.has(token));
    if (candidates.length === 0) return [];
    const fromInput = candidates.filter((token) => {
        const normalizedToken = token.slice(1).toLowerCase();
        return terms.some((term) => normalizedToken.includes(term));
    });
    const merged = [...fromInput, ...candidates.filter((token) => !fromInput.includes(token))];
    return merged.slice(0, limit);
}

export type ProcessInboxTokenVisibility = { contexts: boolean; tags: boolean };

/** Matches for the token being typed, from the visible kinds. */
export function getProcessInboxTokenSuggestions(input: {
    tokenInput: string;
    pools: { contexts: readonly string[]; tags: readonly string[] };
    visible: ProcessInboxTokenVisibility;
    selectedContexts: readonly string[];
    selectedTags: readonly string[];
}): string[] {
    const tokenDraft = input.tokenInput.trim();
    const tokenPrefix = tokenDraft.startsWith('#') ? '#' : tokenDraft.startsWith('@') ? '@' : '';
    const tokenQuery = tokenDraft.replace(/^[@#]+/, '').trim().toLowerCase();
    if (tokenQuery.length === 0) return [];
    const pool = [
        ...(tokenPrefix === '#' ? [] : input.visible.contexts ? input.pools.contexts : []),
        ...(tokenPrefix === '@' ? [] : input.visible.tags ? input.pools.tags : []),
    ];
    const selected = new Set([...input.selectedContexts, ...input.selectedTags]);
    return pool
        .filter((item) => !selected.has(item))
        .filter((item) => item.slice(1).toLowerCase().includes(tokenQuery))
        .slice(0, PROCESS_INBOX_SUGGESTION_LIMIT);
}

export function toggleProcessInboxToken(list: readonly string[], token: string): string[] {
    return list.includes(token) ? list.filter((item) => item !== token) : [...list, token];
}

type TokenLists = { contexts: string[]; tags: string[] };

/**
 * The token input's Add. `kind` is how a surface that shows contexts and tags
 * separately says which one an unprefixed entry belongs to; without it the
 * prefix decides. Returns null when there is nothing to add.
 */
export function addProcessInboxToken(input: TokenLists & {
    tokenInput: string;
    kind?: 'context' | 'tag';
    visible: ProcessInboxTokenVisibility;
}): TokenLists | null {
    const trimmed = input.tokenInput.trim();
    if (!trimmed) return null;
    const addTag = () => {
        const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
        return input.tags.includes(normalized) ? input.tags : [...input.tags, normalized];
    };
    const addContext = () => {
        const normalized = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
        return input.contexts.includes(normalized) ? input.contexts : [...input.contexts, normalized];
    };
    if (input.kind === 'tag' && input.visible.tags) return { contexts: input.contexts, tags: addTag() };
    if (input.kind === 'context' && input.visible.contexts) return { contexts: addContext(), tags: input.tags };
    if (input.visible.tags && (trimmed.startsWith('#') || !input.visible.contexts)) {
        return { contexts: input.contexts, tags: addTag() };
    }
    if (input.visible.contexts) return { contexts: addContext(), tags: input.tags };
    return { contexts: input.contexts, tags: input.tags };
}

/** A suggestion chip. Returns null when the chip does nothing (hidden kind, or a context already picked). */
export function applyProcessInboxTokenSuggestion(input: TokenLists & {
    token: string;
    visible: ProcessInboxTokenVisibility;
}): TokenLists | null {
    const { token } = input;
    if (token.startsWith('#')) {
        if (!input.visible.tags) return null;
        return { contexts: input.contexts, tags: input.tags.includes(token) ? input.tags : [...input.tags, token] };
    }
    if (!input.visible.contexts || input.contexts.includes(token)) return null;
    return { contexts: [...input.contexts, token], tags: input.tags };
}

/**
 * A contexts or tags input's lists. Typed matches show once, above the ranked
 * suggestions; an unprefixed entry belongs to the one kind on screen.
 */
export function getProcessInboxTokenSection(input: {
    showContexts: boolean;
    showTags: boolean;
    tokenSuggestions: readonly string[];
    contextSuggestions: readonly string[];
    tagSuggestions: readonly string[];
}): {
    suggestions: string[];
    contextSuggestions: string[];
    tagSuggestions: string[];
    /** A literal placeholder, or null for the translated generic one. */
    placeholder: '@home' | '#deep-work' | null;
    addKind: 'context' | 'tag' | undefined;
} {
    const { showContexts, showTags } = input;
    const suggestions = input.tokenSuggestions.filter((token) => (token.startsWith('#') ? showTags : showContexts));
    const shown = new Set(suggestions);
    return {
        suggestions,
        contextSuggestions: input.contextSuggestions.filter((token) => !shown.has(token)),
        tagSuggestions: input.tagSuggestions.filter((token) => !shown.has(token)),
        placeholder: showContexts && !showTags ? '@home' : showTags && !showContexts ? '#deep-work' : null,
        addKind: showContexts === showTags ? undefined : showTags ? 'tag' : 'context',
    };
}

/** A similar task's second line: its status, then its project. */
export function formatProcessInboxSimilarTaskMeta(t: Translate, task: Pick<Task, 'status'>, projectTitle: string | undefined): string {
    const status = tFallback(t, `status.${task.status}`, task.status);
    return projectTitle ? `${status} • ${projectTitle}` : status;
}

export function getProcessInboxPersonSuggestions(
    tasks: Task[],
    people: readonly Person[],
    value: string,
): string[] {
    return getPersonSuggestionNames(people as Person[], tasks, value, PROCESS_INBOX_SUGGESTION_LIMIT);
}

/** The project picker: the selected area's projects, or every match for the search. */
export function getProcessInboxProjectChoices(
    projects: Project[],
    areaId: string | null,
    search: string,
): { filteredProjects: Project[]; exactMatch: Project | undefined } {
    const { filteredProjects, exactMatch } = getProjectChoiceState(
        filterProjectsBySelectedArea(projects, areaId || undefined),
        search,
        projects,
    );
    return { filteredProjects, exactMatch };
}

export function getProcessInboxSimilarTasks(
    index: TaskSimilarityIndex | null,
    title: string,
    taskId: string,
    projects: readonly Project[],
): { tasks: Task[]; projectTitles: Map<string, string> } {
    const tasks = index ? findSimilarTasks(index, title, taskId) : [];
    const projectTitles = new Map<string, string>();
    if (tasks.length === 0) return { tasks, projectTitles };
    const projectIds = new Set(tasks.map((task) => task.projectId).filter(Boolean));
    for (const project of projects) {
        if (projectIds.has(project.id)) projectTitles.set(project.id, project.title);
    }
    return { tasks, projectTitles };
}

/** Which sections the plan shows. Contexts and tags ride their own rows. */
export function getProcessInboxSections(plan: Pick<ProcessInboxPlan, 'visibleFields' | 'showProjectStep' | 'showScheduleFields'>) {
    const fields = plan.visibleFields;
    return {
        project: plan.showProjectStep,
        tokens: fields.contexts || fields.tags,
        organization: fields.priority || fields.energyLevel || fields.assignedTo || fields.timeEstimate,
        scheduling: plan.showScheduleFields,
    };
}

// ---------------------------------------------------------------------------
// Messages

export function formatProcessInboxProgressLabel(t: Translate, current: number, total: number): string {
    const taskLabel = t('common.tasks');
    if (total <= 0) return `0/0 ${taskLabel}`;
    return `${Math.max(0, current)}/${total} ${taskLabel}`;
}

/**
 * Both counts shrink as items leave the Inbox, so progress latches the
 * session's largest remaining count and counts up against it: filed and
 * skipped items are both progress.
 */
export function getProcessInboxProgress(latchedTotal: number, remaining: number): { total: number; processed: number } {
    const total = Math.max(latchedTotal, remaining);
    return { total, processed: Math.max(0, total - remaining) };
}

export function formatProcessInboxCommitMessage(t: Translate, committed: ProcessInboxCommitted, title: string): string {
    if (committed === 'trash') {
        return formatI18nTemplate(tFallback(t, 'inbox.movedToTrash', '{{title}} moved to Trash'), { title });
    }
    if (committed === 'done') return formatTaskMarkedDoneMessage(t, title);
    return formatTaskMovedMessage(t, title, committed);
}

export type ProcessInboxNoticeReason =
    | 'invalid-date-command'
    | 'later-start-required'
    | 'incubate-date-required'
    | 'next-action-required'
    | 'write-failed'
    | 'project-create-failed';

export type ProcessInboxNotice = {
    tone: 'warning' | 'error';
    title: string;
    message: string;
    /** Set when the toast stays longer than the default. */
    durationMs?: number;
};

export function getProcessInboxNotice(
    t: Translate,
    reason: ProcessInboxNoticeReason,
    detail?: { invalidDateCommands?: readonly string[]; message?: string },
): ProcessInboxNotice {
    switch (reason) {
        case 'invalid-date-command':
            return {
                tone: 'error',
                title: tFallback(t, 'common.error', 'Error'),
                message: `${tFallback(t, 'quickAdd.invalidDateCommand', 'Invalid date command')}: ${(detail?.invalidDateCommands ?? []).join(', ')}`,
                durationMs: 4200,
            };
        case 'write-failed':
            return {
                tone: 'error',
                title: tFallback(t, 'common.error', 'Error'),
                message: detail?.message || tFallback(t, 'task.updateFailed', 'Could not update task.'),
                durationMs: 4200,
            };
        case 'later-start-required':
            return { tone: 'warning', title: t('common.notice'), message: tFallback(t, 'process.laterStartRequired', 'Choose a start date for Later.') };
        case 'incubate-date-required':
            return { tone: 'warning', title: t('common.notice'), message: tFallback(t, 'process.incubateDateRequired', 'Choose a date to bring this back.') };
        case 'next-action-required':
            return { tone: 'warning', title: t('common.notice'), message: tFallback(t, 'process.nextActionRequired', 'Add a next action before creating the project.') };
        case 'project-create-failed':
            return { tone: 'error', title: t('common.notice'), message: tFallback(t, 'projects.createFailed', 'Failed to create project.') };
    }
}

/** The hand-off message the delegate step shares. */
export function buildProcessInboxDelegateRequest(input: {
    title: string;
    description: string;
    taskTitle: string;
    taskDescription: string | undefined;
    who: string;
}): { subject: string; message: string } {
    const title = input.title.trim() || input.taskTitle;
    const baseDescription = input.description.trim() || input.taskDescription || '';
    const who = input.who.trim();
    const greeting = who ? `Hi ${who},` : 'Hi,';
    const message = [
        greeting,
        '',
        `Could you please handle: ${title}`,
        baseDescription ? `\nDetails:\n${baseDescription}` : '',
        '',
        'Thanks!',
    ].join('\n');
    return { subject: `Delegation: ${title}`, message };
}

/** Everything a decision may change, so Undo can put the task back exactly. */
export function buildProcessInboxUndoRestoreUpdates(task: Task): Partial<Task> {
    return {
        title: task.title,
        description: task.description,
        status: task.status,
        projectId: task.projectId,
        sectionId: task.sectionId,
        viewSectionIds: task.viewSectionIds ? { ...task.viewSectionIds } : undefined,
        areaId: task.areaId,
        contexts: [...task.contexts],
        tags: [...task.tags],
        priority: task.priority,
        energyLevel: task.energyLevel,
        assignedTo: task.assignedTo,
        timeEstimate: task.timeEstimate,
        startTime: task.startTime,
        dueDate: task.dueDate,
        reviewAt: task.reviewAt,
        recurrence: task.recurrence && typeof task.recurrence === 'object'
            ? { ...task.recurrence }
            : task.recurrence,
        relativeStartOffset: task.relativeStartOffset ? { ...task.relativeStartOffset } : undefined,
        suppressMindwtrReminders: task.suppressMindwtrReminders,
        repeatReminderMinutes: task.repeatReminderMinutes,
        showFutureRecurrence: task.showFutureRecurrence,
        isFocusedToday: task.isFocusedToday,
        focusOrder: task.focusOrder,
        boardOrder: task.boardOrder,
        pushCount: task.pushCount,
        completedAt: task.completedAt,
        attachments: task.attachments?.map((attachment) => ({ ...attachment })),
    };
}

// ---------------------------------------------------------------------------
// The draft as plain JSON, and the one commit path both clients run

/** A calendar day, `yyyy-MM-dd` in local time. */
export type ProcessInboxDateValue = { date: string; dateOnly: boolean; useDefaultTime?: boolean } | null;
export type ProcessInboxDateField = ProcessInboxScheduleField | 'followUp';

export type ProcessInboxDraft = {
    title: string;
    description: string;
    projectId: string | null;
    areaId: string | null;
    projectSearch: string;
    contexts: string[];
    tags: string[];
    tokenInput: string;
    priority: TaskPriority | null;
    energyLevel: TaskEnergyLevel | null;
    assignedTo: string;
    timeEstimate: TimeEstimate | null;
    startTime: ProcessInboxDateValue;
    dueDate: ProcessInboxDateValue;
    reviewAt: ProcessInboxDateValue;
    delegateWho: string;
    followUp: ProcessInboxDateValue;
    convertToProject: boolean;
    nextAction: string;
    extraActions: string[];
    somedaySectionId: string | null;
    showAdvancedOptions: boolean;
    /** Date controls the user touched: their value is explicit input, even when hidden. */
    dirtyScheduleFields: ProcessInboxScheduleField[];
};

const toDateValue = (value: string | null, dateOnly: boolean): ProcessInboxDateValue => {
    const parsed = safeParseDate(value);
    return parsed ? { date: safeFormatDate(parsed, 'yyyy-MM-dd'), dateOnly } : null;
};

export function createProcessInboxDraft(task: Task): ProcessInboxDraft {
    const defaults = getProcessInboxTaskDefaults(task);
    return {
        title: defaults.title,
        description: defaults.description,
        projectId: defaults.projectId,
        areaId: defaults.areaId,
        projectSearch: '',
        contexts: defaults.contexts,
        tags: defaults.tags,
        tokenInput: '',
        priority: defaults.priority ?? null,
        energyLevel: defaults.energyLevel ?? null,
        assignedTo: defaults.assignedTo,
        timeEstimate: defaults.timeEstimate ?? null,
        startTime: toDateValue(defaults.dates.startTime.value, defaults.dates.startTime.dateOnly),
        dueDate: toDateValue(defaults.dates.dueDate.value, defaults.dates.dueDate.dateOnly),
        reviewAt: toDateValue(defaults.dates.reviewAt.value, defaults.dates.reviewAt.dateOnly),
        delegateWho: '',
        followUp: null,
        convertToProject: false,
        nextAction: '',
        extraActions: [],
        somedaySectionId: defaults.somedaySectionId ?? null,
        showAdvancedOptions: defaults.showAdvancedOptions,
        dirtyScheduleFields: [],
    };
}

const pendingDate = (value: ProcessInboxDateValue): ProcessInboxPendingDate => (
    value ? { value: value.date, dateOnly: value.dateOnly,
        ...(value.useDefaultTime ? { useDefaultTime: true } : {}) } : { value: null, dateOnly: false }
);

/** The collapsed capture card's plain-text, 200 UTF-16-code-unit preview. */
export function getProcessInboxNotePreview(description: string): string {
    return stripMarkdown(description).trim().slice(0, 200);
}

/** RN's day picker discards the picked time before handing the date to its controller. */
export function normalizeProcessInboxPickedDate(date: Date): Date {
    const next = new Date(date);
    next.setHours(9, 0, 0, 0);
    return next;
}

export type ProcessInboxDraftEdit =
    | { type: 'set'; field: 'title' | 'description' | 'tokenInput' | 'projectSearch' | 'assignedTo' | 'delegateWho' | 'nextAction'; value: string }
    | { type: 'setExtraActions'; value: string[] }
    | { type: 'setExtraAction'; index: number; value: string }
    | { type: 'setPriority'; value: TaskPriority | null }
    | { type: 'setEnergyLevel'; value: TaskEnergyLevel | null }
    | { type: 'setTimeEstimate'; value: TimeEstimate | null }
    | { type: 'setSomedaySection'; value: string | null }
    | { type: 'setArea'; value: string | null }
    | { type: 'selectProject'; value: string | null }
    | { type: 'toggleContext'; value: string }
    | { type: 'toggleTag'; value: string }
    | { type: 'addToken'; kind?: 'context' | 'tag' }
    | { type: 'applyTokenSuggestion'; value: string }
    | { type: 'setDate'; field: ProcessInboxDateField; value: string | null }
    | { type: 'setPickedDate'; field: ProcessInboxDateField; day: string }
    | { type: 'setDateOnly'; field: ProcessInboxDateField; value: boolean }
    | { type: 'toggleAdvancedOptions' };

const markDirty = (draft: ProcessInboxDraft, field: ProcessInboxDateField): ProcessInboxScheduleField[] => (
    field === 'followUp' || draft.dirtyScheduleFields.includes(field)
        ? draft.dirtyScheduleFields
        : [...draft.dirtyScheduleFields, field]
);

/** One edit to the draft, as the mobile controls apply it. Returns the same draft when the edit does nothing. */
export function applyProcessInboxDraftEdit(
    draft: ProcessInboxDraft,
    edit: ProcessInboxDraftEdit,
    plan: Pick<ProcessInboxPlan, 'visibleFields'>,
): ProcessInboxDraft {
    const visible = { contexts: plan.visibleFields.contexts, tags: plan.visibleFields.tags };
    switch (edit.type) {
        case 'set':
            return { ...draft, [edit.field]: edit.value };
        case 'setExtraActions':
            return { ...draft, extraActions: [...edit.value] };
        case 'setExtraAction':
            return { ...draft, extraActions: replaceProcessInboxExtraAction(draft.extraActions, edit.index, edit.value) };
        case 'setPriority':
            return { ...draft, priority: edit.value };
        case 'setEnergyLevel':
            return { ...draft, energyLevel: edit.value };
        case 'setTimeEstimate':
            return { ...draft, timeEstimate: edit.value };
        case 'setSomedaySection':
            return { ...draft, somedaySectionId: edit.value };
        case 'setArea':
            return { ...draft, areaId: edit.value };
        case 'selectProject': {
            const { convertToProject, projectId, areaId, projectSearch } = selectProcessInboxProject(edit.value);
            return { ...draft, convertToProject, projectId, projectSearch, ...(areaId === null ? { areaId } : {}) };
        }
        case 'toggleContext':
            return { ...draft, contexts: toggleProcessInboxToken(draft.contexts, edit.value) };
        case 'toggleTag':
            return { ...draft, tags: toggleProcessInboxToken(draft.tags, edit.value) };
        case 'addToken': {
            const next = addProcessInboxToken({ ...draft, kind: edit.kind, visible });
            return next ? { ...draft, ...next, tokenInput: '' } : draft;
        }
        case 'applyTokenSuggestion': {
            const next = applyProcessInboxTokenSuggestion({ ...draft, token: edit.value, visible });
            return next ? { ...draft, ...next, tokenInput: '' } : draft;
        }
        case 'setPickedDate': {
            const picked = safeParseDate(edit.day);
            if (!picked) return draft;
            return applyProcessInboxDraftEdit(draft, {
                type: 'setDate', field: edit.field,
                value: createDateFormatter({ calendarSystem: 'gregorian' })(normalizeProcessInboxPickedDate(picked), 'yyyy-MM-dd'),
            }, plan);
        }
        case 'setDate':
            return {
                ...draft,
                [edit.field]: edit.value ? { date: edit.value, dateOnly: false } : null,
                dirtyScheduleFields: markDirty(draft, edit.field),
            };
        case 'setDateOnly': {
            const current = draft[edit.field];
            return {
                ...draft,
                [edit.field]: current ? { date: current.date, dateOnly: edit.value,
                    ...(edit.field === 'startTime' && !edit.value ? { useDefaultTime: true } : {}) } : current,
                dirtyScheduleFields: markDirty(draft, edit.field),
            };
        }
        case 'toggleAdvancedOptions':
            return { ...draft, showAdvancedOptions: !draft.showAdvancedOptions };
    }
}

export type ProcessInboxWriteActions = {
    updateTask: (id: string, updates: Partial<Task>) => Promise<StoreActionResult>;
    deleteTask: (id: string) => Promise<StoreActionResult>;
    addTask: (title: string, props?: Partial<Task>) => Promise<StoreActionResult>;
    addProject: (title: string, color: string, props?: Partial<Project>) => Promise<Project | null>;
};

export type ProcessInboxCommitContext<Candidate extends ProcessInboxCandidate> = {
    task: Task;
    draft: ProcessInboxDraft;
    plan: ProcessInboxPlan;
    settings: AppSettings | undefined;
    projects: readonly Project[];
    parseTitle: (input: string) => ProcessInboxParsedTitle;
    session: ProcessInboxSession;
    candidates: readonly Candidate[];
    actions: ProcessInboxWriteActions;
    t: Translate;
};

export type ProcessInboxCommitResult =
    | { ok: true; session: ProcessInboxSession; draft: ProcessInboxDraft }
    | {
        ok: false;
        /** Null when nothing was said (a project that could not be created without an error). */
        reason: ProcessInboxNoticeReason | null;
        notice: ProcessInboxNotice | null;
        draft: ProcessInboxDraft;
        error?: unknown;
    };

const writeFailureMessage = (result: StoreActionResult): string | undefined => (
    typeof result.error === 'string' && result.error.trim().length > 0 ? result.error.trim() : undefined
);
const thrownMessage = (error: unknown): string | undefined => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string' && error.trim().length > 0) return error.trim();
    return undefined;
};

async function writeProcessInboxDecision<Candidate extends ProcessInboxCandidate>(
    ctx: ProcessInboxCommitContext<Candidate>,
    decision: ProcessInboxDecision,
    options: ProcessInboxCommitOptions,
    advance: boolean,
): Promise<{ ok: true; session: ProcessInboxSession } | { ok: false; reason: ProcessInboxNoticeReason; notice: ProcessInboxNotice }> {
    const { draft } = ctx;
    const prepared = prepareProcessInboxCommit({
        task: ctx.task,
        plan: ctx.plan,
        decision,
        title: draft.title,
        description: draft.description,
        parseTitle: ctx.parseTitle,
        selection: {
            projectId: draft.projectId,
            areaId: draft.areaId,
            contexts: draft.contexts,
            tags: draft.tags,
            priority: draft.priority ?? undefined,
            energyLevel: draft.energyLevel ?? undefined,
            assignedTo: draft.assignedTo,
            timeEstimate: draft.timeEstimate ?? undefined,
        },
        scheduleUpdates: buildProcessInboxScheduleUpdates(ctx.plan, {
            startTime: pendingDate(draft.startTime),
            dueDate: pendingDate(draft.dueDate),
            reviewAt: pendingDate(draft.reviewAt),
        }, getProcessInboxDefaultScheduleTime(ctx.settings), ctx.task, new Set(draft.dirtyScheduleFields)),
        dirtyScheduleFields: new Set(draft.dirtyScheduleFields),
        options,
    });
    if (!prepared.ok) {
        return {
            ok: false,
            reason: prepared.reason,
            notice: getProcessInboxNotice(ctx.t, prepared.reason, prepared.reason === 'invalid-date-command'
                ? { invalidDateCommands: prepared.invalidDateCommands }
                : undefined),
        };
    }
    try {
        const outcome = await commitProcessInboxWorkflowEvent(
            ctx.session,
            ctx.candidates,
            prepared.event,
            { deleteTask: ctx.actions.deleteTask, updateTask: ctx.actions.updateTask },
            { taskUpdates: prepared.taskUpdates, advance },
        );
        if (outcome.writeResult.success === false) {
            return { ok: false, reason: 'write-failed', notice: getProcessInboxNotice(ctx.t, 'write-failed', { message: writeFailureMessage(outcome.writeResult) }) };
        }
        return { ok: true, session: outcome.session };
    } catch (error) {
        return { ok: false, reason: 'write-failed', notice: getProcessInboxNotice(ctx.t, 'write-failed', { message: thrownMessage(error) }) };
    }
}

/**
 * Commit one destination for the task on screen, exactly as the mobile modal
 * does, and advance the session when the write lands. The returned draft
 * drops extra actions that were already added, so a retry cannot repeat them.
 */
export async function commitProcessInboxDecision<Candidate extends ProcessInboxCandidate>(
    kind: ProcessInboxCommitKind | 'convert',
    ctx: ProcessInboxCommitContext<Candidate>,
): Promise<ProcessInboxCommitResult> {
    const { draft } = ctx;
    if (kind !== 'convert') {
        const request = buildProcessInboxDecisionRequest(kind, {
            task: ctx.task,
            defaultScheduleTime: getProcessInboxDefaultScheduleTime(ctx.settings),
            somedaySectionId: draft.somedaySectionId ?? undefined,
            startDate: pendingDate(draft.startTime),
            reviewDate: pendingDate(draft.reviewAt),
            followUpDate: pendingDate(draft.followUp),
            delegateWho: draft.delegateWho,
            assignedTo: draft.assignedTo,
            projectId: draft.projectId,
            now: new Date(),
        });
        if (!request.ok) return { ok: false, reason: request.reason, notice: getProcessInboxNotice(ctx.t, request.reason), draft };
        const written = await writeProcessInboxDecision(ctx, request.decision, request.options, true);
        return written.ok
            ? { ok: true, session: written.session, draft }
            : { ok: false, reason: written.reason, notice: written.notice, draft };
    }

    const conversion = prepareProcessInboxProjectConversion({
        task: ctx.task,
        parsedTitle: ctx.parseTitle(draft.title).title,
        title: draft.title,
        nextActionDraft: draft.nextAction,
        extraActionDrafts: draft.extraActions,
        projects: ctx.projects,
        showAreaField: ctx.plan.visibleFields.area,
        areaId: draft.areaId,
    });
    if (!conversion.ok) {
        return conversion.reason === 'next-action-required'
            ? { ok: false, reason: 'next-action-required', notice: getProcessInboxNotice(ctx.t, 'next-action-required'), draft }
            : { ok: false, reason: null, notice: null, draft };
    }
    let current = draft;
    try {
        const project = conversion.existingProject ?? await ctx.actions.addProject(
            conversion.projectTitle,
            DEFAULT_PROJECT_COLOR,
            conversion.newProjectProps,
        );
        if (!project) return { ok: false, reason: null, notice: null, draft };
        // Extra actions are independent durable writes. Commit and drop each one
        // before moving the original Inbox task, so retry cannot lose or
        // duplicate actions already saved.
        for (const { draftValue, title } of conversion.extraActions) {
            const result = await ctx.actions.addTask(title, { status: 'inbox', projectId: project.id });
            if (result.success === false) {
                return {
                    ok: false,
                    reason: 'write-failed',
                    notice: getProcessInboxNotice(ctx.t, 'write-failed', { message: writeFailureMessage(result) }),
                    draft: current,
                };
            }
            current = { ...current, extraActions: removeProcessInboxExtraAction(current.extraActions, draftValue) };
        }
        const written = await writeProcessInboxDecision({ ...ctx, draft: current }, { type: 'next' }, {
            fields: { projectId: project.id, areaId: undefined },
            titleOverride: conversion.nextAction,
            fallbackTitle: ctx.task.title,
        }, false);
        if (!written.ok) return { ok: false, reason: written.reason, notice: written.notice, draft: current };
        return {
            ok: true,
            session: advanceProcessInboxSession(ctx.session, ctx.candidates),
            draft: { ...current, extraActions: [] },
        };
    } catch (error) {
        return { ok: false, reason: 'project-create-failed', notice: getProcessInboxNotice(ctx.t, 'project-create-failed'), draft: current, error };
    }
}

// ---------------------------------------------------------------------------
// The step view a native client renders

export type ProcessInboxChoiceId =
    | 'actionable'
    | 'later'
    | 'someday'
    | 'incubate'
    | 'reference'
    | 'trash'
    | 'next'
    | 'done'
    | 'project'
    | 'delegate'
    | 'no'
    | 'defer'
    | 'single'
    | 'fileIt'
    | 'createProject'
    | 'back';

/** An option the user taps: the edit to send, or the choice to commit. */
export type ProcessInboxViewOption = {
    label: string;
    selected: boolean;
    edit: ProcessInboxDraftEdit;
    color?: string | null;
};

export type ProcessInboxViewDateRow = {
    field: ProcessInboxDateField;
    label: string;
    date: string | null;
    display: string;
    dateOnly: boolean;
    clear: ProcessInboxViewOption | null;
    /** The date-only / default-time switch, shown with a default schedule time. */
    timeMode: ProcessInboxViewOption | null;
    /** Supply the calendar day (yyyy-MM-dd); RN offers no picked time here. */
    pick: Pick<Extract<ProcessInboxDraftEdit, { type: 'setPickedDate' }>, 'type' | 'field'>;
    quickDates: ProcessInboxViewOption[];
};

export type ProcessInboxViewTokens = {
    title: string;
    placeholder: string;
    selectedContexts: ProcessInboxViewOption[];
    selectedContextsLabel: string | null;
    selectedTags: ProcessInboxViewOption[];
    selectedTagsLabel: string | null;
    add: { label: string; enabled: boolean; edit: ProcessInboxDraftEdit };
    suggestions: ProcessInboxViewOption[];
    contextSuggestionsLabel: string | null;
    contextSuggestions: ProcessInboxViewOption[];
    tagSuggestionsLabel: string | null;
    tagSuggestions: ProcessInboxViewOption[];
};

export type ProcessInboxStepView = {
    step: ProcessInboxStep;
    entryStep: ProcessInboxStep;
    mode: ProcessInboxMode;
    modeToggleLabel: string;
    back: string | null;
    skip: string;
    question: string | null;
    hint: string | null;
    choices: ProcessInboxStepChoice[];
    /** The bottom commit button's label; absent when the step commits from its choices. */
    fileIt: string | null;
    capture: {
        title: string;
        titleLabel: string;
        returningLabel: string | null;
        description: string;
        notePreview: string;
        descriptionLabel: string;
        descriptionPlaceholder: string;
        refineHint: string;
        similarTasksLabel: string;
        similarTasks: Array<{ id: string; title: string; meta: string }>;
    };
    dateRow: ProcessInboxViewDateRow | null;
    project: {
        title: string;
        conversion: {
            nextActionLabel: string;
            nextAction: string;
            /** Enter in the next action field; null when it does nothing. */
            nextActionSubmit: ProcessInboxDraftEdit | null;
            /** Typing in row i sends `{ type: 'setExtraAction', index: i, value }`. */
            rows: Array<{ value: string; submit: ProcessInboxDraftEdit | null; remove: ProcessInboxDraftEdit }>;
            addAction: { label: string; edit: ProcessInboxDraftEdit };
            removeActionLabel: string;
            createLabel: string;
        } | null;
        current: ProcessInboxViewOption | null;
        areaLabel: string | null;
        areas: ProcessInboxViewOption[];
        search: { label: string; placeholder: string; value: string; createLabel: string | null } | null;
        projects: ProcessInboxViewOption[];
    } | null;
    somedaySections: { label: string; options: ProcessInboxViewOption[] } | null;
    delegate: {
        title: string;
        hint: string;
        whoLabel: string;
        whoPlaceholder: string;
        who: string;
        whoSuggestions: ProcessInboxViewOption[];
        followUp: ProcessInboxViewDateRow | null;
        sendLabel: string;
        request: { subject: string; message: string };
    } | null;
    contexts: ProcessInboxViewTokens | null;
    /** On the file step, the project row comes before the contexts row. */
    projectFirst: boolean;
    moreOptions: {
        label: string;
        open: boolean;
        edit: Extract<ProcessInboxDraftEdit, { type: 'toggleAdvancedOptions' }>;
        scheduling: { title: string; rows: ProcessInboxViewDateRow[] } | null;
        organization: {
            title: string;
            priorityLabel: string | null;
            priorities: ProcessInboxViewOption[];
            energyLabel: string | null;
            energyLevels: ProcessInboxViewOption[];
            timeEstimateLabel: string | null;
            timeEstimates: ProcessInboxViewOption[];
            assignedToLabel: string | null;
            assignedToPlaceholder: string;
            assignedTo: string;
            assignedToSuggestions: ProcessInboxViewOption[];
        } | null;
        tags: ProcessInboxViewTokens | null;
    } | null;
};

export const PROCESS_INBOX_QUICK_DATE_LABELS: Record<QuickDatePreset, { key: string; fallback: string }> = {
    today: { key: 'quickDate.today', fallback: 'Today' },
    tomorrow: { key: 'quickDate.tomorrow', fallback: 'Tomorrow' },
    in_2_days: { key: 'quickDate.in2Days', fallback: '+2 days' },
    in_3_days: { key: 'quickDate.in3Days', fallback: '+3 days' },
    next_week: { key: 'quickDate.nextWeek', fallback: 'Next week' },
    next_month: { key: 'quickDate.nextMonth', fallback: 'Next month' },
    no_date: { key: 'quickDate.noDate', fallback: 'No date' },
};

const ALL_QUICK_DATES: QuickDatePreset[] = ['today', 'tomorrow', 'in_3_days', 'next_week', 'next_month', 'no_date'];
const DATED_QUICK_DATES = ALL_QUICK_DATES.filter((preset) => preset !== 'no_date');

export type ProcessInboxStepChoice = {
    id: ProcessInboxChoiceId;
    label: string;
    /** Icon key: done, project, later, delegate, someday, incubate, reference or trash. */
    icon: string | null;
    /** Shown apart, in the danger color (Trash). */
    danger: boolean;
};

/** The step's question, hint and buttons. Terminal steps have none; they commit with File it. */
export function getProcessInboxStepPrompt(
    step: ProcessInboxStep,
    plan: Pick<ProcessInboxPlan, 'twoMinuteEnabled' | 'visibleFields'>,
    t: Translate,
): { question: string | null; hint: string | null; choices: ProcessInboxStepChoice[] } {
    const tf = (key: string, fallback: string) => tFallback(t, key, fallback);
    const choice = (id: ProcessInboxChoiceId, label: string, icon: string | null = null, danger = false): ProcessInboxStepChoice => (
        { id, label, icon, danger }
    );
    const later = choice('later', tf('process.later', 'Start later'), 'later');
    const someday = choice('someday', t('inbox.someday'), 'someday');
    const incubate = choice('incubate', tf('process.incubate', 'Incubate'), 'incubate');
    const reference = choice('reference', t('nav.reference'), 'reference');
    const trash = choice('trash', t('inbox.trash'), 'trash', true);
    const delegate = choice('delegate', t('inbox.delegate'), 'delegate');
    switch (step) {
        case 'decisions':
            return {
                question: null,
                hint: null,
                choices: [
                    choice('next', t('inbox.illDoIt')),
                    ...(plan.twoMinuteEnabled ? [choice('done', t('inbox.doneIt'), 'done')] : []),
                    ...(plan.visibleFields.project ? [choice('project', t('taskEdit.projectLabel'), 'project')] : []),
                    later, delegate, someday, incubate, reference, trash,
                ],
            };
        case 'actionable':
            return {
                question: t('inbox.isActionable'),
                hint: t('inbox.actionableHint'),
                choices: [choice('actionable', t('inbox.yes')), later, someday, incubate, reference, trash],
            };
        case 'twoMinute':
            return {
                question: t('inbox.twoMinRule'),
                hint: t('inbox.twoMinHint'),
                choices: [choice('done', t('inbox.doneIt')), choice('no', t('inbox.takesLonger'))],
            };
        case 'execution':
            return { question: t('inbox.whoShouldDoIt'), hint: null, choices: [choice('defer', t('inbox.illDoIt')), delegate] };
        case 'oneAction':
            return {
                question: t('process.moreThanOneStep'),
                hint: t('process.moreThanOneStepDesc'),
                choices: [choice('single', t('process.moreThanOneStepNo')), choice('project', t('process.moreThanOneStepYes'))],
            };
        case 'later':
            return {
                question: tf('inbox.deferWhen', 'When should it start?'),
                hint: tf('process.laterHint', 'Set a start date and move this to Next Actions.'),
                choices: [],
            };
        case 'incubate':
            return {
                question: tf('process.incubateWhen', 'When should it come back?'),
                hint: tf('process.incubateHint', 'Park this without deciding. It comes back to clarify on the date you choose.'),
                choices: [],
            };
        default:
            return { question: null, hint: null, choices: [] };
    }
}

export type ProcessInboxViewInput = {
    task: Task;
    draft: ProcessInboxDraft;
    answers: ProcessInboxAnswers;
    mode: ProcessInboxMode;
    plan: ProcessInboxPlan;
    settings: AppSettings | undefined;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    people: readonly Person[];
    similarityIndex: TaskSimilarityIndex | null;
    t: Translate;
    formatDate: DateFormatter;
    now: Date;
};

/** Everything the mobile step shows for this state, as plain JSON with no policy left to apply. */
export function buildProcessInboxStepView(input: ProcessInboxViewInput): ProcessInboxStepView {
    const { draft, plan, t, mode } = input;
    const tf = (key: string, fallback: string) => tFallback(t, key, fallback);
    const step = resolveProcessInboxStep(input.answers, mode, plan);
    const entryStep = getProcessInboxEntryStep(mode, plan);
    const sections = getProcessInboxSections(plan);
    const fields = plan.visibleFields;
    const defaultScheduleTime = getProcessInboxDefaultScheduleTime(input.settings);
    const dateOnlyLabel = t('taskEdit.dateOnly');

    const dateRow = (field: ProcessInboxDateField, label: string, presets: QuickDatePreset[]): ProcessInboxViewDateRow => {
        const value = draft[field];
        const selectedDate = value ? safeParseDate(value.date) : null;
        return {
            field,
            label,
            date: value?.date ?? null,
            display: value ? input.formatDate(value.date, 'P') : t('common.notSet'),
            dateOnly: value?.dateOnly ?? false,
            clear: value ? { label: t('common.clear'), selected: false, edit: { type: 'setDate', field, value: null } } : null,
            timeMode: value && defaultScheduleTime
                ? {
                    label: value.dateOnly ? defaultScheduleTime : dateOnlyLabel,
                    selected: value.dateOnly,
                    edit: { type: 'setDateOnly', field, value: !value.dateOnly },
                }
                : null,
            pick: { type: 'setPickedDate', field },
            quickDates: presets.map((preset) => {
                const active = isQuickDatePresetSelected(preset, selectedDate, input.now);
                const picked = active ? null : getQuickDate(preset, input.now);
                const labels = PROCESS_INBOX_QUICK_DATE_LABELS[preset];
                return {
                    label: tf(labels.key, labels.fallback),
                    selected: active,
                    edit: { type: 'setDate', field, value: picked ? safeFormatDate(picked, 'yyyy-MM-dd') : null },
                };
            }),
        };
    };

    const pools = getProcessInboxTokenPools(input.tasks);
    const terms = getProcessInboxSuggestionTerms(draft.title, draft.description, draft.tokenInput);
    const tokenSuggestions = getProcessInboxTokenSuggestions({
        tokenInput: draft.tokenInput,
        pools,
        visible: { contexts: fields.contexts, tags: fields.tags },
        selectedContexts: draft.contexts,
        selectedTags: draft.tags,
    });
    const tokenRow = (kind: 'context' | 'tag'): ProcessInboxViewTokens => {
        const showContexts = kind === 'context';
        const showTags = kind === 'tag';
        const section = getProcessInboxTokenSection({
            showContexts,
            showTags,
            tokenSuggestions,
            contextSuggestions: rankProcessInboxTokenSuggestions(pools.contexts, draft.contexts, terms, PROCESS_INBOX_SUGGESTION_LIMIT),
            tagSuggestions: rankProcessInboxTokenSuggestions(pools.tags, draft.tags, terms, PROCESS_INBOX_SUGGESTION_LIMIT),
        });
        const chip = (token: string): ProcessInboxViewOption => ({
            label: token,
            selected: false,
            edit: { type: 'applyTokenSuggestion', value: token },
        });
        const contextCopilot = section.contextSuggestions;
        const tagCopilot = section.tagSuggestions;
        return {
            title: showContexts ? t('taskEdit.contextsLabel') : t('taskEdit.tagsLabel'),
            placeholder: section.placeholder ?? t('inbox.addContextPlaceholder'),
            selectedContextsLabel: showContexts && draft.contexts.length > 0 ? t('inbox.selectedLabel') : null,
            selectedContexts: showContexts
                ? draft.contexts.map((token) => ({ label: `${token} x`, selected: true, edit: { type: 'toggleContext', value: token } }))
                : [],
            selectedTagsLabel: showTags && draft.tags.length > 0 ? t('taskEdit.tagsLabel') : null,
            selectedTags: showTags
                ? draft.tags.map((token) => ({ label: `${token} x`, selected: true, edit: { type: 'toggleTag', value: token } }))
                : [],
            add: { label: t('common.add'), enabled: Boolean(draft.tokenInput.trim()), edit: { type: 'addToken', kind: section.addKind } },
            suggestions: section.suggestions.map(chip),
            contextSuggestionsLabel: showContexts && contextCopilot.length > 0
                ? `${t('copilot.suggested')} ${t('nav.contexts').toLowerCase()}`
                : null,
            contextSuggestions: showContexts ? contextCopilot.map(chip) : [],
            tagSuggestionsLabel: showTags && tagCopilot.length > 0
                ? `${t('copilot.suggested')} ${t('taskEdit.tagsLabel').toLowerCase()}`
                : null,
            tagSuggestions: showTags ? tagCopilot.map(chip) : [],
        };
    };

    const areaById = new Map([...input.areas]
        .filter((area) => !area.deletedAt)
        .sort((left, right) => left.order !== right.order ? left.order - right.order : left.name.localeCompare(right.name))
        .map((area) => [area.id, area]));
    const projectSection = (allowConversion: boolean): ProcessInboxStepView['project'] => {
        if (!sections.project) return null;
        const conversion = fields.project && allowConversion && draft.convertToProject;
        const conversionRows = getProcessInboxConversionRows(draft.nextAction, draft.extraActions);
        const currentProject = draft.projectId ? input.projects.find((project) => project.id === draft.projectId) ?? null : null;
        const currentArea = draft.areaId ? input.areas.find((area) => area.id === draft.areaId) ?? null : null;
        const areaLabel = t('taskEdit.areaLabel');
        const showAreas = fields.area && !draft.projectId;
        const { filteredProjects, exactMatch } = getProcessInboxProjectChoices(input.projects, draft.areaId, draft.projectSearch);
        const areaOptions: ProcessInboxViewOption[] = showAreas ? [
            ...(currentArea ? [{ label: `✓ ${currentArea.name}`, selected: true, color: currentArea.color ?? null, edit: { type: 'setArea' as const, value: currentArea.id } }] : []),
            { label: `${!draft.areaId ? '✓ ' : ''}${t('projects.noArea')}`, selected: !draft.areaId, color: null, edit: { type: 'setArea', value: null } },
            ...Array.from(areaById.values()).map((area) => ({
                label: area.name,
                selected: draft.areaId === area.id,
                color: area.color ?? null,
                edit: { type: 'setArea' as const, value: area.id },
            })),
        ] : [];
        return {
            title: conversion ? t('projects.title') : t('inbox.assignProjectQuestion'),
            conversion: conversion ? {
                nextActionLabel: t('process.nextAction'),
                nextAction: draft.nextAction,
                nextActionSubmit: conversionRows.submitNextAction
                    ? { type: 'setExtraActions', value: conversionRows.submitNextAction }
                    : null,
                rows: conversionRows.rows.map((row) => ({
                    value: row.value,
                    submit: row.submit ? { type: 'setExtraActions' as const, value: row.submit } : null,
                    remove: { type: 'setExtraActions' as const, value: row.remove },
                })),
                addAction: { label: `+ ${t('process.addAnotherAction')}`, edit: { type: 'setExtraActions', value: conversionRows.add } },
                removeActionLabel: t('process.removeAction'),
                createLabel: t('process.createProject'),
            } : null,
            current: !conversion && fields.project && currentProject
                ? { label: `✓ ${currentProject.title}`, selected: true, edit: { type: 'selectProject', value: currentProject.id } }
                : null,
            areaLabel: showAreas ? areaLabel : null,
            areas: areaOptions,
            search: !conversion && fields.project ? {
                label: t('projects.search'),
                placeholder: t('projects.addPlaceholder'),
                value: draft.projectSearch,
                createLabel: !exactMatch && draft.projectSearch.trim() ? t('projects.create') : null,
            } : null,
            projects: !conversion && fields.project ? [
                { label: `${!draft.projectId ? '✓ ' : ''}${t('inbox.noProject')}`, selected: !draft.projectId, color: null, edit: { type: 'selectProject', value: null } },
                ...filteredProjects.map((project) => ({
                    label: project.title,
                    selected: draft.projectId === project.id,
                    color: project.areaId ? areaById.get(project.areaId)?.color ?? null : null,
                    edit: { type: 'selectProject' as const, value: project.id },
                })),
            ] : [],
        };
    };

    const somedaySection = (): ProcessInboxStepView['somedaySections'] => ({
        label: tf('viewSections.somedaySection', 'Someday section'),
        options: getSomedaySectionChoices(
            sortViewSectionDefinitions(input.settings?.gtd?.viewSections?.someday),
            draft.somedaySectionId ?? undefined,
            tf('viewSections.noSection', 'No section'),
        ).map((choice) => ({
            label: choice.title,
            selected: choice.selected,
            edit: { type: 'setSomedaySection', value: choice.id || null },
        })),
    });

    const people = (value: string) => getProcessInboxPersonSuggestions(input.tasks, input.people, value);
    const moreOptions = (): ProcessInboxStepView['moreOptions'] => ({
        label: tf('common.more', 'More options'),
        open: draft.showAdvancedOptions,
        edit: { type: 'toggleAdvancedOptions' },
        scheduling: draft.showAdvancedOptions && sections.scheduling ? {
            title: t('taskEdit.scheduling'),
            rows: [
                ...(fields.startTime ? [dateRow('startTime', t('taskEdit.startDateLabel'), ALL_QUICK_DATES)] : []),
                ...(fields.dueDate ? [dateRow('dueDate', t('taskEdit.dueDateLabel'), ALL_QUICK_DATES)] : []),
                ...(fields.reviewAt ? [dateRow('reviewAt', t('taskEdit.reviewDateLabel'), ALL_QUICK_DATES)] : []),
            ],
        } : null,
        organization: draft.showAdvancedOptions && sections.organization ? {
            title: t('taskEdit.organization'),
            priorityLabel: fields.priority ? t('taskEdit.priorityLabel') : null,
            priorities: fields.priority ? PROCESS_INBOX_PRIORITY_OPTIONS.map((priority) => ({
                label: t(`priority.${priority}`),
                selected: draft.priority === priority,
                edit: { type: 'setPriority', value: draft.priority === priority ? null : priority },
            })) : [],
            energyLabel: fields.energyLevel ? t('taskEdit.energyLevel') : null,
            energyLevels: fields.energyLevel ? [
                { label: t('common.none'), selected: !draft.energyLevel, edit: { type: 'setEnergyLevel', value: null } },
                ...PROCESS_INBOX_ENERGY_LEVEL_OPTIONS.map((energyLevel) => ({
                    label: t(`energyLevel.${energyLevel}`),
                    selected: draft.energyLevel === energyLevel,
                    edit: { type: 'setEnergyLevel' as const, value: draft.energyLevel === energyLevel ? null : energyLevel },
                })),
            ] : [],
            timeEstimateLabel: fields.timeEstimate ? t('taskEdit.timeEstimateLabel') : null,
            timeEstimates: fields.timeEstimate ? [
                { label: t('common.none'), selected: !draft.timeEstimate, edit: { type: 'setTimeEstimate', value: null } },
                ...resolveTimeEstimateOptions(draft.timeEstimate ?? undefined).map((estimate) => ({
                    label: formatTimeEstimateLabel(estimate, { t }),
                    selected: draft.timeEstimate === estimate,
                    edit: { type: 'setTimeEstimate' as const, value: draft.timeEstimate === estimate ? null : estimate },
                })),
            ] : [],
            assignedToLabel: fields.assignedTo ? t('taskEdit.assignedTo') : null,
            assignedToPlaceholder: t('taskEdit.assignedToPlaceholder'),
            assignedTo: draft.assignedTo,
            assignedToSuggestions: fields.assignedTo ? people(draft.assignedTo).map((name) => ({
                label: name,
                selected: false,
                edit: { type: 'set', field: 'assignedTo', value: name },
            })) : [],
        } : null,
        // Contexts stay on the step itself; tags ride the disclosure.
        tags: draft.showAdvancedOptions && step === 'file' && fields.tags ? tokenRow('tag') : null,
    });

    const { question, hint, choices } = getProcessInboxStepPrompt(step, plan, t);

    const similar = getProcessInboxSimilarTasks(input.similarityIndex, draft.title, input.task.id, input.projects);
    const titleLabelKey = step === 'file' && draft.convertToProject ? 'projects.projectName' : 'taskEdit.titleLabel';
    return {
        step,
        entryStep,
        mode,
        modeToggleLabel: mode === 'quick' ? tf('process.modeGuided', 'Guided') : tf('process.modeQuick', 'Quick'),
        back: step !== entryStep ? `‹ ${tf('common.back', 'Back')}` : null,
        skip: tf('inbox.skip', 'Skip'),
        question,
        hint,
        choices,
        fileIt: isProcessInboxTerminalStep(step) && !(step === 'file' && draft.convertToProject)
            ? tf('inbox.fileIt', 'File it')
            : null,
        capture: {
            title: draft.title,
            titleLabel: t(titleLabelKey),
            returningLabel: isProcessInboxReturningTask(input.task, input.now) ? tf('process.returningItem', 'Back to clarify') : null,
            description: draft.description,
            notePreview: getProcessInboxNotePreview(draft.description),
            descriptionLabel: t('taskEdit.descriptionLabel'),
            descriptionPlaceholder: t('taskEdit.descriptionPlaceholder'),
            refineHint: tf('inbox.refineHint', 'Clarify the title and details before deciding what to do next.'),
            similarTasksLabel: t('process.similarTasks'),
            similarTasks: similar.tasks.map((task) => ({
                id: task.id,
                title: task.title,
                meta: formatProcessInboxSimilarTaskMeta(t, task, task.projectId ? similar.projectTitles.get(task.projectId) : undefined),
            })),
        },
        dateRow: step === 'later'
            ? dateRow('startTime', t('taskEdit.startDateLabel'), DATED_QUICK_DATES)
            : step === 'incubate'
                ? dateRow('reviewAt', t('taskEdit.reviewDateLabel'), ALL_QUICK_DATES)
                : null,
        project: step === 'someday' || step === 'later' || step === 'incubate'
            ? projectSection(false)
            : step === 'file' ? projectSection(true) : null,
        somedaySections: step === 'someday' || step === 'incubate' ? somedaySection() : null,
        delegate: step === 'waiting' ? {
            title: t('process.delegateTitle'),
            hint: t('process.delegateDesc'),
            whoLabel: t('process.delegateWhoLabel'),
            whoPlaceholder: t('process.delegateWhoPlaceholder'),
            who: draft.delegateWho,
            whoSuggestions: people(draft.delegateWho).map((name) => ({
                label: name,
                selected: false,
                edit: { type: 'set', field: 'delegateWho', value: name },
            })),
            followUp: fields.reviewAt ? null : dateRow('followUp', t('process.delegateFollowUpLabel'), ALL_QUICK_DATES),
            sendLabel: t('process.delegateSendRequest'),
            request: buildProcessInboxDelegateRequest({
                title: draft.title,
                description: draft.description,
                taskTitle: input.task.title,
                taskDescription: input.task.description,
                who: draft.delegateWho,
            }),
        } : null,
        contexts: step === 'file' && fields.contexts ? tokenRow('context') : null,
        projectFirst: plan.projectFirst,
        moreOptions: step === 'waiting' || step === 'file' ? moreOptions() : null,
    };
}

/** Where the step's choice leads: a new flow state, or a destination to commit. */
export type ProcessInboxChoiceOutcome =
    | { type: 'flow'; answers: ProcessInboxAnswers; draft: ProcessInboxDraft }
    | { type: 'commit'; kind: ProcessInboxCommitKind | 'convert'; committed: ProcessInboxCommitted | null }
    | { type: 'invalid' };

/** The step's buttons, as the mobile step flow wires them. */
export function answerProcessInboxStep(input: {
    choice: string;
    answers: ProcessInboxAnswers;
    draft: ProcessInboxDraft;
    mode: ProcessInboxMode;
    plan: ProcessInboxPlan;
    task: Task;
    parseTitle: (input: string) => ProcessInboxParsedTitle;
}): ProcessInboxChoiceOutcome {
    const { choice, answers, draft, mode, plan } = input;
    const step = resolveProcessInboxStep(answers, mode, plan);
    const flow = (next: ProcessInboxAnswers, nextDraft: ProcessInboxDraft = draft): ProcessInboxChoiceOutcome => (
        { type: 'flow', answers: next, draft: nextDraft }
    );
    const commit = (kind: ProcessInboxCommitKind | 'convert', committed: ProcessInboxCommitted | null): ProcessInboxChoiceOutcome => (
        { type: 'commit', kind, committed }
    );
    if (choice === 'back') {
        if (step === getProcessInboxEntryStep(mode, plan)) return { type: 'invalid' };
        const back = backProcessInboxStep(answers, mode, plan);
        return flow(back.answers, back.cancelProjectConversion
            ? { ...draft, convertToProject: false, nextAction: '', extraActions: [] }
            : draft);
    }
    switch (step) {
        case 'actionable':
            if (choice === 'actionable' || choice === 'later' || choice === 'someday' || choice === 'incubate') {
                return flow(chooseProcessInboxActionability(answers, choice, plan));
            }
            if (choice === 'reference') return commit('reference', 'reference');
            if (choice === 'trash') return commit('trash', 'trash');
            return { type: 'invalid' };
        case 'decisions':
            if (choice === 'next') return commit('next', 'next');
            if (choice === 'done' && plan.twoMinuteEnabled) return commit('complete', 'done');
            if ((choice === 'project' && plan.visibleFields.project) || choice === 'later' || choice === 'delegate') {
                return flow(chooseQuickProcessInboxDestination(answers, choice, plan));
            }
            if (choice === 'someday' || choice === 'incubate') return flow(chooseProcessInboxActionability(answers, choice, plan));
            if (choice === 'reference') return commit('reference', 'reference');
            if (choice === 'trash') return commit('trash', 'trash');
            return { type: 'invalid' };
        case 'twoMinute':
            if (choice === 'done') return commit('complete', 'done');
            if (choice === 'no') return flow(chooseProcessInboxTwoMinute(answers, 'no'));
            return { type: 'invalid' };
        case 'execution':
            if (choice === 'defer' || choice === 'delegate') return flow(chooseProcessInboxExecution(answers, choice));
            return { type: 'invalid' };
        case 'oneAction':
            if (choice === 'single') {
                return flow({ ...answers, oneActionAnswered: true }, { ...draft, convertToProject: false, nextAction: '', extraActions: [] });
            }
            if (choice === 'project') {
                const started = startProcessInboxProjectConversion({
                    parsedTitle: input.parseTitle(draft.title).title,
                    title: draft.title,
                    taskTitle: input.task.title,
                    nextActionDraft: draft.nextAction,
                });
                return flow({ ...answers, oneActionAnswered: true }, {
                    ...draft,
                    convertToProject: true,
                    nextAction: started.nextActionDraft,
                    projectId: null,
                    projectSearch: '',
                });
            }
            return { type: 'invalid' };
        default:
            break;
    }
    // Terminal steps.
    if (step === 'file' && draft.convertToProject) {
        // The conversion card carries its own commit, with no Undo toast.
        return choice === 'createProject' ? commit('convert', null) : { type: 'invalid' };
    }
    if (choice !== 'fileIt') return { type: 'invalid' };
    const committed = getProcessInboxTerminalOutcome(step);
    switch (answers.actionability) {
        case 'later':
            return commit('later', committed);
        case 'incubate':
            return commit('incubate', committed);
        case 'trash':
            return commit('trash', committed);
        case 'someday':
            return commit('someday', committed);
        case 'reference':
            return commit('reference', committed);
        default:
            break;
    }
    if (plan.twoMinuteEnabled && answers.twoMinute === 'yes') return commit('complete', committed);
    if (!answers.execution) return { type: 'invalid' };
    if (answers.execution === 'delegate') return commit('waiting', committed);
    return commit('next', committed);
}
