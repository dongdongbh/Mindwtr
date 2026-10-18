import { useCallback, useEffect, useMemo } from 'react';
import {
    formatPomodoroClock,
    getPomodoroFocusSessionsCompletedToday,
    getPomodoroPresetOptions,
    isTaskActionable,
    PomodoroAutoStartOptions,
    resetPomodoroState,
    Task,
    translateWithFallback,
    useTaskStore,
} from '@mindwtr/core';
import { Play, Pause, RotateCcw, TimerReset, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useLanguage } from '../../contexts/language-context';
import { reconcilePomodoroSnapshot, usePomodoroStore } from '../../store/pomodoro-store';
import { useUiStore } from '../../store/ui-store';
import { PomodoroTaskPicker } from './PomodoroTaskPicker';

export { DESKTOP_POMODORO_SESSION_STORAGE_KEY } from '../../store/pomodoro-store';

interface PomodoroPanelProps {
    tasks: Task[];
}

export function PomodoroPanel({ tasks }: PomodoroPanelProps) {
    const updateTask = useTaskStore((state) => state.updateTask);
    const customDurations = useTaskStore((state) => state.settings.gtd?.pomodoro?.customDurations);
    const linkTaskEnabled = useTaskStore((state) => state.settings.gtd?.pomodoro?.linkTask === true);
    // Links can outlive Focus membership (#867), but must follow live task status.
    const liveTasks = useTaskStore((state) => state.tasks);
    const actionableTasksById = useMemo(
        () => new Map(liveTasks.filter(isTaskActionable).map((task) => [task.id, task])),
        [liveTasks]
    );
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
    const snapshot = usePomodoroStore((state) => state.snapshot);
    const collapsed = usePomodoroStore((state) => state.collapsed);
    const setCollapsed = usePomodoroStore((state) => state.setPomodoroCollapsed);
    const hydratePomodoro = usePomodoroStore((state) => state.hydratePomodoro);
    const commitSnapshot = usePomodoroStore((state) => state.commitPomodoro);

    useEffect(() => {
        // Re-read persisted state on mount, including any session that completed while the app was closed.
        hydratePomodoro(autoStartOptions);
    }, []);

    useEffect(() => {
        if (!linkTaskEnabled) {
            return;
        }
        if (!snapshot.selectedTaskId) return;
        if (actionableTasksById.has(snapshot.selectedTaskId)) return;
        commitSnapshot((prev) => ({ ...prev, selectedTaskId: undefined }));
    }, [commitSnapshot, linkTaskEnabled, snapshot.selectedTaskId, actionableTasksById]);

    // The clock tick and the completion alert live in usePomodoroAlerts, mounted
    // by App: this panel only exists inside Agenda, so running them here meant a
    // timer stopped ticking and stopped alerting the moment the user left the
    // view (#528).

    const durations = snapshot.durations;
    const timerState = snapshot.timerState;
    const selectedTaskId = snapshot.selectedTaskId;
    const lastEvent = snapshot.lastEvent;

    const selectedTask = linkTaskEnabled && selectedTaskId ? actionableTasksById.get(selectedTaskId) : undefined;
    // The picker offers Focus tasks, but a task linked from Review or the calendar
    // will not be among them. Include it so the trigger can name what is linked and
    // the dropdown can unlink it, instead of reading "Timer only" while a timer runs
    // against a task the panel refuses to show (#867).
    const pickerTasks = useMemo(() => {
        const focusTasks = tasks.flatMap((task) => {
            const liveTask = actionableTasksById.get(task.id);
            return liveTask ? [liveTask] : [];
        });
        return selectedTask && !focusTasks.some((task) => task.id === selectedTask.id)
            ? [selectedTask, ...focusTasks]
            : focusTasks;
    }, [actionableTasksById, selectedTask, tasks]);
    const presetOptions = useMemo(() => getPomodoroPresetOptions(customDurations), [customDurations]);

    const phaseLabel = timerState.phase === 'focus'
        ? resolveText('pomodoro.phaseFocusShort', 'Focus')
        : resolveText('pomodoro.phaseBreakShort', 'Break');
    const cardTitle = resolveText('pomodoro.title', 'Pomodoro Focus');
    const sessionCountLabel = resolveText('pomodoro.sessionsDone', 'Focus sessions completed');
    const switchPhaseLabel = timerState.phase === 'focus'
        ? resolveText('pomodoro.switchToBreak', 'Switch to Break')
        : resolveText('pomodoro.switchToFocus', 'Switch to Focus');
    const markDoneLabel = resolveText('pomodoro.markTaskDone', 'Mark task done');
    const noTaskLabel = resolveText('pomodoro.noTask', 'No available focus task');
    const selectedTaskLabel = resolveText('pomodoro.selectedTask', 'Timer task');
    const timerOnlyLabel = resolveText('pomodoro.timerOnly', 'Timer only');
    const focusDoneLabel = resolveText('pomodoro.focusComplete', 'Focus session complete. Take a short break.');
    const breakDoneLabel = resolveText('pomodoro.breakComplete', 'Break complete. Ready for the next focus session.');
    const collapseLabel = resolveText('pomodoro.collapse', 'Collapse timer');
    const expandLabel = resolveText('pomodoro.expand', 'Expand timer');
    const searchTaskLabel = resolveText('common.search', 'Search');
    const noMatchesLabel = resolveText('common.noMatches', 'No matches');

    const handleApplyPreset = (focusMinutes: number, breakMinutes: number) => {
        const nextDurations = { focusMinutes, breakMinutes };
        commitSnapshot((prev) => {
            const reconciled = reconcilePomodoroSnapshot(prev, Date.now(), autoStartOptions);
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
            const reconciled = reconcilePomodoroSnapshot(prev, Date.now(), autoStartOptions);
            return {
                ...reconciled,
                timerState: { ...reconciled.timerState, isRunning: !reconciled.timerState.isRunning },
                updatedAtMs: Date.now(),
            };
        });
    };

    const handleReset = () => {
        commitSnapshot((prev) => {
            const reconciled = reconcilePomodoroSnapshot(prev, Date.now(), autoStartOptions);
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
            const reconciled = reconcilePomodoroSnapshot(prev, Date.now(), autoStartOptions);
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
        const result = await updateTask(selectedTask.id, { status: 'done', isFocusedToday: false });
        if (result?.success === false) {
            useUiStore.getState().showToast(result.error || t('task.updateFailed'), 'error');
            return;
        }
        commitSnapshot((prev) => ({ ...prev, lastEvent: null }));
    };

    const phaseBadgeClass = cn(
        'text-xs px-2 py-0.5 rounded-full border font-medium',
        timerState.phase === 'focus'
            ? 'bg-info/10 text-info border-info/30'
            : 'bg-success/10 text-success border-success/30'
    );

    if (collapsed) {
        return (
            <section className="bg-card border border-border rounded-xl px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <p className="font-mono text-xl leading-none tracking-wide tabular-nums">
                            {formatPomodoroClock(timerState.remainingSeconds)}
                        </p>
                        <span className={phaseBadgeClass}>{phaseLabel}</span>
                        {timerState.isRunning && (
                            <span
                                aria-hidden
                                className={cn(
                                    'w-2 h-2 rounded-full animate-pulse shrink-0',
                                    timerState.phase === 'focus' ? 'bg-info' : 'bg-success'
                                )}
                            />
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => setCollapsed(false)}
                        aria-label={expandLabel}
                        title={expandLabel}
                        className="inline-flex items-center justify-center w-7 h-7 rounded border border-border bg-muted/50 text-muted-foreground hover:bg-muted transition-colors shrink-0"
                    >
                        <ChevronDown className="w-4 h-4" />
                    </button>
                </div>
            </section>
        );
    }

    return (
        <section className="bg-card border border-border rounded-xl p-3 space-y-3">
            <header className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <h3 className="font-semibold text-base truncate">{cardTitle}</h3>
                    <span className={phaseBadgeClass}>{phaseLabel}</span>
                </div>
                <button
                    type="button"
                    onClick={() => setCollapsed(true)}
                    aria-label={collapseLabel}
                    title={collapseLabel}
                    className="inline-flex items-center justify-center w-7 h-7 rounded border border-border bg-muted/50 text-muted-foreground hover:bg-muted transition-colors shrink-0"
                >
                    <ChevronUp className="w-4 h-4" />
                </button>
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
                                'text-xs px-2.5 py-1 rounded-full border transition-colors',
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
                <p className="font-mono text-4xl leading-none tracking-wider tabular-nums">{formatPomodoroClock(timerState.remainingSeconds)}</p>
                <p className="text-xs text-muted-foreground mt-1.5">
                    {sessionCountLabel}: {getPomodoroFocusSessionsCompletedToday(snapshot.sessionHistory)}
                </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                    type="button"
                    onClick={handleToggleRun}
                    className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded border transition-colors bg-primary text-primary-foreground border-primary hover:opacity-90"
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

            {linkTaskEnabled && (
                <div className="flex items-stretch gap-2">
                    <PomodoroTaskPicker
                        tasks={pickerTasks}
                        selectedTaskId={selectedTaskId}
                        onSelect={(nextId) => {
                            commitSnapshot((prev) => ({ ...prev, selectedTaskId: nextId }));
                        }}
                        label={selectedTaskLabel}
                        timerOnlyLabel={timerOnlyLabel}
                        noTaskLabel={noTaskLabel}
                        searchPlaceholder={searchTaskLabel}
                        noMatchesLabel={noMatchesLabel}
                    />
                    {selectedTask && (
                        <button
                            type="button"
                            onClick={() => {
                                void handleMarkTaskDone();
                            }}
                            title={markDoneLabel}
                            aria-label={markDoneLabel}
                            className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded border transition-colors shrink-0 bg-success/10 text-success border-success/50 hover:bg-success/20"
                        >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {markDoneLabel}
                        </button>
                    )}
                </div>
            )}

            {lastEvent && (
                <p className="text-xs text-muted-foreground">
                    {lastEvent === 'focus-finished' ? focusDoneLabel : breakDoneLabel}
                </p>
            )}
        </section>
    );
}
