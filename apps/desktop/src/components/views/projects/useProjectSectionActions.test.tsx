import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Project, Section } from '@mindwtr/core';
import { useProjectSectionActions } from './useProjectSectionActions';

const baseSection: Section = {
    id: 'section-1',
    projectId: 'project-1',
    title: 'Section 1',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};

const baseProject: Project = {
    id: 'project-1',
    title: 'Project 1',
    status: 'active',
    color: '#94a3b8',
    order: 0,
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('useProjectSectionActions', () => {
    beforeEach(() => {
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const setup = (overrides?: Partial<Parameters<typeof useProjectSectionActions>[0]>) => {
        const params: Parameters<typeof useProjectSectionActions>[0] = {
            t: (key) => key,
            selectedProject: baseProject,
            setEditingSectionId: vi.fn(),
            setSectionDraft: vi.fn(),
            setShowSectionPrompt: vi.fn(),
            deleteSection: vi.fn(),
            updateSection: vi.fn(),
            setSectionNotesOpen: vi.fn(),
            setSectionTaskTargetId: vi.fn(),
            setSectionTaskDraft: vi.fn(),
            setShowSectionTaskPrompt: vi.fn(),
            requestConfirmation: vi.fn(async () => true),
            ...overrides,
        };

        const hook = renderHook(() => useProjectSectionActions(params));
        return { hook, params };
    };

    it('does not delete section when confirmation is cancelled', async () => {
        const requestConfirmation = vi.fn(async () => false);
        const { hook, params } = setup({ requestConfirmation });

        await act(async () => {
            await hook.result.current.handleDeleteSection(baseSection);
        });

        expect(requestConfirmation).toHaveBeenCalledWith({
            title: 'projects.sectionsLabel',
            description: 'projects.deleteSectionConfirm',
            confirmLabel: 'common.delete',
            cancelLabel: 'common.cancel',
        });
        expect(params.deleteSection).not.toHaveBeenCalled();
    });

    it('deletes section when confirmation is accepted', async () => {
        const { hook, params } = setup();

        await act(async () => {
            await hook.result.current.handleDeleteSection(baseSection);
        });

        expect(params.deleteSection).toHaveBeenCalledWith(baseSection.id);
    });

    it('opens add section prompt only when a project is selected', () => {
        const withoutProject = setup({ selectedProject: undefined });
        act(() => {
            withoutProject.hook.result.current.handleAddSection();
        });
        expect(withoutProject.params.setShowSectionPrompt).not.toHaveBeenCalled();

        const withProject = setup({ selectedProject: baseProject });
        act(() => {
            withProject.hook.result.current.handleAddSection();
        });
        expect(withProject.params.setEditingSectionId).toHaveBeenCalledWith(null);
        expect(withProject.params.setSectionDraft).toHaveBeenCalledWith('');
        expect(withProject.params.setShowSectionPrompt).toHaveBeenCalledWith(true);
    });
});
