import { useCallback, useEffect, useRef, useState } from 'react';
import { useTaskStore, type Attachment, type Project } from '@mindwtr/core';
import { importPickedFileAttachment } from '../../../lib/attachment-import';
import { openAttachmentTarget } from '../../../lib/open-attachment-target';
import { isTauriRuntime } from '../../../lib/runtime';
import { logWarn } from '../../../lib/app-log';

type UseProjectAttachmentActionsParams = {
    t: (key: string) => string;
    selectedProject: Project | undefined;
    readOnly?: boolean;
    updateProject: (projectId: string, updates: Partial<Project>) => void;
};

export function useProjectAttachmentActions({
    t,
    selectedProject,
    readOnly = false,
    updateProject,
}: UseProjectAttachmentActionsParams) {
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
        try {
            await openAttachmentTarget(
                attachment.uri,
                attachment.kind === 'file' ? attachment.id : undefined,
            );
        } catch (error) {
            void logWarn('Failed to open attachment', {
                scope: 'attachment',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
            const message = error instanceof Error ? error.message : String(error);
            setAttachmentError(message || t('attachments.fileNotSupported'));
        }
    }, [t]);

    const addProjectFileAttachment = useCallback(async () => {
        const projectAtStart = getMutableProject();
        if (!projectAtStart) return;
        if (isProjectAttachmentBusy) return;
        if (!isTauriRuntime()) {
            setAttachmentError(t('attachments.fileNotSupported'));
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
            updateProject(current.id, { attachments: [...(current.attachments || []), result.attachment] });
        } finally {
            setIsProjectAttachmentBusy(false);
        }
    }, [getMutableProject, isProjectAttachmentBusy, t, updateProject]);

    const addProjectLinkAttachment = useCallback(() => {
        if (!getMutableProject()) return;
        setAttachmentError(null);
        setShowLinkPrompt(true);
    }, [getMutableProject]);

    const removeProjectAttachment = useCallback((id: string) => {
        const current = getMutableProject();
        if (!current) return;
        const now = new Date().toISOString();
        const next = (current.attachments || []).map((attachment) =>
            attachment.id === id ? { ...attachment, deletedAt: now, updatedAt: now } : attachment
        );
        updateProject(current.id, { attachments: next });
    }, [getMutableProject, updateProject]);

    return {
        attachmentError,
        setAttachmentError,
        showLinkPrompt,
        setShowLinkPrompt,
        isProjectAttachmentBusy,
        openAttachment,
        addProjectFileAttachment,
        addProjectLinkAttachment,
        removeProjectAttachment,
    };
}
