import { useCallback, useEffect, useRef, useState } from 'react';
import { Attachment, DEFAULT_PROJECT_COLOR, buildTaskUpdatesFromSpeechResult, generateUUID, useTaskStore, validateAttachmentForUpload, type Task } from '@mindwtr/core';
import { invoke } from '@tauri-apps/api/core';
import { dataDir } from '@tauri-apps/api/path';
import { BaseDirectory, readFile, readTextFile, size } from '@tauri-apps/plugin-fs';
import { loadAIKey } from '../../lib/ai-config';
import { normalizeAttachmentInput } from '../../lib/attachment-utils';
import { isTauriRuntime } from '../../lib/runtime';
import { logWarn } from '../../lib/app-log';
import { processAudioCapture } from '../../lib/speech-to-text';
import { DEFAULT_WHISPER_MODEL } from '../../lib/speech-models';
import {
    isAudioAttachment,
    isImageAttachment,
    isTextAttachment,
    resolveAttachmentSource,
} from './task-item-attachment-utils';

type UseTaskItemAttachmentsProps = {
    task: Task;
    t: (key: string) => string;
};

export function useTaskItemAttachments({ task, t }: UseTaskItemAttachmentsProps) {
    const [editAttachments, setEditAttachments] = useState<Attachment[]>(task.attachments || []);
    const [attachmentError, setAttachmentError] = useState<string | null>(null);
    const [audioAttachment, setAudioAttachment] = useState<Attachment | null>(null);
    const [audioSource, setAudioSource] = useState<string | null>(null);
    const [audioError, setAudioError] = useState<string | null>(null);
    const [audioTranscribing, setAudioTranscribing] = useState(false);
    const [audioTranscriptionError, setAudioTranscriptionError] = useState<string | null>(null);
    const [imageAttachment, setImageAttachment] = useState<Attachment | null>(null);
    const [imageSource, setImageSource] = useState<string | null>(null);
    const [textAttachment, setTextAttachment] = useState<Attachment | null>(null);
    const [textContent, setTextContent] = useState('');
    const [textError, setTextError] = useState<string | null>(null);
    const [textLoading, setTextLoading] = useState(false);
    const [showLinkPrompt, setShowLinkPrompt] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioLoadRequestRef = useRef(0);
    const audioObjectUrlRef = useRef<string | null>(null);

    const resolveValidationMessage = useCallback((error?: string) => {
        if (error === 'file_too_large') return t('attachments.fileTooLarge');
        if (error === 'mime_type_blocked' || error === 'mime_type_not_allowed') return t('attachments.invalidFileType');
        return t('attachments.fileNotSupported');
    }, [t]);
    const resolveText = useCallback((key: string, fallback: string) => {
        const translated = t(key);
        return translated === key ? fallback : translated;
    }, [t]);

    const resolveAudioBlobSource = useCallback(async (attachment: Attachment) => {
        if (!isTauriRuntime()) return null;
        const uri = attachment.uri.replace(/^file:\/\//i, '');
        try {
            const baseDir = await dataDir();
            if (!uri.startsWith(baseDir)) return null;
            const relative = uri.slice(baseDir.length).replace(/^[\\/]/, '');
            const bytes = await readFile(relative, { baseDir: BaseDirectory.Data });
            const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            const mimeType = attachment.mimeType || 'audio/wav';
            const blob = new Blob([buffer], { type: mimeType });
            return URL.createObjectURL(blob);
        } catch (error) {
            void logWarn('Failed to load audio bytes', {
                scope: 'attachment',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
            return null;
        }
    }, []);

    const readAttachmentBytes = useCallback(async (attachment: Attachment) => {
        if (!isTauriRuntime()) {
            throw new Error(resolveText('attachments.fileNotSupported', 'File not supported.'));
        }
        const uri = attachment.uri.replace(/^file:\/\//i, '');
        if (/^https?:\/\//i.test(uri)) {
            throw new Error(resolveText('attachments.fileNotSupported', 'File not supported.'));
        }
        const base = await dataDir();
        if (uri.startsWith(base)) {
            const relative = uri.slice(base.length).replace(/^[\\/]/, '');
            const bytes = await readFile(relative, { baseDir: BaseDirectory.Data });
            return {
                bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
                path: uri,
            };
        }
        const bytes = await readFile(uri);
        return {
            bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
            path: uri,
        };
    }, [resolveText]);

    const loadTextAttachment = useCallback(async (attachment: Attachment) => {
        if (!isTauriRuntime()) {
            throw new Error(t('attachments.fileNotSupported'));
        }
        const uri = attachment.uri.replace(/^file:\/\//i, '');
        if (/^https?:\/\//i.test(uri)) {
            throw new Error(t('attachments.fileNotSupported'));
        }
        const base = await dataDir();
        if (uri.startsWith(base)) {
            const relative = uri.slice(base.length).replace(/^[\\/]/, '');
            return await readTextFile(relative, { baseDir: BaseDirectory.Data });
        }
        return await readTextFile(uri);
    }, [t]);

    const openExternal = useCallback(async (uri: string) => {
        setAttachmentError(null);
        const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(uri);
        const normalized = hasScheme ? uri : `file://${uri}`;
        if (isTauriRuntime()) {
            try {
                await invoke('open_path', { path: uri });
                return;
            } catch (error) {
                void logWarn('Failed to open attachment', {
                    scope: 'attachment',
                    extra: { error: error instanceof Error ? error.message : String(error) },
                });
                const message = error instanceof Error ? error.message : String(error);
                setAttachmentError(message || t('attachments.fileNotSupported'));
            }
        }
        window.open(normalized, '_blank');
    }, [t]);

    const closeAudio = useCallback(() => {
        audioLoadRequestRef.current += 1;
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
        }
        setAudioAttachment(null);
        setAudioSource(null);
        setAudioError(null);
        setAudioTranscribing(false);
        setAudioTranscriptionError(null);
        if (audioObjectUrlRef.current) {
            URL.revokeObjectURL(audioObjectUrlRef.current);
            audioObjectUrlRef.current = null;
        }
    }, []);

    const closeImage = useCallback(() => {
        setImageAttachment(null);
        setImageSource(null);
    }, []);

    const closeText = useCallback(() => {
        setTextAttachment(null);
        setTextContent('');
        setTextError(null);
        setTextLoading(false);
    }, []);

    const openAudioExternally = useCallback(() => {
        if (!audioAttachment) return;
        void openExternal(audioAttachment.uri);
    }, [audioAttachment, openExternal]);

    const handleAudioError = useCallback(() => {
        const code = audioRef.current?.error?.code;
        const message = code === 1
            ? 'Audio playback aborted.'
            : code === 2
                ? 'Network error while loading audio.'
                : code === 3
                    ? 'Audio decoding failed.'
                    : code === 4
                        ? 'Audio format not supported.'
                        : 'Audio playback failed.';
        setAudioError(message);
    }, []);

    const retryAudioTranscription = useCallback(async () => {
        const currentAttachment = audioAttachment;
        if (!currentAttachment || audioTranscribing) return;

        setAudioTranscribing(true);
        setAudioTranscriptionError(null);
        try {
            const {
                tasks: currentTasks,
                projects: currentProjects,
                addProject: addProjectNow,
                updateTask: updateTaskNow,
                settings: currentSettings,
            } = useTaskStore.getState();
            const existing = currentTasks.find((item) => item.id === task.id);
            if (!existing) {
                throw new Error(resolveText('attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
            }

            const speech = currentSettings.ai?.speechToText;
            if (!speech?.enabled) {
                throw new Error(resolveText('attachments.transcriptionUnavailable', 'Speech-to-text is not ready. Check your AI settings and try again.'));
            }

            const provider = speech.provider ?? 'gemini';
            const model = speech.model ?? (
                provider === 'openai' ? 'gpt-4o-transcribe'
                    : provider === 'gemini' ? 'gemini-2.5-flash'
                        : DEFAULT_WHISPER_MODEL
            );
            const apiKey = provider === 'whisper' ? '' : await loadAIKey(provider).catch(() => '');
            const modelPath = provider === 'whisper' ? speech.offlineModelPath : undefined;
            const speechReady = provider === 'whisper' ? Boolean(modelPath) : Boolean(apiKey);
            if (!speechReady) {
                throw new Error(resolveText('attachments.transcriptionUnavailable', 'Speech-to-text is not ready. Check your AI settings and try again.'));
            }

            const { bytes, path } = await readAttachmentBytes(currentAttachment);
            const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : undefined;
            const result = await processAudioCapture(
                {
                    bytes,
                    mimeType: currentAttachment.mimeType || 'audio/wav',
                    name: currentAttachment.title || 'audio.wav',
                    path,
                },
                {
                    provider,
                    apiKey,
                    model,
                    modelPath,
                    language: speech.language,
                    mode: speech.mode ?? 'smart_parse',
                    fieldStrategy: speech.fieldStrategy ?? 'smart',
                    parseModel: provider === 'openai' && currentSettings.ai?.provider === 'openai' ? currentSettings.ai?.model : undefined,
                    now: new Date(),
                    timeZone,
                },
            );

            const { updates, suggestedProjectTitle } = buildTaskUpdatesFromSpeechResult(existing, result, currentSettings);
            if (suggestedProjectTitle && !existing.projectId) {
                const match = currentProjects.find((project) => project.title.toLowerCase() === suggestedProjectTitle.toLowerCase());
                if (match) {
                    updates.projectId = match.id;
                } else {
                    const created = await addProjectNow(suggestedProjectTitle, DEFAULT_PROJECT_COLOR);
                    if (!created) {
                        throw new Error(resolveText('attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
                    }
                    updates.projectId = created.id;
                }
            }

            if (Object.keys(updates).length > 0) {
                await updateTaskNow(task.id, updates);
            }
            closeAudio();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAudioTranscriptionError(message || resolveText('attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
        } finally {
            setAudioTranscribing(false);
        }
    }, [audioAttachment, audioTranscribing, closeAudio, readAttachmentBytes, resolveText, task.id]);

    const openTextExternally = useCallback(() => {
        if (!textAttachment) return;
        void openExternal(textAttachment.uri);
    }, [textAttachment, openExternal]);

    const openImageExternally = useCallback(() => {
        if (!imageAttachment) return;
        void openExternal(imageAttachment.uri);
    }, [imageAttachment, openExternal]);

    useEffect(() => {
        if (!audioAttachment && !imageAttachment && !textAttachment) return;
        const handler = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (audioAttachment) closeAudio();
            if (imageAttachment) closeImage();
            if (textAttachment) closeText();
        };
        window.addEventListener('keydown', handler);
        return () => {
            window.removeEventListener('keydown', handler);
        };
    }, [audioAttachment, closeAudio, closeImage, closeText, imageAttachment, textAttachment]);

    const openAttachment = useCallback((attachment: Attachment) => {
        if (isAudioAttachment(attachment)) {
            const requestId = audioLoadRequestRef.current + 1;
            audioLoadRequestRef.current = requestId;
            setAudioAttachment(attachment);
            setAudioError(null);
            setAudioTranscriptionError(null);
            void resolveAudioBlobSource(attachment).then((blobUrl) => {
                if (audioLoadRequestRef.current !== requestId) {
                    if (blobUrl) URL.revokeObjectURL(blobUrl);
                    return;
                }
                if (blobUrl) {
                    if (audioObjectUrlRef.current) {
                        URL.revokeObjectURL(audioObjectUrlRef.current);
                    }
                    audioObjectUrlRef.current = blobUrl;
                    setAudioSource(blobUrl);
                } else {
                    if (audioObjectUrlRef.current) {
                        URL.revokeObjectURL(audioObjectUrlRef.current);
                        audioObjectUrlRef.current = null;
                    }
                    setAudioSource(resolveAttachmentSource(attachment.uri));
                }
            });
            return;
        }
        if (isTextAttachment(attachment)) {
            setTextAttachment(attachment);
            setTextError(null);
            setTextLoading(true);
            void loadTextAttachment(attachment)
                .then((content) => {
                    setTextContent(content);
                })
                .catch((error) => {
                    void logWarn('Failed to read text attachment', {
                        scope: 'attachment',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                    const message = error instanceof Error ? error.message : String(error);
                    setTextError(message || t('attachments.fileNotSupported'));
                })
                .finally(() => {
                    setTextLoading(false);
                });
            return;
        }
        if (isImageAttachment(attachment)) {
            setImageAttachment(attachment);
            setImageSource(resolveAttachmentSource(attachment.uri));
            return;
        }
        void openExternal(attachment.uri);
    }, [loadTextAttachment, openExternal, resolveAudioBlobSource, t]);

    useEffect(() => {
        return () => {
            audioLoadRequestRef.current += 1;
            if (audioObjectUrlRef.current) {
                URL.revokeObjectURL(audioObjectUrlRef.current);
                audioObjectUrlRef.current = null;
            }
        };
    }, []);

    const addFileAttachment = useCallback(async () => {
        if (!isTauriRuntime()) {
            setAttachmentError(t('attachments.fileNotSupported'));
            return;
        }
        setAttachmentError(null);
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
            multiple: false,
            directory: false,
            title: t('attachments.addFile'),
        });
        if (!selected || typeof selected !== 'string') return;
        try {
            const fileSize = await size(selected);
            const validation = await validateAttachmentForUpload(
                {
                    id: 'pending',
                    kind: 'file',
                    title: selected.split(/[/\\]/).pop() || selected,
                    uri: selected,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                fileSize
            );
            if (!validation.valid) {
                setAttachmentError(resolveValidationMessage(validation.error));
                return;
            }
        } catch (error) {
            void logWarn('Failed to validate attachment size', {
                scope: 'attachment',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
        const now = new Date().toISOString();
        const title = selected.split(/[/\\]/).pop() || selected;
        const attachment: Attachment = {
            id: generateUUID(),
            kind: 'file',
            title,
            uri: selected,
            createdAt: now,
            updatedAt: now,
        };
        setEditAttachments((prev) => [...prev, attachment]);
    }, [resolveValidationMessage, t]);

    const addLinkAttachment = useCallback(() => {
        setAttachmentError(null);
        setShowLinkPrompt(true);
    }, []);

    const handleAddLinkAttachment = useCallback((value: string) => {
        const normalized = normalizeAttachmentInput(value);
        if (!normalized.uri) return false;
        const now = new Date().toISOString();
        const attachment: Attachment = {
            id: generateUUID(),
            kind: normalized.kind,
            title: normalized.title,
            uri: normalized.uri,
            createdAt: now,
            updatedAt: now,
        };
        setEditAttachments((prev) => [...prev, attachment]);
        return true;
    }, []);

    const removeAttachment = useCallback((id: string) => {
        const now = new Date().toISOString();
        setEditAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, deletedAt: now, updatedAt: now } : a))
        );
    }, []);

    const resetAttachmentState = useCallback((attachments: Attachment[] | undefined) => {
        setEditAttachments(attachments || []);
        setAttachmentError(null);
        setShowLinkPrompt(false);
        closeAudio();
        closeImage();
        closeText();
    }, [closeAudio, closeImage, closeText]);

    return {
        editAttachments,
        setEditAttachments,
        attachmentError,
        setAttachmentError,
        showLinkPrompt,
        setShowLinkPrompt,
        addFileAttachment,
        addLinkAttachment,
        handleAddLinkAttachment,
        removeAttachment,
        openAttachment,
        resetAttachmentState,
        audioAttachment,
        audioSource,
        audioError,
        audioTranscribing,
        audioTranscriptionError,
        audioRef,
        openAudioExternally,
        handleAudioError,
        retryAudioTranscription,
        closeAudio,
        imageAttachment,
        imageSource,
        closeImage,
        textAttachment,
        textContent,
        textError,
        textLoading,
        openTextExternally,
        openImageExternally,
        closeText,
    };
}
