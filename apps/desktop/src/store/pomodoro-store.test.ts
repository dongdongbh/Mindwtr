import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPomodoroState, useTaskStore, type Task } from '@mindwtr/core';
import { DESKTOP_POMODORO_SESSION_STORAGE_KEY, DESKTOP_POMODORO_COLLAPSED_STORAGE_KEY, usePomodoroStore } from './pomodoro-store';
import { armPomodoroCompletionSound } from '../lib/pomodoro-alert';

const persistence = vi.hoisted(() => ({
    apply: vi.fn(), acknowledge: vi.fn(), flush: vi.fn(async () => undefined),
}));
vi.mock('@mindwtr/core', async (load) => ({
    ...await load<typeof import('@mindwtr/core')>(),
    applyPomodoroCredit: (...args: unknown[]) => persistence.apply(...args),
    acknowledgePomodoroCredits: (...args: unknown[]) => persistence.acknowledge(...args),
    flushPendingSave: () => persistence.flush(),
}));
vi.mock('../lib/pomodoro-alert', () => ({ armPomodoroCompletionSound: vi.fn() }));

let now = Date.parse('2026-11-16T10:00:00Z');
const task = (id = 'a', changes: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [],
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), ...changes,
});
const replaceTasks = (tasks: Task[]) => useTaskStore.setState({ tasks, _allTasks: tasks, _tasksById: new Map(tasks.map((item) => [item.id, item])) });
const timeSpent = (id = 'a') => useTaskStore.getState().tasks.find((item) => item.id === id)?.timeSpentMinutes ?? 0;
const store = () => usePomodoroStore.getState();
const snapshot = () => store().snapshot;
const commit = (update: Parameters<ReturnType<typeof store>['commitPomodoro']>[0]) => store().commitPomodoro(update);
const advance = (seconds: number) => { now += seconds * 1000; };
const pause = () => commit((previous) => ({ ...previous, timerState: { ...previous.timerState, isRunning: false } }));
const resume = () => commit((previous) => ({ ...previous, timerState: { ...previous.timerState, isRunning: true } }));
const start = (id = 'a') => store().startPomodoroFocusForTask(id, {});
const drained = async () => vi.waitFor(() => expect(snapshot().pendingCredits ?? []).toHaveLength(0));
const receipts = new Map<string, { taskId: string; minutes: number }>();

beforeEach(() => {
    now = Date.parse('2026-11-16T10:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    window.localStorage.clear();
    receipts.clear();
    usePomodoroStore.setState({ hasHydrated: false });
    replaceTasks([task('a'), task('b')]);
    useTaskStore.setState({ isLoading: false, settings: {}, persistenceFailure: null });
    persistence.apply.mockReset().mockImplementation(async (credit: { id: string; taskId: string; minutes: number }) => {
        if (receipts.has(credit.id)) return 'already-applied';
        receipts.set(credit.id, credit);
        replaceTasks(useTaskStore.getState().tasks.map((item) => item.id === credit.taskId
            ? { ...item, timeSpentMinutes: (item.timeSpentMinutes ?? 0) + credit.minutes } : item));
        return 'applied';
    });
    persistence.acknowledge.mockReset().mockImplementation(async (ids: string[]) => { ids.forEach((id) => receipts.delete(id)); });
    persistence.flush.mockReset().mockResolvedValue(undefined);
    store().hydratePomodoro({});
});
afterEach(() => vi.restoreAllMocks());

describe('partial Pomodoro work', () => {
    it('records 8 + 4 + 13 active minutes once and one completed Pomodoro', async () => {
        start(); advance(8 * 60); pause(); await drained();
        expect(timeSpent()).toBe(8);
        advance(10 * 60); resume(); advance(4 * 60); pause(); await drained();
        expect(timeSpent()).toBe(12);
        resume(); advance(13 * 60); commit((previous) => previous); await drained();
        expect(timeSpent()).toBe(25);
        expect(snapshot().sessionHistory.totalCompletedFocusSessions).toBe(1);
        expect(snapshot().timerState.phase).toBe('break');
    });

    it('carries three 20-second intervals across pauses and restart', async () => {
        start(); advance(20); pause(); await drained();
        expect(timeSpent()).toBe(0);
        store().hydratePomodoro({});
        resume(); advance(20); pause(); await drained();
        resume(); advance(20); pause(); await drained();
        expect(timeSpent()).toBe(1);
        expect(snapshot().sessionHistory.totalCompletedFocusSessions).toBe(0);
    });

    it('settles the old owner before task switch and carries its own remainder', async () => {
        start(); advance(80); commit((previous) => ({ ...previous, selectedTaskId: 'b' })); await drained();
        expect(timeSpent('a')).toBe(1);
        advance(100); pause(); await drained();
        expect(timeSpent('b')).toBe(1);
        start('a'); advance(40); pause(); await drained();
        expect(timeSpent('a')).toBe(2);
        expect(timeSpent('b')).toBe(1);
    });

    it('preserves work on reset, preset change and switching to a break', async () => {
        start(); advance(120);
        commit((previous) => ({ ...previous, timerState: resetPomodoroState(previous.timerState, previous.durations) }));
        await drained(); expect(timeSpent()).toBe(2);
        resume(); advance(180);
        commit((previous) => ({ ...previous, durations: { focusMinutes: 15, breakMinutes: 3 },
            timerState: resetPomodoroState(previous.timerState, { focusMinutes: 15, breakMinutes: 3 }) }));
        await drained(); expect(timeSpent()).toBe(5);
        resume(); advance(120);
        commit((previous) => ({ ...previous, timerState: resetPomodoroState(previous.timerState, previous.durations, 'break') }));
        await drained(); expect(timeSpent()).toBe(7);
        resume(); advance(180); commit((previous) => previous); await drained();
        expect(timeSpent()).toBe(7);
        expect(snapshot().sessionHistory.totalCompletedFocusSessions).toBe(0);
    });

    it('pauses and records a task completed outside the timer, with no credit to its recurring successor', async () => {
        start(); advance(12 * 60);
        replaceTasks([task('a', { status: 'done', completedAt: new Date(now).toISOString(), recurrence: 'daily' }), task('successor')]);
        await drained();
        expect(timeSpent()).toBe(12);
        expect(timeSpent('successor')).toBe(0);
        expect(snapshot().selectedTaskId).toBeUndefined();
        expect(snapshot().timerState.isRunning).toBe(false);
        expect(snapshot().sessionHistory.totalCompletedFocusSessions).toBe(0);
        replaceTasks([task('a', { timeSpentMinutes: 12 }), task('successor')]);
        advance(60); commit((previous) => previous); await drained();
        expect(timeSpent()).toBe(12);
    });

    it('caps delayed completion at its timestamp despite newer countdown ticks', async () => {
        start(); advance(95);
        const completedAt = new Date(now).toISOString();
        advance(50); commit((previous) => previous);
        replaceTasks([task('a', { status: 'done', completedAt })]);
        await drained();
        expect(timeSpent()).toBe(1);
        expect(snapshot().workSecondsByTaskId?.a).toBe(35);
        expect(snapshot().timerState.isRunning).toBe(false);
    });

    it('preserves previously settled work when completion is backdated', async () => {
        start(); advance(120); pause(); await drained();
        const completedAt = new Date(now - 60_000).toISOString();
        resume(); advance(60); commit((previous) => previous);
        replaceTasks([task('a', { status: 'done', completedAt, timeSpentMinutes: 2 })]);
        await drained();
        expect(timeSpent()).toBe(3);
    });

    it('caps recovered work at the linked task completion time', async () => {
        start(); advance(12 * 60);
        usePomodoroStore.setState({ hasHydrated: false });
        replaceTasks([task('a', { status: 'done', completedAt: new Date(now).toISOString() })]);
        advance(60 * 60); store().hydratePomodoro({}); await drained();
        expect(timeSpent()).toBe(12);
        expect(snapshot().timerState.isRunning).toBe(false);
    });

    it('does not double-credit when expiry coincides with completion', async () => {
        start(); advance(25 * 60); commit((previous) => previous);
        replaceTasks([task('a', { status: 'done', completedAt: new Date(now).toISOString(), timeSpentMinutes: timeSpent() })]);
        await drained();
        expect(timeSpent()).toBe(25);
        expect(snapshot().sessionHistory.totalCompletedFocusSessions).toBe(1);
    });

    it('retains the same credit identity after a failed save and restart', async () => {
        persistence.apply.mockRejectedValueOnce(new Error('disk full'));
        start(); advance(120); pause();
        await vi.waitFor(() => expect(persistence.apply).toHaveBeenCalledTimes(1));
        const pending = snapshot().pendingCredits![0];
        expect(timeSpent()).toBe(0);
        store().hydratePomodoro({}); await drained();
        expect(persistence.apply.mock.calls[1][0]).toEqual(pending);
        expect(timeSpent()).toBe(2);
    });

    it('replays a durable receipt after a crash without overriding a later manual time edit', async () => {
        const apply = persistence.apply.getMockImplementation()!;
        persistence.apply.mockImplementationOnce(async (...args: unknown[]) => {
            await apply(...args); throw new Error('quit after durable write');
        });
        start(); advance(120); pause();
        await vi.waitFor(() => expect(timeSpent()).toBe(2));
        await vi.waitFor(() => expect(snapshot().pendingCredits).toHaveLength(1));
        replaceTasks([task('a', { timeSpentMinutes: 40 })]);
        store().hydratePomodoro({}); await drained();
        expect(timeSpent()).toBe(40);
    });

    it('does not apply a credit until the pending timer checkpoint is durable', async () => {
        start(); advance(120);
        vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
        pause(); await Promise.resolve();
        expect(persistence.apply).not.toHaveBeenCalled();
        vi.mocked(window.localStorage.setItem).mockRestore();
        store().hydratePomodoro({}); pause(); await drained();
        expect(timeSpent()).toBe(2);
    });

    it('does not acknowledge a receipt if removing its queued credit fails', async () => {
        start(); advance(120);
        const apply = persistence.apply.getMockImplementation()!;
        persistence.apply.mockImplementationOnce(async (...args: unknown[]) => {
            const result = await apply(...args);
            vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
            return result;
        });
        pause(); await drained();
        expect(persistence.acknowledge).not.toHaveBeenCalled();
        expect(timeSpent()).toBe(2);
        vi.mocked(window.localStorage.setItem).mockRestore();
        store().hydratePomodoro({}); await drained();
        expect(timeSpent()).toBe(2);
    });

    it('keeps unlinked work out of task totals and does not persist countdown ticks', async () => {
        start(); commit((previous) => ({ ...previous, selectedTaskId: undefined }));
        const saved = window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY);
        for (let index = 0; index < 5; index += 1) { advance(20); commit((previous) => previous); }
        expect(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY)).toBe(saved);
        pause(); await drained();
        expect(timeSpent()).toBe(0);
        expect(persistence.apply).not.toHaveBeenCalled();
    });

    it('migrates the current legacy partial session without re-crediting past blocks', async () => {
        window.localStorage.setItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
            durations: { focusMinutes: 25, breakMinutes: 5 },
            timerState: { phase: 'focus', remainingSeconds: 780, isRunning: false, completedFocusSessions: 2 },
            selectedTaskId: 'a', updatedAtMs: now,
            sessionHistory: { totalCompletedFocusSessions: 2, completedFocusSessionsByTaskId: { a: 2 } },
        }));
        replaceTasks([task('a', { timeSpentMinutes: 50 })]);
        store().hydratePomodoro({}); await drained();
        expect(timeSpent()).toBe(62);
        store().hydratePomodoro({}); await drained();
        expect(timeSpent()).toBe(62);
    });

    it('keeps legacy credits pending if task persistence fails', async () => {
        window.localStorage.setItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
            durations: { focusMinutes: 25, breakMinutes: 5 },
            timerState: { phase: 'break', remainingSeconds: 300, isRunning: false, completedFocusSessions: 1 },
            updatedAtMs: now, workSecondsByTaskId: {},
            pendingCredits: [{ taskId: 'a', to: 25 }],
        }));
        useTaskStore.setState({ updateTask: vi.fn(async (id, patch) => {
            replaceTasks([task(id, patch)]); return { success: true };
        }) });
        persistence.flush.mockRejectedValue(new Error('disk full'));
        store().hydratePomodoro({});
        await vi.waitFor(() => expect(persistence.flush).toHaveBeenCalled());
        expect(snapshot().pendingCredits).toHaveLength(1);
        persistence.flush.mockResolvedValue(undefined);
        commit((previous) => previous); await drained();
        expect(timeSpent()).toBe(25);
    });

    it('retains collapsed preference and arms audio only when starting', () => {
        vi.mocked(armPomodoroCompletionSound).mockClear();
        store().setPomodoroCollapsed(true);
        expect(window.localStorage.getItem(DESKTOP_POMODORO_COLLAPSED_STORAGE_KEY)).toBe('true');
        start(); expect(store().collapsed).toBe(false);
        advance(1); commit((previous) => previous);
        expect(armPomodoroCompletionSound).toHaveBeenCalledTimes(1);
    });
});
