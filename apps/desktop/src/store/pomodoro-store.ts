import { createWithEqualityFn } from 'zustand/traditional';
import { armPomodoroCompletionSound } from '../lib/pomodoro-alert';
import {
    addTimeSpentMinutes,
    accumulatePomodoroWork,
    settlePomodoroWork,
    applyPomodoroCredit,
    acknowledgePomodoroCredits,
    isTaskActionable,
    advancePomodoroState,
    createPomodoroState,
    DEFAULT_POMODORO_DURATIONS,
    flushPendingSave,
    logInfo,
    logWarn,
    recordPomodoroFocusSessions,
    resetPomodoroState,
    runStoreCommand,
    sanitizePomodoroDurations,
    sanitizePomodoroSessionHistory,
    useTaskStore,
    type PomodoroAutoStartOptions,
    type PomodoroDurations,
    type PomodoroEvent,
    type PomodoroSessionHistory,
    type PomodoroState,
} from '@mindwtr/core';
import { getWorkspaceCache } from '../lib/workspace-cache';

export const DESKTOP_POMODORO_SESSION_STORAGE_KEY = 'mindwtr:pomodoro:session:v1';
export const DESKTOP_POMODORO_COLLAPSED_STORAGE_KEY = 'mindwtr:pomodoro:collapsed:v1';


type LegacyPomodoroCredit = { taskId: string; from?: number; to: number };
type PomodoroCredit = LegacyPomodoroCredit | { id: string; taskId: string; minutes: number };

export type PomodoroSnapshot = {
    durations: PomodoroDurations;
    timerState: PomodoroState;
    selectedTaskId?: string;
    lastEvent: PomodoroEvent | null;
    updatedAtMs: number;
    sessionHistory: PomodoroSessionHistory;

    pendingCredits?: PomodoroCredit[];
    workSecondsByTaskId?: Record<string, number>;
};


const loadedCredits = new WeakSet<PomodoroCredit>();

const writtenCredits = new WeakSet<PomodoroCredit>();

const readCredits = (value: unknown): PomodoroCredit[] => (Array.isArray(value) ? value : []).flatMap<PomodoroCredit>((item) => {
    if (!isRecord(item) || typeof item.taskId !== 'string') return [];
    if (typeof item.id === 'string' && typeof item.minutes === 'number' && Number.isSafeInteger(item.minutes) && item.minutes > 0) {
        return [{ id: item.id, taskId: item.taskId, minutes: item.minutes }];
    }
    if (typeof item.to !== 'number' || !Number.isFinite(item.to)) return [];
    const credit: PomodoroCredit = { taskId: item.taskId, to: item.to,
        ...(typeof item.from === 'number' && Number.isFinite(item.from) ? { from: item.from } : {}) };
    loadedCredits.add(credit);
    return [credit];
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
    !!value && typeof value === 'object' && !Array.isArray(value)
);

const createInitialSnapshot = (nowMs = Date.now()): PomodoroSnapshot => ({
    durations: DEFAULT_POMODORO_DURATIONS,
    timerState: createPomodoroState(DEFAULT_POMODORO_DURATIONS),
    selectedTaskId: undefined,
    lastEvent: null,
    updatedAtMs: nowMs,
    sessionHistory: sanitizePomodoroSessionHistory(),
});

export const reconcilePomodoroSnapshot = (
    snapshot: PomodoroSnapshot,
    nowMs: number,
    autoStartOptions: PomodoroAutoStartOptions
): PomodoroSnapshot => {
    if (!snapshot.timerState.isRunning) {
        return { ...snapshot, workSecondsByTaskId: accumulatePomodoroWork(snapshot, snapshot.timerState), updatedAtMs: nowMs };
    }
    const elapsedSeconds = Math.floor((nowMs - snapshot.updatedAtMs) / 1000);
    if (elapsedSeconds <= 0) return snapshot;
    const advanced = advancePomodoroState(snapshot.timerState, snapshot.durations, elapsedSeconds, autoStartOptions);
    const completedSessionDelta = advanced.state.completedFocusSessions - snapshot.timerState.completedFocusSessions;
    const sessionHistory = completedSessionDelta > 0
        ? recordPomodoroFocusSessions(snapshot.sessionHistory, snapshot.selectedTaskId, completedSessionDelta)
        : snapshot.sessionHistory;
    const updatedAtMs = snapshot.updatedAtMs + elapsedSeconds * 1000;
    return {
        ...snapshot,
        timerState: {
            ...advanced.state,
            completedFocusSessions: Math.max(
                advanced.state.completedFocusSessions,
                sessionHistory.totalCompletedFocusSessions
            ),
        },
        sessionHistory,
        workSecondsByTaskId: accumulatePomodoroWork(snapshot, advanced.state),
        lastEvent: advanced.lastEvent ?? snapshot.lastEvent,
        updatedAtMs,
    };
};

const reconcileLinkedTask = (snapshot: PomodoroSnapshot, nowMs: number, options: PomodoroAutoStartOptions, checkpoint = snapshot): PomodoroSnapshot => {
    const state = useTaskStore.getState();
    const task = snapshot.selectedTaskId ? state._tasksById.get(snapshot.selectedTaskId) : undefined;
    const detached = Boolean(snapshot.selectedTaskId && !state.isLoading && (!task || task.deletedAt || !isTaskActionable(task)));
    const stoppedAt = detached && task ? Date.parse(task.completedAt ?? task.cancelledAt ?? task.deletedAt ?? '') : NaN;
    const source = detached && Number.isFinite(stoppedAt)
        && checkpoint.selectedTaskId === snapshot.selectedTaskId
        && checkpoint.timerState.isRunning && stoppedAt >= checkpoint.updatedAtMs
        ? { ...checkpoint, pendingCredits: snapshot.pendingCredits }
        : snapshot;
    const resolvedAt = Number.isFinite(stoppedAt) ? Math.max(source.updatedAtMs, Math.min(nowMs, stoppedAt)) : nowMs;
    const resolved = reconcilePomodoroSnapshot(source, resolvedAt, options);
    return detached ? {
        ...resolved,
        selectedTaskId: undefined,
        timerState: resolved.timerState.phase === 'focus' ? { ...resolved.timerState, isRunning: false } : resolved.timerState,
        updatedAtMs: nowMs,
    } : resolved;
};

const sanitizeStoredPomodoroState = (
    value: unknown,
    durations: PomodoroDurations
): PomodoroState => {
    const record = isRecord(value) ? value : {};
    const phase = record.phase === 'break' ? 'break' : 'focus';
    const baseState = createPomodoroState(
        durations,
        phase,
        typeof record.completedFocusSessions === 'number' ? record.completedFocusSessions : 0
    );
    const remainingSeconds = typeof record.remainingSeconds === 'number' && Number.isFinite(record.remainingSeconds)
        ? Math.max(0, Math.min(baseState.remainingSeconds, Math.floor(record.remainingSeconds)))
        : baseState.remainingSeconds;

    return {
        ...baseState,
        remainingSeconds,
        isRunning: record.isRunning === true,
    };
};

const parseStoredPomodoroSnapshot = (value: unknown, nowMs: number): PomodoroSnapshot => {
    if (!isRecord(value)) return createInitialSnapshot(nowMs);

    const durations = sanitizePomodoroDurations(isRecord(value.durations) ? value.durations : undefined);
    const sanitizedTimerState = sanitizeStoredPomodoroState(value.timerState, durations);
    const sessionHistory = sanitizePomodoroSessionHistory(
        isRecord(value.sessionHistory) ? value.sessionHistory : undefined,
        sanitizedTimerState.completedFocusSessions
    );
    const timerState = {
        ...sanitizedTimerState,
        completedFocusSessions: Math.max(
            sanitizedTimerState.completedFocusSessions,
            sessionHistory.totalCompletedFocusSessions
        ),
    };
    const updatedAtMs = typeof value.updatedAtMs === 'number' && Number.isFinite(value.updatedAtMs)
        ? value.updatedAtMs
        : nowMs;
    const selectedTaskId = typeof value.selectedTaskId === 'string' && value.selectedTaskId.trim().length > 0
        ? value.selectedTaskId
        : undefined;
    const pendingCredits = readCredits(value.pendingCredits);

    return {
        durations,
        timerState,
        selectedTaskId,
        lastEvent: null,
        updatedAtMs,
        sessionHistory,
        workSecondsByTaskId: accumulatePomodoroWork({
            durations, timerState, selectedTaskId,
            workSecondsByTaskId: isRecord(value.workSecondsByTaskId) ? value.workSecondsByTaskId as Record<string, number> : undefined,
        }, timerState),
        ...(pendingCredits.length > 0 ? { pendingCredits } : {}),
    };
};

const readStoredPomodoroSnapshot = (nowMs: number): PomodoroSnapshot => {
    if (typeof window === 'undefined') return createInitialSnapshot(nowMs);
    try {
        const raw = getWorkspaceCache()?.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY);
        if (!raw) return createInitialSnapshot(nowMs);
        return parseStoredPomodoroSnapshot(JSON.parse(raw) as unknown, nowMs);
    } catch {
        return createInitialSnapshot(nowMs);
    }
};


const saveStoredPomodoroSnapshot = (snapshot: PomodoroSnapshot): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        const cache = getWorkspaceCache();
        if (!cache) return false;
        cache.setItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
            durations: snapshot.durations,
            timerState: snapshot.timerState,
            selectedTaskId: snapshot.selectedTaskId,
            updatedAtMs: snapshot.updatedAtMs,
            sessionHistory: snapshot.sessionHistory,
            workSecondsByTaskId: snapshot.workSecondsByTaskId,
            ...(snapshot.pendingCredits?.length ? { pendingCredits: snapshot.pendingCredits } : {}),
        }));
        return true;
    } catch {

        return false;
    }
};


const isCountdownTickOnly = (prev: PomodoroSnapshot, next: PomodoroSnapshot): boolean => (
    prev.timerState.isRunning
    && next.timerState.isRunning
    && prev.timerState.phase === next.timerState.phase
    && prev.timerState.completedFocusSessions === next.timerState.completedFocusSessions
    && prev.durations === next.durations
    && prev.selectedTaskId === next.selectedTaskId
    && prev.sessionHistory === next.sessionHistory
);

const readStoredCollapsed = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return getWorkspaceCache()?.getItem(DESKTOP_POMODORO_COLLAPSED_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
};

const saveStoredCollapsed = (collapsed: boolean) => {
    if (typeof window === 'undefined') return;
    try {
        getWorkspaceCache()?.setItem(DESKTOP_POMODORO_COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false');
    } catch {

    }
};


const withNewCredits = (next: PomodoroSnapshot): PomodoroSnapshot => {
    const work = settlePomodoroWork(next.workSecondsByTaskId ?? {});
    if (work.credits.length === 0) return next;
    return {
        ...next,
        workSecondsByTaskId: work.workSecondsByTaskId,
        pendingCredits: [...(next.pendingCredits ?? []), ...work.credits.map((credit) => ({ ...credit, id: crypto.randomUUID() }))],
    };
};


let workCheckpoint = createInitialSnapshot();
let settling: Promise<void> | null = null;

let settleGeneration = 0;
let settlementRequested = false;
const settleCredits = (): Promise<void> => {
    if (settling) { settlementRequested = true; return settling; }
    const generation = settleGeneration;
    settlementRequested = false;
    settling ??= (async () => {
        const credits = usePomodoroStore.getState().snapshot.pendingCredits ?? [];
        const done = new Set<PomodoroCredit>();
        for (const credit of credits) {
            if (generation !== settleGeneration) return;
            if ('id' in credit) {
                try {
                    const outcome = await applyPomodoroCredit(credit);
                    done.add(credit);
                    void logInfo('Pomodoro active work settled', {
                        scope: 'pomodoro', context: { releaseCheck: 'v1.3.9/pomodoro-partial-work', outcome },
                    });
                } catch {
                    void logWarn('Pomodoro active work kept pending', {
                        scope: 'pomodoro', context: { releaseCheck: 'v1.3.9/pomodoro-partial-work', outcome: 'pending' },
                    });
                    break;
                }
                continue;
            }
            const outcome = await runStoreCommand(async () => {
                if (generation !== settleGeneration) return null;
                const { tasks, updateTask } = useTaskStore.getState();
                const task = tasks.find((candidate) => candidate.id === credit.taskId);
                const time = task?.timeSpentMinutes;
                if (!task) return 'gone';

                if (time === credit.to && credit.to !== credit.from) return 'written';
                let to = credit.to;
                if (time !== credit.from) {
                    if (loadedCredits.has(credit) || writtenCredits.has(credit)) return 'gone';
                    let chainTo = credit.to;
                    to = addTimeSpentMinutes(time, credit.to - (credit.from ?? 0)) ?? credit.to;
                    credit.from = time;
                    credit.to = to;

                    const pending = usePomodoroStore.getState().snapshot.pendingCredits ?? [];
                    let movedTo = to;
                    for (const later of pending.slice(pending.indexOf(credit) + 1)) {
                        if ('id' in later || later.taskId !== credit.taskId || later.from !== chainTo || loadedCredits.has(later)) continue;
                        chainTo = later.to;
                        later.to = addTimeSpentMinutes(movedTo, later.to - later.from) ?? later.to;
                        later.from = movedTo;
                        movedTo = later.to;
                    }

                    if (!saveStoredPomodoroSnapshot(usePomodoroStore.getState().snapshot)) return null;
                    void logInfo('Pomodoro credit moved onto the task time', {
                        scope: 'pomodoro', context: { releaseCheck: 'v1.3.8/pomodoro-credit-moved', outcome: 'moved' },
                    });
                }
                await updateTask(credit.taskId, { timeSpentMinutes: to });
                writtenCredits.add(credit);
                return 'written';
            }).catch(() => null);
            if (!outcome) break;


            if (outcome === 'written' && !await flushPendingSave()
                .then(() => useTaskStore.getState().persistenceFailure === null, () => false)) {
                void logWarn('Pomodoro credit kept owed: the task save did not finish', {
                    scope: 'pomodoro', context: { releaseCheck: 'v1.3.8/pomodoro-credit-durable', outcome: 'owed' },
                });
                break;
            }
            done.add(credit);
        }
        if (generation !== settleGeneration) return;
        if (done.size > 0) {
            const snapshot = usePomodoroStore.getState().snapshot;
            const left = (snapshot.pendingCredits ?? []).filter((credit) => !done.has(credit));
            const next = { ...snapshot, pendingCredits: left.length > 0 ? left : undefined };
            const saved = saveStoredPomodoroSnapshot(next);
            usePomodoroStore.setState({ snapshot: next });
            if (saved) {
                const ids = [...done].flatMap((credit) => 'id' in credit ? [credit.id] : []);
                if (ids.length > 0) await acknowledgePomodoroCredits(ids).catch(() => undefined);
            }
        }
    })().finally(() => {
        if (generation !== settleGeneration) return;
        settling = null;
        if (settlementRequested) {
            settlementRequested = false;
            if (usePomodoroStore.getState().snapshot.pendingCredits?.length) void settleCredits();
        }
    });
    return settling;
};

type PomodoroStoreState = {
    snapshot: PomodoroSnapshot;
    hasHydrated: boolean;

    collapsed: boolean;

    hydratePomodoro: (autoStartOptions: PomodoroAutoStartOptions) => void;

    commitPomodoro: (updater: (prev: PomodoroSnapshot) => PomodoroSnapshot) => void;

    setPomodoroCollapsed: (collapsed: boolean) => void;

    startPomodoroFocusForTask: (taskId: string, autoStartOptions: PomodoroAutoStartOptions) => void;
};

export const usePomodoroStore = createWithEqualityFn<PomodoroStoreState>((set, get) => ({
    snapshot: createInitialSnapshot(),
    hasHydrated: false,
    collapsed: readStoredCollapsed(),
    hydratePomodoro: (autoStartOptions) => {
        const nowMs = Date.now();


        get().snapshot.pendingCredits?.forEach((credit) => loadedCredits.add(credit));
        const stored = readStoredPomodoroSnapshot(nowMs);
        settleGeneration += 1;
        settling = null;
        const reconciled = withNewCredits(reconcileLinkedTask(stored, nowMs, autoStartOptions));
        const saved = saveStoredPomodoroSnapshot(reconciled);
        workCheckpoint = reconciled;
        set({ snapshot: reconciled, hasHydrated: true });
        if (saved && reconciled.pendingCredits?.length) void settleCredits();
    },
    commitPomodoro: (updater) => {
        const prev = get().snapshot;
        const options = useTaskStore.getState().settings.gtd?.pomodoro;
        const reconciled = reconcileLinkedTask(prev, Date.now(), {
            autoStartFocus: options?.autoStartFocus === true,
            autoStartBreaks: options?.autoStartBreaks === true,
        }, workCheckpoint);
        const next = updater(reconciled);


        if (!prev.timerState.isRunning && next.timerState.isRunning) {
            armPomodoroCompletionSound();
        }
        const countdownOnly = isCountdownTickOnly(prev, next);
        const credited = countdownOnly ? next : withNewCredits(next);
        const saved = !countdownOnly && saveStoredPomodoroSnapshot(credited);
        if (!countdownOnly) workCheckpoint = credited;
        set({ snapshot: credited });
        if (saved && credited.pendingCredits?.length) void settleCredits();
    },
    setPomodoroCollapsed: (collapsed) => {
        saveStoredCollapsed(collapsed);
        set({ collapsed });
    },
    startPomodoroFocusForTask: (taskId, autoStartOptions) => {
        if (!get().hasHydrated) {
            get().hydratePomodoro(autoStartOptions);
        }

        get().setPomodoroCollapsed(false);
        get().commitPomodoro((prev) => {
            const reconciled = reconcilePomodoroSnapshot(prev, Date.now(), autoStartOptions);
            return {
                ...reconciled,
                selectedTaskId: taskId,
                timerState: {
                    ...resetPomodoroState(reconciled.timerState, reconciled.durations, 'focus'),
                    isRunning: true,
                },
                lastEvent: null,
                updatedAtMs: Date.now(),
            };
        });
    },
}));

useTaskStore.subscribe((state, previous) => {
    if (state.tasks === previous.tasks || state.isLoading) return;
    const timer = usePomodoroStore.getState();
    const selectedTaskId = timer.snapshot.selectedTaskId;
    if (!timer.hasHydrated || !selectedTaskId) return;
    const task = state._tasksById.get(selectedTaskId);
    if (task && !task.deletedAt && isTaskActionable(task)) return;
    timer.commitPomodoro((snapshot) => ({
        ...snapshot,
        selectedTaskId: undefined,
        timerState: snapshot.timerState.phase === 'focus' ? { ...snapshot.timerState, isRunning: false } : snapshot.timerState,
    }));
});
