


import {
    DEFAULT_CALENDAR_DAY_START_HOUR,
    addCalendarMinutes,
    buildCalendarQuickAddTaskDraft,
    formatCalendarTimeInputValue,
    minutesToTimeEstimate,
    normalizeCalendarDurationMinutes,
    parseCalendarTimeOnDate,
} from './calendar-scheduling';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { getQuickAddProjectInitialProps, type QuickAddParseOptions } from './quick-add';
import type { StoreActionResult } from './store-types';
import type { Area, Project, Task } from './types';

const DEFAULT_CALENDAR_COMPOSER_DURATION_MINUTES = 30;

export type CalendarComposerMode = 'new' | 'existing';

export type CalendarComposerErrorCode =
    | 'invalid_range'
    | 'title_required'
    | 'task_required'
    | 'overlap'
    | 'invalid_date_command'
    | 'start_after_due'
    | 'save_failed';

export type CalendarComposerError = {
    code: CalendarComposerErrorCode;

    detail?: string;
};

export type CalendarComposerState = {
    durationMinutes: number;

    endTimeValue: string;
    error: CalendarComposerError | null;
    mode: CalendarComposerMode;
    query: string;
    selectedTaskId: string | null;

    startAt: Date | null;
    title: string;
};

export type CalendarComposerDeps = {

    findFreeSlot: (day: Date, durationMinutes: number, excludeTaskId?: string) => Date | null;

    timeEstimateToMinutes: (estimate: Task['timeEstimate']) => number;
};

export type CalendarComposerOpenOptions = {
    durationMinutes?: number;
    mode?: CalendarComposerMode;

    task?: Task | null;
};

export type CalendarComposerTaskDraft = {
    props: Partial<Task>;
    title: string;
};

export type CalendarComposerProjectToCreate = {
    color: string;
    initialProps: Pick<Project, 'areaId'> | undefined;
    name: string;
};

export type CalendarComposerSaveIntent =
    | { error: CalendarComposerError; kind: 'error' }
    | { kind: 'update'; taskId: string; updates: Partial<Task> }
    | { draft: CalendarComposerTaskDraft; kind: 'create'; projectToCreate?: CalendarComposerProjectToCreate };

export type CalendarComposerSaveContext = {
    areas?: Area[];

    isSlotFree: (start: Date, durationMinutes: number, excludeTaskId?: string) => boolean;
    now?: Date;

    parseOptions?: QuickAddParseOptions;
    projects?: Project[];
};

export type CalendarComposerActions = {
    addProject: (
        name: string,
        color: string,
        initialProps?: Partial<Project>,
    ) => Promise<Pick<Project, 'id'> | null>;
    addTask: (title: string, props?: Partial<Task>) => Promise<StoreActionResult>;
    updateTask: (taskId: string, updates: Partial<Task>) => Promise<StoreActionResult>;
};

export type CalendarComposerSaveResult =
    | { error: CalendarComposerError; cause?: unknown; success: false }
    | { kind: 'create' | 'update'; start: Date; success: true };

type CalendarComposerSaveFailure = Extract<CalendarComposerSaveResult, { success: false }>;

const composerError = (code: CalendarComposerErrorCode, detail?: string): CalendarComposerSaveIntent => ({
    error: detail ? { code, detail } : { code },
    kind: 'error',
});

const endTimeForStart = (start: Date, durationMinutes: number): string => (
    formatCalendarTimeInputValue(addCalendarMinutes(start, durationMinutes))
);

export function openComposerAt(
    start: Date,
    options: CalendarComposerOpenOptions | undefined,
    deps: CalendarComposerDeps,
): CalendarComposerState {
    const task = options?.task ?? null;
    const durationMinutes = normalizeCalendarDurationMinutes(
        options?.durationMinutes
        ?? (task ? deps.timeEstimateToMinutes(task.timeEstimate) : DEFAULT_CALENDAR_COMPOSER_DURATION_MINUTES)
    );
    return {
        durationMinutes,
        endTimeValue: endTimeForStart(start, durationMinutes),
        error: null,
        mode: options?.mode ?? 'new',
        query: task?.title ?? '',
        selectedTaskId: task?.id ?? null,
        startAt: start,
        title: '',
    };
}


export function openComposerForDate(
    date: Date,
    options: Omit<CalendarComposerOpenOptions, 'durationMinutes'> | undefined,
    deps: CalendarComposerDeps,
): CalendarComposerState {
    const task = options?.task ?? null;
    const durationMinutes = normalizeCalendarDurationMinutes(
        task ? deps.timeEstimateToMinutes(task.timeEstimate) : DEFAULT_CALENDAR_COMPOSER_DURATION_MINUTES
    );
    const slot = deps.findFreeSlot(date, durationMinutes, task?.id);
    const fallback = new Date(date);
    fallback.setHours(DEFAULT_CALENDAR_DAY_START_HOUR, 0, 0, 0);
    return openComposerAt(slot ?? fallback, { durationMinutes, mode: options?.mode, task }, deps);
}


export function setComposerStart(state: CalendarComposerState, start: Date | null): CalendarComposerState {
    if (!start) return { ...state, error: null, startAt: null };
    return {
        ...state,
        endTimeValue: endTimeForStart(start, state.durationMinutes),
        error: null,
        startAt: start,
    };
}

export function setComposerDuration(state: CalendarComposerState, durationMinutes: number): CalendarComposerState {
    const normalized = normalizeCalendarDurationMinutes(durationMinutes);
    return {
        ...state,
        durationMinutes: normalized,
        endTimeValue: state.startAt ? endTimeForStart(state.startAt, normalized) : state.endTimeValue,
        error: null,
    };
}


export function setComposerEndTime(state: CalendarComposerState, endTimeValue: string): CalendarComposerState {
    const start = state.startAt;
    const end = start ? parseCalendarTimeOnDate(start, endTimeValue) : null;
    if (!start || !end || end <= start) return { ...state, endTimeValue, error: null };
    const normalized = normalizeCalendarDurationMinutes((end.getTime() - start.getTime()) / 60_000);
    return {
        ...state,
        durationMinutes: normalized,
        endTimeValue: endTimeForStart(start, normalized),
        error: null,
    };
}

export function setComposerMode(state: CalendarComposerState, mode: CalendarComposerMode): CalendarComposerState {
    return { ...state, error: null, mode };
}

export function setComposerTitle(state: CalendarComposerState, title: string): CalendarComposerState {
    return { ...state, error: null, title };
}

export function setComposerQuery(state: CalendarComposerState, query: string): CalendarComposerState {
    return { ...state, error: null, query, selectedTaskId: null };
}

export function selectComposerTask(
    state: CalendarComposerState,
    task: Task,
    deps: CalendarComposerDeps,
): CalendarComposerState {
    const durationMinutes = normalizeCalendarDurationMinutes(deps.timeEstimateToMinutes(task.timeEstimate));
    return {
        ...state,
        durationMinutes,
        endTimeValue: state.startAt ? endTimeForStart(state.startAt, durationMinutes) : state.endTimeValue,
        error: null,
        query: task.title,
        selectedTaskId: task.id,
    };
}


export function applyComposerCreatedProject(
    draft: CalendarComposerTaskDraft,
    projectId: string,
): CalendarComposerTaskDraft {
    return {
        props: { ...draft.props, areaId: undefined, projectId },
        title: draft.title,
    };
}

export function prepareComposerSave(
    state: CalendarComposerState,
    context: CalendarComposerSaveContext,
): CalendarComposerSaveIntent {
    const start = state.startAt;
    const end = start ? parseCalendarTimeOnDate(start, state.endTimeValue) : null;
    if (!start || !end || end <= start) return composerError('invalid_range');

    const durationMinutes = normalizeCalendarDurationMinutes(state.durationMinutes);
    const selectedTaskId = state.mode === 'existing' ? state.selectedTaskId : null;
    if (state.mode === 'new' && !state.title.trim()) return composerError('title_required');
    if (state.mode === 'existing' && !selectedTaskId) return composerError('task_required');
    if (!context.isSlotFree(start, durationMinutes, selectedTaskId ?? undefined)) return composerError('overlap');

    if (selectedTaskId) {
        return {
            kind: 'update',
            taskId: selectedTaskId,
            updates: {
                startTime: start.toISOString(),
                timeEstimate: minutesToTimeEstimate(durationMinutes),
            },
        };
    }

    const draft = buildCalendarQuickAddTaskDraft(state.title, {
        areas: context.areas,
        durationMinutes,
        now: context.now ?? new Date(),
        parseOptions: context.parseOptions,
        projects: context.projects,
        start,
    });
    if (draft.invalidDateCommands.length > 0) {
        return composerError('invalid_date_command', draft.invalidDateCommands.join(', '));
    }
    if (draft.dateCoherenceIssues.some((issue) => issue.code === 'start_after_due')) {
        return composerError('start_after_due');
    }
    if (!draft.title) return composerError('title_required');


    return {
        draft: { props: draft.props, title: draft.title },
        kind: 'create',
        projectToCreate: !draft.props.projectId && draft.projectTitle
            ? {
                color: DEFAULT_PROJECT_COLOR,
                initialProps: getQuickAddProjectInitialProps(draft.props),
                name: draft.projectTitle,
            }
            : undefined,
    };
}

const actionFailure = (detail?: string): CalendarComposerSaveFailure => ({
    error: detail ? { code: 'save_failed', detail } : { code: 'save_failed' },
    success: false,
});

const thrownFailure = (cause: unknown): CalendarComposerSaveFailure => ({
    ...actionFailure(),
    cause,
});


export async function executeComposerSave(
    state: CalendarComposerState,
    context: CalendarComposerSaveContext,
    actions: CalendarComposerActions,
): Promise<CalendarComposerSaveResult> {
    const intent = prepareComposerSave(state, context);
    if (intent.kind === 'error') return { error: intent.error, success: false };

    try {
        if (intent.kind === 'update') {
            const result = await actions.updateTask(intent.taskId, intent.updates);
            if (!result.success) return actionFailure(result.error);
        } else {
            let draft = intent.draft;
            if (intent.projectToCreate) {
                const created = await actions.addProject(
                    intent.projectToCreate.name,
                    intent.projectToCreate.color,
                    intent.projectToCreate.initialProps,
                );
                if (!created) return actionFailure();
                draft = applyComposerCreatedProject(draft, created.id);
            }

            const result = await actions.addTask(draft.title, draft.props);
            if (!result.success) return actionFailure(result.error);
        }
    } catch (cause) {
        return thrownFailure(cause);
    }


    if (!state.startAt) return actionFailure();
    return { kind: intent.kind, start: state.startAt, success: true };
}
