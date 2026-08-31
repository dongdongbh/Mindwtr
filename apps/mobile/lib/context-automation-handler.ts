import { useTaskStore } from '@mindwtr/core';

import {
  buildContextAutomationNotificationCopy,
  CONTEXT_AUTOMATION_NOTIFICATION_KIND,
  selectContextNextActions,
  type ContextAutomationPayload,
} from './context-automation';
import { sendMobileImmediateNotification } from './notification-service';

export type ResolveContextAutomationText = (key: string, fallback: string) => string;

const RECENT_CONTEXT_AUTOMATION_TTL_MS = 10_000;
const recentlyHandledContextAutomation = new Map<string, number>();

// The Android receiver is open to every automation app by design, and each
// accepted trigger wakes a headless task that runs a full fetchData(). The
// per-key dedupe below is defeated by simply varying the context, so the number
// of starts is capped per window regardless of what the payload says.
//
// Two accepted ceilings on this budget, both fine for the receiver's threat model
// (a hostile automation app on-device) but worth knowing about:
// - The counter is global, not per-source: `useRootLayoutContextAutomation` (the
//   user's own foreground deep-link path, e.g. tapping a context:// link) and
//   `runContextAutomationHeadlessTask` (the Android broadcast receiver's headless
//   wake, open to any automation app) both call wasContextAutomationRecentlyHandled
//   against this same array. A flood from the receiver can exhaust the window and
//   block the user's own foreground automation for up to CONTEXT_AUTOMATION_RATE_WINDOW_MS.
// - The counter is module-scoped, not persisted: the headless task dynamically
//   imports this module fresh on each Android process start, so a wake that
//   follows the RN instance being torn down (process death, not just backgrounding)
//   starts counting from zero again rather than continuing the prior window.
export const CONTEXT_AUTOMATION_RATE_WINDOW_MS = 60_000;
export const CONTEXT_AUTOMATION_MAX_STARTS_PER_WINDOW = 12;
let contextAutomationStarts: number[] = [];

export const defaultContextAutomationText: ResolveContextAutomationText = (_key, fallback) => fallback;

export function __resetContextAutomationDedupeForTests(): void {
  recentlyHandledContextAutomation.clear();
  contextAutomationStarts = [];
}

export function wasContextAutomationRecentlyHandled(payload: ContextAutomationPayload, nowMs = Date.now()): boolean {
  for (const [handledKey, handledAtMs] of recentlyHandledContextAutomation.entries()) {
    if (nowMs - handledAtMs > RECENT_CONTEXT_AUTOMATION_TTL_MS) {
      recentlyHandledContextAutomation.delete(handledKey);
    }
  }

  const key = `${payload.action}:${payload.context}`;
  const previousHandledAtMs = recentlyHandledContextAutomation.get(key);
  if (previousHandledAtMs !== undefined && nowMs - previousHandledAtMs <= RECENT_CONTEXT_AUTOMATION_TTL_MS) {
    return true;
  }

  contextAutomationStarts = contextAutomationStarts.filter(
    (startedAtMs) => nowMs - startedAtMs <= CONTEXT_AUTOMATION_RATE_WINDOW_MS
  );
  if (contextAutomationStarts.length >= CONTEXT_AUTOMATION_MAX_STARTS_PER_WINDOW) {
    return true;
  }
  contextAutomationStarts.push(nowMs);

  recentlyHandledContextAutomation.set(key, nowMs);
  return false;
}

export async function handleContextAutomationPayload(
  payload: ContextAutomationPayload,
  resolveText: ResolveContextAutomationText = defaultContextAutomationText
): Promise<void> {
  if (payload.action === 'deactivate') return;

  const state = useTaskStore.getState();
  const matchingTasks = selectContextNextActions(
    state.tasks ?? [],
    state.projects ?? [],
    payload.context,
    new Date(),
    state.settings,
  );
  if (matchingTasks.length === 0) return;

  const copy = buildContextAutomationNotificationCopy(payload.context, matchingTasks, {
    noTasksTitle: resolveText('contextAutomation.noNextActionsTitle', 'No {{context}} next actions'),
    noTasksMessage: resolveText('contextAutomation.noNextActionsBody', 'Mindwtr did not find any /next tasks for {{context}}.'),
    oneTaskTitle: resolveText('contextAutomation.oneNextActionTitle', '{{context}} next action'),
    manyTasksTitle: resolveText('contextAutomation.manyNextActionsTitle', '{{count}} {{context}} next actions'),
    moreTasksLine: resolveText('contextAutomation.moreTasksLine', '+{{count}} more'),
  });

  await sendMobileImmediateNotification(copy.title, copy.message, {
    kind: CONTEXT_AUTOMATION_NOTIFICATION_KIND,
    context: payload.context,
  });
}
