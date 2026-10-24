import { describe, expect, it } from 'vitest';
import type { Area, Project, Task } from './types';
import type { ProjectDeadlineBoost } from './task-utils';
import { buildFocusTaskGroups, getProjectDeadlineBoostLabel, type FocusResolveText } from './focus-grouping';
import { getContextColor } from './context-color';
import { DEFAULT_AREA_COLOR } from './color-constants';

const makeTask = (overrides: Partial<Task>): Task => ({
    id: 'task',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

const makeProject = (overrides: Partial<Project>): Project => ({
    id: 'project',
    title: 'Project',
    status: 'active',
    color: '#fff',
    order: 0,
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

const makeArea = (overrides: Partial<Area>): Area => ({
    id: 'area',
    name: 'Area',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

// Return the human fallback so assertions read as labels, not keys.
const resolveText: FocusResolveText = (_key, fallback) => fallback;

const build = (groupBy: Parameters<typeof buildFocusTaskGroups>[0]['groupBy'], params: {
    tasks: Task[];
    projects?: Project[];
    areas?: Area[];
    theme?: string;
}) => buildFocusTaskGroups({
    groupBy,
    tasks: params.tasks,
    projects: params.projects ?? [],
    areas: params.areas ?? [],
    resolveText,
    theme: params.theme,
});

const keys = (groups: { key: string }[]) => groups.map((group) => group.key);

describe('buildFocusTaskGroups', () => {
    it('returns no groups for the none axis', () => {
        expect(build('none', { tasks: [makeTask({ id: 'a' })] })).toEqual([]);
    });

    describe('context axis', () => {
        it('leads with a muted no-context bucket, then contexts alphabetically', () => {
            const tasks = [
                makeTask({ id: 'a', contexts: ['@work'] }),
                makeTask({ id: 'b', contexts: [] }),
                makeTask({ id: 'c', contexts: ['@home'] }),
            ];
            const groups = build('context', { tasks });
            expect(keys(groups)).toEqual(['context:none', 'context:@home', 'context:@work']);
            expect(groups[0].label).toBe('No context');
            expect(groups[0].muted).toBe(true);
        });

        it('places a multi-context task into every one of its buckets', () => {
            const tasks = [makeTask({ id: 'a', contexts: ['@work', '@home'] })];
            const groups = build('context', { tasks });
            expect(keys(groups)).toEqual(['context:@home', 'context:@work']);
            expect(groups.every((group) => group.tasks[0].id === 'a')).toBe(true);
        });
    });

    describe('tag axis', () => {
        it('leads with a muted no-tag bucket, then tags alphabetically', () => {
            const tasks = [
                makeTask({ id: 'a', tags: ['zeta'] }),
                makeTask({ id: 'b', tags: [] }),
                makeTask({ id: 'c', tags: ['alpha'] }),
            ];
            const groups = build('tag', { tasks });
            expect(keys(groups)).toEqual(['tag:none', 'tag:alpha', 'tag:zeta']);
            expect(groups[0].muted).toBe(true);
        });
    });

    describe('project axis', () => {
        it('orders by project.order and leads with a muted no-project bucket', () => {
            const projects = [
                makeProject({ id: 'p1', title: 'Beta', order: 1 }),
                makeProject({ id: 'p2', title: 'Alpha', order: 0 }),
            ];
            const tasks = [
                makeTask({ id: 'a', projectId: 'p1' }),
                makeTask({ id: 'b', projectId: 'p2' }),
                makeTask({ id: 'c' }),
                makeTask({ id: 'd', projectId: 'missing' }),
            ];
            const groups = build('project', { tasks, projects });
            expect(keys(groups)).toEqual(['project:none', 'project:p2', 'project:p1']);
            expect(groups[0].muted).toBe(true);
            // Unknown projectId collapses into the no-project bucket.
            expect(groups[0].tasks.map((task) => task.id).sort()).toEqual(['c', 'd']);
        });
    });

    describe('area axis', () => {
        it('resolves area via project then task, ordered by area.order', () => {
            const projects = [makeProject({ id: 'p1', areaId: 'a2' })];
            const areas = [
                makeArea({ id: 'a1', name: 'Home', order: 1 }),
                makeArea({ id: 'a2', name: 'Work', order: 0 }),
            ];
            const tasks = [
                makeTask({ id: 'a', projectId: 'p1' }),      // area a2 via project
                makeTask({ id: 'b', areaId: 'a1' }),         // area a1 via task
                makeTask({ id: 'c' }),                       // no area
            ];
            const groups = build('area', { tasks, projects, areas });
            expect(keys(groups)).toEqual(['area:none', 'area:a2', 'area:a1']);
            expect(groups[0].muted).toBe(true);
            expect(groups[1].label).toBe('Work');
        });
    });

    describe('energy axis', () => {
        it('orders high, medium, low, then a muted no-energy bucket last', () => {
            const tasks = [
                makeTask({ id: 'a', energyLevel: 'low' }),
                makeTask({ id: 'b' }),
                makeTask({ id: 'c', energyLevel: 'high' }),
                makeTask({ id: 'd', energyLevel: 'medium' }),
            ];
            const groups = build('energy', { tasks });
            expect(keys(groups)).toEqual(['energy:high', 'energy:medium', 'energy:low', 'energy:none']);
            expect(groups[groups.length - 1].muted).toBe(true);
        });
    });

    describe('priority axis', () => {
        it('orders urgent, high, medium, low, then a muted no-priority bucket last', () => {
            const tasks = [
                makeTask({ id: 'a', priority: 'medium' }),
                makeTask({ id: 'b', priority: 'urgent' }),
                makeTask({ id: 'c' }),
                makeTask({ id: 'd', priority: 'low' }),
            ];
            const groups = build('priority', { tasks });
            expect(keys(groups)).toEqual(['priority:urgent', 'priority:medium', 'priority:low', 'priority:none']);
            expect(groups[groups.length - 1].muted).toBe(true);
        });
    });

    describe('dot colors (desktop next-grouping parity)', () => {
        it('colors context/tag named buckets by token hash, none-bucket bare', () => {
            const context = build('context', { tasks: [
                makeTask({ id: 'a', contexts: ['@work'] }),
                makeTask({ id: 'b' }),
            ] });
            expect(context.find((g) => g.key === 'context:@work')?.dotColor).toBe(getContextColor('@work'));
            expect(context.find((g) => g.key === 'context:none')?.dotColor).toBeUndefined();

            const tag = build('tag', { tasks: [makeTask({ id: 'a', tags: ['home'] })] });
            expect(tag[0].dotColor).toBe(getContextColor('home'));
        });

        it('passes the theme through to the token palette (#974)', () => {
            const tasks = [makeTask({ id: 'a', contexts: ['@work'] })];
            expect(build('context', { tasks, theme: 'nord' })[0].dotColor)
                .toBe(getContextColor('@work', 'nord'));
            // The project/area axes read stored colors and must not be themed.
            const projects = [makeProject({ id: 'p1', color: '#123456' })];
            expect(build('project', { tasks: [makeTask({ id: 'a', projectId: 'p1' })], projects, theme: 'nord' })[0].dotColor)
                .toBe('#123456');
        });

        it('colors project buckets by project.color, none-bucket bare', () => {
            const projects = [makeProject({ id: 'p1', color: '#123456' })];
            const groups = build('project', { tasks: [
                makeTask({ id: 'a', projectId: 'p1' }),
                makeTask({ id: 'b' }),
            ], projects });
            expect(groups.find((g) => g.key === 'project:p1')?.dotColor).toBe('#123456');
            expect(groups.find((g) => g.key === 'project:none')?.dotColor).toBeUndefined();
        });

        it('gives a project with no Area and no color of its own the grey default dot, like an Area bucket (#1422)', () => {
            const groups = build('project', { tasks: [makeTask({ id: 'a', projectId: 'p1' })],
                projects: [makeProject({ id: 'p1', color: DEFAULT_AREA_COLOR })] });
            expect(groups.find((g) => g.key === 'project:p1')?.dotColor).toBe(DEFAULT_AREA_COLOR);
        });

        it('colors area buckets by area.color (default when unset), none-bucket bare', () => {
            const areas = [
                makeArea({ id: 'a1', color: '#abcdef' }),
                makeArea({ id: 'a2', color: undefined }),
            ];
            const groups = build('area', { tasks: [
                makeTask({ id: 'a', areaId: 'a1' }),
                makeTask({ id: 'b', areaId: 'a2' }),
                makeTask({ id: 'c' }),
            ], areas });
            expect(groups.find((g) => g.key === 'area:a1')?.dotColor).toBe('#abcdef');
            expect(groups.find((g) => g.key === 'area:a2')?.dotColor).toBe(DEFAULT_AREA_COLOR);
            expect(groups.find((g) => g.key === 'area:none')?.dotColor).toBeUndefined();
        });

        it('never colors person, energy, or priority buckets', () => {
            const person = build('person', { tasks: [makeTask({ id: 'a', assignedTo: 'Ann' }), makeTask({ id: 'b' })] });
            const energy = build('energy', { tasks: [makeTask({ id: 'a', energyLevel: 'high' }), makeTask({ id: 'b' })] });
            const priority = build('priority', { tasks: [makeTask({ id: 'a', priority: 'urgent' }), makeTask({ id: 'b' })] });
            [...person, ...energy, ...priority].forEach((group) => {
                expect(group.dotColor).toBeUndefined();
            });
        });
    });

    describe('person axis', () => {
        it('sorts named people alphabetically and keeps unassigned last', () => {
            const tasks = [
                makeTask({ id: 'a', assignedTo: 'Zed' }),
                makeTask({ id: 'b' }),
                makeTask({ id: 'c', assignedTo: 'Ann' }),
            ];
            const groups = build('person', { tasks });
            expect(keys(groups)).toEqual(['person:ann', 'person:zed', 'person:none']);
            const unassigned = groups.find((group) => group.key === 'person:none');
            expect(unassigned?.muted).toBe(true);
        });

        it('folds case-variant assignees into one bucket', () => {
            const tasks = [
                makeTask({ id: 'a', assignedTo: 'Ann' }),
                makeTask({ id: 'b', assignedTo: 'ann' }),
            ];
            const groups = build('person', { tasks });
            expect(keys(groups)).toEqual(['person:ann']);
            expect(groups[0].tasks).toHaveLength(2);
        });
    });
});

describe('getProjectDeadlineBoostLabel', () => {
    const boost = (overrides: Partial<ProjectDeadlineBoost>): ProjectDeadlineBoost => ({
        isOverdue: false,
        ...overrides,
    } as ProjectDeadlineBoost);

    it('returns undefined without a boost', () => {
        expect(getProjectDeadlineBoostLabel(undefined, resolveText)).toBeUndefined();
    });

    it('labels overdue and due-today boosts', () => {
        expect(getProjectDeadlineBoostLabel(boost({ isOverdue: true }), resolveText)).toBe('Project overdue');
        expect(getProjectDeadlineBoostLabel(boost({ isOverdue: false }), resolveText)).toBe('Project due today');
    });
});
