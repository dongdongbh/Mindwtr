import { useCallback, useEffect, useRef } from 'react';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

import {
    buildShareCaptureDraft,
    buildShareIntentFileCaptureParams,
    generateUUID,
    resolveEntityOpenTarget,
    useTaskStore,
    type ShareIntentFileCaptureHost,
    type SharedIntentFile,
    type Task,
} from '@mindwtr/core';

import type { ToastOptions } from '@/contexts/toast-context';
import { logError, logInfo, logWarn } from '@/lib/app-log';
import { syncAppSearchIndexingWithPreference } from '@/lib/app-search-service';
import { persistAttachmentLocallyDetailed } from '@/lib/attachment-sync';
import {
    classifyIosShareHandoffUrl,
    logIosShareDiagnostic,
    type IosSharePayloadType,
} from '@/lib/share-intent-diagnostics';
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

type UseRootLayoutExternalCaptureParams = {
    canonicalDataReady: boolean;
    /** The startup snapshot has painted; entity links may open from it (#1310). */
    dataReady: boolean;
    disabled?: boolean;
    hasShareIntent: boolean;
    incomingUrl: string | null;
    incomingUrlKey: number;
    providerReady: boolean;
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

const inferSharePayloadType = ({
    shareFiles,
    shareText,
    shareWebUrl,
}: {
    shareFiles?: SharedIntentFile[] | null;
    shareText?: string | null;
    shareWebUrl?: string | null;
}): IosSharePayloadType => {
    if ((shareFiles ?? []).some((file) => typeof file?.path === 'string' && file.path.trim().length > 0)) {
        const files = shareFiles ?? [];
        return files.length > 0 && files.every((file) => (
            typeof file?.mimeType === 'string'
            && (file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/'))
        )) ? 'media' : 'file';
    }
    if (trimSharedValue(shareWebUrl)) return 'weburl';
    if (trimSharedValue(shareText)) return 'text';
    return 'unknown';
};

// The capture a file share opens is core's (buildShareIntentFileCaptureParams), shared with the native Android app; the
// hook hands it this app's attachment IO and log.
const shareFileCaptureHost: ShareIntentFileCaptureHost = {
    newId: generateUUID,
    persistAttachmentLocallyDetailed,
    deleteFile: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
    logWarn,
    logError,
};

// The capture a text or link share opens is core's (buildShareCaptureDraft), shared with the native Android app.
function buildShareIntentCaptureParams(share: {
    shareSubject?: string | null;
    shareText?: string | null;
    shareWebUrl?: string | null;
}): Record<string, string> | null {
    const draft = buildShareCaptureDraft(share);
    if (!draft) return null;
    const params: Record<string, string> = {
        initialValue: encodeURIComponent(draft.title),
    };
    if (draft.description !== undefined) {
        params.initialProps = encodeURIComponent(JSON.stringify({
            description: draft.description,
        } satisfies Partial<Task>));
    }
    return params;
}

// Deep links are untrusted input (#1017): core's resolveEntityOpenTarget opens an entity only while its id still
// exists in the store, and falls back to the default view otherwise.
function resolveEntityOpenPath(kind: EntityOpenKind, id: string): { pathname: string; params?: Record<string, string> } | null {
    const state = useTaskStore.getState();
    const target = resolveEntityOpenTarget(kind, id, state);
    if (!target) return null;
    if (target.pathname === '/focus') {
        state.setHighlightTask(target.taskId);
        return { pathname: '/focus', params: { taskId: target.taskId, openToken: `deeplink:${Date.now()}`, taskTab: 'view' } };
    }
    return target.projectId ? { pathname: '/projects-screen', params: { projectId: target.projectId } } : { pathname: '/projects-screen' };
}

export function useRootLayoutExternalCapture({
    canonicalDataReady,
    dataReady,
    disabled = false,
    hasShareIntent,
    incomingUrl,
    incomingUrlKey,
    providerReady,
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
    // Keyed per delivery, not per URL string: an Action Button shortcut sends
    // the same capture link every time, and each press must open the sheet.
    const lastHandledKey = useRef<number>(0);
    // The async file-copy branch outlives a render; a dep-identity change
    // mid-copy (language load swaps resolveText, for instance) must not start
    // a second copy of the same share.
    const shareHandlingRef = useRef(false);
    const lastProviderReadyRef = useRef<boolean | null>(null);
    const lastObservedShareUrlKeyRef = useRef<number | null>(null);
    const shareDiagnosticActiveRef = useRef(false);
    const shareDiagnosticStagesRef = useRef(new Set<string>());

    useEffect(() => {
        if (Platform.OS !== 'ios' || lastProviderReadyRef.current === providerReady) return;
        lastProviderReadyRef.current = providerReady;
        logIosShareDiagnostic({
            stage: 'provider-status',
            providerReady,
            dataReady: canonicalDataReady,
            disabled,
        });
    }, [canonicalDataReady, disabled, providerReady]);

    useEffect(() => {
        if (Platform.OS !== 'ios') return;
        const type = classifyIosShareHandoffUrl(incomingUrl);
        if (!type || lastObservedShareUrlKeyRef.current === incomingUrlKey) return;
        lastObservedShareUrlKeyRef.current = incomingUrlKey;
        logIosShareDiagnostic({
            stage: 'host-url-received',
            type,
            providerReady,
            dataReady: canonicalDataReady,
            disabled,
        });
    }, [canonicalDataReady, disabled, incomingUrl, incomingUrlKey, providerReady]);

    useEffect(() => {
        if (Platform.OS !== 'ios') return;
        if (!hasShareIntent) {
            if (!shareHandlingRef.current) {
                shareDiagnosticActiveRef.current = false;
                shareDiagnosticStagesRef.current.clear();
            }
            return;
        }

        if (!shareDiagnosticActiveRef.current) {
            shareDiagnosticActiveRef.current = true;
            shareDiagnosticStagesRef.current.clear();
        }
        const stages = shareDiagnosticStagesRef.current;
        const type = inferSharePayloadType({ shareFiles, shareText, shareWebUrl });
        if (!stages.has('payload-seen')) {
            stages.add('payload-seen');
            logIosShareDiagnostic({
                stage: 'payload-seen',
                type,
                providerReady,
                dataReady: canonicalDataReady,
                disabled,
                fileCount: shareFiles?.length ?? 0,
            });
        }
        const waitingOutcome = disabled ? 'disabled' : (!canonicalDataReady ? 'data-not-ready' : null);
        if (waitingOutcome && !stages.has(`waiting:${waitingOutcome}`)) {
            stages.add(`waiting:${waitingOutcome}`);
            logIosShareDiagnostic({
                stage: 'waiting',
                outcome: waitingOutcome,
                providerReady,
            });
        }
    }, [canonicalDataReady, disabled, hasShareIntent, providerReady, shareFiles, shareText, shareWebUrl]);

    // Arms the AppSearch index (#1017) once per app start if the device-local
    // preference is on. This hook already owns every other OS-level entry
    // point (share intents, deep links) and runs unconditionally on mount, so
    // it is the natural place to also arm the search-index subscription —
    // there is no dedicated root-layout-startup file in this task's scope.
    // No-op (and no AsyncStorage read) when unsupported or off.
    useEffect(() => {
        if (disabled) return;
        void syncAppSearchIndexingWithPreference();
    }, [disabled]);

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
    const lastShareDiagnosticErrorRef = useRef<{ error: string; shareUrlKey: number | null } | null>(null);
    useEffect(() => {
        if (!shareError) {
            lastShareDiagnosticErrorRef.current = null;
            return;
        }
        if (disabled) return;
        if (Platform.OS === 'ios') {
            const shareUrlKey = classifyIosShareHandoffUrl(incomingUrl) ? incomingUrlKey : null;
            const previous = lastShareDiagnosticErrorRef.current;
            if (!previous || previous.error !== shareError || (shareUrlKey !== null && previous.shareUrlKey !== shareUrlKey)) {
                lastShareDiagnosticErrorRef.current = { error: shareError, shareUrlKey };
                logIosShareDiagnostic({
                    stage: 'native-error',
                    outcome: 'present',
                    providerReady,
                    dataReady: canonicalDataReady,
                    disabled,
                });
            }
        }
        if (lastShareErrorRef.current === shareError) return;
        lastShareErrorRef.current = shareError;
        if (Platform.OS !== 'ios') {
            void logError(new Error(`Share intent failed: ${shareError}`), { scope: 'share-intent' });
        }
        showToast({
            title: resolveText('share.unavailable', 'Share unavailable'),
            message: resolveText('share.readFailed', 'Mindwtr could not read text, a URL, or a file from the shared item.'),
            tone: 'warning',
        });
    }, [canonicalDataReady, disabled, incomingUrl, incomingUrlKey, providerReady, resolveText, shareError, showToast]);

    useEffect(() => {
        if (disabled) return;
        if (!hasShareIntent) return;
        // Cold start: navigating before the root navigator and store are up
        // swallows the replace and the share dies silently (#1117). The provider
        // holds the intent, so waiting for canonical data just re-runs this effect —
        // the same gate the deep-link effect below uses. The startup snapshot is
        // not enough: the capture sheet and entity links read its tasks and projects.
        if (!canonicalDataReady) return;
        if (shareHandlingRef.current) return;
        shareHandlingRef.current = true;
        const payloadType = inferSharePayloadType({ shareFiles, shareText, shareWebUrl });
        if (!shareDiagnosticStagesRef.current.has('processing-started')) {
            shareDiagnosticStagesRef.current.add('processing-started');
            logIosShareDiagnostic({
                stage: 'processing-started',
                type: payloadType,
                fileCount: shareFiles?.length ?? 0,
            });
        }
        const finish = (params: Record<string, string> | null) => {
            if (params) {
                logIosShareDiagnostic({ stage: 'navigation-requested', type: payloadType });
                router.replace({
                    pathname: '/capture-modal',
                    params: { ...params, ...(Platform.OS === 'ios' ? { origin: 'share' } : {}) },
                });
                logIosShareDiagnostic({ stage: 'navigation-returned', type: payloadType });
            } else {
                logIosShareDiagnostic({ stage: 'payload-missing', type: payloadType });
                if (Platform.OS !== 'ios') {
                    void logError(new Error('Share intent payload missing text and files'), { scope: 'share-intent' });
                }
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
            logIosShareDiagnostic({ stage: 'reset-requested' });
            resetShareIntent();
            logIosShareDiagnostic({ stage: 'reset-returned' });
            shareHandlingRef.current = false;
            return;
        }
        void buildShareIntentFileCaptureParams({ files: shareFiles, shareSubject, shareText }, shareFileCaptureHost)
            .then((result) => {
                const skippedCount = result.candidateCount - result.attachedCount;
                logIosShareDiagnostic({
                    stage: 'files-prepared',
                    candidateCount: result.candidateCount,
                    attachedCount: result.attachedCount,
                    skippedCount,
                });
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
                    logIosShareDiagnostic({ stage: 'navigation-requested', type: payloadType });
                    router.replace({
                        pathname: '/capture-modal',
                        params: { ...params, ...(Platform.OS === 'ios' ? { origin: 'share' } : {}) },
                    });
                    logIosShareDiagnostic({ stage: 'navigation-returned', type: payloadType });
                } else if (skippedCount === 0) {
                    // Nothing readable at all; when files were skipped the
                    // toast above already explains why nothing arrived.
                    finish(null);
                }
            })
            .finally(() => {
                logIosShareDiagnostic({ stage: 'reset-requested' });
                resetShareIntent();
                logIosShareDiagnostic({ stage: 'reset-returned' });
                shareHandlingRef.current = false;
            });
    }, [canonicalDataReady, disabled, hasShareIntent, resolveText, resetShareIntent, router, shareFiles, shareSubject, shareText, shareWebUrl, showToast]);

    useEffect(() => {
        if (!dataReady || disabled) return;
        if (!incomingUrl) return;
        if (lastHandledKey.current === incomingUrlKey) return;

        // An entity link only navigates, so it opens from the startup snapshot when
        // the entity is already there, as a tap on a snapshot row does; waiting for
        // canonical data made a cold widget tap sit on the Inbox (#1310). A link to
        // an entity the snapshot lacks waits for canonical data before falling back.
        const entityPayload = parseEntityOpenUrl(incomingUrl);
        if (entityPayload) {
            const target = resolveEntityOpenPath(entityPayload.kind, entityPayload.id);
            if (!target && !canonicalDataReady) return;
            lastHandledKey.current = incomingUrlKey;
            if (target && !canonicalDataReady) {
                void logInfo('Entity link opened from the startup snapshot', {
                    scope: 'routing',
                    extra: { releaseCheck: 'v1.3.4/entity-link-snapshot-open', kind: entityPayload.kind },
                });
            }
            router.replace(target ?? '/inbox');
            if (entityPayload.kind === 'task') {
                if (!target) {
                    showToast({
                        message: resolveText('task.linkNotFound', 'This task is not in this library. It may have been deleted or not synced to this device.'),
                        tone: 'error',
                    });
                }
                void logInfo('Task link route requested', {
                    scope: 'routing',
                    extra: { releaseCheck: 'v1.3.5/task-link-open', outcome: target ? 'opened' : 'missing' },
                }).catch(() => undefined);
            }
            return;
        }
        if (!canonicalDataReady) return;

        const featurePayload = parseOpenFeatureUrl(incomingUrl);
        if (featurePayload) {
            lastHandledKey.current = incomingUrlKey;
            router.replace(resolveOpenFeaturePath(featurePayload.feature));
            return;
        }
        if (isOpenFeatureUrl(incomingUrl)) {
            lastHandledKey.current = incomingUrlKey;
            router.replace('/inbox');
            return;
        }

        if (isEntityOpenUrl(incomingUrl)) {
            lastHandledKey.current = incomingUrlKey;
            router.replace('/inbox');
            return;
        }

        const payload = parseShortcutCaptureUrl(incomingUrl);
        if (!payload) {
            if (!isShortcutCaptureUrl(incomingUrl)) return;
            lastHandledKey.current = incomingUrlKey;
            void logWarn('Invalid shortcut capture URL', {
                scope: 'shortcuts',
                extra: { releaseCheck: 'v1.3.1/shortcut-failure-privacy', stage: 'invalid-payload' },
            });
            showToast({
                title: resolveText('shortcuts.captureUnavailable', 'Capture shortcut unavailable'),
                message: resolveText('shortcuts.missingTitle', 'Mindwtr could not read a task title from that shortcut link.'),
                tone: 'warning',
            });
            return;
        }

        lastHandledKey.current = incomingUrlKey;
        try {
            openCaptureConfirmation(payload);
            void logInfo('Shortcut capture confirmation requested', {
                scope: 'shortcuts',
                extra: { releaseCheck: 'v1.3.0/shortcut-capture-single-owner' },
            });
        } catch {
            lastHandledKey.current = 0;
            // Router errors can echo the private capture parameters too.
            void logWarn('Shortcut capture confirmation failed', {
                scope: 'shortcuts',
                extra: { releaseCheck: 'v1.3.1/shortcut-failure-privacy', stage: 'navigation' },
            });
        }
    }, [canonicalDataReady, dataReady, disabled, incomingUrl, incomingUrlKey, resolveText, openCaptureConfirmation, router, showToast]);
}
