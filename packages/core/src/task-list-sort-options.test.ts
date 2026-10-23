import { describe, expect, it } from 'vitest';
import type { AppSettings, Task } from './types';
import { normalizeProjectTaskSortBy, TASK_SORT_BY_VALUE_SET } from './project-utils';
import {
    DONE_TASK_LIST_SORT_OPTIONS,
    FOCUS_SORT_OPTIONS,
    getTaskSortByLabel,
    getVisibleTaskSortOptions,
    PROJECT_TASK_SORT_OPTIONS,
    TASK_LIST_SORT_OPTIONS,
    resolveDoneTaskSortBy,
    resolveNonDoneTaskSortBy,
} from './task-list-sort-options';
import { sortTasksBy } from './task-utils';

const settingsWith = (timeEstimates: boolean) => ({ features: { timeEstimates } } as AppSettings);

describe('task list sort rosters', () => {
    it('keeps the ordinary roster fixed and Done appending only the legacy completed sort', () => {
        expect(TASK_LIST_SORT_OPTIONS).toEqual([
            'default',
            'due',
            'start',
            'review',
            'priority',
            'timeEstimate',
            'title',
            'created',
            'created-desc',
        ]);
        expect(DONE_TASK_LIST_SORT_OPTIONS).toEqual([...TASK_LIST_SORT_OPTIONS.filter((option) => option !== 'priority'), 'completed']);
    });

    // Both Focus filter panels read this one; pinning the order keeps the two
    // pickers showing the same choices in the same places.
    it('keeps the Focus roster fixed', () => {
        expect(FOCUS_SORT_OPTIONS).toEqual(['default', 'due', 'start', 'priority', 'created', 'created-desc']);
    });
});

describe('resolveNonDoneTaskSortBy / resolveDoneTaskSortBy', () => {
    it('keeps legacy completion sorting in Done and out of every ordinary view', () => {
        expect(resolveDoneTaskSortBy('completed', undefined, undefined)).toBe('completed');
        expect(resolveNonDoneTaskSortBy('completed', undefined)).toBe('default');
    });

    it('keeps the device-local Done preference separate from the synced ordinary preference', () => {
        expect(resolveDoneTaskSortBy('title', 'completed', undefined)).toBe('completed');
        expect(resolveDoneTaskSortBy('title', undefined, undefined)).toBe('default');
        expect(resolveNonDoneTaskSortBy('title', undefined)).toBe('title');
    });

    it('falls back to the default order while Time estimates is off (#1107)', () => {
        expect(resolveNonDoneTaskSortBy('timeEstimate', settingsWith(false))).toBe('default');
        expect(resolveDoneTaskSortBy('title', 'timeEstimate', settingsWith(false))).toBe('default');
    });

    it('keeps the time-estimate order with the feature on or unset', () => {
        expect(resolveNonDoneTaskSortBy('timeEstimate', settingsWith(true))).toBe('timeEstimate');
        expect(resolveNonDoneTaskSortBy('timeEstimate', undefined)).toBe('timeEstimate');
        expect(resolveDoneTaskSortBy('title', 'timeEstimate', settingsWith(true))).toBe('timeEstimate');
    });
});

// Priority is a shared-list sort (settings.taskSortBy) only (#1415).
describe('priority in the shared list sort', () => {
    const flags = (priorities: boolean) => ({ features: { priorities } } as AppSettings);

    it('offers priority while Priorities is on or unset, and hides it while off', () => {
        expect(getVisibleTaskSortOptions(TASK_LIST_SORT_OPTIONS, flags(true))).toContain('priority');
        expect(getVisibleTaskSortOptions(TASK_LIST_SORT_OPTIONS, undefined)).toContain('priority');
        expect(getVisibleTaskSortOptions(TASK_LIST_SORT_OPTIONS, flags(false))).toEqual(
            TASK_LIST_SORT_OPTIONS.filter((option) => option !== 'priority'),
        );
    });

    it('labels priority with the Focus key and the rest with sort.*', () => {
        const t = (key: string) => key;
        expect(getTaskSortByLabel('priority', t)).toBe('filters.priority');
        expect(getTaskSortByLabel('due', t)).toBe('sort.due');
    });

    it('sorts a stored priority sort as default while Priorities is off', () => {
        const task = (id: string, priority: Task['priority'], createdAt: string) =>
            ({ id, title: id, status: 'next', priority, tags: [], contexts: [], createdAt, updatedAt: createdAt } as Task);
        const tasks = [task('low-old', 'low', '2026-01-01T00:00:00.000Z'), task('high-new', 'high', '2026-01-02T00:00:00.000Z')];
        expect(resolveNonDoneTaskSortBy('priority', flags(true))).toBe('priority');
        expect(sortTasksBy(tasks, resolveNonDoneTaskSortBy('priority', flags(true))).map((entry) => entry.id))
            .toEqual(['high-new', 'low-old']);
        expect(resolveNonDoneTaskSortBy('priority', flags(false))).toBe('default');
        expect(sortTasksBy(tasks, resolveNonDoneTaskSortBy('priority', flags(false))).map((entry) => entry.id))
            .toEqual(sortTasksBy(tasks, 'default').map((entry) => entry.id));
    });

    // Project.taskSortBy syncs; an older client normalizes an unknown value to
    // undefined and would erase a project's Priority sort on its next edit.
    it('never offers or accepts priority as a project sort', () => {
        expect(PROJECT_TASK_SORT_OPTIONS).toEqual(TASK_LIST_SORT_OPTIONS.filter((option) => option !== 'priority'));
        expect(getVisibleTaskSortOptions(PROJECT_TASK_SORT_OPTIONS, flags(true))).not.toContain('priority');
        expect(normalizeProjectTaskSortBy('priority')).toBeUndefined();
        expect(TASK_SORT_BY_VALUE_SET.has('priority')).toBe(false);
    });
});
