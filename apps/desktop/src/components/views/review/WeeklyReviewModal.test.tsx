import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetForTests, useTaskStore, type Task } from '@mindwtr/core';

import { WeeklyReviewGuideModal } from './WeeklyReviewModal';

vi.mock('../../../contexts/language-context', () => ({
    useLanguage: () => ({
        t: (key: string) => ({
            'review.title': 'Weekly Review',
            'review.inboxZero': 'Inbox Zero',
            'review.inboxZeroDesc': 'tasks in your inbox',
            'review.inboxEmpty': 'Inbox empty',
            'review.inboxStep': 'Inbox',
            'review.staleStep': 'Stale Items',
            'review.calendarStep': 'Calendar',
            'review.waitingStep': 'Waiting For',
            'review.contexts': 'Contexts',
            'review.projectsStep': 'Projects',
            'review.somedayStep': 'Someday',
            'review.allDone': 'All Done',
            'review.allDoneDesc': 'Nice work.',
            'review.complete': 'Review Complete!',
            'review.completeDesc': 'Nice work this week.',
            'review.summaryInboxEmpty': 'Inbox is empty.',
            'review.finish': 'Finish',
            'review.step': 'Step',
            'review.of': 'of',
            'mindSweep.title': 'Mind Sweep',
            'mindSweep.intro': 'Capture anything on your mind.',
            'common.close': 'Close',
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

vi.mock('../../MindSweepModal', () => ({
    MindSweepLauncher: () => <div data-testid="mind-sweep-launcher" />,
}));

vi.mock('../../PromptModal', () => ({
    PromptModal: () => null,
}));

const now = '2026-02-01T00:00:00.000Z';
const storageKey = 'mindwtr:weeklyReview:currentStep';
const initialTaskState = useTaskStore.getState();

const makeTask = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    createdAt: now,
    updatedAt: now,
    ...overrides,
} as Task);

describe('WeeklyReviewGuideModal', () => {
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
            settings: { gtd: { weeklyReview: { includeContextStep: true } } },
            addProject: vi.fn(),
            updateProject: vi.fn(),
            updateTask: vi.fn(),
            deleteTask: vi.fn(),
            batchUpdateTasks: vi.fn(),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('lands on the all-clear step when nothing needs review', () => {
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { level: 2, name: 'Review Complete!' })).toBeInTheDocument();
    });

    it('opens on the inbox step when there is an inbox task to process', () => {
        useTaskStore.setState({
            _allTasks: [makeTask({ id: 'inbox-1', title: 'Inbox task', status: 'inbox' })],
        });

        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeInTheDocument();
        expect(screen.getByTestId('task-inbox-1')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'review.back' })).toBeDisabled();
    });

    it('resumes within the configured local review week, preserves Close, and clears on Finish', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 4, 10, 0, 0));
        useTaskStore.setState({
            _allTasks: [
                makeTask({ id: 'inbox-1', title: 'Inbox task', status: 'inbox', updatedAt: new Date(2026, 2, 4).toISOString() }),
                makeTask({ id: 'waiting-1', title: 'Waiting task', status: 'waiting', updatedAt: new Date(2026, 2, 4).toISOString() }),
            ],
            settings: { weekStart: 'monday', gtd: { weeklyReview: { includeContextStep: true } } },
        });
        const onClose = vi.fn();
        const first = render(<WeeklyReviewGuideModal onClose={onClose} />);

        fireEvent.click(screen.getByRole('button', { name: 'review.nextStepBtn' }));
        expect(screen.getByRole('heading', { level: 1, name: 'Waiting For' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')).toEqual({
            step: 'waiting',
            startedAt: new Date(2026, 2, 4, 10, 0, 0).toISOString(),
        });

        first.unmount();
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { level: 1, name: 'Waiting For' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'review.nextStepBtn' }));
        fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
        expect(window.localStorage.getItem(storageKey)).toBeNull();
    });

    it('ignores a checkpoint from the previous configured review week', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 2, 9, 0, 0));
        window.localStorage.setItem(storageKey, JSON.stringify({
            step: 'completed',
            startedAt: new Date(2026, 2, 1, 16, 0, 0).toISOString(),
        }));
        useTaskStore.setState({
            _allTasks: [makeTask({ id: 'inbox-1', title: 'Inbox task', status: 'inbox' })],
            settings: { weekStart: 'monday', gtd: { weeklyReview: { includeContextStep: true } } },
        });

        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeInTheDocument();
        expect(JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')).toEqual({
            step: 'inbox',
            startedAt: new Date(2026, 2, 2, 9, 0, 0).toISOString(),
        });
    });
});
