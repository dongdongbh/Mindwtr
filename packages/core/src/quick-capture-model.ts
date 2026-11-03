


import {
    executeCaptureTransaction,
    filterCaptureAreas,
    filterCaptureProjects,
    hasExactCaptureAreaMatch,
    hasExactCaptureProjectMatch,
    planCaptureTask,
    prepareCaptureTask,
    type CaptureAssemblyInput,
    type CaptureTransactionActions,
    type CaptureTransactionOptions,
} from './capture';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, areaFilterSelectionToValue, resolveAreaFilterSelection } from './area-filter';
import { getDefaultTaskAreaMode, resolveDefaultNewTaskAreaId } from './area-utils';
import { getQuickDate, hasTimeComponent, isQuickDatePresetSelected, safeParseDate, type DateFormatter } from './date';
import { canStarNewCapture } from './focus-star';
import { formatFocusTaskLimitText, normalizeFocusTaskLimit } from './focus-utils';
import { tFallback, type TranslateFn } from './i18n';
import { isSelectableProjectForTaskAssignment } from './project-utils';
import { buildQuickAddPreviewEntries, formatQuickAddHelp, parseQuickAdd, splitQuickAddBulkLines, type QuickAddParseOptions, type QuickAddPreviewEntry } from './quick-add';
import { resolveFeatureFlags } from './resolve-feature-flags';
import type { StoreActionResult } from './store-types';
import { getQuickDateLabel } from './task-editor-schedule';
import { getRetainedTaskContexts, getTaskContextMatches } from './task-token-usage';
import type { AppSettings, Area, Project, Task, TaskPriority } from './types';


export type QuickCaptureOptions = {

    note: string;

    dueDate: string | null;

    dueDateHasTime: boolean;

    startTime: string | null;

    contexts: string[];
    projectId: string | null;
    areaId: string | null;
    priority: TaskPriority | null;

    focus: boolean;

    addAnother: boolean;
};


export type QuickCaptureContext = {
    settings: AppSettings;
    projects: readonly Project[];
    areas: readonly Area[];

    parseOptions: QuickAddParseOptions;

    focusedCount: number;

    defaultAreaId: string | null;

    initialProps?: Partial<Task>;

    contextChoices?: readonly string[];
    t: TranslateFn;
    formatDate: DateFormatter;
    now: Date;
};


export type QuickCaptureNotice = {
    tone: 'warning' | 'error';
    title: string;
    message: string;
    durationMs?: number;
};

export const QUICK_CAPTURE_PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

export const QUICK_CAPTURE_DATE_PRESETS = ['today', 'tomorrow', 'next_week'] as const;
export type QuickCaptureDatePreset = typeof QUICK_CAPTURE_DATE_PRESETS[number];

export const QUICK_CAPTURE_BULK_PREVIEW_LINES = 5;


export const normalizeQuickCaptureContext = (token: string): string => {
    const trimmed = token.trim();
    if (!trimmed) return '';
    const stripped = trimmed.replace(/^[@＠]+/, '');
    if (!stripped) return '';
    return `@${stripped}`;
};


export const parseQuickCaptureContextQuery = (value: string): string[] => {
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const part of value.split(',')) {
        const normalized = normalizeQuickCaptureContext(part);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tokens.push(normalized);
    }
    return tokens;
};

const normalizeInitialContexts = (contexts?: readonly string[]): string[] => Array.from(new Set(
    (contexts ?? []).map((item) => normalizeQuickCaptureContext(String(item || ''))).filter(Boolean),
));


export function getQuickCaptureContextChoices(tasks: readonly Task[], initialContexts?: readonly string[]): string[] {
    return Array.from(new Set(
        [...getRetainedTaskContexts(tasks as Task[]), ...normalizeInitialContexts(initialContexts)]
            .map((item) => normalizeQuickCaptureContext(String(item || '')))
            .filter(Boolean),
    ));
}

const sameToken = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();


export function getQuickCaptureContextPicker(choices: readonly string[], query: string, selected: readonly string[], history: readonly string[] = []): {
    items: string[];
    addable: boolean;
} {
    const tokens = parseQuickCaptureContextQuery(query);
    const filter = normalizeQuickCaptureContext(query.split(',').pop() ?? '').toLowerCase();
    return {
        items: filter ? getTaskContextMatches([...choices, ...history], filter, 8) : [...choices],
        addable: tokens.some((token) => !selected.some((chosen) => sameToken(chosen, token))),
    };
}


export function resolveQuickCaptureDefaultAreaId(
    settings: AppSettings,
    areas: readonly Area[],
    selected?: { areaId: string | null | undefined },
): string | null {
    if (getDefaultTaskAreaMode(settings) !== 'active') return resolveDefaultNewTaskAreaId(settings, areas) ?? null;
    if (selected) return selected.areaId ?? null;
    const liveAreas = areas.filter((area) => !area.deletedAt);
    const value = areaFilterSelectionToValue(resolveAreaFilterSelection(settings.filters, liveAreas));
    return value === AREA_FILTER_ALL || value === AREA_FILTER_NONE ? null : value;
}

const toInstant = (value: string | undefined | null): string | null => (value ? safeParseDate(value)?.toISOString() ?? null : null);


export function createQuickCaptureOptions(input: {
    initialProps?: Partial<Task>;
    projects: readonly Project[];
    defaultAreaId: string | null;
    addAnother?: boolean;
}): QuickCaptureOptions {
    const { initialProps } = input;
    const projectId = initialProps?.projectId && input.projects.some((project) => (
        project.id === initialProps.projectId && isSelectableProjectForTaskAssignment(project)
    )) ? initialProps.projectId : null;
    return {
        note: initialProps?.description ?? '',
        dueDate: toInstant(initialProps?.dueDate),
        dueDateHasTime: Boolean(initialProps?.dueDate && hasTimeComponent(initialProps.dueDate)),
        startTime: toInstant(initialProps?.startTime),
        contexts: normalizeInitialContexts(initialProps?.contexts),
        projectId,
        areaId: projectId ? null : (initialProps?.areaId ?? input.defaultAreaId),
        priority: (initialProps?.priority as TaskPriority) ?? null,
        focus: Boolean(initialProps?.isFocusedToday),
        addAnother: Boolean(input.addAnother),
    };
}


export type QuickCaptureEdit =
    | { type: 'setNote'; value: string }
    | { type: 'selectProject'; projectId: string | null }

    | { type: 'resetProject' }

    | { type: 'selectArea'; areaId: string | null }
    | { type: 'toggleContext'; value: string }
    | { type: 'removeContext'; value: string }
    | { type: 'clearContexts' }

    | { type: 'addContexts'; query: string }
    | { type: 'setPriority'; priority: TaskPriority | null }
    | { type: 'toggleFocus' }
    | { type: 'setAddAnother'; value: boolean }

    | { type: 'setDueDay'; day: string }

    | { type: 'setDueTime'; time: string }
    | { type: 'clearDueDate' }
    | { type: 'clearDueTime' };

const canFocus = (options: QuickCaptureOptions, context: Pick<QuickCaptureContext, 'settings' | 'focusedCount'>) => (
    options.focus || canStarNewCapture({
        focusedCount: context.focusedCount,
        focusTaskLimit: normalizeFocusTaskLimit(context.settings?.gtd?.focusTaskLimit),
    })
);

const focusLimitText = (context: Pick<QuickCaptureContext, 'settings' | 't'>) => formatFocusTaskLimitText(
    tFallback(context.t, 'agenda.maxFocusItems', 'Max {{count}} focus item(s)'),
    normalizeFocusTaskLimit(context.settings?.gtd?.focusTaskLimit),
);

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const withDueDay = (options: QuickCaptureOptions, day: string): QuickCaptureOptions => {
    const [, year, month, date] = DAY_PATTERN.exec(day)!;
    const next = new Date(Number(year), Number(month) - 1, Number(date));
    const current = options.dueDate ? new Date(options.dueDate) : null;
    if (options.dueDateHasTime && current) {
        next.setHours(current.getHours(), current.getMinutes(), 0, 0);
    } else {
        next.setHours(0, 0, 0, 0);
    }
    return { ...options, dueDate: next.toISOString() };
};


export function applyQuickCaptureEdit(
    options: QuickCaptureOptions,
    edit: QuickCaptureEdit,
    context: Pick<QuickCaptureContext, 'settings' | 'focusedCount' | 'defaultAreaId' | 'contextChoices' | 't' | 'now'>,
): { options: QuickCaptureOptions; notice: QuickCaptureNotice | null } | null {
    const done = (next: QuickCaptureOptions) => ({ options: next, notice: null });
    switch (edit.type) {
        case 'setNote':
            return done({ ...options, note: edit.value });
        case 'selectProject':
            return done({ ...options, projectId: edit.projectId, areaId: edit.projectId ? null : options.areaId });
        case 'resetProject':
            return done({ ...options, projectId: null, areaId: context.defaultAreaId });
        case 'selectArea':
            return done({ ...options, areaId: edit.areaId, projectId: edit.areaId ? null : options.projectId });
        case 'toggleContext':
            return done({
                ...options,
                contexts: options.contexts.some((item) => sameToken(item, edit.value))
                    ? options.contexts.filter((item) => !sameToken(item, edit.value))
                    : [...options.contexts, edit.value],
            });
        case 'removeContext':
            return done({ ...options, contexts: options.contexts.filter((item) => !sameToken(item, edit.value)) });
        case 'clearContexts':
            return done({ ...options, contexts: [] });
        case 'addContexts': {
            const choices = context.contextChoices ?? [];
            const contexts = [...options.contexts];
            for (const token of parseQuickCaptureContextQuery(edit.query)) {
                const resolved = choices.find((item) => sameToken(item, token)) ?? token;
                if (!contexts.some((item) => sameToken(item, resolved))) contexts.push(resolved);
            }
            return done({ ...options, contexts });
        }
        case 'setPriority':
            return done({ ...options, priority: edit.priority });
        case 'toggleFocus':

            if (!options.focus && !canFocus(options, context)) {
                return {
                    options,
                    notice: { tone: 'warning', title: tFallback(context.t, 'digest.focus', 'Focus'), message: focusLimitText(context) },
                };
            }
            return done({ ...options, focus: !options.focus });
        case 'setAddAnother':
            return done({ ...options, addAnother: edit.value });
        case 'setDueDay':
            return DAY_PATTERN.test(edit.day) && safeParseDate(edit.day) ? done(withDueDay(options, edit.day)) : null;
        case 'setDueTime': {
            const match = TIME_PATTERN.exec(edit.time);
            if (!match) return null;
            const combined = options.dueDate ? new Date(options.dueDate) : new Date(context.now);
            combined.setHours(Number(match[1]), Number(match[2]), 0, 0);
            return done({ ...options, dueDate: combined.toISOString(), dueDateHasTime: true });
        }
        case 'clearDueDate':
            return done({ ...options, dueDate: null, dueDateHasTime: false });
        case 'clearDueTime': {
            if (!options.dueDate) return done({ ...options, dueDateHasTime: false });
            const midnight = new Date(options.dueDate);
            midnight.setHours(0, 0, 0, 0);
            return done({ ...options, dueDate: midnight.toISOString(), dueDateHasTime: false });
        }
        default:
            return null;
    }
}


export function getQuickCapturePickedDueDate(
    options: Pick<QuickCaptureOptions, 'dueDate' | 'dueDateHasTime'>,
    formatDate: DateFormatter,
): string | undefined {
    if (!options.dueDate) return undefined;
    const dueDate = new Date(options.dueDate);
    const dateOnly = formatDate(dueDate, 'yyyy-MM-dd');
    if (!dateOnly) return undefined;
    return options.dueDateHasTime ? dueDate.toISOString() : dateOnly;
}


export function buildQuickCapturePreview(
    text: string,
    options: Pick<QuickCaptureOptions, 'projectId' | 'dueDate' | 'dueDateHasTime' | 'startTime'>,
    context: Pick<QuickCaptureContext, 'projects' | 'areas' | 'parseOptions' | 't' | 'formatDate' | 'now'>,
): QuickAddPreviewEntry[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    return buildQuickAddPreviewEntries(
        parseQuickAdd(trimmed, context.projects as Project[], context.now, context.areas as Area[], context.parseOptions),
        {
            t: context.t,
            projects: context.projects,
            areas: context.areas,
            rawInput: trimmed,

            overrides: {
                projectId: options.projectId || undefined,
                dueDate: getQuickCapturePickedDueDate(options, context.formatDate),
                startTime: options.startTime ?? undefined,
            },
            formatDate: context.formatDate,
        },
    );
}


export function getQuickCaptureLabels(
    options: QuickCaptureOptions,
    context: Pick<QuickCaptureContext, 'projects' | 'areas' | 'settings' | 'focusedCount' | 't' | 'formatDate'>,
) {
    const { t, formatDate } = context;
    const dueDate = options.dueDate ? new Date(options.dueDate) : null;
    const project = options.projectId ? context.projects.find((entry) => entry.id === options.projectId) : null;
    return {
        due: dueDate ? formatDate(dueDate, options.dueDateHasTime ? 'Pp' : 'P') : t('taskEdit.dueDateLabel'),
        dueTime: dueDate && options.dueDateHasTime ? formatDate(dueDate, 'p') : t('calendar.changeTime'),
        contexts: options.contexts.length === 0
            ? t('taskEdit.contextsLabel')
            : `${options.contexts[0].replace(/^@+/, '')}${options.contexts.length > 1 ? ` +${options.contexts.length - 1}` : ''}`,
        project: project ? project.title : t('taskEdit.projectLabel'),
        projectSelected: Boolean(project),
        area: options.areaId
            ? context.areas.find((area) => area.id === options.areaId)?.name || t('taskEdit.noAreaOption')
            : t('taskEdit.noAreaOption'),
        priority: options.priority ? t(`priority.${options.priority}`) : t('taskEdit.priorityLabel'),
        canFocus: canFocus(options, context),
        focusDisabledReason: focusLimitText(context),
        prioritiesEnabled: resolveFeatureFlags(context.settings).priorities,
    };
}


export function getQuickCaptureFocusLabel(t: TranslateFn, focus: { on: boolean; canFocus: boolean; disabledReason?: string }): string {
    const add = tFallback(t, 'agenda.addToFocus', "Add to today's focus");
    if (focus.on) return tFallback(t, 'agenda.removeFromFocus', 'Remove from focus');
    return !focus.canFocus ? (focus.disabledReason || add) : add;
}


export function getQuickCaptureText(t: TranslateFn, flags: { priorities: boolean; timeEstimates: boolean }) {
    return {
        title: t('nav.addTask'),
        close: t('common.close'),
        inputLabel: t('quickAdd.inputLabel'),
        inputHint: t('quickAdd.inputHint'),
        more: tFallback(t, 'common.more', 'More'),
        hideOptions: t('taskEdit.hideOptions'),
        noteLabel: t('taskEdit.descriptionLabel'),
        notePlaceholder: t('taskEdit.descriptionPlaceholder'),
        focusChip: tFallback(t, 'agenda.title', 'Focus'),
        syntaxHelp: t('quickAdd.syntaxHelp'),
        syntaxHelpText: formatQuickAddHelp(t('quickAdd.help'), flags),

        customDate: t('recurrence.custom').replace(/[\s.…]+$/u, ''),
        addAnother: t('quickAdd.addAnother'),
        save: t('common.save'),
        saveAndEdit: t('quickAdd.saveAndEdit'),
    };
}


export const getQuickCaptureAddFailedNotice = (t: TranslateFn): QuickCaptureNotice => ({
    tone: 'error',
    title: t('common.notice'),
    message: tFallback(t, 'task.addFailed', 'Failed to add task'),
    durationMs: 4200,
});


export const getQuickCaptureInvalidDateNotice = (t: TranslateFn, commands: readonly string[]): QuickCaptureNotice => ({
    tone: 'warning',
    title: t('common.notice'),
    message: `${t('quickAdd.invalidDateCommand')}: ${commands.join(', ')}`,
    durationMs: 4200,
});


export const getQuickCaptureBulkFailedNotice = (t: TranslateFn): QuickCaptureNotice => ({
    tone: 'warning',
    title: t('common.notice'),
    message: tFallback(t, 'quickAdd.bulkCreateError', 'Could not create all tasks.'),
    durationMs: 4200,
});


export function getQuickCaptureBulkConfirm(lines: readonly string[], t: TranslateFn) {
    const preview = lines.slice(0, QUICK_CAPTURE_BULK_PREVIEW_LINES).join('\n');
    const remaining = Math.max(0, lines.length - QUICK_CAPTURE_BULK_PREVIEW_LINES);
    const suffix = remaining > 0
        ? `\n${tFallback(t, 'quickAdd.bulkMoreLines', '+{{count}} more').replace('{{count}}', String(remaining))}`
        : '';
    return {
        title: tFallback(t, 'quickAdd.bulkConfirmTitle', 'Create {{count}} tasks?').replace('{{count}}', String(lines.length)),
        message: `${preview}${suffix}`,
        confirmLabel: tFallback(t, 'quickAdd.bulkConfirmCreate', 'Create tasks'),
        cancelLabel: t('common.cancel'),
    };
}


export function planQuickCaptureSave(text: string):
    | { kind: 'empty' }
    | { kind: 'single'; text: string }
    | { kind: 'bulk'; lines: string[] } {
    if (!text.trim()) return { kind: 'empty' };
    const lines = splitQuickAddBulkLines(text);
    return lines.length > 1 ? { kind: 'bulk', lines } : { kind: 'single', text: text.trim() };
}


const presetUnderOptions = (initialProps: Partial<Task> | undefined, options: QuickCaptureOptions): Partial<Task> | undefined => {
    if (!initialProps) return initialProps;
    const {
        projectId, sectionId, areaId: _areaId, priority: _priority, description: _description,
        dueDate: _dueDate, startTime: _startTime, contexts: _contexts, isFocusedToday: _isFocusedToday,
        ...rest
    } = initialProps;

    return sectionId && projectId && options.projectId === projectId ? { ...rest, sectionId } : rest;
};


export function buildQuickCaptureRequest(
    input: {
        text: string;

        fallbackTitle: string;
        options: QuickCaptureOptions;

        extraProps?: Partial<Task>;

        projects?: readonly Project[];
    },
    context: Pick<QuickCaptureContext, 'projects' | 'areas' | 'parseOptions' | 'settings' | 'focusedCount' | 'initialProps' | 'formatDate' | 'now'>,
): { input: CaptureAssemblyInput; options: CaptureTransactionOptions } {
    const { options } = input;
    const projects = input.projects ?? context.projects;
    const trimmed = input.text.trim();
    const parsed = trimmed
        ? parseQuickAdd(trimmed, projects as Project[], context.now, context.areas as Area[], context.parseOptions)
        : { title: '', props: {}, projectTitle: undefined, detectedDate: undefined, invalidDateCommands: undefined };
    const pickedDueDate = getQuickCapturePickedDueDate(options, context.formatDate);
    const prioritiesEnabled = resolveFeatureFlags(context.settings).priorities;
    return {
        input: {
            parsed,
            rawInput: trimmed,
            fallbackTitle: input.fallbackTitle,
            projects,
            initialProps: presetUnderOptions(context.initialProps, options),
            extraProps: input.extraProps,
            selectedAreaId: options.areaId,
            starNewTask: options.focus && canFocus(options, context),

            suppressDetectedDate: Boolean(pickedDueDate),
        },
        options: {
            transformProps: (props) => {
                const taskProps = { ...props };


                const note = options.note.trim();
                if (note) {
                    const parsedNote = typeof taskProps.description === 'string' ? taskProps.description.trim() : '';
                    taskProps.description = parsedNote && parsedNote !== note ? `${note}\n${parsedNote}` : note;
                }
                if (options.projectId) taskProps.projectId = options.projectId;
                if (options.contexts.length > 0) {
                    taskProps.contexts = Array.from(new Set([...(taskProps.contexts ?? []), ...options.contexts]));
                }
                if (prioritiesEnabled && options.priority) taskProps.priority = options.priority;
                if (pickedDueDate) taskProps.dueDate = pickedDueDate;
                if (options.startTime) taskProps.startTime = options.startTime;
                return taskProps;
            },
        },
    };
}


export function planQuickCaptureTask(
    input: { text: string; options: QuickCaptureOptions; projects?: readonly Project[] },
    context: Parameters<typeof buildQuickCaptureRequest>[1],
): ReturnType<typeof planCaptureTask> {
    const request = buildQuickCaptureRequest({ text: input.text, fallbackTitle: input.text.trim(), options: input.options, projects: input.projects }, context);
    return planCaptureTask(request.input, request.options);
}


export type QuickCaptureSaved = {
    kind: 'saved';
    taskId: string | null;
    projectId: string | undefined;
    next: 'open' | 'addAnother' | 'close';

    highlightTaskId: string | null;
};

export type QuickCaptureSaveOutcome =
    | QuickCaptureSaved

    | { kind: 'refused'; reason: 'invalid-date-command' | 'write-failed'; notice: QuickCaptureNotice; error?: string };


export async function saveQuickCapture(input: {
    text: string;
    options: QuickCaptureOptions;
    context: QuickCaptureContext;
    actions: CaptureTransactionActions;
    openAfterSave?: boolean;

    fallbackTitle?: string;
    extraProps?: Partial<Task>;
}): Promise<QuickCaptureSaveOutcome> {
    const { context, options } = input;
    const request = buildQuickCaptureRequest({
        text: input.text, fallbackTitle: input.fallbackTitle ?? input.text.trim(), options, extraProps: input.extraProps,
    }, context);
    const result = await executeCaptureTransaction(request.input, input.actions, request.options);
    if (!result.success && result.reason === 'invalid-date-command') {
        return { kind: 'refused', reason: 'invalid-date-command', notice: getQuickCaptureInvalidDateNotice(context.t, result.invalidDateCommands) };
    }
    if (!result.success) {
        return {
            kind: 'refused',
            reason: 'write-failed',
            notice: getQuickCaptureAddFailedNotice(context.t),
            error: 'error' in result ? result.error : result.reason,
        };
    }
    const taskId = result.createdTaskId ?? null;
    const next = input.openAfterSave ? 'open' : options.addAnother ? 'addAnother' : 'close';
    return {
        kind: 'saved',
        taskId,
        projectId: result.props.projectId,
        next,

        highlightTaskId: next === 'close' && context.initialProps?.projectId && taskId ? taskId : null,
    };
}

export type QuickCaptureBulkOutcome =
    | { kind: 'saved' }

    | { kind: 'refused'; notice: QuickCaptureNotice }

    | { kind: 'failed' }

    | { kind: 'stale' };


export async function saveQuickCaptureBulk(input: {
    lines: readonly string[];
    options: QuickCaptureOptions;
    context: QuickCaptureContext;
    actions: Pick<CaptureTransactionActions, 'addProject'> & {
        addTasks: (items: { title: string; initialProps?: Partial<Task>; captureId?: string }[]) => Promise<StoreActionResult>;
    };

    isCurrent?: () => boolean;

    captureIds?: readonly string[];
}): Promise<QuickCaptureBulkOutcome> {

    for (const line of input.lines) {
        const plan = planQuickCaptureTask({ text: line, options: input.options }, input.context);
        if (!plan.success && plan.reason === 'invalid-date-command') {
            return { kind: 'refused', notice: getQuickCaptureInvalidDateNotice(input.context.t, plan.invalidDateCommands) };
        }
    }
    const items: { title: string; initialProps: Partial<Task>; captureId?: string }[] = [];
    let projects = input.context.projects;
    for (const line of input.lines) {
        const request = buildQuickCaptureRequest({ text: line, fallbackTitle: line.trim(), options: input.options, projects }, input.context);
        const prepared = await prepareCaptureTask(request.input, input.actions, request.options);
        if (input.isCurrent && !input.isCurrent()) return { kind: 'stale' };
        if (!prepared.success && prepared.reason === 'invalid-date-command') {
            return { kind: 'refused', notice: getQuickCaptureInvalidDateNotice(input.context.t, prepared.invalidDateCommands) };
        }
        if (!prepared.success) return { kind: 'failed' };
        const captureId = input.captureIds?.[items.length];
        items.push({ title: prepared.title, initialProps: prepared.props, ...(captureId ? { captureId } : {}) });
        if (prepared.createdProject) projects = [...projects, prepared.createdProject];
    }
    const result = await input.actions.addTasks(items);
    return result && typeof result === 'object' && result.success === false ? { kind: 'failed' } : { kind: 'saved' };
}


type Choice = { label: string; selected: boolean; edit: QuickCaptureEdit };

export type QuickCaptureView = {

    options: QuickCaptureOptions;
    text: ReturnType<typeof getQuickCaptureText>;

    canSave: boolean;
    preview: QuickAddPreviewEntry[];
    project: { label: string; selected: boolean; accessibilityLabel: string; reset: QuickCaptureEdit };
    area: { label: string; accessibilityLabel: string; reset: QuickCaptureEdit };
    contexts: { label: string; accessibilityLabel: string; reset: QuickCaptureEdit };

    priority: { label: string; accessibilityLabel: string; value: TaskPriority | null; reset: QuickCaptureEdit } | null;
    focus: { selected: boolean; enabled: boolean; label: string; accessibilityLabel: string; edit: QuickCaptureEdit };
    due: {
        label: string;

        custom: { label: string; accessibilityLabel: string; startDay: string };
        clear: QuickCaptureEdit;
        quickDates: (Choice & { preset: QuickCaptureDatePreset })[];

        time: { label: string; accessibilityLabel: string; clear: QuickCaptureEdit; start: string } | null;
    };
    addAnother: { label: string; value: boolean; edit: QuickCaptureEdit };

    failureNotices: { save: QuickCaptureNotice; lines: QuickCaptureNotice };
};


export function buildQuickCaptureView(text: string, options: QuickCaptureOptions, context: QuickCaptureContext): QuickCaptureView {
    const { t } = context;
    const labels = getQuickCaptureLabels(options, context);
    const copy = getQuickCaptureText(t, { priorities: labels.prioritiesEnabled, timeEstimates: resolveFeatureFlags(context.settings).timeEstimates });
    const dueDate = options.dueDate ? new Date(options.dueDate) : null;
    return {
        options,
        text: copy,
        canSave: Boolean(text.trim()),
        preview: buildQuickCapturePreview(text, options, context),
        project: {
            label: labels.project,
            selected: labels.projectSelected,
            accessibilityLabel: `${t('taskEdit.projectLabel')}: ${labels.project}`,
            reset: { type: 'resetProject' },
        },
        area: { label: labels.area, accessibilityLabel: `${t('taskEdit.areaLabel')}: ${labels.area}`, reset: { type: 'selectArea', areaId: null } },
        contexts: { label: labels.contexts, accessibilityLabel: `${t('taskEdit.contextsLabel')}: ${labels.contexts}`, reset: { type: 'clearContexts' } },
        priority: labels.prioritiesEnabled
            ? {
                label: labels.priority,
                accessibilityLabel: `${t('taskEdit.priorityLabel')}: ${labels.priority}`,
                value: options.priority,
                reset: { type: 'setPriority', priority: null },
            }
            : null,
        focus: {
            selected: options.focus,
            enabled: labels.canFocus,
            label: copy.focusChip,
            accessibilityLabel: getQuickCaptureFocusLabel(t, { on: options.focus, canFocus: labels.canFocus, disabledReason: labels.focusDisabledReason }),
            edit: { type: 'toggleFocus' },
        },
        due: {
            label: labels.due,
            custom: {
                label: copy.customDate,
                accessibilityLabel: `${t('taskEdit.dueDateLabel')}: ${labels.due}`,
                startDay: context.formatDate(dueDate ?? context.now, 'yyyy-MM-dd'),
            },
            clear: { type: 'clearDueDate' },
            quickDates: QUICK_CAPTURE_DATE_PRESETS.map((preset) => {
                const selected = isQuickDatePresetSelected(preset, dueDate, context.now);

                const day = getQuickDate(preset, context.now)!;
                return {
                    preset,
                    label: getQuickDateLabel(preset, t),
                    selected,
                    edit: selected ? { type: 'clearDueDate' } : { type: 'setDueDay', day: context.formatDate(day, 'yyyy-MM-dd') },
                };
            }),
            time: dueDate
                ? {
                    label: labels.dueTime,
                    accessibilityLabel: `${t('task.aria.dueTime')}: ${labels.dueTime}`,
                    clear: { type: 'clearDueTime' },
                    start: context.formatDate(dueDate, 'HH:mm'),
                }
                : null,
        },
        addAnother: { label: copy.addAnother, value: options.addAnother, edit: { type: 'setAddAnother', value: !options.addAnother } },
        failureNotices: { save: getQuickCaptureAddFailedNotice(t), lines: getQuickCaptureBulkFailedNotice(t) },
    };
}


export function buildQuickCaptureProjectPicker(options: QuickCaptureOptions, context: Pick<QuickCaptureContext, 'projects' | 't'>, query: string) {
    const { t } = context;
    const trimmed = query.trim();
    return {
        title: t('taskEdit.projectLabel'),
        placeholder: t('projects.addPlaceholder'),
        none: { label: t('taskEdit.noProjectOption'), edit: { type: 'selectProject', projectId: null } as QuickCaptureEdit },
        items: filterCaptureProjects(context.projects, { selectedAreaId: options.areaId, query }).map((project) => ({
            id: project.id,
            label: project.title,
            edit: { type: 'selectProject', projectId: project.id } as QuickCaptureEdit,
        })),

        create: !hasExactCaptureProjectMatch(context.projects, query) && trimmed
            ? { label: `${t('projects.create')} "${trimmed}"`, accessibilityLabel: `${t('projects.create')}: ${trimmed}` }
            : null,
    };
}


export function buildQuickCaptureAreaPicker(options: QuickCaptureOptions, context: Pick<QuickCaptureContext, 'areas' | 't'>, query: string) {
    const { t } = context;
    const trimmed = query.trim();
    return {
        title: t('taskEdit.areaLabel'),
        placeholder: t('common.search'),
        none: { label: t('taskEdit.noAreaOption'), edit: { type: 'selectArea', areaId: null } as QuickCaptureEdit },
        items: filterCaptureAreas(context.areas, query).map((area) => ({
            id: area.id,
            label: area.name,
            selected: options.areaId === area.id,
            edit: { type: 'selectArea', areaId: area.id } as QuickCaptureEdit,
        })),

        create: !hasExactCaptureAreaMatch(context.areas, query) && trimmed
            ? { label: `${t('areas.create')} "${trimmed}"`, accessibilityLabel: `${t('areas.create')}: ${trimmed}` }
            : null,
    };
}


export function buildQuickCaptureContextPicker(options: QuickCaptureOptions, context: Pick<QuickCaptureContext, 't'>, query: string, choices: readonly string[], history: readonly string[] = []) {
    const { t } = context;
    const { items, addable } = getQuickCaptureContextPicker(choices, query, options.contexts, history);
    const trimmed = query.trim();
    const isSelected = (token: string) => options.contexts.some((item) => sameToken(item, token));
    return {
        title: t('taskEdit.contextsLabel'),
        placeholder: t('taskEdit.contextsPlaceholder'),
        clear: { label: t('common.clear'), edit: { type: 'clearContexts' } as QuickCaptureEdit },

        submit: parseQuickCaptureContextQuery(query).length > 0 ? { type: 'addContexts', query } as QuickCaptureEdit : null,
        add: addable && trimmed
            ? { label: trimmed, accessibilityLabel: `${t('common.add')}: ${trimmed}`, edit: { type: 'addContexts', query } as QuickCaptureEdit }
            : null,
        selected: options.contexts.map((token) => ({
            label: token,
            accessibilityLabel: `${t('common.delete')}: ${token}`,
            edit: { type: 'removeContext', value: token } as QuickCaptureEdit,
        })),
        items: items.map((token) => ({
            label: token,
            selected: isSelected(token),
            accessibilityLabel: `${isSelected(token) ? t('common.delete') : t('common.add')}: ${token}`,
            edit: { type: 'toggleContext', value: token } as QuickCaptureEdit,
        })),
    };
}


export function buildQuickCapturePriorityPicker(options: QuickCaptureOptions, context: Pick<QuickCaptureContext, 't'>) {
    const { t } = context;
    return {
        title: t('taskEdit.priorityLabel'),
        none: { label: t('common.none'), edit: { type: 'setPriority', priority: null } as QuickCaptureEdit },
        items: QUICK_CAPTURE_PRIORITY_OPTIONS.map((priority) => ({
            value: priority,
            label: t(`priority.${priority}`),
            selected: options.priority === priority,
            edit: { type: 'setPriority', priority } as QuickCaptureEdit,
        })),
    };
}
