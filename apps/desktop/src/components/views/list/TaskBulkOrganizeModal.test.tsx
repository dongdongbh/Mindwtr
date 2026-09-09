import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Area, Project, Section } from '@mindwtr/core';

import { LanguageProvider } from '../../../contexts/language-context';
import { TaskBulkOrganizeModal } from './TaskBulkOrganizeModal';

const { createAreaMock, createProjectMock, ensureDestinationSavedMock } = vi.hoisted(() => ({
    createAreaMock: vi.fn(),
    createProjectMock: vi.fn(),
    ensureDestinationSavedMock: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@mindwtr/core')>(),
    createBulkOrganizeArea: createAreaMock,
    createBulkOrganizeProject: createProjectMock,
    ensureBulkOrganizeDestinationSaved: ensureDestinationSavedMock,
}));

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

const area: Area = {
    id: 'area-1',
    name: 'Work',
    color: '#3b82f6',
    order: 0,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
};

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
    const onCancel = vi.fn();
    const renderWith = (nextOverrides: Partial<Props>) => (
        <LanguageProvider>
            <TaskBulkOrganizeModal
                isOpen
                selectedCount={2}
                projects={[project, otherProject]}
                areas={[]}
                isApplying={false}
                t={t}
                onApply={onApply}
                onCancel={onCancel}
                {...nextOverrides}
            />
        </LanguageProvider>
    );
    const result = render(renderWith(overrides));
    return {
        ...result,
        onApply,
        onCancel,
        rerenderModal: (nextOverrides: Partial<Props>) => result.rerender(renderWith({ ...overrides, ...nextOverrides })),
    };
};

function setInputValue(input: HTMLInputElement, value: string) {
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(input));
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    act(() => {
        if (nativeSetter) nativeSetter.call(input, value);
        else (input as any).value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe('TaskBulkOrganizeModal', () => {
    beforeEach(() => {
        createAreaMock.mockReset();
        createProjectMock.mockReset();
        ensureDestinationSavedMock.mockReset();
        ensureDestinationSavedMock.mockResolvedValue(undefined);
    });

    it('creates a project in the chosen explicit area without applying task changes', async () => {
        const createdProject = { ...project, id: 'created-project', title: 'New initiative', areaId: area.id };
        createProjectMock.mockResolvedValue(createdProject);
        const { getByLabelText, getByRole, onApply } = renderModal({ areas: [area] });

        const areaTrigger = getByRole('button', { name: 'Area' });
        fireEvent.click(areaTrigger);
        fireEvent.click(getByRole('option', { name: area.name }));
        await waitFor(() => expect(ensureDestinationSavedMock).toHaveBeenCalledOnce());
        fireEvent.change(getByLabelText('Tags'), { target: { value: '#launch' } });

        const projectTrigger = getByRole('button', { name: 'Project' });
        await waitFor(() => expect(projectTrigger).toBeEnabled());
        fireEvent.click(projectTrigger);
        const search = getByLabelText('Search projects') as HTMLInputElement;
        setInputValue(search, createdProject.title);
        fireEvent.click(getByRole('option', { name: `Create project "${createdProject.title}"` }));

        await waitFor(() => expect(createProjectMock).toHaveBeenCalledWith(createdProject.title, area.id));
        expect(onApply).not.toHaveBeenCalled();
        await waitFor(() => expect(projectTrigger).toHaveFocus());

        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));
        expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
            projectId: createdProject.id,
            tags: ['#launch'],
        }));
    });

    it('creates and selects an area without applying task changes first', async () => {
        const createdArea = { ...area, id: 'created-area', name: 'Errands' };
        createAreaMock.mockResolvedValue(createdArea);
        const { getByLabelText, getByRole, onApply } = renderModal({ areas: [area] });

        const areaTrigger = getByRole('button', { name: 'Area' });
        fireEvent.click(areaTrigger);
        const search = getByLabelText('Search areas') as HTMLInputElement;
        setInputValue(search, createdArea.name);
        fireEvent.click(getByRole('option', { name: `Create area "${createdArea.name}"` }));

        await waitFor(() => expect(createAreaMock).toHaveBeenCalledWith(createdArea.name));
        expect(onApply).not.toHaveBeenCalled();
        await waitFor(() => expect(areaTrigger).toHaveFocus());

        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));
        expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ areaId: createdArea.id }));
    });

    it('keeps Keep distinct from explicitly clearing project and area', () => {
        const { getByRole, onApply } = renderModal({ areas: [area] });

        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));
        let input = onApply.mock.calls[0]?.[0] as Record<string, unknown>;
        expect('projectId' in input).toBe(false);
        expect('areaId' in input).toBe(false);

        onApply.mockClear();
        fireEvent.click(getByRole('button', { name: 'Project' }));
        fireEvent.click(getByRole('option', { name: 'No project' }));
        fireEvent.click(getByRole('button', { name: 'Area' }));
        fireEvent.click(getByRole('option', { name: 'No area' }));
        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));

        input = onApply.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(input.projectId).toBeNull();
        expect(input.areaId).toBeNull();
    });

    it('shows the localized area error while retaining the create query', async () => {
        createAreaMock.mockRejectedValue(new Error('save failed'));
        const { getByLabelText, getByRole } = renderModal({ areas: [area] });

        fireEvent.click(getByRole('button', { name: 'Area' }));
        setInputValue(getByLabelText('Search areas') as HTMLInputElement, 'New area');
        fireEvent.click(getByRole('option', { name: 'Create area "New area"' }));

        expect(await waitFor(() => getByRole('alert'))).toHaveTextContent('Failed to create area');
        expect(getByLabelText('Search areas')).toHaveValue('New area');
    });

    it('shows a create error for null or rejection and keeps the project query open for retry', async () => {
        const createdProject = { ...project, id: 'retry-project', title: 'Retry project' };
        createProjectMock
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new Error('save failed'))
            .mockResolvedValueOnce(createdProject);
        const { getByLabelText, getByRole, onApply } = renderModal();

        fireEvent.click(getByRole('button', { name: 'Project' }));
        const search = getByLabelText('Search projects') as HTMLInputElement;
        setInputValue(search, createdProject.title);
        const createOptionName = `Create project "${createdProject.title}"`;
        fireEvent.click(getByRole('option', { name: createOptionName }));

        expect(await waitFor(() => getByRole('alert'))).toHaveTextContent('Failed to create project');
        expect(getByLabelText('Search projects')).toHaveValue(createdProject.title);
        expect(onApply).not.toHaveBeenCalled();

        fireEvent.click(getByRole('option', { name: createOptionName }));
        await waitFor(() => expect(createProjectMock).toHaveBeenCalledTimes(2));
        expect(getByRole('alert')).toHaveTextContent('Failed to create project');
        expect(getByLabelText('Search projects')).toHaveValue(createdProject.title);

        fireEvent.click(getByRole('option', { name: createOptionName }));
        await waitFor(() => expect(createProjectMock).toHaveBeenCalledTimes(3));
        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));
        expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ projectId: createdProject.id }));
    });

    it('does not select a failed-created project from store props until persistence retry succeeds', async () => {
        const failedCreatedProject = { ...project, id: 'failed-created-project', title: 'Recovered project' };
        createProjectMock.mockRejectedValue(new Error('save failed after store insert'));
        let resolveEnsure!: () => void;
        ensureDestinationSavedMock.mockImplementation(() => new Promise<void>((resolve) => {
            resolveEnsure = resolve;
        }));
        const { getByLabelText, getByRole, onApply, queryByRole, rerenderModal } = renderModal();

        fireEvent.click(getByRole('button', { name: 'Project' }));
        const search = getByLabelText('Search projects') as HTMLInputElement;
        setInputValue(search, failedCreatedProject.title);
        fireEvent.click(getByRole('option', { name: `Create project "${failedCreatedProject.title}"` }));
        await waitFor(() => expect(getByRole('alert')).toHaveTextContent('Failed to create project'));

        rerenderModal({ projects: [project, otherProject, failedCreatedProject] });
        expect(queryByRole('option', { name: `Create project "${failedCreatedProject.title}"` })).not.toBeInTheDocument();
        fireEvent.keyDown(search, { key: 'Enter' });

        expect(ensureDestinationSavedMock).toHaveBeenCalledOnce();
        expect(getByRole('button', { name: 'Project' })).toHaveTextContent('Keep project');
        expect(getByRole('button', { name: 'Apply to selected' })).toBeDisabled();
        expect(onApply).not.toHaveBeenCalled();

        resolveEnsure();
        await waitFor(() => expect(getByRole('button', { name: 'Apply to selected' })).toBeEnabled());
        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));
        expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ projectId: failedCreatedProject.id }));
    });

    it('does not select an existing area until its pending persistence is durable', async () => {
        let resolveEnsure!: () => void;
        ensureDestinationSavedMock.mockImplementation(() => new Promise<void>((resolve) => {
            resolveEnsure = resolve;
        }));
        const { getByRole, onApply } = renderModal({ areas: [area] });

        fireEvent.click(getByRole('button', { name: 'Area' }));
        fireEvent.click(getByRole('option', { name: area.name }));

        expect(ensureDestinationSavedMock).toHaveBeenCalledOnce();
        expect(getByRole('button', { name: 'Area' })).toHaveTextContent('Keep area');
        expect(getByRole('button', { name: 'Apply to selected' })).toBeDisabled();
        expect(onApply).not.toHaveBeenCalled();

        resolveEnsure();
        await waitFor(() => expect(getByRole('button', { name: 'Apply to selected' })).toBeEnabled());
        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));
        expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ areaId: area.id }));
    });

    it('keeps the prior destination and shows an error when durability retry fails', async () => {
        ensureDestinationSavedMock.mockRejectedValue(new Error('flush failed'));
        const { getByRole, onApply } = renderModal();

        fireEvent.click(getByRole('button', { name: 'Project' }));
        fireEvent.click(getByRole('option', { name: otherProject.title }));

        expect(await waitFor(() => getByRole('alert'))).toHaveTextContent('Failed to create project');
        expect(ensureDestinationSavedMock).toHaveBeenCalledOnce();
        expect(getByRole('button', { name: 'Project' })).toHaveTextContent('Keep project');

        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));
        expect('projectId' in (onApply.mock.calls[0]?.[0] as Record<string, unknown>)).toBe(false);
    });

    it('disables destination creation and repeated Apply while task changes are applying', () => {
        const { getByRole, onApply } = renderModal({ isApplying: true });

        expect(getByRole('button', { name: 'Project' })).toBeDisabled();
        expect(getByRole('button', { name: 'Area' })).toBeDisabled();
        expect(getByRole('button', { name: 'Apply to selected' })).toBeDisabled();
        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));
        expect(onApply).not.toHaveBeenCalled();
        expect(createProjectMock).not.toHaveBeenCalled();
        expect(createAreaMock).not.toHaveBeenCalled();
    });

    it('blocks duplicate creation, Apply, and dismissal while creation is pending', async () => {
        let resolveCreate!: (value: Project) => void;
        createProjectMock.mockImplementation(() => new Promise<Project>((resolve) => {
            resolveCreate = resolve;
        }));
        const { getByLabelText, getByRole, onApply, onCancel } = renderModal();

        fireEvent.click(getByRole('button', { name: 'Project' }));
        setInputValue(getByLabelText('Search projects') as HTMLInputElement, 'Slow project');
        const createOption = getByRole('option', { name: 'Create project "Slow project"' });
        fireEvent.click(createOption);
        fireEvent.click(createOption);

        expect(createProjectMock).toHaveBeenCalledTimes(1);
        expect(getByRole('button', { name: 'Close' })).toBeDisabled();
        expect(getByRole('button', { name: 'Cancel' })).toBeDisabled();
        expect(getByRole('button', { name: 'Apply to selected' })).toBeDisabled();
        expect(onApply).not.toHaveBeenCalled();
        expect(onCancel).not.toHaveBeenCalled();

        resolveCreate({ ...project, id: 'slow-project', title: 'Slow project' });
        await waitFor(() => expect(getByRole('button', { name: 'Cancel' })).toBeEnabled());
        fireEvent.click(getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalledOnce();
        expect(onApply).not.toHaveBeenCalled();
    });

    it('ignores a delayed create result after the modal closes and reopens', async () => {
        let resolveCreate!: (value: Project) => void;
        createProjectMock.mockImplementation(() => new Promise<Project>((resolve) => {
            resolveCreate = resolve;
        }));
        const { getByLabelText, getByRole, onApply, rerenderModal } = renderModal();

        fireEvent.click(getByRole('button', { name: 'Project' }));
        setInputValue(getByLabelText('Search projects') as HTMLInputElement, 'Old session project');
        fireEvent.click(getByRole('option', { name: 'Create project "Old session project"' }));

        rerenderModal({ isOpen: false });
        rerenderModal({ isOpen: true });
        resolveCreate({ ...project, id: 'old-session-project', title: 'Old session project' });
        await act(async () => {
            await Promise.resolve();
        });

        fireEvent.click(getByRole('button', { name: 'Apply to selected' }));
        expect('projectId' in (onApply.mock.calls[0]?.[0] as Record<string, unknown>)).toBe(false);
    });

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

    it('keeps the section out of the apply when the modal moves tasks to another project', async () => {
        const { getByRole, onApply } = renderModal({
            sectionScope: { projectId: project.id, sections: [section] },
        });

        const sectionSelect = getByRole('combobox', { name: 'Project section' });
        fireEvent.change(sectionSelect, { target: { value: section.id } });
        fireEvent.click(getByRole('button', { name: 'Project' }));
        fireEvent.click(getByRole('option', { name: otherProject.title }));

        await waitFor(() => expect(sectionSelect).toBeDisabled());

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
