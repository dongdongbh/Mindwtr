import { describe, expect, it } from 'vitest';

import type { Project, Task } from '@mindwtr/core';

import {
  buildContextAutomationNotificationCopy,
  normalizeContextToken,
  parseContextAutomationUrl,
  selectContextNextActions,
} from './context-automation';

const task = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? 'task',
  title: overrides.title ?? 'Task',
  status: overrides.status ?? 'next',
  tags: overrides.tags ?? [],
  contexts: overrides.contexts ?? [],
  createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const project = (overrides: Partial<Project>): Project => ({
  id: overrides.id ?? 'project',
  title: overrides.title ?? 'Project',
  status: overrides.status ?? 'active',
  color: overrides.color ?? '#3b82f6',
  order: overrides.order ?? 0,
  tagIds: overrides.tagIds ?? [],
  createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('context-automation', () => {
  it('normalizes context names to @ tokens', () => {
    expect(normalizeContextToken('parents')).toBe('@parents');
    expect(normalizeContextToken('@parents')).toBe('@parents');
    expect(normalizeContextToken('  #parents  ')).toBe('@parents');
    expect(normalizeContextToken('')).toBe('');
  });

  it('parses context automation URLs', () => {
    expect(parseContextAutomationUrl('mindwtr://contexts?token=%40parents&contextAction=activate')).toEqual({
      action: 'activate',
      context: '@parents',
    });
    expect(parseContextAutomationUrl('mindwtr:///context/deactivate/parents')).toEqual({
      action: 'deactivate',
      context: '@parents',
    });
    expect(parseContextAutomationUrl('mindwtr:///context/activate/parents/errands')).toEqual({
      action: 'activate',
      context: '@parents/errands',
    });
    expect(parseContextAutomationUrl('mindwtr://activate-context?name=parents')).toEqual({
      action: 'activate',
      context: '@parents',
    });
    expect(parseContextAutomationUrl('mindwtr://contexts?token=%40parents')).toBeNull();
    expect(parseContextAutomationUrl('https://example.com/context?token=parents&action=activate')).toBeNull();
  });

  it('selects matching active /next tasks for a context', () => {
    const tasks = [
      task({ id: 'later-due', title: 'Later due', contexts: ['@parents'], dueDate: '2026-01-03' }),
      task({ id: 'soon-due', title: 'Soon due', contexts: ['@parents'], dueDate: '2026-01-02' }),
      task({ id: 'nested', title: 'Nested', contexts: ['@parents/errands'] }),
      task({ id: 'started-today', title: 'Started today', contexts: ['@parents'], startTime: '2026-01-02' }),
      task({ id: 'started-earlier', title: 'Started earlier', contexts: ['@parents'], startTime: '2026-01-02T08:00:00.000Z' }),
      task({ id: 'future-date', title: 'Future date', contexts: ['@parents'], startTime: '2026-01-03' }),
      task({ id: 'future-time', title: 'Future time', contexts: ['@parents'], startTime: '2026-01-02T13:00:00.000Z' }),
      task({ id: 'waiting', title: 'Waiting', status: 'waiting', contexts: ['@parents'] }),
      task({ id: 'deleted', title: 'Deleted', contexts: ['@parents'], deletedAt: '2026-01-01T01:00:00.000Z' }),
      task({ id: 'archived-project', title: 'Archived project', contexts: ['@parents'], projectId: 'archived' }),
      task({ id: 'other', title: 'Other', contexts: ['@home'] }),
    ];
    const projects = [
      project({ id: 'archived', status: 'archived' }),
    ];

    expect(selectContextNextActions(tasks, projects, 'parents', new Date('2026-01-02T12:00:00.000Z')).map((item) => item.id)).toEqual([
      'soon-due',
      'later-due',
      'started-today',
      'started-earlier',
      'nested',
    ]);
  });

  it('prioritizes next actions while Priorities is on, and stops when it is off', () => {
    // Two undated next actions in the same bucket, titled so the alphabetical
    // tie-break puts the LOW one first: only priority can flip them, so this
    // fails the moment the flag stops reaching sortFocusNextActions.
    const tasks = [
      task({ id: 'low', title: 'Alpha', contexts: ['@parents'], priority: 'low' }),
      task({ id: 'high', title: 'Beta', contexts: ['@parents'], priority: 'high' }),
    ];
    const now = new Date('2026-01-02T12:00:00.000Z');

    expect(selectContextNextActions(tasks, [], 'parents', now, { features: { priorities: true } })
      .map((item) => item.id)).toEqual(['high', 'low']);
    expect(selectContextNextActions(tasks, [], 'parents', now, undefined)
      .map((item) => item.id)).toEqual(['high', 'low']);
    expect(selectContextNextActions(tasks, [], 'parents', now, { features: { priorities: false } })
      .map((item) => item.id)).toEqual(['low', 'high']);
  });

  it('builds compact notification copy', () => {
    expect(buildContextAutomationNotificationCopy('@parents', [])).toEqual({
      title: 'No @parents next actions',
      message: 'Mindwtr did not find any /next tasks for @parents.',
    });
    expect(buildContextAutomationNotificationCopy('@parents', [task({ title: 'Call mom' })])).toEqual({
      title: '@parents next action',
      message: 'Call mom',
    });
    expect(buildContextAutomationNotificationCopy('@parents', [
      task({ title: 'Call mom' }),
      task({ title: 'Bring forms' }),
    ])).toEqual({
      title: '2 @parents next actions',
      message: '- Call mom\n- Bring forms',
    });
  });

  it('accepts localized notification templates', () => {
    expect(buildContextAutomationNotificationCopy('@parents', [], {
      noTasksTitle: 'No hay acciones para {{context}}',
      noTasksMessage: '{{context}} no tiene tareas /next.',
    })).toEqual({
      title: 'No hay acciones para @parents',
      message: '@parents no tiene tareas /next.',
    });
    expect(buildContextAutomationNotificationCopy('@parents', Array.from({ length: 6 }, (_, index) => task({ title: `Task ${index + 1}` })), {
      manyTasksTitle: '{{count}} acciones para {{context}}',
      moreTasksLine: '{{count}} mas',
    })).toEqual({
      title: '6 acciones para @parents',
      message: '- Task 1\n- Task 2\n- Task 3\n- Task 4\n- Task 5\n1 mas',
    });
  });
});
