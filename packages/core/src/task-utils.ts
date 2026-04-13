/**
 * Utility functions for task operations
 */

import { Task, TaskStatus, TaskSortBy, Project, AppData } from './types';
import { safeParseDate, safeParseDueDate } from './date';
import { TASK_STATUS_ORDER } from './task-status';
import type { Language } from './i18n/i18n-types';

/**
 * Status sorting order for task list display
 */
/**
 * Standard task colors for each status.
 * Used for badges, borders, and highlights across the app.
 */
export const STATUS_COLORS: Record<TaskStatus, { bg: string; text: string; border: string }> = {
    'inbox': { bg: '#6B728020', text: '#6B7280', border: '#6B7280' },
    'next': { bg: '#10B98120', text: '#10B981', border: '#10B981' },
    'waiting': { bg: '#F59E0B20', text: '#F59E0B', border: '#F59E0B' },
    'someday': { bg: '#8B5CF620', text: '#8B5CF6', border: '#8B5CF6' },
    'reference': { bg: '#0EA5E920', text: '#0EA5E9', border: '#0EA5E9' },
    'done': { bg: '#22C55E20', text: '#22C55E', border: '#22C55E' },
    'archived': { bg: '#6B728020', text: '#6B7280', border: '#6B7280' },
};

const safeTime = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const safeDueTime = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = safeParseDueDate(value);
    return parsed ? parsed.getTime() : fallback;
};

const shouldIncrementPushCount = (oldDueDate?: string, newDueDate?: string): boolean => {
    if (!oldDueDate || !newDueDate) return false;
    const oldTime = Date.parse(oldDueDate);
    const newTime = Date.parse(newDueDate);
    if (!Number.isFinite(oldTime) || !Number.isFinite(newTime)) return false;
    return newTime > oldTime;
};

const WAITING_FOR_LINE_REGEX = /^\s*waiting\s+for\s*[:：]\s*(.+?)\s*$/i;

export function rescheduleTask(task: Task, newDueDate?: string): Task {
    const next: Task = { ...task, dueDate: newDueDate };
    if (shouldIncrementPushCount(task.dueDate, newDueDate)) {
        next.pushCount = (task.pushCount ?? 0) + 1;
    } else if (typeof task.pushCount === 'number') {
        next.pushCount = task.pushCount;
    }
    return next;
}

export function extractWaitingPerson(description?: string): string | null {
    if (!description) return null;
    const lines = description.split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(WAITING_FOR_LINE_REGEX);
        if (!match) continue;
        const person = match[1]?.trim();
        if (person) return person;
    }
    return null;
}

export function getWaitingPerson(task: Pick<Task, 'assignedTo' | 'description'>): string | null {
    const assignedTo = task.assignedTo?.trim();
    if (assignedTo) return assignedTo;
    return extractWaitingPerson(task.description);
}

/**
 * Sort tasks by status, due date, and creation time.
 * Order: inbox → next → waiting → someday → reference → done → archived
 * Within same status: tasks with due dates first (sorted by date), then by creation time (FIFO)
 */
export function sortTasks(tasks: Task[]): Task[] {
    return [...tasks].sort((a, b) => {
        // 1. Sort by Status
        const statusA = TASK_STATUS_ORDER[a.status] ?? 99;
        const statusB = TASK_STATUS_ORDER[b.status] ?? 99;

        if (statusA !== statusB) {
            return statusA - statusB;
        }

        // 2. Sort by Due Date (tasks with valid due dates first)
        const dueA = safeDueTime(a.dueDate, Number.NaN);
        const dueB = safeDueTime(b.dueDate, Number.NaN);
        const hasDueA = Number.isFinite(dueA);
        const hasDueB = Number.isFinite(dueB);
        if (hasDueA && !hasDueB) return -1;
        if (!hasDueA && hasDueB) return 1;
        if (hasDueA && hasDueB && dueA !== dueB) return dueA - dueB;

        // 3. Created At (oldest first for FIFO)
        return safeTime(a.createdAt, 0) - safeTime(b.createdAt, 0);
    });
}

/**
 * Sort tasks by a user-selected sort option.
 * Falls back to default sortTasks when sortBy is 'default' or undefined.
 */
export function sortTasksBy(tasks: Task[], sortBy: TaskSortBy = 'default'): Task[] {
    if (!sortBy || sortBy === 'default') {
        return sortTasks(tasks);
    }

    const copy = [...tasks];

    const timeOrInfinity = (value?: string) => safeTime(value, Infinity);
    const dueOrInfinity = (value?: string) => safeDueTime(value, Infinity);
    const timeOrZero = (value?: string) => safeTime(value, 0);

    switch (sortBy) {
        case 'title':
            return copy.sort((a, b) => {
                const cmp = a.title.localeCompare(b.title);
                if (cmp !== 0) return cmp;
                return safeTime(a.createdAt, 0) - safeTime(b.createdAt, 0);
            });
        case 'due':
            return copy.sort((a, b) => {
                const aDue = dueOrInfinity(a.dueDate);
                const bDue = dueOrInfinity(b.dueDate);
                if (aDue !== bDue) return aDue - bDue;
                return timeOrZero(a.createdAt) - timeOrZero(b.createdAt);
            });
        case 'start':
            return copy.sort((a, b) => {
                const aStart = timeOrInfinity(a.startTime);
                const bStart = timeOrInfinity(b.startTime);
                if (aStart !== bStart) return aStart - bStart;
                return timeOrZero(a.createdAt) - timeOrZero(b.createdAt);
            });
        case 'review':
            return copy.sort((a, b) => {
                const aReview = timeOrInfinity(a.reviewAt);
                const bReview = timeOrInfinity(b.reviewAt);
                if (aReview !== bReview) return aReview - bReview;
                return timeOrZero(a.createdAt) - timeOrZero(b.createdAt);
            });
        case 'created':
            return copy.sort((a, b) => timeOrZero(a.createdAt) - timeOrZero(b.createdAt));
        case 'created-desc':
            return copy.sort((a, b) => timeOrZero(b.createdAt) - timeOrZero(a.createdAt));
        default:
            return sortTasks(tasks);
    }
}

/**
 * Get display color for a task status
 */
export function getStatusColor(status: TaskStatus): { bg: string; text: string; border: string } {
    return STATUS_COLORS[status] || STATUS_COLORS['inbox'];
}

/**
 * Calculate the age of a task in days
 */
export function getTaskAgeDays(createdAt: string): number {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - created.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Get a human-readable age string for a task
 * Returns null for tasks < 1 day old (to avoid clutter)
 */
export function getTaskAgeLabel(createdAt: string, lang: Language = 'en'): string | null {
    const days = getTaskAgeDays(createdAt);
    const isChinese = lang === 'zh' || lang === 'zh-Hant';

    if (days < 1) return null;
    if (isChinese) {
        if (days === 1) return '1天前';
        if (days < 7) return `${days}天前`;
        if (days < 14) return '1周前';
        if (days < 30) return `${Math.floor(days / 7)}周前`;
        if (days < 60) return '1个月前';
        return `${Math.floor(days / 30)}个月前`;
    }

    if (days === 1) return '1 day old';
    if (days < 7) return `${days} days old`;
    if (days < 14) return '1 week old';
    if (days < 30) return `${Math.floor(days / 7)} weeks old`;
    if (days < 60) return '1 month old';
    return `${Math.floor(days / 30)} months old`;
}

/**
 * Get the staleness level of a task (for color coding)
 * Returns: 'fresh' | 'aging' | 'stale' | 'very-stale'
 */
export function getTaskStaleness(createdAt: string): 'fresh' | 'aging' | 'stale' | 'very-stale' {
    const days = getTaskAgeDays(createdAt);

    if (days < 7) return 'fresh';
    if (days < 14) return 'aging';
    if (days < 30) return 'stale';
    return 'very-stale';
}

/**
 * Get the urgency level of a task based on due date
 * Returns: 'overdue' | 'urgent' (24h) | 'upcoming' (72h) | 'normal' | 'done'
 */
export function getTaskUrgency(task: Partial<Task>): 'overdue' | 'urgent' | 'upcoming' | 'normal' | 'done' {
    if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return 'done';
    if (!task.dueDate) return 'normal';

    const now = new Date();
    const due = safeParseDueDate(task.dueDate);
    if (!due) return 'normal';
    const diffHours = (due.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (diffHours < 0) return 'overdue';
    if (diffHours < 24) return 'urgent';
    if (diffHours < 72) return 'upcoming';
    return 'normal';
}

export function getTaskAreaId(
    task: Pick<Task, 'areaId' | 'projectId'>,
    projectMap?: Map<string, Project> | Record<string, Project>,
): string | undefined {
    if (task.projectId && projectMap) {
        const project = projectMap instanceof Map ? projectMap.get(task.projectId) : projectMap[task.projectId];
        if (project?.areaId) return project.areaId;
    }
    return task.areaId;
}

export type SpeechResultLike = {
    transcript?: string | null;
    title?: string | null;
    description?: string | null;
    dueDate?: string | null;
    startTime?: string | null;
    tags?: string[] | null;
    contexts?: string[] | null;
    projectTitle?: string | null;
};

export type SpeechUpdatePlan = {
    updates: Partial<Task>;
    suggestedProjectTitle?: string;
};

export function buildTaskUpdatesFromSpeechResult(
    existing: Pick<Task, 'title' | 'description' | 'dueDate' | 'startTime' | 'tags' | 'contexts' | 'projectId'>,
    result: SpeechResultLike,
    settings?: AppData['settings'],
): SpeechUpdatePlan {
    const updates: Partial<Task> = {};
    const mode = settings?.ai?.speechToText?.mode ?? 'smart_parse';
    const fieldStrategy = settings?.ai?.speechToText?.fieldStrategy ?? 'smart';
    const transcript = result.transcript?.trim();

    if (mode === 'transcribe_only') {
        if (transcript) {
            if (fieldStrategy === 'description_only') {
                updates.description = transcript;
            } else if (fieldStrategy === 'title_only') {
                updates.title = transcript;
            } else {
                const wordCount = transcript.split(/\s+/).filter(Boolean).length;
                if (wordCount <= 15) {
                    updates.title = transcript;
                } else {
                    updates.description = transcript;
                }
            }
        }
    } else {
        if (result.title && result.title.trim()) updates.title = result.title.trim();
        if (result.description !== undefined && result.description !== null) {
            const description = result.description.trim();
            updates.description = description ? description : undefined;
        }
        if (!updates.title && transcript) {
            if (fieldStrategy === 'description_only') {
                updates.description = transcript;
            } else if (fieldStrategy === 'title_only') {
                updates.title = transcript;
            } else {
                const wordCount = transcript.split(/\s+/).filter(Boolean).length;
                if (wordCount <= 15) {
                    updates.title = transcript;
                } else {
                    const words = transcript.split(/\s+/).filter(Boolean);
                    updates.title = `${words.slice(0, 7).join(' ')}...`;
                    if (!updates.description) {
                        updates.description = transcript;
                    }
                }
            }
        }
    }

    if (result.dueDate) {
        const parsed = safeParseDate(result.dueDate);
        if (parsed) updates.dueDate = parsed.toISOString();
    }
    if (result.startTime) {
        const parsed = safeParseDate(result.startTime);
        if (parsed) updates.startTime = parsed.toISOString();
    }

    const normalizeList = (items: string[] | null | undefined, prefix: string) => {
        if (!Array.isArray(items)) return [];
        return items
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => (item.startsWith(prefix) ? item : `${prefix}${item}`));
    };

    const nextTags = normalizeList(result.tags ?? [], '#');
    const nextContexts = normalizeList(result.contexts ?? [], '@');
    if (nextTags.length) {
        updates.tags = Array.from(new Set([...(existing.tags ?? []), ...nextTags]));
    }
    if (nextContexts.length) {
        updates.contexts = Array.from(new Set([...(existing.contexts ?? []), ...nextContexts]));
    }

    const suggestedProjectTitle = result.projectTitle && !existing.projectId
        ? result.projectTitle.trim()
        : '';

    return {
        updates,
        suggestedProjectTitle: suggestedProjectTitle || undefined,
    };
}

/**
 * Get checklist progress for display.
 * Returns null if no checklist or checklist is empty.
 */
export function getChecklistProgress(task: Pick<Task, 'checklist'>): { completed: number; total: number; percent: number } | null {
    const list = task.checklist || [];
    if (list.length === 0) return null;
    const completed = list.filter((i) => i.isCompleted).length;
    const total = list.length;
    const percent = total === 0 ? 0 : completed / total;
    return { completed, total, percent };
}
