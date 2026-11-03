import { act, renderHook } from '@testing-library/react';
import { type Area, type Project, type Task } from '@mindwtr/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCalendarComposer, type CalendarComposerOptions } from './use-calendar-composer';

const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});

const makeProject = (overrides: Partial<Project> = {}): Project => ({
    id: 'project-1',
    title: 'Launch',
    status: 'active',
    color: '#94a3b8',
    order: 0,
    tagIds: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});

const makeArea = (overrides: Partial<Area> = {}): Area => ({
    id: 'area-1',
    name: 'Work',
    color: '#94a3b8',
    order: 0,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});


const ENGLISH: Record<string, string> = {
    'calendar.overlapWarning': 'That time overlaps with an event.',
    'quickAdd.invalidDateCommand': 'Invalid date command',
};

const buildOptions = (overrides: Partial<CalendarComposerOptions> = {}) => {
    const addProject = vi.fn(async () => makeProject({ id: 'project-new', title: 'Created' }));
    const addTask = vi.fn(async () => ({ success: true, id: 'task-new' }));
    const updateTask = vi.fn(async () => ({ success: true }));
    const onSaved = vi.fn();
    const options: CalendarComposerOptions = {
        addProject,
        addTask,
        areas: [],
        findFreeSlot: (day) => {
            const slot = new Date(day);
            slot.setHours(8, 0, 0, 0);
            return slot;
        },
        isSlotFree: () => true,
        onSaved,
        projects: [],
        resolveText: (key, fallback) => ENGLISH[key] ?? fallback,
        schedulableTasks: [],
        t: (key) => ENGLISH[key] ?? key,
        tasks: [],
        timeEstimateToMinutes: () => 30,
        updateTask,
        ...overrides,
    };
    return { addProject, addTask, onSaved, options, updateTask };
};

const renderComposer = (overrides: Partial<CalendarComposerOptions> = {}) => {
    const built = buildOptions(overrides);
    const view = renderHook(() => useCalendarComposer(built.options));
    return { ...built, ...view };
};

describe('useCalendarComposer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 3, 3, 14, 48));
        return () => vi.useRealTimers();
    });

    it('opens at a free slot for a date and exposes the raw desktop inputs', () => {
        const { result } = renderComposer();

        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));

        expect(result.current.taskComposer?.mode).toBe('new');
        expect(result.current.taskComposer?.startDateValue).toBe('2026-04-04');
        expect(result.current.taskComposer?.startTimeValue).toBe('08:00');
        expect(result.current.taskComposer?.endTimeValue).toBe('08:30');
    });

    it('opens at an exact slot with a 30 minute default from the timeline', () => {
        const { result } = renderComposer();

        act(() => result.current.openQuickAddForStart(new Date(2026, 3, 4, 9, 15)));

        expect(result.current.taskComposer?.startTimeValue).toBe('09:15');
        expect(result.current.taskComposer?.durationMinutes).toBe(30);
    });

    it('keeps a retyped date rather than snapping back to the resolved start', () => {
        const { result } = renderComposer();
        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));

        act(() => result.current.updateTaskComposerStart({ startDateValue: '2026-04-09' }));

        expect(result.current.taskComposer?.startDateValue).toBe('2026-04-09');
        expect(result.current.taskComposer?.startAt?.getDate()).toBe(9);


        act(() => result.current.updateTaskComposerStart({ startDateValue: '2026-04-' }));
        expect(result.current.taskComposer?.startDateValue).toBe('2026-04-');
        expect(result.current.taskComposer?.startAt).toBeNull();
    });

    it('derives the duration from a later end time and rejects an earlier one', async () => {
        const { result, addTask } = renderComposer();
        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));

        act(() => result.current.updateTaskComposerEndTime('09:00'));
        expect(result.current.taskComposer?.durationMinutes).toBe(60);

        act(() => result.current.updateTaskComposerTitle('Draft launch note'));
        act(() => result.current.updateTaskComposerEndTime('07:45'));
        await act(async () => { await result.current.saveTaskComposer(); });

        expect(result.current.taskComposerError).toBe('Choose a valid start and end time.');
        expect(addTask).not.toHaveBeenCalled();
    });

    it('requires a title in new mode and a task in existing mode', async () => {
        const { result, addTask } = renderComposer();
        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));

        await act(async () => { await result.current.saveTaskComposer(); });
        expect(result.current.taskComposerError).toBe('Enter a task title.');

        act(() => result.current.updateTaskComposerMode('existing'));
        await act(async () => { await result.current.saveTaskComposer(); });
        expect(result.current.taskComposerError).toBe('Choose a task.');
        expect(addTask).not.toHaveBeenCalled();
    });

    it('reports an occupied slot with the plain overlap string, not a fallback', async () => {
        const { result, addTask } = renderComposer({ isSlotFree: () => false });
        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));
        act(() => result.current.updateTaskComposerTitle('Prepare notes'));

        await act(async () => { await result.current.saveTaskComposer(); });

        expect(result.current.taskComposerError).toBe('That time overlaps with an event.');
        expect(addTask).not.toHaveBeenCalled();
    });

    it('parses quick-add syntax through core and closes on success', async () => {
        const { result, addTask, addProject, onSaved } = renderComposer({
            areas: [makeArea()],
            projects: [makeProject()],
        });
        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));
        act(() => result.current.updateTaskComposerTitle('Draft launch note +Launch @computer #deep'));

        await act(async () => { await result.current.saveTaskComposer(); });

        expect(addTask).toHaveBeenCalledWith('Draft launch note', expect.objectContaining({
            contexts: ['@computer'],
            projectId: 'project-1',
            startTime: new Date(2026, 3, 4, 8, 0).toISOString(),
            tags: ['#deep'],
        }));
        expect(addProject).not.toHaveBeenCalled();
        expect(result.current.taskComposer).toBeNull();
        expect(onSaved).toHaveBeenCalledWith(new Date(2026, 3, 4, 8, 0));
    });

    it('creates an unknown +Project first and applies it to the draft', async () => {
        const { result, addTask, addProject } = renderComposer();
        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));
        act(() => result.current.updateTaskComposerTitle('Draft note +Unknown'));

        await act(async () => { await result.current.saveTaskComposer(); });

        expect(addProject).toHaveBeenCalledWith('Unknown', expect.any(String), undefined);
        expect(addTask).toHaveBeenCalledWith('Draft note', expect.objectContaining({ projectId: 'project-new' }));
    });

    it('keeps the composer open and reports the store error when the write fails', async () => {
        const { result, onSaved } = renderComposer({
            addTask: vi.fn(async () => ({ success: false, error: 'disk full' })),
        });
        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));
        act(() => result.current.updateTaskComposerTitle('Draft launch note'));

        await act(async () => { await result.current.saveTaskComposer(); });

        expect(result.current.taskComposer).not.toBeNull();
        expect(result.current.taskComposerError).toBe('disk full');
        expect(onSaved).not.toHaveBeenCalled();
    });

    it('reschedules an existing task instead of creating one, carrying its estimate', async () => {
        const existing = makeTask({ id: 'task-existing', title: 'Write proposal', timeEstimate: '1hr' });
        const { result, addTask, updateTask } = renderComposer({
            schedulableTasks: [existing],
            tasks: [existing],
            timeEstimateToMinutes: () => 60,
        });
        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));
        act(() => result.current.updateTaskComposerMode('existing'));

        expect(result.current.taskComposerCandidates.map((task) => task.id)).toEqual(['task-existing']);
        act(() => result.current.selectTaskComposerTask(existing));
        expect(result.current.selectedComposerTask?.title).toBe('Write proposal');

        await act(async () => { await result.current.saveTaskComposer(); });

        expect(updateTask).toHaveBeenCalledWith('task-existing', {
            startTime: new Date(2026, 3, 4, 8, 0).toISOString(),
            timeEstimate: '1hr',
        });
        expect(addTask).not.toHaveBeenCalled();
    });

    it('narrows existing-task candidates by query and drops a stale selection', () => {
        const tasks = [
            makeTask({ id: 'a', title: 'Write proposal' }),
            makeTask({ id: 'b', title: 'Book flights' }),
        ];
        const { result } = renderComposer({ schedulableTasks: tasks, tasks });
        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));
        act(() => result.current.updateTaskComposerMode('existing'));

        act(() => result.current.selectTaskComposerTask(tasks[0]));
        expect(result.current.taskComposer?.selectedTaskId).toBe('a');

        act(() => result.current.updateTaskComposerQuery('flight'));
        expect(result.current.taskComposerCandidates.map((task) => task.id)).toEqual(['b']);
        expect(result.current.taskComposer?.selectedTaskId).toBeNull();
    });

    it('closes without saving', async () => {
        const { result, addTask } = renderComposer();
        act(() => result.current.openQuickAddForDate(new Date(2026, 3, 4)));

        act(() => result.current.closeTaskComposer());

        expect(result.current.taskComposer).toBeNull();
        expect(addTask).not.toHaveBeenCalled();
    });
});
