import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@mindwtr/core';
import { ProjectToSectionDialog } from './ProjectToSectionDialog';

const mocks = vi.hoisted(() => {
    const command = { section: { title: 'Milestones' }, source: { before: { supportNotes: 'Source notes' } }, destination: { id: 'dest', title: 'Destination' } };
    const preview = { ok: true, sourceTitle: 'Source', destinationTitle: 'Destination', defaultTitle: 'Source', taskCount: 3, completedCount: 1, archivedCount: 1, colorWillBeLost: true };
    const convert = vi.fn();
    const rows = { _allProjects: [], _allSections: [], _allTasks: [] };
    const previewer = vi.fn(() => preview);
    return { command, preview, convert, rows, prepare: vi.fn(() => ({ ok: true, preview, command })), previewCall: vi.fn(() => preview),
        createPreviewer: vi.fn(() => previewer) };
});

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return {
        ...actual,
        previewProjectToSection: mocks.previewCall,
        createProjectToSectionPreviewer: mocks.createPreviewer,
        prepareProjectToSection: mocks.prepare,
        useTaskStore: { getState: () => ({ areas: [], convertProjectToSection: mocks.convert, ...mocks.rows }) },
    };
});

const source = { id: 'source', title: 'Source', status: 'active', color: '#f00', supportNotes: 'Source notes' } as Project;
const destination = { id: 'dest', title: 'Destination', status: 'active', color: '#00f' } as Project;
const t = (key: string) => key === 'common.cancel' ? 'Cancel' : key;

describe('ProjectToSectionDialog', () => {
    it('explains the required destination flow for a sequential source', () => {
        render(<ProjectToSectionDialog source={{ ...source, isSequential: true }} projects={[destination]} onCancel={vi.fn()} onSuccess={vi.fn()} t={t} />);
        expect(screen.getByText(/Choose a destination set to Sequential → Within sections/)).toBeInTheDocument();
    });

    it('cancels without a write and shows the count and chosen title at confirmation', () => {
        const onCancel = vi.fn();
        const { unmount } = render(<ProjectToSectionDialog source={source} projects={[source, destination]} onCancel={onCancel} onSuccess={vi.fn()} t={t} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalledOnce();
        expect(mocks.convert).not.toHaveBeenCalled();
        unmount();

        render(<ProjectToSectionDialog source={source} projects={[source, destination]} onCancel={vi.fn()} onSuccess={vi.fn()} t={t} />);
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dest' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Section name' }), { target: { value: 'Milestones' } });
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.getByText('New section: Milestones')).toBeInTheDocument();
        expect(screen.getByText(/Move 3 tasks \(1 done, 1 archived\)/)).toBeInTheDocument();
        expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), 'source', 'dest', 'Milestones');
    });

    it('does not rebuild the destination list while the section name is typed', () => {
        render(<ProjectToSectionDialog source={source} projects={[source, destination]} onCancel={vi.fn()} onSuccess={vi.fn()} t={t} />);
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dest' } });
        const builds = mocks.createPreviewer.mock.calls.length;
        const previews = mocks.previewCall.mock.calls.length;
        expect(builds).toBeGreaterThan(0);
        const input = screen.getByRole('textbox', { name: 'Section name' });
        for (const value of ['M', 'Mi', 'Mil', 'Mile']) fireEvent.change(input, { target: { value } });
        expect(mocks.createPreviewer.mock.calls.length).toBe(builds);
        expect(mocks.previewCall.mock.calls.length).toBe(previews);
        expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    });

    it('keeps the frozen command and retry control after the source leaves the live list', async () => {
        mocks.convert.mockReset();
        mocks.convert.mockResolvedValueOnce({ success: false, reason: 'save-failed' });
        mocks.convert.mockResolvedValueOnce({ success: true, receipt: mocks.command, destinationProjectId: 'dest', sectionId: 'section' });
        const onSuccess = vi.fn();
        const view = render(<ProjectToSectionDialog source={source} projects={[source, destination]} onCancel={vi.fn()} onSuccess={onSuccess} t={t} />);
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dest' } });
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        fireEvent.click(screen.getByRole('button', { name: 'Convert to section…' }));
        view.rerender(<ProjectToSectionDialog source={source} projects={[destination]} onCancel={vi.fn()} onSuccess={onSuccess} t={t} />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument());
        expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
        expect(mocks.convert).toHaveBeenNthCalledWith(1, mocks.command);
        expect(mocks.convert).toHaveBeenNthCalledWith(2, mocks.command);
    });
});
