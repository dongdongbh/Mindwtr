import { router } from 'expo-router';

type TaskOpenTab = 'view' | 'task';

type PendingCaptureTaskOpen = { taskId: string; projectId: string; taskTab: TaskOpenTab };


let pendingCaptureTaskOpen: PendingCaptureTaskOpen | null = null;

export function stashPendingCaptureTaskOpen(pending: PendingCaptureTaskOpen) {
    pendingCaptureTaskOpen = pending;
}

export function consumePendingCaptureTaskOpen(projectId: string | undefined): PendingCaptureTaskOpen | null {
    const pending = pendingCaptureTaskOpen;
    if (!pending || !projectId || pending.projectId !== projectId) return null;
    pendingCaptureTaskOpen = null;
    return pending;
}

const navigateToTaskMetaScreen = (
    pathname: '/projects-screen' | '/contexts',
    params: { projectId?: string; token?: string; openToken?: string }
) => {


    router.navigate({ pathname, params });
};

export function openProjectScreen(projectId: string) {
    if (!projectId) return;


    navigateToTaskMetaScreen('/projects-screen', { projectId, openToken: String(Date.now()) });
}

export function openContextsScreen(token: string) {
    if (!token) return;
    navigateToTaskMetaScreen('/contexts', { token });
}

export function openTaskScreen(
    taskId: string,
    projectId?: string,
    taskTab: TaskOpenTab = 'view',
    options?: {


        replace?: boolean;
    },
) {
    if (!taskId) return;
    const openToken = String(Date.now());
    const target = projectId
        ? { pathname: '/projects-screen' as const, params: { projectId, taskId, openToken, taskTab } }
        : { pathname: '/focus' as const, params: { taskId, openToken, taskTab } };
    if (options?.replace) {
        if (router.canGoBack()) {
            router.back();
            router.navigate(target);
        } else {


            router.replace(target);
        }
        return;
    }
    router.push(target);
}
