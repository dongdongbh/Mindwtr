import { describe, expect, it } from 'vitest';
import type { Area, Project, Task } from '@mindwtr/core';

import { buildReviewTaskGroups } from './review-task-groups';

const task = (id: string, title: string, updates: Partial<Task> = {}): Task => ({
  id,
  title,
  status: 'next',
  contexts: [],
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...updates,
});

const project = (id: string, title: string, updates: Partial<Project> = {}): Project => ({
  id,
  title,
  status: 'active',
  color: '#3b82f6',
  order: 0,
  tagIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...updates,
});

const area = (id: string, name: string, color: string): Area => ({
  id,
  name,
  color,
  order: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('buildReviewTaskGroups', () => {
  it('puts unassigned tasks first and summarizes project action state', () => {
    const workArea = area('area-work', 'Work', '#94a3b8');
    const activeProject = project('project-active', 'Active Project', { areaId: workArea.id, order: 1 });
    const stuckProject = project('project-stuck', 'Stuck Project', { areaId: workArea.id, order: 2 });
    const groups = buildReviewTaskGroups({
      areaById: new Map([[workArea.id, workArea]]),
      areaOrderById: new Map([[workArea.id, 0]]),
      noAreaLabel: 'Unassigned',
      projectById: new Map([
        [activeProject.id, activeProject],
        [stuckProject.id, stuckProject],
      ]),
      singleActionsLabel: 'Single actions',
      sortedTasks: [
        task('unassigned', 'Loose task', { status: 'inbox' }),
        task('next', 'Project next action', { projectId: activeProject.id, status: 'next' }),
        task('waiting', 'Project waiting task', { projectId: stuckProject.id, status: 'waiting' }),
      ],
      fallbackAreaColor: '#3b82f6',
      unassignedAreaColor: '#f59e0b',
    });

    expect(groups.map((group) => group.title)).toEqual(['Unassigned', 'Work']);
    expect(groups[0]).toMatchObject({
      color: '#f59e0b',
      isUnassigned: true,
      projectCount: 0,
      taskCount: 1,
    });
    expect(groups[1]).toMatchObject({
      needsActionCount: 1,
      projectCount: 2,
      taskCount: 2,
    });
    expect(groups[1].projectGroups.map((group) => [group.title, group.hasNextAction])).toEqual([
      ['Active Project', true],
      ['Stuck Project', false],
    ]);
  });
});
