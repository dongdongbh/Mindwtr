import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsSyncLabels } from './sync/types';

const harness = vi.hoisted(() => ({
    days: 0,
    save: vi.fn(async (_days: number) => ({ success: true })),
    preview: vi.fn(() => ({ taskIds: ['task-1'], projectIds: ['project-1'], sectionIds: ['section-1'], legacyTaskIds: ['old-1'], legacyProjectIds: [] })),
}));

vi.mock('@mindwtr/core', () => ({
    isArchiveRetentionDays: (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36500,
    getArchiveRetentionPreview: harness.preview,
    useTaskStore: Object.assign(
        (selector: (state: unknown) => unknown) => selector({ settings: { gtd: { archiveRetentionDays: harness.days } } }),
        { getState: () => ({
            _allTasks: [{ id: 'task-1', title: 'Old task' }],
            _allProjects: [{ id: 'project-1', title: 'Old project' }],
            _allSections: [{ id: 'section-1', title: 'Old section' }],
            setArchiveRetentionDays: harness.save,
        }) },
    ),
}));

import { ArchiveRetentionSection } from './ArchiveRetentionSection';

const t = {
    archiveRetention: 'Archive retention', archiveRetentionDesc: 'Description', archiveRetentionSafety: 'Safety',
    archiveRetentionCurrent: 'Current setting', archiveRetentionDays: '{days} days',
    archiveRetentionDaysLabel: 'Remove after days', archiveRetentionNever: 'Never', archiveRetentionSave: 'Save',
    archiveRetentionInvalid: 'Enter a whole number.', archiveRetentionSaveFailed: 'Save failed',
    archiveRetentionConfirmTitle: 'Change archive retention?',
    archiveRetentionConfirmDescription: 'Permanently remove after {days} days.',
    archiveRetentionConfirmAction: 'Apply retention',
    archiveRetentionCounts: '{tasks} tasks, {projects} projects, {sections} sections',
    archiveRetentionLegacyCount: '{count} legacy items start fresh',
    archiveRetentionCandidates: 'Eligible:', archiveRetentionNoCandidates: 'None',
    archiveRetentionSection: 'Section', tasks: 'Tasks', projects: 'Projects', cancel: 'Cancel',
} as SettingsSyncLabels;

describe('ArchiveRetentionSection', () => {
    beforeEach(() => {
        harness.days = 0;
        harness.save.mockClear();
        harness.preview.mockClear();
    });

    it('rejects empty, fractional and out-of-range days without writing', () => {
        render(<ArchiveRetentionSection t={t} />);
        fireEvent.click(screen.getByRole('button', { name: /^Archive retention/ }));
        const input = screen.getByRole('spinbutton', { name: 'Remove after days' });
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        for (const value of ['0', '1.5', '36501']) {
            fireEvent.change(input, { target: { value } });
            expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        }
        expect(harness.save).not.toHaveBeenCalled();
    });

    it('reviews candidates and legacy clocks before enabling, and cancel leaves the policy unchanged', async () => {
        render(<ArchiveRetentionSection t={t} />);
        const toggle = screen.getByRole('button', { name: /^Archive retention/ });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
        fireEvent.click(toggle);
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
        fireEvent.click(toggle);
        fireEvent.click(toggle);
        expect(screen.getByRole('spinbutton')).toHaveValue(30);
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(screen.getByText(/1 tasks, 1 projects, 1 sections/)).toBeTruthy();
        expect(screen.getByText(/Old project/)).toBeTruthy();
        expect(screen.getByText(/Old section/)).toBeTruthy();
        expect(screen.getByText(/Old task/)).toBeTruthy();
        expect(screen.getByText(/1 legacy items start fresh/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(harness.save).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        fireEvent.click(screen.getByRole('button', { name: 'Apply retention' }));
        await waitFor(() => expect(harness.save).toHaveBeenCalledWith(30));
    });

    it('requires review when shortening an existing policy', () => {
        harness.days = 90;
        render(<ArchiveRetentionSection t={t} />);
        fireEvent.click(screen.getByRole('button', { name: /^Archive retention/ }));
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(screen.getByText('Change archive retention?')).toBeTruthy();
        expect(harness.save).not.toHaveBeenCalled();
    });
});
