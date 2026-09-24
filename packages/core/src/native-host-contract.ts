import { MAX_FOCUSED_PROJECTS } from './store-projects/project-actions';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, areaFilterSelectionToFilters, areaFilterSelectionToValue, cycleAreaFilterSelection, isAreaFilterSelectionActive, isTaskVisibleInArea, isTaskVisibleInInbox, resolveAreaFilterSelection, taskMatchesAreaFilterSelection, type AreaFilterSelection } from './area-filter';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { flushPendingSave, getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import { noopStorage, type StorageAdapter } from './storage';
import { resolveNonDoneTaskSortBy } from './task-list-sort-options';
import { getSequentialProjectTaskCues, isSelectableProjectForTaskAssignment, type ProjectSequenceTaskCue } from './project-utils';
import {
    buildProjectTaskListModel,
    getProjectDetailTaskListOptions,
    selectProjectTaskListTasks,
    type ProjectTaskListItem,
} from './project-task-list-model';
import { buildProjectGroups, type ProjectAreaGroup } from './project-grouping';
import { resolveTaskSortByForFeatures, sortTasksBy, splitTodayTasksByStartTime } from './task-utils';
import { isCustomTimeEstimate, TIME_ESTIMATE_OPTIONS } from './calendar-scheduling';
import { isRecurrenceRule, parseRRuleString } from './recurrence';
import { createTaskDraft, TASK_DRAFT_FIELD_KEYS, type TaskDraft, type TaskDraftField } from './task-draft';
import {
    applyTaskDraftPatch,
    buildTaskEditorModel,
    buildTaskEditUpdatePatch,
    clearInvalidTaskDraftSection,
    getTaskEditorSuggestions,
    TASK_EDITOR_ENERGY_LEVEL_OPTIONS,
    TASK_EDITOR_PRIORITY_OPTIONS,
    TASK_EDITOR_STATUS_OPTIONS,
    type TaskEditorModel,
    type TaskEditorSuggestions,
} from './task-editor-model';
import { normalizeRelativeStartOffset } from './task-relative-start';
import { computeGlobalSearchResults, type DuePreset, type GlobalSearchScope } from './global-search-filter';
import { clearGlobalSearchActiveChip, DEFAULT_GLOBAL_SEARCH_FILTERS, fetchGlobalSearchAdapterResults, getGlobalSearchActiveChips, getGlobalSearchFilterOptions, getGlobalSearchResultDate, getGlobalSearchTaskListTarget, resolveSavedSearch, GLOBAL_SEARCH_DUE_OPTIONS, GLOBAL_SEARCH_SCOPE_OPTIONS, GLOBAL_SEARCH_STATUS_OPTIONS, type GlobalSearchFilterState } from './global-search-model';
import type { SearchProjectResult } from './storage';
import { createSearchHighlighter } from './search-highlight';
import { createDateFormatter, hasTimeComponent, normalizeClockTimeInput, safeParseDate, type DateFormatter, type DateFormattingConfig } from './date';
import { WEEKDAY_ORDER } from './recurrence-constants';
import {
    editTaskDraftRecurrence,
    getTaskDraftDateEdit,
    getTaskDraftRecurrenceWeekdays,
    getTaskDraftRelativeStartEdit,
    getTaskEditorRecurrenceDefaultUntil,
    parseRecurrenceIntervalInput,
    parseTaskEditorTimeEstimate,
    parseTaskEditorTimeSpent,
    setTaskDraftDate,
    setTaskDraftTime,
    type TaskDraftRecurrenceEdit,
    type TaskEditorDateField,
    type TaskEditorMonthlyCustom,
} from './task-editor-schedule';
import { getProjectDeadlineBoostLabel } from './focus-grouping';
import { getProjectRowStatus } from './project-row-meta';
import { getFocusStarBlockedText } from './focus-star';
import { normalizeFocusTaskLimit } from './focus-utils';
import {
    buildFocusTaskSections,
    type FocusTaskSection,
    type FocusTaskSectionKey,
} from './focus-sections';
import {
    applyFocusControlEdit,
    buildFocusControlsModel,
    buildFocusNextItems,
    DEFAULT_FOCUS_CONTROL_STATE,
    type FocusControlEdit,
    type FocusControlsModel,
    type FocusControlState,
} from './focus-controls';
import { themeDescriptor } from './theme-scheme';
import { formatLocalDate } from './import-source-reader';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { isTaskCancelled, isTaskFinished } from './task-status';
import { buildTaskRowMeta, resolveTaskRowFeatures, resolveTaskRowLookup, type TaskRowMeta, type TaskRowMetaInput } from './task-row-meta';
import type { ProjectDeadlineBoost } from './task-utils';
import { getEnglishI18nValue, getTranslator, tFallback } from './i18n';
import { isSupportedLanguage } from './i18n/i18n-constants';
import { loadTranslations } from './i18n/i18n-loader';
import { resolveLanguageFromLocale } from './i18n/i18n-storage';
import type { Language } from './i18n/i18n-types';
import type { Area, Project, RecurrenceWeekday, RelativeStartOffsetUnit, Task, TaskPriority, TaskStatus, TimeEstimate } from './types';
import { generateUUID } from './uuid';
import { isCustomTimeEstimate as isCustomInboxTimeEstimate, TIME_ESTIMATE_OPTIONS as INBOX_TIME_ESTIMATES } from './calendar-scheduling';
import { resolveProcessInboxPlan } from './process-inbox-plan';
import {
    answerProcessInboxStep,
    applyProcessInboxDraftEdit,
    buildProcessInboxStepView,
    commitProcessInboxDecision,
    createProcessInboxDraft,
    createProcessInboxTitleParser,
    formatProcessInboxCommitMessage,
    formatProcessInboxProgressLabel,
    getProcessInboxProgress,
    getProcessInboxProjectChoices,
    INITIAL_PROCESS_INBOX_ANSWERS,
    PROCESS_INBOX_ENERGY_LEVEL_OPTIONS,
    PROCESS_INBOX_PRIORITY_OPTIONS,
    resolveProcessInboxProjectSearchSubmit,
    resolveProcessInboxStep,
    selectProcessInboxQueue,
    type ProcessInboxAnswers,
    type ProcessInboxDraft,
    type ProcessInboxDraftEdit,
    type ProcessInboxMode,
    type ProcessInboxNotice,
    type ProcessInboxStepView,
} from './process-inbox-model';
import {
    getProcessInboxCurrentCandidate,
    getProcessInboxRemainingCandidates,
    startProcessInboxSession,
    type ProcessInboxSession,
} from './process-inbox-session';
import { createTaskSimilarityIndex, type TaskSimilarityIndex } from './task-similarity';
// Contexts, Archive, Trash and History (the list views block at the end of this file).
import {
    ARCHIVE_SEGMENTS,
    ARCHIVE_TASK_GROUP_OPTIONS,
    buildArchiveTaskItems,
    filterArchivedTasksByArea,
    getArchiveCompletedAtPickerStart,
    getArchiveConfirmation,
    getArchivedProjectRow,
    getArchivedTaskRow,
    getArchiveEmptyState,
    getArchiveMenu,
    getArchiveRowLabels,
    getArchiveSegmentLabel,
    getArchiveSummary,
    getArchiveTokenFilterOptions,
    getHistoryTabs,
    getTaskGroupItemIds,
    moveArchivedTasksToInbox,
    moveArchivedTaskToInbox,
    reactivateArchivedProject,
    resolveArchiveSortBy,
    resolveHistoryTab,
    resolvePickedCompletedAt,
    selectArchivedProjects,
    selectArchivedTasks,
    setArchivedTaskCompletedAt,
    showArchiveSearch,
    sortArchivedTasks,
    type ArchiveMenu,
    type ArchiveSegment,
    type ArchiveTaskGroupBy,
    type HistoryTab,
} from './archive-view-model';
import type { BulkTaskTokenField, BulkTaskTokenMode } from './bulk-task-tokens';
import { createNativeRequestReceipts, runStoreWrite, settleWrite, type NativeUnsavedWrite } from './native-request-receipts';
import {
    buildContextsTokenIndex,
    buildContextsViewModel,
    CONTEXTS_BULK_STATUSES,
    editContextsTaskTokens,
    getContextsEmptyState,
    getContextsMatchModeLabels,
    getContextsTokenPicker,
    resolveContextsMatchMode,
    toggleContextsNoContext,
    toggleContextsToken,
    type ContextsTokenPicker,
} from './contexts-view-model';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import { applyListFilterEdit, resolveListFilterState, type ListFilterEdit, type ListFilterState } from './list-filter-state';
import type { ListFilterOptions } from './menu-views-model';
import { getProjectAccentColor } from './task-accent-color';
import { formatListItemCount } from './list-count';
import type { ContextOrTagMatchMode } from './hierarchy-utils';
import { getInlineMarkdownPreview } from './markdown';
import { taskMatchesFilterSelections } from './task-filter-selections';
import type { TaskGroupItem } from './task-group-sections';
import { DONE_TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import { getTaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import { buildTrashTimeline, resolveTrashClearScope } from './task-utils';
import {
    formatTrashCounts,
    formatTrashDeletedDate,
    getBulkTrashConfirmation,
    getTrashUndoLabel,
    getTrashEmptyState,
    getTrashPurgeConfirmation,
    getTrashRetentionHint,
    getTrashRowLabels,
    purgeTrashItems,
    restoreTrashItems,
    selectTrashedProjects,
    selectTrashedTasks,
    type ListConfirmation,
} from './trash-view-model';
import type { TaskSortBy } from './types';
import {
    createMenuViewMethods,
    isFilterEdit,
    matchesPickerQuery,
    nativeFilterView,
    paramsKey,
    readFilterState,
    tokenOptions,
    type NativeListChip,
    type NativeListFilterView,
    type NativeWindow,
    type TokenOption,
} from './native-host-contract-menu-views';
import { createReviewViewMethods } from './native-host-contract-review-views';
import { createQuickCaptureMethods } from './native-host-contract-quick-capture';
import { createCalendarViewMethods } from './native-host-contract-calendar';
import { createBoardViewMethods } from './native-host-contract-board';
import { createInboxViewMethods } from './native-host-contract-inbox-view';
import {
    buildNativeFocusControls,
    createFocusControlMethods,
    readNativeFocusControlEdit,
    readNativeFocusControls,
    type NativeFocusControls,
    type NativeFocusControlsInput,
} from './native-host-contract-focus-controls';

export const NATIVE_HOST_CONTRACT_VERSION = 1;
export const NATIVE_HOST_MAX_WINDOW = 100;
export const NATIVE_HOST_EDITOR_FIELDS = ['title', 'description', 'status', 'priority', 'projectId', 'startTime', 'dueDate'] as const;
export type NativeEditableFields = {
    title: string;
    description: string | null;
    status: TaskStatus;
    priority: TaskPriority | null;
    projectId: string | null;
    startTime: string | null;
    dueDate: string | null;
};
export type NativeTaskEditor = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    id: string;
    fields: NativeEditableFields;
    projects: Array<Pick<Project, 'id' | 'title'>>;
    readOnly: boolean;
    statuses: TaskStatus[];
    priorities: TaskPriority[];
};

/**
 * The React Native task editor for one task: its draft, the fields to show by
 * section, and the lists each field picks from. Labels are string keys, except
 * time estimates, which are formatted in the host language.
 */
export type NativeTaskEditorModel = TaskEditorModel & {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    id: string;
    readOnly: boolean;
    /** createTaskDraft(task). Fields whose value is undefined are absent over JSON. */
    draft: TaskDraft;
};

const CAPTURE_ID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;
const EDITOR_FIELD_SET = new Set<string>(NATIVE_HOST_EDITOR_FIELDS);
const EDITOR_STATUSES = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done'] as const satisfies readonly TaskStatus[];
const EDITOR_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const satisfies readonly TaskPriority[];
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EDITOR_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)?$/;

export type NativeHostErrorCode = 'NOT_READY' | 'INVALID_INPUT' | 'STALE_REVISION' | 'TASK_NOT_FOUND' | 'ACTION_FAILED' | 'SAVE_FAILED';
export type NativeHostResult<T> = { ok: true; value: T } | {
    ok: false;
    error: { code: NativeHostErrorCode; message: string };
};

export type NativeTaskRow = Pick<Task, 'id' | 'title' | 'status'> & {
    priority: Task['priority'] | null;
    dueDate: string | null;
    startTime: string | null;
    isFocusedToday: boolean;
    projectTitle: string | null;
    hasNotes: boolean;
    revealDate: string | null;
    revealLabel: string | null;
    laterToday: boolean;
    /**
     * The React Native row's labels and meta line, formatted with the user's date
     * settings and language. Render `meta.parts` in order. Inbox and project detail
     * hide detail parts, the age and the description (mobile lists always do);
     * Focus shows them only with its details toggle on (off by default).
     */
    meta: TaskRowMeta;
};
export type NativeInboxRow = NativeTaskRow;
export type NativeInboxWindow = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    /** Opaque within this host instance; send it back on later pages. */
    revision: string;
    total: number;
    rows: NativeInboxRow[];
};
export type NativeSearchView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    query: string;
    tasks: (Omit<NativeTaskRow, 'meta'> & {
        inStore: boolean;
        cancelled: boolean;
        meta: TaskRowMeta | null;
        date: ReturnType<typeof getGlobalSearchResultDate>;
        titleSegments: ReturnType<ReturnType<typeof createSearchHighlighter>>;
        canComplete: boolean;
        tap: { kind: 'editor'; id: string } | { kind: 'list'; route: string; id: string; projectId: string | null };
    })[];
    totalTasks: number;
    projects: (Pick<SearchProjectResult, 'id' | 'title' | 'status' | 'cancelledAt' | 'areaId'> & {
        titleSegments: ReturnType<ReturnType<typeof createSearchHighlighter>>;
    })[];
    defaultFilters: GlobalSearchFilterState;
    activeChips: (ReturnType<typeof getGlobalSearchActiveChips>[number] & { clearedFilters: GlobalSearchFilterState })[];
    hiddenCompletedCount: number;
    hasActiveFilters: boolean;
    isTruncated: boolean;
    totalResultsLabel: string;
    filterOptions: ReturnType<typeof getGlobalSearchFilterOptions>;
};
export type NativeFocusSection = {
    key: FocusTaskSectionKey;
    title: string;
    /** The header count: the section's tasks. */
    total: number;
    rows: NativeTaskRow[];
    focusBlockedLabel: string | null;
    /**
     * Only on a read that sends `controls`. The rows to page through: `total`, except
     * that under a grouping a task in two groups is listed twice. A read without
     * `controls` keeps the flat rows it always had: each task once, never grouped.
     */
    rowTotal?: number;
    /**
     * Only on a read that sends `controls`. Next actions under a grouping
     * (controls.view.group): RN's group headings, each drawn before the row at `start`
     * (an index into the section's rows, so a heading belongs to the window that holds
     * that row). Rows under a heading are indented. Null for other sections and
     * without a grouping.
     */
    groups?: NativeFocusGroup[] | null;
};
export type NativeFocusGroup = { id: string; title: string; count: number; muted: boolean; dotColor: string | null; start: number };
type CachedFocusSection = FocusTaskSection & { total: number; groups: NativeFocusGroup[] | null };
export type NativeFocusView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    dateLabel: string;
    /** Mobile hides a section whose total is 0: no header, no rows. */
    sections: NativeFocusSection[];
    /**
     * "Projects to review" (string key agenda.reviewDueProjects), shown after the
     * task sections and hidden when empty; its header count is this length.
     */
    reviewProjects: NativeReviewProjectRow[];
    /** The filter sheet, saved filters, View options and reorder, for the control state read (native-host-contract-focus-controls.ts). */
    controls: NativeFocusControls;
};
export type NativeProjectRow = Pick<Project, 'id' | 'title' | 'status'> & {
    cancelled: boolean;
    statusLabel: string;
    isFocused: boolean;
    focusDisabled: boolean;
    color: string | null;
    activeTaskCount: number;
    nextActionId: string | null;
    nextActionTitle: string | null;
    focusedWithoutNextAction: boolean;
};
export type NativeReviewProjectRow = NativeProjectRow & {
    /** The review date, formatted like the mobile Focus row. */
    reviewDateLabel: string | null;
};
export type NativeProjectGroup = {
    areaId: string | null;
    areaName: string | null;
    areaColor: string | null;
    areaIcon: string | null;
    projects: NativeProjectRow[];
};
export type NativeProjectsView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    active: NativeProjectGroup[];
    deferred: NativeProjectGroup[];
    archived: NativeProjectGroup[];
};

export type NativeProjectDetailItem =
    | { type: 'section'; id: string; title: string; count: number; muted: boolean }
    /** sectionId: the project section the row is filed under as shown (null = no section, Completed, or Reference). */
    | { type: 'task'; row: NativeTaskRow; sectionId: string | null; sequenceCue: ProjectSequenceTaskCue | null };
export type NativeProjectDetail = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    projectId: string;
    readOnly: boolean;
    total: number;
    items: NativeProjectDetailItem[];
};
type ProjectDetailCache = {
    readOnly: boolean;
    items: ProjectTaskListItem[];
    cues: Map<string, ProjectSequenceTaskCue>;
    projectTitles: Map<string, string>;
};

export const sortAreasForDisplay = (areas: Area[]): Area[] => [...areas]
    .filter((area) => !area.deletedAt)
    .sort((a, b) => a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name));

// The per-row view options mobile passes to the row.
type RowMetaOptions = Omit<TaskRowMetaInput, 'task' | 'lookup' | 'features' | 'language' | 'dateFormatting' | 't' | 'now'>;

const toNativeTaskRow = (task: Task, projectTitles: Map<string, string>, meta: TaskRowMeta): NativeTaskRow => ({
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority ?? null,
    dueDate: task.dueDate ?? null,
    startTime: task.startTime ?? null,
    isFocusedToday: task.isFocusedToday === true,
    projectTitle: task.projectId ? projectTitles.get(task.projectId) ?? null : null,
    hasNotes: typeof task.description === 'string' && task.description.length > 0,
    revealDate: null,
    revealLabel: null,
    laterToday: false,
    meta,
});

const toNativeProjectRow = (
    project: Project,
    summaries: ReturnType<ReturnType<typeof useTaskStore.getState>['getDerivedState']>['projectTaskSummaryById'],
    focusedProjectCount: number,
    t: (key: string) => string,
): NativeProjectRow => {
    const summary = summaries.get(project.id);
    const nextAction = summary?.nextAction;
    const activeTaskCount = summary?.activeTaskCount ?? 0;
    const isFocused = project.isFocused === true;
    return {
        id: project.id,
        title: project.title,
        status: project.status,
        ...getProjectRowStatus(project, t),
        isFocused,
        focusDisabled: !isFocused && focusedProjectCount >= MAX_FOCUSED_PROJECTS,
        color: project.color ?? null,
        activeTaskCount,
        nextActionId: nextAction?.id ?? null,
        nextActionTitle: nextAction?.title ?? null,
        focusedWithoutNextAction: isFocused && !nextAction && activeTaskCount > 0,
    };
};

const fail = (code: NativeHostErrorCode, message: string): NativeHostResult<never> => ({
    ok: false,
    error: { code, message },
});
const hasLoadError = (message: string | null): boolean => (
    message?.startsWith('Failed to fetch data') === true || message === 'Storage request timed out. Try again.'
);
const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);
const GLOBAL_SEARCH_FILTER_KEYS = new Set(['includeCompleted', 'includeReference', 'hideFutureTasks', 'selectedStatuses', 'selectedArea', 'selectedTokens', 'locationQuery', 'duePreset', 'scope']);
const isGlobalSearchFilterState = (value: unknown): value is GlobalSearchFilterState => (
    isObjectRecord(value)
    && Object.keys(value).every((key) => GLOBAL_SEARCH_FILTER_KEYS.has(key))
    && typeof value.includeCompleted === 'boolean'
    && typeof value.includeReference === 'boolean'
    && typeof value.hideFutureTasks === 'boolean'
    && Array.isArray(value.selectedStatuses)
    && value.selectedStatuses.every((status) => GLOBAL_SEARCH_STATUS_OPTIONS.includes(status))
    && typeof value.selectedArea === 'string'
    && Array.isArray(value.selectedTokens)
    && value.selectedTokens.length <= 500
    && value.selectedTokens.every((token) => typeof token === 'string')
    && (value.locationQuery === undefined || (typeof value.locationQuery === 'string' && value.locationQuery.length <= 2000))
    && GLOBAL_SEARCH_DUE_OPTIONS.includes(value.duePreset as DuePreset)
    && GLOBAL_SEARCH_SCOPE_OPTIONS.includes(value.scope as GlobalSearchScope)
);
const isValidEditorDate = (value: unknown): value is string => (
    typeof value === 'string'
    && safeParseDate(value) !== null
    && (DATE_ONLY_PATTERN.test(value) || (EDITOR_DATETIME_PATTERN.test(value) && hasTimeComponent(value)))
);
const normalizeEditorValue = (field: keyof NativeEditableFields, value: unknown): unknown => (
    value == null || (field === 'description' && value === '') ? null : value
);

const DRAFT_FIELD_SET = new Set<string>(TASK_DRAFT_FIELD_KEYS);
// JSON has no undefined: these draft fields accept null for "not set".
const UNSET_DRAFT_FIELDS = new Set<string>(['relativeStartOffset', 'viewSectionIds', 'timeSpentMinutes', 'repeatReminderMinutes']);
const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isDraftDate = (value: unknown) => value === '' || isValidEditorDate(value);
const isUnsetOrMinutes = (value: unknown) => value === undefined
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const isOneOf = (values: readonly unknown[]) => (value: unknown) => values.includes(value);
// The value shapes TaskDraft holds; ids are checked against the store at save.
const DRAFT_VALUE_CHECKS: Record<TaskDraftField, (value: unknown) => boolean> = {
    title: isString,
    dueDate: isDraftDate,
    startTime: isDraftDate,
    relativeStartOffset: (value) => value === undefined || normalizeRelativeStartOffset(value) !== undefined,
    projectId: isString,
    sectionId: isString,
    viewSectionIds: (value) => value === undefined || (isObjectRecord(value) && Object.values(value).every(isString)),
    areaId: isString,
    completedAt: isDraftDate,
    status: isOneOf(TASK_EDITOR_STATUS_OPTIONS),
    focusedToday: isBoolean,
    contexts: isString,
    tags: isString,
    description: isString,
    location: isString,
    recurrence: (value) => value === '' || (isString(value) && isRecurrenceRule(value)),
    recurrenceStrategy: isOneOf(['strict', 'fluid']),
    recurrenceRRule: (value) => value === '' || (isString(value) && parseRRuleString(value).rule !== undefined),
    showFutureRecurrence: isBoolean,
    timeEstimate: (value) => value === '' || TIME_ESTIMATE_OPTIONS.includes(value as TimeEstimate)
        || (isString(value) && isCustomTimeEstimate(value as TimeEstimate)),
    timeSpentMinutes: isUnsetOrMinutes,
    priority: isOneOf(['', ...TASK_EDITOR_PRIORITY_OPTIONS]),
    energyLevel: isOneOf(['', ...TASK_EDITOR_ENERGY_LEVEL_OPTIONS]),
    assignedTo: isString,
    reviewAt: isDraftDate,
    repeatReminderMinutes: isUnsetOrMinutes,
    suppressMindwtrReminders: isBoolean,
};
const toDraftValues = (input: Record<string, unknown>): Partial<TaskDraft> => Object.fromEntries(
    Object.entries(input).map(([field, value]) => [field, value === null && UNSET_DRAFT_FIELDS.has(field) ? undefined : value]),
) as Partial<TaskDraft>;
const isSameDraftValue = (left: unknown, right: unknown): boolean => (
    left === right || JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
);

// ---------------------------------------------------------------------------
// Editor draft edits: the React Native editor's date, recurrence and estimate
// controls, applied to a host's unsaved draft (editTaskDraft).

/**
 * One editor control's edit. Values are draft strings. The model supplies the value
 * each date control writes (quick chips, Date only, clear as ''): send it as `date`.
 */
export type NativeTaskDraftEdit =
    /** Plain field values, through the draft's cascades (status, star, due date moving a relative start). */
    | { type: 'fields'; patch: Partial<TaskDraft> }
    | { type: 'date'; field: TaskEditorDateField; value: string }
    /** A day from the date picker, yyyy-MM-dd: an existing time is kept, else the default schedule time is added. */
    | { type: 'pickDate'; field: TaskEditorDateField; date: string }
    /** A time from the time picker, HH:mm, on the field's day (today when unset). */
    | { type: 'pickTime'; field: 'startTime' | 'dueDate'; time: string }
    /** "Start N units before due"; `amount` as typed. */
    | { type: 'relativeStart'; amount: number | string; unit: RelativeStartOffsetUnit }
    | { type: 'recurrence'; edit: NativeTaskDraftRecurrenceEdit }
    /** The Custom… estimate input as typed; text that does not parse leaves the estimate. */
    | { type: 'timeEstimate'; text: string }
    /** The Time Spent input as typed. */
    | { type: 'timeSpent'; text: string };

export type NativeTaskDraftRecurrenceEdit =
    | Exclude<TaskDraftRecurrenceEdit, { kind: 'interval' } | { kind: 'weekdays' }>
    /** "Repeat every" as typed. */
    | { kind: 'interval'; text: string }
    /** A weekly day button: turns that day on or off. */
    | { kind: 'weekday'; day: RecurrenceWeekday };

const EDITOR_DATE_FIELDS: readonly string[] = ['startTime', 'dueDate', 'reviewAt'];
const RELATIVE_START_UNITS: readonly string[] = ['minute', 'hour', 'day', 'week'];
const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const isEditorDay = (value: unknown): value is string => (
    typeof value === 'string' && DATE_ONLY_PATTERN.test(value) && safeParseDate(value) !== null
);
const isInputText = (value: unknown): value is string => typeof value === 'string' && value.length <= 200;
const isMonthlyCustom = (value: unknown): value is TaskEditorMonthlyCustom => (
    isObjectRecord(value)
    && Number.isSafeInteger(value.interval) && (value.interval as number) >= 1 && (value.interval as number) <= 999
    && isOneOf(['date', 'nth', 'lastDay'])(value.mode)
    && isOneOf(['1', '2', '3', '4', '-1'])(value.ordinal)
    && (isOneOf(WEEKDAY_ORDER)(value.weekday) || value.weekday === 'WEEKDAY')
    && Array.isArray(value.monthDays) && value.monthDays.length <= 32
    && value.monthDays.every((day) => Number.isSafeInteger(day) && (day === -1 || (day >= 1 && day <= 31)))
);

/** A whole draft from a host: every field present and valid (JSON drops unset fields, or sends null). */
const readTaskDraft = (value: unknown): TaskDraft | null => {
    if (!isObjectRecord(value) || Object.keys(value).some((field) => !DRAFT_FIELD_SET.has(field))) return null;
    const draft = toDraftValues(value) as TaskDraft;
    return TASK_DRAFT_FIELD_KEYS.every((field) => (
        (Object.prototype.hasOwnProperty.call(value, field) || UNSET_DRAFT_FIELDS.has(field))
        && DRAFT_VALUE_CHECKS[field](draft[field])
    )) ? draft : null;
};

const readRecurrenceEdit = (value: unknown, draft: TaskDraft): TaskDraftRecurrenceEdit | null => {
    if (!isObjectRecord(value)) return null;
    switch (value.kind) {
        case 'rule':
            return value.rule === '' || (isString(value.rule) && isRecurrenceRule(value.rule))
                ? { kind: 'rule', rule: value.rule as TaskDraft['recurrence'] }
                : null;
        case 'interval':
            return isInputText(value.text) ? { kind: 'interval', interval: parseRecurrenceIntervalInput(value.text) ?? 1 } : null;
        case 'weekday': {
            if (!isOneOf(WEEKDAY_ORDER)(value.day)) return null;
            const day = value.day as RecurrenceWeekday;
            const weekdays = getTaskDraftRecurrenceWeekdays(draft.recurrence, draft.recurrenceRRule);
            return {
                kind: 'weekdays',
                weekdays: weekdays.includes(day) ? weekdays.filter((entry) => entry !== day) : [...weekdays, day],
            };
        }
        case 'monthlyOnDay':
        case 'strategy':
            return { kind: value.kind };
        case 'ends':
            return isOneOf(['never', 'until', 'count'])(value.ends) ? { kind: 'ends', ends: value.ends as 'never' | 'until' | 'count' } : null;
        case 'count':
            return isInputText(value.text) ? { kind: 'count', text: value.text } : null;
        case 'until':
            return isEditorDay(value.date) ? { kind: 'until', date: value.date } : null;
        case 'monthlyCustom':
            return isMonthlyCustom(value.custom) ? { kind: 'monthlyCustom', custom: value.custom } : null;
        default:
            return null;
    }
};

/** The draft after one control's edit, as the React Native editor applies it; null for an invalid edit. */
const applyNativeTaskDraftEdit = (
    draft: TaskDraft,
    edit: unknown,
    context: { task: Task; now: Date; formatDate: DateFormatter; defaultScheduleTime: string },
): TaskDraft | null => {
    if (!isObjectRecord(edit)) return null;
    const withPatch = (patch: Partial<TaskDraft> | null) => (patch ? applyTaskDraftPatch(draft, patch) : draft);
    const field = edit.field as TaskEditorDateField;
    switch (edit.type) {
        case 'fields': {
            if (!isObjectRecord(edit.patch)) return null;
            const fields = Object.keys(edit.patch) as TaskDraftField[];
            if (fields.some((key) => !DRAFT_FIELD_SET.has(key))) return null;
            const patch = toDraftValues(edit.patch);
            return fields.every((key) => DRAFT_VALUE_CHECKS[key](patch[key])) ? applyTaskDraftPatch(draft, patch) : null;
        }
        case 'date':
            if (!EDITOR_DATE_FIELDS.includes(field) || !isDraftDate(edit.value)) return null;
            return withPatch(getTaskDraftDateEdit(field, edit.value as string));
        case 'pickDate': {
            if (!EDITOR_DATE_FIELDS.includes(field) || !isEditorDay(edit.date)) return null;
            const value = setTaskDraftDate(field, draft[field], safeParseDate(edit.date) as Date, context);
            return withPatch(getTaskDraftDateEdit(field, value));
        }
        case 'pickTime': {
            // The React Native editor has no review time: its review field offers a date only.
            if ((field !== 'startTime' && field !== 'dueDate') || typeof edit.time !== 'string' || !CLOCK_TIME_PATTERN.test(edit.time)) return null;
            const [hours, minutes] = edit.time.split(':').map(Number);
            return withPatch(getTaskDraftDateEdit(field, setTaskDraftTime(draft[field], { hours, minutes }, null, context.now)));
        }
        case 'relativeStart': {
            if (!RELATIVE_START_UNITS.includes(edit.unit as string)
                || !(typeof edit.amount === 'number' || isInputText(edit.amount))) return null;
            const patch = getTaskDraftRelativeStartEdit(draft.dueDate, Number(edit.amount), edit.unit as RelativeStartOffsetUnit);
            // An offset the store would not accept (more than 10,000 units) is refused, not written.
            if (patch?.relativeStartOffset && !normalizeRelativeStartOffset(patch.relativeStartOffset)) return null;
            return withPatch(patch);
        }
        case 'recurrence': {
            const recurrenceEdit = readRecurrenceEdit(edit.edit, draft);
            if (!recurrenceEdit) return null;
            return withPatch(editTaskDraftRecurrence(draft, recurrenceEdit, {
                weekdays: getTaskDraftRecurrenceWeekdays(draft.recurrence, draft.recurrenceRRule),
                defaultUntil: getTaskEditorRecurrenceDefaultUntil(draft, context.task, context.formatDate, context.now),
            }));
        }
        case 'timeEstimate': {
            if (!isInputText(edit.text)) return null;
            const timeEstimate = parseTaskEditorTimeEstimate(edit.text);
            return withPatch(timeEstimate === null ? null : { timeEstimate });
        }
        case 'timeSpent':
            return isInputText(edit.text) ? withPatch({ timeSpentMinutes: parseTaskEditorTimeSpent(edit.text) }) : null;
        default:
            return null;
    }
};

/** One instance per serial native JS host. All reads and commands use the shared store. */
export function createNativeHostContract() {
    const processId = generateUUID();
    let language: Language = 'en';
    let systemLocale: string | null = null;
    let translate = getTranslator(language);
    let readyAdapter: StorageAdapter | null = null;
    let generation = 0;
    let lastTasks = useTaskStore.getState()._allTasks;
    let lastProjects = useTaskStore.getState()._allProjects;
    let lastSections = useTaskStore.getState()._allSections;
    let lastAreas = useTaskStore.getState()._allAreas;
    let lastPeople = useTaskStore.getState()._allPeople;
    let lastSortBy = resolveNonDoneTaskSortBy(useTaskStore.getState().settings.taskSortBy, useTaskStore.getState().settings);
    let lastSettings = useTaskStore.getState().settings;
    let settingsGeneration = 0;
    let cachedRevision = '';
    let cachedInbox: Task[] = [];
    let cachedProjectTitles = new Map<string, string>();
    let cachedFocusKey = '';
    let cachedFocusSections: CachedFocusSection[] = [];
    let cachedFocusModel: FocusControlsModel | null = null;
    let cachedFocusProjectTitles = new Map<string, string>();
    let cachedRevealDates = new Map<string, Date>();
    let cachedLaterTodayIds = new Set<string>();
    let cachedDeadlineBoosts = new Map<string, ProjectDeadlineBoost>();
    let cachedReviewProjects: Project[] = [];
    let cachedProjectsRevision = '';
    let cachedProjects: NativeProjectsView | null = null;
    let cachedProjectDetailKey = '';
    let cachedProjectDetail: ProjectDetailCache | null = null;
    // ponytail: title/area dedupe survives process death, but a renamed, moved, archived, or deleted project can be recreated; persist a capture ID if those retries become required.
    const createdProjects = new Map<string, string>();
    // Per task, the last draft save the store accepted and the task it produced. The
    // same request against that same task is a retry: the store may have rewritten
    // fields it saved (a recurrence's series stamp, a deferred star), so the field
    // comparison alone cannot recognise it. Any other write to the task replaces its
    // object, which ends the entry.
    // ponytail: keeps the 50 most recently saved tasks; an older task's retry falls back to the field comparison.
    const draftSaves = new Map<string, { key: string; task: Task | undefined }>();
    // ponytail: keep 50 request IDs; an older retry falls back to the saved-query match.
    const savedSearchRequests = new Map<string, { query: string; name: string; id: string }>();
    useTaskStore.subscribe((state) => {
        if (hasLoadError(state.error)) readyAdapter = null;
    });

    const readiness = (): NativeHostResult<null> => {
        const state = useTaskStore.getState();
        if (readyAdapter && (getStorageAdapter() !== readyAdapter || hasLoadError(state.error))) readyAdapter = null;
        if (!readyAdapter || readyAdapter === noopStorage || state.isLoading) {
            return fail('NOT_READY', 'Native storage has not been loaded and validated');
        }
        return { ok: true, value: null };
    };

    const revision = () => {
        const state = useTaskStore.getState();
        const sortBy = resolveNonDoneTaskSortBy(state.settings.taskSortBy, state.settings);
        if (state._allTasks !== lastTasks || state._allProjects !== lastProjects
            || state._allSections !== lastSections || state._allAreas !== lastAreas
            || state._allPeople !== lastPeople || sortBy !== lastSortBy) {
            generation += 1;
            lastTasks = state._allTasks;
            lastProjects = state._allProjects;
            lastSections = state._allSections;
            lastAreas = state._allAreas;
            lastPeople = state._allPeople;
            lastSortBy = sortBy;
        }
        return `${processId}:${generation}`;
    };

    const settingsRevision = () => {
        const settings = useTaskStore.getState().settings;
        if (settings !== lastSettings) {
            settingsGeneration += 1;
            lastSettings = settings;
        }
        return settingsGeneration;
    };

    // Row labels read the date settings (the settings generation), the language
    // and locale, and the clock: urgency tones cross thresholds within a day.
    const displayRevision = (now: Date) => (
        `${settingsRevision()}:${language}:${systemLocale ?? ''}:${formatLocalDate(now)}:${Math.floor(now.getTime() / 60_000)}`
    );

    const focusRevision = (now: Date) => `${revision()}:${displayRevision(now)}`;

    // The configuration mobile's root layout applies to its dates.
    const dateFormatting = (): DateFormattingConfig => {
        const settings = useTaskStore.getState().settings;
        return {
            language: settings.language || language,
            dateFormat: settings.dateFormat,
            calendarSystem: settings.calendarSystem,
            timeFormat: settings.timeFormat,
            systemLocale,
        };
    };

    const rowMeta = (task: Task, now: Date, options: RowMetaOptions = {}): TaskRowMeta => {
        const state = useTaskStore.getState();
        return buildTaskRowMeta({
            ...options,
            task,
            lookup: resolveTaskRowLookup(task, state.projects, state.areas, state._sectionsById),
            features: resolveTaskRowFeatures(state.settings),
            language,
            dateFormatting: dateFormatting(),
            t: translate,
            now,
        });
    };

    // The RN Focus screen's pass for a control state (focus-controls.ts): area-visible
    // actionable tasks, the state's criteria, sort and grouping, then buildFocusPools
    // and deriveFocusTaskLists. Cached per revision and state. `null` is a read without
    // `controls`: the default state, and Next actions stays flat whatever grouping is
    // stored, as it was before controls existed (a caller keying rows by task ID must
    // never see a task twice).
    const focusSections = (currentRevision: string, now: Date, controls: FocusControlState | null): CachedFocusSection[] => {
        const key = `${currentRevision}\u0000${controls ? paramsKey(controls) : 'flat'}`;
        if (cachedFocusKey !== key) {
            const state = useTaskStore.getState();
            const formatDate = createDateFormatter(dateFormatting());
            const model = buildFocusControlsModel({
                state: controls ?? DEFAULT_FOCUS_CONTROL_STATE,
                tasks: state.tasks,
                projects: state.projects,
                areas: state.areas,
                sections: state.sections,
                settings: state.settings,
                now,
                t: translate,
                formatDate: (value) => formatDate(value, 'P', value),
            });
            const { lists } = model;
            const groupBy = controls ? model.perspective.effectiveGroupBy : 'none';
            const schedule = splitTodayTasksByStartTime(lists.schedule, now);
            cachedDeadlineBoosts = lists.projectDeadlineBoosts;
            cachedReviewProjects = model.reviewProjects;
            cachedLaterTodayIds = new Set(schedule.laterToday.map((task) => task.id));
            cachedFocusSections = buildFocusTaskSections(lists, (key) => {
                const value = translate(key);
                return value === key ? undefined : value;
            }).map((section): CachedFocusSection => {
                if (section.key === 'schedule') {
                    return { ...section, items: [...schedule.ready, ...schedule.laterToday], total: section.items.length, groups: null };
                }
                if (section.key !== 'next' || groupBy === 'none') return { ...section, total: section.items.length, groups: null };
                const items: Task[] = [];
                const groups: NativeFocusGroup[] = [];
                for (const item of buildFocusNextItems({
                    groupBy,
                    tasks: section.items,
                    projects: state.projects,
                    areas: state.areas,
                    t: translate,
                    // RN's theme preset, for the context and tag swatches.
                    theme: themeDescriptor(state.settings.theme)?.statusPreset ?? 'default',
                })) {
                    if (item.type === 'task') items.push(item.task);
                    else groups.push({ id: item.id, title: item.title, count: item.count, muted: item.muted === true, dotColor: item.dotColor ?? null, start: items.length });
                }
                return { ...section, items, total: section.items.length, groups };
            });
            cachedFocusProjectTitles = new Map(state.projects.map((project) => [project.id, project.title]));
            cachedRevealDates = new Map(model.pools.upcoming.map(({ task, appearsAt }) => [task.id, appearsAt]));
            cachedFocusModel = model;
            cachedFocusKey = key;
        }
        return cachedFocusSections;
    };

    /**
     * The Focus model for a control state (null: a read without `controls`), and the
     * revision a Focus read answers under. A read without `controls` keeps the plain
     * Focus revision it always had.
     */
    const focusModel = (controls: FocusControlState | null, now: Date): { model: FocusControlsModel; revision: string } => {
        const currentRevision = focusRevision(now);
        focusSections(currentRevision, now, controls);
        const model = cachedFocusModel as FocusControlsModel;
        return { model, revision: controls ? `${currentRevision}:${paramsKey(model.filter.state)}` : currentRevision };
    };

    /**
     * The control state a Focus read asks for: the host's state after its control edit;
     * `controls: null` for a read that sends neither; null when invalid.
     */
    const readFocusControls = (input: { controls?: unknown; controlEdit?: unknown }, now: Date): { controls: FocusControlState | null } | null => {
        if (input.controls === undefined && input.controlEdit === undefined) return { controls: null };
        const controls = readNativeFocusControls(input.controls);
        if (!controls) return null;
        if (input.controlEdit === undefined) return { controls };
        const edit = readNativeFocusControlEdit(input.controlEdit);
        if (!edit) return null;
        const { model } = focusModel(controls, now);
        const next = applyFocusControlEdit({
            state: model.filter.state,
            activeSavedFilter: model.filter.activeSavedFilter,
            effectiveSortBy: model.perspective.effectiveSortBy,
        }, edit, model.savedFilters);
        return next ? { controls: next } : null;
    };

    // A heading belongs to the window holding the row it precedes.
    const windowGroups = (section: CachedFocusSection, offset: number, limit: number) => (
        section.groups?.filter(({ start }) => start >= offset && start < offset + limit) ?? null
    );

    const focusRows = (section: CachedFocusSection, offset: number, limit: number, now: Date): NativeTaskRow[] => {
        const formatDate = createDateFormatter(dateFormatting());
        return section.items.slice(offset, offset + limit).map((task) => {
            const appearsAt = section.key === 'upcoming' ? cachedRevealDates.get(task.id) : undefined;
            return {
                ...toNativeTaskRow(task, cachedFocusProjectTitles, rowMeta(task, now, {
                    projectDeadlineLabel: getProjectDeadlineBoostLabel(
                        cachedDeadlineBoosts.get(task.id),
                        (key, fallback) => tFallback(translate, key, fallback),
                    ),
                })),
                revealDate: appearsAt ? formatLocalDate(appearsAt) : null,
                revealLabel: appearsAt ? formatDate(appearsAt, 'P') : null,
                laterToday: section.key === 'schedule' && cachedLaterTodayIds.has(task.id),
            };
        });
    };

    // The mobile project workspace as it opens: the project's saved sort, no
    // search, Show completed off, nothing collapsed. RN TaskList filters its
    // project rows by area, including completed and reference tasks.
    const projectDetail = (projectId: string, currentRevision: string): ProjectDetailCache | null => {
        const key = `${currentRevision}\u0000${projectId}`;
        if (cachedProjectDetailKey === key && cachedProjectDetail) return cachedProjectDetail;
        const state = useTaskStore.getState();
        const project = state._allProjects.find((candidate) => candidate.id === projectId);
        if (!project || project.deletedAt) return null;
        const options = getProjectDetailTaskListOptions(project);
        // Mobile: ProjectDetailModal resolves the saved sort for features (it gates
        // the cues); TaskList then resolves that for the all-status list.
        const projectSortBy = resolveTaskSortByForFeatures(project.taskSortBy ?? 'default', state.settings);
        const projectTasks = state._allTasks.filter((task) => task.projectId === project.id && !task.deletedAt);
        const areaById = new Map(sortAreasForDisplay(state.areas).map((area) => [area.id, area]));
        const selection = resolveAreaFilterSelection(state.settings.filters, state.areas);
        const model = buildProjectTaskListModel({
            project,
            tasks: selectProjectTaskListTasks(projectTasks, {
                projectId: project.id,
                statusFilter: 'all',
                includeArchived: options.includeArchived,
                includeDone: options.includeDone,
                isVisible: (task) => taskMatchesAreaFilterSelection(task, selection, state._projectsById, areaById),
            }),
            visibleTasks: state.tasks,
            sections: state.sections,
            allSections: state._allSections,
            statusFilter: 'all',
            criteria: {},
            searchQuery: '',
            sortBy: resolveNonDoneTaskSortBy(projectSortBy, state.settings),
            projectOrder: options.enableProjectReorder,
            reorderMode: false,
            groupCompletedTasksLast: options.groupCompletedTasksLast,
            completedCollapsed: false,
            t: translate,
        });
        cachedProjectDetail = {
            readOnly: options.readOnly,
            items: model.items,
            // Same input as mobile's ProjectDetailModal: the project's tasks in store order.
            cues: projectSortBy === 'default' ? getSequentialProjectTaskCues(project, projectTasks) : new Map(),
            projectTitles: new Map(state.projects.map((candidate) => [candidate.id, candidate.title])),
        };
        cachedProjectDetailKey = key;
        return cachedProjectDetail;
    };

    const save = async (): Promise<NativeHostResult<null>> => {
        const before = readiness();
        if (!before.ok) return before;
        try {
            await flushPendingSave();
            const after = readiness();
            if (!after.ok) return after;
            const failure = useTaskStore.getState().persistenceFailure;
            if (failure) return fail('SAVE_FAILED', failure.message);
            return { ok: true, value: null };
        } catch (error) {
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
    };

    // Mobile opens a task in an archived project read-only.
    const isInArchivedProject = (task: Task): boolean => Boolean(task.projectId)
        && useTaskStore.getState()._allProjects.find((project) => project.id === task.projectId)?.status === 'archived';

    // The editor model reads the task, its containers, people, settings and language; the
    // day and minute ride along in the revision as in the other views.
    const taskEditorModel = (task: Task, draft: TaskDraft, now: Date): NativeTaskEditorModel => {
        const state = useTaskStore.getState();
        const { allContexts, allTags } = state.getDerivedState();
        return {
            version: NATIVE_HOST_CONTRACT_VERSION,
            revision: `${revision()}:${displayRevision(now)}`,
            id: task.id,
            readOnly: isInArchivedProject(task),
            draft,
            ...buildTaskEditorModel({
                task,
                draft,
                settings: state.settings,
                projects: state.projects,
                sections: state.sections,
                areas: state.areas,
                tasks: state.tasks,
                people: state.people,
                contexts: allContexts,
                tags: allTags,
                t: translate,
                now,
                formatDate: createDateFormatter(dateFormatting()),
                language,
            }),
        };
    };

    return {
        version: NATIVE_HOST_CONTRACT_VERSION,
        ...createInboxProcessingMethods({
            readiness, save, t: () => translate, formatDate: () => createDateFormatter(dateFormatting()),
            revision: (now) => `${revision()}:${displayRevision(now)}`,
        }),
        ...createListViewMethods({
            readiness, save, t: () => translate, formatDate: () => createDateFormatter(dateFormatting()),
            revision: (now) => `${revision()}:${displayRevision(now)}`,
            dataRevision: () => `${revision()}:${settingsRevision()}`,
            rowMeta: (task, now) => rowMeta(task, now),
        }),
        // More sheet, Waiting, Someday, Reference and Done: native-host-contract-menu-views.ts.
        ...createMenuViewMethods({
            readiness,
            save,
            t: () => translate,
            formatDate: () => createDateFormatter(dateFormatting()),
            revision: (now) => `${revision()}:${displayRevision(now)}`,
            rows: (tasks, now) => {
                const titles = new Map(useTaskStore.getState().projects.map((project) => [project.id, project.title]));
                return tasks.map((task) => toNativeTaskRow(task, titles, rowMeta(task, now)));
            },
            requestIdPattern: CAPTURE_ID_PATTERN,
        }),
        // Review, Weekly Review and Daily Review: native-host-contract-review-views.ts.
        ...createReviewViewMethods({
            readiness,
            save,
            t: () => translate,
            formatDate: () => createDateFormatter(dateFormatting()),
            revision: (now) => `${revision()}:${displayRevision(now)}`,
            rows: (tasks, now) => {
                const titles = new Map(useTaskStore.getState().projects.map((project) => [project.id, project.title]));
                return tasks.map((task) => toNativeTaskRow(task, titles, rowMeta(task, now)));
            },
        }),
        // The Calendar screen: native-host-contract-calendar.ts.
        ...createCalendarViewMethods({
            readiness,
            save,
            t: () => translate,
            dateFormatting,
            revision: (now) => `${revision()}:${displayRevision(now)}`,
            dataRevision: () => `${revision()}:${settingsRevision()}`,
            rows: (tasks, now) => {
                const titles = new Map(useTaskStore.getState().projects.map((project) => [project.id, project.title]));
                return tasks.map((task) => toNativeTaskRow(task, titles, rowMeta(task, now)));
            },
        }),
        // The capture popup: native-host-contract-quick-capture.ts.
        ...createQuickCaptureMethods({
            readiness,
            save,
            t: () => translate,
            formatDate: () => createDateFormatter(dateFormatting()),
            revision: (now) => `${revision()}:${displayRevision(now)}`,
            requestIdPattern: CAPTURE_ID_PATTERN,
        }),
        // The Inbox tab's list, toolbar and screen parts: native-host-contract-inbox-view.ts.
        ...createInboxViewMethods({
            readiness,
            t: () => translate,
            revision: (now) => `${revision()}:${displayRevision(now)}`,
            // Mobile's Inbox list hides checklist progress.
            rows: (tasks, now) => {
                const titles = new Map(useTaskStore.getState().projects.map((project) => [project.id, project.title]));
                return tasks.map((task) => toNativeTaskRow(task, titles, rowMeta(task, now, { hideChecklistProgress: true })));
            },
        }),
        // The Board: native-host-contract-board.ts.
        ...createBoardViewMethods({
            readiness,
            save,
            t: () => translate,
            revision: (now) => `${revision()}:${displayRevision(now)}`,
            rows: (tasks, now) => {
                const titles = new Map(useTaskStore.getState().projects.map((project) => [project.id, project.title]));
                return tasks.map((task) => toNativeTaskRow(task, titles, rowMeta(task, now)));
            },
            requestIdPattern: CAPTURE_ID_PATTERN,
        }),
        // Focus's control commands: native-host-contract-focus-controls.ts.
        ...createFocusControlMethods({
            readiness,
            save,
            t: () => translate,
            focusModel,
            requestIdPattern: CAPTURE_ID_PATTERN,
        }),

        getAreaFilter(): NativeHostResult<{ revision: string; label: string; summary: string; options: { id: string; label: string; color: string | null; state: 'included' | 'excluded' | 'none'; next: AreaFilterSelection }[] }> {
            const ready = readiness();
            if (!ready.ok) return ready;
            const state = useTaskStore.getState();
            const areas = sortAreasForDisplay(state.areas);
            const selection = resolveAreaFilterSelection(state.settings.filters, areas);
            const value = areaFilterSelectionToValue(selection);
            const areaById = new Map(areas.map((area) => [area.id, area]));
            const areaName = (id: string) => id === AREA_FILTER_NONE
                ? translate('projects.noArea') : areaById.get(id)?.name ?? translate('projects.noArea');
            const isDefault = !isAreaFilterSelectionActive(selection);
            const summary = isDefault ? translate('projects.allAreas') : [
                selection.included.map(areaName).join(', '),
                selection.excluded.length ? `${tFallback(translate, 'filters.excluded', 'Excluded')}: ${selection.excluded.map(areaName).join(', ')}` : '',
            ].filter(Boolean).join(' · ');
            // RN's trigger says All/None for those scopes and counts richer selections.
            const label = isDefault ? translate('common.all')
                : value === AREA_FILTER_NONE ? translate('common.none')
                    : value !== AREA_FILTER_ALL ? areaName(value)
                        : [selection.included.length || '', selection.excluded.length ? `−${selection.excluded.length}` : '']
                            .filter(Boolean).join(' ');
            return { ok: true, value: {
                revision: `${revision()}:${settingsRevision()}:${language}`,
                label, summary,
                options: [
                    { id: AREA_FILTER_ALL, label: translate('projects.allAreas'), color: null, state: isDefault ? 'included' as const : 'none' as const, next: { included: [], excluded: [] } },
                    ...areas.map((area) => ({ id: area.id, label: area.name, color: area.color ?? null,
                        state: selection.included.includes(area.id) ? 'included' as const : selection.excluded.includes(area.id) ? 'excluded' as const : 'none' as const,
                        next: cycleAreaFilterSelection(selection, area.id),
                    })),
                    { id: AREA_FILTER_NONE, label: translate('projects.noArea'), color: null,
                        state: selection.included.includes(AREA_FILTER_NONE) ? 'included' as const : selection.excluded.includes(AREA_FILTER_NONE) ? 'excluded' as const : 'none' as const,
                        next: cycleAreaFilterSelection(selection, AREA_FILTER_NONE),
                    },
                ],
            } };
        },

        async setAreaFilter(input: AreaFilterSelection): Promise<NativeHostResult<AreaFilterSelection>> {
            const ready = readiness();
            if (!ready.ok) return ready;
            const state = useTaskStore.getState();
            const validIds = new Set([AREA_FILTER_NONE, ...state.areas.filter((area) => !area.deletedAt).map((area) => area.id)]);
            if (!input || !Array.isArray(input.included) || !Array.isArray(input.excluded)
                || [...input.included, ...input.excluded].some((id) => typeof id !== 'string' || !validIds.has(id))
                || new Set([...input.included, ...input.excluded]).size !== input.included.length + input.excluded.length) {
                return fail('INVALID_INPUT', 'Area filter selection is not available');
            }
            const selection = { included: [...input.included], excluded: [...input.excluded] };
            const current = resolveAreaFilterSelection(state.settings.filters, state.areas);
            try {
                if (current.included.length !== selection.included.length
                    || current.excluded.length !== selection.excluded.length
                    || current.included.some((id, index) => id !== selection.included[index])
                    || current.excluded.some((id, index) => id !== selection.excluded[index])) {
                    await state.updateSettings({ filters: {
                        ...state.settings.filters,
                        ...areaFilterSelectionToFilters(selection),
                    } });
                } else if (state.persistenceFailure) {
                    await state.retryPersistence();
                }
                const saved = await save();
                if (!saved.ok) return saved;
                return { ok: true, value: selection };
            } catch (error) {
                const failure = useTaskStore.getState().persistenceFailure;
                return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? (error instanceof Error ? error.message : String(error)));
            }
        },

        async setLanguage(input: { storedLanguage: string | null; systemLocale: string | null }): Promise<NativeHostResult<{ language: Language }>> {
            if (!input || (input.storedLanguage !== null && typeof input.storedLanguage !== 'string')
                || (input.systemLocale !== null && typeof input.systemLocale !== 'string')) {
                return fail('INVALID_INPUT', 'Stored language and system locale must be strings or null');
            }
            const nextLanguage = isSupportedLanguage(input.storedLanguage)
                ? input.storedLanguage
                : resolveLanguageFromLocale(input.systemLocale);
            try {
                await loadTranslations('en');
                await loadTranslations(nextLanguage);
                language = nextLanguage;
                systemLocale = input.systemLocale;
                translate = getTranslator(language);
                return { ok: true, value: { language } };
            } catch (error) {
                return fail('ACTION_FAILED', error instanceof Error ? error.message : String(error));
            }
        },

        getStrings(input: { keys: string[] }): NativeHostResult<{ language: Language; strings: Record<string, string>; missing: string[] }> {
            if (!input || !Array.isArray(input.keys) || input.keys.length > 500
                || input.keys.some((key) => typeof key !== 'string')) {
                return fail('INVALID_INPUT', 'Up to 500 string keys are required');
            }
            const strings: Record<string, string> = {};
            const missing: string[] = [];
            for (const key of input.keys) {
                if (getEnglishI18nValue(key) === undefined) missing.push(key);
                else strings[key] = translate(key);
            }
            return { ok: true, value: { language, strings, missing } };
        },

        /** Call only after the host validates its adapter and any required recovery checkpoint. */
        async activate(input: { writeSafetyReady: boolean }): Promise<NativeHostResult<null>> {
            readyAdapter = null;
            const adapter = getStorageAdapter();
            if (!input || input.writeSafetyReady !== true || adapter === noopStorage) {
                return fail('NOT_READY', 'Native storage and write safety must be validated first');
            }
            const pending = getPersistenceStatus();
            if (pending.queued || pending.inFlight || pending.immediate || pending.retrying || pending.failed
                || useTaskStore.getState().isLoading || useTaskStore.getState().editLockCount > 0) {
                return fail('NOT_READY', 'Native storage cannot load while save or edit work is pending');
            }
            const loadStartedAt = useTaskStore.getState().lastDataChangeAt;
            let loadInvalidated = false;
            let relevanceChecks = 0;
            try {
                await useTaskStore.getState().fetchData({
                    throwOnError: true,
                    isResultStillRelevant: () => {
                        relevanceChecks += 1;
                        if (getStorageAdapter() !== adapter || useTaskStore.getState().lastDataChangeAt !== loadStartedAt) {
                            loadInvalidated = true;
                            return false;
                        }
                        return true;
                    },
                });
                // fetchData's third relevance check is inside the state producer.
                // Earlier exits (including a concurrent edit) never reach its apply gate.
                if (loadInvalidated || relevanceChecks < 3) {
                    return fail('NOT_READY', 'Native storage load was not applied');
                }
                await flushPendingSave();
            } catch (error) {
                return fail('NOT_READY', error instanceof Error ? error.message : String(error));
            }
            if (getStorageAdapter() !== adapter || useTaskStore.getState().isLoading
                || useTaskStore.getState().error || useTaskStore.getState().editLockCount > 0) {
                return fail('NOT_READY', 'Native storage load did not finish cleanly');
            }
            readyAdapter = adapter;
            return { ok: true, value: null };
        },

        getInboxWindow(input: { offset: number; limit: number; revision?: string }): NativeHostResult<NativeInboxWindow> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || !Number.isSafeInteger(input.offset) || input.offset < 0
                || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > NATIVE_HOST_MAX_WINDOW
                || (input.offset > 0 && typeof input.revision !== 'string')
                || (input.revision !== undefined && typeof input.revision !== 'string')) {
                return fail('INVALID_INPUT', 'A valid offset, bounded limit, and revision for later pages are required');
            }
            const now = new Date();
            const currentRevision = `${revision()}:${displayRevision(now)}`;
            if (input.revision !== undefined && input.revision !== currentRevision) {
                return fail('STALE_REVISION', 'Inbox changed; restart paging from offset zero');
            }
            const state = useTaskStore.getState();
            if (cachedRevision !== currentRevision) {
                // RN Inbox stays global across area selections.
                cachedInbox = sortTasksBy(state.tasks.filter((task) => (
                    task.status === 'inbox' && isTaskVisibleInInbox(task, { projectById: state._projectsById })
                )), resolveNonDoneTaskSortBy(state.settings.taskSortBy, state.settings));
                cachedProjectTitles = new Map(state.projects.map((project) => [project.id, project.title]));
                cachedRevision = currentRevision;
            }
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: currentRevision,
                    total: cachedInbox.length,
                    // Mobile's Inbox list hides checklist progress.
                    rows: cachedInbox.slice(input.offset, input.offset + input.limit).map((task) => (
                        toNativeTaskRow(task, cachedProjectTitles, rowMeta(task, now, { hideChecklistProgress: true }))
                    )),
                },
            };
        },

        async searchTasks(input: { query: string; filters: GlobalSearchFilterState; limit: number }): Promise<NativeHostResult<NativeSearchView>> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.query !== 'string' || input.query.length > 2000
                || !isGlobalSearchFilterState(input.filters)
                || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > NATIVE_HOST_MAX_WINDOW) {
                return fail('INVALID_INPUT', 'A query, valid filters, and bounded limit are required');
            }
            const adapter = getStorageAdapter();
            const trimmedQuery = input.query.trim();
            const ftsResults = await fetchGlobalSearchAdapterResults(trimmedQuery, adapter.searchAll?.bind(adapter));
            const after = readiness();
            if (!after.ok) return after;
            const now = new Date();
            const state = useTaskStore.getState();
            const model = computeGlobalSearchResults({
                query: input.query,
                tasks: state._allTasks,
                projects: state.projects,
                areas: state.areas,
                weekStart: state.settings.weekStart,
                includeCompleted: input.filters.includeCompleted,
                includeReference: input.filters.includeReference,
                hideFutureTasks: input.filters.hideFutureTasks,
                selectedStatuses: input.filters.selectedStatuses,
                selectedArea: input.filters.selectedArea,
                selectedTokens: input.filters.selectedTokens,
                locationQuery: input.filters.locationQuery,
                duePreset: input.filters.duePreset,
                scope: input.filters.scope,
                ftsResults,
                ftsQuery: trimmedQuery,
                limit: input.limit,
            });
            const projectTitles = new Map(state.projects.map((project) => [project.id, project.title]));
            const highlight = createSearchHighlighter(input.query);
            const formatDate = createDateFormatter(dateFormatting());
            return { ok: true, value: {
                version: NATIVE_HOST_CONTRACT_VERSION,
                revision: `${revision()}:${displayRevision(now)}`,
                query: trimmedQuery,
                tasks: model.results.filter((result) => result.type === 'task').map(({ item }) => {
                    const full = state._tasksById.get(item.id);
                    const inStore = Boolean(full && !full.deletedAt);
                    const row = inStore && full
                        ? toNativeTaskRow(full, projectTitles, rowMeta(full, now))
                        : {
                            id: item.id, title: item.title, status: item.status,
                            priority: null, dueDate: null, startTime: null, isFocusedToday: false,
                            projectTitle: item.projectId ? projectTitles.get(item.projectId) ?? null : null,
                            hasNotes: false, revealDate: null, revealLabel: null, laterToday: false, meta: null,
                        };
                    return { ...row, inStore,
                        cancelled: isTaskCancelled(full),
                        date: getGlobalSearchResultDate(inStore ? full : undefined, translate, formatDate),
                        titleSegments: highlight(item.title),
                        canComplete: inStore && !isTaskFinished(item),
                        tap: inStore ? { kind: 'editor' as const, id: item.id }
                            : { kind: 'list' as const, id: item.id, ...getGlobalSearchTaskListTarget(item) },
                    };
                }),
                totalTasks: model.totalTasks,
                projects: model.results.filter((result) => result.type === 'project').map(({ item }) => ({
                    id: item.id, title: item.title, status: item.status,
                    cancelledAt: item.cancelledAt, areaId: item.areaId,
                    titleSegments: highlight(item.title),
                })),
                defaultFilters: {
                    ...DEFAULT_GLOBAL_SEARCH_FILTERS,
                    selectedStatuses: [...DEFAULT_GLOBAL_SEARCH_FILTERS.selectedStatuses],
                    selectedTokens: [...DEFAULT_GLOBAL_SEARCH_FILTERS.selectedTokens],
                },
                activeChips: getGlobalSearchActiveChips(input.filters, state.areas, translate).map((chip) => ({
                    ...chip, clearedFilters: clearGlobalSearchActiveChip(input.filters, chip.key),
                })),
                hiddenCompletedCount: model.hiddenCompletedCount,
                hasActiveFilters: model.hasActiveFilters,
                isTruncated: model.isTruncated,
                totalResultsLabel: model.totalResultsLabel,
                filterOptions: getGlobalSearchFilterOptions(state._allTasks, state.areas, translate),
            } };
        },

        async saveSearch(input: { query: string; name?: string; requestId: string }): Promise<NativeHostResult<{ id: string; existing: boolean }>> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2000
                || (input.name !== undefined && typeof input.name !== 'string')
                || typeof input.requestId !== 'string' || !CAPTURE_ID_PATTERN.test(input.requestId)) {
                return fail('INVALID_INPUT', 'A non-blank query and request UUID are required');
            }
            const trimmedQuery = input.query.trim();
            const name = input.name?.trim() || trimmedQuery;
            const previous = savedSearchRequests.get(input.requestId);
            if (previous && (previous.query !== trimmedQuery || previous.name !== name)) return fail('INVALID_INPUT', 'Request ID already belongs to another search');
            const state = useTaskStore.getState();
            const savedSearches = state.settings.savedSearches || [];
            const resolved = resolveSavedSearch(savedSearches, trimmedQuery, name, previous?.id ?? generateUUID());
            try {
                if (!resolved.existing) {
                    savedSearchRequests.set(input.requestId, { query: trimmedQuery, name, id: resolved.search.id });
                    if (savedSearchRequests.size > 50) savedSearchRequests.delete(savedSearchRequests.keys().next().value!);
                    await state.updateSettings({ savedSearches: [...savedSearches, resolved.search] });
                } else if (useTaskStore.getState().persistenceFailure) {
                    await useTaskStore.getState().retryPersistence();
                }
                const saved = await save();
                if (!saved.ok) return saved;
                return { ok: true, value: { id: resolved.search.id, existing: !previous && resolved.existing } };
            } catch (error) {
                const failure = useTaskStore.getState().persistenceFailure;
                return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? (error instanceof Error ? error.message : String(error)));
            }
        },

        /**
         * Focus: its sections with each one's first `limit` rows, and its controls.
         * `controls` is the control state the host keeps (default: no filter, the
         * default sort); a control's `edit` sent as `controlEdit` changes it first.
         * Keep the returned `controls.state` and send it with later reads.
         */
        getFocus(input: { limit: number; controls?: NativeFocusControlsInput; controlEdit?: FocusControlEdit }): NativeHostResult<NativeFocusView> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > NATIVE_HOST_MAX_WINDOW) {
                return fail('INVALID_INPUT', 'A bounded limit is required');
            }
            const now = new Date();
            const read = readFocusControls(input, now);
            if (!read) return fail('INVALID_INPUT', 'The Focus controls or control edit are not valid');
            const { controls } = read;
            const { model, revision: currentRevision } = focusModel(controls, now);
            const sections = focusSections(focusRevision(now), now, controls).map((section) => ({
                key: section.key,
                title: section.title,
                total: section.total,
                rows: focusRows(section, 0, input.limit, now),
                focusBlockedLabel: section.key === 'upcoming'
                    ? getFocusStarBlockedText(translate, { blockedReason: 'deferred' }, normalizeFocusTaskLimit(useTaskStore.getState().settings.gtd?.focusTaskLimit))
                    : null,
                ...(controls ? { rowTotal: section.items.length, groups: windowGroups(section, 0, input.limit) } : {}),
            }));
            const { projectTaskSummaryById: summaries, focusedProjectCount } = useTaskStore.getState().getDerivedState();
            const formatDate = createDateFormatter(dateFormatting());
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: currentRevision,
                    dateLabel: formatDate(now, 'PPPP'),
                    sections,
                    reviewProjects: cachedReviewProjects.map((project) => ({
                        ...toNativeProjectRow(project, summaries, focusedProjectCount, translate),
                        reviewDateLabel: project.reviewAt ? formatDate(project.reviewAt, 'P') : null,
                    })),
                    controls: buildNativeFocusControls(model, { t: translate, formatDate }),
                },
            };
        },

        getProjects(): NativeHostResult<NativeProjectsView> {
            const ready = readiness();
            if (!ready.ok) return ready;
            const currentRevision = `${revision()}:${settingsRevision()}:${language}`;
            if (cachedProjectsRevision !== currentRevision || !cachedProjects) {
                const state = useTaskStore.getState();
                const orderedAreas = sortAreasForDisplay(state.areas);
                const areaById = new Map(orderedAreas.map((area) => [area.id, area]));
                const { projectTaskSummaryById: summaries, focusedProjectCount } = state.getDerivedState();
                // RN Projects groups apply the selected area, including No area.
                const groups = buildProjectGroups({
                    projects: state.projects,
                    orderedAreas,
                    areaFilter: resolveAreaFilterSelection(state.settings.filters, orderedAreas),
                    tagFilter: { kind: 'all' },
                    pinFocused: true,
                });
                const toNativeGroup = (group: ProjectAreaGroup): NativeProjectGroup => {
                    const area = group.areaId ? areaById.get(group.areaId) : undefined;
                    return {
                        areaId: area?.id ?? null,
                        areaName: area?.name ?? null,
                        areaColor: area?.color ?? null,
                        areaIcon: area?.icon ?? null,
                        projects: group.projects.map((project) => toNativeProjectRow(project, summaries, focusedProjectCount, translate)),
                    };
                };
                cachedProjects = {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: currentRevision,
                    active: groups.active.map(toNativeGroup),
                    deferred: groups.deferred.map(toNativeGroup),
                    archived: groups.archived.map(toNativeGroup),
                };
                cachedProjectsRevision = currentRevision;
            }
            return { ok: true, value: cachedProjects };
        },

        getProjectDetail(input: { projectId: string; offset: number; limit: number; revision?: string }): NativeHostResult<NativeProjectDetail> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId.trim()
                || !Number.isSafeInteger(input.offset) || input.offset < 0
                || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > NATIVE_HOST_MAX_WINDOW
                || (input.offset > 0 && typeof input.revision !== 'string')
                || (input.revision !== undefined && typeof input.revision !== 'string')) {
                return fail('INVALID_INPUT', 'A project ID, valid offset, bounded limit, and revision for later pages are required');
            }
            // Feature settings change the resolved sort; titles and row labels are translated.
            const now = new Date();
            const currentRevision = `${revision()}:${displayRevision(now)}`;
            if (input.revision !== undefined && input.revision !== currentRevision) {
                return fail('STALE_REVISION', 'Project changed; restart paging from offset zero');
            }
            const detail = projectDetail(input.projectId, currentRevision);
            if (!detail) return fail('TASK_NOT_FOUND', 'Project not found');
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: currentRevision,
                    projectId: input.projectId,
                    readOnly: detail.readOnly,
                    total: detail.items.length,
                    items: detail.items.slice(input.offset, input.offset + input.limit).map((item): NativeProjectDetailItem => (
                        item.type === 'section'
                            ? { type: 'section', id: item.id, title: item.title, count: item.count, muted: item.muted === true }
                            : {
                                type: 'task',
                                // Mobile's project list hides the project name on its rows.
                                row: toNativeTaskRow(item.task, detail.projectTitles, rowMeta(item.task, now, {
                                    hideProjectMeta: true,
                                    sequenceCue: detail.cues.get(item.task.id),
                                    sequenceLabel: tFallback(translate, 'projects.availableNextAction', 'Available next action'),
                                })),
                                sectionId: item.reorderSectionId ?? null,
                                sequenceCue: detail.cues.get(item.task.id) ?? null,
                            }
                    )),
                },
            };
        },

        /** A later window of one Focus section's rows. Send the `controls.state` the Focus read returned. */
        getFocusSectionWindow(input: {
            key: FocusTaskSectionKey; offset: number; limit: number; revision: string; controls?: NativeFocusControlsInput;
        }): NativeHostResult<{
            version: typeof NATIVE_HOST_CONTRACT_VERSION;
            revision: string;
            key: FocusTaskSectionKey;
            total: number;
            rows: NativeTaskRow[];
            rowTotal?: number;
            groups?: NativeFocusGroup[] | null;
        }> {
            const ready = readiness();
            if (!ready.ok) return ready;
            const controls = input && input.controls !== undefined ? readNativeFocusControls(input.controls) : null;
            if (!input || typeof input.key !== 'string' || (input.controls !== undefined && !controls)
                || !Number.isSafeInteger(input.offset) || input.offset < 0
                || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > NATIVE_HOST_MAX_WINDOW
                || typeof input.revision !== 'string') {
                return fail('INVALID_INPUT', 'A valid section, offset, bounded limit, revision and Focus controls are required');
            }
            const now = new Date();
            const { revision: currentRevision } = focusModel(controls, now);
            if (input.revision !== currentRevision) return fail('STALE_REVISION', 'Focus changed; restart paging');
            const section = focusSections(focusRevision(now), now, controls).find(({ key }) => key === input.key);
            if (!section) return fail('INVALID_INPUT', 'Focus section is not available');
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: currentRevision,
                    key: section.key,
                    total: section.total,
                    rows: focusRows(section, input.offset, input.limit, now),
                    ...(controls ? { rowTotal: section.items.length, groups: windowGroups(section, input.offset, input.limit) } : {}),
                },
            };
        },

        getTask(input: { id: string }): NativeHostResult<Task> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.id !== 'string' || !input.id.trim()) return fail('INVALID_INPUT', 'Task ID is required');
            const task = useTaskStore.getState()._tasksById.get(input.id);
            if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            return { ok: true, value: JSON.parse(JSON.stringify(task)) as Task };
        },

        getTaskEditor(input: { id: string }): NativeHostResult<NativeTaskEditor> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.id !== 'string' || !input.id.trim()) return fail('INVALID_INPUT', 'Task ID is required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.id);
            if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            const taskProject = task.projectId
                ? state._allProjects.find((project) => project.id === task.projectId)
                : undefined;
            const projects = state._allProjects
                .filter((project) => isSelectableProjectForTaskAssignment(project)
                    || (project.id === task.projectId && !project.deletedAt && project.status === 'archived'))
                .map(({ id, title }) => ({ id, title }));
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    id: task.id,
                    fields: {
                        title: task.title,
                        description: task.description ?? null,
                        status: task.status,
                        priority: task.priority ?? null,
                        projectId: task.projectId ?? null,
                        startTime: task.startTime ?? null,
                        dueDate: task.dueDate ?? null,
                    },
                    projects,
                    readOnly: taskProject?.status === 'archived',
                    statuses: [...EDITOR_STATUSES],
                    priorities: [...EDITOR_PRIORITIES],
                },
            };
        },

        async updateTask(input: {
            id: string;
            base: Partial<NativeEditableFields>;
            patch: Partial<NativeEditableFields>;
        }): Promise<NativeHostResult<{ id: string; changed: boolean }>> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.id !== 'string' || !input.id.trim()) return fail('INVALID_INPUT', 'Task ID is required');
            if (!isObjectRecord(input.base) || !isObjectRecord(input.patch)) {
                return fail('INVALID_INPUT', 'base and patch must be objects');
            }
            const patchKeys = Object.keys(input.patch);
            if (patchKeys.length === 0) return fail('INVALID_INPUT', 'patch must include an editor field');
            if (patchKeys.some((key) => !EDITOR_FIELD_SET.has(key))) {
                return fail('INVALID_INPUT', 'patch fields must be title, description, status, priority, projectId, startTime, or dueDate');
            }
            const baseKeys = Object.keys(input.base);
            const mismatchedFields = NATIVE_HOST_EDITOR_FIELDS.filter((field) =>
                Object.prototype.hasOwnProperty.call(input.base, field)
                !== Object.prototype.hasOwnProperty.call(input.patch, field));
            if (baseKeys.length !== patchKeys.length || mismatchedFields.length > 0) {
                const fields = mismatchedFields.length > 0 ? `: ${mismatchedFields.join(', ')}` : '';
                return fail('INVALID_INPUT', `base and patch fields must match${fields}`);
            }

            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.id);
            if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            const taskProject = task.projectId
                ? state._allProjects.find((project) => project.id === task.projectId)
                : undefined;
            if (taskProject?.status === 'archived') {
                return fail('INVALID_INPUT', 'Task is read-only while its project is archived');
            }

            for (const key of patchKeys) {
                const field = key as keyof NativeEditableFields;
                const value = input.patch[field];
                switch (field) {
                    case 'title':
                        if (typeof value !== 'string' || !value.trim()) return fail('INVALID_INPUT', 'title must be a non-blank string');
                        break;
                    case 'status':
                        if (typeof value !== 'string' || !EDITOR_STATUSES.some((status) => status === value)) {
                            return fail('INVALID_INPUT', 'status must be an editable status');
                        }
                        break;
                    case 'description':
                        if (value != null && typeof value !== 'string') return fail('INVALID_INPUT', 'description must be a string or null');
                        break;
                    case 'priority':
                        if (value != null && !EDITOR_PRIORITIES.some((priority) => priority === value)) {
                            return fail('INVALID_INPUT', 'priority must be an editable priority or null');
                        }
                        break;
                    case 'projectId':
                        if (value != null) {
                            const project = typeof value === 'string'
                                ? state._allProjects.find((candidate) => candidate.id === value)
                                : undefined;
                            if (!project || !isSelectableProjectForTaskAssignment(project)) {
                                return fail('INVALID_INPUT', 'projectId must reference an editable project or null');
                            }
                        }
                        break;
                    case 'startTime':
                    case 'dueDate':
                        if (value != null && !isValidEditorDate(value)) {
                            return fail('INVALID_INPUT', `${field} must be a valid date or datetime`);
                        }
                        break;
                }
            }

            const resultingStatus = Object.prototype.hasOwnProperty.call(input.patch, 'status')
                ? input.patch.status
                : task.status;
            if (resultingStatus === 'reference') {
                for (const field of ['priority', 'startTime', 'dueDate'] as const) {
                    if (Object.prototype.hasOwnProperty.call(input.patch, field) && input.patch[field] != null) {
                        return fail('INVALID_INPUT', `${field} cannot be set while status is reference`);
                    }
                }
            }

            const updates: Partial<Task> = {};
            const conflicts: string[] = [];
            for (const key of patchKeys) {
                const field = key as keyof NativeEditableFields;
                const current = normalizeEditorValue(field, task[field]);
                const base = normalizeEditorValue(field, input.base[field]);
                const next = normalizeEditorValue(field, input.patch[field]);
                if (current === base) {
                    if (current !== next) Object.assign(updates, { [field]: next === null ? undefined : next });
                } else if (current !== next) {
                    conflicts.push(field);
                }
            }
            if (conflicts.length > 0) {
                return fail('STALE_REVISION', `Task changed while editing: ${conflicts.join(', ')}`);
            }

            const changed = Object.keys(updates).length > 0;
            try {
                if (changed) {
                    const result = await useTaskStore.getState().updateTask(input.id, updates);
                    if (!result.success) {
                        const failure = useTaskStore.getState().persistenceFailure;
                        return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? result.error ?? 'Task update failed');
                    }
                } else if (useTaskStore.getState().persistenceFailure) {
                    await useTaskStore.getState().retryPersistence();
                }
                const saved = await save();
                if (!saved.ok) return saved;
                return { ok: true, value: { id: input.id, changed } };
            } catch (error) {
                const failure = useTaskStore.getState().persistenceFailure;
                return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? (error instanceof Error ? error.message : String(error)));
            }
        },

        getTaskEditorModel(input: { id: string }): NativeHostResult<NativeTaskEditorModel> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.id !== 'string' || !input.id.trim()) return fail('INVALID_INPUT', 'Task ID is required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.id);
            if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            return { ok: true, value: taskEditorModel(task, createTaskDraft(task), new Date()) };
        },

        /**
         * Suggestions for a context, tag or person input, from its whole text as typed.
         * The React Native editor shows 4 matches (`limit`). Store `draftValue` in the draft.
         */
        getTaskEditorSuggestions(input: {
            id: string;
            field: 'contexts' | 'tags' | 'assignedTo';
            query: string;
            limit: number;
        }): NativeHostResult<TaskEditorSuggestions> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.id !== 'string' || !input.id.trim()
                || (input.field !== 'contexts' && input.field !== 'tags' && input.field !== 'assignedTo')
                || typeof input.query !== 'string' || input.query.length > 2000
                || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > NATIVE_HOST_MAX_WINDOW) {
                return fail('INVALID_INPUT', 'A task ID, a contexts, tags or assignedTo field, a query and a bounded limit are required');
            }
            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.id);
            if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            const derived = state.getDerivedState();
            return {
                ok: true,
                value: getTaskEditorSuggestions({
                    field: input.field,
                    text: input.query,
                    limit: input.limit,
                    knownTokens: input.field === 'tags' ? derived.allTags : derived.allContexts,
                    usage: input.field === 'tags' ? derived.tagTokenUsage : derived.contextTokenUsage,
                    people: state.people,
                    tasks: state.tasks,
                }),
            };
        },

        /**
         * Save draft fields. `base` holds each field's value when editing began; a field
         * changed since by another writer is a conflict, unless it already holds the new
         * value. A repeat of the same request after a failed save writes nothing new.
         */
        async saveTaskDraft(input: {
            id: string;
            base: Partial<TaskDraft>;
            patch: Partial<TaskDraft>;
        }): Promise<NativeHostResult<{ id: string; draft: TaskDraft }>> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.id !== 'string' || !input.id.trim()) return fail('INVALID_INPUT', 'Task ID is required');
            if (!isObjectRecord(input.base) || !isObjectRecord(input.patch)) {
                return fail('INVALID_INPUT', 'base and patch must be objects');
            }
            const fields = Object.keys(input.patch) as TaskDraftField[];
            if (fields.length === 0) return fail('INVALID_INPUT', 'patch must include a draft field');
            if (fields.some((field) => !DRAFT_FIELD_SET.has(field))) {
                return fail('INVALID_INPUT', 'patch fields must be task draft fields');
            }
            const mismatchedFields = TASK_DRAFT_FIELD_KEYS.filter((field) =>
                Object.prototype.hasOwnProperty.call(input.base, field)
                !== Object.prototype.hasOwnProperty.call(input.patch, field));
            if (Object.keys(input.base).length !== fields.length || mismatchedFields.length > 0) {
                const named = mismatchedFields.length > 0 ? `: ${mismatchedFields.join(', ')}` : '';
                return fail('INVALID_INPUT', `base and patch fields must match${named}`);
            }

            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.id);
            if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            if (isInArchivedProject(task)) return fail('INVALID_INPUT', 'Task is read-only while its project is archived');

            const base = toDraftValues(input.base);
            const patch = toDraftValues(input.patch);
            for (const field of fields) {
                const value = patch[field];
                let valid = DRAFT_VALUE_CHECKS[field](value);
                if (valid && field === 'projectId' && value && value !== task.projectId) {
                    const project = state._projectsById.get(value as string);
                    valid = Boolean(project && isSelectableProjectForTaskAssignment(project));
                }
                if (valid && field === 'areaId' && value && value !== task.areaId) {
                    valid = state.areas.some((area) => area.id === value && !area.deletedAt);
                }
                if (valid && field === 'sectionId' && value) {
                    // A named section must be live in the project the draft ends up in.
                    const projectId = Object.prototype.hasOwnProperty.call(patch, 'projectId') ? patch.projectId : task.projectId;
                    valid = state.sections.some((section) => section.id === value && section.projectId === projectId && !section.deletedAt);
                }
                if (!valid) return fail('INVALID_INPUT', `${field} is not a valid value`);
            }

            const key = JSON.stringify([input.base, input.patch]);
            const lastSave = draftSaves.get(input.id);
            if (lastSave && lastSave.task !== task) draftSaves.delete(input.id);
            const isRetry = lastSave?.key === key && lastSave.task === task;
            let updates: Partial<Task> | null = {};
            if (!isRetry) {
                const current = createTaskDraft(task);
                const conflicts = fields.filter((field) => !isSameDraftValue(current[field], base[field])
                    && !isSameDraftValue(current[field], patch[field]));
                if (conflicts.length > 0) {
                    return fail('STALE_REVISION', `Task changed while editing: ${conflicts.join(', ')}`);
                }
                // A field that already holds its new value is left alone.
                const pending = Object.fromEntries(fields
                    .filter((field) => isSameDraftValue(current[field], base[field]))
                    .map((field) => [field, patch[field]]));
                const draft = clearInvalidTaskDraftSection(applyTaskDraftPatch(current, pending), state.sections);
                updates = buildTaskEditUpdatePatch({ draft, checklist: task.checklist, attachments: task.attachments }, task);
                if (!updates) return fail('INVALID_INPUT', 'title must not be blank');
            }

            try {
                if (Object.keys(updates).length > 0) {
                    const result = await useTaskStore.getState().updateTask(input.id, updates);
                    if (!result.success) {
                        const failure = useTaskStore.getState().persistenceFailure;
                        return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? result.error ?? 'Task update failed');
                    }
                    draftSaves.delete(input.id);
                    draftSaves.set(input.id, { key, task: useTaskStore.getState()._tasksById.get(input.id) });
                    if (draftSaves.size > 50) draftSaves.delete(draftSaves.keys().next().value as string);
                } else if (useTaskStore.getState().persistenceFailure) {
                    await useTaskStore.getState().retryPersistence();
                }
                const saved = await save();
                if (!saved.ok) return saved;
                const savedTask = useTaskStore.getState()._tasksById.get(input.id) ?? task;
                return { ok: true, value: { id: input.id, draft: createTaskDraft(savedTask) } };
            } catch (error) {
                const failure = useTaskStore.getState().persistenceFailure;
                return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? (error instanceof Error ? error.message : String(error)));
            }
        },

        // -------------------------------------------------------------------
        // Editor draft edits (task editor-dates-contract).

        /**
         * The editor for an unsaved draft, after one control's edit: the edited draft and its
         * layout, options and field states, exactly as the React Native editor shows them while
         * the user edits. Without `edit`, the model for `draft` as it is. Nothing is written;
         * save the result with saveTaskDraft. An edit that changes nothing returns the draft as is.
         */
        editTaskDraft(input: {
            id: string;
            draft: TaskDraft;
            edit?: NativeTaskDraftEdit;
        }): NativeHostResult<NativeTaskEditorModel> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.id !== 'string' || !input.id.trim()) return fail('INVALID_INPUT', 'Task ID is required');
            const draft = readTaskDraft(input.draft);
            if (!draft) return fail('INVALID_INPUT', 'draft must hold every task draft field with a valid value');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.id);
            if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            const now = new Date();
            const edited = input.edit === undefined ? draft : applyNativeTaskDraftEdit(draft, input.edit, {
                task,
                now,
                formatDate: createDateFormatter(dateFormatting()),
                defaultScheduleTime: normalizeClockTimeInput(state.settings.gtd?.defaultScheduleTime) || '',
            });
            if (!edited) return fail('INVALID_INPUT', 'edit is not a valid editor edit');
            return { ok: true, value: taskEditorModel(task, edited, now) };
        },

        /** Reuse captureId for retries so a failed save cannot create a duplicate. */
        async createInboxTask(input: { title: string; captureId: string }): Promise<NativeHostResult<{ id: string }>> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.title !== 'string' || !input.title.trim()
                || typeof input.captureId !== 'string' || !CAPTURE_ID_PATTERN.test(input.captureId)) {
                return fail('INVALID_INPUT', 'Task title and capture UUID are required');
            }
            try {
                const result = await useTaskStore.getState().addTask(input.title, { status: 'inbox' }, { captureId: input.captureId });
                if (!result.success || !result.id) {
                    const failure = useTaskStore.getState().persistenceFailure;
                    return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? result.error ?? 'Task creation failed');
                }
                const saved = await save();
                if (!saved.ok) return saved;
                return { ok: true, value: { id: result.id } };
            } catch (error) {
                return fail('ACTION_FAILED', error instanceof Error ? error.message : String(error));
            }
        },

        async createProject(input: { title: string; areaId: string | null; requestId: string }): Promise<NativeHostResult<{ id: string }>> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.title !== 'string' || !input.title.trim()
                || (input.areaId !== null && typeof input.areaId !== 'string')
                || typeof input.requestId !== 'string' || !CAPTURE_ID_PATTERN.test(input.requestId)) {
                return fail('INVALID_INPUT', 'Project title, area ID, and request UUID are required');
            }
            try {
                const state = useTaskStore.getState();
                const previousId = createdProjects.get(input.requestId);
                const previous = previousId && state._projectsById.get(previousId);
                if (previous && !previous.deletedAt) {
                    if (state.persistenceFailure) await state.retryPersistence();
                    const saved = await save();
                    if (!saved.ok) return saved;
                    return { ok: true, value: { id: previous.id } };
                }
                const area = state.areas.find((candidate) => candidate.id === input.areaId && !candidate.deletedAt);
                const created = await state.addProject(input.title, area?.color || DEFAULT_PROJECT_COLOR, { areaId: area?.id });
                if (!created) {
                    const failure = useTaskStore.getState().persistenceFailure;
                    return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? useTaskStore.getState().error ?? 'Project creation failed');
                }
                createdProjects.set(input.requestId, created.id);
                const saved = await save();
                if (!saved.ok) return saved;
                return { ok: true, value: { id: created.id } };
            } catch (error) {
                const failure = useTaskStore.getState().persistenceFailure;
                return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? (error instanceof Error ? error.message : String(error)));
            }
        },

        async setTaskFocus(input: { id: string; focused: boolean }): Promise<NativeHostResult<{ id: string; focused: boolean } | { blocked: string; blockedTitle: string }>> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.id !== 'string' || !input.id.trim() || typeof input.focused !== 'boolean') {
                return fail('INVALID_INPUT', 'Task ID and target focus state are required');
            }
            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.id);
            if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            try {
                if (Boolean(task.isFocusedToday) === input.focused) {
                    if (state.persistenceFailure) await state.retryPersistence();
                } else {
                    const action = state.getFocusStarAction(task);
                    if (!action.canToggle) return { ok: true, value: {
                        blocked: getFocusStarBlockedText(translate, action, normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit)) ?? '',
                        blockedTitle: tFallback(translate, 'digest.focus', 'Focus'),
                    } };
                    if (action.patch.isFocusedToday !== input.focused) return fail('ACTION_FAILED', 'Focus action did not match target state');
                    const result = await state.updateTask(input.id, action.patch);
                    if (!result.success) {
                        const failure = useTaskStore.getState().persistenceFailure;
                        return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? result.error ?? 'Task focus failed');
                    }
                }
                const saved = await save();
                if (!saved.ok) return saved;
                return { ok: true, value: { id: input.id, focused: input.focused } };
            } catch (error) {
                const failure = useTaskStore.getState().persistenceFailure;
                return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? (error instanceof Error ? error.message : String(error)));
            }
        },

        async setProjectFocus(input: { id: string; focused: boolean }): Promise<NativeHostResult<{ id: string; focused: boolean } | { blocked: '' }>> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.id !== 'string' || !input.id.trim() || typeof input.focused !== 'boolean') {
                return fail('INVALID_INPUT', 'Project ID and target focus state are required');
            }
            const state = useTaskStore.getState();
            const project = state._projectsById.get(input.id);
            if (!project || project.deletedAt) return fail('INVALID_INPUT', 'Project is not available');
            try {
                if (Boolean(project.isFocused) === input.focused) {
                    if (state.persistenceFailure) await state.retryPersistence();
                } else {
                    await state.toggleProjectFocus(input.id);
                    const after = useTaskStore.getState();
                    const failure = after.persistenceFailure;
                    if (failure) return fail('SAVE_FAILED', failure.message);
                    if (Boolean(after._projectsById.get(input.id)?.isFocused) !== input.focused) return { ok: true, value: { blocked: '' } };
                }
                const saved = await save();
                if (!saved.ok) return saved;
                return { ok: true, value: { id: input.id, focused: input.focused } };
            } catch (error) {
                const failure = useTaskStore.getState().persistenceFailure;
                return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? (error instanceof Error ? error.message : String(error)));
            }
        },

        async completeTask(input: { id: string }): Promise<NativeHostResult<{ id: string }>> {
            const ready = readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.id !== 'string' || !input.id.trim()) return fail('INVALID_INPUT', 'Task ID is required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.id);
            if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            try {
                if (task.status === 'done' && state.persistenceFailure) {
                    await state.retryPersistence();
                } else if (task.status !== 'done') {
                    const result = await state.updateTask(input.id, { status: 'done' });
                    if (!result.success) {
                        const failure = useTaskStore.getState().persistenceFailure;
                        return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? result.error ?? 'Task completion failed');
                    }
                }
                const saved = await save();
                if (!saved.ok) return saved;
                return { ok: true, value: { id: input.id } };
            } catch (error) {
                return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Process Inbox. Kept in one block: other changes edit this file in parallel.

/** One Process Inbox step for the task on screen, with the draft the user is editing. */
export type NativeInboxProcessingView = ProcessInboxStepView & {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    /** Changes with any task, project, area, person, setting, language or minute change. */
    revision: string;
    sessionId: string;
    taskId: string;
    progress: { processed: number; total: number; label: string };
    draft: ProcessInboxDraft;
};

/** A step's result. `view` is null once the queue is done; the session has then ended. */
export type NativeInboxProcessingResult = {
    view: NativeInboxProcessingView | null;
    /** A message the step shows instead of moving on, like "Choose a start date". */
    notice: ProcessInboxNotice | null;
    /** The confirmation shown after a decision lands, with its Undo label. */
    toast: { message: string; undoLabel: string } | null;
};

type InboxProcessingDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: (now: Date) => string;
    t: () => (key: string) => string;
    formatDate: () => DateFormatter;
};

type InboxProcessingEntry = {
    id: string;
    mode: ProcessInboxMode;
    session: ProcessInboxSession;
    answers: ProcessInboxAnswers;
    draft: ProcessInboxDraft;
    /** The task's content when it opened; a change by another writer makes the session stale. */
    taskRevision: string;
    latchedTotal: number;
    /** The queue is done. Kept until evicted or ended, so the last decision can still be retried. */
    ended: boolean;
    /** Completed requests: an exact retry returns the same outcome without writing again. */
    requests: Map<string, { key: string; notice: ProcessInboxNotice | null; toast: NativeInboxProcessingResult['toast']; saved: boolean }>;
};

const INBOX_PROCESSING_MODES = new Set(['guided', 'quick']);
const INBOX_TEXT_FIELDS = new Set(['title', 'description', 'tokenInput', 'projectSearch', 'assignedTo', 'delegateWho', 'nextAction']);
const INBOX_DATE_FIELDS = new Set(['startTime', 'dueDate', 'reviewAt', 'followUp']);
const INBOX_TEXT_LIMIT = 10_000;
const isInboxText = (value: unknown): value is string => typeof value === 'string' && value.length <= INBOX_TEXT_LIMIT;
const inboxTaskRevision = (task: Task) => `${task.rev ?? ''}:${task.revBy ?? ''}:${task.updatedAt}`;

function isValidInboxEdit(edit: unknown): edit is ProcessInboxDraftEdit {
    if (!isObjectRecord(edit)) return false;
    const state = useTaskStore.getState();
    const { value } = edit;
    switch (edit.type) {
        case 'set':
            return typeof edit.field === 'string' && INBOX_TEXT_FIELDS.has(edit.field) && isInboxText(value);
        case 'setExtraActions':
            return Array.isArray(value) && value.length <= NATIVE_HOST_MAX_WINDOW && value.every(isInboxText);
        case 'setExtraAction':
            return Number.isSafeInteger(edit.index) && (edit.index as number) >= 0
                && (edit.index as number) < NATIVE_HOST_MAX_WINDOW && isInboxText(value);
        case 'setPriority':
            return value === null || PROCESS_INBOX_PRIORITY_OPTIONS.includes(value as TaskPriority);
        case 'setEnergyLevel':
            return value === null || PROCESS_INBOX_ENERGY_LEVEL_OPTIONS.includes(value as never);
        case 'setTimeEstimate':
            return value === null || INBOX_TIME_ESTIMATES.includes(value as TimeEstimate) || isCustomInboxTimeEstimate(value as TimeEstimate);
        case 'setSomedaySection':
            return value === null || (typeof value === 'string'
                && (state.settings.gtd?.viewSections?.someday ?? []).some((section) => section.id === value));
        case 'setArea':
            return value === null || state.areas.some((area) => area.id === value && !area.deletedAt);
        case 'selectProject': {
            if (value === null) return true;
            const project = typeof value === 'string' ? state._projectsById.get(value) : undefined;
            return Boolean(project && isSelectableProjectForTaskAssignment(project));
        }
        case 'toggleContext':
        case 'toggleTag':
        case 'applyTokenSuggestion':
            return typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
        case 'addToken':
            return edit.kind === undefined || edit.kind === 'context' || edit.kind === 'tag';
        case 'setDate':
            return typeof edit.field === 'string' && INBOX_DATE_FIELDS.has(edit.field)
                && (value === null || (typeof value === 'string' && DATE_ONLY_PATTERN.test(value) && safeParseDate(value) !== null));
        case 'setPickedDate':
            return typeof edit.field === 'string' && INBOX_DATE_FIELDS.has(edit.field)
                && typeof edit.day === 'string' && DATE_ONLY_PATTERN.test(edit.day) && safeParseDate(edit.day) !== null;
        case 'setDateOnly':
            return typeof edit.field === 'string' && INBOX_DATE_FIELDS.has(edit.field) && typeof value === 'boolean';
        case 'toggleAdvancedOptions':
            return true;
        default:
            return false;
    }
}

function createInboxProcessingMethods(deps: InboxProcessingDeps) {
    // ponytail: keeps 4 sessions and 20 requests per session. The oldest one whose
    // writes are all saved makes room; a write still waiting for a save is never
    // dropped, so while only such work remains, new sessions and requests are refused.
    // Add an idle expiry if hosts leave sessions open.
    const sessions = new Map<string, InboxProcessingEntry>();
    const busy = () => fail('ACTION_FAILED', 'Earlier Process Inbox changes are not saved yet. Retry them first.');
    const owesSave = (entry: InboxProcessingEntry) => Array.from(entry.requests.values()).some((done) => !done.saved);
    /** A successful save stores every earlier write too. */
    const markAllSaved = () => {
        for (const entry of sessions.values()) {
            for (const done of entry.requests.values()) done.saved = true;
        }
    };
    let similarity: { tasks: Task[]; index: TaskSimilarityIndex } | null = null;

    const context = () => {
        const state = useTaskStore.getState();
        return {
            state,
            plan: resolveProcessInboxPlan(state.settings),
            queue: selectProcessInboxQueue(state.tasks, state.projects),
            parseTitle: createProcessInboxTitleParser({
                settings: state.settings, tasks: state.tasks, people: state.people, projects: state.projects, areas: state.areas,
            }),
        };
    };

    /** Put the session's current task on screen with fresh answers and draft. False when the queue is done. */
    const openCurrent = (entry: InboxProcessingEntry, queue: Task[]): boolean => {
        const task = getProcessInboxCurrentCandidate(entry.session, queue);
        if (!task) return false;
        entry.answers = { ...INITIAL_PROCESS_INBOX_ANSWERS };
        entry.draft = createProcessInboxDraft(task);
        entry.taskRevision = inboxTaskRevision(task);
        return true;
    };

    const buildView = (entry: InboxProcessingEntry): NativeInboxProcessingView | null => {
        const { state, plan, queue } = context();
        const task = entry.ended ? null : getProcessInboxCurrentCandidate(entry.session, queue);
        if (!task) return null;
        const now = new Date();
        const t = deps.t();
        if (similarity?.tasks !== state._allTasks) {
            similarity = { tasks: state._allTasks, index: createTaskSimilarityIndex(state._allTasks) };
        }
        const progress = getProcessInboxProgress(entry.latchedTotal, getProcessInboxRemainingCandidates(entry.session, queue).length);
        entry.latchedTotal = progress.total;
        return {
            version: NATIVE_HOST_CONTRACT_VERSION,
            revision: deps.revision(now),
            sessionId: entry.id,
            taskId: task.id,
            progress: { ...progress, label: formatProcessInboxProgressLabel(t, progress.processed, progress.total) },
            draft: entry.draft,
            ...buildProcessInboxStepView({
                task,
                draft: entry.draft,
                answers: entry.answers,
                mode: entry.mode,
                plan,
                settings: state.settings,
                tasks: state.tasks,
                projects: state.projects,
                areas: state.areas,
                people: state.people,
                similarityIndex: similarity.index,
                t,
                formatDate: deps.formatDate(),
                now,
            }),
        };
    };

    /** The session, checked against its current task and step. */
    const current = (input: { sessionId: unknown; taskId: unknown; step: unknown }): NativeHostResult<{ entry: InboxProcessingEntry; task: Task }> => {
        const entry = typeof input.sessionId === 'string' ? sessions.get(input.sessionId) : undefined;
        if (!entry || entry.ended) return fail('STALE_REVISION', 'Process Inbox session ended; start again');
        const { plan, queue } = context();
        const task = getProcessInboxCurrentCandidate(entry.session, queue);
        if (!task || task.id !== input.taskId || inboxTaskRevision(task) !== entry.taskRevision) {
            return fail('STALE_REVISION', 'The Inbox item changed; start again');
        }
        if (input.step !== resolveProcessInboxStep(entry.answers, entry.mode, plan)) {
            return fail('STALE_REVISION', 'The step changed; show the current step');
        }
        return { ok: true, value: { entry, task } };
    };

    const result = (entry: InboxProcessingEntry, notice: ProcessInboxNotice | null, toast: NativeInboxProcessingResult['toast']): NativeInboxProcessingResult => (
        { view: buildView(entry), notice, toast }
    );

    const writeFailure = (message: string | undefined): NativeHostResult<never> => {
        const failure = useTaskStore.getState().persistenceFailure;
        return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? message ?? 'Process Inbox write failed');
    };

    /** Run one request once. A retry of a completed request only finishes its save. */
    const once = async (
        entry: InboxProcessingEntry,
        requestId: string,
        key: string,
        run: () => Promise<NativeHostResult<{ notice: ProcessInboxNotice | null; toast: NativeInboxProcessingResult['toast']; wrote: boolean }>>,
    ): Promise<NativeHostResult<NativeInboxProcessingResult>> => {
        let done = entry.requests.get(requestId);
        if (done && done.key !== key) return fail('INVALID_INPUT', 'Request ID already belongs to another step');
        if (!done) {
            if (entry.requests.size >= 20) {
                const oldestSaved = Array.from(entry.requests.entries()).find(([, receipt]) => receipt.saved)?.[0];
                if (oldestSaved === undefined) return busy();
                entry.requests.delete(oldestSaved);
            }
            const outcome = await run();
            if (!outcome.ok) return outcome;
            done = { key, notice: outcome.value.notice, toast: outcome.value.toast, saved: !outcome.value.wrote };
            entry.requests.set(requestId, done);
        } else if (!done.saved && useTaskStore.getState().persistenceFailure) {
            try {
                await useTaskStore.getState().retryPersistence();
            } catch (error) {
                return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
            }
        }
        if (!done.saved) {
            const saved = await deps.save();
            if (!saved.ok) return saved;
            markAllSaved();
        }
        return { ok: true, value: result(entry, done.notice, done.toast) };
    };

    const isRequest = (input: unknown): input is { sessionId: string; taskId: string; requestId: string } => (
        isObjectRecord(input) && typeof input.sessionId === 'string' && typeof input.taskId === 'string'
        && typeof input.requestId === 'string' && CAPTURE_ID_PATTERN.test(input.requestId)
    );

    /** Commit a destination, then open the next task or end the session. */
    const commitKind = async (
        entry: InboxProcessingEntry,
        task: Task,
        kind: Parameters<typeof commitProcessInboxDecision>[0],
        committed: Parameters<typeof formatProcessInboxCommitMessage>[1] | null,
    ) => {
        const { state, plan, queue, parseTitle } = context();
        const t = deps.t();
        const title = entry.draft.title.trim() || task.title;
        const outcome = await commitProcessInboxDecision(kind, {
            task,
            draft: entry.draft,
            plan,
            settings: state.settings,
            projects: state.projects,
            parseTitle,
            session: entry.session,
            candidates: queue,
            // Read at call time, like every other contract write.
            actions: {
                updateTask: (id, updates) => useTaskStore.getState().updateTask(id, updates),
                deleteTask: (id) => useTaskStore.getState().deleteTask(id),
                addTask: (taskTitle, props) => useTaskStore.getState().addTask(taskTitle, props),
                addProject: (projectTitle, color, props) => useTaskStore.getState().addProject(projectTitle, color, props),
            },
            t,
        });
        entry.draft = outcome.draft;
        if (!outcome.ok) {
            if (outcome.reason === 'write-failed' || outcome.reason === 'project-create-failed' || outcome.reason === null) {
                return writeFailure(outcome.notice?.message);
            }
            return { ok: true as const, value: { notice: outcome.notice, toast: null, wrote: false } };
        }
        entry.session = outcome.session;
        if (!openCurrent(entry, context().queue)) entry.ended = true;
        return {
            ok: true as const,
            value: {
                notice: null,
                toast: committed
                    ? { message: formatProcessInboxCommitMessage(t, committed, title), undoLabel: tFallback(t, 'common.undo', 'Undo') }
                    : null,
                wrote: true,
            },
        };
    };

    return {
        /** Open the queue: Inbox items and returning Someday items, in store order. */
        startInboxProcessing(input: { mode?: ProcessInboxMode } = {}): NativeHostResult<{
            sessionId: string | null;
            queue: { total: number; taskIds: string[] };
            view: NativeInboxProcessingView | null;
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || (input.mode !== undefined && !INBOX_PROCESSING_MODES.has(input.mode as string))) {
                return fail('INVALID_INPUT', 'mode must be guided or quick');
            }
            const { queue } = context();
            const taskIds = queue.slice(0, NATIVE_HOST_MAX_WINDOW).map((task) => task.id);
            if (queue.length === 0) return { ok: true, value: { sessionId: null, queue: { total: 0, taskIds }, view: null } };
            if (sessions.size >= 4) {
                const oldestSaved = Array.from(sessions.values()).find((session) => !owesSave(session));
                if (!oldestSaved) return busy();
                sessions.delete(oldestSaved.id);
            }
            const entry: InboxProcessingEntry = {
                id: generateUUID(),
                mode: input.mode ?? 'guided',
                session: startProcessInboxSession(queue),
                answers: { ...INITIAL_PROCESS_INBOX_ANSWERS },
                draft: createProcessInboxDraft(queue[0]),
                taskRevision: inboxTaskRevision(queue[0]),
                latchedTotal: 0,
                ended: false,
                requests: new Map(),
            };
            sessions.set(entry.id, entry);
            return { ok: true, value: { sessionId: entry.id, queue: { total: queue.length, taskIds }, view: buildView(entry)! } };
        },

        /**
         * The current step. `edit` changes the draft first, as the step's controls do;
         * `mode` switches guided and quick for the same task.
         */
        getInboxProcessingStep(input: {
            sessionId: string;
            taskId: string;
            step: string;
            edit?: ProcessInboxDraftEdit;
            mode?: ProcessInboxMode;
        }): NativeHostResult<NativeInboxProcessingView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.sessionId !== 'string' || typeof input.taskId !== 'string'
                || typeof input.step !== 'string'
                || (input.edit !== undefined && !isValidInboxEdit(input.edit))
                || (input.mode !== undefined && !INBOX_PROCESSING_MODES.has(input.mode))) {
                return fail('INVALID_INPUT', 'A session, task, step, and a valid edit or mode are required');
            }
            const checked = current(input);
            if (!checked.ok) return checked;
            const { entry } = checked.value;
            if (input.edit) entry.draft = applyProcessInboxDraftEdit(entry.draft, input.edit, context().plan);
            if (input.mode) entry.mode = input.mode;
            return { ok: true, value: buildView(entry)! };
        },

        /**
         * Answer the step: a choice from `view.choices`, `fileIt`, `createProject`, `back`, or
         * `submitProjectSearch`. Reuse `requestId` to retry: a completed request writes nothing again.
         */
        async commitInboxProcessingStep(input: {
            sessionId: string;
            taskId: string;
            step: string;
            decision: { choice: string };
            requestId: string;
        }): Promise<NativeHostResult<NativeInboxProcessingResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isRequest(input) || typeof input.step !== 'string'
                || !isObjectRecord(input.decision) || typeof input.decision.choice !== 'string') {
                return fail('INVALID_INPUT', 'A session, task, step, decision choice, and request UUID are required');
            }
            const entry = sessions.get(input.sessionId);
            if (!entry) return fail('STALE_REVISION', 'Process Inbox session ended; start again');
            const key = JSON.stringify([input.taskId, input.step, input.decision.choice]);
            return once(entry, input.requestId, key, async () => {
                const checked = current(input);
                if (!checked.ok) return checked;
                const { task } = checked.value;
                const { state, plan, parseTitle } = context();
                if (input.decision.choice === 'submitProjectSearch') {
                    if (!buildView(entry)?.project?.search) return fail('INVALID_INPUT', 'This step has no project search');
                    const { exactMatch } = getProcessInboxProjectChoices(state.projects, entry.draft.areaId, entry.draft.projectSearch);
                    const submit = resolveProcessInboxProjectSearchSubmit(entry.draft.projectSearch, exactMatch, entry.draft.areaId);
                    if (submit.type === 'none') return { ok: true, value: { notice: null, toast: null, wrote: false } };
                    let projectId = submit.type === 'select' ? submit.projectId : null;
                    if (submit.type === 'create') {
                        try {
                            projectId = (await useTaskStore.getState().addProject(submit.title, submit.color, submit.props))?.id ?? null;
                        } catch (error) {
                            return writeFailure(error instanceof Error ? error.message : String(error));
                        }
                        if (!projectId) return writeFailure(useTaskStore.getState().error ?? undefined);
                    }
                    entry.draft = applyProcessInboxDraftEdit(entry.draft, { type: 'selectProject', value: projectId }, plan);
                    return { ok: true, value: { notice: null, toast: null, wrote: submit.type === 'create' } };
                }
                const outcome = answerProcessInboxStep({
                    choice: input.decision.choice,
                    answers: entry.answers,
                    draft: entry.draft,
                    mode: entry.mode,
                    plan,
                    task,
                    parseTitle,
                });
                if (outcome.type === 'invalid') return fail('INVALID_INPUT', 'This step does not offer that choice');
                if (outcome.type === 'flow') {
                    entry.answers = outcome.answers;
                    entry.draft = outcome.draft;
                    return { ok: true, value: { notice: null, toast: null, wrote: false } };
                }
                return commitKind(entry, task, outcome.kind, outcome.committed);
            });
        },

        /** Skip: keep the edits made so far and move to the next item, as mobile does. */
        async skipInboxProcessingTask(input: {
            sessionId: string;
            taskId: string;
            requestId: string;
        }): Promise<NativeHostResult<NativeInboxProcessingResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isRequest(input)) return fail('INVALID_INPUT', 'A session, task, and request UUID are required');
            const entry = sessions.get(input.sessionId);
            if (!entry) return fail('STALE_REVISION', 'Process Inbox session ended; start again');
            return once(entry, input.requestId, JSON.stringify([input.taskId, 'skip']), async () => {
                // Skip sits in the header, so every step offers it.
                const step = resolveProcessInboxStep(entry.answers, entry.mode, context().plan);
                const checked = current({ ...input, step });
                if (!checked.ok) return checked;
                return commitKind(entry, checked.value.task, 'skip', null);
            });
        },

        /** Close the session. Nothing is written; a write still waiting for its save stays retryable. */
        endInboxProcessing(input: { sessionId: string }): NativeHostResult<null> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.sessionId !== 'string') return fail('INVALID_INPUT', 'A session ID is required');
            const entry = sessions.get(input.sessionId);
            if (entry && owesSave(entry)) entry.ended = true;
            else sessions.delete(input.sessionId);
            return { ok: true, value: null };
        },
    };
}

// ---------------------------------------------------------------------------
// Contexts, Archive, Trash and History. Kept in one block: other changes edit this file in parallel.

/** A success message; `undo`, when set, is the action to send back (with a new requestId) to undo it. */
export type NativeListToast<Action> = {
    tone: 'success' | 'info';
    title: string | null;
    message: string;
    undo: { label: string; action: Action } | null;
};
export type NativeListActionResult<Action> = {
    /** False when the action had nothing to write, as a token edit that changes no task. */
    changed: boolean;
    toast: NativeListToast<Action> | null;
};

export type NativeContextsChip = {
    id: string;
    kind: 'all' | 'none' | 'contexts' | 'tags';
    label: string;
    accessibilityLabel: string;
    count: number;
    selected: boolean;
    /** The selection after tapping this chip. */
    next: { tokens: string[]; matchMode: ContextOrTagMatchMode };
};
export type NativeContextsView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    /** The selection as the screen applies it: an empty selection matches with All. */
    selection: { tokens: string[]; matchMode: ContextOrTagMatchMode };
    searchPlaceholder: string;
    chips: NativeContextsChip[];
    matchMode: { label: string; options: { mode: ContextOrTagMatchMode; label: string; selected: boolean }[] } | null;
    total: number;
    rows: NativeTaskRow[];
    empty: ReturnType<typeof getContextsEmptyState> | null;
    /** The selected ids still on screen; the bulk bar shows while any remain. */
    selectedIds: string[];
    bulk: {
        countLabel: string;
        exitLabel: string;
        statuses: { status: TaskStatus; label: string }[];
        tokenActions: (ContextsTokenPicker & { field: BulkTaskTokenField; mode: BulkTaskTokenMode; enabled: boolean })[];
        deleteLabel: string;
        deleteConfirmation: ListConfirmation;
    } | null;
};
export type NativeContextsAction =
    | { type: 'setTaskStatus'; taskId: string; status: TaskStatus }
    | { type: 'moveTasks'; taskIds: string[]; status: TaskStatus }
    | { type: 'editTaskTokens'; taskIds: string[]; field: BulkTaskTokenField; mode: BulkTaskTokenMode; values: string[] }
    | { type: 'trashTask'; taskId: string }
    | { type: 'trashTasks'; taskIds: string[] }
    | { type: 'restoreTasks'; taskIds: string[] };

/** Archive's view inputs; `filters` is the returned `filters.state`, `filterEdit` one control's edit. */
export type NativeArchiveParams = {
    segment?: ArchiveSegment;
    sortBy?: TaskSortBy;
    groupBy?: ArchiveTaskGroupBy;
    filters?: Partial<ListFilterState>;
    filterEdit?: ListFilterEdit;
    /** Once the sheet is open it offers every token in use; before that, only the chosen ones. */
    filterSheetOpen?: boolean;
    collapsedGroupIds?: string[];
};
/**
 * RN's Select all: every task row on screen (a folded heading hides its rows), less
 * `except`, the rows deselected since. A bulk action resolves it again and refuses
 * with STALE_REVISION once those rows changed, so it acts only on the rows shown.
 */
export type NativeArchiveSelectAll = {
    /** The view's params (filters as returned, no filterEdit). */
    params: Omit<NativeArchiveParams, 'filterEdit'>;
    revision: string;
    except?: string[];
};
export type NativeArchiveItem =
    | { type: 'section'; id: string; title: string; count: number; muted: boolean; collapsible: boolean; collapsed: boolean }
    | {
        type: 'task';
        /** The heading the row sits under; a multi-tag task appears under each of its tags. */
        groupId: string | null;
        row: NativeTaskRow;
        cancelled: boolean;
        /** Completed rows show their title struck through; cancelled ones do not. */
        struck: boolean;
        dateLabel: string;
        descriptionMarkdown: string | null;
        /** Completed rows open a completion time picker at this value. */
        completedAtValue: string | null;
        /** The same start as a local day and time; send the picked ones back with setCompletedAt. Null for cancelled rows. */
        completedAtPicker: { day: string; time: string } | null;
        /** In the bulk selection (selectedIds, or Select all less its except). */
        selected: boolean;
    }
    | {
        type: 'project';
        id: string;
        title: string;
        cancelled: boolean;
        struck: boolean;
        dateLabel: string;
        areaName: string | null;
        indicatorColor: string | null;
        trashConfirmation: ListConfirmation;
    };
export type NativeArchiveView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    segment: ArchiveSegment;
    segments: { id: ArchiveSegment; label: string; selected: boolean }[];
    menu: ArchiveMenu;
    /** Null when the search row is hidden. */
    search: { query: string; placeholder: string } | null;
    /** The filter sheet as the menu views carry it; getArchiveFilterTokens pages its tokens. */
    filters: NativeListFilterView & {
        /** "Filters · 2" beside the search box, or null with no active filter. */
        buttonLabel: string | null;
        /** Deprecated: `chips` below carries each chip's edit. */
        chips: { id: string; label: string; excluded: boolean }[];
        /** Deprecated and unwindowed: use `tokens`. */
        tokenOptions: string[];
        /** Deprecated: use `timeEstimates`. */
        timeEstimateOptions: { value: TimeEstimate; label: string }[];
    };
    /** The active filters; removing one sends its `action.filterEdit`. */
    chips: NativeListChip[];
    summary: string | null;
    total: number;
    items: NativeArchiveItem[];
    /** The task rows a folded heading has not removed: what Select all selects. */
    visibleTaskCount: number;
    /** The explicitly selected rows still on screen (empty under Select all). */
    selectedIds: string[];
    selectedCount: number;
    /** Sent with `selectAll: { except }`: the object a bulk action takes as `selectAll`. Null otherwise. */
    selectAll: NativeArchiveSelectAll | null;
    empty: ReturnType<typeof getArchiveEmptyState> | null;
    labels: ReturnType<typeof getArchiveRowLabels> & { selectAll: string; restoreSelected: string; done: string; selected: string };
    confirmations: { trashTask: ListConfirmation; trashTasks: ListConfirmation };
};
export type NativeArchiveAction =
    | { type: 'moveToInbox'; taskId: string }
    | { type: 'moveTasksToInbox'; taskIds: string[] }
    | { type: 'moveTasksToInbox'; selectAll: NativeArchiveSelectAll }
    | { type: 'setCompletedAt'; taskId: string; completedAt: string }
    /** The picker's local day (yyyy-MM-dd) and time (HH:mm); core stores them as mobile's picker does. */
    | { type: 'setCompletedAt'; taskId: string; day: string; time: string }
    | { type: 'trashTask'; taskId: string }
    | { type: 'trashTasks'; taskIds: string[] }
    | { type: 'trashTasks'; selectAll: NativeArchiveSelectAll }
    | { type: 'restoreTasks'; taskIds: string[] }
    | { type: 'reactivateProject'; projectId: string }
    | { type: 'trashProject'; projectId: string };

export type NativeTrashItem =
    | { type: 'task'; row: NativeTaskRow; typeLabel: string; deletedLabel: string; descriptionMarkdown: string | null }
    | { type: 'project'; id: string; title: string; indicatorColor: string | null; typeLabel: string; deletedLabel: string };
export type NativeTrashView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    /** "4 tasks · 2 projects", or null with an empty Trash. */
    summary: string | null;
    retentionHint: string | null;
    taskCount: number;
    projectCount: number;
    total: number;
    items: NativeTrashItem[];
    selected: { taskIds: string[]; projectIds: string[] };
    empty: ReturnType<typeof getTrashEmptyState> | null;
    labels: ReturnType<typeof getTrashRowLabels> & { done: string; clearAll: string; selectAll: string; restoreSelected: string; deleteSelected: string; selected: string };
    confirmations: { purgeItem: ListConfirmation; purgeSelection: ListConfirmation };
    /** Clear Trash deletes exactly these shown items; send `revision` with emptyTrash. */
    emptyTrash: { revision: string; taskCount: number; projectCount: number; confirmation: ListConfirmation } | null;
};
export type NativeTrashAction =
    | { type: 'restoreItem'; kind: 'task' | 'project'; id: string }
    | { type: 'restoreItems'; taskIds: string[]; projectIds: string[] }
    | { type: 'purgeItem'; kind: 'task' | 'project'; id: string }
    | { type: 'purgeItems'; taskIds: string[]; projectIds: string[] }
    | { type: 'emptyTrash'; revision: string };

/** A list action's answer; SAVE_FAILED carries it when the write landed and only its save failed. */
/** An Archive action once Select all is resolved to its task ids. */
type ResolvedArchiveAction = Exclude<NativeArchiveAction, { selectAll: NativeArchiveSelectAll }>;
type ListActionOutcome<Action> = NativeHostResult<NativeListActionResult<Action>> | NativeUnsavedWrite<NativeListActionResult<Action>>;

type ListViewDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    /** Changes with any data, setting, language, day or minute change. */
    revision: (now: Date) => string;
    /** Changes with any data or setting change: what Clear Trash's scope depends on. */
    dataRevision: () => string;
    rowMeta: (task: Task, now: Date) => TaskRowMeta;
    t: () => (key: string) => string;
    formatDate: () => DateFormatter;
};

const LIST_ID_LIMIT = 10_000;
const TASK_STATUSES: readonly TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)$/;
const isIdList = (value: unknown, allowEmpty = false): value is string[] => (
    Array.isArray(value) && value.length <= LIST_ID_LIMIT && (allowEmpty || value.length > 0)
    && value.every((id) => typeof id === 'string' && id.length > 0) && new Set(value).size === value.length
);
const isStringList = (value: unknown, limit: number): value is string[] => (
    Array.isArray(value) && value.length <= limit && value.every((entry) => typeof entry === 'string' && entry.length <= 500)
);
const isWindow = (input: { offset?: unknown; limit?: unknown; revision?: unknown }) => (
    Number.isSafeInteger(input.offset) && (input.offset as number) >= 0
    && Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= NATIVE_HOST_MAX_WINDOW
    && (input.revision === undefined || typeof input.revision === 'string')
    && ((input.offset as number) === 0 || typeof input.revision === 'string')
);

/** Archive's view inputs with defaults, `filterEdit` applied; null when any is invalid. */
const readArchiveParams = (input: Record<string, unknown>) => {
    const filters = readFilterState(input.filters);
    if (!filters
        || (input.segment !== undefined && !ARCHIVE_SEGMENTS.includes(input.segment as ArchiveSegment))
        || (input.sortBy !== undefined && !DONE_TASK_LIST_SORT_OPTIONS.includes(input.sortBy as TaskSortBy))
        || (input.groupBy !== undefined && !ARCHIVE_TASK_GROUP_OPTIONS.includes(input.groupBy as ArchiveTaskGroupBy))
        || (input.filterSheetOpen !== undefined && typeof input.filterSheetOpen !== 'boolean')
        || (input.collapsedGroupIds !== undefined && !isStringList(input.collapsedGroupIds, 1000))
        || (input.filterEdit !== undefined && !isFilterEdit(input.filterEdit))) {
        return null;
    }
    const edit = input.filterEdit as ListFilterEdit | undefined;
    return {
        segment: (input.segment as ArchiveSegment | undefined) ?? 'tasks',
        sortBy: input.sortBy as TaskSortBy | undefined,
        groupBy: (input.groupBy as ArchiveTaskGroupBy | undefined) ?? 'none',
        filters: edit ? applyListFilterEdit(filters, edit) : filters,
        filterSheetOpen: input.filterSheetOpen === true,
        collapsedGroupIds: (input.collapsedGroupIds as string[] | undefined) ?? [],
    };
};
type ArchiveParams = NonNullable<ReturnType<typeof readArchiveParams>>;

function createListViewMethods(deps: ListViewDeps) {
    // Exact retries, shared with other contract writes through one helper.
    const receipts = createNativeRequestReceipts({
        save: async () => {
            if (useTaskStore.getState().persistenceFailure) {
                try {
                    await useTaskStore.getState().retryPersistence();
                } catch (error) {
                    return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
                }
            }
            return deps.save();
        },
    });
    // One cached view per screen, so paging does not rebuild the list.
    const cache = new Map<string, { key: string; value: unknown }>();
    const cached = <T,>(screen: string, key: string, build: () => T): T => {
        const hit = cache.get(screen);
        if (hit?.key === key) return hit.value as T;
        const value = build();
        cache.set(screen, { key, value });
        return value;
    };

    const areaScope = () => {
        const state = useTaskStore.getState();
        const areas = sortAreasForDisplay(state.areas);
        return {
            state,
            areaById: new Map(areas.map((area) => [area.id, area])),
            projectById: new Map(state.projects.map((project) => [project.id, project])),
            selection: resolveAreaFilterSelection(state.settings.filters, areas),
        };
    };
    const projectTitles = () => new Map(useTaskStore.getState().projects.map((project) => [project.id, project.title]));

    /** Run the screen's store write (one call, or several together): SAVE_FAILED only when it landed. */
    const write = runStoreWrite;
    const liveTask = (id: unknown): Task | undefined => {
        const task = typeof id === 'string' ? useTaskStore.getState()._tasksById.get(id) : undefined;
        return task && !task.deletedAt ? task : undefined;
    };
    const inTrash = (entity: { deletedAt?: string; purgedAt?: string } | undefined) => Boolean(entity?.deletedAt && !entity.purgedAt);
    const trashedTask = (id: unknown) => {
        const task = typeof id === 'string' ? useTaskStore.getState()._tasksById.get(id) : undefined;
        return inTrash(task) ? task : undefined;
    };
    const trashedProject = (id: unknown) => {
        const project = typeof id === 'string' ? useTaskStore.getState()._allProjects.find((entry) => entry.id === id) : undefined;
        return inTrash(project) ? project : undefined;
    };
    const liveProject = (id: unknown) => {
        const project = typeof id === 'string' ? useTaskStore.getState()._projectsById.get(id) : undefined;
        return project && !project.deletedAt ? project : undefined;
    };

    const tasksCountMessage = (count: number, t: (key: string) => string) => formatListItemCount(count, 'task', t);
    const doneToast = <Action,>(count: number, t: (key: string) => string): NativeListToast<Action> => (
        { tone: 'success', title: t('common.done'), message: tasksCountMessage(count, t), undo: null }
    );

    /** The actions Contexts and Archive share, as their mobile handlers write them. */
    const performTaskAction = async (
        screen: 'contexts' | 'archive',
        action: NativeContextsAction | ResolvedArchiveAction,
    ): Promise<ListActionOutcome<NativeContextsAction | NativeArchiveAction> | null> => {
        const t = deps.t();
        const store = () => useTaskStore.getState();
        const missing = (ids: string[]) => ids.some((id) => !liveTask(id));
        switch (action.type) {
            case 'trashTask': {
                if (!liveTask(action.taskId)) return fail('TASK_NOT_FOUND', 'Task not found');
                const written = await write(() => store().deleteTask(action.taskId));
                // Contexts rows offer Undo; Archive asked before deleting and offers none.
                return settleWrite(written, { changed: true, toast: screen === 'contexts' ? {
                    tone: 'info' as const, title: null, message: tFallback(t, 'list.taskDeleted', 'Task deleted'),
                    undo: { label: getTrashUndoLabel(t), action: { type: 'restoreTasks' as const, taskIds: [action.taskId] } },
                } : null });
            }
            case 'trashTasks': {
                if (!isIdList(action.taskIds) || missing(action.taskIds)) return fail('INVALID_INPUT', 'Every task must exist and not be in Trash');
                const written = await write(() => store().batchDeleteTasks(action.taskIds));
                return settleWrite(written, { changed: true, toast: {
                    ...doneToast(action.taskIds.length, t),
                    undo: { label: getTrashUndoLabel(t), action: { type: 'restoreTasks' as const, taskIds: [...action.taskIds] } },
                } });
            }
            case 'restoreTasks': {
                if (!isIdList(action.taskIds) || action.taskIds.some((id) => !trashedTask(id))) {
                    return fail('INVALID_INPUT', 'Every task must be in Trash');
                }
                const written = await write(() => Promise.all(action.taskIds.map((id) => store().restoreTask(id))));
                return settleWrite(written, { changed: true, toast: null });
            }
            default:
                return null;
        }
    };

    /** Archive's rows and filter sheet for these params; paging and Select all reuse one build. */
    const buildArchive = (params: ArchiveParams, revision: string) => cached('archive', JSON.stringify([revision, params]), () => {
        const t = deps.t();
        const { state, areaById, projectById, selection } = areaScope();
        const sortBy = resolveArchiveSortBy(params.sortBy, state.settings);
        const allArchived = filterArchivedTasksByArea(sortArchivedTasks(selectArchivedTasks(state._allTasks), sortBy), selection, projectById, areaById);
        const flags = resolveFeatureFlags(state.settings);
        const visibility = getTaskMetadataFilterVisibility(allArchived, { prioritiesEnabled: flags.priorities, timeEstimatesEnabled: flags.timeEstimates });
        // Mobile's Archive sheet offers no project filter, so no project selection filters it.
        const resolved = resolveListFilterState(params.filters, { visibility, retainProjects: [], t });
        const archivedTasks = allArchived.filter((task) => taskMatchesFilterSelections(task, { criteria: resolved.criteria, searchQuery: resolved.searchQuery }));
        const taskItems = buildArchiveTaskItems({
            groupBy: params.groupBy, tasks: archivedTasks, areas: state.areas, projectById, t, collapsedGroupIds: new Set(params.collapsedGroupIds),
        });
        const visibleIds = getTaskGroupItemIds(taskItems);
        const projects = selectArchivedProjects(state.projects, selection, areaById);
        const options: ListFilterOptions = {
            tokens: getArchiveTokenFilterOptions(allArchived, params.filterSheetOpen, resolved.state),
            projects: null,
            timeEstimates: TIME_ESTIMATE_OPTIONS,
            visibility,
        };
        return {
            taskItems, projects, visibleIds, areaById, resolved, options,
            menu: getArchiveMenu({ sortBy, groupBy: params.groupBy, settings: state.settings }, t),
            labels: getArchiveRowLabels(t),
            tokens: tokenOptions(options, resolved.state),
            archivedCount: allArchived.length,
            shownCount: params.segment === 'tasks' ? archivedTasks.length : projects.length,
            // Select all's rows: any change to them makes its bulk action stale.
            selectAllRevision: `${visibleIds.length}:${paramsKey(visibleIds)}`,
            titles: projectTitles(),
        };
    });

    /** Select all's task ids now, or STALE_REVISION once the rows shown differ from those it was offered for. */
    const resolveSelectAll = (selectAll: unknown): string[] | NativeHostResult<never> => {
        const params = isObjectRecord(selectAll) && isObjectRecord(selectAll.params) && selectAll.params.filterEdit === undefined
            ? readArchiveParams(selectAll.params)
            : null;
        const { revision, except } = (params ? selectAll : {}) as Partial<NativeArchiveSelectAll>;
        if (!params || typeof revision !== 'string' || (except !== undefined && !isIdList(except, true))) {
            return fail('INVALID_INPUT', 'Select all needs the view\'s params, its revision and the rows deselected since');
        }
        const view = buildArchive(params, deps.revision(new Date()));
        if (view.selectAllRevision !== revision) return fail('STALE_REVISION', 'Archive changed; select all again');
        const deselected = new Set(except);
        const ids = view.visibleIds.filter((id) => !deselected.has(id));
        return ids.length > 0 ? ids : fail('INVALID_INPUT', 'Select all selects no task');
    };

    return {
        getContextsView(input: {
            tokens?: string[]; matchMode?: ContextOrTagMatchMode; searchQuery?: string; selectedIds?: string[];
            offset: number; limit: number; revision?: string;
        }): NativeHostResult<NativeContextsView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isWindow(input)
                || (input.tokens !== undefined && !isStringList(input.tokens, 500))
                || (input.matchMode !== undefined && input.matchMode !== 'all' && input.matchMode !== 'any')
                || (input.searchQuery !== undefined && (typeof input.searchQuery !== 'string' || input.searchQuery.length > 2000))
                || (input.selectedIds !== undefined && !isIdList(input.selectedIds, true))) {
                return fail('INVALID_INPUT', 'Valid tokens, match mode, search, selected ids, offset, bounded limit, and revision for later pages are required');
            }
            const now = new Date();
            const revision = deps.revision(now);
            if (input.revision !== undefined && input.revision !== revision) return fail('STALE_REVISION', 'Contexts changed; restart paging from offset zero');
            const t = deps.t();
            const tokens = input.tokens ?? [];
            const matchMode = resolveContextsMatchMode(tokens, input.matchMode ?? 'all');
            const selectedIds = input.selectedIds ?? [];
            const view = cached('contexts', JSON.stringify([revision, tokens, matchMode, input.searchQuery ?? '', selectedIds]), () => {
                const { state, areaById, projectById, selection } = areaScope();
                // Counted once per data change, whatever the selection.
                const index = cached('contexts-index', deps.dataRevision(), () => buildContextsTokenIndex(
                    // Mobile's visible tasks: the store's tasks in the selected area, outside parked projects.
                    state.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter: selection })),
                ));
                const model = buildContextsViewModel({ index, settings: state.settings, selectedTokens: tokens, matchMode, searchQuery: input.searchQuery ?? '' });
                const next = (nextTokens: string[], nextMode: ContextOrTagMatchMode) => ({ tokens: nextTokens, matchMode: resolveContextsMatchMode(nextTokens, nextMode) });
                const labels = getContextsMatchModeLabels(t);
                const onScreen = new Set(model.tasks.map((task) => task.id));
                const selected = selectedIds.filter((id) => onScreen.has(id));
                const tasksById = Object.fromEntries(state.tasks.map((task) => [task.id, task]));
                return {
                    model,
                    selected,
                    chips: [
                        { id: 'all', kind: 'all' as const, label: t('common.all'), accessibilityLabel: t('contexts.all'), count: model.allCount, selected: tokens.length === 0, next: next([], 'all') },
                        { id: 'none', kind: 'none' as const, label: t('contexts.none'), accessibilityLabel: t('contexts.none'), count: model.noContextCount, selected: model.noContextSelected, next: next(toggleContextsNoContext(tokens), 'all') },
                        ...model.tokenChips.map((chip) => ({
                            id: chip.token, kind: chip.kind, label: chip.token, accessibilityLabel: `${chip.token} (${chip.count})`,
                            count: chip.count, selected: chip.selected, next: next(toggleContextsToken(tokens, chip.token), matchMode),
                        })),
                    ],
                    matchMode: model.showMatchMode ? {
                        label: labels.label,
                        options: (['all', 'any'] as const).map((mode) => ({ mode, label: mode === 'all' ? labels.all : labels.any, selected: matchMode === mode })),
                    } : null,
                    empty: model.tasks.length === 0 ? getContextsEmptyState({ hasTokens: model.hasTokens, selectedTokens: tokens }, t) : null,
                    bulk: selected.length === 0 ? null : {
                        countLabel: `${selected.length} ${t('bulk.selected')}`,
                        exitLabel: t('bulk.exitSelect'),
                        statuses: CONTEXTS_BULK_STATUSES.map((status) => ({ status, label: t(`status.${status}`) })),
                        tokenActions: (['tags', 'contexts'] as const).flatMap((field) => (['add', 'remove'] as const).map((mode) => {
                            const picker = getContextsTokenPicker({ field, action: mode, activeTasks: model.activeTasks, selectedIds: selected, tasksById, t });
                            return { ...picker, field, mode, enabled: mode === 'add' || picker.tokens.length > 0 };
                        })),
                        deleteLabel: t('common.delete'),
                        deleteConfirmation: getBulkTrashConfirmation(t),
                    },
                    titles: projectTitles(),
                };
            });
            return { ok: true, value: {
                version: NATIVE_HOST_CONTRACT_VERSION,
                revision,
                selection: { tokens, matchMode },
                searchPlaceholder: t('contexts.search'),
                chips: view.chips,
                matchMode: view.matchMode,
                total: view.model.tasks.length,
                rows: view.model.tasks.slice(input.offset, input.offset + input.limit).map((task) => toNativeTaskRow(task, view.titles, deps.rowMeta(task, now))),
                empty: view.empty,
                selectedIds: view.selected,
                bulk: view.bulk,
            } };
        },

        /**
         * One Contexts action, as the screen's rows and bulk bar write it. Reuse
         * `requestId` to retry: a completed request writes nothing again.
         */
        async runContextsAction(input: { requestId: string; action: NativeContextsAction }): Promise<NativeHostResult<NativeListActionResult<NativeContextsAction>>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isObjectRecord(input.action)) return fail('INVALID_INPUT', 'A request UUID and an action are required');
            const action = input.action as NativeContextsAction;
            return receipts.run(input.requestId, JSON.stringify(['contexts', action]), async () => {
                const shared = await performTaskAction('contexts', action);
                if (shared) return shared as ListActionOutcome<NativeContextsAction>;
                const t = deps.t();
                const store = useTaskStore.getState();
                switch (action.type) {
                    case 'setTaskStatus': {
                        if (!TASK_STATUSES.includes(action.status)) return fail('INVALID_INPUT', 'A task status is required');
                        if (!liveTask(action.taskId)) return fail('TASK_NOT_FOUND', 'Task not found');
                        const written = await write(() => store.updateTask(action.taskId, { status: action.status }));
                        return settleWrite(written, { changed: true, toast: null });
                    }
                    case 'moveTasks': {
                        if (!CONTEXTS_BULK_STATUSES.some((status) => status === action.status)
                            || !isIdList(action.taskIds) || action.taskIds.some((id) => !liveTask(id))) {
                            return fail('INVALID_INPUT', 'A bulk status and tasks that exist are required');
                        }
                        const written = await write(() => store.batchMoveTasks(action.taskIds, action.status));
                        return settleWrite(written, { changed: true, toast: doneToast(action.taskIds.length, t) });
                    }
                    case 'editTaskTokens': {
                        if (!isIdList(action.taskIds) || action.taskIds.some((id) => !liveTask(id))
                            || (action.field !== 'tags' && action.field !== 'contexts') || (action.mode !== 'add' && action.mode !== 'remove')
                            || !isStringList(action.values, 100)) {
                            return fail('INVALID_INPUT', 'Tasks that exist, a tags or contexts field, add or remove, and values are required');
                        }
                        let changed = false;
                        let count = 0;
                        const written = await write(async () => {
                            const outcome = await editContextsTaskTokens(store, {
                                taskIds: action.taskIds,
                                tasksById: Object.fromEntries(store.tasks.map((task) => [task.id, task])),
                                field: action.field, mode: action.mode, values: action.values,
                            });
                            changed = outcome.changed;
                            count = outcome.changed ? outcome.count : 0;
                            return outcome.changed ? outcome.result : undefined;
                        });
                        return settleWrite(written, { changed, toast: changed ? doneToast(count, t) : null });
                    }
                    default:
                        return fail('INVALID_INPUT', 'Contexts does not offer that action');
                }
            });
        },

        /**
         * Archive. Send the returned `filters.state` back as `filters` with a control's
         * `filterEdit`. Bulk selection: `selectedIds`, or after Select all
         * `selectAll: { except }` (the rows deselected since), never both.
         */
        getArchiveView(input: NativeArchiveParams & {
            selectedIds?: string[]; selectAll?: { except?: string[] };
            offset: number; limit: number; revision?: string;
        }): NativeHostResult<NativeArchiveView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const params = isObjectRecord(input) ? readArchiveParams(input) : null;
            if (!params || !isWindow(input)
                || (input.selectedIds !== undefined && !isIdList(input.selectedIds, true))
                || (input.selectAll !== undefined && (!isObjectRecord(input.selectAll) || input.selectedIds !== undefined
                    || (input.selectAll.except !== undefined && !isIdList(input.selectAll.except, true))))) {
                return fail('INVALID_INPUT', 'Valid view options, filters, one selection, offset, bounded limit, and revision for later pages are required');
            }
            const now = new Date();
            const revision = deps.revision(now);
            if (input.revision !== undefined && input.revision !== revision) return fail('STALE_REVISION', 'Archive changed; restart paging from offset zero');
            const t = deps.t();
            const { segment, groupBy } = params;
            const view = buildArchive(params, revision);
            const onScreen = new Set(view.visibleIds);
            const selectAll = input.selectAll;
            const except = (selectAll?.except ?? []).filter((id) => onScreen.has(id));
            const selectedIds = (input.selectedIds ?? []).filter((id) => onScreen.has(id));
            const picked = new Set(selectAll ? except : selectedIds);
            const isSelected = (id: string) => (selectAll ? onScreen.has(id) && !picked.has(id) : picked.has(id));
            const selectedCount = selectAll ? view.visibleIds.length - except.length : selectedIds.length;
            const formatDate = deps.formatDate();
            const { resolved, labels } = view;
            const toItem = (entry: TaskGroupItem | Project): NativeArchiveItem => {
                if (!('type' in entry)) {
                    const row = getArchivedProjectRow(entry, formatDate, view.areaById, labels.notSet);
                    return {
                        type: 'project', id: entry.id, title: entry.title, cancelled: row.cancelled, struck: !row.cancelled,
                        dateLabel: `${row.cancelled ? labels.projectCancelled : labels.completed}: ${row.dateLabel}`,
                        areaName: entry.areaId ? view.areaById.get(entry.areaId)?.name ?? null : null,
                        indicatorColor: row.indicatorColor ?? null,
                        trashConfirmation: getArchiveConfirmation({ kind: 'project', project: entry }, t),
                    };
                }
                if (entry.type === 'section') {
                    // Month headings come from core's global formatter (buildCompletionDateSections), which
                    // this host never configures; name the month with the host's formatter instead.
                    const month = /^completedDate:(\d{4})-(\d{2})$/.exec(entry.id);
                    const title = month ? formatDate(new Date(Number(month[1]), Number(month[2]) - 1, 1), 'LLLL yyyy', entry.title) : entry.title;
                    return { type: 'section', id: entry.id, title, count: entry.count, muted: entry.muted === true, collapsible: entry.collapsible === true, collapsed: entry.collapsed === true };
                }
                const row = getArchivedTaskRow(entry.task, formatDate, labels.notSet);
                return {
                    type: 'task',
                    groupId: entry.groupId ?? null,
                    row: toNativeTaskRow(entry.task, view.titles, deps.rowMeta(entry.task, now)),
                    cancelled: row.cancelled,
                    struck: !row.cancelled,
                    dateLabel: `${row.cancelled ? labels.taskCancelled : labels.completed}: ${row.dateLabel}`,
                    descriptionMarkdown: entry.task.description ? getInlineMarkdownPreview(entry.task.description) : null,
                    completedAtValue: row.cancelled ? null : entry.task.completedAt || entry.task.updatedAt || null,
                    completedAtPicker: row.cancelled ? null : getArchiveCompletedAtPickerStart(entry.task, formatDate, now),
                    selected: isSelected(entry.task.id),
                };
            };
            const entries: (TaskGroupItem | Project)[] = segment === 'tasks' ? view.taskItems : view.projects;
            return { ok: true, value: {
                version: NATIVE_HOST_CONTRACT_VERSION,
                revision,
                segment,
                segments: ARCHIVE_SEGMENTS.map((id) => ({ id, label: getArchiveSegmentLabel(id, t), selected: id === segment })),
                menu: view.menu,
                search: showArchiveSearch(segment, view.archivedCount, resolved.hasActive)
                    ? { query: resolved.searchQuery, placeholder: tFallback(t, 'common.search', 'Search') }
                    : null,
                filters: {
                    ...nativeFilterView(resolved, view.options, view.tokens, null, t),
                    buttonLabel: resolved.hasActive ? `${view.menu.filtersLabel} · ${resolved.activeCount}` : null,
                    chips: resolved.chips.map(({ id, label, excluded }) => ({ id, label, excluded })),
                    tokenOptions: view.options.tokens,
                    timeEstimateOptions: TIME_ESTIMATE_OPTIONS.map((value) => ({ value, label: formatTimeEstimateLabel(value) })),
                },
                chips: resolved.chips.map((chip) => ({ id: chip.id, label: chip.label, excluded: chip.excluded, action: { filterEdit: chip.edit } })),
                summary: getArchiveSummary(segment, view.shownCount, t),
                total: entries.length,
                items: entries.slice(input.offset, input.offset + input.limit).map(toItem),
                visibleTaskCount: view.visibleIds.length,
                selectedIds: selectAll ? [] : selectedIds,
                selectedCount,
                selectAll: selectAll
                    ? {
                        params: { ...(params.sortBy ? { sortBy: params.sortBy } : {}), groupBy, filters: resolved.state, collapsedGroupIds: params.collapsedGroupIds },
                        revision: view.selectAllRevision,
                        except,
                    }
                    : null,
                empty: entries.length === 0
                    ? getArchiveEmptyState({ segment, hasActiveFilters: resolved.hasActive, filterChipLabels: resolved.chips.map((chip) => chip.label) }, t)
                    : null,
                labels: {
                    ...labels,
                    selectAll: `${tFallback(t, 'bulk.select', 'Select')} ${tFallback(t, 'common.all', 'all')}`,
                    restoreSelected: t('trash.restoreToInbox'),
                    done: tFallback(t, 'common.done', 'Done'),
                    selected: `${selectedCount} ${t('bulk.selected')}`,
                },
                confirmations: { trashTask: getArchiveConfirmation({ kind: 'task' }, t), trashTasks: getBulkTrashConfirmation(t) },
            } };
        },

        /**
         * The Archive filter sheet's tokens: a later window, or those matching the
         * picker's search `query` from offset zero. `params` are the view's inputs as
         * last sent (filters as returned, no filterEdit); `revision` is the view's.
         */
        getArchiveFilterTokens(input: {
            params?: Omit<NativeArchiveParams, 'filterEdit'>; query?: string; offset: number; limit: number; revision: string;
        }): NativeHostResult<{ version: typeof NATIVE_HOST_CONTRACT_VERSION; revision: string } & NativeWindow<TokenOption>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const raw: unknown = isObjectRecord(input) && input.params !== undefined ? input.params : {};
            const params = isObjectRecord(raw) && raw.filterEdit === undefined ? readArchiveParams(raw) : null;
            if (!params || typeof input.revision !== 'string' || !isWindow(input)
                || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 500))) {
                return fail('INVALID_INPUT', 'The view\'s params, its revision, a valid window and a short search text are required');
            }
            const revision = deps.revision(new Date());
            if (input.revision !== revision) return fail('STALE_REVISION', 'Archive changed; read it again');
            const { tokens } = buildArchive(params, revision);
            const query = input.query;
            const matches = query === undefined ? tokens : tokens.filter((token) => matchesPickerQuery(token.value, query));
            return {
                ok: true,
                value: { version: NATIVE_HOST_CONTRACT_VERSION, revision, total: matches.length, items: matches.slice(input.offset, input.offset + input.limit) },
            };
        },

        /**
         * One Archive action, as the screen writes it. Reuse `requestId` to retry. A bulk
         * move or trash takes `taskIds` or the view's `selectAll`; setCompletedAt takes
         * an ISO `completedAt` or the picker's local `day` and `time`.
         */
        async runArchiveAction(input: { requestId: string; action: NativeArchiveAction }): Promise<NativeHostResult<NativeListActionResult<NativeArchiveAction>>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isObjectRecord(input.action)) return fail('INVALID_INPUT', 'A request UUID and an action are required');
            const action = input.action as NativeArchiveAction;
            return receipts.run(input.requestId, JSON.stringify(['archive', action]), async () => {
                let resolved = action as ResolvedArchiveAction;
                if ((action.type === 'moveTasksToInbox' || action.type === 'trashTasks') && 'selectAll' in action && action.selectAll !== undefined) {
                    if ('taskIds' in action) return fail('INVALID_INPUT', 'Send taskIds or selectAll, not both');
                    // Resolved inside the receipt: a retry of a landed request never resolves it again.
                    const ids = resolveSelectAll(action.selectAll);
                    if (!Array.isArray(ids)) return ids;
                    resolved = { type: action.type, taskIds: ids };
                }
                const shared = await performTaskAction('archive', resolved);
                if (shared) return shared as ListActionOutcome<NativeArchiveAction>;
                const store = useTaskStore.getState();
                const done = (written: NativeHostResult<null>): ListActionOutcome<NativeArchiveAction> => settleWrite(written, { changed: true, toast: null });
                switch (resolved.type) {
                    case 'moveToInbox': {
                        const { taskId } = resolved;
                        if (!liveTask(taskId)) return fail('TASK_NOT_FOUND', 'Task not found');
                        return done(await write(() => moveArchivedTaskToInbox(store, taskId)));
                    }
                    case 'moveTasksToInbox': {
                        const { taskIds } = resolved;
                        if (!isIdList(taskIds) || taskIds.some((id) => !liveTask(id))) return fail('INVALID_INPUT', 'Tasks that exist are required');
                        return done(await write(() => moveArchivedTasksToInbox(store, taskIds)));
                    }
                    case 'setCompletedAt': {
                        const { taskId } = resolved;
                        const task = liveTask(taskId);
                        if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                        const { completedAt: iso, day, time } = resolved as { completedAt?: unknown; day?: unknown; time?: unknown };
                        const completedAt = iso === undefined
                            ? resolvePickedCompletedAt(day, time)
                            : day === undefined && time === undefined && typeof iso === 'string' && ISO_TIMESTAMP_PATTERN.test(iso) && safeParseDate(iso) ? iso : null;
                        if (!completedAt || isTaskCancelled(task)) {
                            return fail('INVALID_INPUT', 'A completion timestamp, or a local day and time, for a completed task is required');
                        }
                        // Target state: a replay of a time that already landed writes nothing.
                        if (task.completedAt === completedAt) return { ok: true, value: { changed: false, toast: null } };
                        return done(await write(() => setArchivedTaskCompletedAt(store, taskId, completedAt)));
                    }
                    case 'reactivateProject': {
                        const { projectId } = resolved;
                        if (!liveProject(projectId)) return fail('INVALID_INPUT', 'Project is not available');
                        return done(await write(() => reactivateArchivedProject(store, projectId)));
                    }
                    case 'trashProject': {
                        const { projectId } = resolved;
                        if (!liveProject(projectId)) return fail('INVALID_INPUT', 'Project is not available');
                        return done(await write(() => store.deleteProject(projectId)));
                    }
                    default:
                        return fail('INVALID_INPUT', 'Archive does not offer that action');
                }
            });
        },

        getTrashView(input: {
            selected?: { taskIds: string[]; projectIds: string[] }; offset: number; limit: number; revision?: string;
        }): NativeHostResult<NativeTrashView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isWindow(input)
                || (input.selected !== undefined && (!isObjectRecord(input.selected)
                    || !isIdList(input.selected.taskIds, true) || !isIdList(input.selected.projectIds, true)))) {
                return fail('INVALID_INPUT', 'Valid selected ids, offset, bounded limit, and revision for later pages are required');
            }
            const now = new Date();
            const revision = deps.revision(now);
            if (input.revision !== undefined && input.revision !== revision) return fail('STALE_REVISION', 'Trash changed; restart paging from offset zero');
            const t = deps.t();
            const view = cached('trash', JSON.stringify([revision, input.selected]), () => {
                const { state, areaById, projectById, selection } = areaScope();
                const tasks = selectTrashedTasks(state._allTasks, selection, projectById, areaById);
                const projects = selectTrashedProjects(state._allProjects, selection, areaById);
                const taskIds = new Set(tasks.map((task) => task.id));
                const projectIds = new Set(projects.map((project) => project.id));
                return {
                    tasks, projects, areaById,
                    items: buildTrashTimeline(tasks, projects),
                    scope: resolveTrashClearScope(tasks, projects, state._allTasks, state._allProjects),
                    selected: {
                        taskIds: (input.selected?.taskIds ?? []).filter((id) => taskIds.has(id)),
                        projectIds: (input.selected?.projectIds ?? []).filter((id) => projectIds.has(id)),
                    },
                    titles: projectTitles(),
                };
            });
            const formatDate = deps.formatDate();
            const labels = getTrashRowLabels(t);
            const deletedLabel = (deletedAt: string | undefined) => `${labels.deleted}: ${formatTrashDeletedDate(deletedAt, formatDate, labels.notSet)}`;
            const count = view.items.length;
            return { ok: true, value: {
                version: NATIVE_HOST_CONTRACT_VERSION,
                revision,
                summary: count > 0 ? formatTrashCounts(view.tasks.length, view.projects.length, t) : null,
                retentionHint: count > 0 ? getTrashRetentionHint(t) : null,
                taskCount: view.tasks.length,
                projectCount: view.projects.length,
                total: count,
                items: view.items.slice(input.offset, input.offset + input.limit).map((item): NativeTrashItem => (
                    item.type === 'project'
                        ? {
                            type: 'project', id: item.project.id, title: item.project.title, indicatorColor: getProjectAccentColor(item.project, view.areaById) ?? null,
                            typeLabel: labels.projectType, deletedLabel: deletedLabel(item.project.deletedAt),
                        }
                        : {
                            type: 'task', row: toNativeTaskRow(item.task, view.titles, deps.rowMeta(item.task, now)),
                            typeLabel: labels.taskType, deletedLabel: deletedLabel(item.task.deletedAt),
                            descriptionMarkdown: item.task.description ? getInlineMarkdownPreview(item.task.description) : null,
                        }
                )),
                selected: view.selected,
                empty: count === 0 ? getTrashEmptyState(t) : null,
                labels: {
                    ...labels,
                    done: tFallback(t, 'common.done', 'Done'),
                    clearAll: tFallback(t, 'trash.clearAll', 'Clear Trash'),
                    selectAll: `${tFallback(t, 'bulk.select', 'Select')} ${tFallback(t, 'common.all', 'all')}`,
                    restoreSelected: t('trash.restore'),
                    deleteSelected: t('trash.deletePermanently'),
                    selected: `${view.selected.taskIds.length + view.selected.projectIds.length} ${t('bulk.selected')}`,
                },
                confirmations: {
                    purgeItem: getTrashPurgeConfirmation({ kind: 'item' }, t),
                    purgeSelection: getTrashPurgeConfirmation({ kind: 'selection' }, t),
                },
                emptyTrash: count === 0 ? null : {
                    revision: deps.dataRevision(),
                    taskCount: view.scope.taskIds.length,
                    projectCount: view.scope.projectIds.length,
                    confirmation: getTrashPurgeConfirmation({
                        kind: 'clear', narrowed: view.scope.narrowed, taskCount: view.scope.taskIds.length, projectCount: view.scope.projectIds.length,
                    }, t),
                },
            } };
        },

        /**
         * One Trash action, as the screen writes it. Deleting forever uses the store's
         * purge actions, which keep a tombstone for sync, and only reaches items in
         * Trash. `emptyTrash` needs the `emptyTrash.revision` its confirmation showed:
         * it deletes exactly the items shown then, or refuses with STALE_REVISION.
         */
        async runTrashAction(input: { requestId: string; action: NativeTrashAction }): Promise<NativeHostResult<NativeListActionResult<NativeTrashAction>>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isObjectRecord(input.action)) return fail('INVALID_INPUT', 'A request UUID and an action are required');
            const action = input.action as NativeTrashAction;
            return receipts.run(input.requestId, JSON.stringify(['trash', action]), async () => {
                const store = useTaskStore.getState();
                const done = (written: NativeHostResult<null>): ListActionOutcome<NativeTrashAction> => settleWrite(written, { changed: true, toast: null });
                const itemsInTrash = (taskIds: unknown, projectIds: unknown) => isIdList(taskIds, true) && isIdList(projectIds, true)
                    && taskIds.length + projectIds.length > 0
                    && taskIds.every((id) => trashedTask(id)) && projectIds.every((id) => trashedProject(id));
                // The store treats the ids as a set; hand them over in store order, as mobile's Select all does.
                const inStoreOrder = (ids: string[], entities: { id: string }[]) => {
                    const wanted = new Set(ids);
                    return entities.flatMap((entity) => (wanted.has(entity.id) ? [entity.id] : []));
                };
                switch (action.type) {
                    case 'restoreItem':
                    case 'purgeItem': {
                        const found = action.kind === 'task' ? trashedTask(action.id) : action.kind === 'project' ? trashedProject(action.id) : undefined;
                        if (!found) return fail('TASK_NOT_FOUND', 'Item is not in Trash');
                        if (action.type === 'restoreItem') {
                            return done(await write(() => (action.kind === 'task' ? store.restoreTask(action.id) : store.restoreProject(action.id))));
                        }
                        return done(await write(() => (action.kind === 'task' ? store.purgeTask(action.id) : store.purgeProject(action.id))));
                    }
                    case 'restoreItems':
                    case 'purgeItems': {
                        if (!itemsInTrash(action.taskIds, action.projectIds)) return fail('INVALID_INPUT', 'Every item must be in Trash');
                        const ids = { taskIds: inStoreOrder(action.taskIds, store._allTasks), projectIds: inStoreOrder(action.projectIds, store._allProjects) };
                        return done(await write(() => (action.type === 'restoreItems' ? restoreTrashItems(store, ids) : purgeTrashItems(store, ids))));
                    }
                    case 'emptyTrash': {
                        if (typeof action.revision !== 'string') return fail('INVALID_INPUT', 'The Clear Trash revision is required');
                        if (action.revision !== deps.dataRevision()) return fail('STALE_REVISION', 'Trash changed; confirm Clear Trash again');
                        const { state, areaById, projectById, selection } = areaScope();
                        const scope = resolveTrashClearScope(
                            selectTrashedTasks(state._allTasks, selection, projectById, areaById),
                            selectTrashedProjects(state._allProjects, selection, areaById),
                            state._allTasks,
                            state._allProjects,
                        );
                        if (scope.taskIds.length + scope.projectIds.length === 0) return fail('INVALID_INPUT', 'Trash is empty');
                        return done(await write(() => purgeTrashItems(store, scope)));
                    }
                    default:
                        return fail('INVALID_INPUT', 'Trash does not offer that action');
                }
            });
        },

        /** History's Done and Archive tabs; any `tab` but "archived" opens Done. */
        getHistoryView(input: { tab?: string | null } = {}): NativeHostResult<{ tab: HistoryTab; tabs: { id: HistoryTab; label: string; selected: boolean }[] }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || (input.tab != null && typeof input.tab !== 'string')) return fail('INVALID_INPUT', 'tab must be a string');
            const tab = resolveHistoryTab(input.tab);
            return { ok: true, value: { tab, tabs: getHistoryTabs(deps.t()).map((entry) => ({ ...entry, selected: entry.id === tab })) } };
        },
    };
}
