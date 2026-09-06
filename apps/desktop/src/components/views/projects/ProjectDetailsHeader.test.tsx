import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@mindwtr/core';

import { ProjectDetailsHeader } from './ProjectDetailsHeader';

const translations: Record<string, string> = {
    'common.delete': 'Delete',
    'projects.archive': 'Archive',
    'projects.complete': 'Complete',
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
    'status.archived': 'Archived',
    'status.done': 'Done',
    'status.waiting': 'Waiting',
    'taskEdit.details': 'Details',
    'taskEdit.dueDateLabel': 'Due Date',
    'taskEdit.moreOptions': 'More options',
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

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /^More options: / }));

describe('ProjectDetailsHeader', () => {
    it('shows compact project summary metadata and toggles details from the menu', () => {
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
                projectProgress={{ total: 5, doneCount: 2, remainingCount: 3 }}
                t={t}
            />
        );

        expect(screen.getByDisplayValue('Launch site')).toHaveAttribute('title', 'Launch site');
        expect(screen.getByDisplayValue('Launch site').tagName).toBe('TEXTAREA');
        screen.getByText('Waiting');
        screen.getByText('Ops');
        screen.getByText('Sequential');
        screen.getByText('Start Date: Mar 24');
        screen.getByText('Due Date: Mar 28');
        screen.getByText('Review Date: Mar 30');
        screen.getByText('#client');
        screen.getByText('2/5 Done • 3 remaining');

        // Management actions stay out of the row until the menu opens.
        expect(screen.queryByRole('menuitem', { name: 'Details' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Duplicate' })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Project type help' }));
        expect(screen.getByText('Sequential projects surface one available action at a time. Parallel projects can surface multiple independent Next tasks.')).toBeInTheDocument();

        openMenu();
        expect(screen.getByRole('button', { name: 'More options: Launch site' })).toHaveAttribute('aria-expanded', 'true');
        const details = screen.getByRole('menuitem', { name: 'Details' });
        expect(details).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(details);
        expect(onToggleDetails).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('routes duplicate, archive, and delete through the menu and closes it on Escape', () => {
        const onDuplicate = vi.fn();
        const onArchive = vi.fn();
        const onDelete = vi.fn();

        render(
            <ProjectDetailsHeader
                project={buildProject()}
                projectColor="#2563eb"
                isSequential={false}
                editTitle="Launch site"
                onEditTitleChange={vi.fn()}
                onCommitTitle={vi.fn()}
                onResetTitle={vi.fn()}
                detailsExpanded
                onToggleDetails={vi.fn()}
                onDuplicate={onDuplicate}
                onArchive={onArchive}
                onReactivate={vi.fn()}
                onDelete={onDelete}
                t={t}
            />
        );

        openMenu();
        expect(screen.getByRole('menuitem', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true');
        expect(screen.queryByRole('menuitem', { name: 'Reactivate' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
        expect(onDuplicate).toHaveBeenCalledTimes(1);

        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Complete' }));
        expect(onArchive).toHaveBeenCalledTimes(1);

        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
        expect(onDelete).toHaveBeenCalledTimes(1);

        openMenu();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('offers Reactivate instead of Archive and blocks Delete on a read-only archived project', () => {
        const onReactivate = vi.fn();
        const onDelete = vi.fn();

        render(
            <ProjectDetailsHeader
                project={buildProject({ status: 'archived' })}
                projectColor="#2563eb"
                isSequential={false}
                editTitle="Launch site"
                onEditTitleChange={vi.fn()}
                onCommitTitle={vi.fn()}
                onResetTitle={vi.fn()}
                detailsExpanded={false}
                onToggleDetails={vi.fn()}
                onDuplicate={vi.fn()}
                onArchive={vi.fn()}
                onReactivate={onReactivate}
                onDelete={onDelete}
                readOnly
                readOnlyHint="Archived projects are read-only"
                t={t}
            />
        );

        openMenu();
        expect(screen.queryByRole('menuitem', { name: 'Complete' })).not.toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Reactivate' }));
        expect(onReactivate).toHaveBeenCalledTimes(1);
    });

    // The header is a size container, so it is its own stacking context and the sticky task
    // toolbar rendered after it would paint over an open menu (reported from a 1.2.8 build).
    it('lifts the header above the sticky toolbar only while the menu is open', () => {
        render(
            <ProjectDetailsHeader
                project={buildProject()}
                projectColor="#2563eb"
                isSequential={false}
                editTitle="Launch site"
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
        const header = screen.getByDisplayValue('Launch site').closest('.project-details-header');
        expect(header).not.toHaveClass('z-30');

        openMenu();
        expect(screen.getByRole('menu')).toBeInTheDocument();
        expect(header).toHaveClass('relative', 'z-30');

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(header).not.toHaveClass('z-30');
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
