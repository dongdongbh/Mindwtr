import { getOnboardingGuideUrl, ONBOARDING_TOPIC_COPY } from './onboarding-guidance';
import {
    formatTimeEstimateLabel,
    isCustomTimeEstimate,
    resolveTimeEstimateOptions,
} from './calendar-scheduling';
import { normalizeClockTimeInput, safeFormatDate, safeParseDate, type DateFormatter } from './date';
import { tFallback } from './i18n';
import { getPersonOptionNames, getPersonSuggestionNames } from './people';
import { filterProjectsBySelectedArea, getProjectChoiceState, groupProjectsForPicker } from './project-utils';
import { parseRRuleString } from './recurrence';
import { REFERENCE_HIDDEN_TASK_FIELDS } from './reference';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { getTaskEditorDateIssueLabel } from './task-date-coherence';
import { buildTaskMovePatch, type TaskMoveDestination } from './task-container-rules';
import {
    areDraftAttachmentsDirty,
    createTaskDraft,
    isTaskDraftDirty,
    setTaskDraftField,
    TASK_DRAFT_FIELD_KEYS,
    taskDraftToChangedUpdatePatch,
    type TaskDraft,
    type TaskDraftField,
} from './task-draft';
import {
    DEFAULT_TASK_EDITOR_HIDDEN,
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_VISIBLE,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    isTaskEditorSectionFieldVisible,
    normalizeTaskEditorOrder,
    TASK_EDITOR_FIXED_FIELDS,
    TASK_EDITOR_SECTION_ORDER,
} from './task-editor-layout';
import {
    getTaskDraftRecurrenceWeekdays,
    getTaskEditorDatePart,
    getTaskEditorMonthlyCustom,
    getTaskEditorRecurrenceCalendarPreviewHint,
    getTaskEditorRecurrenceDetails,
    getTaskEditorRelativeStart,
    getTaskEditorReminders,
    getTaskEditorTimeEstimate,
    getTaskEditorWeekdayButtons,
    isTaskEditorTimeSpentEnabled,
    parseTaskEditorTimeSpent,
    type TaskEditorDatePart,
    type TaskEditorMonthlyCustom,
    type TaskEditorRecurrenceDetails,
    type TaskEditorRelativeStart,
    type TaskEditorReminders,
    type TaskEditorTimeEstimate,
} from './task-editor-schedule';
import { normalizeTimeSpentMinutes } from './time-spent';
import { getFrequentTaskTokensFromUsage, getTaskContextMatches, type TaskTokenUsage } from './task-token-usage';
import { compareAreasByOrder } from './task-utils';
import { resolveTaskViewSection, setTaskViewSectionId, sortViewSectionDefinitions } from './view-sections';
import type {
    AppSettings,
    Area,
    Attachment,
    Person,
    Project,
    RecurrenceRule,
    Section,
    Task,
    TaskEditorFieldId,
    TaskEditorSectionId,
    TaskEditorSettings,
    TaskEnergyLevel,
    TaskPriority,
    TaskStatus,
    TimeEstimate,
    ViewSectionDefinition,
    ViewSectionIds,
} from './types';


export const TASK_EDITOR_STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'];
export const TASK_EDITOR_PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
export const TASK_EDITOR_ENERGY_LEVEL_OPTIONS: TaskEnergyLevel[] = ['low', 'medium', 'high'];
export const TASK_EDITOR_RECURRENCE_OPTIONS: ReadonlyArray<{ value: RecurrenceRule | ''; labelKey: string }> = [
    { value: '', labelKey: 'recurrence.none' },
    { value: 'daily', labelKey: 'recurrence.daily' },
    { value: 'weekly', labelKey: 'recurrence.weekly' },
    { value: 'monthly', labelKey: 'recurrence.monthly' },
    { value: 'yearly', labelKey: 'recurrence.yearly' },
];

const REFERENCE_HIDDEN_FIELDS = new Set<TaskEditorFieldId>(REFERENCE_HIDDEN_TASK_FIELDS);


export function getTaskEditorProjectSections(sections: readonly Section[], projectId: string | undefined): Section[] {
    if (!projectId) return [];
    return sections
        .filter((section) => section.projectId === projectId && !section.deletedAt)
        .sort((a, b) => {
            const aOrder = Number.isFinite(a.order) ? a.order : 0;
            const bOrder = Number.isFinite(b.order) ? b.order : 0;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.title.localeCompare(b.title);
        });
}


export function getTaskEditorTimeEstimateValues(current: TimeEstimate | '' | undefined): Array<TimeEstimate | ''> {
    return ['', ...resolveTimeEstimateOptions(current && !isCustomTimeEstimate(current) ? current : undefined)];
}

export function getTaskEditorDailyInterval(rule: RecurrenceRule | '' | undefined, rrule: string): number {
    if (rule !== 'daily') return 1;
    const parsed = parseRRuleString(rrule);
    return parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
}


export function getTaskEditorMonthlyAnchorSource(task: Task | null, draft: TaskDraft | null): string | undefined {
    return draft ? draft.dueDate || draft.startTime : task?.dueDate || task?.startTime;
}

export function resolveTaskEditorMonthlyAnchorDate(source: string | undefined, now: Date = new Date()): Date {
    return safeParseDate(source) ?? now;
}


export function getTaskEditorMonthlyPattern(
    rule: RecurrenceRule | '' | undefined,
    rrule: string,
    anchorDate: Date,
): 'date' | 'custom' {
    if (rule !== 'monthly') return 'date';
    const parsed = parseRRuleString(rrule);
    const hasByDay = Boolean(parsed.byDay?.length);
    const hasByMonthDay = parsed.byMonthDay && parsed.byMonthDay.length > 0;


    const isCustomDay = hasByMonthDay
        && (parsed.byMonthDay!.length > 1 || parsed.byMonthDay![0] !== anchorDate.getDate());
    return hasByDay || isCustomDay ? 'custom' : 'date';
}

export type TaskEditorFieldLayoutInput = {
    task: Task | null;

    draft: TaskDraft | null;
    checklist: Task['checklist'];
    taskEditor: TaskEditorSettings | undefined;
    hasProjectSections: boolean;
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;

    contextInputDraft: string;
    descriptionDraft: string;
    tagInputDraft: string;
    visibleAttachmentsLength: number;
};

export type TaskEditorFieldLayout = {
    sections: Record<TaskEditorSectionId, TaskEditorFieldId[]>;
    showStatusField: boolean;
};


export function getTaskEditorFieldLayout(input: TaskEditorFieldLayoutInput): TaskEditorFieldLayout {
    const { task, draft, taskEditor, prioritiesEnabled, timeEstimatesEnabled } = input;
    const disabledFields = new Set<TaskEditorFieldId>();
    if (!prioritiesEnabled) disabledFields.add('priority');
    if (!timeEstimatesEnabled) disabledFields.add('timeEstimate');
    const defaultHidden = DEFAULT_TASK_EDITOR_ORDER.filter(
        (fieldId) => !DEFAULT_TASK_EDITOR_VISIBLE.includes(fieldId) || disabledFields.has(fieldId)
    );
    const savedHidden = taskEditor?.hidden ?? defaultHidden;
    const order = normalizeTaskEditorOrder(taskEditor?.order ?? [], disabledFields);
    const known = new Set(order);
    const hidden = new Set(savedHidden.filter((id) => known.has(id)));
    disabledFields.forEach((fieldId) => hidden.add(fieldId));
    const assignments = getTaskEditorSectionAssignments(taskEditor);

    const editStatus = draft?.status ?? task?.status;
    const isReference = editStatus === 'reference';


    const hasPersistedDefaults = Boolean(taskEditor?.defaultsVersion)
        && !taskEditor?.order?.length
        && savedHidden.length === DEFAULT_TASK_EDITOR_HIDDEN.length
        && DEFAULT_TASK_EDITOR_HIDDEN.every((field) => savedHidden.includes(field));
    const isAssignedToExplicitlyHidden = !hasPersistedDefaults && (taskEditor?.hidden?.includes('assignedTo') ?? false);
    const projectId = draft ? draft.projectId : task?.projectId;
    const sectionId = draft ? draft.sectionId : task?.sectionId;
    const areaId = draft ? draft.areaId : task?.areaId;
    const showSectionField = isTaskEditorSectionFieldVisible(taskEditor, {
        projectId,
        sectionId,
        hasProjectSections: input.hasProjectSections,
    });
    const value = <K extends keyof TaskDraft & keyof Task>(field: K) => (draft ? draft[field] : task?.[field]);
    const hasValue = (fieldId: TaskEditorFieldId): boolean => {
        switch (fieldId) {
            case 'project': return Boolean(projectId);
            case 'section': return Boolean(sectionId);
            case 'area': return Boolean(areaId);
            case 'priority': return prioritiesEnabled && Boolean(value('priority'));
            case 'energyLevel': return Boolean(value('energyLevel'));
            case 'assignedTo': return Boolean(value('assignedTo')?.trim());
            case 'contexts': return Boolean(input.contextInputDraft.trim());
            case 'description': return Boolean(input.descriptionDraft.trim());
            case 'location': return Boolean(value('location')?.trim());
            case 'tags': return Boolean(input.tagInputDraft.trim());
            case 'timeEstimate': return timeEstimatesEnabled && Boolean(value('timeEstimate'));
            case 'recurrence': return Boolean(value('recurrence'));
            case 'startTime': return Boolean(value('startTime'));
            case 'dueDate': return Boolean(value('dueDate'));
            case 'reviewAt': return Boolean(value('reviewAt'));
            case 'attachments': return input.visibleAttachmentsLength > 0;
            case 'checklist': return (input.checklist ?? task?.checklist ?? []).length > 0;
            default: return false;
        }
    };
    const isVisible = (fieldId: TaskEditorFieldId): boolean => {
        if (isReference && REFERENCE_HIDDEN_FIELDS.has(fieldId)) return false;
        if (fieldId === 'section') return showSectionField;
        if (fieldId === 'assignedTo' && editStatus === 'waiting' && !isAssignedToExplicitlyHidden) return true;
        return !hidden.has(fieldId) || hasValue(fieldId);
    };
    const inSection = (section: TaskEditorSectionId) => order.filter((fieldId) => (
        (section === 'basic' && TASK_EDITOR_FIXED_FIELDS.includes(fieldId)) || assignments[fieldId] === section
    )).filter(isVisible);
    return {
        sections: {
            basic: inSection('basic'),
            scheduling: inSection('scheduling'),
            organization: inSection('organization'),
            details: inSection('details'),
        },
        showStatusField: isVisible('status'),
    };
}


export function countTaskEditorFilledFields(
    fieldIds: readonly TaskEditorFieldId[],
    { draft, checklist, attachments }: {
        draft: TaskDraft | null | undefined;
        checklist: Task['checklist'];
        attachments: Attachment[] | undefined;
    },
): number {
    return fieldIds.filter((fieldId) => {
        switch (fieldId) {
            case 'startTime': return Boolean(draft?.startTime);
            case 'recurrence': return Boolean(draft?.recurrence);
            case 'reviewAt': return Boolean(draft?.reviewAt);
            case 'contexts': return Boolean(draft?.contexts.trim());
            case 'tags': return Boolean(draft?.tags.trim());
            case 'priority': return Boolean(draft?.priority);
            case 'energyLevel': return Boolean(draft?.energyLevel);
            case 'assignedTo': return Boolean(draft?.assignedTo.trim());
            case 'timeEstimate': return Boolean(draft?.timeEstimate);
            case 'description': return Boolean(draft?.description.trim());
            case 'location': return Boolean(draft?.location.trim());
            case 'checklist': return (checklist?.length ?? 0) > 0;
            case 'attachments': return (attachments || []).some((attachment) => !attachment.deletedAt);
            default: return false;
        }
    }).length;
}


export type TaskEditDraft = {
    draft: TaskDraft;
    checklist: Task['checklist'];
    attachments: Attachment[] | undefined;
};

export function createTaskEditDraft(task: Task): TaskEditDraft {
    return {
        draft: createTaskDraft(task),
        checklist: task.checklist,
        attachments: task.attachments,
    };
}

const areChecklistsDirty = (state: TaskEditDraft, task: Task) => (
    JSON.stringify(state.checklist ?? null) !== JSON.stringify(task.checklist ?? null)
);

export function isTaskEditDraftDirty(state: TaskEditDraft, task: Task): boolean {
    return isTaskDraftDirty(state.draft, task)
        || areChecklistsDirty(state, task)
        || areDraftAttachmentsDirty(state.attachments, task);
}

export type TaskEditDraftOverrides = {
    title?: string;
    description?: string;
    contexts?: string[];
    tags?: string[];
};

const applyDraftOverrides = (
    state: TaskEditDraft,
    overrides: TaskEditDraftOverrides,
): TaskEditDraft => {
    if (Object.keys(overrides).length === 0) return state;
    let draft = state.draft;
    if (overrides.title !== undefined) draft = setTaskDraftField(draft, 'title', overrides.title);
    if (overrides.description !== undefined) draft = setTaskDraftField(draft, 'description', overrides.description);
    if (overrides.contexts !== undefined) draft = setTaskDraftField(draft, 'contexts', overrides.contexts.join(', '));
    if (overrides.tags !== undefined) draft = setTaskDraftField(draft, 'tags', overrides.tags.join(', '));
    return draft === state.draft ? state : { ...state, draft };
};


export function buildTaskEditUpdatePatch(
    state: TaskEditDraft,
    task: Task,
    overrides: TaskEditDraftOverrides = {},
): Partial<Task> | null {
    const finalState = applyDraftOverrides(state, overrides);
    const narrowed = taskDraftToChangedUpdatePatch(finalState.draft, task, {
        attachments: finalState.attachments,
    });
    if (!narrowed) return null;


    const cleanedChecklist = finalState.checklist?.filter((item) => item.title.trim() !== '');
    const bothEmpty = (cleanedChecklist?.length ?? 0) === 0 && (task.checklist?.length ?? 0) === 0;
    if (!bothEmpty && areChecklistsDirty({ ...finalState, checklist: cleanedChecklist }, task)) {
        narrowed.checklist = cleanedChecklist;
    }
    return narrowed;
}


export function clearInvalidTaskDraftSection(
    draft: TaskDraft,
    sections: ReadonlyArray<{ id: string; projectId?: string; deletedAt?: string | null }>,
): TaskDraft {
    if (!draft.projectId || !draft.sectionId) return draft;
    const isValid = sections.some((section) =>
        section.id === draft.sectionId && section.projectId === draft.projectId && !section.deletedAt
    );
    return isValid ? draft : setTaskDraftField(draft, 'sectionId', '');
}


const DRAFT_APPLY_ORDER: TaskDraftField[] = [
    'status',
    ...TASK_DRAFT_FIELD_KEYS.filter((field) => field !== 'status'),
];


export function applyTaskDraftPatch(draft: TaskDraft, patch: Partial<TaskDraft>): TaskDraft {
    let next = draft;
    for (const field of DRAFT_APPLY_ORDER) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) {
            next = setTaskDraftField(next, field, patch[field] as TaskDraft[typeof field]);
        }
    }
    return next;
}


export function getTaskEditorBackdatedCompletionStart(
    task: Pick<Task, 'status' | 'updatedAt'>,
    draft: Pick<TaskDraft, 'completedAt' | 'timeSpentMinutes'>,
): { initialValue: string | null; initialTimeSpentMinutes: number | null } {
    const raw = draft.completedAt || (task.status === 'done' ? task.updatedAt : null);
    const parsed = raw ? new Date(raw) : null;
    return {
        initialValue: parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null,
        initialTimeSpentMinutes: normalizeTimeSpentMinutes(draft.timeSpentMinutes) ?? null,
    };
}


export function resolveTaskEditorBackdatedCompletion(input: {
    completedAt: string;
    timeSpentText?: string;
}): Pick<TaskDraft, 'status' | 'completedAt'> & Partial<Pick<TaskDraft, 'timeSpentMinutes'>> | null {
    if (!input || typeof input.completedAt !== 'string'
        || safeParseDate(input.completedAt)?.toISOString() !== input.completedAt
        || (input.timeSpentText !== undefined && typeof input.timeSpentText !== 'string')) return null;
    return {
        status: 'done', completedAt: input.completedAt,
        ...(input.timeSpentText !== undefined
            ? { timeSpentMinutes: normalizeTimeSpentMinutes(parseTaskEditorTimeSpent(input.timeSpentText)) }
            : {}),
    };
}


export const TASK_EDITOR_QUICK_TOKEN_LIMIT = 6;

type TokenPrefix = '@' | '#';


export const parseTaskEditorTokenList = (value: string | undefined, tokenPrefix: TokenPrefix): string[] => {
    if (!value) return [];
    const tokens = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
            if (item.startsWith(tokenPrefix)) return item;
            const stripped = item.replace(/^[@#]+/, '').trim();
            if (!stripped) return '';
            return `${tokenPrefix}${stripped}`;
        })
        .filter(Boolean);

    return Array.from(new Set(tokens));
};


export const getTaskEditorActiveTokenQuery = (value: string | undefined, _tokenPrefix?: TokenPrefix): string => {
    if (!value) return '';
    const draft = value.split(',').pop()?.trim() ?? '';
    const stripped = draft.replace(/^[@#]+/, '').trim();
    if (!stripped) return '';
    return stripped.toLowerCase();
};


export const replaceTaskEditorTrailingToken = (value: string | undefined, token: string): string => {
    const source = value ?? '';
    const lastCommaIndex = source.lastIndexOf(',');
    if (lastCommaIndex === -1) {
        return `${token}, `;
    }
    const head = source.slice(0, lastCommaIndex + 1).trimEnd();
    return `${head} ${token}, `;
};


export function toggleTaskEditorToken(value: string, token: string, tokenPrefix: TokenPrefix): string {
    const next = new Set(parseTaskEditorTokenList(value, tokenPrefix));
    if (next.has(token)) {
        next.delete(token);
    } else {
        next.add(token);
    }
    return Array.from(next).join(', ');
}


export function getTaskEditorTokenPool(
    editedTokens: readonly string[] | undefined,
    knownTokens: readonly string[],
    tokenPrefix: TokenPrefix,
): string[] {
    return Array.from(new Set([...(editedTokens ?? []), ...knownTokens]))
        .filter((item): item is string => Boolean(item?.startsWith(tokenPrefix)));
}


export function getTaskEditorTokenMatches(
    pool: readonly string[],
    value: string,
    tokenPrefix: TokenPrefix,
    limit: number,
): string[] {
    const query = getTaskEditorActiveTokenQuery(value, tokenPrefix);
    if (!query) return [];
    const selected = new Set(parseTaskEditorTokenList(value, tokenPrefix));
    if (tokenPrefix === '@') {
        return getTaskContextMatches(pool.filter((token) => !selected.has(token)), query, limit);
    }
    return pool
        .filter((token) => token.slice(1).toLowerCase().includes(query))
        .filter((token) => !selected.has(token))
        .slice(0, limit);
}

export type TaskEditorSuggestions = {

    draftValue: string;

    matches: Array<{ value: string; text: string }>;

    quick: Array<{ value: string; selected: boolean; text: string }>;

    canCreatePerson?: boolean;
};


export function getTaskEditorSuggestions(input: {
    field: 'contexts' | 'tags' | 'assignedTo';
    text: string;

    limit: number;

    knownTokens: readonly string[];
    usage: readonly TaskTokenUsage[];
    people: readonly Person[];
    tasks: readonly Task[];
}): TaskEditorSuggestions {
    const { text, limit } = input;
    if (input.field === 'assignedTo') {
        const names = getPersonSuggestionNames(input.people, input.tasks, text, limit);
        const name = text.trim();
        return {
            draftValue: text,
            matches: names.map((name) => ({ value: name, text: name })),
            quick: [],
            canCreatePerson: name.length > 0 && !names.some((value) => value.trim().toLowerCase() === name.toLowerCase()),
        };
    }
    const prefix: TokenPrefix = input.field === 'contexts' ? '@' : '#';

    const draftValue = parseTaskEditorTokenList(text, prefix).join(', ');
    const pool = getTaskEditorTokenPool(parseTaskEditorTokenList(draftValue, prefix), input.knownTokens, prefix);
    const selected = new Set(parseTaskEditorTokenList(text, prefix));
    return {
        draftValue,
        matches: getTaskEditorTokenMatches(pool, text, prefix, limit)
            .map((token) => ({ value: token, text: replaceTaskEditorTrailingToken(text, token) })),
        quick: getFrequentTaskTokensFromUsage(input.usage, TASK_EDITOR_QUICK_TOKEN_LIMIT).map((token) => ({
            value: token,
            selected: selected.has(token),
            text: toggleTaskEditorToken(text, token, prefix),
        })),
    };
}


export function getSomedaySectionChoices(
    sections: readonly ViewSectionDefinition[],
    selectedId: string | undefined,
    noSectionTitle: string,
    selectionMixed = false,
): Array<{ id: string; title: string; selected: boolean }> {
    const sortedSections = sortViewSectionDefinitions(sections);
    const resolvedSelectedId = sortedSections.some((section) => section.id === selectedId) ? selectedId : undefined;
    return [{ id: '', title: noSectionTitle }, ...sortedSections].map((section) => ({
        id: section.id,
        title: section.title,
        selected: !selectionMixed && (resolvedSelectedId ?? '') === section.id,
    }));
}

export type TaskEditorLayoutSection = {
    id: TaskEditorSectionId;

    titleKey: string | null;
    fields: TaskEditorFieldId[];

    filledCount: number;

    open: boolean;


    help?: { label: string; body: string; readGuide: string; guideError: string; dismiss: string; guideUrl: string };
};

export type TaskEditorModel = {
    layout: {

        sections: TaskEditorLayoutSection[];
        showStatusField: boolean;

        showSomedaySection: boolean;

        recurrence: { dailyInterval: number; monthlyPattern: 'date' | 'custom' };
    };
    options: {
        statuses: TaskStatus[];
        priorities: TaskPriority[];
        energyLevels: TaskEnergyLevel[];
        recurrences: Array<{ value: RecurrenceRule | ''; labelKey: string }>;

        timeEstimates: Array<{ value: TimeEstimate | ''; label: string }>;

        projects: Array<{ id: string; title: string; areaId: string | null; deferred?: boolean }>;

        sections: Array<{ id: string; title: string }>;
        areas: Array<{ id: string; name: string; color: string | null }>;
        contexts: string[];
        tags: string[];
        people: string[];

        somedaySections: Array<{ id: string; title: string; selected: boolean; viewSectionIds: ViewSectionIds }>;
    };


    fields: {
        startTime: TaskEditorDatePart;
        dueDate: TaskEditorDatePart;
        reviewAt: TaskEditorDatePart;

        dateIssue: string;

        relativeStart: TaskEditorRelativeStart | null;

        recurrence: TaskEditorRecurrenceDetails & {
            calendarPreviewHint: string;
            weekdays: ReturnType<typeof getTaskEditorWeekdayButtons>;
            monthlyCustom: TaskEditorMonthlyCustom;
        };
        reminders: TaskEditorReminders;
        timeEstimate: TaskEditorTimeEstimate;
        timeSpent: { enabled: boolean };
    };
};

export type TaskEditorModelInput = {
    task: Task;
    draft: TaskDraft;
    settings: AppSettings;

    projects: Project[];
    sections: readonly Section[];
    areas: readonly Area[];
    tasks: readonly Task[];
    people: readonly Person[];

    contexts: readonly string[];
    tags: readonly string[];

    checklist?: Task['checklist'];
    t: (key: string) => string;
    now?: Date;

    formatDate?: DateFormatter;

    language?: string;

    groupDeferredProjects?: boolean;
};

export type TaskDraftDestinationPicker = {
    query: string;
    destination: {

        fieldId: 'project' | 'area' | null;
        label: string;
        value: string;
        emptyLabel: string | null;
        groups: Array<{
            kind: TaskMoveDestination['kind'];
            label: string | null;
            choices: Array<{
                id: string;
                label: string;
                selected: boolean;
                patch: Pick<TaskDraft, 'projectId' | 'areaId' | 'sectionId'>;
            }>;
        }>;
    };
    section: {
        visible: boolean;
        label: string;
        value: string;
        emptyLabel: string | null;
        choices: Array<{ id: string; label: string; selected: boolean; patch: Pick<TaskDraft, 'sectionId'> }>;
    };
};


function editorProjectOptions(projects: Project[], areas: readonly Area[], grouped: boolean): TaskEditorModel['options']['projects'] {
    const option = (project: Project) => ({ id: project.id, title: project.title, areaId: project.areaId ?? null });
    if (!grouped) return projects.map(option);
    const { active, deferred } = groupProjectsForPicker(projects, areas);
    return [...active.map((project) => ({ ...option(project), deferred: false })), ...deferred.map((project) => ({ ...option(project), deferred: true }))];
}


export function buildTaskDraftDestinationPicker(input: {
    draft: TaskDraft;
    layout: TaskEditorModel['layout'];
    projects: Project[];
    sections: readonly Section[];
    areas: readonly Area[];
    query: string;
    t: (key: string) => string;
    groupDeferredProjects?: boolean;
}): TaskDraftDestinationPicker {
    const { draft, query, t } = input;
    const basicFields = input.layout.sections.find((section) => section.id === 'basic')?.fields ?? [];
    const destinationFields = basicFields.filter((field): field is 'project' | 'area' => field === 'project' || field === 'area');
    const normalizedQuery = query.trim().toLowerCase();
    const choice = (destination: TaskMoveDestination, label: string) => {
        const patch = buildTaskMovePatch(destination, { projectId: draft.projectId, sectionId: draft.sectionId });
        return {
            id: destination.kind === 'none' ? '' : destination.id,
            label,
            selected: destination.kind === 'none' ? !draft.projectId && !draft.areaId
                : destination.kind === 'project' ? draft.projectId === destination.id : draft.areaId === destination.id,
            patch: { projectId: patch.projectId ?? '', areaId: patch.areaId ?? '', sectionId: patch.sectionId ?? '' },
        };
    };
    const groups: TaskDraftDestinationPicker['destination']['groups'] = [
        { kind: 'none', label: null, choices: [choice({ kind: 'none' }, t('common.none'))] },
    ];
    if (destinationFields.includes('project')) {
        const { filteredProjects } = getProjectChoiceState(filterProjectsBySelectedArea(input.projects, draft.areaId), query, input.projects);
        const projectChoices = (projects: readonly Project[]) => projects.map((project) => choice({ kind: 'project', id: project.id }, project.title));
        if (input.groupDeferredProjects) {
            const { active, deferred } = groupProjectsForPicker(filteredProjects, input.areas);
            groups.push({ kind: 'project', label: t('nav.projects'), choices: projectChoices(active) });
            if (deferred.length > 0) groups.push({ kind: 'project', label: tFallback(t, 'projects.deferredSection', 'Someday / Waiting'), choices: projectChoices(deferred) });
        } else {
            groups.push({ kind: 'project', label: t('nav.projects'), choices: projectChoices(filteredProjects) });
        }
    }
    if (destinationFields.includes('area')) {
        const areas = input.areas.filter((area) => !area.deletedAt && (!normalizedQuery || area.name.toLowerCase().includes(normalizedQuery)))
            .sort(compareAreasByOrder);
        groups.push({ kind: 'area', label: t('taskEdit.areaLabel'), choices: areas.map((area) => choice({ kind: 'area', id: area.id }, area.name)) });
    }
    const sections = getTaskEditorProjectSections(input.sections, draft.projectId);
    const filteredSections = sections.filter((section) => !normalizedQuery || section.title.toLowerCase().includes(normalizedQuery));
    const sectionVisible = Boolean(draft.projectId) && basicFields.includes('section');
    const noSection = t('taskEdit.noSectionOption');
    return {
        query,
        destination: {
            fieldId: destinationFields[0] ?? null,
            label: t('task.destination'),
            value: draft.projectId
                ? input.projects.find((project) => project.id === draft.projectId && !project.deletedAt)?.title || t('taskEdit.noProjectOption')
                : draft.areaId
                    ? input.areas.find((area) => area.id === draft.areaId && !area.deletedAt)?.name || t('taskEdit.noAreaOption')
                    : t('common.none'),
            emptyLabel: groups.every((group) => group.kind === 'none' || group.choices.length === 0) ? t('common.noMatches') : null,
            groups,
        },
        section: {
            visible: sectionVisible,
            label: t('taskEdit.sectionLabel'),
            value: sections.find((section) => section.id === draft.sectionId)?.title || noSection,
            emptyLabel: normalizedQuery && filteredSections.length === 0 ? t('common.noMatches') : null,
            choices: sectionVisible ? [
                { id: '', label: noSection, selected: !draft.sectionId, patch: { sectionId: '' } },
                ...filteredSections.map((section) => ({ id: section.id, label: section.title, selected: draft.sectionId === section.id, patch: { sectionId: section.id } })),
            ] : [],
        },
    };
}


export function buildTaskEditorModel(input: TaskEditorModelInput): TaskEditorModel {
    const { task, draft, t } = input;
    const flags = resolveFeatureFlags(input.settings);
    const taskEditor = input.settings.gtd?.taskEditor;
    const projectSections = getTaskEditorProjectSections(input.sections, draft.projectId);
    const checklist = input.checklist ?? task.checklist;
    const { sections, showStatusField } = getTaskEditorFieldLayout({
        task,
        draft,
        checklist,
        taskEditor,
        hasProjectSections: projectSections.length > 0,
        prioritiesEnabled: flags.priorities,
        timeEstimatesEnabled: flags.timeEstimates,
        contextInputDraft: draft.contexts,
        descriptionDraft: draft.description,
        tagInputDraft: draft.tags,
        visibleAttachmentsLength: (task.attachments ?? []).filter((attachment) => !attachment.deletedAt).length,
    });
    const openDefaults = getTaskEditorSectionOpenDefaults(taskEditor);
    const somedayDefinitions = sortViewSectionDefinitions(input.settings.gtd?.viewSections?.someday ?? []);
    const now = input.now ?? new Date();
    const anchorDate = resolveTaskEditorMonthlyAnchorDate(getTaskEditorMonthlyAnchorSource(task, draft), now);
    const formatDate = input.formatDate ?? safeFormatDate;
    const dailyInterval = getTaskEditorDailyInterval(draft.recurrence, draft.recurrenceRRule);
    const dateOptions = {
        t,
        now,
        formatDate,
        defaultScheduleTime: normalizeClockTimeInput(input.settings.gtd?.defaultScheduleTime) || '',
    };
    return {
        layout: {
            sections: TASK_EDITOR_SECTION_ORDER.filter((id) => sections[id].length > 0).map((id) => {
                const filledCount = countTaskEditorFilledFields(sections[id], {
                    draft,
                    checklist,
                    attachments: task.attachments,
                });
                return {
                    id,
                    titleKey: id === 'basic' ? null : `taskEdit.${id}`,
                    fields: sections[id],
                    filledCount,
                    open: openDefaults[id] || filledCount > 0,
                    ...(id === 'scheduling' || id === 'details' ? { help: {
                        label: `${t('onboarding.help')}: ${t(ONBOARDING_TOPIC_COPY[id].title)}`,
                        body: t(ONBOARDING_TOPIC_COPY[id].body),
                        readGuide: t('onboarding.readGuide'),
                        guideError: t('onboarding.guideError'),
                        dismiss: t('common.dismiss'),
                        guideUrl: getOnboardingGuideUrl(id, 'mobile', input.language),
                    } } : {}),
                };
            }),
            showStatusField,
            showSomedaySection: draft.status === 'someday',
            recurrence: {
                dailyInterval,
                monthlyPattern: getTaskEditorMonthlyPattern(draft.recurrence, draft.recurrenceRRule, anchorDate),
            },
        },
        options: {
            statuses: [...TASK_EDITOR_STATUS_OPTIONS],
            priorities: [...TASK_EDITOR_PRIORITY_OPTIONS],
            energyLevels: [...TASK_EDITOR_ENERGY_LEVEL_OPTIONS],
            recurrences: TASK_EDITOR_RECURRENCE_OPTIONS.map((option) => ({ ...option })),
            timeEstimates: getTaskEditorTimeEstimateValues(draft.timeEstimate).map((value) => ({
                value,
                label: value ? formatTimeEstimateLabel(value, { t }) : t('common.none'),
            })),
            projects: editorProjectOptions(filterProjectsBySelectedArea(input.projects, draft.areaId), input.areas, input.groupDeferredProjects === true),
            sections: projectSections.map((section) => ({ id: section.id, title: section.title })),
            areas: input.areas.filter((area) => !area.deletedAt).sort(compareAreasByOrder)
                .map((area) => ({ id: area.id, name: area.name, color: area.color ?? null })),
            contexts: [...input.contexts],
            tags: [...input.tags],
            people: getPersonOptionNames(input.people, input.tasks),
            somedaySections: getSomedaySectionChoices(
                somedayDefinitions,
                resolveTaskViewSection(draft, 'someday', somedayDefinitions)?.id,
                tFallback(t, 'viewSections.noSection', 'No section'),
            ).map((choice) => ({
                ...choice,
                viewSectionIds: setTaskViewSectionId(draft.viewSectionIds, 'someday', choice.id || undefined),
            })),
        },
        fields: {
            startTime: getTaskEditorDatePart('startTime', draft.startTime, dateOptions),
            dueDate: getTaskEditorDatePart('dueDate', draft.dueDate, dateOptions),
            reviewAt: getTaskEditorDatePart('reviewAt', draft.reviewAt, dateOptions),
            dateIssue: getTaskEditorDateIssueLabel(draft, t),
            relativeStart: getTaskEditorRelativeStart(draft, t),
            recurrence: {
                ...getTaskEditorRecurrenceDetails({ draft, task, dailyInterval, t, formatDate, now }),
                calendarPreviewHint: getTaskEditorRecurrenceCalendarPreviewHint({ draft, task, t, formatDate, now }),
                weekdays: getTaskEditorWeekdayButtons(
                    input.language,
                    getTaskDraftRecurrenceWeekdays(draft.recurrence, draft.recurrenceRRule),
                ),
                monthlyCustom: getTaskEditorMonthlyCustom(draft.recurrenceRRule, anchorDate),
            },
            reminders: getTaskEditorReminders(draft, t, input.settings),
            timeEstimate: getTaskEditorTimeEstimate(draft.timeEstimate, t),
            timeSpent: { enabled: isTaskEditorTimeSpentEnabled(input.settings) },
        },
    };
}
