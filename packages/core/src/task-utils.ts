/**
 * Utility functions for task operations
 */

import { Task, TaskStatus, TaskSortBy } from './types';
import type { Language } from './i18n';

/**
 * Status sorting order for task list display
 */
const STATUS_ORDER: Record<TaskStatus, number> = {
    'inbox': 0,
    'todo': 1,
    'next': 2,
    'waiting': 3,
    'someday': 4,
    'in-progress': 5,
    'done': 6,
    'archived': 7,
};

/**
 * Standard task colors for each status.
 * Used for badges, borders, and highlights across the app.
 */
export const STATUS_COLORS: Record<TaskStatus, { bg: string; text: string; border: string }> = {
    'inbox': { bg: '#6B728020', text: '#6B7280', border: '#6B7280' },
    'todo': { bg: '#3B82F620', text: '#3B82F6', border: '#3B82F6' },
    'next': { bg: '#10B98120', text: '#10B981', border: '#10B981' },
    'waiting': { bg: '#F59E0B20', text: '#F59E0B', border: '#F59E0B' },
    'someday': { bg: '#8B5CF620', text: '#8B5CF6', border: '#8B5CF6' },
    'in-progress': { bg: '#F9731620', text: '#F97316', border: '#F97316' },
    'done': { bg: '#22C55E20', text: '#22C55E', border: '#22C55E' },
    'archived': { bg: '#9CA3AF20', text: '#9CA3AF', border: '#9CA3AF' },
};

/**
 * Sort tasks by status, due date, and creation time.
 * Order: inbox → todo → next → waiting → someday → in-progress → done → archived
 * Within same status: tasks with due dates first (sorted by date), then by creation time (FIFO)
 */
export function sortTasks(tasks: Task[]): Task[] {
    return [...tasks].sort((a, b) => {
        // 1. Sort by Status
        const statusA = STATUS_ORDER[a.status] ?? 99;
        const statusB = STATUS_ORDER[b.status] ?? 99;

        if (statusA !== statusB) {
            return statusA - statusB;
        }

        // 2. Sort by Due Date (tasks with due dates first)
        if (a.dueDate && !b.dueDate) return -1;
        if (!a.dueDate && b.dueDate) return 1;
        if (a.dueDate && b.dueDate) {
            const timeA = new Date(a.dueDate).getTime();
            const timeB = new Date(b.dueDate).getTime();
            if (timeA !== timeB) return timeA - timeB;
        }

        // 3. Created At (oldest first for FIFO)
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
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

    const timeOrInfinity = (value?: string) => {
        if (!value) return Infinity;
        const parsed = new Date(value).getTime();
        return Number.isFinite(parsed) ? parsed : Infinity;
    };

    switch (sortBy) {
        case 'title':
            return copy.sort((a, b) => {
                const cmp = a.title.localeCompare(b.title);
                if (cmp !== 0) return cmp;
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            });
        case 'due':
            return copy.sort((a, b) => {
                const aDue = timeOrInfinity(a.dueDate);
                const bDue = timeOrInfinity(b.dueDate);
                if (aDue !== bDue) return aDue - bDue;
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            });
        case 'start':
            return copy.sort((a, b) => {
                const aStart = timeOrInfinity(a.startTime);
                const bStart = timeOrInfinity(b.startTime);
                if (aStart !== bStart) return aStart - bStart;
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            });
        case 'review':
            return copy.sort((a, b) => {
                const aReview = timeOrInfinity(a.reviewAt);
                const bReview = timeOrInfinity(b.reviewAt);
                if (aReview !== bReview) return aReview - bReview;
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            });
        case 'created':
            return copy.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        case 'created-desc':
            return copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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

    if (days < 1) return null;
    if (lang === 'zh') {
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
    if (task.status === 'done') return 'done';
    if (!task.dueDate) return 'normal';

    const now = new Date();
    const due = new Date(task.dueDate);
    const diffHours = (due.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (diffHours < 0) return 'overdue';
    if (diffHours < 24) return 'urgent';
    if (diffHours < 72) return 'upcoming';
    return 'normal';
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
