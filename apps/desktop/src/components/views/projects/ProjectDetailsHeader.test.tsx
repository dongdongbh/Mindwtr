import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@mindwtr/core';

import { ProjectDetailsHeader } from './ProjectDetailsHeader';

const translations: Record<string, string> = {
    'common.delete': 'Delete',
    'projects.archive': 'Archive',
    'projects.details': 'Details',
    'projects.duplicate': 'Duplicate',
    'projects.noActiveTasks': 'No active tasks',
    'projects.parallel': 'Parallel',
    'projects.projectTypeHelpLabel': 'Project type help',
    'projects.projectTypeHelpText': 'Sequential projects surface one available action at a time. Parallel projects can surface multiple independent Next tasks.',
    'projects.reviewAt': 'Review Date',
    'projects.reactivate': 'Reactivate',
    'projects.sequential': 'Sequential',
    'projects.title': 'Project title',
    'process.remaining': 'remaining',
    'status.active': 'Active',
    'status.done': 'Done',
    'status.waiting': 'Waiting',
    'taskEdit.details': 'Details',
    'taskEdit.dueDateLabel': 'Due Date',
    'taskEdit.startDateLabel': 'Start Date',
};

const t = (key: string) => translations[key] ?? key;

function buildProject(overrides: Partial<Project> = {}): Project {
    return {
        id: 'project-1',
        title: 'Launch site',
        status: 'active',
        color: '#3b82f6',
        order: 0,
        tagIds: [],
        createdAt: '2026-03-30T09:00:00',
        updatedAt: '2026-03-30T09:00:00',
        ...overrides,
    };
}

describe('ProjectDetailsHeader', () => {
    it('shows compact project summary metadata and toggles details', () => {
        const onToggleDetails = vi.fn();
        const project = buildProject({
            status: 'waiting',
            tagIds: ['#client'],
            startDate: '2026-03-24',
            dueDate: '2026-03-28',
            reviewAt: '2026-03-30T09:00:00',
        });

        render(
            <ProjectDetailsHeader
                project={project}
                projectColor="#2563eb"
                areaLabel="Ops"
                isSequential
                dueDate={project.dueDate}
                reviewAt={project.reviewAt}
                editTitle={project.title}
                onEditTitleChange={vi.fn()}
                onCommitTitle={vi.fn()}
                onResetTitle={vi.fn()}
                detailsExpanded={false}
                onToggleDetails={onToggleDetails}
                onDuplicate={vi.fn()}
                onArchive={vi.fn()}
                onReactivate={vi.fn()}
                onDelete={vi.fn()}
                t={t}
            />
        );

        expect(screen.getByRole('button', { name: /details/i })).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByDisplayValue('Launch site')).toHaveAttribute('title', 'Launch site');
        expect(screen.getByDisplayValue('Launch site').tagName).toBe('TEXTAREA');
        screen.getByText('Waiting');
        screen.getByText('Ops');
        screen.getByText('Sequential');
        screen.getByText('Start Date: Mar 24');
        screen.getByText('Due Date: Mar 28');
        screen.getByText('Review Date: Mar 30');
        screen.getByText('#client');

        fireEvent.click(screen.getByRole('button', { name: 'Project type help' }));
        expect(screen.getByText('Sequential projects surface one available action at a time. Parallel projects can surface multiple independent Next tasks.')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /details/i }));
        expect(onToggleDetails).toHaveBeenCalledTimes(1);
    });

    it('renders the parallel summary and expanded state without optional chips', () => {
        const project = buildProject();

        render(
            <ProjectDetailsHeader
                project={project}
                projectColor="#2563eb"
                isSequential={false}
                dueDate={project.dueDate}
                editTitle={project.title}
                onEditTitleChange={vi.fn()}
                onCommitTitle={vi.fn()}
                onResetTitle={vi.fn()}
                detailsExpanded
                onToggleDetails={vi.fn()}
                onDuplicate={vi.fn()}
                onArchive={vi.fn()}
                onReactivate={vi.fn()}
                onDelete={vi.fn()}
                t={t}
            />
        );

        expect(screen.getByRole('button', { name: /details/i })).toHaveAttribute('aria-expanded', 'true');
        screen.getByText('Active');
        screen.getByText('Parallel');
        expect(screen.queryByText('Ops')).not.toBeInTheDocument();
        expect(screen.queryByText(/Start Date:/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Due Date:/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Review Date:/i)).not.toBeInTheDocument();
    });

    it('uses a container-responsive header layout so actions cannot hide long project titles', () => {
        render(
            <ProjectDetailsHeader
                project={buildProject()}
                projectColor="#2563eb"
                isSequential={false}
                dueDate={undefined}
                editTitle="A very long project name that should keep the whole details-column width"
                onEditTitleChange={vi.fn()}
                onCommitTitle={vi.fn()}
                onResetTitle={vi.fn()}
                detailsExpanded={false}
                onToggleDetails={vi.fn()}
                onDuplicate={vi.fn()}
                onArchive={vi.fn()}
                onReactivate={vi.fn()}
                onDelete={vi.fn()}
                t={t}
            />
        );

        const title = screen.getByDisplayValue('A very long project name that should keep the whole details-column width');
        const header = title.closest('.project-details-header');
        const actions = header?.querySelector('.project-details-header__actions');

        expect(header).not.toBeNull();
        expect(header).toHaveClass('project-details-header');
        expect(title).toHaveClass('project-details-header__titleInput');
        expect(title).toHaveClass('break-words');
        expect(title).not.toHaveClass('truncate');
        expect(actions).not.toBeNull();
    });
});
