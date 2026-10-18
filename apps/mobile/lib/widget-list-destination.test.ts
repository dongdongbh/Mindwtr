import { beforeEach, describe, expect, it } from 'vitest';
import type { AppData, Project, Task } from '@mindwtr/core';
import { resetFocusWidgetFilter } from './focus-widget-filter';
import { normalizeWidgetListDestinationId, resolveWidgetListDestination } from './widget-list-destination';

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: id, status: 'next', tags: [], contexts: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id, title: id, status: 'active', color: '#000000', order: 0, tagIds: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const data = (tasks: Task[], projects: Project[] = []): AppData => ({ tasks, projects, sections: [], areas: [], settings: {} });

describe('widget list destination', () => {
  beforeEach(resetFocusWidgetFilter);
  it('accepts exact Next and filter identifiers, not route or criteria payloads', () => {
    expect(normalizeWidgetListDestinationId('next')).toBe('next');
    expect(normalizeWidgetListDestinationId('upcoming')).toBe('upcoming');
    expect(normalizeWidgetListDestinationId('filter:desk')).toBe('filter:desk');
    expect(normalizeWidgetListDestinationId('project:alpha')).toBe('project:alpha');
    for (const invalid of [undefined, ['next'], 'inbox', 'filter:', 'filter:  ', 'project:', 'project:  ', 'next/../settings', 'next?status=done', 'filter:a\u0000b', 'project:a\u0000b', 'x'.repeat(1025)]) {
      expect(normalizeWidgetListDestinationId(invalid)).toBeNull();
    }
  });
  it('resolves a live project with the widget visibility predicate and rejects deleted or missing projects', () => {
    const active = project('active-project', { title: 'Active project' });
    const deleted = project('deleted-project', { deletedAt: '2026-01-02T00:00:00Z' });
    const source = data([
      task('included', { projectId: active.id }),
      task('other-project', { projectId: 'other' }),
      task('done', { projectId: active.id, status: 'done' }),
      task('deleted-task', { projectId: active.id, deletedAt: '2026-01-02T00:00:00Z' }),
    ], [active, deleted, project('other')]);

    const result = resolveWidgetListDestination(source, 'en', `project:${active.id}`);
    expect(result?.title).toBe('Active project');
    expect(result?.tasks.map((item) => item.id)).toEqual(['included']);
    expect(resolveWidgetListDestination(source, 'en', `project:${deleted.id}`)).toBeNull();
    expect(resolveWidgetListDestination(source, 'en', 'project:missing')).toBeNull();
  });
  it('opens the full live Next list rather than the widget snapshot cap', () => {
    const tasks = Array.from({ length: 90 }, (_, i) => task(`next-${i}`));
    const result = resolveWidgetListDestination(data([...tasks, task('done', { status: 'done' }), task('deleted', { deletedAt: '2026-01-02T00:00:00Z' })]), 'en', 'next');
    expect(result?.tasks).toHaveLength(90);
    expect(new Set(result?.tasks.map((item) => item.id))).toEqual(new Set(tasks.map((item) => item.id)));
  });
  it('resolves a saved filter by identity using its latest criteria and rejects deleted filters', () => {
    const source = data([task('desk', { contexts: ['@desk'] }), task('home', { contexts: ['@home'] })]);
    const filters = [{ id: 'same-title-id', name: 'Desk', view: 'next' as const, criteria: { contexts: ['@desk'] }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: undefined as string | undefined }];
    source.settings.savedFilters = filters;
    expect(resolveWidgetListDestination(source, 'en', 'filter:same-title-id')?.tasks.map((item) => item.id)).toEqual(['desk']);
    filters[0].criteria = { contexts: ['@home'] };
    expect(resolveWidgetListDestination(source, 'en', 'filter:same-title-id')?.tasks.map((item) => item.id)).toEqual(['home']);
    filters[0].deletedAt = '2026-01-02T00:00:00Z';
    expect(resolveWidgetListDestination(source, 'en', 'filter:same-title-id')).toBeNull();
    expect(resolveWidgetListDestination(source, 'en', 'filter:missing')).toBeNull();
  });
});
