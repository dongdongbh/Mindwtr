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
            const taskId = typeof payload?.taskId === 'string' ? payload.taskId : undefined;
            const projectId = typeof payload?.projectId === 'string' ? payload.projectId : undefined;
            const kind = typeof payload?.kind === 'string' ? payload.kind : undefined;
            if (taskId) {
                useTaskStore.getState().setHighlightTask(taskId);
                const openToken = typeof payload?.notificationId === 'string' ? payload.notificationId : String(Date.now());
                router.push({ pathname: '/focus', params: { taskId, openToken } });
                return;
            }
            if (projectId) {
                router.push({ pathname: '/projects-screen', params: { projectId } });
                return;
            }
            if (kind === 'daily-digest' || kind === 'weekly-review') {
                router.push('/review');
            }
        });
        return () => {
            setNotificationOpenHandler(null);
        };
    }, [router]);
}
