import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetForTests, useTaskStore, type Task } from '@mindwtr/core';

import { DailyReviewGuideModal } from './DailyReviewModal';

vi.mock('../../../contexts/language-context', () => ({
    useLanguage: () => ({
        t: (key: string) => ({
            'agenda.addToFocus': 'Add to Focus',
            'agenda.focusHint': 'Pick focus tasks.',
            'agenda.maxFocusItems': 'Maximum focus items reached',
            'agenda.noTasks': 'No tasks',
            'agenda.reviewDue': 'Review Due',
            'agenda.removeFromFocus': 'Remove from Focus',
            'calendar.allDay': 'All day',
            'calendar.events': 'Events',
            'calendar.noTasks': 'No events',
            'common.close': 'Close',
            'common.loading': 'Loading',
            'common.tasks': 'tasks',
            'dailyReview.completeDesc': 'Ready to go.',
            'dailyReview.completeTitle': 'Ready',
            'dailyReview.focusDesc': 'Choose focus tasks.',
            'dailyReview.focusStep': "Today's Focus",
            'dailyReview.followUpToday': 'Follow up today',
            'dailyReview.inboxDesc': 'Clarify inbox tasks.',
            'dailyReview.inboxStep': 'Process Inbox',
            'dailyReview.title': 'Daily Review',
            'dailyReview.todayDesc': 'Review today.',
            'dailyReview.todayStep': 'Today and Calendar',
            'dailyReview.waitingDesc': 'Follow up.',
            'dailyReview.waitingStep': 'Waiting For',
            'review.back': 'Back',
            'review.finish': 'Finish',
            'review.inboxEmpty': 'Inbox empty',
            'review.nextStepBtn': 'Next',
            'review.of': 'of',
            'review.step': 'Step',
            'review.waitingEmpty': 'Nothing waiting',
        }[key] ?? key),
    }),
}));

vi.mock('../../../lib/external-calendar-events', () => ({
    fetchExternalCalendarEvents: vi.fn(async () => ({ events: [], warnings: [] })),
    summarizeExternalCalendarWarnings: vi.fn(() => null),
}));

vi.mock('../../TaskItem', () => ({
    TaskItem: ({ task }: { task: Task }) => <div data-testid={`task-${task.id}`}>{task.title}</div>,
}));

vi.mock('../InboxProcessor', () => ({
    InboxProcessor: () => <div data-testid="inbox-processor" />,
}));

const storageKey = 'mindwtr:dailyReview:currentStep';
const now = '2026-02-01T00:00:00.000Z';
const initialTaskState = useTaskStore.getState();

const makeTask = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    createdAt: now,
    updatedAt: now,
    ...overrides,
} as Task);

describe('DailyReviewGuideModal', () => {
    beforeEach(() => {
        vi.useRealTimers();
        resetForTests();
        window.localStorage.clear();
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState({
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
            settings: { gtd: { dailyReview: { includeFocusStep: true } } },
            addProject: vi.fn(),
            updateTask: vi.fn(),
            deleteTask: vi.fn(),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows skipped empty steps as checked and lands on all clear when nothing needs review', () => {
        render(<DailyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { level: 1, name: /ready/i })).toBeInTheDocument();
        expect(screen.getByText('Today and Calendar')).toBeInTheDocument();
        expect(screen.getByText('Process Inbox')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
    });

    it('persists the current step across modal remounts and clears it when finished', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 1, 15, 10, 30, 0));
        useTaskStore.setState({
            _allTasks: [makeTask({ id: 'inbox-1', title: 'Inbox task', status: 'inbox' })],
        });

        const { unmount } = render(<DailyReviewGuideModal onClose={vi.fn()} />);

        expect(JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')).toEqual({
            step: 'inbox',
            startedAt: new Date(2026, 1, 15, 10, 30, 0).toISOString(),
        });

        unmount();
        render(<DailyReviewGuideModal onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { level: 1, name: /process inbox/i })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /next/i }));
        fireEvent.click(screen.getByRole('button', { name: /finish/i }));

        expect(window.localStorage.getItem(storageKey)).toBeNull();
    });

    it('ignores an expired completed checkpoint when new daily review work appears', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 1, 15, 10, 30, 0));
        window.localStorage.setItem(storageKey, JSON.stringify({
            step: 'completed',
            startedAt: new Date(2026, 1, 14, 10, 30, 0).toISOString(),
        }));
        useTaskStore.setState({
            _allTasks: [makeTask({ id: 'inbox-1', title: 'Inbox task', status: 'inbox' })],
        });

        render(<DailyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { level: 1, name: /process inbox/i })).toBeInTheDocument();
        expect(JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')).toEqual({
            step: 'inbox',
            startedAt: new Date(2026, 1, 15, 10, 30, 0).toISOString(),
        });
    });

    it('disables Back on the first active step and preserves the checkpoint when closed', () => {
        useTaskStore.setState({
            _allTasks: [makeTask({ id: 'inbox-1', title: 'Inbox task', status: 'inbox' })],
        });
        const onClose = vi.fn();

        render(<DailyReviewGuideModal onClose={onClose} />);

        expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')).toEqual(expect.objectContaining({ step: 'inbox' }));
    });

    it('reviews Waiting For before choosing todays focus so unblocked items can be promoted', () => {
        useTaskStore.setState({
            _allTasks: [
                makeTask({ id: 'waiting-1', title: 'Waiting for invoice', status: 'waiting' }),
                makeTask({ id: 'next-1', title: 'Write report', status: 'next' }),
            ],
        });

        render(<DailyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Waiting For' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Next' }));

        expect(screen.getByRole('heading', { level: 1, name: "Today's Focus" })).toBeInTheDocument();
    });

    it('sets a waiting item to follow up today without changing its status', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 1, 15, 10, 30, 0));
        const updateTask = vi.fn();
        useTaskStore.setState({
            _allTasks: [
                makeTask({
                    id: 'waiting-1',
                    title: 'Waiting for invoice',
                    status: 'waiting',
                    reviewAt: undefined,
                }),
            ],
            updateTask,
        });

        render(<DailyReviewGuideModal onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /follow up today: waiting for invoice/i }));

        expect(updateTask).toHaveBeenCalledWith('waiting-1', {
            reviewAt: new Date(2026, 1, 15, 0, 0, 0, 0).toISOString(),
        });
    });

    const seedStep = (step: string, task: Partial<Task>) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 6, 15, 10, 0, 0));
        useTaskStore.setState({
            _allTasks: Array.from({ length: 11 }, (_, index) => makeTask({
                id: `${step}-${index + 1}`,
                title: `${step} task ${index + 1}`,
                ...task,
            })),
        });
        window.localStorage.setItem(storageKey, JSON.stringify({
            step,
            startedAt: new Date(2026, 6, 15, 8, 0, 0).toISOString(),
        }));
    };

    it.each([
        { step: 'today', task: { dueDate: '2026-07-15' } },
        { step: 'inbox', task: { status: 'inbox' as const } },
        { step: 'waiting', task: { status: 'waiting' as const } },
    ])('shows every eligible task in the $step step', ({ step, task }) => {
        seedStep(step, task);

        render(<DailyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getAllByTestId(/^task-/)).toHaveLength(11);
        expect(screen.getByTestId(`task-${step}-11`)).toBeInTheDocument();
    });

    it('shows every focus candidate in the focus step', () => {
        seedStep('focus', { status: 'next' });

        render(<DailyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { level: 1, name: "Today's Focus" })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Add to Focus' })).toHaveLength(11);
        expect(screen.getByText('focus task 11')).toBeInTheDocument();
    });

    it('refreshes review buckets when the open review crosses local midnight', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 6, 15, 23, 59, 59));
        useTaskStore.setState({
            _allTasks: [
                makeTask({ id: 'today-1', title: 'Before midnight', dueDate: '2026-07-15' }),
                makeTask({ id: 'tomorrow-1', title: 'After midnight', dueDate: '2026-07-16' }),
            ],
        });

        render(<DailyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByTestId('task-today-1')).toBeInTheDocument();
        expect(screen.queryByTestId('task-tomorrow-1')).not.toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(1_100);
        });

        expect(screen.getByTestId('task-tomorrow-1')).toBeInTheDocument();
    });
});
