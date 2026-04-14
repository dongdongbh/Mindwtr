import { useCallback, useEffect, useRef } from 'react';

import {
    DEFAULT_PROJECT_COLOR,
    useTaskStore,
} from '@mindwtr/core';

import type { ToastOptions } from '@/contexts/toast-context';
import { logError, logWarn } from '@/lib/app-log';
import {
    isShortcutCaptureUrl,
    parseShortcutCaptureUrl,
    type ShortcutCapturePayload,
} from '@/lib/capture-deeplink';

type Localize = (english: string, chinese: string) => string;

type RouterLike = {
    canGoBack: () => boolean;
    push: (...args: any[]) => void;
    replace: (...args: any[]) => void;
};

type UseRootLayoutExternalCaptureParams = {
    dataReady: boolean;
    hasShareIntent: boolean;
    incomingUrl: string | null;
    localize: Localize;
    resetShareIntent: () => void;
    router: RouterLike;
    shareText?: string | null;
    shareWebUrl?: string | null;
    showToast: (options: ToastOptions) => void;
};

const normalizeShortcutTags = (tags: string[]): string[] => {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const rawTag of tags) {
        const trimmed = String(rawTag || '').trim();
        if (!trimmed) continue;
        const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
        const key = prefixed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(prefixed);
    }
    return normalized;
};

export function useRootLayoutExternalCapture({
    dataReady,
    hasShareIntent,
    incomingUrl,
    localize,
    resetShareIntent,
    router,
    shareText,
    shareWebUrl,
    showToast,
}: UseRootLayoutExternalCaptureParams) {
    const lastHandledCaptureUrl = useRef<string | null>(null);

    const captureFromShortcut = useCallback(async (payload: ShortcutCapturePayload) => {
        const store = useTaskStore.getState();
        const requestedProject = String(payload.project || '').trim();
        let projectId: string | undefined;
        if (requestedProject) {
            const existing = store.projects.find(
                (project) =>
                    !project.deletedAt &&
                    project.status !== 'archived' &&
                    project.title.trim().toLowerCase() === requestedProject.toLowerCase()
            );
            if (existing) {
                projectId = existing.id;
            } else {
                const created = await store.addProject(requestedProject, DEFAULT_PROJECT_COLOR);
                projectId = created?.id;
            }
        }

        const tags = normalizeShortcutTags(payload.tags);
        await store.addTask(payload.title, {
            status: 'inbox',
            ...(payload.note ? { description: payload.note } : {}),
            ...(projectId ? { projectId } : {}),
            ...(tags.length > 0 ? { tags } : {}),
        });

        if (router.canGoBack()) {
            router.push('/inbox');
        } else {
            router.replace('/inbox');
        }
    }, [router]);

    useEffect(() => {
        if (!hasShareIntent) return;
        const sharedText = typeof shareText === 'string'
            ? shareText
            : typeof shareWebUrl === 'string'
                ? shareWebUrl
                : '';
        if (sharedText.trim()) {
            router.replace({
                pathname: '/capture-modal',
                params: { text: encodeURIComponent(sharedText.trim()) },
            });
        } else {
            void logError(new Error('Share intent payload missing text'), { scope: 'share-intent' });
            showToast({
                title: localize('Share unavailable', '分享不可用'),
                message: localize(
                    'Mindwtr could not read text or a URL from the shared item.',
                    'Mindwtr 无法从分享内容中读取文本或链接。'
                ),
                tone: 'warning',
            });
        }
        resetShareIntent();
    }, [hasShareIntent, localize, resetShareIntent, router, shareText, shareWebUrl, showToast]);

    useEffect(() => {
        if (!dataReady) return;
        if (!incomingUrl) return;
        if (lastHandledCaptureUrl.current === incomingUrl) return;
        const payload = parseShortcutCaptureUrl(incomingUrl);
        if (!payload) {
            if (!isShortcutCaptureUrl(incomingUrl)) return;
            lastHandledCaptureUrl.current = incomingUrl;
            void logWarn('Invalid shortcut capture URL', {
                scope: 'shortcuts',
                extra: { url: incomingUrl },
            });
            showToast({
                title: localize('Capture shortcut unavailable', '快捷捕获不可用'),
                message: localize(
                    'Mindwtr could not read a task title from that shortcut link.',
                    'Mindwtr 无法从该快捷方式链接中读取任务标题。'
                ),
                tone: 'warning',
            });
            return;
        }

        lastHandledCaptureUrl.current = incomingUrl;
        void captureFromShortcut(payload).catch((error) => {
            lastHandledCaptureUrl.current = null;
            void logError(error, { scope: 'shortcuts', extra: { url: incomingUrl } });
        });
    }, [captureFromShortcut, dataReady, incomingUrl, localize, showToast]);
}
