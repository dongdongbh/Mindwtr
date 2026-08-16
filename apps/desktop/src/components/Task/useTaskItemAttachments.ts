import { useCallback, useEffect, useRef, useState } from 'react';
import { Attachment, DEFAULT_PROJECT_COLOR, buildTaskUpdatesFromSpeechResult, findSelectableProjectByTitleAndArea, generateUUID, normalizeLinkAttachmentInput, translateWithFallback, useTaskStore, type Task } from '@mindwtr/core';
import { dataDir } from '@tauri-apps/api/path';
import { BaseDirectory, readFile, readTextFile } from '@tauri-apps/plugin-fs';
import { importDroppedFileAttachment, importPickedFileAttachment } from '../../lib/attachment-import';
import { normalizeAttachmentPathForUrl, resolveAttachmentReadPath } from '../../lib/attachment-paths';
import { normalizeAttachmentInput } from '../../lib/attachment-utils';
import { openAttachmentTarget } from '../../lib/open-attachment-target';
import { isTauriRuntime } from '../../lib/runtime';
import { logWarn } from '../../lib/app-log';
import { getManagedDataDir, getManagedPath } from '../../lib/managed-paths';
import { ATTACHMENTS_DIR_NAME } from '../../lib/sync-service-utils';
import { processAudioCapture, resolveSpeechCapture } from '../../lib/speech-to-text';
import {
    isAudioAttachment,
    isImageAttachment,
    isTextAttachment,
    resolveAttachmentSource,
} from './task-item-attachment-utils';

type LinkPromptVariant = 'link' | 'obsidian';

type UseTaskItemAttachmentsProps = {
    task: Task;
    t: (key: string) => string;
};

// addFileAttachment/addDroppedFileAttachments copy bytes into the managed
// attachments dir immediately, but the attachment *record* only lives in
// editor-local state until Save — cancelling (or reopening the editor)
// discards records added since the last save and orphans their files.
// Delete only what's provably ours: a `kind: 'file'` attachment whose uri
// sits inside the managed attachments dir. Never touch `kind: 'link'`
// (points at the user's own file) or a uri outside that dir (legacy
// path-referencing attachments). Best-effort — failures are logged, never
// thrown, so they can't block the reset.
const deleteOrphanedAttachmentFiles = async (orphaned: Attachment[]): Promise<void> => {
    if (!isTauriRuntime()) return;
    const fileOrphans = orphaned.filter((a) => a.kind === 'file');
    if (fileOrphans.length === 0) return;
    try {
        const managedDir = normalizeAttachmentPathForUrl(await getManagedPath(ATTACHMENTS_DIR_NAME));
        const managedDirPrefix = `${managedDir}/`;
        const { remove } = await import('@tauri-apps/plugin-fs');
        for (const attachment of fileOrphans) {
            // A bare `startsWith(managedDir)` would also match a sibling
            // directory that merely shares the prefix (e.g. `attachments-old/`)
            // — require the path separator so only files actually inside the
            // managed dir are "provably ours" to delete.
            if (!normalizeAttachmentPathForUrl(attachment.uri).startsWith(managedDirPrefix)) continue;
            try {
                await remove(attachment.uri);
            } catch (error) {
                void logWarn('Failed to delete orphaned attachment file', {
                    scope: 'attachment',
                    extra: { error: error instanceof Error ? error.message : String(error) },
                });
            }
        }
    } catch (error) {
        void logWarn('Failed to resolve managed attachments dir for cleanup', {
            scope: 'attachment',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
};

export function useTaskItemAttachments({ task, t }: UseTaskItemAttachmentsProps) {
    const [editAttachments, setEditAttachments] = useState<Attachment[]>(task.attachments || []);
    // Mirrors editAttachments for resetAttachmentState (a useCallback) to read
    // the latest value without depending on it — StrictMode double-invokes a
    // setEditAttachments updater, which would run the orphan-file delete twice.
    const editAttachmentsRef = useRef(editAttachments);
    editAttachmentsRef.current = editAttachments;
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
    const [editingLinkAttachmentId, setEditingLinkAttachmentId] = useState<string | null>(null);
    const [linkPromptDefaultValue, setLinkPromptDefaultValue] = useState('');
    const [linkPromptVariant, setLinkPromptVariant] = useState<LinkPromptVariant>('link');
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioLoadRequestRef = useRef(0);
    const audioObjectUrlRef = useRef<string | null>(null);

    const resolveText = useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);

    const resolveAudioBlobSource = useCallback(async (attachment: Attachment) => {
        if (!isTauriRuntime()) return null;
        const uri = await resolveAttachmentReadPath(attachment.uri);
        try {
            // Blob playback is limited to app-managed files (attachments and
            // audio captures under the managed data dir, portable-aware).
            const managedDir = await getManagedDataDir();
            const normalizedUri = normalizeAttachmentPathForUrl(uri);
            const normalizedBaseDir = normalizeAttachmentPathForUrl(managedDir);
            if (!normalizedUri.startsWith(normalizedBaseDir)) return null;
            const bytes = await readFile(normalizedUri);
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
        const uri = await resolveAttachmentReadPath(attachment.uri);
        if (/^https?:\/\//i.test(uri)) {
            throw new Error(resolveText('attachments.fileNotSupported', 'File not supported.'));
        }
        const base = await dataDir();
        const normalizedUri = normalizeAttachmentPathForUrl(uri);
        const normalizedBase = normalizeAttachmentPathForUrl(base);
        if (normalizedUri.startsWith(normalizedBase)) {
            const relative = normalizedUri.slice(normalizedBase.length).replace(/^[\\/]/, '');
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
        const uri = await resolveAttachmentReadPath(attachment.uri);
        if (/^https?:\/\//i.test(uri)) {
            throw new Error(t('attachments.fileNotSupported'));
        }
        const base = await dataDir();
        const normalizedUri = normalizeAttachmentPathForUrl(uri);
        const normalizedBase = normalizeAttachmentPathForUrl(base);
        if (normalizedUri.startsWith(normalizedBase)) {
            const relative = normalizedUri.slice(normalizedBase.length).replace(/^[\\/]/, '');
            return await readTextFile(relative, { baseDir: BaseDirectory.Data });
        }
        return await readTextFile(uri);
    }, [t]);

    const openExternal = useCallback(async (uri: string) => {
        setAttachmentError(null);
        try {
            await openAttachmentTarget(uri);
        } catch (error) {
            void logWarn('Failed to open attachment', {
                scope: 'attachment',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
            const message = error instanceof Error ? error.message : String(error);
            setAttachmentError(message || t('attachments.fileNotSupported'));
        }
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

            const { ready: speechReady, config: speechConfig } = await resolveSpeechCapture(currentSettings.ai);
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
                    ...speechConfig,
                    now: new Date(),
                    timeZone,
                },
            );

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
        if (attachment.kind === 'link') {
            void openExternal(attachment.uri);
            return;
        }
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
        const result = await importPickedFileAttachment(selected);
        if ('errorKey' in result) {
            setAttachmentError(t(result.errorKey));
            return;
        }
        setEditAttachments((prev) => [...prev, result.attachment]);
    }, [t]);

    // Attachments stay in editor-local state until the task is saved, same
    // as addFileAttachment above; removing a chip before saving is the undo.
    const addDroppedFileAttachments = useCallback(async (files: File[]) => {
        if (!isTauriRuntime()) {
            setAttachmentError(t('attachments.fileNotSupported'));
            return;
        }
        setAttachmentError(null);
        let firstErrorKey: string | null = null;
        for (const file of files) {
            const result = await importDroppedFileAttachment(file);
            if ('errorKey' in result) {
                firstErrorKey ??= result.errorKey;
                continue;
            }
            setEditAttachments((prev) => [...prev, result.attachment]);
        }
        if (firstErrorKey) setAttachmentError(t(firstErrorKey));
    }, [t]);

    const addLinkAttachment = useCallback(() => {
        setAttachmentError(null);
        setEditingLinkAttachmentId(null);
        setLinkPromptDefaultValue('');
        setLinkPromptVariant('link');
        setShowLinkPrompt(true);
    }, []);

    const addObsidianNoteAttachment = useCallback(() => {
        setAttachmentError(null);
        setEditingLinkAttachmentId(null);
        setLinkPromptDefaultValue('');
        setLinkPromptVariant('obsidian');
        setShowLinkPrompt(true);
    }, []);

    const handleAddLinkAttachment = useCallback((value: string) => {
        const normalized = editingLinkAttachmentId
            ? normalizeLinkAttachmentInput(value)
            : normalizeAttachmentInput(value);
        if (!normalized.uri) return false;
        const now = new Date().toISOString();
        if (editingLinkAttachmentId) {
            setEditAttachments((prev) => prev.map((attachment) => (
                attachment.id === editingLinkAttachmentId
                    ? {
                        ...attachment,
                        kind: 'link',
                        title: normalized.title,
                        uri: normalized.uri,
                        updatedAt: now,
                    }
                    : attachment
            )));
            return true;
        }
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
    }, [editingLinkAttachmentId]);

    const editLinkAttachment = useCallback((attachment: Attachment) => {
        if (attachment.kind !== 'link') return;
        setAttachmentError(null);
        setEditingLinkAttachmentId(attachment.id);
        setLinkPromptVariant('link');
        setLinkPromptDefaultValue(
            attachment.title && attachment.title !== attachment.uri
                ? `${attachment.title} | ${attachment.uri}`
                : attachment.uri,
        );
        setShowLinkPrompt(true);
    }, []);

    const closeLinkPrompt = useCallback(() => {
        setShowLinkPrompt(false);
        setEditingLinkAttachmentId(null);
        setLinkPromptDefaultValue('');
    }, []);

    const removeAttachment = useCallback((id: string) => {
        const now = new Date().toISOString();
        setEditAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, deletedAt: now, updatedAt: now } : a))
        );
    }, []);

    const resetAttachmentState = useCallback((attachments: Attachment[] | undefined) => {
        const nextList = attachments || [];
        const nextIds = new Set(nextList.map((a) => a.id));
        const orphaned = editAttachmentsRef.current.filter((a) => !nextIds.has(a.id));
        if (orphaned.length > 0) void deleteOrphanedAttachmentFiles(orphaned);
        setEditAttachments(nextList);
        setAttachmentError(null);
        closeLinkPrompt();
        closeAudio();
        closeImage();
        closeText();
    }, [closeAudio, closeImage, closeLinkPrompt, closeText]);

    return {
        editAttachments,
        setEditAttachments,
        attachmentError,
        setAttachmentError,
        showLinkPrompt,
        setShowLinkPrompt,
        editingLinkAttachmentId,
        linkPromptDefaultValue,
        linkPromptVariant,
        closeLinkPrompt,
        addFileAttachment,
        addDroppedFileAttachments,
        addLinkAttachment,
        addObsidianNoteAttachment,
        editLinkAttachment,
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
