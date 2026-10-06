import { useCallback, useEffect, useMemo, useRef } from 'react';

import { AppState, Platform } from 'react-native';
import { flushPendingSave, runWithImmediateSaveTracking, useTaskStore } from '@mindwtr/core';
import {
    getReminderCompletionBlocker,
    REMINDER_COMPLETE_UPDATE,
    resolveNotificationOpenRoute,
} from '@mindwtr/core/mobile-notification-open';

import { logInfo, logWarn } from '@/lib/app-log';
import { setNotificationOpenHandler } from '@/lib/notification-service';
import { acknowledgeNotificationCompletion, peekPendingNotificationCompletions, consumePendingNotificationOpenPayload } from '@/modules/notification-open-intents';

// Outcome evidence for #1028: a received action that changes nothing must say
// why, or the log can't separate a lost tap from a deliberately ignored one.
const logNotificationOutcome = (message: string, extra: Record<string, string>) => {
    void logInfo(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

// One replay owner across hook remounts; native receipts remain the durable owner.
let completionReplay: Promise<void> | null = null;
let replayRequested = false;
const replayNotificationCompletions = (): Promise<void> => {
    replayRequested = true;
    if (completionReplay) return completionReplay;
    completionReplay = (async () => {
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
                        await flushPendingSave();
                        await acknowledgeNotificationCompletion(completion.actionId);
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
                        return;
                    }
                }
            } catch {
                void logWarn('[Local Notifications] Done queue retained for retry', {
                    scope: 'notifications', extra: { releaseCheck: 'v1.3.5/reminder-done-durable', outcome: 'unreadable' },
                });
                replayRequested = false;
                return;
            }
        } while (replayRequested);
    })().finally(() => { completionReplay = null; });
    return completionReplay;
};

type RouterLike = {
    push: (...args: any[]) => void;
};

type UseRootLayoutNotificationOpenHandlerParams = {
    appReady: boolean;
    disabled?: boolean;
    pathname?: string | null;
    router: RouterLike;
};

export function useRootLayoutNotificationOpenHandler({
    appReady,
    disabled = false,
    pathname,
    router,
}: UseRootLayoutNotificationOpenHandlerParams) {
    const pendingPayloadRef = useRef<{
        notificationId?: string;
        actionIdentifier?: string;
        taskId?: string;
        projectId?: string;
        context?: string;
        kind?: string;
    } | null>(null);
    const handledCompleteActionsRef = useRef(new Set<string>());
    const taskOpenSequenceRef = useRef(0);
    const normalizedPathname = useMemo(() => String(pathname || '').trim(), [pathname]);
    const canNavigate = !disabled && appReady && normalizedPathname.length > 0;

    const routeNotificationOpen = useCallback((payload: {
        notificationId?: string;
        actionIdentifier?: string;
        taskId?: string;
        projectId?: string;
        context?: string;
        kind?: string;
    }) => {
        // Which screen or action a tap means is core's (mobile-notification-open.ts).
        const route = resolveNotificationOpenRoute(payload, {
            now: () => Date.now(),
            nextTaskOpenSequence: () => {
                taskOpenSequenceRef.current += 1;
                return taskOpenSequenceRef.current;
            },
        });
        switch (route.type) {
            case 'none':
                return;
            case 'complete': {
                if (Platform.OS === 'android') {
                    void replayNotificationCompletions();
                    return;
                }
                const { taskId, actionKey } = route;
                if (handledCompleteActionsRef.current.has(actionKey)) {
                    logNotificationOutcome('Complete action ignored as duplicate', { taskId });
                    return;
                }
                handledCompleteActionsRef.current.add(actionKey);

                const state = useTaskStore.getState();
                const task = state._tasksById?.get(taskId) ?? state.tasks?.find((item) => item.id === taskId);
                const blocker = getReminderCompletionBlocker(task);
                if (blocker) {
                    logNotificationOutcome('Complete action dropped', { taskId, reason: blocker });
                    return;
                }
                logNotificationOutcome('Complete action applied', { taskId });
                state.updateTask(taskId, { ...REMINDER_COMPLETE_UPDATE }).catch(() => undefined);
                return;
            }
            case 'review':
                router.push({
                    pathname: '/review-tab',
                    params: {
                        openToken: route.openToken,
                        ...(route.taskId ? { taskId: route.taskId } : {}),
                        ...(route.projectId ? { projectId: route.projectId } : {}),
                    },
                });
                return;
            case 'task':
                useTaskStore.getState().setHighlightTask(route.taskId);
                router.push({ pathname: '/focus', params: { taskId: route.taskId, openToken: route.openToken, taskTab: 'view' } });
                return;
            case 'project':
                router.push({ pathname: '/projects-screen', params: { projectId: route.projectId } });
                return;
            case 'contexts':
                router.push({ pathname: '/contexts', params: { token: route.token } });
                return;
            case 'daily-review':
                router.push({ pathname: '/daily-review', params: { openToken: route.openToken } });
                return;
            case 'weekly-review':
                router.push({ pathname: '/weekly-review', params: { openToken: route.openToken } });
        }
    }, [router]);

    const handleNotificationOpen = useCallback((payload: {
        notificationId?: string;
        actionIdentifier?: string;
        taskId?: string;
        projectId?: string;
        context?: string;
        kind?: string;
    }) => {
        if (!canNavigate) {
            logNotificationOutcome('Notification action deferred until app is ready', {
                action: payload?.actionIdentifier || 'open',
                taskId: payload?.taskId || '',
            });
            pendingPayloadRef.current = payload;
            return;
        }
        routeNotificationOpen(payload);
    }, [canNavigate, routeNotificationOpen]);

    useEffect(() => {
        if (disabled) return;
        setNotificationOpenHandler(handleNotificationOpen);
        // Read the cold-start payload only once it can be acted on. Until then
        // native storage keeps it, so a kill during a slow data load loses nothing.
        if (canNavigate) {
            void consumePendingNotificationOpenPayload().then((payload) => {
                if (!payload) return;
                logNotificationOutcome('Cold-start notification payload consumed', {
                    action: payload.actionIdentifier || 'open',
                    taskId: payload.taskId || '',
                });
                handleNotificationOpen(payload);
            });
            if (Platform.OS === 'android') void replayNotificationCompletions();
        }
        return () => {
            setNotificationOpenHandler(null);
        };
    }, [canNavigate, disabled, handleNotificationOpen]);

    useEffect(() => {
        if (disabled || !canNavigate || Platform.OS !== 'android') return;
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') void replayNotificationCompletions();
        });
        return () => subscription.remove();
    }, [canNavigate, disabled]);

    useEffect(() => {
        if (disabled || !canNavigate || !pendingPayloadRef.current) return;
        const pendingPayload = pendingPayloadRef.current;
        pendingPayloadRef.current = null;
        routeNotificationOpen(pendingPayload);
    }, [canNavigate, disabled, routeNotificationOpen]);
}
