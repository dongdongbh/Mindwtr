import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ListBulkActions } from './ListBulkActions';

const t = (key: string) => {
    const labels: Record<string, string> = {
        'bulk.selected': 'selected',
        'bulk.moveTo': 'Move to',
        'status.inbox': 'Inbox',
        'status.next': 'Next',
        'status.waiting': 'Waiting',
        'status.someday': 'Someday',
        'status.reference': 'Reference',
        'status.done': 'Done',
        'taskEdit.energyLevel': 'Energy Level',
        'energyLevel.low': 'Low energy',
        'energyLevel.medium': 'Medium energy',
        'energyLevel.high': 'High energy',
        'bulk.addTag': 'Add Tag',
        'bulk.addContext': 'Add Context',
        'bulk.removeContext': 'Remove Context',
        'bulk.delete': 'Delete',
        'projects.areaLabel': 'Area',
        'taskEdit.noAreaOption': 'No area',
    };
    return labels[key] ?? key;
};

describe('ListBulkActions', () => {
    afterEach(() => {
        cleanup();
    });

    it('assigns selected status from bulk action select', () => {
        const onMoveToStatus = vi.fn();

        const { getByRole } = render(
            <ListBulkActions
                selectionCount={2}
                onMoveToStatus={onMoveToStatus}
                onAddTag={() => undefined}
                onAddContext={() => undefined}
                onRemoveContext={() => undefined}
                onDelete={() => undefined}
                t={t}
            />
        );

        fireEvent.change(getByRole('combobox', { name: 'Move to' }), {
            target: { value: 'waiting' },
        });

        expect(onMoveToStatus).toHaveBeenCalledWith('waiting');
    });

    it('assigns selected area from bulk action select', () => {
        const onAssignArea = vi.fn();

        const { getByRole } = render(
            <ListBulkActions
                selectionCount={2}
                onMoveToStatus={() => undefined}
                onAssignArea={onAssignArea}
                areaOptions={[{ id: 'area-1', name: 'Work' }]}
                onAddTag={() => undefined}
                onAddContext={() => undefined}
                onRemoveContext={() => undefined}
                onDelete={() => undefined}
                t={t}
            />
        );

        fireEvent.change(getByRole('combobox', { name: 'Area' }), {
            target: { value: 'area-1' },
        });

        expect(onAssignArea).toHaveBeenCalledWith('area-1');
    });

    it('assigns no area when no-area option is selected', () => {
        const onAssignArea = vi.fn();

        const { getByRole } = render(
            <ListBulkActions
                selectionCount={1}
                onMoveToStatus={() => undefined}
                onAssignArea={onAssignArea}
                areaOptions={[{ id: 'area-1', name: 'Work' }]}
                onAddTag={() => undefined}
                onAddContext={() => undefined}
                onRemoveContext={() => undefined}
                onDelete={() => undefined}
                t={t}
            />
        );

        fireEvent.change(getByRole('combobox', { name: 'Area' }), {
            target: { value: '__NO_AREA__' },
        });

        expect(onAssignArea).toHaveBeenCalledWith(null);
    });

    it('assigns selected energy level from bulk action select', () => {
        const onAssignEnergyLevel = vi.fn();

        const { getByRole } = render(
            <ListBulkActions
                selectionCount={1}
                onMoveToStatus={() => undefined}
                onAssignEnergyLevel={onAssignEnergyLevel}
                onAddTag={() => undefined}
                onAddContext={() => undefined}
                onRemoveContext={() => undefined}
                onDelete={() => undefined}
                t={t}
            />
        );

        fireEvent.change(getByRole('combobox', { name: 'Energy Level' }), {
            target: { value: 'high' },
        });

        expect(onAssignEnergyLevel).toHaveBeenCalledWith('high');
    });
});
