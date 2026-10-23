import { useCallback, useEffect, useMemo, useRef } from 'react';

import { AppState, Platform } from 'react-native';
import { useTaskStore } from '@mindwtr/core';
import {
    getReminderCompletionBlocker,
    REMINDER_COMPLETE_UPDATE,
    resolveNotificationOpenRoute,
} from '@mindwtr/core/mobile-notification-open';

import { logInfo } from '@/lib/app-log';
import { replayNotificationCompletions } from '@/lib/notification-completion-drain';
import { setNotificationOpenHandler } from '@/lib/notification-service';
import { consumePendingNotificationOpenPayload } from '@/modules/notification-open-intents';

// Outcome evidence for #1028: a received action that changes nothing must say
// why, or the log can't separate a lost tap from a deliberately ignored one.
const logNotificationOutcome = (message: string, extra: Record<string, string>) => {
    void logInfo(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

// Release evidence for #1386; an update returning is not proof of durable background completion.
const logIosReminderAction = (stage: string, action = 'complete', reason = '') => {
    if (Platform.OS !== 'ios') return;
    void logInfo('[Local Notifications] iOS reminder action progress', {
        scope: 'notifications',
        extra: { releaseCheck: 'v1.3.7/ios-reminder-actions', stage, action, reason,
            appState: AppState.currentState || 'unknown' },
    });
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
                    logIosReminderAction('duplicate');
                    logNotificationOutcome('Complete action ignored as duplicate', { taskId });
                    return;
                }
                handledCompleteActionsRef.current.add(actionKey);

                const state = useTaskStore.getState();
                const task = state._tasksById?.get(taskId) ?? state.tasks?.find((item) => item.id === taskId);
                const blocker = getReminderCompletionBlocker(task);
                if (blocker) {
                    logIosReminderAction('blocked', 'complete', blocker);
                    logNotificationOutcome('Complete action dropped', { taskId, reason: blocker });
                    return;
                }
                logNotificationOutcome('Complete action applied', { taskId });
                logIosReminderAction('update-started');
                state.updateTask(taskId, { ...REMINDER_COMPLETE_UPDATE }).then(
                    () => logIosReminderAction('update-returned'),
                    () => logIosReminderAction('update-failed'),
                );
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
        const rawAction = String(payload?.actionIdentifier || 'open').trim().toLowerCase();
        const action = ['complete', 'complete_action'].includes(rawAction) ? 'complete'
            : ['dismiss', 'dismiss_action'].includes(rawAction) ? 'dismiss'
                : ['snooze', 'snooze_action'].includes(rawAction) ? 'snooze' : 'open';
        logIosReminderAction(canNavigate ? 'received-ready' : 'received-deferred', action);
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
