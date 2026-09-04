import { describe, expect, it } from 'vitest';
import { computeTodayFocusTasks } from './focus-widget-selection';
import type { Project, Task } from './types';

const NOW = new Date('2026-03-10T09:00:00');
const iso = (value: string) => new Date(value).toISOString();

const makeTask = (overrides: Partial<Task> & Pick<Task, 'id'>): Task => ({
    title: overrides.id,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: iso('2026-01-01T08:00:00'),
    updatedAt: iso('2026-01-01T08:00:00'),
    ...overrides,
});

const makeProject = (overrides: Partial<Project> & Pick<Project, 'id'>): Project => ({
    title: overrides.id,
    status: 'active',
    color: '#2563EB',
    order: 0,
    tagIds: [],
    createdAt: iso('2026-01-01T08:00:00'),
    updatedAt: iso('2026-01-01T08:00:00'),
    ...overrides,
});

const select = (activeTasks: Task[], projects: Project[] = []) => (
    computeTodayFocusTasks({ activeTasks, projects, sortBy: 'default', now: NOW })
);

const ids = (tasks: Task[]) => tasks.map((task) => task.id);

describe('computeTodayFocusTasks — sequential projects', () => {
    const sequential = makeProject({ id: 'seq', isSequential: true });
    const steps = (thirdOverrides: Partial<Task> = {}) => ([
        makeTask({ id: 'step-1', projectId: 'seq', order: 0, orderNum: 0 }),
        makeTask({ id: 'step-2', projectId: 'seq', order: 1, orderNum: 1 }),
        makeTask({ id: 'step-3', projectId: 'seq', order: 2, orderNum: 2, ...thirdOverrides }),
    ]);

    it('gives the slot to a later step that is due today', () => {
        // The Focus screens' rule (getFocusSequentialFirstTaskIds): a due-today
        // step outranks an earlier plain step. The order-only helper the widget
        // builders used before this module picked step-1 here.
        const { focusTasks } = select(steps({ dueDate: iso('2026-03-10T17:00:00') }), [sequential]);
        expect(ids(focusTasks)).toEqual(['step-3']);
    });

    it('gives the slot to a later step that is due for review', () => {
        const { focusTasks } = select(steps({ reviewAt: iso('2026-03-09T08:00:00') }), [sequential]);
        expect(ids(focusTasks)).toEqual(['step-3']);
    });

    it('falls back to the first step by order when nothing is scheduled', () => {
        const { focusTasks } = select(steps(), [sequential]);
        expect(ids(focusTasks)).toEqual(['step-1']);
    });

    it('lets an earlier step deferred to a future date keep holding the slot', () => {
        // The Focus screens feed the helper their unfiltered active pool, so a
        // step hidden by its own start date still blocks the ones after it.
        const [first, second, third] = steps();
        const deferred = { ...first, startTime: iso('2026-03-20T09:00:00') };
        const { focusTasks } = select([deferred, second, third], [sequential]);
        expect(ids(focusTasks)).toEqual([]);
    });

    it('lets a waiting first step block the later ones', () => {
        const [first, second, third] = steps();
        const { focusTasks } = select([{ ...first, status: 'waiting' }, second, third], [sequential]);
        expect(ids(focusTasks)).toEqual([]);
    });

    it('does not let an unclarified inbox task hold the slot', () => {
        const [first, second] = steps();
        const { focusTasks } = select([{ ...first, status: 'inbox' }, second], [sequential]);
        expect(ids(focusTasks)).toEqual(['step-2']);
    });

    it('gives one slot per section for a section-scoped sequential project', () => {
        const sectionScoped = makeProject({ id: 'seq', isSequential: true, sequentialScope: 'section' });
        const tasks = [
            makeTask({ id: 'a-1', projectId: 'seq', sectionId: 'a', order: 0, orderNum: 0 }),
            makeTask({ id: 'a-2', projectId: 'seq', sectionId: 'a', order: 1, orderNum: 1 }),
            makeTask({ id: 'b-1', projectId: 'seq', sectionId: 'b', order: 2, orderNum: 2 }),
        ];
        const { focusTasks } = select(tasks, [sectionScoped]);
        expect(ids(focusTasks)).toEqual(['a-1', 'b-1']);
    });

    it('leaves every step of a non-sequential project visible', () => {
        const parallel = makeProject({ id: 'seq' });
        const { focusTasks } = select(steps(), [parallel]);
        expect(ids(focusTasks)).toEqual(['step-1', 'step-2', 'step-3']);
    });
});

describe('computeTodayFocusTasks — list composition', () => {
    it('puts starred tasks first and keeps them out of the focus list', () => {
        const tasks = [
            makeTask({ id: 'plain' }),
            makeTask({ id: 'starred', isFocusedToday: true }),
        ];
        const { starredTasks, focusTasks } = select(tasks);
        expect(ids(starredTasks)).toEqual(['starred']);
        expect(ids(focusTasks)).toEqual(['plain']);
    });

    it('keeps a starred waiting task in the starred list', () => {
        const { starredTasks, focusTasks } = select([
            makeTask({ id: 'waiting-star', status: 'waiting', isFocusedToday: true }),
        ]);
        expect(ids(starredTasks)).toEqual(['waiting-star']);
        expect(ids(focusTasks)).toEqual([]);
    });

    it('drops a next action deferred past today but keeps one due today', () => {
        const tasks = [
            makeTask({ id: 'later', startTime: iso('2026-03-20T09:00:00') }),
            makeTask({ id: 'due-today', dueDate: iso('2026-03-10T12:00:00') }),
            makeTask({ id: 'starts-today', startTime: iso('2026-03-10T18:00:00') }),
        ];
        const { focusTasks } = select(tasks);
        expect(ids(focusTasks).sort()).toEqual(['due-today', 'starts-today']);
    });

    it('keeps a future-start task that is also due today', () => {
        const { focusTasks } = select([
            makeTask({
                id: 'due-today-later-start',
                startTime: iso('2026-03-20T09:00:00'),
                dueDate: iso('2026-03-10T12:00:00'),
            }),
        ]);
        expect(ids(focusTasks)).toEqual(['due-today-later-start']);
    });

    it('ignores a deleted sequential project when gating its tasks', () => {
        const deleted = makeProject({ id: 'seq', isSequential: true, deletedAt: iso('2026-02-01T08:00:00') });
        const tasks = [
            makeTask({ id: 'step-1', projectId: 'seq', order: 0, orderNum: 0 }),
            makeTask({ id: 'step-2', projectId: 'seq', order: 1, orderNum: 1 }),
        ];
        const { focusTasks } = select(tasks, [deleted]);
        expect(ids(focusTasks)).toEqual(['step-1', 'step-2']);
    });
});
