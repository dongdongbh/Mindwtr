import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_COLOR, type Area, type Project, type Task } from '@mindwtr/core';
import { getProjectAccentColor, getTaskAccentColor } from './task-accent-color';

const task = (overrides: Partial<Task>): Task => ({
    id: 't1',
    title: 'test',
    status: 'next',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
} as Task);

const project = (overrides: Partial<Project>): Project => ({
    id: 'p1',
    title: 'Project',
    status: 'active',
    color: DEFAULT_PROJECT_COLOR,
    order: 0,
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
} as Project);

const area = (overrides: Partial<Area>): Area => ({
    id: 'a1',
    name: 'Area',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
} as Area);

const maps = (projects: Project[], areas: Area[]) => [
    new Map(projects.map((p) => [p.id, p])),
    new Map(areas.map((a) => [a.id, a])),
] as const;

describe('getTaskAccentColor', () => {
    it('uses an explicitly chosen project color', () => {
        const [projects, areas] = maps([project({ color: '#f97316', areaId: 'a1' })], [area({ color: '#8b5cf6' })]);
        expect(getTaskAccentColor(task({ projectId: 'p1' }), projects, areas)).toBe('#f97316');
    });

    it('falls through the never-changed default project color to the area color (#1124)', () => {
        const [projects, areas] = maps([project({ areaId: 'a1' })], [area({ color: '#8b5cf6' })]);
        expect(getTaskAccentColor(task({ projectId: 'p1' }), projects, areas)).toBe('#8b5cf6');
    });

    it('uses the task area color when the task has no project', () => {
        const [projects, areas] = maps([], [area({ color: '#3b82f6' })]);
        expect(getTaskAccentColor(task({ areaId: 'a1' }), projects, areas)).toBe('#3b82f6');
    });

    it('returns undefined when neither project nor area carries a real color', () => {
        const [projects, areas] = maps([project({ areaId: 'a1' })], [area({ color: DEFAULT_PROJECT_COLOR })]);
        expect(getTaskAccentColor(task({ projectId: 'p1' }), projects, areas)).toBeUndefined();
        expect(getTaskAccentColor(task({}), projects, areas)).toBeUndefined();
    });
});

describe('getProjectAccentColor', () => {
    it('uses an explicitly chosen project color over the area', () => {
        const [, areas] = maps([], [area({ color: '#8b5cf6' })]);
        expect(getProjectAccentColor(project({ color: '#f97316', areaId: 'a1' }), areas)).toBe('#f97316');
    });

    it('falls through the never-changed default project color to the area color', () => {
        const [, areas] = maps([], [area({ color: '#8b5cf6' })]);
        expect(getProjectAccentColor(project({ areaId: 'a1' }), areas)).toBe('#8b5cf6');
    });

    it('returns undefined for a default-grey project with no area color', () => {
        const [, areas] = maps([], [area({ color: DEFAULT_PROJECT_COLOR })]);
        expect(getProjectAccentColor(project({ areaId: 'a1' }), areas)).toBeUndefined();
        expect(getProjectAccentColor(project({}), areas)).toBeUndefined();
    });
});
