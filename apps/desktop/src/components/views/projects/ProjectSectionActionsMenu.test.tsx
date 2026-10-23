import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectSectionActionsMenu } from './ProjectSectionActionsMenu';

const renderMenu = (overrides: Partial<ComponentProps<typeof ProjectSectionActionsMenu>> = {}) => {
    const actions = {
        onMoveBack: vi.fn(),
        onMoveForward: vi.fn(),
        onToggleNotes: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
    };
    render(
        <ProjectSectionActionsMenu
            sectionTitle="Planning"
            orientation="vertical"
            moreOptionsLabel="More options"
            moveBackLabel="Move section up"
            moveForwardLabel="Move section down"
            notesLabel="Section notes"
            editLabel="Edit"
            deleteLabel="Delete"
            canMoveBack
            canMoveForward
            readOnly={false}
            notesActive={false}
            {...actions}
            {...overrides}
        />,
    );
    return actions;
};

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'More options: Planning' }));

describe('ProjectSectionActionsMenu', () => {
    it('keeps every secondary section action reachable from the overflow', () => {
        const actions = renderMenu();

        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Move section down: Planning' }));
        expect(actions.onMoveForward).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: 'More options: Planning' })).toHaveFocus();

        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Section notes' }));
        expect(actions.onToggleNotes).toHaveBeenCalledTimes(1);

        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
        expect(actions.onRename).toHaveBeenCalledTimes(1);

        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
        expect(actions.onDelete).toHaveBeenCalledTimes(1);
    });

    it('offers the section Flow mode only when the menu is given one (#1429)', () => {
        renderMenu();
        openMenu();
        expect(screen.queryByRole('menuitemradio')).toBeNull();
        fireEvent.keyDown(window, { key: 'Escape' });

        const onChange = vi.fn();
        renderMenu({ sectionTitle: 'Book campsite', flow: {
            label: 'Flow Mode', parallelLabel: 'Parallel', sequentialLabel: 'Sequential',
            isSequential: false, onChange,
        } });
        fireEvent.click(screen.getByRole('button', { name: 'More options: Book campsite' }));
        expect(screen.getByRole('group', { name: 'Flow Mode' })).toBeInTheDocument();
        expect(screen.getByRole('menuitemradio', { name: 'Parallel' })).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Parallel' }));
        expect(onChange).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'More options: Book campsite' }));
        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sequential' }));
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it('keeps notes available but blocks mutations for read-only archived sections', () => {
        const actions = renderMenu({ readOnly: true, readOnlyHint: 'Archived projects are read-only' });

        openMenu();
        expect(screen.getByRole('menuitem', { name: 'Move section up: Planning' })).toBeDisabled();
        expect(screen.getByRole('menuitem', { name: 'Move section down: Planning' })).toBeDisabled();
        expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeDisabled();
        expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();

        fireEvent.click(screen.getByRole('menuitem', { name: 'Section notes' }));
        expect(actions.onToggleNotes).toHaveBeenCalledTimes(1);
    });
});
