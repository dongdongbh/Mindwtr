import type { ExternalCalendarSubscription } from './ics';

export type TaskStatus = 'inbox' | 'next' | 'waiting' | 'someday' | 'reference' | 'done' | 'archived';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskEnergyLevel = 'low' | 'medium' | 'high';

export type TimeEstimatePreset = '5min' | '10min' | '15min' | '30min' | '1hr' | '2hr' | '3hr' | '4hr' | '4hr+';
export type CustomTimeEstimate = `custom:${number}`;
export type TimeEstimate = TimeEstimatePreset | CustomTimeEstimate;


export type TaskSortBy = 'default' | 'due' | 'start' | 'review' | 'title' | 'timeEstimate' | 'priority' | 'created' | 'created-desc' | 'completed';

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
    seriesId?: string;
    preserveChecklistOnRepeat?: boolean;
    strategy?: RecurrenceStrategy;
    byDay?: RecurrenceByDay[];
    byMonthDay?: number[];
    weekStart?: RecurrenceWeekday;
    count?: number;
    until?: string;
    completedOccurrences?: number;
    anchorDay?: number;
    startAnchorDay?: number;
    dueAnchorDay?: number;
    reviewAnchorDay?: number;
    rrule?: string;
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


export type ProjectFlowMode = 'parallel' | 'sequential' | 'perSection';

export interface Project {
    id: string;
    title: string;
    status: 'active' | 'someday' | 'waiting' | 'archived';
    color: string;
    colorOverride?: string | null;
    order: number;
    tagIds: string[];
    isSequential?: boolean;
    sequentialScope?: ProjectSequentialScope;
    perSectionFlow?: boolean;
    taskSortBy?: TaskSortBy;
    isFocused?: boolean;
    supportNotes?: string;
    attachments?: Attachment[];
    startDate?: string;
    dueDate?: string;
    reviewAt?: string;
    cancelledAt?: string;
    archivedAt?: string;
    areaId?: string;
    areaTitle?: string;
    viewSectionIds?: ViewSectionIds;
    rev?: number;
    revBy?: string;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
    purgedAt?: string;
}

export interface Section {
    id: string;
    projectId: string;
    title: string;
    description?: string;
    order: number;
    isCollapsed?: boolean;
    isSequential?: boolean;
    rev?: number;
    revBy?: string;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
    deletedAtBeforeProjectArchive?: string | null;
    projectArchivedAt?: string;
}

export interface Area {
    id: string;
    name: string;
    color?: string;
    icon?: string;
    order: number;
    rev?: number;
    revBy?: string;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
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
    deletedAt?: string;


    cloudKey?: string;

    fileHash?: string;


    contentRev?: number;


    contentMtimeMs?: number;


    contentSize?: number;


    pendingContentUpload?: boolean;


    staleContentHash?: string;


    localStatus?: 'available' | 'missing' | 'uploading' | 'downloading';
}

export interface ChecklistItem {
    id: string;
    title: string;
    isCompleted: boolean;
}

export type ViewSectionScope = 'someday' | 'waiting' | 'focus';
export type ViewSectionIds = Partial<Record<ViewSectionScope, string>>;

export interface ViewSectionDefinition {
    id: string;
    title: string;
    order: number;
}


export type RelativeStartOffsetUnit = 'minute' | 'hour' | 'day' | 'week';

export interface RelativeStartOffset {

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
    taskMode?: TaskMode;
    startTime?: string;
    relativeStartOffset?: RelativeStartOffset;
    dueDate?: string;
    recurrence?: Recurrence | RecurrenceRule;
    showFutureRecurrence?: boolean;
    pushCount?: number;
    tags: string[];
    contexts: string[];
    checklist?: ChecklistItem[];
    description?: string;
    textDirection?: TextDirection;
    attachments?: Attachment[];
    location?: string;
    projectId?: string;
    sectionId?: string;
    viewSectionIds?: ViewSectionIds;
    areaId?: string;
    isFocusedToday?: boolean;
    timeEstimate?: TimeEstimate;
    timeSpentMinutes?: number;
    reminderPolicy?: TaskReminderPolicy;
    suppressMindwtrReminders?: boolean;
    dueReminderLeadMinutes?: number;
    startReminderLeadMinutes?: number;
    repeatReminderMinutes?: number;
    reviewAt?: string;
    completedAt?: string;
    cancelledAt?: string;
    archivedAt?: string;
    statusBeforeProjectArchive?: TaskStatus;
    completedAtBeforeProjectArchive?: string | null;
    isFocusedTodayBeforeProjectArchive?: boolean | null;
    projectArchivedAt?: string;
    rev?: number;
    revBy?: string;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
    purgedAt?: string;
    order?: number;
    orderNum?: number;
    boardOrder?: number;
    focusOrder?: number;
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
    | { preset: 'today' | 'this_week' | 'this_month' | 'overdue' | 'no_date' | 'next_7_days' | 'overdue_next_7_days' | 'next_14_days' | 'next_30_days' | 'upcoming' }
    | { from?: string; to?: string };

export interface FilterCriteria {
    contexts?: string[];
    contextMatchMode?: MultiValueFilterMatchMode;

    excludedContexts?: string[];
    areas?: string[];
    projects?: string[];

    excludedProjects?: string[];
    tags?: string[];
    tagMatchMode?: MultiValueFilterMatchMode;

    excludedTags?: string[];
    energy?: TaskEnergyLevel[];
    priority?: FilterPriority[];
    dueDateRange?: DateRange;
    startDateRange?: DateRange;

    anyDateRange?: DateRange;
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
import type { Language } from './i18n/i18n-types';

export type AppTheme = 'light' | 'dark' | 'system' | 'system-oled' | 'eink' | 'nord' | 'sepia' | 'material3-light' | 'material3-dark' | 'oled' | 'catppuccin-macchiato' | 'dracula' | 'gruvbox-light' | 'gruvbox-dark';


export type AppLanguage = Language | 'system';
export type MobileQuickAccessView = 'review' | 'projects' | 'calendar' | 'contexts';
export type DefaultTaskAreaMode = 'none' | 'fixed' | 'active';

export interface GtdSettings {
    timeEstimatePresets?: TimeEstimate[];
    taskEditor?: TaskEditorSettings;
    autoArchiveDays?: number;
    archiveRetentionDays?: number;
    defaultCaptureMethod?: 'text' | 'audio';
    defaultAreaMode?: DefaultTaskAreaMode;
    defaultAreaId?: string | null;
    focusTaskLimit?: number;
    focusIncludeStartDates?: boolean;
    focusGroupBy?: FocusGroupBy;
    focusGroupByDefaultsVersion?: number;
    defaultProjectFlowMode?: DefaultProjectFlowMode;
    viewSections?: Partial<Record<ViewSectionScope, ViewSectionDefinition[]>>;
    defaultScheduleTime?: string;
    saveAudioAttachments?: boolean;


    naturalLanguageDates?: boolean;
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


        completionAlert?: boolean;
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
    timeline?: boolean;
}

export interface AppearanceSettings {
    density?: 'comfortable' | 'compact' | 'condensed';
    textSize?: 'small' | 'default' | 'large' | 'extra-large';

    fontFamily?: string;
    showTaskAge?: boolean;
    showFutureStarts?: boolean;
    unassignedAreaColor?: string;
    mobileQuickAccessView?: MobileQuickAccessView;
    areaFilterStyle?: 'list' | 'chips';
}

export interface CalendarSettings {
    viewMode?: 'month' | 'day' | 'week' | 'schedule';
    weekVisibleDays?: number;


    showCompleted?: boolean;
}

export interface WindowSettings {
    decorations?: boolean;
    closeBehavior?: 'ask' | 'tray' | 'quit';
    launchAtStartup?: boolean;
    showTray?: boolean;
}

export type TaskReminderPolicy = 'inherit' | 'send' | 'skip';
export type TaskReminderDefault = 'send' | 'skip';

export interface NotificationSettings {
    taskReminderDefault?: TaskReminderDefault;
    notificationsEnabled?: boolean;
    undoNotificationsEnabled?: boolean;
    startDateNotificationsEnabled?: boolean;
    dueDateNotificationsEnabled?: boolean;
    reviewAtNotificationsEnabled?: boolean;
    dailyDigestMorningEnabled?: boolean;
    dailyDigestMorningTime?: string;
    dailyDigestEveningEnabled?: boolean;
    dailyDigestEveningTime?: string;
    weeklyReviewEnabled?: boolean;
    weeklyReviewDay?: number;
    weeklyReviewTime?: string;
}

export interface AiSettings {
    enabled?: boolean;
    provider?: 'gemini' | 'openai' | 'anthropic';
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    openAIExtraBodyParams?: Record<string, unknown>;


    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    thinkingBudget?: number;
    copilotModel?: string;
    requestTimeoutSeconds?: number;
    speechToText?: SpeechToTextSettings;
}

export interface SpeechToTextSettings {
    enabled?: boolean;
    provider?: 'openai' | 'gemini' | 'whisper' | 'parakeet';
    model?: string;


    baseUrl?: string;
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

export interface SupportPromptSettings {
    lastShownAt?: string;
}


export type MobileAppLockRelockDelayMinutes = 0 | 1 | 5 | 15;

export interface SecuritySettings {
    mobileAppLockEnabled?: boolean;

    mobileAppLockRelockDelayMinutes?: MobileAppLockRelockDelayMinutes;
    mobileAppLockRelockDelayUpdatedAt?: string;
}

export interface NetworkSettings {
    proxyUrl?: string;
}

export interface FilterSettings {

    areaId?: string;
    areaIds?: string[];
    excludedAreaIds?: string[];
}

export interface MigrationSettings {
    version?: number;


    lastAutoArchiveAt?: string;
    lastTombstoneCleanupAt?: string;


    legacyReferenceRecoveryVersion?: number;
}

export interface TaxonomyCatalogEntry {
    token: string;
    rev: number;
    revBy: string;
    updatedAt: string;
    deletedAt?: string;
}

export interface TaxonomyCatalog {
    contexts?: TaxonomyCatalogEntry[];
    tags?: TaxonomyCatalogEntry[];
}

export interface AppSettings extends NotificationSettings {
    taxonomy?: TaxonomyCatalog;
    gtd?: GtdSettings;
    attachments?: AttachmentSettings;
    features?: FeatureSettings;
    appearance?: AppearanceSettings;
    theme?: AppTheme;
    language?: AppLanguage;
    weekStart?: 'system' | 'monday' | 'sunday' | 'saturday';
    dateFormat?: string;
    calendarSystem?: string;
    timeFormat?: string;
    syncPreferences?: SettingsSyncPreferences;
    syncPreferencesUpdatedAt?: SettingsSyncUpdatedAt;
    externalCalendars?: ExternalCalendarSubscription[];
    calendar?: CalendarSettings;
    keybindingStyle?: 'vim' | 'emacs' | 'standard';
    globalQuickAddShortcut?: string;


    quickAddAutoClean?: boolean;


    markdownEditorAssist?: boolean;
    window?: WindowSettings;
    ai?: AiSettings;
    savedSearches?: SavedSearch[];

    savedSearchesUpdatedAt?: string;
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


    analyticsProfileId?: string;

    supportPrompt?: SupportPromptSettings;
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
