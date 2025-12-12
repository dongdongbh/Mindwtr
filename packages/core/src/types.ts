export type TaskStatus = 'inbox' | 'todo' | 'next' | 'in-progress' | 'waiting' | 'someday' | 'done' | 'archived';

export type TimeEstimate = '5min' | '15min' | '30min' | '1hr' | '2hr+';

export type TaskSortBy = 'default' | 'due' | 'start' | 'review' | 'title' | 'created' | 'created-desc';

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
        savedSearches?: SavedSearch[];
        sidebarCollapsed?: boolean;
        accentColor?: string;
        taskSortBy?: TaskSortBy;
        lastSyncAt?: string;
        lastSyncStatus?: 'idle' | 'syncing' | 'success' | 'error';
        lastSyncError?: string;
        lastSyncStats?: MergeStats;
    };
}
