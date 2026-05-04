import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useTaskStore } from '@mindwtr/core';

import { setNotificationOpenHandler } from '@/lib/notification-service';
import { consumePendingNotificationOpenPayload } from '@/modules/notification-open-intents';

type RouterLike = {
    push: (...args: any[]) => void;
};

type UseRootLayoutNotificationOpenHandlerParams = {
    appReady: boolean;
    pathname?: string | null;
    router: RouterLike;
};

function isReviewReminderKind(kind: string | undefined): boolean {
    return kind === 'task-review' || kind === 'project-review';
}

function isWeeklyReviewOpen(kind: string | undefined, notificationId: string): boolean {
    return kind === 'weekly-review' || notificationId === 'digest:weekly-review';
}

function isDailyReviewOpen(kind: string | undefined, notificationId: string): boolean {
    return kind === 'daily-digest' || notificationId === 'digest:morning' || notificationId === 'digest:evening';
}

export function useRootLayoutNotificationOpenHandler({
    appReady,
    pathname,
    router,
}: UseRootLayoutNotificationOpenHandlerParams) {
    const pendingPayloadRef = useRef<{
        notificationId?: string;
        actionIdentifier?: string;
        taskId?: string;
        projectId?: string;
        kind?: string;
    } | null>(null);
    const handledCompleteActionsRef = useRef(new Set<string>());
    const normalizedPathname = useMemo(() => String(pathname || '').trim(), [pathname]);
    const canNavigate = appReady && normalizedPathname.length > 0 && normalizedPathname !== '/';

    const routeNotificationOpen = useCallback((payload: {
        notificationId?: string;
        actionIdentifier?: string;
        taskId?: string;
        projectId?: string;
        kind?: string;
    }) => {
        const openToken = typeof payload?.notificationId === 'string' ? payload.notificationId : String(Date.now());
        const actionIdentifier = typeof payload?.actionIdentifier === 'string' ? payload.actionIdentifier : undefined;
        const taskId = typeof payload?.taskId === 'string' ? payload.taskId : undefined;
        const projectId = typeof payload?.projectId === 'string' ? payload.projectId : undefined;
        const kind = typeof payload?.kind === 'string' ? payload.kind : undefined;
        const normalizedAction = String(actionIdentifier || '').trim().toLowerCase();
        if (normalizedAction === 'dismiss' || normalizedAction === 'dismiss_action' || normalizedAction === 'snooze' || normalizedAction === 'snooze_action') {
            return;
        }
        if ((normalizedAction === 'complete' || normalizedAction === 'complete_action') && taskId) {
            const actionKey = `${openToken}:${taskId}:complete`;
            if (handledCompleteActionsRef.current.has(actionKey)) return;
            handledCompleteActionsRef.current.add(actionKey);

            const state = useTaskStore.getState();
            const task = state._tasksById?.get(taskId) ?? state.tasks?.find((item) => item.id === taskId);
            if (!task || task.deletedAt || task.status === 'done' || task.status === 'archived' || task.status === 'reference') return;
            state.updateTask(taskId, { status: 'done', isFocusedToday: false }).catch(() => undefined);
            return;
        }
        if (isReviewReminderKind(kind)) {
            router.push({
                pathname: '/review-tab',
                params: {
                    openToken,
                    ...(taskId ? { taskId } : {}),
                    ...(projectId ? { projectId } : {}),
                },
            });
            return;
        }
        if (taskId) {
            useTaskStore.getState().setHighlightTask(taskId);
            router.push({ pathname: '/focus', params: { taskId, openToken } });
            return;
        }
        if (projectId) {
            router.push({ pathname: '/projects-screen', params: { projectId } });
            return;
        }
        if (isDailyReviewOpen(kind, openToken)) {
            router.push({ pathname: '/daily-review', params: { openToken } });
            return;
        }
        if (isWeeklyReviewOpen(kind, openToken)) {
            router.push({ pathname: '/weekly-review', params: { openToken } });
        }
    }, [router]);

    const handleNotificationOpen = useCallback((payload: {
        notificationId?: string;
        actionIdentifier?: string;
        taskId?: string;
        projectId?: string;
        kind?: string;
    }) => {
        if (!canNavigate) {
            pendingPayloadRef.current = payload;
            return;
        }
        routeNotificationOpen(payload);
    }, [canNavigate, routeNotificationOpen]);

    useEffect(() => {
        setNotificationOpenHandler(handleNotificationOpen);
        void consumePendingNotificationOpenPayload().then((payload) => {
            if (!payload) return;
            handleNotificationOpen(payload);
        });
        return () => {
            setNotificationOpenHandler(null);
        };
    }, [handleNotificationOpen]);

    useEffect(() => {
        if (!canNavigate || !pendingPayloadRef.current) return;
        const pendingPayload = pendingPayloadRef.current;
        pendingPayloadRef.current = null;
        routeNotificationOpen(pendingPayload);
    }, [canNavigate, routeNotificationOpen]);
}
