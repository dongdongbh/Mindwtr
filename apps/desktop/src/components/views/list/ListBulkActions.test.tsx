import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Area, Project } from '@mindwtr/core';

import { getListBulkMoveStatusOptions, ListBulkActions } from './ListBulkActions';

const t = (key: string) => {
    const labels: Record<string, string> = {
        'bulk.selected': 'selected',
        'bulk.organizeStatus': 'Status',
        'task.destination': 'Destination',
        'projects.title': 'Projects',
        'areas.manage': 'Areas',
        'common.none': 'None',
        'common.search': 'Search',
        'status.inbox': 'Inbox',
        'status.next': 'Next',
        'status.waiting': 'Waiting',
        'status.someday': 'Someday',
        'status.reference': 'Reference',
        'status.done': 'Done',
        'status.archived': 'Archived',
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

        fireEvent.change(getByRole('combobox', { name: 'Status' }), {
            target: { value: 'waiting' },
        });

        expect(onMoveToStatus).toHaveBeenCalledWith('waiting');
    });

    it('offers Archived only when moving completed tasks', () => {
        expect(getListBulkMoveStatusOptions('done')).toEqual([
            'inbox',
            'next',
            'waiting',
            'someday',
            'reference',
            'archived',
        ]);
        expect(getListBulkMoveStatusOptions('next')).not.toContain('archived');
    });

    it('keeps the destination picker neutral and writes only after an explicit choice', () => {
        const onMoveToDestination = vi.fn();
        const onMoveToStatus = vi.fn();
        const projects = [{ id: 'project-1', title: 'Plan', status: 'active' }] as Project[];
        const areas = [{ id: 'area-1', name: 'Work' }] as Area[];
        const { getByRole, getByLabelText, queryByRole } = render(
            <ListBulkActions
                selectionCount={2}
                onMoveToStatus={onMoveToStatus}
                onMoveToDestination={onMoveToDestination}
                projects={projects}
                areas={areas}
                onAddTag={() => undefined}
                onAddContext={() => undefined}
                onDelete={() => undefined}
                t={t}
            />,
        );

        const trigger = getByRole('button', { name: 'Destination' });
        expect(trigger).toHaveTextContent('Destination');
        expect(queryByRole('combobox', { name: 'Area' })).not.toBeInTheDocument();
        fireEvent.click(trigger);
        expect(getByRole('option', { name: 'None' })).toHaveAttribute('aria-selected', 'false');
        expect(getByRole('option', { name: 'Plan' })).toHaveAttribute('aria-selected', 'false');
        expect(getByRole('option', { name: 'Work' })).toHaveAttribute('aria-selected', 'false');
        fireEvent.keyDown(getByLabelText('Search'), { key: 'Enter' });
        fireEvent.keyDown(getByLabelText('Search'), { key: 'Escape' });
        expect(onMoveToDestination).not.toHaveBeenCalled();
        expect(queryByRole('listbox')).not.toBeInTheDocument();
        fireEvent.click(trigger);
        fireEvent.mouseDown(document.body);
        expect(onMoveToDestination).not.toHaveBeenCalled();
        expect(queryByRole('listbox')).not.toBeInTheDocument();

        for (const [label, destination] of [
            ['Plan', { kind: 'project', id: 'project-1' }],
            ['Work', { kind: 'area', id: 'area-1' }],
            ['None', { kind: 'none' }],
        ] as const) {
            fireEvent.click(trigger);
            fireEvent.click(getByRole('option', { name: label }));
            expect(onMoveToDestination).toHaveBeenLastCalledWith(destination);
            expect(trigger).toHaveTextContent('Destination');
        }
        expect(onMoveToDestination).toHaveBeenCalledTimes(3);
        expect(onMoveToStatus).not.toHaveBeenCalled();
        fireEvent.change(getByRole('combobox', { name: 'Status' }), { target: { value: 'waiting' } });
        expect(onMoveToStatus).toHaveBeenCalledWith('waiting');
        expect(onMoveToDestination).toHaveBeenCalledTimes(3);
    });

    it('offers existing projects with no areas and no creation controls', () => {
        const { getByRole, getByLabelText, queryByRole } = render(
            <ListBulkActions
                selectionCount={1}
                onMoveToStatus={() => undefined}
                onMoveToDestination={() => undefined}
                projects={[{ id: 'project-1', title: 'Plan', status: 'active' }] as Project[]}
                areas={[]}
                onAddTag={() => undefined}
                onAddContext={() => undefined}
                onDelete={() => undefined}
                t={t}
            />,
        );
        fireEvent.click(getByRole('button', { name: 'Destination' }));
        expect(getByRole('option', { name: 'Plan' })).toBeInTheDocument();
        fireEvent.change(getByLabelText('Search'), { target: { value: 'New destination' } });
        expect(queryByRole('option', { name: /New project|New area/ })).not.toBeInTheDocument();
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

    it('offers the selected-task CSV export and disables repeats while pending', () => {
        const onExportCsv = vi.fn();
        const { getByRole, rerender } = render(
            <ListBulkActions
                selectionCount={2}
                onMoveToStatus={() => undefined}
                onAddTag={() => undefined}
                onAddContext={() => undefined}
                onExportCsv={onExportCsv}
                onDelete={() => undefined}
                t={t}
            />
        );

        const exportButton = getByRole('button', { name: 'Export selected tasks as CSV' });
        fireEvent.click(exportButton);
        expect(onExportCsv).toHaveBeenCalledTimes(1);

        rerender(
            <ListBulkActions
                selectionCount={2}
                onMoveToStatus={() => undefined}
                onAddTag={() => undefined}
                onAddContext={() => undefined}
                onExportCsv={onExportCsv}
                isExporting
                onDelete={() => undefined}
                t={t}
            />
        );
        const pendingExportButton = getByRole('button', { name: 'Export selected tasks as CSV' });
        expect(pendingExportButton).toBeDisabled();
        expect(pendingExportButton).toHaveAttribute('aria-busy', 'true');
        fireEvent.click(pendingExportButton);
        expect(onExportCsv).toHaveBeenCalledTimes(1);
    });
});
