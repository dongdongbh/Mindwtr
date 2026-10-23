import { isUpNoteHref, showExternalLinkFailure } from '../../../lib/external-link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isSandboxMode, updateProjectFromLatest, useTaskStore, type Attachment, type Project } from '@mindwtr/core';
import { importPickedFileAttachment, pickFolderLinkAttachment } from '../../../lib/attachment-import';
import { openAttachmentTarget } from '../../../lib/open-attachment-target';
import { isTauriRuntime } from '../../../lib/runtime';
import { logWarn } from '../../../lib/app-log';

type UseProjectAttachmentActionsParams = {
    t: (key: string) => string;
    selectedProject: Project | undefined;
    readOnly?: boolean;
};

// Attachment writes are built on the project row as it is when the write is admitted, so an attachment a sync save
// brought meanwhile is kept. An archived project is never written.
export const appendProjectAttachments = (projectId: string, added: Attachment[]) => updateProjectFromLatest(projectId, (latest) => (
    latest.status === 'archived' ? null : { attachments: [...(latest.attachments || []), ...added] }
));

export function useProjectAttachmentActions({
    t,
    selectedProject,
    readOnly = false,
}: UseProjectAttachmentActionsParams) {
    const sandboxMode = isSandboxMode();
    const selectedProjectRef = useRef(selectedProject);
    selectedProjectRef.current = selectedProject;
    const readOnlyRef = useRef(readOnly);
    readOnlyRef.current = readOnly;
    const [attachmentError, setAttachmentError] = useState<string | null>(null);
    const [showLinkPrompt, setShowLinkPrompt] = useState(false);
    const [isProjectAttachmentBusy, setIsProjectAttachmentBusy] = useState(false);

    useEffect(() => {
        setAttachmentError(null);
    }, [selectedProject?.id]);

    useEffect(() => {
        if (readOnly) setShowLinkPrompt(false);
    }, [readOnly]);

    const getMutableProject = useCallback((expectedId?: string) => {
        const current = selectedProjectRef.current;
        if (!current || readOnlyRef.current || current.status === 'archived') return null;
        if (expectedId && current.id !== expectedId) return null;
        const stored = useTaskStore.getState()._allProjects?.find((project) => project.id === current.id);
        if (stored?.status === 'archived') return null;
        return current;
    }, []);

    const openAttachment = useCallback(async (attachment: Attachment) => {
        if (sandboxMode) {
            setAttachmentError(t('sandbox.unavailable'));
            return;
        }
        try {
            // The id lets the native side find a file's managed copy, or a
            // folder link's device-local bookmark on the App Store build.
            await openAttachmentTarget(attachment.uri, attachment.id);
        } catch (error) {
            if (isUpNoteHref(attachment.uri)) {
                setAttachmentError(showExternalLinkFailure(attachment.uri, t));
                return;
            }
            void logWarn('Failed to open attachment', {
                scope: 'attachment',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
            const message = error instanceof Error ? error.message : String(error);
            setAttachmentError(message || t('attachments.fileNotSupported'));
        }
    }, [sandboxMode, t]);

    const addProjectFileAttachment = useCallback(async () => {
        if (sandboxMode) {
            setAttachmentError(t('sandbox.unavailable'));
            return;
        }
        const projectAtStart = getMutableProject();
        if (!projectAtStart) return;
        if (isProjectAttachmentBusy) return;
        if (!isTauriRuntime()) {
            setAttachmentError(t('attachments.webProjectUploadUnsupported'));
            return;
        }
        setIsProjectAttachmentBusy(true);
        setAttachmentError(null);
        try {
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
            const current = getMutableProject(projectAtStart.id);
            if (!current) return;
            void appendProjectAttachments(current.id, [result.attachment]);
        } finally {
            setIsProjectAttachmentBusy(false);
        }
    }, [getMutableProject, isProjectAttachmentBusy, sandboxMode, t]);

    const addProjectLinkAttachment = useCallback(() => {
        if (sandboxMode) {
            setAttachmentError(t('sandbox.unavailable'));
            return;
        }
        if (!getMutableProject()) return;
        setAttachmentError(null);
        setShowLinkPrompt(true);
    }, [getMutableProject, sandboxMode, t]);

    const addProjectFolderLinkAttachment = useCallback(async () => {
        if (sandboxMode) {
            setAttachmentError(t('sandbox.unavailable'));
            return;
        }
        const projectAtStart = getMutableProject();
        if (!projectAtStart || isProjectAttachmentBusy || !isTauriRuntime()) return;
        setIsProjectAttachmentBusy(true);
        setAttachmentError(null);
        try {
            const attachment = await pickFolderLinkAttachment(t('attachments.linkFolder'));
            if (!attachment) return;
            const current = getMutableProject(projectAtStart.id);
            if (!current) return;
            void appendProjectAttachments(current.id, [attachment]);
        } finally {
            setIsProjectAttachmentBusy(false);
        }
    }, [getMutableProject, isProjectAttachmentBusy, sandboxMode, t]);

    const removeProjectAttachment = useCallback((id: string) => {
        const current = getMutableProject();
        if (!current) return;
        const now = new Date().toISOString();
        void updateProjectFromLatest(current.id, (latest) => {
            const attachments = latest.attachments || [];
            if (latest.status === 'archived' || !attachments.some((attachment) => attachment.id === id)) return null;
            return {
                attachments: attachments.map((attachment) =>
                    attachment.id === id ? { ...attachment, deletedAt: now, updatedAt: now } : attachment
                ),
            };
        });
    }, [getMutableProject]);

    return {
        attachmentError,
        setAttachmentError,
        showLinkPrompt,
        setShowLinkPrompt,
        isProjectAttachmentBusy,
        openAttachment,
        addProjectFileAttachment,
        addProjectLinkAttachment,
        addProjectFolderLinkAttachment,
        removeProjectAttachment,
    };
}
