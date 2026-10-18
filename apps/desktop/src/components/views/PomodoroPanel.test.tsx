import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getPomodoroLocalDayKey, loadTranslations, useTaskStore, type Task } from '@mindwtr/core';
import { LanguageProvider } from '../../contexts/language-context';
import * as languageContext from '../../contexts/language-context';
import { useUiStore } from '../../store/ui-store';
import { usePomodoroStore } from '../../store/pomodoro-store';
import { DESKTOP_POMODORO_SESSION_STORAGE_KEY, PomodoroPanel } from './PomodoroPanel';
const nowIso = '2026-07-01T12:00:00.000Z';
const task: Task = {
    id: 'task-1',
    title: 'Write RFC reply',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: nowIso,
    updatedAt: nowIso,
};

const renderPanel = () => render(
    <LanguageProvider>
        <PomodoroPanel tasks={[task]} />
    </LanguageProvider>
);

describe('PomodoroPanel desktop persistence', () => {
    beforeEach(() => {
        window.localStorage.clear();
        useTaskStore.setState({
            tasks: [task],
            _allTasks: [task],
            settings: {
                gtd: {
                    pomodoro: {
                        linkTask: true,
                    },
                },
            },
            error: null,
            highlightTaskId: null,
        });
        usePomodoroStore.getState().hydratePomodoro({});
    });

    it('localizes both phases and switch directions with the shared Chinese labels (#1367)', async () => {
        const translations = await loadTranslations('zh-Hant');
        const language = vi.spyOn(languageContext, 'useLanguage').mockReturnValue({
            language: 'zh-Hant', setLanguage: vi.fn(), t: (key) => translations[key] ?? key,
        });
        try {
            renderPanel();
            expect(screen.getByText('專注')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: '切換到休息' }));
            expect(screen.getByText('休息')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: '收起計時器' }));
            expect(screen.getByText('休息')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: '展開計時器' }));
            fireEvent.click(screen.getByRole('button', { name: '切換到專注' }));
            expect(screen.getByText('專注')).toBeInTheDocument();
        } finally {
            language.mockRestore();
        }
    });

    it('restores device-local timer state and task history from local storage', () => {
        window.localStorage.setItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
            durations: { focusMinutes: 25, breakMinutes: 5 },
            timerState: {
                phase: 'focus',
                remainingSeconds: 1200,
                isRunning: false,
                completedFocusSessions: 0,
            },
            selectedTaskId: 'task-1',
            updatedAtMs: Date.now(),
            sessionHistory: {
                totalCompletedFocusSessions: 4,
                completedFocusSessionsByTaskId: {
                    'task-1': 2,
                },
                // The visible count is per-day: today's stored count restores,
                // while a lifetime total from another day would show 0.
                todayDayKey: getPomodoroLocalDayKey(),
                completedTodayFocusSessions: 4,
            },
        }));

        const { getByLabelText, getByText } = renderPanel();

        expect(getByText('Focus sessions completed: 4')).toBeInTheDocument();
        expect(getByLabelText('Timer task').textContent).toContain('Write RFC reply');
    });

    it('persists timer state changes to device-local storage', () => {
        const { getByRole } = renderPanel();

        fireEvent.click(getByRole('button', { name: 'Start' }));

        const stored = JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY) ?? '{}');
        expect(stored.timerState).toMatchObject({
            phase: 'focus',
            isRunning: true,
            completedFocusSessions: 0,
        });
        expect(stored.sessionHistory).toEqual({
            totalCompletedFocusSessions: 0,
            completedFocusSessionsByTaskId: {},
            todayDayKey: getPomodoroLocalDayKey(),
            completedTodayFocusSessions: 0,
        });
    });

    it('shows zero completed sessions once the stored day has passed', () => {
        window.localStorage.setItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
            durations: { focusMinutes: 25, breakMinutes: 5 },
            timerState: {
                phase: 'focus',
                remainingSeconds: 1200,
                isRunning: false,
                completedFocusSessions: 4,
            },
            selectedTaskId: 'task-1',
            updatedAtMs: Date.now(),
            sessionHistory: {
                totalCompletedFocusSessions: 4,
                completedFocusSessionsByTaskId: { 'task-1': 2 },
                todayDayKey: '2001-01-01',
                completedTodayFocusSessions: 4,
            },
        }));

        const { getByText } = renderPanel();

        expect(getByText('Focus sessions completed: 0')).toBeInTheDocument();
    });

    it('links a task through the searchable popup and clears back to timer only', () => {
        const otherTask: Task = { ...task, id: 'task-2', title: 'Draft release notes' };
        useTaskStore.setState({ tasks: [task, otherTask], _allTasks: [task, otherTask] } as never);
        render(
            <LanguageProvider>
                <PomodoroPanel tasks={[task, otherTask]} />
            </LanguageProvider>
        );

        // Starts unlinked: the trigger shows the timer-only state.
        expect(screen.getByLabelText('Timer task').textContent).toContain('Timer only');

        // Open the popup and filter down to a single match.
        fireEvent.click(screen.getByLabelText('Timer task'));
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'release' } });
        expect(screen.queryByRole('option', { name: 'Write RFC reply' })).toBeNull();
        fireEvent.click(screen.getByRole('option', { name: 'Draft release notes' }));

        expect(screen.getByLabelText('Timer task').textContent).toContain('Draft release notes');
        let stored = JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY) ?? '{}');
        expect(stored.selectedTaskId).toBe('task-2');

        // Reopen and clear the link back to timer only.
        fireEvent.click(screen.getByLabelText('Timer task'));
        fireEvent.click(screen.getByRole('option', { name: 'Timer only' }));

        expect(screen.getByLabelText('Timer task').textContent).toContain('Timer only');
        stored = JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY) ?? '{}');
        expect(stored.selectedTaskId ?? null).toBeNull();
    });

    const storeSession = (selectedTaskId: string) => window.localStorage.setItem(
        DESKTOP_POMODORO_SESSION_STORAGE_KEY,
        JSON.stringify({
            durations: { focusMinutes: 25, breakMinutes: 5 },
            timerState: { phase: 'focus', remainingSeconds: 1500, isRunning: false, completedFocusSessions: 0 },
            selectedTaskId,
            updatedAtMs: Date.now(),
            sessionHistory: { totalCompletedFocusSessions: 0, completedFocusSessionsByTaskId: {} },
        })
    );

    // A timer started from Review or the calendar links a task that is not in the
    // Focus list this panel is handed. Resolving the link against that list dropped
    // it the moment the panel rendered, which is what made the row's Play button
    // look dead outside Focus (#867).
    it('keeps a linked task that is not in the panel list', () => {
        const offFocusTask: Task = { ...task, id: 'task-3', title: 'Deferred chore' };
        useTaskStore.setState({ tasks: [task, offFocusTask], _allTasks: [task, offFocusTask] } as never);
        storeSession('task-3');

        render(
            <LanguageProvider>
                <PomodoroPanel tasks={[task]} />
            </LanguageProvider>
        );

        expect(screen.getByLabelText('Timer task').textContent).toContain('Deferred chore');
        const stored = JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY) ?? '{}');
        expect(stored.selectedTaskId).toBe('task-3');
    });

    // The boundary: a task that is genuinely gone must still release the timer, so
    // widening the lookup above does not just disable the guard.
    it('still clears the link when the linked task no longer exists', () => {
        useTaskStore.setState({ tasks: [task], _allTasks: [task] } as never);
        storeSession('deleted-task');

        render(
            <LanguageProvider>
                <PomodoroPanel tasks={[task]} />
            </LanguageProvider>
        );

        expect(screen.getByLabelText('Timer task').textContent).toContain('Timer only');
    });

    it.each(['done', 'archived', 'cancelled', 'reference', 'deleted'] as const)(
        'unlinks a task becoming %s while the picker is open without changing the timer', (transition) => {
            storeSession(task.id);
            renderPanel();
            fireEvent.click(screen.getByRole('button', { name: 'Start' }));
            fireEvent.click(screen.getByLabelText('Timer task'));
            expect(screen.getByRole('option', { name: task.title })).toBeInTheDocument();
            const before = usePomodoroStore.getState().snapshot;

            const nextTasks: Task[] = transition === 'deleted' ? [] : [{
                ...task,
                status: transition === 'cancelled' ? 'archived' : transition,
                ...(transition === 'cancelled' ? { cancelledAt: nowIso } : {}),
            }];
            act(() => useTaskStore.setState({ tasks: nextTasks, _allTasks: nextTasks }));

            expect(screen.getByRole('button', { name: 'Timer task' }).textContent).toContain('Timer only');
            expect(screen.getByRole('option', { name: 'Timer only' })).toHaveAttribute('aria-selected', 'true');
            expect(screen.queryByRole('option', { name: task.title })).toBeNull();
            expect(screen.queryByLabelText('Mark task done')).toBeNull();
            expect(usePomodoroStore.getState().snapshot).toEqual({ ...before, selectedTaskId: undefined });
        }
    );

    it('uses current live titles and eligibility for unselected picker candidates', () => {
        const otherTask: Task = { ...task, id: 'task-2', title: 'Keep working' };
        useTaskStore.setState({ tasks: [task, otherTask], _allTasks: [task, otherTask] });
        render(<LanguageProvider><PomodoroPanel tasks={[task, otherTask]} /></LanguageProvider>);
        fireEvent.click(screen.getByLabelText('Timer task'));

        const nextTasks: Task[] = [{ ...task, status: 'done' }, { ...otherTask, title: 'Updated title' }];
        act(() => useTaskStore.setState({ tasks: nextTasks, _allTasks: nextTasks }));

        expect(screen.queryByRole('option', { name: task.title })).toBeNull();
        expect(screen.queryByRole('option', { name: otherTask.title })).toBeNull();
        fireEvent.click(screen.getByRole('option', { name: 'Updated title' }));
        expect(screen.getByLabelText('Timer task').textContent).toContain('Updated title');
    });

    it('keeps the link until its own Mark done changes the live task', async () => {
        let finish!: () => void;
        const updateTask = vi.fn(() => new Promise<{ success: true }>((resolve) => {
            finish = () => {
                const completed: Task = { ...task, status: 'done' };
                useTaskStore.setState({ tasks: [completed], _allTasks: [completed] });
                resolve({ success: true });
            };
        }));
        useTaskStore.setState({ updateTask });
        storeSession(task.id);
        renderPanel();

        fireEvent.click(screen.getByLabelText('Mark task done'));
        expect(usePomodoroStore.getState().snapshot.selectedTaskId).toBe(task.id);
        await act(async () => finish());

        expect(screen.getByLabelText('Timer task').textContent).toContain('Timer only');
        fireEvent.click(screen.getByLabelText('Timer task'));
        expect(screen.queryByRole('option', { name: task.title })).toBeNull();
    });
    // Mark done dropped the store result, so a rejected write left the task
    // untouched with nothing on screen and the user pressed the button again.
    it('reports a failed Mark done instead of silently doing nothing', async () => {
        const updateTask = vi.fn().mockResolvedValue({ success: false, error: 'Disk full' });
        useUiStore.setState({ toasts: [] });
        useTaskStore.setState({ tasks: [task], _allTasks: [task], updateTask } as never);
        storeSession('task-1');

        render(
            <LanguageProvider>
                <PomodoroPanel tasks={[task]} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(screen.getByLabelText('Mark task done'));
        });

        expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'done', isFocusedToday: false });
        expect(useUiStore.getState().toasts.map((toast) => toast.message)).toContain('Disk full');
        expect(usePomodoroStore.getState().snapshot.selectedTaskId).toBe(task.id);
        expect(screen.getByLabelText('Timer task').textContent).toContain(task.title);
    });
});
