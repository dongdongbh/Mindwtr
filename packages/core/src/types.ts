import type { ExternalCalendarSubscription } from './ics';

export type TaskStatus = 'inbox' | 'next' | 'waiting' | 'someday' | 'reference' | 'done' | 'archived';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type TimeEstimate = '5min' | '10min' | '15min' | '30min' | '1hr' | '2hr' | '3hr' | '4hr' | '4hr+';

export type TaskSortBy = 'default' | 'due' | 'start' | 'review' | 'title' | 'created' | 'created-desc';

export type TaskMode = 'task' | 'list';

export type RecurrenceRule = 'daily' | 'weekly' | 'monthly' | 'yearly';

export type RecurrenceStrategy = 'strict' | 'fluid';

export type TextDirection = 'auto' | 'ltr' | 'rtl';

export type RecurrenceWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export type RecurrenceByDay =
    | RecurrenceWeekday
    | `${'1' | '2' | '3' | '4' | '-1'}${RecurrenceWeekday}`;

export type SettingsSyncGroup = 'appearance' | 'language' | 'externalCalendars' | 'ai';

export type SettingsSyncPreferences = Partial<Record<SettingsSyncGroup, boolean>>;

export type SettingsSyncUpdatedAt = Partial<Record<SettingsSyncGroup | 'preferences', string>>;

export interface Recurrence {
    rule: RecurrenceRule;
    strategy?: RecurrenceStrategy; // Defaults to 'strict'
    byDay?: RecurrenceByDay[]; // Explicit weekdays for weekly/monthly recurrences
    rrule?: string; // Optional RFC 5545 fragment (e.g. FREQ=WEEKLY;BYDAY=MO,WE)
}

export type TaskEditorFieldId =
    | 'status'
    | 'project'
    | 'section'
    | 'area'
    | 'priority'
    | 'contexts'
    | 'tags'
    | 'timeEstimate'
    | 'recurrence'
    | 'startTime'
    | 'dueDate'
    | 'reviewAt'
    | 'description'
    | 'textDirection'
    | 'attachments'
    | 'checklist';

export interface Project {
    id: string;
    title: string;
    status: 'active' | 'someday' | 'waiting' | 'archived';
    color: string;
    order: number; // Sort order within an Area
    tagIds: string[]; // Array of Tag IDs
    isSequential?: boolean; // If true, only first incomplete task shows in Next Actions
    isFocused?: boolean; // If true, this project is a priority focus (max 5 allowed)
    supportNotes?: string;
    attachments?: Attachment[];
    reviewAt?: string; // Tickler/review date (ISO string). If set, project is due for review at/after this time.
    areaId?: string;
    areaTitle?: string;
    rev?: number; // Monotonic revision counter for sync conflict resolution
    revBy?: string; // Device identifier that issued the revision
    createdAt: string;
    updatedAt: string;
    deletedAt?: string; // Soft-delete: if set, this item is considered deleted
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
}

export interface Area {
    id: string;
    name: string;
    color?: string; // Hex code
    icon?: string; // Emoji or icon name
    order: number; // For sorting in the sidebar
    rev?: number; // Monotonic revision counter for sync conflict resolution
    revBy?: string; // Device identifier that issued the revision
    createdAt?: string;
    updatedAt?: string;
    deletedAt?: string; // Soft-delete tombstone for cross-device area deletion
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
     * Local runtime status (not synced to remote).
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

export interface Task {
    id: string;
    title: string;
    status: TaskStatus;
    priority?: TaskPriority;
    taskMode?: TaskMode; // 'list' for checklist-first tasks
    startTime?: string; // ISO date string
    dueDate?: string; // ISO date string
    recurrence?: Recurrence | RecurrenceRule;
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
    isFocusedToday?: boolean; // Marked as today's priority (Top 3 focus)
    timeEstimate?: TimeEstimate; // Estimated time to complete
    reviewAt?: string; // Tickler/review date (ISO string). If set, task is due for review at/after this time.
    completedAt?: string; // ISO timestamp when task was last completed/archived.
    rev?: number; // Monotonic revision counter for sync conflict resolution
    revBy?: string; // Device identifier that issued the revision
    createdAt: string;
    updatedAt: string;
    deletedAt?: string; // Soft-delete: if set, this item is considered deleted
    purgedAt?: string; // Permanently removed from trash, kept for sync tombstone
    orderNum?: number; // Manual ordering within a project (for sequential projects)
}

export interface SavedSearch {
    id: string;
    name: string;
    query: string;
    sort?: string;
    groupBy?: string;
}

export interface PendingRemoteAttachmentDelete {
    cloudKey: string;
    title?: string;
    attempts?: number;
    lastErrorAt?: string;
}

import type { MergeStats, SyncHistoryEntry } from './sync';

export interface AppData {
    tasks: Task[];
    projects: Project[];
    sections: Section[];
    areas: Area[];
    settings: {
        gtd?: {
            timeEstimatePresets?: TimeEstimate[];
            taskEditor?: {
                order?: TaskEditorFieldId[];
                hidden?: TaskEditorFieldId[];
                defaultsVersion?: number;
            };
            autoArchiveDays?: number;
            defaultCaptureMethod?: 'text' | 'audio';
            saveAudioAttachments?: boolean;
            inboxProcessing?: {
                twoMinuteFirst?: boolean;
                projectFirst?: boolean;
                scheduleEnabled?: boolean;
            };
            weeklyReview?: {
                includeContextStep?: boolean;
            };
        };
        attachments?: {
            lastCleanupAt?: string;
            pendingRemoteDeletes?: PendingRemoteAttachmentDelete[];
        };
        features?: {
            priorities?: boolean;
            timeEstimates?: boolean;
            pomodoro?: boolean;
        };
        appearance?: {
            density?: 'comfortable' | 'compact';
        };
        theme?: 'light' | 'dark' | 'system' | 'eink' | 'nord' | 'sepia' | 'material3-light' | 'material3-dark' | 'oled';
        language?: 'en' | 'zh' | 'es' | 'hi' | 'ar' | 'de' | 'ru' | 'ja' | 'fr' | 'pt' | 'pl' | 'ko' | 'it' | 'tr' | 'system';
        weekStart?: 'monday' | 'sunday';
        dateFormat?: string;
        syncPreferences?: SettingsSyncPreferences;
        syncPreferencesUpdatedAt?: SettingsSyncUpdatedAt;
        externalCalendars?: ExternalCalendarSubscription[];
        keybindingStyle?: 'vim' | 'emacs';
        globalQuickAddShortcut?: string;
        window?: {
            decorations?: boolean;
            closeBehavior?: 'ask' | 'tray' | 'quit';
            showTray?: boolean;
        };
        notificationsEnabled?: boolean;
        reviewAtNotificationsEnabled?: boolean;
        dailyDigestMorningEnabled?: boolean;
        dailyDigestMorningTime?: string; // HH:mm
        dailyDigestEveningEnabled?: boolean;
        dailyDigestEveningTime?: string; // HH:mm
        weeklyReviewEnabled?: boolean;
        weeklyReviewDay?: number; // 0 = Sunday
        weeklyReviewTime?: string; // HH:mm
        ai?: {
            enabled?: boolean;
            provider?: 'gemini' | 'openai' | 'anthropic';
            apiKey?: string;
            baseUrl?: string;
            model?: string;
            reasoningEffort?: 'low' | 'medium' | 'high';
            thinkingBudget?: number;
            copilotModel?: string;
            speechToText?: {
                enabled?: boolean;
                provider?: 'openai' | 'gemini' | 'whisper';
                model?: string;
                language?: string;
                mode?: 'smart_parse' | 'transcribe_only';
                fieldStrategy?: 'smart' | 'title_only' | 'description_only';
                offlineModelPath?: string;
            };
        };
        savedSearches?: SavedSearch[];
        sidebarCollapsed?: boolean;
        taskSortBy?: TaskSortBy;
        lastSyncAt?: string;
        lastSyncStatus?: 'idle' | 'syncing' | 'success' | 'error' | 'conflict';
        lastSyncError?: string;
        lastSyncStats?: MergeStats;
        lastSyncHistory?: SyncHistoryEntry[];
        diagnostics?: {
            loggingEnabled?: boolean;
        };
        filters?: {
            areaId?: string;
        };
        deviceId?: string;
        migrations?: {
            version?: number;
            lastAutoArchiveAt?: string;
            lastTombstoneCleanupAt?: string;
        };
    };
}
