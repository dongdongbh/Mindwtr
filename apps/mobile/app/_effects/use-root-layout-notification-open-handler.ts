import { useEffect } from 'react';

import { useTaskStore } from '@mindwtr/core';

import { setNotificationOpenHandler } from '@/lib/notification-service';

type RouterLike = {
    push: (...args: any[]) => void;
};

type UseRootLayoutNotificationOpenHandlerParams = {
    router: RouterLike;
};

export function useRootLayoutNotificationOpenHandler({
    router,
}: UseRootLayoutNotificationOpenHandlerParams) {
    useEffect(() => {
        setNotificationOpenHandler((payload) => {
            const openToken = typeof payload?.notificationId === 'string' ? payload.notificationId : String(Date.now());
            const taskId = typeof payload?.taskId === 'string' ? payload.taskId : undefined;
            const projectId = typeof payload?.projectId === 'string' ? payload.projectId : undefined;
            const kind = typeof payload?.kind === 'string' ? payload.kind : undefined;
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
        });
        return () => {
            setNotificationOpenHandler(null);
        };
    }, [router]);
}
