import React from 'react';
import { Alert, Platform } from 'react-native';
import type { Attachment, Task } from '@mindwtr/core';
import {
    generateUUID,
    normalizeLinkAttachmentInput,
    validateAttachmentForUpload,
} from '@mindwtr/core';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Paths } from 'expo-file-system';

import { ensureAttachmentAvailable, persistAttachmentLocally } from '../../lib/attachment-sync';
import {
    isReleasedAudioPlayerError,
    isValidLinkUri,
    logTaskError,
    logTaskWarn,
} from './task-edit-modal.utils';
import type { SetEditedTask } from './use-task-edit-state';

type UseTaskEditAttachmentsParams = {
    editedTask: Partial<Task>;
    setEditedTask: SetEditedTask;
    t: (key: string) => string;
    visible: boolean;
};

export function useTaskEditAttachments({
    editedTask,
    setEditedTask,
    t,
    visible,
}: UseTaskEditAttachmentsParams) {
    const [linkModalVisible, setLinkModalVisible] = React.useState(false);
    const [audioModalVisible, setAudioModalVisible] = React.useState(false);
    const [imagePreviewAttachment, setImagePreviewAttachment] = React.useState<Attachment | null>(null);
    const [audioAttachment, setAudioAttachment] = React.useState<Attachment | null>(null);
    const [audioLoading, setAudioLoading] = React.useState(false);
    const [linkInput, setLinkInput] = React.useState('');
    const [linkInputTouched, setLinkInputTouched] = React.useState(false);

    const audioPlayer = useAudioPlayer(null, { updateInterval: 500 });
    const audioStatus = useAudioPlayerStatus(audioPlayer);
    const audioLoadedRef = React.useRef(false);
    const audioStoppingRef = React.useRef(false);

    const attachments = React.useMemo(
        () => (editedTask.attachments || []) as Attachment[],
        [editedTask.attachments]
    );
    const visibleAttachments = React.useMemo(
        () => attachments.filter((attachment) => !attachment.deletedAt),
        [attachments]
    );

    const resolveValidationMessage = React.useCallback((error?: string) => {
        if (error === 'file_too_large') return t('attachments.fileTooLarge');
        if (error === 'mime_type_blocked' || error === 'mime_type_not_allowed') return t('attachments.invalidFileType');
        return t('attachments.fileNotSupported');
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
        setEditedTask((prev) => ({ ...prev, attachments: [...(prev.attachments || []), cached] }));
    }, [resolveValidationMessage, setEditedTask, t]);

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
        setEditedTask((prev) => ({ ...prev, attachments: [...(prev.attachments || []), cached] }));
    }, [resolveValidationMessage, setEditedTask, t]);

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
        const attachment: Attachment = {
            id: generateUUID(),
            kind: normalized.kind,
            title: normalized.title,
            uri: normalized.uri,
            createdAt: now,
            updatedAt: now,
        };
        setEditedTask((prev) => ({ ...prev, attachments: [...(prev.attachments || []), attachment] }));
        setLinkInput('');
        setLinkInputTouched(false);
        setLinkModalVisible(false);
    }, [linkInput, setEditedTask, t]);

    const closeLinkModal = React.useCallback(() => {
        setLinkModalVisible(false);
        setLinkInput('');
        setLinkInputTouched(false);
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
        } catch (error) {
            if (!isReleasedAudioPlayerError(error)) {
                logTaskWarn('Stop audio failed', error);
            }
        } finally {
            audioLoadedRef.current = false;
            audioStoppingRef.current = false;
        }
    }, [audioPlayer]);

    const normalizeAudioUri = React.useCallback((uri: string) => {
        if (!uri) return '';
        if (uri.startsWith('file://') || uri.startsWith('content://')) return uri;
        if (uri.startsWith('file:/')) {
            const stripped = uri.replace(/^file:\//, '/');
            return `file://${stripped}`;
        }
        if (uri.startsWith('/')) return `file://${uri}`;
        return uri;
    }, []);

    const openAudioAttachment = React.useCallback(async (attachment: Attachment) => {
        setAudioAttachment(attachment);
        setAudioModalVisible(true);
        setAudioLoading(true);
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
    }, [audioPlayer, normalizeAudioUri, t, unloadAudio]);

    const closeAudioModal = React.useCallback(() => {
        setAudioModalVisible(false);
        setAudioAttachment(null);
        setAudioLoading(false);
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

    const updateAttachmentState = React.useCallback((nextAttachment: Attachment) => {
        setEditedTask((prev) => {
            const nextAttachments = (prev.attachments || []).map((item) =>
                item.id === nextAttachment.id ? { ...item, ...nextAttachment } : item
            );
            return { ...prev, attachments: nextAttachments };
        }, false);
    }, [setEditedTask]);

    const resolveAttachment = React.useCallback(async (attachment: Attachment): Promise<Attachment | null> => {
        if (attachment.kind !== 'file') return attachment;
        const shouldDownload = attachment.cloudKey && (attachment.localStatus === 'missing' || !attachment.uri);
        if (shouldDownload && attachment.localStatus !== 'downloading') {
            updateAttachmentState({ ...attachment, localStatus: 'downloading' });
        }
        const resolved = await ensureAttachmentAvailable(attachment);
        if (resolved) {
            if (resolved.uri !== attachment.uri || resolved.localStatus !== attachment.localStatus) {
                updateAttachmentState(resolved);
            }
            return resolved;
        }
        if (shouldDownload) {
            updateAttachmentState({ ...attachment, localStatus: 'missing' });
        }
        return null;
    }, [updateAttachmentState]);

    const downloadAttachment = React.useCallback(async (attachment: Attachment) => {
        const resolved = await resolveAttachment(attachment);
        if (!resolved) {
            const message = attachment.kind === 'file' ? t('attachments.missing') : t('attachments.fileNotSupported');
            Alert.alert(t('attachments.title'), message);
        }
    }, [resolveAttachment, t]);

    const isImageAttachment = React.useCallback((attachment: Attachment) => {
        const mime = attachment.mimeType?.toLowerCase();
        if (mime?.startsWith('image/')) return true;
        return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
    }, []);

    const openAttachment = React.useCallback(async (attachment: Attachment) => {
        const resolved = await resolveAttachment(attachment);
        if (!resolved) {
            const message = attachment.kind === 'file' ? t('attachments.missing') : t('attachments.fileNotSupported');
            Alert.alert(t('attachments.title'), message);
            return;
        }
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
        const available = await Sharing.isAvailableAsync().catch((error) => {
            logTaskWarn('[Sharing] availability check failed', error);
            return false;
        });
        if (available) {
            Sharing.shareAsync(resolved.uri).catch((error) => logTaskError('Failed to share attachment', error));
        } else {
            Linking.openURL(resolved.uri).catch((error) => logTaskError('Failed to open attachment URL', error));
        }
    }, [isAudioAttachment, isImageAttachment, openAudioAttachment, resolveAttachment, t]);

    const removeAttachment = React.useCallback((id: string) => {
        const now = new Date().toISOString();
        const next = attachments.map((attachment) =>
            attachment.id === id ? { ...attachment, deletedAt: now, updatedAt: now } : attachment
        );
        setEditedTask((prev) => ({ ...prev, attachments: next }));
    }, [attachments, setEditedTask]);

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
        audioModalVisible,
        audioStatus,
        closeAudioModal,
        closeImagePreview,
        closeLinkModal,
        confirmAddLink,
        downloadAttachment,
        imagePreviewAttachment,
        isImageAttachment,
        linkInput,
        linkInputTouched,
        linkModalVisible,
        openAttachment,
        removeAttachment,
        setAudioModalVisible,
        setImagePreviewAttachment,
        setLinkInput,
        setLinkInputTouched,
        setLinkModalVisible,
        toggleAudioPlayback,
        visibleAttachments,
    };
}
