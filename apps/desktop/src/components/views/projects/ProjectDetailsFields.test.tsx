import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@mindwtr/core';

import { LanguageProvider } from '../../../contexts/language-context';
import { ProjectDetailsFields } from './ProjectDetailsFields';

const translations: Record<string, string> = {
    'projects.areaLabel': 'Area',
    'projects.create': 'Create',
    'projects.manageAreas': 'Manage areas',
    'projects.noArea': 'No area',
    'projects.parallel': 'Parallel',
    'projects.parallelTooltip': 'Parallel project',
    'projects.reviewAt': 'Review Date',
    'projects.reviewAtHint': 'Review reminders keep projects visible in Review.',
    'projects.sequenceMode': 'Flow Mode',
    'projects.sequential': 'Sequential',
    'projects.sequentialAcrossSections': 'Across sections',
    'projects.sequentialScope': 'Sequential Scope',
    'projects.sequentialTooltip': 'Sequential project',
    'projects.sequentialWithinSections': 'Within sections',
    'projects.statusLabel': 'Status',
    'status.active': 'Active',
    'status.someday': 'Someday',
    'status.waiting': 'Waiting',
    'taskEdit.dueDateLabel': 'Due Date',
    'taskEdit.startDateLabel': 'Start Date',
    'taskEdit.tagsLabel': 'Tags',
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

const defaultProps = {
    project: buildProject(),
    selectedAreaId: '__no_area__',
    sortedAreas: [],
    noAreaId: '__no_area__',
    t,
    tagDraft: '#cl',
    onTagDraftChange: vi.fn(),
    onCommitTags: vi.fn(),
    onNewArea: vi.fn(),
    onManageAreas: vi.fn(),
    onAreaChange: vi.fn(),
    isSequential: false,
    onToggleSequential: vi.fn(),
    sequentialScope: 'project' as Project['sequentialScope'],
    onSequentialScopeChange: vi.fn(),
    status: 'active' as Project['status'],
    onChangeStatus: vi.fn(),
    startDateValue: '',
    onStartDateChange: vi.fn(),
    dueDateValue: '',
    onDueDateChange: vi.fn(),
    reviewAtValue: '',
    onReviewAtChange: vi.fn(),
};

describe('ProjectDetailsFields', () => {
    it('offers existing tag completions for the project tag field', async () => {
        render(
            <LanguageProvider>
                <ProjectDetailsFields
                    {...defaultProps}
                    tagSuggestions={['#client', '#creative']}
                />
            </LanguageProvider>
        );

        const tagInput = screen.getByRole('combobox', { name: 'Tags' }) as HTMLInputElement;
        tagInput.setSelectionRange(3, 3);

        fireEvent.keyUp(tagInput, { key: 'l' });
        await screen.findByRole('option', { name: '#client' });

        fireEvent.keyDown(tagInput, { key: 'ArrowDown' });
        fireEvent.keyDown(tagInput, { key: 'Enter' });

        expect(defaultProps.onTagDraftChange).toHaveBeenCalledWith('#client, ');
    });

    it('offers a start date beside the due date and reports what was typed', () => {
        const onStartDateChange = vi.fn();
        render(
            <LanguageProvider>
                <ProjectDetailsFields {...defaultProps} onStartDateChange={onStartDateChange} />
            </LanguageProvider>
        );

        const startInput = screen.getByLabelText('Start Date');
        expect(screen.getByLabelText('Due Date')).toBeTruthy();

        fireEvent.change(startInput, { target: { value: '2026-10-05' } });
        expect(onStartDateChange).toHaveBeenCalledWith('2026-10-05');
    });
});
