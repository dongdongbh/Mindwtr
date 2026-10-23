import { AppState } from 'react-native';
import { runWithImmediateSaveTracking, useTaskStore } from '@mindwtr/core';
import { getReminderCompletionBlocker, REMINDER_COMPLETE_UPDATE } from '@mindwtr/core/mobile-notification-open';

import { acknowledgeNotificationCompletion, peekPendingNotificationCompletions } from '../modules/notification-open-intents';
import { logInfo, logWarn } from './app-log';
import { flushPendingTaskActionSave } from './pending-capture-persistence';

const logNotificationOutcome = (message: string, extra: Record<string, string>) => {
    void logInfo(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

// One replay owner across foreground hooks and headless wakes; native receipts remain the durable owner.
let completionReplay: Promise<number> | null = null;
let replayRequested = false;
export const replayNotificationCompletions = (): Promise<number> => {
    replayRequested = true;
    if (completionReplay) return completionReplay;
    completionReplay = (async () => {
        let savedCount = 0;
        do {
            replayRequested = false;
            try {
                const completions = await peekPendingNotificationCompletions();
                for (const completion of completions) {
                    try {
                        if (!completion.actionId || !completion.taskId) throw new Error('Invalid completion receipt');
                        logNotificationOutcome('Done action stored', {
                            releaseCheck: 'v1.3.5/reminder-done-durable', outcome: 'stored',
                        });
                        const state = useTaskStore.getState();
                        const task = state._tasksById?.get(completion.taskId) ?? state.tasks?.find((item) => item.id === completion.taskId);
                        const blocker = getReminderCompletionBlocker(task);
                        if (!blocker) {
                            const { result } = await runWithImmediateSaveTracking(() => state.updateTask(completion.taskId!, { ...REMINDER_COMPLETE_UPDATE }));
                            if (!result.success) throw new Error('Completion update failed');
                        } else {
                            // A previous failed save may already have changed memory (including recurrence).
                            // Save that snapshot again without reapplying completion or generating another instance.
                            await state.persistSnapshot();
                        }
                        await flushPendingTaskActionSave();
                        const { updateMobileWidgetFromStore } = await import('./widget-service');
                        const widgetUpdated = await updateMobileWidgetFromStore();
                        if (!widgetUpdated) throw new Error('Widget refresh failed');
                        await acknowledgeNotificationCompletion(completion.actionId);
                        savedCount += 1;
                        await logInfo('[Local Notifications] Background Done saved and widget refreshed', {
                            scope: 'notifications', force: true,
                            extra: { releaseCheck: 'v1.3.8/reminder-background-completion',
                                outcome: blocker || 'completed', widgetUpdated: String(widgetUpdated),
                                appState: AppState.currentState || 'unknown' },
                        }).catch(() => undefined);
                        logNotificationOutcome('Done action saved and acknowledged', {
                            releaseCheck: 'v1.3.5/reminder-done-durable',
                            outcome: blocker || 'completed',
                        });
                    } catch {
                        void logWarn('[Local Notifications] Done action retained for retry', {
                            scope: 'notifications', extra: { releaseCheck: 'v1.3.5/reminder-done-durable', outcome: 'retained' },
                        });
                        // Retry only on another receipt, readiness change, or foreground; no failure loop.
                        replayRequested = false;
                        return savedCount;
                    }
                }
            } catch {
                void logWarn('[Local Notifications] Done queue retained for retry', {
                    scope: 'notifications', extra: { releaseCheck: 'v1.3.5/reminder-done-durable', outcome: 'unreadable' },
                });
                replayRequested = false;
                return savedCount;
            }
        } while (replayRequested);
        return savedCount;
    })().finally(() => { completionReplay = null; });
    return completionReplay;
};
