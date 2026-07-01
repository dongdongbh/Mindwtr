import type { ExternalCalendarSubscription } from './ics';

export type TaskStatus = 'inbox' | 'next' | 'waiting' | 'someday' | 'reference' | 'done' | 'archived';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskEnergyLevel = 'low' | 'medium' | 'high';

export type TimeEstimatePreset = '5min' | '10min' | '15min' | '30min' | '1hr' | '2hr' | '3hr' | '4hr' | '4hr+';
export type CustomTimeEstimate = `custom:${number}`;
export type TimeEstimate = TimeEstimatePreset | CustomTimeEstimate;

export type TaskSortBy = 'default' | 'due' | 'start' | 'review' | 'title' | 'created' | 'created-desc';

export type TaskMode = 'task' | 'list';

export type FocusGroupBy = 'none' | 'context' | 'project' | 'area' | 'energy' | 'priority' | 'person' | 'tag';

export type RecurrenceRule = 'daily' | 'weekly' | 'monthly' | 'yearly';

export type RecurrenceStrategy = 'strict' | 'fluid';

export type TextDirection = 'auto' | 'ltr' | 'rtl';

export type RecurrenceWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export type RecurrenceByDay =
    | RecurrenceWeekday
    | `${'1' | '2' | '3' | '4' | '-1'}${RecurrenceWeekday}`;

export type SettingsSyncGroup = 'appearance' | 'language' | 'gtd' | 'externalCalendars' | 'ai' | 'savedFilters';

export type SettingsSyncPreferences = Partial<Record<SettingsSyncGroup, boolean>>;

export type SettingsSyncUpdatedAt = Partial<Record<SettingsSyncGroup | 'preferences', string>>;

export interface Recurrence {
    rule: RecurrenceRule;
    strategy?: RecurrenceStrategy; // Defaults to 'strict'
    byDay?: RecurrenceByDay[]; // Explicit weekdays for weekly/monthly recurrences
    byMonthDay?: number[]; // Explicit month days for monthly recurrences
    weekStart?: RecurrenceWeekday; // RFC 5545 WKST for weekly interval anchoring
    count?: number; // Total occurrences in the series, including the current task
    until?: string; // ISO date/datetime when the series should stop
    completedOccurrences?: number; // Internal counter used to preserve COUNT across generated tasks
    anchorDay?: number; // Original day-of-month anchor for clamped monthly/yearly recurrences
    startAnchorDay?: number; // Field-specific anchor for startTime when it differs from dueDate
    dueAnchorDay?: number; // Field-specific anchor for dueDate
    reviewAnchorDay?: number; // Field-specific anchor for reviewAt
    rrule?: string; // Optional RFC 5545 fragment (e.g. FREQ=WEEKLY;BYDAY=MO,WE)
}

export type TaskEditorFieldId =
    | 'status'
    | 'project'
    | 'section'
    | 'area'
    | 'priority'
    | 'energyLevel'
    | 'assignedTo'
    | 'contexts'
    | 'tags'
    | 'location'
    | 'timeEstimate'
    | 'recurrence'
    | 'startTime'
    | 'dueDate'
    | 'reviewAt'
    | 'description'
    | 'textDirection'
    | 'attachments'
    | 'checklist';

export type TaskEditorSectionId = 'basic' | 'scheduling' | 'organization' | 'details';
export type TaskEditorPresentation = 'inline' | 'modal';

export type InboxProcessingMode = 'guided' | 'quick';

export type DefaultProjectFlowMode = 'parallel' | 'sequential';

export type ProjectSequentialScope = 'project' | 'section';

export interface Project {
    id: string;
    title: string;
    status: 'active' | 'someday' | 'waiting' | 'archived';
    color: string;
    order: number; // Sort order within an Area
    tagIds: string[]; // Array of Tag IDs
    isSequential?: boolean; // If true, only first incomplete task shows in Next Actions
    sequentialScope?: ProjectSequentialScope; // 'project' = one stream, 'section' = first incomplete task per section
    isFocused?: boolean; // If true, this project is a priority focus (max 5 allowed)
    supportNotes?: string;
    attachments?: Attachment[];
    dueDate?: string; // Optional project deadline/target date (ISO date or datetime).
    reviewAt?: string; // Tickler/review date (ISO string). If set, project is due for review at/after this time.
    areaId?: string;
    areaTitle?: string;
    rev?: number; // Monotonic revision counter for sync conflict resolution
    revBy?: string; // Device identifier that issued the revision
    createdAt: string;
    updatedAt: string;
    deletedAt?: string; // Soft-delete: if set, this item is considered deleted
    purgedAt?: string; // Permanently removed from Trash, kept for sync tombstone
}

export interface Section {
    id: string;
    projectId: string;
    title: string;
    description?: string;
    order: number; // Sort order within a Project
    isCollapsed?: boolean;
    rev?: number; // Monotonic revision counter for sync conflict resolution
    revBy?: string; // Device identifier that issued the revision
    createdAt: string;
    updatedAt: string;
    deletedAt?: string; // Soft-delete: if set, this item is considered deleted
    deletedAtBeforeProjectArchive?: string | null; // Original deletion timestamp when project archive hid this section.
    projectArchivedAt?: string; // Archive timestamp used to identify reversible project-archive mutations.
}

export interface Area {
    id: string;
    name: string;
    color?: string; // Hex code
    icon?: string; // Emoji or icon name
    order: number; // For sorting in the sidebar
    rev?: number; // Monotonic revision counter for sync conflict resolution
    revBy?: string; // Device identifier that issued the revision
    createdAt: string;
    updatedAt: string;
    deletedAt?: string; // Soft-delete tombstone for cross-device area deletion
}

export interface Person {
    id: string;
    name: string;
    note?: string;
    referenceLink?: string;
    rev?: number;
    revBy?: string;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
}

export type AttachmentKind = 'file' | 'link';

export interface Attachment {
    id: string;
    kind: AttachmentKind;
    title: string;
    uri: string;
    mimeType?: string;
    size?: number;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string; // Soft-delete: if set, this attachment is considered deleted
    /**
     * Relative path on the sync server, e.g., "attachments/123-456.png".
     * If undefined, the file has not been uploaded yet.
     */
    cloudKey?: string;
    /** Optional hash (e.g., SHA-256) for integrity checks. */
    fileHash?: string;
    /**
     * Local availability/transfer status. Persisted locally, but not synced to remote.
     * - available: File exists at `uri`
     * - missing: Metadata exists, file not found at `uri`
     * - uploading/downloading: Transfer in progress
     */
    localStatus?: 'available' | 'missing' | 'uploading' | 'downloading';
}

export interface ChecklistItem {
    id: string;
    title: string;
    isCompleted: boolean;
}


export type RelativeStartOffsetUnit = 'minute' | 'hour' | 'day' | 'week';

export interface RelativeStartOffset {
    /** Negative offset from dueDate; e.g. -3 day means start three days before due. */
    amount: number;
    unit: RelativeStartOffsetUnit;
}

export interface Task {
    id: string;
    title: string;
    status: TaskStatus;
    priority?: TaskPriority;
    energyLevel?: TaskEnergyLevel;
    assignedTo?: string;
    taskMode?: TaskMode; // 'list' for checklist-first tasks
    startTime?: string; // ISO date string
    relativeStartOffset?: RelativeStartOffset; // Offset from dueDate that recomputes startTime when dueDate changes
    dueDate?: string; // ISO date string
    recurrence?: Recurrence | RecurrenceRule; // Legacy string inputs are normalized to Recurrence on load/store writes
    showFutureRecurrence?: boolean; // Calendar-only preview of the next recurrence; does not create a real task.
    pushCount?: number; // Tracks how many times dueDate was pushed later
    tags: string[];
    contexts: string[]; // e.g., '@home', '@work'
    checklist?: ChecklistItem[]; // Subtasks/Shopping list items
    description?: string;
    textDirection?: TextDirection;
    attachments?: Attachment[];
    location?: string;
    projectId?: string;
    sectionId?: string;
    areaId?: string;
    isFocusedToday?: boolean; // Marked as today's focus list.
    timeEstimate?: TimeEstimate; // Estimated time to complete
    suppressMindwtrReminders?: boolean; // If true, skip Mindwtr start/due reminders for this task.
    repeatReminderMinutes?: number; // Repeat the due-time reminder every N minutes (presets 5|10|15|30|60). Absent/0 = off. Due-time only.
    reviewAt?: string; // Tickler/review date (ISO string). If set, task is due for review at/after this time.
    completedAt?: string; // ISO timestamp when task was last completed/archived.
    statusBeforeProjectArchive?: TaskStatus; // Original status when a project archive auto-completed this task.
    completedAtBeforeProjectArchive?: string | null; // Original completion timestamp before project archive auto-completion.
    isFocusedTodayBeforeProjectArchive?: boolean | null; // Original focus flag before project archive auto-completion.
    projectArchivedAt?: string; // Archive timestamp used to identify reversible project-archive mutations.
    rev?: number; // Monotonic revision counter for sync conflict resolution
    revBy?: string; // Device identifier that issued the revision
    createdAt: string;
    updatedAt: string;
    deletedAt?: string; // Soft-delete: if set, this item is considered deleted
    purgedAt?: string; // Permanently removed from trash, kept for sync tombstone
    order?: number; // Manual ordering within a project (for sequential projects)
    orderNum?: number; // Legacy alias kept for backward compatibility with older payloads
    boardOrder?: number; // Manual ordering within a Board status column; cleared on status change
}

export interface SavedSearch {
    id: string;
    name: string;
    query: string;
    sort?: string;
    groupBy?: string;
}

export type SavedFilterView = 'focus' | 'next' | 'waiting' | 'someday' | 'contexts' | 'all';

export type SortField =
    | TaskSortBy
    | 'priority'
    | 'energy'
    | 'timeEstimate'
    | 'project'
    | 'updated';

export type FilterPriority = 'none' | TaskPriority;

export type MultiValueFilterMatchMode = 'any' | 'all';

export type DateRange =
    | { preset: 'today' | 'this_week' | 'this_month' | 'overdue' | 'no_date' }
    | { from?: string; to?: string };

export interface FilterCriteria {
    contexts?: string[];
    contextMatchMode?: MultiValueFilterMatchMode;
    areas?: string[];
    projects?: string[];
    tags?: string[];
    energy?: TaskEnergyLevel[];
    priority?: FilterPriority[];
    dueDateRange?: DateRange;
    startDateRange?: DateRange;
    statuses?: TaskStatus[];
    assignedTo?: string[];
    locations?: string[];
    timeEstimateRange?: { min?: number; max?: number };
    timeEstimates?: TimeEstimate[];
    hasDescription?: boolean;
    isStarred?: boolean;
}

export interface SavedFilter {
    id: string;
    name: string;
    icon?: string;
    view: SavedFilterView;
    criteria: FilterCriteria;
    sortBy?: SortField;
    sortOrder?: 'asc' | 'desc';
    groupBy?: FocusGroupBy;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
}

export interface PendingRemoteAttachmentDelete {
    cloudKey: string;
    title?: string;
    attempts?: number;
    lastErrorAt?: string;
}

import type { MergeStats, SyncHistoryEntry } from './sync';

export type AppTheme = 'light' | 'dark' | 'system' | 'eink' | 'nord' | 'sepia' | 'material3-light' | 'material3-dark' | 'oled';
export type AppLanguage = 'en' | 'vi' | 'zh' | 'zh-Hant' | 'es' | 'hi' | 'ar' | 'de' | 'ru' | 'ja' | 'fr' | 'pt' | 'pl' | 'ko' | 'cs' | 'it' | 'tr' | 'nl' | 'system';
export type MobileQuickAccessView = 'review' | 'projects' | 'calendar' | 'contexts';

export interface GtdSettings {
    timeEstimatePresets?: TimeEstimate[];
    taskEditor?: TaskEditorSettings;
    autoArchiveDays?: number;
    defaultCaptureMethod?: 'text' | 'audio';
    defaultAreaId?: string | null;
    focusTaskLimit?: number;
    focusGroupBy?: FocusGroupBy;
    focusGroupByDefaultsVersion?: number;
    defaultProjectFlowMode?: DefaultProjectFlowMode;
    defaultScheduleTime?: string; // HH:mm, used to prefill manual scheduling fields.
    saveAudioAttachments?: boolean;
    inboxProcessing?: {
        defaultMode?: InboxProcessingMode;
        twoMinuteEnabled?: boolean;
        twoMinuteFirst?: boolean;
        projectFirst?: boolean;
        contextStepEnabled?: boolean;
        scheduleEnabled?: boolean;
        referenceEnabled?: boolean;
    };
    weeklyReview?: {
        includeContextStep?: boolean;
    };
    dailyReview?: {
        includeFocusStep?: boolean;
    };
    pomodoro?: {
        customDurations?: {
            focusMinutes?: number;
            breakMinutes?: number;
        };
        linkTask?: boolean;
        autoStartBreaks?: boolean;
        autoStartFocus?: boolean;
    };
}

export interface TaskEditorSettings {
    order?: TaskEditorFieldId[];
    hidden?: TaskEditorFieldId[];
    sections?: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>;
    sectionOpen?: Partial<Record<TaskEditorSectionId, boolean>>;
    presentation?: TaskEditorPresentation;
    defaultsVersion?: number;
}

export interface AttachmentSettings {
    lastCleanupAt?: string;
    pendingRemoteDeletes?: PendingRemoteAttachmentDelete[];
}

export interface FeatureSettings {
    priorities?: boolean;
    timeEstimates?: boolean;
    pomodoro?: boolean;
}

export interface AppearanceSettings {
    density?: 'comfortable' | 'compact';
    textSize?: 'small' | 'default' | 'large' | 'extra-large';
    showTaskAge?: boolean;
    showFutureStarts?: boolean;
    unassignedAreaColor?: string;
    mobileQuickAccessView?: MobileQuickAccessView;
}

export interface CalendarSettings {
    viewMode?: 'month' | 'day' | 'week' | 'schedule';
    weekVisibleDays?: number;
}

export interface WindowSettings {
    decorations?: boolean;
    closeBehavior?: 'ask' | 'tray' | 'quit';
    launchAtStartup?: boolean;
    showTray?: boolean;
}

export interface NotificationSettings {
    notificationsEnabled?: boolean;
    undoNotificationsEnabled?: boolean;
    startDateNotificationsEnabled?: boolean;
    dueDateNotificationsEnabled?: boolean;
    reviewAtNotificationsEnabled?: boolean;
    dailyDigestMorningEnabled?: boolean;
    dailyDigestMorningTime?: string; // HH:mm
    dailyDigestEveningEnabled?: boolean;
    dailyDigestEveningTime?: string; // HH:mm
    weeklyReviewEnabled?: boolean;
    weeklyReviewDay?: number; // 0 = Sunday
    weeklyReviewTime?: string; // HH:mm
}

export interface AiSettings {
    enabled?: boolean;
    provider?: 'gemini' | 'openai' | 'anthropic';
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    openAIExtraBodyParams?: Record<string, unknown>;
    // Mirrors AIReasoningEffort (kept inline to avoid a types <-> ai/types import cycle).
    // 'minimal' is used internally for the low-latency copilot path; the main-model
    // settings UI exposes low/medium/high.
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    thinkingBudget?: number;
    copilotModel?: string;
    speechToText?: SpeechToTextSettings;
}

export interface SpeechToTextSettings {
    enabled?: boolean;
    provider?: 'openai' | 'gemini' | 'whisper' | 'parakeet';
    model?: string;
    language?: string;
    mode?: 'smart_parse' | 'transcribe_only';
    fieldStrategy?: 'smart' | 'title_only' | 'description_only';
    offlineModelPath?: string;
}

export interface DiagnosticsSettings {
    loggingEnabled?: boolean;
}

export interface AnalyticsSettings {
    heartbeatEnabled?: boolean;
}

export interface SecuritySettings {
    mobileAppLockEnabled?: boolean;
}

export interface NetworkSettings {
    proxyUrl?: string;
}

export interface FilterSettings {
    areaId?: string;
}

export interface MigrationSettings {
    version?: number;
    lastAutoArchiveAt?: string;
    lastTombstoneCleanupAt?: string;
}

export interface AppSettings extends NotificationSettings {
    gtd?: GtdSettings;
    attachments?: AttachmentSettings;
    features?: FeatureSettings;
    appearance?: AppearanceSettings;
    theme?: AppTheme;
    language?: AppLanguage;
    weekStart?: 'monday' | 'sunday' | 'saturday';
    dateFormat?: string;
    calendarSystem?: string;
    timeFormat?: string;
    syncPreferences?: SettingsSyncPreferences;
    syncPreferencesUpdatedAt?: SettingsSyncUpdatedAt;
    externalCalendars?: ExternalCalendarSubscription[];
    calendar?: CalendarSettings;
    keybindingStyle?: 'vim' | 'emacs';
    globalQuickAddShortcut?: string;
    // Quick-add: when true, recognized tokens (dates, tags, contexts) are removed
    // from the title after being applied. Default (unset) preserves text as typed
    // and only copies metadata out, so pasted URLs/notes are never mangled (#742).
    quickAddAutoClean?: boolean;
    // Markdown editor typing helpers (bracket/backtick auto-pairing, list
    // continuation, reference autocomplete). Default on; false types plain text
    // without the editor injecting characters (#742).
    markdownEditorAssist?: boolean;
    window?: WindowSettings;
    ai?: AiSettings;
    savedSearches?: SavedSearch[];
    savedFilters?: SavedFilter[];
    sidebarCollapsed?: boolean;
    taskSortBy?: TaskSortBy;
    lastSyncAt?: string;
    lastSyncStatus?: 'idle' | 'syncing' | 'success' | 'error' | 'conflict';
    lastSyncError?: string;
    pendingRemoteWriteAt?: string;
    pendingRemoteWriteRetryAt?: string;
    pendingRemoteWriteAttempts?: number;
    lastSyncStats?: MergeStats;
    lastSyncHistory?: SyncHistoryEntry[];
    diagnostics?: DiagnosticsSettings;
    analytics?: AnalyticsSettings;
    security?: SecuritySettings;
    network?: NetworkSettings;
    filters?: FilterSettings;
    deviceId?: string;
    migrations?: MigrationSettings;
}

export interface AppData {
    tasks: Task[];
    projects: Project[];
    sections: Section[];
    areas: Area[];
    people?: Person[];
    settings: AppSettings;
}
