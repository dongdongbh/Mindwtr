export type TaskStatus = 'inbox' | 'next' | 'waiting' | 'someday' | 'done' | 'archived';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type TimeEstimate = '5min' | '10min' | '15min' | '30min' | '1hr' | '2hr' | '3hr' | '4hr' | '4hr+';

export type TaskSortBy = 'default' | 'due' | 'start' | 'review' | 'title' | 'created' | 'created-desc';

export type TaskMode = 'task' | 'list';

export type TaskEditorFieldId =
    | 'status'
    | 'priority'
    | 'contexts'
    | 'tags'
    | 'blockedBy'
    | 'timeEstimate'
    | 'recurrence'
    | 'startTime'
    | 'dueDate'
    | 'reviewAt'
    | 'description'
    | 'attachments'
    | 'checklist';

export interface Project {
    id: string;
    title: string;
    status: 'active' | 'completed' | 'archived';
    color: string;
    isSequential?: boolean; // If true, only first incomplete task shows in Next Actions
    isFocused?: boolean; // If true, this project is a priority focus (max 5 allowed)
    supportNotes?: string;
    attachments?: Attachment[];
    reviewAt?: string; // Tickler/review date (ISO string). If set, project is due for review at/after this time.
    areaId?: string;
    areaTitle?: string;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string; // Soft-delete: if set, this item is considered deleted
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
    recurrence?: string; // e.g., 'daily', 'weekly', 'monthly'
    tags: string[];
    contexts: string[]; // e.g., '@home', '@work'
    checklist?: ChecklistItem[]; // Subtasks/Shopping list items
    description?: string;
    attachments?: Attachment[];
    location?: string;
    projectId?: string;
    isFocusedToday?: boolean; // Marked as today's priority (Top 3 focus)
    timeEstimate?: TimeEstimate; // Estimated time to complete
    reviewAt?: string; // Tickler/review date (ISO string). If set, task is due for review at/after this time.
    blockedByTaskIds?: string[]; // Task dependencies that block this task.
    completedAt?: string; // ISO timestamp when task was last completed/archived.
    createdAt: string;
    updatedAt: string;
    deletedAt?: string; // Soft-delete: if set, this item is considered deleted
}

export interface SavedSearch {
    id: string;
    name: string;
    query: string;
    sort?: string;
    groupBy?: string;
}

import type { MergeStats } from './sync';

export interface AppData {
    tasks: Task[];
    projects: Project[];
    settings: {
        gtd?: {
            timeEstimatePresets?: TimeEstimate[];
            taskEditor?: {
                order?: TaskEditorFieldId[];
                hidden?: TaskEditorFieldId[];
            };
            autoArchiveDays?: number;
        };
        theme?: 'light' | 'dark' | 'system';
        language?: 'en' | 'zh' | 'system';
        weekStart?: 'monday' | 'sunday';
        dateFormat?: string;
        keybindingStyle?: 'vim' | 'emacs';
        notificationsEnabled?: boolean;
        dailyDigestMorningEnabled?: boolean;
        dailyDigestMorningTime?: string; // HH:mm
        dailyDigestEveningEnabled?: boolean;
        dailyDigestEveningTime?: string; // HH:mm
        weeklyReviewEnabled?: boolean;
        weeklyReviewDay?: number; // 0 = Sunday
        weeklyReviewTime?: string; // HH:mm
        ai?: {
            enabled?: boolean;
            provider?: 'gemini' | 'openai';
            apiKey?: string;
            model?: string;
            reasoningEffort?: 'low' | 'medium' | 'high';
            thinkingBudget?: number;
            copilotModel?: string;
        };
        savedSearches?: SavedSearch[];
        sidebarCollapsed?: boolean;
        taskSortBy?: TaskSortBy;
        lastSyncAt?: string;
        lastSyncStatus?: 'idle' | 'syncing' | 'success' | 'error';
        lastSyncError?: string;
        lastSyncStats?: MergeStats;
        diagnostics?: {
            loggingEnabled?: boolean;
        };
    };
}
