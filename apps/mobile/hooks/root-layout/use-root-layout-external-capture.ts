import { useCallback, useEffect, useRef } from 'react';
import * as FileSystem from 'expo-file-system';

import { generateUUID, useTaskStore, validateAttachmentForUpload, type Attachment, type Task } from '@mindwtr/core';

import type { ToastOptions } from '@/contexts/toast-context';
import { logError, logWarn } from '@/lib/app-log';
import { syncAppSearchIndexingWithPreference } from '@/lib/app-search-service';
import { persistAttachmentLocallyDetailed } from '@/lib/attachment-sync';
import {
    isEntityOpenUrl,
    isOpenFeatureUrl,
    isShortcutCaptureUrl,
    normalizeShortcutTags,
    parseEntityOpenUrl,
    parseOpenFeatureUrl,
    parseShortcutCaptureUrl,
    resolveOpenFeaturePath,
    type EntityOpenKind,
    type ShortcutCapturePayload,
} from '@/lib/capture-deeplink';

type ResolveText = (key: string, fallback: string) => string;

type RouterLike = {
    canGoBack: () => boolean;
    push: (...args: any[]) => void;
    replace: (...args: any[]) => void;
};

type SharedIntentFile = {
    fileName?: string | null;
    mimeType?: string | null;
    path?: string | null;
    size?: number | null;
};

type UseRootLayoutExternalCaptureParams = {
    dataReady: boolean;
    hasShareIntent: boolean;
    incomingUrl: string | null;
    resolveText: ResolveText;
    resetShareIntent: () => void;
    router: RouterLike;
    shareError?: string | null;
    shareFiles?: SharedIntentFile[] | null;
    shareSubject?: string | null;
    shareText?: string | null;
    shareWebUrl?: string | null;
    showToast: (options: ToastOptions) => void;
};

const trimSharedValue = (value: string | null | undefined): string => (
    typeof value === 'string' ? value.trim() : ''
);

const SHARE_INTENT_MAX_FILES = 6;

const stripFileExtension = (value: string): string => value.replace(/\.[A-Za-z0-9]{1,8}$/, '');

type ShareIntentFileCaptureResult = {
    params: Record<string, string> | null;
    candidateCount: number;
    attachedCount: number;
};

// Shared files (PDFs, images, audio, ...) become copied attachments on the
// capture draft, mirroring the in-app attach flow: the share-extension file
// lives in a temporary container, so the bytes must be re-homed into the
// managed attachments dir before the capture sheet ever sees them.
async function buildShareIntentFileCaptureParams({
    files,
    shareSubject,
    shareText,
}: {
    files?: SharedIntentFile[] | null;
    shareSubject?: string | null;
    shareText?: string | null;
}): Promise<ShareIntentFileCaptureResult> {
    const candidates = (files ?? [])
        .filter((file): file is SharedIntentFile & { path: string } => (
            typeof file?.path === 'string' && file.path.trim().length > 0
        ))
        .slice(0, SHARE_INTENT_MAX_FILES);
    if (candidates.length === 0) return { params: null, candidateCount: 0, attachedCount: 0 };

    const attachments: Attachment[] = [];
    for (const file of candidates) {
        const now = new Date().toISOString();
        const sourceUri = file.path.startsWith('/') ? `file://${file.path}` : file.path;
        const attachment: Attachment = {
            id: generateUUID(),
            kind: 'file',
            title: trimSharedValue(file.fileName) || 'Shared file',
            uri: sourceUri,
            mimeType: trimSharedValue(file.mimeType) || undefined,
            size: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : undefined,
            createdAt: now,
            updatedAt: now,
            localStatus: 'available',
        };
        try {
            // Some providers omit the size; 0 still runs the mime blocklist,
            // and the post-copy check below enforces the size cap.
            const validation = await validateAttachmentForUpload(attachment, attachment.size ?? 0);
            if (!validation.valid) {
                void logWarn('Skipped shared file failing attachment validation', {
                    scope: 'share-intent',
                    extra: { error: validation.error ?? 'unknown', size: String(attachment.size ?? 'unknown') },
                });
                continue;
            }
            const persisted = await persistAttachmentLocallyDetailed(attachment);
            if (persisted.status !== 'copied' && persisted.status !== 'already-local') {
                // A share-container path goes stale as soon as the intent is
                // consumed, so a failed copy means the file is lost to us.
                void logWarn('Failed to copy shared file into attachments', {
                    scope: 'share-intent',
                    extra: { status: persisted.status },
                });
                continue;
            }
            const cached = persisted.attachment;
            if (typeof attachment.size !== 'number' && typeof cached.size === 'number') {
                // The copy revealed the real size of a sizeless share; drop the
                // bytes again if they exceed the attachment cap.
                const sizeValidation = await validateAttachmentForUpload(cached, cached.size);
                if (!sizeValidation.valid) {
                    void FileSystem.deleteAsync(cached.uri, { idempotent: true }).catch(() => undefined);
                    void logWarn('Skipped shared file failing attachment validation', {
                        scope: 'share-intent',
                        extra: { error: sizeValidation.error ?? 'unknown', size: String(cached.size) },
                    });
                    continue;
                }
            }
            attachments.push(cached);
        } catch (error) {
            void logError(error, { scope: 'share-intent', extra: { step: 'copy-shared-file' } });
        }
    }
    if (attachments.length === 0) {
        return { params: null, candidateCount: candidates.length, attachedCount: 0 };
    }

    const subject = trimSharedValue(shareSubject);
    const text = trimSharedValue(shareText);
    const title = subject || text || stripFileExtension(attachments[0].title);
    const props: Partial<Task> = { attachments };
    // Only a real email subject earns a description; plain file shares keep
    // their long-standing shape (title only, no body).
    if (subject && text) {
        props.description = text;
    }
    return {
        params: {
            initialValue: encodeURIComponent(title),
            initialProps: encodeURIComponent(JSON.stringify(props satisfies Partial<Task>)),
        },
        candidateCount: candidates.length,
        attachedCount: attachments.length,
    };
}

function buildShareIntentCaptureParams({
    shareSubject,
    shareText,
    shareWebUrl,
}: {
    shareSubject?: string | null;
    shareText?: string | null;
    shareWebUrl?: string | null;
}): Record<string, string> | null {
    const subject = trimSharedValue(shareSubject);
    if (subject) {
        // Email shares (FairEmail etc.) carry a real subject: it becomes the
        // title, and the body/URL move to the description instead of being
        // dumped into the title together.
        const text = trimSharedValue(shareText);
        const url = trimSharedValue(shareWebUrl);
        const descriptionLines = [text, url && url !== text ? url : null]
            .filter((line): line is string => Boolean(line));

        const params: Record<string, string> = {
            initialValue: encodeURIComponent(subject),
        };
        if (descriptionLines.length > 0) {
            params.initialProps = encodeURIComponent(JSON.stringify({
                description: descriptionLines.join('\n'),
            } satisfies Partial<Task>));
        }
        return params;
    }

    const title = trimSharedValue(shareText) || trimSharedValue(shareWebUrl);
    if (!title) return null;

    const params: Record<string, string> = {
        initialValue: encodeURIComponent(title),
    };
    const url = trimSharedValue(shareWebUrl);
    if (url && url !== title) {
        params.initialProps = encodeURIComponent(JSON.stringify({
            description: url,
        } satisfies Partial<Task>));
    }

    return params;
}

// Deep links are untrusted input (#1017): resolve an entity-open URL to a
// navigation target only when the id still exists in the store, and fall
// back to the default view otherwise. Areas have no dedicated detail screen,
// so an area link opens Projects — the closest existing view that lists them.
function resolveEntityOpenPath(kind: EntityOpenKind, id: string): { pathname: string; params?: Record<string, string> } | null {
    const state = useTaskStore.getState();
    if (kind === 'task') {
        const task = state._tasksById?.get(id);
        if (!task || task.deletedAt) return null;
        state.setHighlightTask(id);
        return { pathname: '/focus', params: { taskId: id, openToken: `deeplink:${Date.now()}`, taskTab: 'view' } };
    }
    if (kind === 'project') {
        const project = state._projectsById?.get(id);
        if (!project || project.deletedAt) return null;
        return { pathname: '/projects-screen', params: { projectId: id } };
    }
    const area = state._areasById?.get(id);
    if (!area || area.deletedAt) return null;
    return { pathname: '/projects-screen' };
}

export function useRootLayoutExternalCapture({
    dataReady,
    hasShareIntent,
    incomingUrl,
    resolveText,
    resetShareIntent,
    router,
    shareError,
    shareFiles,
    shareSubject,
    shareText,
    shareWebUrl,
    showToast,
}: UseRootLayoutExternalCaptureParams) {
    const lastHandledUrl = useRef<string | null>(null);
    // The async file-copy branch outlives a render; a dep-identity change
    // mid-copy (language load swaps resolveText, for instance) must not start
    // a second copy of the same share.
    const shareHandlingRef = useRef(false);

    // Arms the AppSearch index (#1017) once per app start if the device-local
    // preference is on. This hook already owns every other OS-level entry
    // point (share intents, deep links) and runs unconditionally on mount, so
    // it is the natural place to also arm the search-index subscription —
    // there is no dedicated root-layout-startup file in this task's scope.
    // No-op (and no AsyncStorage read) when unsupported or off.
    useEffect(() => {
        void syncAppSearchIndexingWithPreference();
    }, []);

    const openCaptureConfirmation = useCallback((payload: ShortcutCapturePayload) => {
        const tags = normalizeShortcutTags(payload.tags);
        const initialProps: Partial<Task> = {
            ...(payload.note ? { description: payload.note } : {}),
            ...(tags.length > 0 ? { tags } : {}),
        };
        const params: Record<string, string> = {
            initialValue: encodeURIComponent(payload.title),
        };
        if (Object.keys(initialProps).length > 0) {
            params.initialProps = encodeURIComponent(JSON.stringify(initialProps));
        }
        if (payload.project) {
            params.project = encodeURIComponent(payload.project);
        }

        if (router.canGoBack()) {
            router.push({
                pathname: '/capture-modal',
                params,
            });
        } else {
            router.replace({
                pathname: '/capture-modal',
                params,
            });
        }
    }, [router]);

    // The native module reports failures (unreadable URI, resolver errors) on a
    // separate error channel that used to vanish silently: the app just opened
    // with no sheet and no clue (#1117). Surface it so a broken share is at
    // least visible and diagnosable from the log.
    const lastShareErrorRef = useRef<string | null>(null);
    useEffect(() => {
        if (!shareError || lastShareErrorRef.current === shareError) return;
        lastShareErrorRef.current = shareError;
        void logError(new Error(`Share intent failed: ${shareError}`), { scope: 'share-intent' });
        showToast({
            title: resolveText('share.unavailable', 'Share unavailable'),
            message: resolveText('share.readFailed', 'Mindwtr could not read text, a URL, or a file from the shared item.'),
            tone: 'warning',
        });
    }, [resolveText, shareError, showToast]);

    useEffect(() => {
        if (!hasShareIntent) return;
        if (shareHandlingRef.current) return;
        shareHandlingRef.current = true;
        const finish = (params: Record<string, string> | null) => {
            if (params) {
                router.replace({
                    pathname: '/capture-modal',
                    params,
                });
            } else {
                void logError(new Error('Share intent payload missing text and files'), { scope: 'share-intent' });
                showToast({
                    title: resolveText('share.unavailable', 'Share unavailable'),
                    message: resolveText('share.readFailed', 'Mindwtr could not read text, a URL, or a file from the shared item.'),
                    tone: 'warning',
                });
            }
        };
        const hasSharedFiles = (shareFiles ?? []).some((file) => typeof file?.path === 'string' && file.path.trim().length > 0);
        if (!hasSharedFiles) {
            // Text/URL shares stay synchronous; only file shares need the
            // async copy into the managed attachments dir.
            finish(buildShareIntentCaptureParams({ shareSubject, shareText, shareWebUrl }));
            resetShareIntent();
            shareHandlingRef.current = false;
            return;
        }
        void buildShareIntentFileCaptureParams({ files: shareFiles, shareSubject, shareText })
            .then((result) => {
                const skippedCount = result.candidateCount - result.attachedCount;
                if (skippedCount > 0) {
                    showToast({
                        title: resolveText('common.notice', 'Notice'),
                        message: resolveText(
                            'share.filesSkipped',
                            '{{count}} shared file(s) could not be attached (too large, blocked file type, or unreadable).',
                        ).replace('{{count}}', String(skippedCount)),
                        tone: 'warning',
                    });
                }
                const params = result.params ?? buildShareIntentCaptureParams({ shareSubject, shareText, shareWebUrl });
                if (params) {
                    router.replace({
                        pathname: '/capture-modal',
                        params,
                    });
                } else if (skippedCount === 0) {
                    // Nothing readable at all; when files were skipped the
                    // toast above already explains why nothing arrived.
                    finish(null);
                }
            })
            .finally(() => {
                resetShareIntent();
                shareHandlingRef.current = false;
            });
    }, [hasShareIntent, resolveText, resetShareIntent, router, shareFiles, shareSubject, shareText, shareWebUrl, showToast]);

    useEffect(() => {
        if (!dataReady) return;
        if (!incomingUrl) return;
        if (lastHandledUrl.current === incomingUrl) return;

        const featurePayload = parseOpenFeatureUrl(incomingUrl);
        if (featurePayload) {
            lastHandledUrl.current = incomingUrl;
            router.replace(resolveOpenFeaturePath(featurePayload.feature));
            return;
        }
        if (isOpenFeatureUrl(incomingUrl)) {
            lastHandledUrl.current = incomingUrl;
            router.replace('/inbox');
            return;
        }

        const entityPayload = parseEntityOpenUrl(incomingUrl);
        if (entityPayload) {
            lastHandledUrl.current = incomingUrl;
            const target = resolveEntityOpenPath(entityPayload.kind, entityPayload.id);
            router.replace(target ?? '/inbox');
            return;
        }
        if (isEntityOpenUrl(incomingUrl)) {
            lastHandledUrl.current = incomingUrl;
            router.replace('/inbox');
            return;
        }

        const payload = parseShortcutCaptureUrl(incomingUrl);
        if (!payload) {
            if (!isShortcutCaptureUrl(incomingUrl)) return;
            lastHandledUrl.current = incomingUrl;
            void logWarn('Invalid shortcut capture URL', {
                scope: 'shortcuts',
                extra: { url: incomingUrl },
            });
            showToast({
                title: resolveText('shortcuts.captureUnavailable', 'Capture shortcut unavailable'),
                message: resolveText('shortcuts.missingTitle', 'Mindwtr could not read a task title from that shortcut link.'),
                tone: 'warning',
            });
            return;
        }

        lastHandledUrl.current = incomingUrl;
        try {
            openCaptureConfirmation(payload);
        } catch (error) {
            lastHandledUrl.current = null;
            void logError(error, { scope: 'shortcuts', extra: { url: incomingUrl } });
        }
    }, [dataReady, incomingUrl, resolveText, openCaptureConfirmation, router, showToast]);
}
