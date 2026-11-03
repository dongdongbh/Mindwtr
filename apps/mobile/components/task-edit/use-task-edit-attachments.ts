import React from 'react';
import { Alert, Platform } from 'react-native';
import {
    DEFAULT_PROJECT_COLOR,
    addPickedAttachment,
    buildTaskUpdatesFromSpeechResult,
    findSelectableProjectByTitleAndArea,
    findTaskDraftAttachmentForIdentity,
    generateUUID,
    getAttachmentOpenLinkFailedMessage,
    getAttachmentLinkEditText,
    getAttachmentResolutionMessage,
    isAttachmentFileInUse,
    isImageAttachment,
    isSandboxMode,
    patchAttachment,
    planAttachmentDraftSettlement,
    planAttachmentLinkBatch,
    planAttachmentLinkEdit,
    planAttachmentOpen,
    resolveAttachmentAvailability,
    softDeleteAttachment,
    translateWithFallback,
    type Attachment,
    type AttachmentDraftSettlementInput,
    type AttachmentResolution,
    type Task,
    useTaskStore,
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
import { hasAttachmentDownloadIdentity } from '../../lib/attachment-sync-availability';
import { attachmentAvailabilityPort } from '../../lib/attachment-availability-port';
import { loadAIKey } from '../../lib/ai-config';
import { tryOpenWithAndroidViewer } from '../../lib/open-file-externally';
import { openExternalLink } from '../../lib/open-external-link';
import { ensureWhisperModelPathForConfigAsync, processAudioCapture, resolveSpeechToTextRuntimeSettings } from '../../lib/speech-to-text';
import { normalizeAudioUri } from '../../lib/speech-to-text.helpers';
import {
    isReleasedAudioPlayerError,
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
    canMutate?: () => boolean;
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
    canMutate = () => true,
    setAttachments,
    setDraftField,
    taskId,
    t,
    visible,
}: UseTaskEditAttachmentsParams) {
    const attachmentsRef = React.useRef(attachments);
    attachmentsRef.current = attachments;
    const showSandboxUnavailable = React.useCallback(() => {
        Alert.alert(t('attachments.title'), t('sandbox.unavailable'));
    }, [t]);
    const settleDraftAttachments = React.useCallback((input: AttachmentDraftSettlementInput) => {
        if (isSandboxMode()) return;
        for (const { attachment } of planAttachmentDraftSettlement(input)) {

            void deleteManagedAttachmentFile(attachment, {
                keep: () => {
                    const state = useTaskStore.getState();
                    return isAttachmentFileInUse(attachment.uri, [
                        ...(state._allTasks ?? state.tasks ?? []),
                        ...(state._allProjects ?? state.projects ?? []),
                    ]);
                },
            });
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
    const ownerRef = React.useRef({ taskId, visible, canMutate });
    ownerRef.current = { taskId, visible, canMutate };
    const audioAttachmentRef = React.useRef(audioAttachment);
    audioAttachmentRef.current = audioAttachment;

    const getLiveMutableTask = React.useCallback((expectedTaskId: string): Task | null => {
        const owner = ownerRef.current;
        if (!owner.visible || owner.taskId !== expectedTaskId || !owner.canMutate()) return null;
        const state = useTaskStore.getState();
        const currentTask = (state._allTasks ?? state.tasks).find((candidate) => candidate.id === expectedTaskId);
        if (!currentTask || currentTask.deletedAt) return null;
        if (currentTask.projectId) {
            const currentProject = (state._allProjects ?? state.projects)
                .find((candidate) => candidate.id === currentTask.projectId);
            if (!currentProject || currentProject.deletedAt || currentProject.status === 'archived') return null;
        }
        return currentTask;
    }, []);

    const audioPlayer = useAudioPlayer(null, { updateInterval: 500 });
    const audioStatus = useAudioPlayerStatus(audioPlayer);
    const audioLoadedRef = React.useRef(false);
    const audioStoppingRef = React.useRef(false);

    const visibleAttachments = React.useMemo(
        () => attachments.filter((attachment) => !attachment.deletedAt),
        [attachments]
    );

    const resolveText = React.useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);

    const addPickedFile = React.useCallback(async (
        source: 'file' | 'image',
        asset: Parameters<typeof addPickedAttachment>[0]['asset'],
    ) => {
        const outcome = await addPickedAttachment({
            source,
            asset,
            newId: () => generateUUID(),
            persist: (attachment) => persistAttachmentLocally(attachment),
            t,
        });
        if (outcome.kind === 'refused') {
            Alert.alert(t('attachments.title'), outcome.message);
            return;
        }
        setAttachments((current) => [...(current || []), outcome.attachment]);
    }, [setAttachments, t]);

    const addFileAttachment = React.useCallback(async () => {
        if (isSandboxMode()) {
            showSandboxUnavailable();
            return;
        }
        const result = await DocumentPicker.getDocumentAsync({
            copyToCacheDirectory: false,
            multiple: false,
        });
        if (result.canceled) return;
        await addPickedFile('file', result.assets[0]);
    }, [addPickedFile, showSandboxUnavailable]);

    const addImageAttachment = React.useCallback(async () => {
        if (isSandboxMode()) {
            showSandboxUnavailable();
            return;
        }
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
        await addPickedFile('image', result.assets[0]);
    }, [addPickedFile, showSandboxUnavailable, t]);

    const openAddLinkAttachment = React.useCallback(() => {
        if (isSandboxMode()) {
            showSandboxUnavailable();
            return;
        }
        setEditingLinkAttachmentId(null);
        setLinkInput('');
        setLinkInputTouched(false);
        setLinkModalVisible(true);
    }, [showSandboxUnavailable]);

    const editLinkAttachment = React.useCallback((attachment: Attachment) => {
        if (isSandboxMode()) {
            showSandboxUnavailable();
            return;
        }
        if (attachment.kind !== 'link') return;
        setEditingLinkAttachmentId(attachment.id);
        setLinkInput(getAttachmentLinkEditText(attachment));
        setLinkInputTouched(false);
        setLinkModalVisible(true);
    }, [showSandboxUnavailable]);

    const confirmAddLink = React.useCallback(() => {
        if (isSandboxMode()) {
            showSandboxUnavailable();
            return;
        }
        if (!linkInput.trim()) {
            setLinkInputTouched(true);
            return;
        }
        const now = new Date().toISOString();
        if (editingLinkAttachmentId) {
            const edit = planAttachmentLinkEdit(linkInput, now, t);
            if (edit.kind === 'refused') {
                Alert.alert(t('attachments.title'), edit.message);
                return;
            }
            setAttachments((current) => patchAttachment(current || [], editingLinkAttachmentId, edit.patch));
            setLinkInput('');
            setLinkInputTouched(false);
            setEditingLinkAttachmentId(null);
            setLinkModalVisible(false);
            return;
        }
        const batch = planAttachmentLinkBatch(linkInput, { newId: () => generateUUID(), now, t });
        if (batch.kind === 'refused') {
            Alert.alert(t('attachments.title'), batch.message);
            return;
        }
        if (batch.kind === 'nothing') return;
        const { added } = batch;
        setAttachments((current) => [...(current || []), ...added]);
        setLinkInput('');
        setLinkInputTouched(false);
        setEditingLinkAttachmentId(null);
        setLinkModalVisible(false);
    }, [editingLinkAttachmentId, linkInput, setAttachments, showSandboxUnavailable, t]);

    const closeLinkModal = React.useCallback(() => {
        setLinkModalVisible(false);
        setLinkInput('');
        setLinkInputTouched(false);
        setEditingLinkAttachmentId(null);
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
        if (isSandboxMode()) {
            showSandboxUnavailable();
            return;
        }
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
    }, [audioPlayer, showSandboxUnavailable, t, unloadAudio]);

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
        if (isSandboxMode()) return;
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
        if (isSandboxMode()) {
            showSandboxUnavailable();
            return;
        }
        const currentAttachment = audioAttachment;
        if (!currentAttachment || currentAttachment.kind !== 'file' || !currentAttachment.uri || !taskId || audioTranscribing) {
            return;
        }
        const retryOwner = {
            taskId,
            attachmentId: currentAttachment.id,
            attachmentUri: currentAttachment.uri,
        };
        const isRetryUiOwnerCurrent = () => {
            const owner = ownerRef.current;
            const currentAudio = audioAttachmentRef.current;
            return owner.visible
                && owner.taskId === retryOwner.taskId
                && currentAudio?.id === retryOwner.attachmentId
                && currentAudio.uri === retryOwner.attachmentUri;
        };
        const currentMutableTask = () => (
            isRetryUiOwnerCurrent() ? getLiveMutableTask(retryOwner.taskId) : null
        );
        if (!currentMutableTask()) return;

        setAudioTranscribing(true);
        setAudioTranscriptionError(null);
        try {
            await unloadAudio();
            let existing = currentMutableTask();
            if (!existing) {
                return;
            }
            const initialState = useTaskStore.getState();
            const currentSettings = initialState.settings;

            const speech = currentSettings.ai?.speechToText;
            const speechRuntime = resolveSpeechToTextRuntimeSettings(speech);
            if (!speechRuntime.enabled) {
                throw new Error(resolveText('attachments.transcriptionUnavailable', 'Speech-to-text is not ready. Check your AI settings and try again.'));
            }

            const { provider, model, modelPath } = speechRuntime;
            let apiKey = '';
            if (provider !== 'whisper') {
                apiKey = await loadAIKey(provider).catch(() => '');
                if (!currentMutableTask()) return;
            }
            let whisperResolved: Awaited<ReturnType<typeof ensureWhisperModelPathForConfigAsync>> | null = null;
            if (provider === 'whisper') {
                whisperResolved = await ensureWhisperModelPathForConfigAsync(model, modelPath);
                if (!currentMutableTask()) return;
            }
            const whisperModelReady = provider === 'whisper' ? Boolean(whisperResolved?.exists) : false;
            const resolvedModelPath = provider === 'whisper'
                ? (whisperResolved?.exists ? whisperResolved.path : modelPath)
                : undefined;
            const speechReady = provider === 'whisper'
                ? whisperModelReady || Boolean(modelPath?.trim())

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
            existing = currentMutableTask();
            if (!existing) return;

            const { updates, suggestedProjectTitle } = buildTaskUpdatesFromSpeechResult(existing, result, currentSettings);
            if (suggestedProjectTitle && !existing.projectId) {
                const currentState = useTaskStore.getState();
                const targetAreaId = updates.areaId ?? existing.areaId;
                const match = findSelectableProjectByTitleAndArea(currentState.projects, suggestedProjectTitle, targetAreaId);
                if (match) {
                    updates.projectId = match.id;
                } else {
                    if (!currentMutableTask()) return;
                    const created = await currentState.addProject(
                        suggestedProjectTitle,
                        DEFAULT_PROJECT_COLOR,
                        targetAreaId ? { areaId: targetAreaId } : undefined
                    );
                    if (!currentMutableTask()) return;
                    if (!created) {
                        throw new Error(resolveText('attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
                    }
                    updates.projectId = created.id;
                }
            }

            if (Object.keys(updates).length > 0) {
                if (!currentMutableTask()) return;
                await useTaskStore.getState().updateTask(retryOwner.taskId, updates);
                if (!currentMutableTask()) return;
                applySpeechUpdatesToDraft(updates, setDraftField);
            }
            if (currentMutableTask()) closeAudioModal();
        } catch (error) {
            if (!isRetryUiOwnerCurrent()) return;
            const message = error instanceof Error ? error.message : String(error);
            setAudioTranscriptionError(message || resolveText('attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
        } finally {
            if (isRetryUiOwnerCurrent()) setAudioTranscribing(false);
        }
    }, [audioAttachment, audioTranscribing, closeAudioModal, getLiveMutableTask, resolveText, setDraftField, showSandboxUnavailable, taskId, unloadAudio]);

    const currentAttachmentForIdentity = React.useCallback((
        attachmentId: string,
        identity: string,
    ): Attachment | null => findTaskDraftAttachmentForIdentity({
        draft: attachmentsRef.current,
        stored: () => (taskId
            ? useTaskStore.getState()._allTasks.find((item) => item.id === taskId)?.attachments?.find((item) => item.id === attachmentId)
            : null),
        attachmentId,
        identity,
        has: (attachment, expected): attachment is Attachment => hasAttachmentDownloadIdentity(attachment, expected),
    }), [taskId]);

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
            return patchAttachment(current || [], attachmentId, patch);
        }, false);
        return nextAttachment;
    }, [currentAttachmentForIdentity, setAttachments]);

    const resolveAttachment = React.useCallback((attachment: Attachment): Promise<AttachmentResolution> => (
        resolveAttachmentAvailability(attachment, {
            availability: attachmentAvailabilityPort,
            current: currentAttachmentForIdentity,
            update: updateAttachmentStateIfCurrent,
        })
    ), [currentAttachmentForIdentity, updateAttachmentStateIfCurrent]);

    const showAttachmentResolutionError = React.useCallback((resolution: AttachmentResolution) => {
        const message = getAttachmentResolutionMessage(resolution, t);
        if (message) Alert.alert(t('attachments.title'), message);
    }, [t]);

    const downloadAttachment = React.useCallback(async (attachment: Attachment) => {
        if (isSandboxMode()) {
            showSandboxUnavailable();
            return;
        }
        const resolution = await resolveAttachment(attachment);
        showAttachmentResolutionError(resolution);
    }, [resolveAttachment, showAttachmentResolutionError, showSandboxUnavailable]);

    const openAttachment = React.useCallback(async (attachment: Attachment) => {
        if (isSandboxMode()) {
            showSandboxUnavailable();
            return;
        }
        const resolution = await resolveAttachment(attachment);
        if (resolution.status !== 'available') {
            showAttachmentResolutionError(resolution);
            return;
        }
        const plan = planAttachmentOpen(resolution.attachment, { audio: true, t });
        if (plan.kind === 'alert') {
            Alert.alert(t('attachments.title'), plan.message);
            return;
        }
        if (plan.kind === 'link') {
            if (/^upnote:\/\//i.test(plan.uri)) {
                await openExternalLink(plan.uri, t, 'attachment');
            } else {
                Linking.openURL(plan.uri).catch((error) => {
                    logTaskError('Failed to open attachment URL', error);
                    Alert.alert(t('attachments.title'), getAttachmentOpenLinkFailedMessage(t));
                });
            }
            return;
        }
        if (plan.kind === 'audio') {
            openAudioAttachment(plan.attachment).catch((error) => logTaskError('Failed to open audio attachment', error));
            return;
        }
        if (plan.kind === 'image') {
            setImagePreviewAttachment(plan.attachment);
            return;
        }


        if (await tryOpenWithAndroidViewer(plan.uri, plan.mimeType ?? undefined)) return;
        const available = await Sharing.isAvailableAsync().catch((error) => {
            logTaskWarn('[Sharing] availability check failed', error);
            return false;
        });
        if (available) {
            Sharing.shareAsync(plan.uri).catch((error) => logTaskError('Failed to share attachment', error));
        } else {
            Linking.openURL(plan.uri).catch((error) => logTaskError('Failed to open attachment URL', error));
        }
    }, [openAudioAttachment, resolveAttachment, showAttachmentResolutionError, showSandboxUnavailable, t]);

    const removeAttachment = React.useCallback((id: string) => {
        setAttachments(softDeleteAttachment(attachments, id, new Date().toISOString()));
    }, [attachments, setAttachments]);

    React.useEffect(() => {
        if (!visible) {
            closeAudioModal();
            closeImagePreview();
        }
    }, [closeAudioModal, closeImagePreview, visible]);

    const previousTaskIdRef = React.useRef(taskId);
    React.useEffect(() => {
        if (previousTaskIdRef.current === taskId) return;
        previousTaskIdRef.current = taskId;
        setAudioModalVisible(false);
        setAudioAttachment(null);
        setAudioLoading(false);
        setAudioTranscribing(false);
        setAudioTranscriptionError(null);
        void unloadAudio();
    }, [taskId, unloadAudio]);

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
