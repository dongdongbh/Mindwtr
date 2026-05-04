import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    advancePomodoroState,
    createPomodoroState,
    DEFAULT_POMODORO_DURATIONS,
    formatPomodoroClock,
    getPomodoroPresetOptions,
    PomodoroAutoStartOptions,
    PomodoroDurations,
    PomodoroEvent,
    PomodoroState,
    resetPomodoroState,
    Task,
    translateWithFallback,
    useTaskStore,
} from '@mindwtr/core';
import { Play, Pause, RotateCcw, TimerReset, CheckCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useLanguage } from '../../contexts/language-context';
import { sendDesktopImmediateNotification } from '../../lib/notification-service';

interface PomodoroPanelProps {
    tasks: Task[];
}

type PomodoroSnapshot = {
    durations: PomodoroDurations;
    timerState: PomodoroState;
    selectedTaskId?: string;
    lastEvent: PomodoroEvent | null;
    updatedAtMs: number;
};

const createInitialSnapshot = (): PomodoroSnapshot => ({
    durations: DEFAULT_POMODORO_DURATIONS,
    timerState: createPomodoroState(DEFAULT_POMODORO_DURATIONS),
    selectedTaskId: undefined,
    lastEvent: null,
    updatedAtMs: Date.now(),
});

const reconcileSnapshot = (
    snapshot: PomodoroSnapshot,
    nowMs: number,
    autoStartOptions: PomodoroAutoStartOptions
): PomodoroSnapshot => {
    if (!snapshot.timerState.isRunning) {
        return { ...snapshot, updatedAtMs: nowMs };
    }
    const elapsedSeconds = Math.floor((nowMs - snapshot.updatedAtMs) / 1000);
    if (elapsedSeconds <= 0) return snapshot;
    const advanced = advancePomodoroState(snapshot.timerState, snapshot.durations, elapsedSeconds, autoStartOptions);
    const updatedAtMs = snapshot.updatedAtMs + elapsedSeconds * 1000;
    return {
        ...snapshot,
        timerState: advanced.state,
        lastEvent: advanced.lastEvent ?? snapshot.lastEvent,
        updatedAtMs,
    };
};

let persistedSnapshot: PomodoroSnapshot = createInitialSnapshot();

export function PomodoroPanel({ tasks }: PomodoroPanelProps) {
    const updateTask = useTaskStore((state) => state.updateTask);
    const notificationsEnabled = useTaskStore((state) => state.settings.notificationsEnabled !== false);
    const customDurations = useTaskStore((state) => state.settings.gtd?.pomodoro?.customDurations);
    const linkTaskEnabled = useTaskStore((state) => state.settings.gtd?.pomodoro?.linkTask === true);
    const autoStartBreaks = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartBreaks === true);
    const autoStartFocus = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartFocus === true);
    const { t } = useLanguage();
    const autoStartOptions = useMemo<PomodoroAutoStartOptions>(
        () => ({ autoStartBreaks, autoStartFocus }),
        [autoStartBreaks, autoStartFocus]
    );
    const resolveText = useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);
    const [snapshot, setSnapshot] = useState<PomodoroSnapshot>(() => {
        persistedSnapshot = reconcileSnapshot(persistedSnapshot, Date.now(), autoStartOptions);
        return persistedSnapshot;
    });
    const previousEventRef = useRef<PomodoroEvent | null>(snapshot.lastEvent);

    const commitSnapshot = useCallback((updater: (prev: PomodoroSnapshot) => PomodoroSnapshot) => {
        setSnapshot((prev) => {
            const next = updater(prev);
            persistedSnapshot = next;
            return next;
        });
    }, []);

    useEffect(() => {
        if (!linkTaskEnabled) {
            return;
        }
        if (!snapshot.selectedTaskId) return;
        if (snapshot.selectedTaskId && tasks.some((task) => task.id === snapshot.selectedTaskId)) return;
        commitSnapshot((prev) => ({ ...prev, selectedTaskId: undefined }));
    }, [commitSnapshot, linkTaskEnabled, snapshot.selectedTaskId, tasks]);

    useEffect(() => {
        if (!snapshot.timerState.isRunning) return;
        const intervalId = window.setInterval(() => {
            commitSnapshot((prev) => reconcileSnapshot(prev, Date.now(), autoStartOptions));
        }, 1000);
        return () => window.clearInterval(intervalId);
    }, [autoStartOptions, commitSnapshot, snapshot.timerState.isRunning]);

    const durations = snapshot.durations;
    const timerState = snapshot.timerState;
    const selectedTaskId = snapshot.selectedTaskId;
    const lastEvent = snapshot.lastEvent;

    const selectedTask = useMemo(
        () => (linkTaskEnabled && selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : undefined),
        [linkTaskEnabled, selectedTaskId, tasks]
    );
    const presetOptions = useMemo(() => getPomodoroPresetOptions(customDurations), [customDurations]);

    const phaseLabel = timerState.phase === 'focus'
        ? resolveText('pomodoro.phaseFocus', 'Focus session')
        : resolveText('pomodoro.phaseBreak', 'Break');
    const cardTitle = resolveText('pomodoro.title', 'Pomodoro Focus');
    const subtitle = resolveText('pomodoro.subtitle', 'Work one task at a time.');
    const sessionCountLabel = resolveText('pomodoro.sessionsDone', 'Focus sessions completed');
    const switchPhaseLabel = resolveText('pomodoro.switchPhase', 'Switch phase');
    const markDoneLabel = resolveText('pomodoro.markTaskDone', 'Mark task done');
    const noTaskLabel = resolveText('pomodoro.noTask', 'No available focus task');
    const selectedTaskLabel = resolveText('pomodoro.selectedTask', 'Timer task');
    const timerControlsLabel = resolveText('pomodoro.timerControls', 'Timer');
    const taskUpdateLabel = resolveText('pomodoro.taskUpdate', 'Task update');
    const timerOnlyLabel = resolveText('pomodoro.timerOnly', 'Timer only');
    const focusDoneLabel = resolveText('pomodoro.focusComplete', 'Focus session complete. Take a short break.');
    const breakDoneLabel = resolveText('pomodoro.breakComplete', 'Break complete. Ready for the next focus session.');

    useEffect(() => {
        const previous = previousEventRef.current;
        if (lastEvent && lastEvent !== previous && notificationsEnabled) {
            const message = lastEvent === 'focus-finished' ? focusDoneLabel : breakDoneLabel;
            void sendDesktopImmediateNotification(cardTitle, message);
        }
        previousEventRef.current = lastEvent;
    }, [breakDoneLabel, cardTitle, focusDoneLabel, lastEvent, notificationsEnabled]);

    const handleApplyPreset = (focusMinutes: number, breakMinutes: number) => {
        const nextDurations = { focusMinutes, breakMinutes };
        commitSnapshot((prev) => {
            const reconciled = reconcileSnapshot(prev, Date.now(), autoStartOptions);
            return {
                ...reconciled,
                durations: nextDurations,
                timerState: resetPomodoroState(reconciled.timerState, nextDurations, reconciled.timerState.phase),
                lastEvent: null,
                updatedAtMs: Date.now(),
            };
        });
    };

    const handleToggleRun = () => {
        commitSnapshot((prev) => {
            const reconciled = reconcileSnapshot(prev, Date.now(), autoStartOptions);
            return {
                ...reconciled,
                timerState: { ...reconciled.timerState, isRunning: !reconciled.timerState.isRunning },
                updatedAtMs: Date.now(),
            };
        });
    };

    const handleReset = () => {
        commitSnapshot((prev) => {
            const reconciled = reconcileSnapshot(prev, Date.now(), autoStartOptions);
            return {
                ...reconciled,
                timerState: resetPomodoroState(reconciled.timerState, reconciled.durations, reconciled.timerState.phase),
                lastEvent: null,
                updatedAtMs: Date.now(),
            };
        });
    };

    const handleSwitchPhase = () => {
        commitSnapshot((prev) => {
            const reconciled = reconcileSnapshot(prev, Date.now(), autoStartOptions);
            return {
                ...reconciled,
                timerState: resetPomodoroState(
                    reconciled.timerState,
                    reconciled.durations,
                    reconciled.timerState.phase === 'focus' ? 'break' : 'focus'
                ),
                lastEvent: null,
                updatedAtMs: Date.now(),
            };
        });
    };

    const handleMarkTaskDone = async () => {
        if (!selectedTask) return;
        await updateTask(selectedTask.id, { status: 'done', isFocusedToday: false });
        commitSnapshot((prev) => ({ ...prev, lastEvent: null }));
    };

    return (
        <section className="bg-card border border-border rounded-xl p-4 space-y-4">
            <header className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h3 className="font-semibold text-lg">{cardTitle}</h3>
                    <p className="text-xs text-muted-foreground">{subtitle}</p>
                </div>
                <span
                    className={cn(
                        'text-xs px-2 py-1 rounded-full border font-medium',
                        timerState.phase === 'focus'
                            ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-700/40'
                            : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-200 dark:border-emerald-700/40'
                    )}
                >
                    {phaseLabel}
                </span>
            </header>

            <div className="flex flex-wrap gap-2">
                {presetOptions.map((preset) => {
                    const active = durations.focusMinutes === preset.focusMinutes && durations.breakMinutes === preset.breakMinutes;
                    return (
                        <button
                            key={preset.id}
                            type="button"
                            onClick={() => handleApplyPreset(preset.focusMinutes, preset.breakMinutes)}
                            className={cn(
                                'text-xs px-2.5 py-1.5 rounded-full border transition-colors',
                                active
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
                            )}
                        >
                            {preset.label}
                        </button>
                    );
                })}
            </div>

            <div className="text-center">
                <p className="font-mono text-5xl leading-none tracking-wider">{formatPomodoroClock(timerState.remainingSeconds)}</p>
                <p className="text-xs text-muted-foreground mt-2">
                    {sessionCountLabel}: {timerState.completedFocusSessions}
                </p>
            </div>

            {linkTaskEnabled && (
                <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">
                        {selectedTaskLabel}
                    </label>
                    <select
                        className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                        aria-label={selectedTaskLabel}
                        value={selectedTaskId ?? ''}
                        onChange={(event) => {
                            const nextId = event.target.value || undefined;
                            commitSnapshot((prev) => ({ ...prev, selectedTaskId: nextId }));
                        }}
                    >
                        <option value="">{tasks.length === 0 ? noTaskLabel : timerOnlyLabel}</option>
                        {tasks.map((task) => (
                            <option key={task.id} value={task.id}>
                                {task.title}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase text-muted-foreground">{timerControlsLabel}</div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={handleToggleRun}
                            className={cn(
                                'inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded border transition-colors',
                                'bg-primary text-primary-foreground border-primary hover:opacity-90'
                            )}
                        >
                            {timerState.isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                            {timerState.isRunning
                                ? resolveText('common.pause', 'Pause')
                                : resolveText('common.start', 'Start')}
                        </button>
                        <button
                            type="button"
                            onClick={handleReset}
                            className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded border border-border bg-muted/50 text-muted-foreground hover:bg-muted transition-colors"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                            {resolveText('common.reset', 'Reset')}
                        </button>
                        <button
                            type="button"
                            onClick={handleSwitchPhase}
                            className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded border border-border bg-muted/50 text-muted-foreground hover:bg-muted transition-colors"
                        >
                            <TimerReset className="w-3.5 h-3.5" />
                            {switchPhaseLabel}
                        </button>
                    </div>
                </div>
                {linkTaskEnabled && selectedTask && (
                    <div className="space-y-1.5 sm:ml-auto">
                        <div className="text-[11px] font-semibold uppercase text-muted-foreground sm:text-right">{taskUpdateLabel}</div>
                        <button
                            type="button"
                            onClick={() => {
                                void handleMarkTaskDone();
                            }}
                            disabled={!selectedTask}
                            title={markDoneLabel}
                            className={cn(
                                'inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded border transition-colors',
                                selectedTask
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-500 hover:bg-emerald-100 dark:bg-emerald-950/20 dark:text-emerald-300 dark:border-emerald-700 dark:hover:bg-emerald-900/30'
                                    : 'bg-muted text-muted-foreground border-border cursor-not-allowed opacity-60'
                            )}
                        >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {markDoneLabel}
                        </button>
                    </div>
                )}
            </div>

            {lastEvent && (
                <p className="text-xs text-muted-foreground">
                    {lastEvent === 'focus-finished' ? focusDoneLabel : breakDoneLabel}
                </p>
            )}
        </section>
    );
}
