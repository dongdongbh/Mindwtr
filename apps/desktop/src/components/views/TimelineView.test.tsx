import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TimelineView, resolveTimelineTrack, taskBarTint } from './TimelineView';
import { LanguageProvider } from '../../contexts/language-context';
import { configureDateFormatting, useTaskStore, type Area, type Project, type Task } from '@mindwtr/core';

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
const projectBarFor = (projectId: string) => document.querySelector(
    `[data-testid="timeline-project-bar"][data-project-id="${projectId}"]`,
) as HTMLElement | null;
// Day zoom is 32px per day, so a bar's width and offset read back as day counts.
const projectBarDays = (projectId: string) => {
    const bar = projectBarFor(projectId);
    if (!bar) return null;
    return {
        from: Number.parseFloat(bar.style.left) / 32,
        days: Number.parseFloat(bar.style.width) / 32,
    };
};
const barFor = (taskId: string) => document.querySelector(`[data-testid="timeline-bar"][data-task-id="${taskId}"]`) as HTMLElement | null;
// Group headings and bar titles in one pass, in the order they are laid out.
const rowLabels = () => Array.from(
    document.querySelectorAll('[data-testid="timeline-group"], [data-testid="timeline-row-label"]'),
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

    afterEach(() => {
        vi.useRealTimers();
        configureDateFormatting({ language: 'en', calendarSystem: 'gregorian' });
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
        expect(barFor('start-only')?.style.width).toBe('12px');
    });

    it('draws task bars thinner than the solid project bar and gridlines as real elements, not a gradient', () => {
        setStore({
            projects: [{ id: 'p1', title: 'Remodel', status: 'active', startDate: iso(0), dueDate: iso(20), createdAt: iso(-60), updatedAt: iso(-60) } as Project],
            tasks: [makeTask({ id: 't1', title: 'Tiles', projectId: 'p1', startTime: iso(1), dueDate: iso(6) })],
        });
        renderTimeline();
        const projectHeight = Number.parseFloat(projectBarFor('p1')?.style.height ?? '0');
        const taskHeight = Number.parseFloat(barFor('t1')?.style.height ?? '0');
        expect(projectHeight).toBeGreaterThan(taskHeight);
        // Week zoom over a 21-day range: at least two week boundaries inside it.
        const gridlines = document.querySelectorAll('[data-testid="timeline-gridline-minor"]');
        expect(gridlines.length).toBeGreaterThanOrEqual(2);
        const withGradient = Array.from(document.querySelectorAll<HTMLElement>('div'))
            .filter((element) => element.style.backgroundImage.includes('gradient'));
        expect(withGradient).toHaveLength(0);
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

    it('tints a bar with the same accent the calendar gives that task', () => {
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
        // Same hue as the calendar, drawn at the calm strength a task bar uses.
        expect(barFor('in-area')?.style.backgroundColor).toBe('rgba(255, 0, 0, 0.25)');
        expect(barFor('plain')?.style.backgroundColor).toBe('rgba(0, 255, 0, 0.25)');
        expect(barFor('loose')?.style.backgroundColor).toBe('rgba(255, 0, 0, 0.25)');
        expect(barFor('plain')?.style.border).toBe('1px solid rgba(0, 255, 0, 0.7)');
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

    describe('project bars', () => {
        // Day zoom keeps one day at a fixed 32px, so extents are readable as numbers.
        beforeEach(() => {
            window.localStorage.setItem('mindwtr:view:timeline:v1', JSON.stringify({ zoom: 'day' }));
        });

        const projectWithDates = (dates: Partial<Project>): Project => ({
            id: 'p1',
            title: 'Rebuild the deck',
            status: 'active',
            color: '#00ff00',
            createdAt: iso(-60),
            updatedAt: iso(-60),
            ...dates,
        } as Project);

        // The one task in the group runs day 0 to day 2 of its own span.
        const groupTasks = () => [
            makeTask({ id: 't1', title: 'Task', projectId: 'p1', startTime: iso(0), dueDate: iso(2) }),
        ];

        it('spans start to due when the project carries both dates', () => {
            setStore({
                tasks: groupTasks(),
                projects: [projectWithDates({ startDate: iso(-3).slice(0, 10), dueDate: iso(6).slice(0, 10) })],
            });
            renderTimeline();
            // The axis starts at the project start, three days before today.
            expect(projectBarDays('p1')).toEqual({ from: 0, days: 10 });
        });

        it('borrows the missing end from the tasks under it', () => {
            setStore({
                tasks: groupTasks(),
                projects: [projectWithDates({ startDate: iso(-3).slice(0, 10) })],
            });
            renderTimeline();
            // Start date to the latest task end: -3 through +2 is six days.
            expect(projectBarDays('p1')).toEqual({ from: 0, days: 6 });
        });

        it('borrows the missing start from the tasks under it', () => {
            setStore({
                tasks: groupTasks(),
                projects: [projectWithDates({ dueDate: iso(6).slice(0, 10) })],
            });
            renderTimeline();
            // Earliest task start (today) through the project due date.
            expect(projectBarDays('p1')).toEqual({ from: 0, days: 7 });
        });

        it('draws no bar for a project with neither date', () => {
            setStore({ tasks: groupTasks(), projects: [projectWithDates({})] });
            renderTimeline();
            expect(projectBarFor('p1')).toBeNull();
            expect(barFor('t1')).not.toBeNull();
        });

        it('stretches the axis to a project deadline past every task', () => {
            setStore({
                tasks: groupTasks(),
                projects: [projectWithDates({ dueDate: iso(40).slice(0, 10) })],
            });
            renderTimeline();
            // Without the project date the axis would stop two days out; the bar
            // must not be clipped to it.
            expect(projectBarDays('p1')).toEqual({ from: 0, days: 41 });
        });

        it('draws a dated project with no dated tasks as a bare group row', () => {
            setStore({
                tasks: [makeTask({ id: 'undated', title: 'No dates yet', projectId: 'p1' })],
                projects: [projectWithDates({ startDate: iso(0).slice(0, 10), dueDate: iso(4).slice(0, 10) })],
            });
            renderTimeline();

            // A freshly planned project shows its span before its steps have dates.
            expect(projectBarDays('p1')).toEqual({ from: 0, days: 5 });
            expect(rowLabels()).toEqual(['Rebuild the deck']);
            expect(bars()).toHaveLength(0);
        });

        it('shows nothing for an undated project whose tasks are undated too', () => {
            setStore({
                tasks: [makeTask({ id: 'undated', title: 'No dates yet', projectId: 'p1' })],
                projects: [projectWithDates({})],
            });
            renderTimeline();

            expect(projectBarFor('p1')).toBeNull();
            expect(rowLabels()).toEqual([]);
            expect(screen.getByText('Nothing scheduled yet')).toBeTruthy();
        });

        it('uses the project color and opens the project from its name', () => {
            setStore({
                tasks: groupTasks(),
                projects: [projectWithDates({ startDate: iso(0).slice(0, 10), dueDate: iso(2).slice(0, 10) })],
            });
            renderTimeline();

            expect(projectBarFor('p1')?.style.backgroundColor).toBe('rgb(0, 255, 0)');
            const groupButton = screen.getByRole('button', { name: /Rebuild the deck.*Start date: .+Due date: .+/ });
            expect(groupButton.dataset.projectId).toBe('p1');

            const navigations: string[] = [];
            const listener = (event: Event) => navigations.push((event as CustomEvent<{ view: string }>).detail.view);
            window.addEventListener('mindwtr:navigate', listener as EventListener);
            fireEvent.click(groupButton);
            window.removeEventListener('mindwtr:navigate', listener as EventListener);
            expect(navigations).toEqual(['projects']);
        });
    });

    describe('project group and task bar hierarchy', () => {
        const twoProjectStore = () => setStore({
            tasks: [
                makeTask({ id: 'owned', title: 'Owned task', projectId: 'p1', startTime: iso(0), dueDate: iso(3) }),
                makeTask({ id: 'other', title: 'Other task', projectId: 'p2', startTime: iso(0), dueDate: iso(3) }),
                makeTask({ id: 'loose', title: 'Loose task', startTime: iso(0), dueDate: iso(3) }),
            ],
            projects: [
                { id: 'p1', title: 'First', status: 'active', color: '#00ff00', startDate: iso(0).slice(0, 10), dueDate: iso(3).slice(0, 10), createdAt: iso(-60), updatedAt: iso(-60) } as Project,
                { id: 'p2', title: 'Second', status: 'active', color: '#0000ff', createdAt: iso(-59), updatedAt: iso(-59) } as Project,
            ],
        });

        it('rules off every project group but the first', () => {
            twoProjectStore();
            renderTimeline();

            // Three groups: First, Second and No project. The first opens the
            // list, so only the two that start a new block carry a rule.
            expect(rowLabels()).toEqual(['First', 'Owned task', 'Second', 'Other task', 'No project', 'Loose task']);
            expect(screen.getAllByTestId('timeline-group-separator')).toHaveLength(2);
        });

        it('draws a task bar as a tint of the project bar, with no title on it', () => {
            twoProjectStore();
            renderTimeline();

            const projectBar = projectBarFor('p1');
            const taskBar = barFor('owned');
            expect(projectBar?.style.backgroundColor).toBe('rgb(0, 255, 0)');
            expect(taskBar?.style.backgroundColor).not.toBe(projectBar?.style.backgroundColor);
            expect(taskBar?.style.backgroundColor).toBe('rgba(0, 255, 0, 0.25)');
            // The sticky name column is the only place the title is written.
            expect(taskBar?.textContent).toBe('');
            expect(screen.getAllByText('Owned task')).toHaveLength(1);
        });

        it('tints a mini marker and an accent-colored bar the same way', () => {
            setStore({
                tasks: [
                    makeTask({ id: 'mini', title: 'One sided', projectId: 'p1', dueDate: iso(1) }),
                    makeTask({ id: 'accent', title: 'No color', startTime: iso(0), dueDate: iso(2) }),
                ],
                projects: [{ id: 'p1', title: 'First', status: 'active', color: '#00ff00', createdAt: iso(-60), updatedAt: iso(-60) } as Project],
            });
            renderTimeline();

            expect(barFor('mini')?.dataset.variant).toBe('mini');
            expect(barFor('mini')?.style.backgroundColor).toBe('rgba(0, 255, 0, 0.25)');
            // A task with no area or project keeps the accent, tinted with the token.
            expect(barFor('accent')?.style.backgroundColor).toBe('hsl(var(--primary) / 0.25)');
            expect(bars().every((bar) => bar.textContent === '')).toBe(true);
        });

        it('falls back to the accent token for a color it cannot read', () => {
            expect(taskBarTint('#00ff00')).toEqual({ fill: 'rgba(0, 255, 0, 0.25)', border: 'rgba(0, 255, 0, 0.7)' });
            // Shorthand hex and an 8-digit widget color both resolve.
            expect(taskBarTint('#0f0').fill).toBe('rgba(0, 255, 0, 0.25)');
            expect(taskBarTint('#00ff00ff').fill).toBe('rgba(0, 255, 0, 0.25)');
            expect(taskBarTint(undefined).fill).toBe('hsl(var(--primary) / 0.25)');
            expect(taskBarTint('not a color').border).toBe('hsl(var(--primary) / 0.7)');
        });
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

    it('opens centered on today and re-centers when the zoom changes', () => {
        const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
        const scrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft');
        const positions = new WeakMap<Element, number>();
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
        Object.defineProperty(Element.prototype, 'scrollLeft', {
            configurable: true,
            get() { return positions.get(this) ?? 0; },
            set(value: number) { positions.set(this, value); },
        });
        try {
            // 200 days before today through 150 after: wider than the pane at every zoom.
            setStore({
                tasks: [
                    makeTask({ id: 'past', title: 'Past', startTime: iso(-200), dueDate: iso(-190) }),
                    makeTask({ id: 'future', title: 'Future', startTime: iso(100), dueDate: iso(150) }),
                ],
            });
            renderTimeline();
            const scroller = screen.getByTestId('timeline-scroller');
            // Week zoom is 12px per day: today sits 2400px in, centered in a 1000px pane past the 224px gutter.
            expect(scroller.scrollLeft).toBe(224 + 200 * 12 - 500);
            fireEvent.click(screen.getByRole('button', { name: 'Day' }));
            expect(scroller.scrollLeft).toBe(224 + 200 * 32 - 500);
        } finally {
            if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
            else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
            if (scrollLeft) Object.defineProperty(Element.prototype, 'scrollLeft', scrollLeft);
        }
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

    it('keeps scheduled tasks recoverable when the bounded window omits them', () => {
        setStore({
            tasks: [
                makeTask({ id: 'early', title: 'Early task', dueDate: iso(-365) }),
                makeTask({ id: 'late', title: 'Late task', dueDate: iso(365) }),
            ],
        });
        renderTimeline();

        expect(screen.queryByText('Nothing scheduled yet')).toBeNull();
        expect(screen.getByTestId('timeline-omitted-notice')).toHaveTextContent('+2 tasks');
        expect(bars()).toHaveLength(0);

        fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));
        expect(barFor('early')).not.toBeNull();
        expect(barFor('late')).toBeNull();
        expect(screen.getByTestId('timeline-omitted-notice')).toHaveTextContent('+1 tasks');

        fireEvent.click(screen.getByRole('button', { name: 'Later' }));
        expect(barFor('early')).toBeNull();
        expect(barFor('late')).not.toBeNull();
    });

    it('advances the today marker when the local day rolls over', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 6, 27, 23, 59, 59, 900));
        setStore({
            tasks: [makeTask({ id: 'span', title: 'Spanning task', startTime: iso(-2), dueDate: iso(2) })],
        });
        renderTimeline();

        const before = screen.getByTestId('timeline-today-line').style.left;
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect(screen.getByTestId('timeline-today-line').style.left).not.toBe(before);
    });

    it('uses Jalali month and year boundaries when that calendar is selected', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 20, 12, 0, 0));
        configureDateFormatting({ language: 'fa', calendarSystem: 'jalali' });
        window.localStorage.setItem('mindwtr:view:timeline:v1', JSON.stringify({ zoom: 'month' }));
        const start = new Date(2026, 2, 20, 12, 0, 0);
        const due = new Date(2026, 2, 23, 12, 0, 0);
        setStore({
            tasks: [makeTask({ id: 'new-year', title: 'New year span', startTime: start.toISOString(), dueDate: due.toISOString() })],
        });
        useTaskStore.setState((state) => ({
            ...state,
            settings: { ...state.settings, calendarSystem: 'jalali', language: 'fa' },
        }));
        renderTimeline();

        expect(axisLabels('major')).toContain('۱۴۰۵');
        expect(axisLabels('major')).not.toContain('2026');
        expect(axisLabels('minor')).toContain('فروردین');
    });

    it('exposes one task action with localized start and due semantics', () => {
        setStore({
            tasks: [makeTask({
                id: 'accessible',
                title: 'Accessible task',
                startTime: iso(-2).slice(0, 10),
                dueDate: iso(3).slice(0, 10),
            })],
        });
        renderTimeline();

        const taskActions = screen.getAllByRole('button').filter((button) => button.dataset.taskId === 'accessible');
        expect(taskActions).toHaveLength(1);
        expect(taskActions[0]).toHaveAccessibleName(/Accessible task.*Start date: .+Due date: .+/);
        expect(barFor('accessible')).toHaveAttribute('aria-hidden', 'true');
    });
});
