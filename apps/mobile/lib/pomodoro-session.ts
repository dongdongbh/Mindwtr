export const POMODORO_SESSION_STORAGE_KEY = '@mindwtr_pomodoro_state';
/** Whether the Focus screen's timer card is folded away on this device (#946). */
export const POMODORO_COLLAPSED_STORAGE_KEY = '@mindwtr_pomodoro_collapsed';

export {
  pausePomodoroSession,
  resolvePomodoroSession,
  serializePomodoroSession,
  startPomodoroSession,
  type ResolvedPomodoroSession,
  type StoredPomodoroSession,
} from '@mindwtr/core';
