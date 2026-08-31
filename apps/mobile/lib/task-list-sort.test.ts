import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@mindwtr/core';
import { resolveDoneTaskSortBy, resolveNonDoneTaskSortBy, resolveTaskListSortBy } from './task-list-sort';

const settingsWith = (timeEstimates: boolean) => ({ features: { timeEstimates } } as AppSettings);

describe('resolveTaskListSortBy', () => {
  it('keeps the legacy completed preference in Done without leaking it after navigation', () => {
    expect(resolveTaskListSortBy({
      globalSortBy: 'completed',
      settings: undefined,
      statusFilter: 'done',
    })).toBe('completed');
    expect(resolveTaskListSortBy({
      globalSortBy: 'completed',
      settings: undefined,
      statusFilter: 'inbox',
    })).toBe('default');
  });

  it('uses a separate Done view preference without changing ordinary lists', () => {
    expect(resolveTaskListSortBy({
      globalSortBy: 'title',
      settings: undefined,
      statusFilter: 'done',
      viewSortBy: 'completed',
    })).toBe('completed');
    expect(resolveTaskListSortBy({
      globalSortBy: 'title',
      settings: undefined,
      statusFilter: 'next',
    })).toBe('title');
    expect(resolveTaskListSortBy({
      globalSortBy: 'title',
      settings: undefined,
      statusFilter: 'done',
    })).toBe('default');
  });

  it('provides explicit helpers for standalone Done and ordinary views', () => {
    expect(resolveDoneTaskSortBy('completed', undefined, undefined)).toBe('completed');
    expect(resolveDoneTaskSortBy('title', 'completed', undefined)).toBe('completed');
    expect(resolveNonDoneTaskSortBy('completed', undefined)).toBe('default');
    expect(resolveNonDoneTaskSortBy('title', undefined)).toBe('title');
  });

  it('falls back to the default order while Time estimates is off (#1107)', () => {
    expect(resolveTaskListSortBy({
      globalSortBy: 'timeEstimate',
      settings: settingsWith(false),
      statusFilter: 'next',
    })).toBe('default');
    expect(resolveTaskListSortBy({
      projectSortBy: 'timeEstimate',
      settings: settingsWith(false),
      statusFilter: 'all',
    })).toBe('default');
    expect(resolveNonDoneTaskSortBy('timeEstimate', settingsWith(false))).toBe('default');
  });

  it('keeps the time-estimate order with the feature on or unset', () => {
    expect(resolveTaskListSortBy({
      globalSortBy: 'timeEstimate',
      settings: settingsWith(true),
      statusFilter: 'next',
    })).toBe('timeEstimate');
    expect(resolveTaskListSortBy({
      globalSortBy: 'timeEstimate',
      settings: undefined,
      statusFilter: 'next',
    })).toBe('timeEstimate');
  });
});
