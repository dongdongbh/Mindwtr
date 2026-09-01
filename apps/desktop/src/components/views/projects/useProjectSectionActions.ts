import { useCallback, useRef } from 'react';
import { tFallback, useTaskStore, type Project, type Section } from '@mindwtr/core';
import type { ConfirmationRequestOptions } from '../../../hooks/useConfirmDialog';

type UseProjectSectionActionsParams = {
    t: (key: string) => string;
    selectedProject: Project | undefined;
    readOnly?: boolean;
    setEditingSectionId: (id: string | null) => void;
    setSectionDraft: (value: string) => void;
    setShowSectionPrompt: (value: boolean) => void;
    deleteSection: (id: string) => void;
    updateSection: (id: string, updates: Partial<Section>) => void;
    setSectionNotesOpen: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
    requestConfirmation: (options: ConfirmationRequestOptions) => Promise<boolean>;
};

export function useProjectSectionActions({
    t,
    selectedProject,
    readOnly = false,
    setEditingSectionId,
    setSectionDraft,
    setShowSectionPrompt,
    deleteSection,
    updateSection,
    setSectionNotesOpen,
    requestConfirmation,
}: UseProjectSectionActionsParams) {
    const selectedProjectRef = useRef(selectedProject);
    selectedProjectRef.current = selectedProject;
    const readOnlyRef = useRef(readOnly);
    readOnlyRef.current = readOnly;
    const isReadOnly = useCallback(() => {
        const current = selectedProjectRef.current;
        if (!current || readOnlyRef.current || current.status === 'archived') return true;
        return useTaskStore.getState()._allProjects?.find((project) => project.id === current.id)?.status === 'archived';
    }, []);

    const handleAddSection = useCallback(() => {
        if (isReadOnly()) return;
        setEditingSectionId(null);
        setSectionDraft('');
        setShowSectionPrompt(true);
    }, [isReadOnly, setEditingSectionId, setSectionDraft, setShowSectionPrompt]);

    const handleRenameSection = useCallback((section: Section) => {
        if (isReadOnly()) return;
        setEditingSectionId(section.id);
        setSectionDraft(section.title);
        setShowSectionPrompt(true);
    }, [isReadOnly, setEditingSectionId, setSectionDraft, setShowSectionPrompt]);

    const handleDeleteSection = useCallback(async (section: Section) => {
        if (isReadOnly()) return;
        const confirmed = await requestConfirmation({
            title: t('projects.sectionsLabel'),
            description: t('projects.deleteSectionConfirm'),
            confirmLabel: tFallback(t, 'common.delete', 'Delete'),
            cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
        });
        if (confirmed && !isReadOnly()) {
            deleteSection(section.id);
        }
    }, [deleteSection, isReadOnly, requestConfirmation, t]);

    const handleToggleSection = useCallback((section: Section) => {
        if (isReadOnly()) return;
        updateSection(section.id, { isCollapsed: !section.isCollapsed });
    }, [isReadOnly, updateSection]);

    const handleToggleSectionNotes = useCallback((sectionId: string) => {
        setSectionNotesOpen((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
    }, [setSectionNotesOpen]);

    return {
        handleAddSection,
        handleRenameSection,
        handleDeleteSection,
        handleToggleSection,
        handleToggleSectionNotes,
    };
}
