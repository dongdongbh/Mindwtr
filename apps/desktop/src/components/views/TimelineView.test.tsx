import { beforeEach, describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimelineView, resolveTimelineTrack } from './TimelineView';
import { LanguageProvider } from '../../contexts/language-context';
import { useTaskStore, type Area, type Project, type Task } from '@mindwtr/core';

const iso = (offsetDays: number): string => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString();
};

const makeTask = (overrides: Partial<Task> & { id: string; title: string }): Task => ({
    status: 'next',
    createdAt: iso(-30),
    updatedAt: iso(-30),
    ...overrides,
} as Task);

const setStore = ({
    tasks = [],
    projects = [],
    areas = [],
}: { tasks?: Task[]; projects?: Project[]; areas?: Area[] }) => {
    useTaskStore.setState({
        tasks,
        projects,
        areas,
        settings: {},
        _allTasks: tasks,
        _allProjects: projects,
        _allAreas: areas,
    });
};

const renderTimeline = () => render(
    <LanguageProvider>
        <TimelineView />
    </LanguageProvider>
);

const bars = () => Array.from(document.querySelectorAll('[data-testid="timeline-bar"]')) as HTMLElement[];
const barFor = (taskId: string) => document.querySelector(`[data-testid="timeline-bar"][data-task-id="${taskId}"]`) as HTMLElement | null;
// Group headings and bar titles in one pass, in the order they are laid out.
const rowLabels = () => Array.from(
    document.querySelectorAll('[data-testid="timeline-group"], [data-testid="timeline-bar"]'),
).map((node) => node.textContent);
const axisLabels = (tier: 'major' | 'minor') => Array.from(
    document.querySelectorAll(`[data-testid="timeline-axis-${tier}"]`),
).map((node) => node.textContent ?? '');

describe('resolveTimelineTrack (#1111)', () => {
    it('stretches a range that fits the pane and scrolls one that does not', () => {
        // 30 days at the month zoom's 4px minimum is 120px in a 1200px pane.
        expect(resolveTimelineTrack(30, 4, 1200)).toEqual({ dayWidth: 40, trackWidth: 1200, fitted: true });
        // 400 days at 4px overflows, so the minimum stands and the track scrolls.
        expect(resolveTimelineTrack(400, 4, 1200)).toEqual({ dayWidth: 4, trackWidth: 1600, fitted: false });
        // Exactly full is still fitted, and the pre-measure paint uses the minimum.
        expect(resolveTimelineTrack(100, 12, 1200).fitted).toBe(true);
        expect(resolveTimelineTrack(30, 4, 0)).toEqual({ dayWidth: 4, trackWidth: 120, fitted: false });
        expect(resolveTimelineTrack(0, 4, 1200)).toEqual({ dayWidth: 4, trackWidth: 0, fitted: false });
    });
});

describe('TimelineView (#1111)', () => {
    beforeEach(() => {
        window.localStorage.clear();
        setStore({});
    });

    it('draws a span bar for a task with both a start and a due date', () => {
        setStore({
            tasks: [makeTask({ id: 'span', title: 'Span task', startTime: iso(-2), dueDate: iso(3) })],
        });
        renderTimeline();
        const bar = barFor('span');
        expect(bar).not.toBeNull();
        expect(bar?.dataset.variant).toBe('bar');
        // Six inclusive days at the default week zoom (12px per day).
        expect(bar?.style.width).toBe('72px');
    });

    it('draws a compact mini-bar for a task dated on only one side', () => {
        setStore({
            tasks: [
                makeTask({ id: 'start-only', title: 'Start only', startTime: iso(1) }),
                makeTask({ id: 'due-only', title: 'Due only', dueDate: iso(4) }),
            ],
        });
        renderTimeline();
        expect(barFor('start-only')?.dataset.variant).toBe('mini');
        expect(barFor('due-only')?.dataset.variant).toBe('mini');
        expect(barFor('start-only')?.style.width).toBe('56px');
    });

    it('leaves out undated, done and deleted tasks', () => {
        setStore({
            tasks: [
                makeTask({ id: 'dated', title: 'Dated', dueDate: iso(1) }),
                makeTask({ id: 'undated', title: 'Undated' }),
                makeTask({ id: 'finished', title: 'Finished', status: 'done', dueDate: iso(1) }),
                makeTask({ id: 'gone', title: 'Gone', dueDate: iso(1), deletedAt: iso(0) }),
            ],
        });
        renderTimeline();
        expect(bars().map((bar) => bar.dataset.taskId)).toEqual(['dated']);
    });

    it('colors a bar with the same accent the calendar gives that task', () => {
        setStore({
            tasks: [
                makeTask({ id: 'in-area', title: 'In area', projectId: 'p1', startTime: iso(0), dueDate: iso(1) }),
                makeTask({ id: 'plain', title: 'Plain', projectId: 'p2', startTime: iso(0), dueDate: iso(1) }),
                // No project, area straight on the task: colored on the calendar,
                // so colored here too.
                makeTask({ id: 'loose', title: 'Loose', areaId: 'a1', startTime: iso(0), dueDate: iso(1) }),
            ],
            projects: [
                { id: 'p1', title: 'Area project', status: 'active', areaId: 'a1', createdAt: iso(-60), updatedAt: iso(-60) } as Project,
                { id: 'p2', title: 'Colored project', status: 'active', color: '#00ff00', createdAt: iso(-60), updatedAt: iso(-60) } as Project,
            ],
            areas: [{ id: 'a1', name: 'Work', color: '#ff0000', createdAt: iso(-60), updatedAt: iso(-60) } as unknown as Area],
        });
        renderTimeline();
        expect(barFor('in-area')?.style.backgroundColor).toBe('rgb(255, 0, 0)');
        expect(barFor('plain')?.style.backgroundColor).toBe('rgb(0, 255, 0)');
        expect(barFor('loose')?.style.backgroundColor).toBe('rgb(255, 0, 0)');
    });

    it('groups rows by project with unassigned tasks last', () => {
        setStore({
            tasks: [
                makeTask({ id: 'loose', title: 'Loose task', dueDate: iso(1) }),
                makeTask({ id: 'owned', title: 'Owned task', projectId: 'p1', dueDate: iso(1) }),
            ],
            projects: [{ id: 'p1', title: 'Area project', status: 'active', createdAt: iso(-60), updatedAt: iso(-60) } as Project],
        });
        renderTimeline();
        expect(rowLabels()).toEqual(['Area project', 'Owned task', 'No project', 'Loose task']);
    });

    it('splits the month-zoom axis into a year tier and month ticks, and floors thin bars', () => {
        // The shipped axis printed "MMM yyyy" on every month start, which
        // collided at 4px per day; the year moves to the top tier instead.
        window.localStorage.setItem('mindwtr:view:timeline:v1', JSON.stringify({ zoom: 'month' }));
        setStore({
            tasks: [
                makeTask({ id: 'long', title: 'Long haul', startTime: iso(-60), dueDate: iso(90) }),
                makeTask({ id: 'oneday', title: 'One day', startTime: iso(5), dueDate: iso(5) }),
            ],
        });
        renderTimeline();

        expect(axisLabels('major').every((label) => /^\d{4}$/.test(label))).toBe(true);
        const minor = axisLabels('minor');
        expect(minor.length).toBeGreaterThan(2);
        expect(minor.every((label) => /^[A-Za-z]+$/.test(label))).toBe(true);
        // One day is 4px at month zoom; a bar never renders as a sliver.
        expect(barFor('oneday')?.style.width).toBe('10px');
    });

    it('marks today and shows the empty state when nothing is dated', () => {
        setStore({ tasks: [makeTask({ id: 'dated', title: 'Dated', dueDate: iso(1) })] });
        const { unmount } = renderTimeline();
        expect(document.querySelector('[data-testid="timeline-today-line"]')).not.toBeNull();
        unmount();

        setStore({ tasks: [makeTask({ id: 'undated', title: 'Undated' })] });
        renderTimeline();
        expect(bars()).toHaveLength(0);
        expect(screen.getByText('Nothing scheduled yet')).toBeTruthy();
    });
});
