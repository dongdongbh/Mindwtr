import React from 'react';
import { Alert, Platform } from 'react-native';
import {
    DEFAULT_PROJECT_COLOR,
    buildTaskUpdatesFromSpeechResult,
    findSelectableProjectByTitleAndArea,
    generateUUID,
    normalizeLinkAttachmentInput,
    planAttachmentDraftSettlement,
    translateWithFallback,
    type Attachment,
    type AttachmentDraftSettlementInput,
    type Task,
    useTaskStore,
    validateAttachmentForUpload,
} from '@mindwtr/core';
import {
    toTaskDraftDateTimeLocalValue,
} from '@mindwtr/core/task-draft';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Paths } from 'expo-file-system';

import {
    deleteManagedAttachmentFile,
    persistAttachmentLocally,
} from '../../lib/attachment-sync';
import {
    ensureAttachmentAvailableDetailed,
    getAttachmentAvailabilityPatch,
    getAttachmentDownloadIdentity,
    hasAttachmentDownloadIdentity,
    type AttachmentAvailabilityOutcome,
} from '../../lib/attachment-sync-availability';
import { loadAIKey } from '../../lib/ai-config';
import { tryOpenWithAndroidViewer } from '../../lib/open-file-externally';
import { ensureWhisperModelPathForConfigAsync, processAudioCapture, resolveSpeechToTextRuntimeSettings } from '../../lib/speech-to-text';
import { normalizeAudioUri } from '../../lib/speech-to-text.helpers';
import {
    isReleasedAudioPlayerError,
    isValidLinkUri,
    logTaskError,
    logTaskWarn,
} from './task-edit-modal.utils';
import type {
    SetTaskEditDraftField,
    SetTaskEditDraftValue,
} from './use-task-edit-state';

const EMPTY_ATTACHMENTS: Attachment[] = [];

type UseTaskEditAttachmentsParams = {
    attachments: Attachment[] | undefined;
    setAttachments: SetTaskEditDraftValue<Attachment[] | undefined>;
    setDraftField: SetTaskEditDraftField;
    taskId: string | undefined;
    t: (key: string) => string;
    visible: boolean;
};

const applySpeechUpdatesToDraft = (updates: Partial<Task>, setDraftField: SetTaskEditDraftField) => {
    if ('title' in updates) setDraftField('title', updates.title ?? '', false);
    if ('description' in updates) setDraftField('description', updates.description ?? '', false);
    if ('dueDate' in updates) setDraftField('dueDate', toTaskDraftDateTimeLocalValue(updates.dueDate), false);
    if ('startTime' in updates) setDraftField('startTime', toTaskDraftDateTimeLocalValue(updates.startTime), false);
    if ('tags' in updates) setDraftField('tags', (updates.tags ?? []).join(', '), false);
    if ('contexts' in updates) setDraftField('contexts', (updates.contexts ?? []).join(', '), false);
    if ('projectId' in updates) setDraftField('projectId', updates.projectId ?? '', false);
    if ('areaId' in updates) setDraftField('areaId', updates.areaId ?? '', false);
};

export function useTaskEditAttachments({
    attachments = EMPTY_ATTACHMENTS,
    setAttachments,
    setDraftField,
    taskId,
    t,
    visible,
}: UseTaskEditAttachmentsParams) {
    const attachmentsRef = React.useRef(attachments);
    attachmentsRef.current = attachments;
    const settleDraftAttachments = React.useCallback((input: AttachmentDraftSettlementInput) => {
        for (const candidate of planAttachmentDraftSettlement(input)) {
            void deleteManagedAttachmentFile(candidate.attachment);
        }
    }, []);
    const [linkModalVisible, setLinkModalVisible] = React.useState(false);
    const [audioModalVisible, setAudioModalVisible] = React.useState(false);
    const [imagePreviewAttachment, setImagePreviewAttachment] = React.useState<Attachment | null>(null);
    const [audioAttachment, setAudioAttachment] = React.useState<Attachment | null>(null);
    const [audioLoading, setAudioLoading] = React.useState(false);
    const [audioTranscribing, setAudioTranscribing] = React.useState(false);
    const [audioTranscriptionError, setAudioTranscriptionError] = React.useState<string | null>(null);
    const [linkInput, setLinkInput] = React.useState('');
    const [linkInputTouched, setLinkInputTouched] = React.useState(false);
    const [editingLinkAttachmentId, setEditingLinkAttachmentId] = React.useState<string | null>(null);

    const audioPlayer = useAudioPlayer(null, { updateInterval: 500 });
    const audioStatus = useAudioPlayerStatus(audioPlayer);
    const audioLoadedRef = React.useRef(false);
    const audioStoppingRef = React.useRef(false);

    const visibleAttachments = React.useMemo(
        () => attachments.filter((attachment) => !attachment.deletedAt),
        [attachments]
    );

    const resolveValidationMessage = React.useCallback((error?: string) => {
        if (error === 'file_too_large') return t('attachments.fileTooLarge');
        if (error === 'mime_type_blocked' || error === 'mime_type_not_allowed') return t('attachments.invalidFileType');
        return t('attachments.fileNotSupported');
    }, [t]);
    const resolveText = React.useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);

    const addFileAttachment = React.useCallback(async () => {
        const result = await DocumentPicker.getDocumentAsync({
            copyToCacheDirectory: false,
            multiple: false,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        const size = asset.size;
        if (typeof size === 'number') {
            const validation = await validateAttachmentForUpload(
                {
                    id: 'pending',
                    kind: 'file',
                    title: asset.name || 'file',
                    uri: asset.uri,
                    mimeType: asset.mimeType,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                size
            );
            if (!validation.valid) {
                Alert.alert(t('attachments.title'), resolveValidationMessage(validation.error));
                return;
            }
        }
        const now = new Date().toISOString();
        const attachment: Attachment = {
            id: generateUUID(),
            kind: 'file',
            title: asset.name || 'file',
            uri: asset.uri,
            mimeType: asset.mimeType,
            size: asset.size,
            createdAt: now,
            updatedAt: now,
            localStatus: 'available',
        };
        const cached = await persistAttachmentLocally(attachment);
        if (cached.uri === attachment.uri) {
            Alert.alert(t('attachments.title'), t('attachments.fileNotReadable'));
            return;
        }
        setAttachments((current) => [...(current || []), cached]);
    }, [resolveValidationMessage, setAttachments, t]);

    const addImageAttachment = React.useCallback(async () => {
        let imagePicker: typeof import('expo-image-picker') | null = null;
        try {
            imagePicker = await import('expo-image-picker');
        } catch (error) {
            logTaskWarn('Image picker unavailable', error);
            Alert.alert(t('attachments.photoUnavailableTitle'), t('attachments.photoUnavailableBody'));
            return;
        }

        if (Platform.OS === 'ios') {
            const permission = await imagePicker.getMediaLibraryPermissionsAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionsAsync();
                if (!requested.granted) return;
            }
        }
        const result = await imagePicker.launchImageLibraryAsync({
            mediaTypes: imagePicker.MediaTypeOptions.Images,
            quality: 0.9,
            allowsMultipleSelection: false,
        });
        if (result.canceled || !result.assets?.length) return;
        const asset = result.assets[0];
        const size = (asset as { fileSize?: number }).fileSize ?? (asset as { size?: number }).size;
        if (typeof size === 'number') {
            const validation = await validateAttachmentForUpload(
                {
                    id: 'pending',
                    kind: 'file',
                    title: asset.fileName || asset.uri.split('/').pop() || 'image',
                    uri: asset.uri,
                    mimeType: asset.mimeType,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                size
            );
            if (!validation.valid) {
                Alert.alert(t('attachments.title'), resolveValidationMessage(validation.error));
                return;
            }
        }
        const now = new Date().toISOString();
        const attachment: Attachment = {
            id: generateUUID(),
            kind: 'file',
            title: asset.fileName || asset.uri.split('/').pop() || 'image',
            uri: asset.uri,
            mimeType: asset.mimeType,
            size: (asset as { fileSize?: number }).fileSize,
            createdAt: now,
            updatedAt: now,
            localStatus: 'available',
        };
        const cached = await persistAttachmentLocally(attachment);
        if (cached.uri === attachment.uri) {
            Alert.alert(t('attachments.title'), t('attachments.fileNotReadable'));
            return;
        }
        setAttachments((current) => [...(current || []), cached]);
    }, [resolveValidationMessage, setAttachments, t]);

    const openAddLinkAttachment = React.useCallback(() => {
        setEditingLinkAttachmentId(null);
        setLinkInput('');
        setLinkInputTouched(false);
        setLinkModalVisible(true);
    }, []);

    const editLinkAttachment = React.useCallback((attachment: Attachment) => {
        if (attachment.kind !== 'link') return;
        setEditingLinkAttachmentId(attachment.id);
        setLinkInput(
            attachment.title && attachment.title !== attachment.uri
                ? `${attachment.title} | ${attachment.uri}`
                : attachment.uri
        );
        setLinkInputTouched(false);
        setLinkModalVisible(true);
    }, []);

    const confirmAddLink = React.useCallback(() => {
        if (!linkInput.trim()) {
            setLinkInputTouched(true);
            return;
        }
        const normalized = normalizeLinkAttachmentInput(linkInput);
        if (!normalized.uri || !isValidLinkUri(normalized.uri)) {
            Alert.alert(t('attachments.title'), t('attachments.invalidLink'));
            return;
        }
        const now = new Date().toISOString();
        if (editingLinkAttachmentId) {
            setAttachments((current) => (
                (current || []).map((attachment) => (
                    attachment.id === editingLinkAttachmentId
                        ? {
                            ...attachment,
                            kind: 'link',
                            title: normalized.title,
                            uri: normalized.uri,
                            updatedAt: now,
                        }
                        : attachment
                ))
            ));
            setLinkInput('');
            setLinkInputTouched(false);
            setEditingLinkAttachmentId(null);
            setLinkModalVisible(false);
            return;
        }
        const attachment: Attachment = {
            id: generateUUID(),
            kind: normalized.kind,
            title: normalized.title,
            uri: normalized.uri,
            createdAt: now,
            updatedAt: now,
        };
        setAttachments((current) => [...(current || []), attachment]);
        setLinkInput('');
        setLinkInputTouched(false);
        setEditingLinkAttachmentId(null);
        setLinkModalVisible(false);
    }, [editingLinkAttachmentId, linkInput, setAttachments, t]);

    const closeLinkModal = React.useCallback(() => {
        setLinkModalVisible(false);
        setLinkInput('');
        setLinkInputTouched(false);
        setEditingLinkAttachmentId(null);
    }, []);

    const isAudioAttachment = React.useCallback((attachment: Attachment) => {
        const mime = attachment.mimeType?.toLowerCase();
        if (mime?.startsWith('audio/')) return true;
        return /\.(m4a|aac|mp3|wav|caf|ogg|oga|3gp|3gpp)$/i.test(attachment.uri);
    }, []);

    const unloadAudio = React.useCallback(async () => {
        if (audioStoppingRef.current) return;
        if (!audioLoadedRef.current) return;
        audioStoppingRef.current = true;
        try {
            await Promise.resolve(audioPlayer.pause());
            audioPlayer.replace(null);
        } catch (error) {
            if (!isReleasedAudioPlayerError(error)) {
                logTaskWarn('Stop audio failed', error);
            }
        } finally {
            audioLoadedRef.current = false;
            audioStoppingRef.current = false;
        }
    }, [audioPlayer]);

    const openAudioAttachment = React.useCallback(async (attachment: Attachment) => {
        setAudioAttachment(attachment);
        setAudioModalVisible(true);
        setAudioLoading(true);
        setAudioTranscriptionError(null);
        try {
            await unloadAudio();
            await setAudioModeAsync({
                allowsRecording: false,
                playsInSilentMode: true,
                interruptionMode: 'duckOthers',
                interruptionModeAndroid: 'duckOthers',
            });
            const normalizedUri = normalizeAudioUri(attachment.uri);
            if (normalizedUri) {
                try {
                    const info = Paths.info(normalizedUri);
                    if (info?.exists === false) {
                        logTaskWarn('Audio attachment missing', new Error(`uri:${normalizedUri}`));
                        Alert.alert(t('attachments.title'), t('attachments.missing'));
                        setAudioModalVisible(false);
                        setAudioAttachment(null);
                        return;
                    }
                    if (info?.isDirectory) {
                        logTaskWarn('Audio attachment path is directory', new Error(`uri:${normalizedUri}`));
                        Alert.alert(t('attachments.title'), t('attachments.missing'));
                        setAudioModalVisible(false);
                        setAudioAttachment(null);
                        return;
                    }
                } catch (error) {
                    logTaskWarn('Audio attachment info failed', error);
                }
            } else {
                logTaskWarn('Audio attachment uri missing', new Error('empty-uri'));
                Alert.alert(t('attachments.title'), t('attachments.missing'));
                setAudioModalVisible(false);
                setAudioAttachment(null);
                return;
            }
            audioPlayer.replace({ uri: normalizedUri });
            audioLoadedRef.current = true;
            await Promise.resolve(audioPlayer.play());
        } catch (error) {
            audioLoadedRef.current = false;
            logTaskError('Failed to play audio attachment', error);
            Alert.alert(t('quickAdd.audioErrorTitle'), t('quickAdd.audioErrorBody'));
            setAudioModalVisible(false);
            setAudioAttachment(null);
        } finally {
            setAudioLoading(false);
        }
    }, [audioPlayer, t, unloadAudio]);

    const closeAudioModal = React.useCallback(() => {
        setAudioModalVisible(false);
        setAudioAttachment(null);
        setAudioLoading(false);
        setAudioTranscribing(false);
        setAudioTranscriptionError(null);
        void unloadAudio();
    }, [unloadAudio]);

    const closeImagePreview = React.useCallback(() => {
        setImagePreviewAttachment(null);
    }, []);

    const toggleAudioPlayback = React.useCallback(async () => {
        if (!audioStatus?.isLoaded || !audioLoadedRef.current) return;
        try {
            if (audioStatus.playing) {
                await Promise.resolve(audioPlayer.pause());
            } else {
                const duration = Number.isFinite(audioStatus.duration) ? audioStatus.duration : 0;
                const currentTime = Number.isFinite(audioStatus.currentTime) ? audioStatus.currentTime : 0;
                const isAtEnd = duration > 0 && currentTime >= Math.max(0, duration - 0.1);
                if (audioStatus.didJustFinish || isAtEnd) {
                    await Promise.resolve(audioPlayer.seekTo(0));
                }
                await Promise.resolve(audioPlayer.play());
            }
        } catch (error) {
            if (isReleasedAudioPlayerError(error)) {
                audioLoadedRef.current = false;
                return;
            }
            logTaskWarn('Toggle audio playback failed', error);
        }
    }, [audioPlayer, audioStatus]);

    const retryAudioTranscription = React.useCallback(async () => {
        const currentAttachment = audioAttachment;
        if (!currentAttachment || currentAttachment.kind !== 'file' || !currentAttachment.uri || !taskId || audioTranscribing) {
            return;
        }

        setAudioTranscribing(true);
        setAudioTranscriptionError(null);
        try {
            await unloadAudio();
            const {
                tasks: currentTasks,
                projects: currentProjects,
                addProject: addProjectNow,
                updateTask: updateTaskNow,
                settings: currentSettings,
            } = useTaskStore.getState();
            const existing = currentTasks.find((task) => task.id === taskId);
            if (!existing) {
                throw new Error(resolveText('attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
            }

            const speech = currentSettings.ai?.speechToText;
            const speechRuntime = resolveSpeechToTextRuntimeSettings(speech);
            if (!speechRuntime.enabled) {
                throw new Error(resolveText('attachments.transcriptionUnavailable', 'Speech-to-text is not ready. Check your AI settings and try again.'));
            }

            const { provider, model, modelPath } = speechRuntime;
            const apiKey = provider === 'whisper' ? '' : await loadAIKey(provider).catch(() => '');
            const whisperResolved = provider === 'whisper'
                ? await ensureWhisperModelPathForConfigAsync(model, modelPath)
                : null;
            const whisperModelReady = provider === 'whisper' ? Boolean(whisperResolved?.exists) : false;
            const resolvedModelPath = provider === 'whisper'
                ? (whisperResolved?.exists ? whisperResolved.path : modelPath)
                : undefined;
            const speechReady = provider === 'whisper'
                ? whisperModelReady || Boolean(modelPath?.trim())
                // A self-hosted OpenAI-compatible server (#930) substitutes for a key.
                : Boolean(apiKey) || (provider === 'openai' && Boolean(speechRuntime.baseUrl?.trim()));
            if (!speechReady) {
                throw new Error(resolveText('attachments.transcriptionUnavailable', 'Speech-to-text is not ready. Check your AI settings and try again.'));
            }

            const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : undefined;
            const result = await processAudioCapture(normalizeAudioUri(currentAttachment.uri), {
                provider,
                apiKey,
                baseUrl: speechRuntime.baseUrl,
                model,
                modelPath: resolvedModelPath,
                isFossBuild: speechRuntime.isFossBuild,
                language: speechRuntime.language,
                mode: speechRuntime.mode,
                fieldStrategy: speechRuntime.fieldStrategy,
                parseModel: provider === 'openai' && currentSettings.ai?.provider === 'openai' ? currentSettings.ai?.model : undefined,
                now: new Date(),
                timeZone,
            });

            const { updates, suggestedProjectTitle } = buildTaskUpdatesFromSpeechResult(existing, result, currentSettings);
            if (suggestedProjectTitle && !existing.projectId) {
                const targetAreaId = updates.areaId ?? existing.areaId;
                const match = findSelectableProjectByTitleAndArea(currentProjects, suggestedProjectTitle, targetAreaId);
                if (match) {
                    updates.projectId = match.id;
                } else {
                    const created = await addProjectNow(
                        suggestedProjectTitle,
                        DEFAULT_PROJECT_COLOR,
                        targetAreaId ? { areaId: targetAreaId } : undefined
                    );
                    if (!created) {
                        throw new Error(resolveText('attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
                    }
                    updates.projectId = created.id;
                }
            }

            if (Object.keys(updates).length > 0) {
                await updateTaskNow(taskId, updates);
                applySpeechUpdatesToDraft(updates, setDraftField);
            }
            closeAudioModal();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAudioTranscriptionError(message || resolveText('attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
        } finally {
            setAudioTranscribing(false);
        }
    }, [audioAttachment, audioTranscribing, closeAudioModal, resolveText, setDraftField, taskId, unloadAudio]);

    const currentAttachmentForIdentity = React.useCallback((
        attachmentId: string,
        identity: string,
    ): Attachment | null => {
        const currentDraftAttachment = attachmentsRef.current.find((item) => item.id === attachmentId);
        if (!hasAttachmentDownloadIdentity(currentDraftAttachment, identity)) return null;
        if (taskId && currentDraftAttachment.cloudKey) {
            const currentTask = useTaskStore.getState()._allTasks.find((item) => item.id === taskId);
            const currentStoredAttachment = currentTask?.attachments?.find((item) => item.id === attachmentId);
            if (!hasAttachmentDownloadIdentity(currentStoredAttachment, identity)) return null;
        }
        return currentDraftAttachment;
    }, [taskId]);

    const updateAttachmentStateIfCurrent = React.useCallback((
        attachmentId: string,
        identity: string,
        patch: Partial<Attachment>,
    ): Attachment | null => {
        const currentAttachment = currentAttachmentForIdentity(attachmentId, identity);
        if (!currentAttachment) return null;
        const nextAttachment = { ...currentAttachment, ...patch };
        setAttachments((current) => {
            const latestAttachment = (current || []).find((item) => item.id === attachmentId);
            if (!hasAttachmentDownloadIdentity(latestAttachment, identity)) return current;
            const nextAttachments = (current || []).map((item) =>
                item.id === attachmentId ? { ...item, ...patch } : item
            );
            return nextAttachments;
        }, false);
        return nextAttachment;
    }, [currentAttachmentForIdentity, setAttachments]);

    type TaskAttachmentResolution = AttachmentAvailabilityOutcome | { status: 'stale' };

    const resolveAttachment = React.useCallback(async (attachment: Attachment): Promise<TaskAttachmentResolution> => {
        if (attachment.kind !== 'file') return { status: 'available', attachment };
        const identity = getAttachmentDownloadIdentity(attachment);
        if (!currentAttachmentForIdentity(attachment.id, identity)) return { status: 'stale' };
        const shouldDownload = attachment.cloudKey && (attachment.localStatus === 'missing' || !attachment.uri);
        if (shouldDownload && attachment.localStatus !== 'downloading') {
            updateAttachmentStateIfCurrent(attachment.id, identity, { localStatus: 'downloading' });
        }
        const outcome = await ensureAttachmentAvailableDetailed(attachment);
        if (outcome.status === 'available') {
            const currentAttachment = currentAttachmentForIdentity(attachment.id, identity);
            if (!currentAttachment) return { status: 'stale' };
            const resolved = updateAttachmentStateIfCurrent(
                attachment.id,
                identity,
                getAttachmentAvailabilityPatch(currentAttachment, outcome.attachment),
            );
            return resolved
                ? { status: 'available', attachment: resolved }
                : { status: 'stale' };
        }
        if (shouldDownload) {
            const restored = updateAttachmentStateIfCurrent(attachment.id, identity, { localStatus: 'missing' });
            if (!restored) return { status: 'stale' };
        }
        return outcome;
    }, [currentAttachmentForIdentity, updateAttachmentStateIfCurrent]);

    const showAttachmentResolutionError = React.useCallback((resolution: TaskAttachmentResolution) => {
        if (resolution.status === 'stale' || resolution.status === 'available') return;
        const message = resolution.status === 'generation-conflict'
            ? t('attachments.downloadConflict')
            : t('attachments.missing');
        Alert.alert(t('attachments.title'), message);
    }, [t]);

    const downloadAttachment = React.useCallback(async (attachment: Attachment) => {
        const resolution = await resolveAttachment(attachment);
        showAttachmentResolutionError(resolution);
    }, [resolveAttachment, showAttachmentResolutionError]);

    const isImageAttachment = React.useCallback((attachment: Attachment) => {
        const mime = attachment.mimeType?.toLowerCase();
        if (mime?.startsWith('image/')) return true;
        return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
    }, []);

    const openAttachment = React.useCallback(async (attachment: Attachment) => {
        const resolution = await resolveAttachment(attachment);
        if (resolution.status !== 'available') {
            showAttachmentResolutionError(resolution);
            return;
        }
        const resolved = resolution.attachment;
        if (resolved.kind === 'link') {
            Linking.openURL(resolved.uri).catch((error) => logTaskError('Failed to open attachment URL', error));
            return;
        }
        if (isAudioAttachment(resolved)) {
            openAudioAttachment(resolved).catch((error) => logTaskError('Failed to open audio attachment', error));
            return;
        }
        if (isImageAttachment(resolved)) {
            setImagePreviewAttachment(resolved);
            return;
        }
        // Android: a real ACTION_VIEW open first — the share sheet below only
        // reaches send/save targets, so a PDF "open" only offered saving it.
        if (await tryOpenWithAndroidViewer(resolved.uri, resolved.mimeType)) return;
        const available = await Sharing.isAvailableAsync().catch((error) => {
            logTaskWarn('[Sharing] availability check failed', error);
            return false;
        });
        if (available) {
            Sharing.shareAsync(resolved.uri).catch((error) => logTaskError('Failed to share attachment', error));
        } else {
            Linking.openURL(resolved.uri).catch((error) => logTaskError('Failed to open attachment URL', error));
        }
    }, [isAudioAttachment, isImageAttachment, openAudioAttachment, resolveAttachment, showAttachmentResolutionError]);

    const removeAttachment = React.useCallback((id: string) => {
        const now = new Date().toISOString();
        const next = attachments.map((attachment) =>
            attachment.id === id ? { ...attachment, deletedAt: now, updatedAt: now } : attachment
        );
        setAttachments(next);
    }, [attachments, setAttachments]);

    React.useEffect(() => {
        if (!visible) {
            closeAudioModal();
            closeImagePreview();
        }
    }, [closeAudioModal, closeImagePreview, visible]);

    React.useEffect(() => {
        if (!audioStatus?.isLoaded) {
            audioLoadedRef.current = false;
        }
    }, [audioStatus?.isLoaded]);

    React.useEffect(() => {
        return () => {
            void unloadAudio();
        };
    }, [unloadAudio]);

    return {
        addFileAttachment,
        addImageAttachment,
        attachments,
        audioAttachment,
        audioLoading,
        audioTranscribing,
        audioTranscriptionError,
        audioModalVisible,
        audioStatus,
        closeAudioModal,
        closeImagePreview,
        closeLinkModal,
        confirmAddLink,
        downloadAttachment,
        editLinkAttachment,
        editingLinkAttachmentId,
        imagePreviewAttachment,
        isImageAttachment,
        linkInput,
        linkInputTouched,
        linkModalVisible,
        openAddLinkAttachment,
        openAttachment,
        removeAttachment,
        retryAudioTranscription,
        setAudioModalVisible,
        setImagePreviewAttachment,
        setLinkInput,
        setLinkInputTouched,
        setLinkModalVisible,
        settleDraftAttachments,
        toggleAudioPlayback,
        visibleAttachments,
    };
}
