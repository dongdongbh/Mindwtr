import { useEffect, useRef, useState } from 'react';
import { isEntityOpenUrl, parseEntityOpenUrl, translateWithFallback, useTaskStore } from '@mindwtr/core';
import { logInfo, logWarn } from '../lib/app-log';
import { useUiStore } from '../store/ui-store';


export function useTaskDeepLink(dataReady: boolean, enabled: boolean, t: (key: string) => string) {
    const [pendingUrl, setPendingUrl] = useState<{ url: string } | null>(null);
    const [openTaskId, setOpenTaskId] = useState<string | null>(null);
    const linkedTask = useTaskStore((state) => openTaskId ? state._tasksById.get(openTaskId) : undefined);
    const projects = useTaskStore((state) => state.projects);
    const error = useTaskStore((state) => state.error);
    const loadFailed = useRef(false);

    useEffect(() => {
        if (!enabled) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        let delivered = false;
        const receive = (urls: string[]) => {
            if (disposed) return;
            delivered = true;
            const url = urls.find(isEntityOpenUrl);
            if (url) setPendingUrl({ url });
        };
        void import('@tauri-apps/plugin-deep-link').then(async ({ onOpenUrl, getCurrent }) => {

            const stop = await onOpenUrl(receive);
            if (disposed) { stop(); return; }
            unlisten = stop;
            const urls = await getCurrent();
            if (!delivered && urls) receive(urls);
        }).catch(() => {
            void logWarn('Task link listener unavailable', { scope: 'routing' }).catch(() => undefined);
        });
        return () => { disposed = true; unlisten?.(); };
    }, [enabled]);

    useEffect(() => {
        if (!pendingUrl) return;
        if (!dataReady) {
            if (error && !loadFailed.current) {
                loadFailed.current = true;

                useUiStore.getState().showToast(error, 'error');
            }
            return;
        }
        loadFailed.current = false;
        const payload = parseEntityOpenUrl(pendingUrl.url);
        if (payload?.kind !== 'task') { setPendingUrl(null); return; }
        const task = useTaskStore.getState()._tasksById.get(payload.id);
        setPendingUrl(null);
        if (task && !task.deletedAt) {
            useUiStore.getState().setTaskExpanded(task.id, true);
            setOpenTaskId(task.id);
        } else {
            setOpenTaskId(null);
            useUiStore.getState().showToast(translateWithFallback(t, 'task.linkNotFound',
                'This task is not in this library. It may have been deleted or not synced to this device.'), 'error');
        }
        void logInfo('Task link route requested', {
            scope: 'routing',
            extra: { releaseCheck: 'v1.3.5/task-link-open', outcome: task && !task.deletedAt ? 'opened' : 'missing' },
        }).catch(() => undefined);
    }, [dataReady, error, pendingUrl, t]);

    const openTask = linkedTask && !linkedTask.deletedAt ? linkedTask : null;
    return {
        openTask,
        openProject: openTask?.projectId ? projects.find((project) => project.id === openTask.projectId) : undefined,
        closeOpenTask: () => setOpenTaskId(null),
        t,
    };
}
