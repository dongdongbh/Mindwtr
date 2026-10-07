import type { ChecklistItem, PomodoroPhase } from '@mindwtr/core';

import type { MobilePomodoroControllerState } from './pomodoro-controller';

export const WATCH_FOCUS_TASK_LIMIT = 20;
export const WATCH_TITLE_LIMIT = 160;

export type WatchFocusItem = {
  id: string;
  title: string;
  createdAt?: string;
  description?: string;
  checklist?: ChecklistItem[];
  detailsUnavailable?: boolean;
};
// Leave space for property-list overhead; native validation checks the actual encoding too.
export const WATCH_DETAILS_BUDGET = 40 * 1024;
const encodedSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export type WatchApplicationContext = {
  protocolVersion: 1;
  generatedAt: string;
  focus: WatchFocusItem[];
  pomodoro: {
    phase: PomodoroPhase;
    isRunning: boolean;
    remainingSeconds: number;
    completionAlert: boolean;
    phaseEndTime?: number;
    taskId?: string;
    taskTitle?: string;
  };
};

const boundedText = (value: string): string => value.trim().slice(0, WATCH_TITLE_LIMIT);

export function buildWatchApplicationContext({
  focus,
  pomodoro,
  linkedTask,
  completionAlertEnabled = true,
  now = new Date(),
}: {
  focus: readonly WatchFocusItem[];
  pomodoro: MobilePomodoroControllerState;
  linkedTask?: WatchFocusItem;
  completionAlertEnabled?: boolean;
  now?: Date;
}): WatchApplicationContext {
  const seen = new Set<string>();
  const boundedFocus: WatchFocusItem[] = [];
  let remainingDetails = WATCH_DETAILS_BUDGET;
  for (const item of focus) {
    const id = item.id.trim();
    const title = boundedText(item.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const details = {
      ...(item.createdAt ? { createdAt: item.createdAt } : {}),
      ...(item.description ? { description: item.description } : {}),
      ...(item.checklist?.length ? { checklist: item.checklist } : {}),
    };
    const size = encodedSize(details);
    const fits = size <= Math.min(16 * 1024, remainingDetails)
      && (item.checklist?.length ?? 0) <= 100
      && (item.checklist ?? []).every((entry) => entry.id.length > 0 && entry.id.trim() === entry.id
        && !/[\u0000-\u001f\u007f]/.test(entry.id)
        && new TextEncoder().encode(entry.id).length <= 512
        && new TextEncoder().encode(entry.title).length <= 8000);
    boundedFocus.push({ id, title, ...(fits ? details : { detailsUnavailable: true }) });
    if (fits) remainingDetails -= size;
    if (boundedFocus.length >= WATCH_FOCUS_TASK_LIMIT) break;
  }

  const endMs = pomodoro.phaseEndsAt ? new Date(pomodoro.phaseEndsAt).getTime() : Number.NaN;
  const taskId = linkedTask?.id.trim();
  const taskTitle = linkedTask ? boundedText(linkedTask.title) : '';
  return {
    protocolVersion: 1,
    generatedAt: now.toISOString(),
    focus: boundedFocus,
    pomodoro: {
      phase: pomodoro.timerState.phase,
      isRunning: pomodoro.timerState.isRunning,
      remainingSeconds: Math.max(0, Math.floor(pomodoro.timerState.remainingSeconds)),
      completionAlert: completionAlertEnabled,
      ...(pomodoro.timerState.isRunning && Number.isFinite(endMs) ? { phaseEndTime: endMs } : {}),
      ...(taskId ? { taskId } : {}),
      ...(taskId && taskTitle ? { taskTitle } : {}),
    },
  };
}

/** Changes once per displayed minute while running, immediately for all controls. */
export function watchPomodoroPublicationKey(snapshot: MobilePomodoroControllerState): string {
  const remaining = snapshot.timerState.isRunning
    ? Math.ceil(snapshot.timerState.remainingSeconds / 60)
    : snapshot.timerState.remainingSeconds;
  return JSON.stringify([
    snapshot.isHydrating,
    snapshot.timerState.phase,
    snapshot.timerState.isRunning,
    remaining,
    snapshot.phaseEndsAt,
    snapshot.selectedTaskId,
  ]);
}
