import { useCallback } from 'react';
import type { Project, Section } from '@mindwtr/core';
import type { ConfirmationRequestOptions } from '../../../hooks/useConfirmDialog';

type UseProjectSectionActionsParams = {
    t: (key: string) => string;
    selectedProject: Project | undefined;
    setEditingSectionId: (id: string | null) => void;
    setSectionDraft: (value: string) => void;
    setShowSectionPrompt: (value: boolean) => void;
    deleteSection: (id: string) => void;
    updateSection: (id: string, updates: Partial<Section>) => void;
    setSectionNotesOpen: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
    setSectionTaskTargetId: (value: string | null) => void;
    setSectionTaskDraft: (value: string) => void;
    setShowSectionTaskPrompt: (value: boolean) => void;
    requestConfirmation: (options: ConfirmationRequestOptions) => Promise<boolean>;
};

export function useProjectSectionActions({
    t,
    selectedProject,
    setEditingSectionId,
    setSectionDraft,
    setShowSectionPrompt,
    deleteSection,
    updateSection,
    setSectionNotesOpen,
    setSectionTaskTargetId,
    setSectionTaskDraft,
    setShowSectionTaskPrompt,
    requestConfirmation,
}: UseProjectSectionActionsParams) {
    const handleAddSection = useCallback(() => {
        if (!selectedProject) return;
        setEditingSectionId(null);
        setSectionDraft('');
        setShowSectionPrompt(true);
    }, [selectedProject, setEditingSectionId, setSectionDraft, setShowSectionPrompt]);

    const handleRenameSection = useCallback((section: Section) => {
        setEditingSectionId(section.id);
        setSectionDraft(section.title);
        setShowSectionPrompt(true);
    }, [setEditingSectionId, setSectionDraft, setShowSectionPrompt]);

    const handleDeleteSection = useCallback(async (section: Section) => {
        const confirmed = await requestConfirmation({
            title: t('projects.sectionsLabel'),
            description: t('projects.deleteSectionConfirm'),
            confirmLabel: t('common.delete') || 'Delete',
            cancelLabel: t('common.cancel') || 'Cancel',
        });
        if (confirmed) {
            deleteSection(section.id);
        }
    }, [deleteSection, requestConfirmation, t]);

    const handleToggleSection = useCallback((section: Section) => {
        updateSection(section.id, { isCollapsed: !section.isCollapsed });
    }, [updateSection]);

    const handleToggleSectionNotes = useCallback((sectionId: string) => {
        setSectionNotesOpen((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
    }, [setSectionNotesOpen]);

    const handleOpenSectionTaskPrompt = useCallback((sectionId: string) => {
        setSectionTaskTargetId(sectionId);
        setSectionTaskDraft('');
        setShowSectionTaskPrompt(true);
    }, [setSectionTaskDraft, setSectionTaskTargetId, setShowSectionTaskPrompt]);

    return {
        handleAddSection,
        handleRenameSection,
        handleDeleteSection,
        handleToggleSection,
        handleToggleSectionNotes,
        handleOpenSectionTaskPrompt,
    };
}
