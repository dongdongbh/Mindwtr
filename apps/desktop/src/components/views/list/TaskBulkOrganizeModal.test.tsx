import { fireEvent, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Project, Section } from '@mindwtr/core';

import { LanguageProvider } from '../../../contexts/language-context';
import { TaskBulkOrganizeModal } from './TaskBulkOrganizeModal';

const t = (key: string) => key;

const project: Project = {
    id: 'project-1',
    title: 'Launch',
    color: '#3b82f6',
    order: 0,
    status: 'active',
    tagIds: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
};

const otherProject: Project = { ...project, id: 'project-2', title: 'Rewrite' };

const section: Section = {
    id: 'section-1',
    projectId: project.id,
    title: 'Planning',
    order: 0,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
};

type Props = ComponentProps<typeof TaskBulkOrganizeModal>;

const renderModal = (overrides: Partial<Props> = {}) => {
    const onApply = vi.fn();
    const result = render(
        <LanguageProvider>
            <TaskBulkOrganizeModal
                isOpen
                selectedCount={2}
                projects={[project, otherProject]}
                areas={[]}
                isApplying={false}
                t={t}
                onApply={onApply}
                onCancel={vi.fn()}
                {...overrides}
            />
        </LanguageProvider>
    );
    return { ...result, onApply };
};

describe('TaskBulkOrganizeModal section picker', () => {
    it('hides the section picker outside a single-project scope', () => {
        const { queryByRole } = renderModal();
        expect(queryByRole('combobox', { name: 'Project section' })).toBeNull();
    });

    it('hides the section picker for a project without sections', () => {
        const { queryByRole } = renderModal({ sectionScope: { projectId: project.id, sections: [] } });
        expect(queryByRole('combobox', { name: 'Project section' })).toBeNull();
    });

    it('sends the chosen section with the project that owns it', () => {
        const { getByRole, onApply } = renderModal({
            sectionScope: { projectId: project.id, sections: [section] },
        });

        fireEvent.change(getByRole('combobox', { name: 'Project section' }), {
            target: { value: section.id },
        });
        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));

        expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
            sectionId: section.id,
            sectionProjectId: project.id,
        }));
    });

    it('sends a null section id when clearing the section', () => {
        const { getByRole, onApply } = renderModal({
            sectionScope: { projectId: project.id, sections: [section] },
        });

        fireEvent.change(getByRole('combobox', { name: 'Project section' }), {
            target: { value: '__NONE__' },
        });
        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));

        expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ sectionId: null }));
    });

    it('keeps the section out of the apply when the modal moves tasks to another project', () => {
        const { getByRole, onApply } = renderModal({
            sectionScope: { projectId: project.id, sections: [section] },
        });

        const sectionSelect = getByRole('combobox', { name: 'Project section' });
        fireEvent.change(sectionSelect, { target: { value: section.id } });
        fireEvent.change(getByRole('combobox', { name: 'Project' }), { target: { value: otherProject.id } });

        expect(sectionSelect).toBeDisabled();

        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));

        const input = onApply.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(input.projectId).toBe(otherProject.id);
        expect('sectionId' in input).toBe(false);
    });

    it('omits the section when nothing is picked', () => {
        const { getByRole, onApply } = renderModal({
            sectionScope: { projectId: project.id, sections: [section] },
        });

        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));

        expect('sectionId' in (onApply.mock.calls[0]?.[0] as Record<string, unknown>)).toBe(false);
    });
});
