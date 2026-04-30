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

export function useRootLayoutNotificationOpenHandler({
    appReady,
    pathname,
    router,
}: UseRootLayoutNotificationOpenHandlerParams) {
    const pendingPayloadRef = useRef<{
        notificationId?: string;
        taskId?: string;
        projectId?: string;
        kind?: string;
    } | null>(null);
    const normalizedPathname = useMemo(() => String(pathname || '').trim(), [pathname]);
    const canNavigate = appReady && normalizedPathname.length > 0 && normalizedPathname !== '/';

    const routeNotificationOpen = useCallback((payload: {
        notificationId?: string;
        taskId?: string;
        projectId?: string;
        kind?: string;
    }) => {
        const openToken = typeof payload?.notificationId === 'string' ? payload.notificationId : String(Date.now());
        const taskId = typeof payload?.taskId === 'string' ? payload.taskId : undefined;
        const projectId = typeof payload?.projectId === 'string' ? payload.projectId : undefined;
        const kind = typeof payload?.kind === 'string' ? payload.kind : undefined;
        if (isReviewReminderKind(kind)) {
            router.push({
                pathname: '/review',
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
        if (kind === 'daily-digest') {
            router.push({ pathname: '/daily-review', params: { openToken } });
            return;
        }
        if (kind === 'weekly-review') {
            router.push({ pathname: '/weekly-review', params: { openToken } });
        }
    }, [router]);

    const handleNotificationOpen = useCallback((payload: {
        notificationId?: string;
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
