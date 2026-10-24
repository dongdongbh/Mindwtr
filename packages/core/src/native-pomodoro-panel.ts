import { tFallback } from './i18n';
import { decodeNativePomodoroSession } from './native-pomodoro-session';
import { taskRevisionOf } from './native-request-receipts';
import { createPomodoroState, DEFAULT_POMODORO_DURATIONS, formatPomodoroClock, getPomodoroFocusSessionsCompletedToday, getPomodoroLocalDayKey,
    getPomodoroPresetOptions, type PomodoroEvent } from './pomodoro';
import { resolvePomodoroSession } from './pomodoro-session';
import { resolveFeatureFlags } from './resolve-feature-flags';
import type { AppSettings, Task } from './types';

export type NativePomodoroFeedback = { sessionID: string; generation: number; value: PomodoroEvent };

export function readNativePomodoroPresentation(value: unknown): { collapsed: boolean; lastEvent: NativePomodoroFeedback | null } {
    const invalid = () => { throw new Error('Invalid Pomodoro presentation'); };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const input = value as Record<string, unknown>;
    if (Object.keys(input).length !== 2 || Object.keys(input).some((name) => !['collapsed', 'lastEvent'].includes(name))
        || typeof input.collapsed !== 'boolean') return invalid();
    if (input.lastEvent === null) return { collapsed: input.collapsed, lastEvent: null };
    if (!input.lastEvent || typeof input.lastEvent !== 'object' || Array.isArray(input.lastEvent)) return invalid();
    const event = input.lastEvent as Record<string, unknown>;
    if (Object.keys(event).length !== 3 || Object.keys(event).some((name) => !['sessionID', 'generation', 'value'].includes(name))
        || typeof event.sessionID !== 'string'
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(event.sessionID)
        || typeof event.generation !== 'number' || !Number.isSafeInteger(event.generation) || event.generation < 0
        || (event.value !== 'focus-finished' && event.value !== 'break-finished')) return invalid();
    return { collapsed: input.collapsed, lastEvent: { sessionID: event.sessionID, generation: event.generation, value: event.value } };
}

function buildPanel(input: {
    raw: string | null;
    settings: AppSettings;
    liveTasks: readonly Task[];
    nowMs: number;
    collapsed: boolean;
    lastEvent: NativePomodoroFeedback | null;
    t: (key: string) => string;
}) {
    if (!Number.isSafeInteger(input.nowMs) || Math.abs(input.nowMs) > 8_640_000_000_000_000
        || typeof input.collapsed !== 'boolean') throw new Error('Invalid Pomodoro presentation');
    const tr = (key: string, fallback: string) => tFallback(input.t, key, fallback);
    const options = input.settings.gtd?.pomodoro;
    const autoStart = { autoStartFocus: options?.autoStartFocus === true, autoStartBreaks: options?.autoStartBreaks === true };
    const day = getPomodoroLocalDayKey(input.nowMs);
    const common = { visible: resolveFeatureFlags(input.settings).pomodoro, autoStart,
        observation: { nowMs: input.nowMs, localDayKey: day },
        text: { title: tr('pomodoro.mobileTitle', 'Pomodoro Timer'),
            collapse: input.collapsed ? tr('pomodoro.expand', 'Expand timer') : tr('pomodoro.collapse', 'Collapse timer') },
        completionAlert: options?.completionAlert !== false, collapsed: input.collapsed, linkTaskEnabled: options?.linkTask === true };
    if (input.raw === null) return { kind: 'uninitialized' as const, ...common };
    const state = decodeNativePomodoroSession(input.raw), session = state.session;
    const needsReconcile = session.timerState.isRunning && Date.parse(session.phaseEndsAt!) <= input.nowMs;
    // Completion counters and the next phase belong to the durable transition, not a display tick.
    const resolved = resolvePomodoroSession(session, input.nowMs, autoStart, day);
    const remaining = needsReconcile ? 0 : resolved.timerState.remainingSeconds;
    const { linkTaskEnabled } = common;
    const selected = linkTaskEnabled && session.selectedTaskId
        ? input.liveTasks.find((task) => task.id === session.selectedTaskId) : undefined;
    const lastEvent = input.lastEvent;
    if (lastEvent && !['focus-finished', 'break-finished'].includes(lastEvent.value)) throw new Error('Invalid Pomodoro feedback');
    const event = lastEvent?.sessionID === state.sessionID && lastEvent.generation === state.generation && !needsReconcile
        ? lastEvent.value : null;
    const phase = session.timerState.phase, isRunning = session.timerState.isRunning;
    return {
        kind: 'ready' as const,
        ...common,
        sessionID: state.sessionID,
        generation: state.generation,
        clock: formatPomodoroClock(remaining),
        phase,
        isRunning,
        phaseEndsAtMs: session.phaseEndsAt ? Date.parse(session.phaseEndsAt) : null,
        needsReconcile,
        completionEvent: needsReconcile ? resolved.lastEvent : null,
        completedToday: getPomodoroFocusSessionsCompletedToday(session.sessionHistory, day),
        durations: { ...session.durations },
        presets: getPomodoroPresetOptions(options?.customDurations).map((preset) => ({ ...preset,
            active: preset.focusMinutes === session.durations.focusMinutes && preset.breakMinutes === session.durations.breakMinutes })),
        selectedTask: selected ? { id: selected.id, title: selected.title, taskRevision: taskRevisionOf(selected),
            completionSource: selected.status === 'reference' ? 'reference' : 'ordinary' } : null,
        selectionMissing: linkTaskEnabled && session.selectedTaskId !== undefined && selected === undefined,
        event: event === 'focus-finished' ? tr('pomodoro.focusComplete', 'Focus session complete. Take a short break.')
            : event === 'break-finished' ? tr('pomodoro.breakComplete', 'Break complete. Ready for the next focus session.') : null,
        text: {
            title: common.text.title,
            phase: phase === 'focus' ? tr('pomodoro.phaseFocusShort', 'Focus') : tr('pomodoro.phaseBreakShort', 'Break'),
            state: isRunning ? tr('pomodoro.running', 'Running') : tr('pomodoro.paused', 'Paused'),
            toggle: isRunning ? tr('common.pause', 'Pause') : tr('common.start', 'Start'),
            reset: tr('common.reset', 'Reset'),
            switchPhase: phase === 'focus' ? tr('pomodoro.switchToBreak', 'Switch to Break') : tr('pomodoro.switchToFocus', 'Switch to Focus'),
            collapse: common.text.collapse,
            more: tr('common.more', 'More'),
            sessionsDone: tr('pomodoro.sessionsDone', 'Focus sessions completed'),
            selectedTask: tr('pomodoro.selectedTask', 'Timer task'),
            timerOnly: tr('pomodoro.timerOnly', 'Timer only'),
            changeTask: selected ? tr('common.change', 'Change') : tr('pomodoro.linkTask', 'Link task'),
            markDone: tr('pomodoro.markTaskDone', 'Mark task done'),
            taskDoneShort: tr('pomodoro.taskDoneShort', 'Task done'),
            noTask: tr('pomodoro.noTask', 'No available focus task'),
        },
    };
}

export function buildNativePomodoroPanel(input: Parameters<typeof buildPanel>[0]) {
    const panel = buildPanel(input);
    if (panel.kind === 'ready') return panel;
    // RN's card while its session loads (pomodoro-panel.tsx isHydrating): the default timer, its controls off, a Loading row.
    const defaults = buildPanel({ ...input, lastEvent: null, raw: JSON.stringify({ version: 1,
        sessionID: '00000000-0000-4000-8000-000000000000', generation: 0, session: { durations: DEFAULT_POMODORO_DURATIONS,
            timerState: createPomodoroState(DEFAULT_POMODORO_DURATIONS), sessionHistory: { totalCompletedFocusSessions: 0,
                completedFocusSessionsByTaskId: {}, todayDayKey: getPomodoroLocalDayKey(input.nowMs), completedTodayFocusSessions: 0 },
            updatedAtMs: 0 } }) });
    if (defaults.kind !== 'ready') throw new Error('Invalid Pomodoro presentation');
    return { ...defaults, kind: 'uninitialized' as const, sessionID: null, generation: null,
        text: { ...defaults.text, loading: tFallback(input.t, 'common.loading', 'Loading...') } };
}
