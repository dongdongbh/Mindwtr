import { render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '@mindwtr/core';

import { DraggableProjectTaskRow, SortableProjectRow, SortableProjectTaskRow } from './SortableRows';

const taskItemProps = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('../../TaskItem', () => ({
    TaskItem: (props: Record<string, unknown>) => {
        taskItemProps.calls.push(props);
        return <div data-task-id={(props.task as Task).id} />;
    },
}));

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

const task: Task = {
    id: 'task-1',
    title: 'Audit competitor websites',
    status: 'next',
    projectId: project.id,
    tags: [],
    contexts: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
};

const renderRow = (narrow: boolean, Row: typeof SortableProjectTaskRow | typeof DraggableProjectTaskRow) => {
    taskItemProps.calls = [];
    render(
        <DndContext>
            <SortableContext items={[task.id]}>
                <Row
                    task={task}
                    project={project}
                    narrow={narrow}
                    availableSequenceLabel="Available"
                    laterSequenceLabel="Later"
                />
            </SortableContext>
        </DndContext>
    );
    return taskItemProps.calls[0] ?? {};
};

it('gives the project reorder handle an explicit accessible name', () => {
    render(
        <DndContext>
            <SortableContext items={[project.id]}>
                <SortableProjectRow projectId={project.id} section="active">
                    {({ handle }) => <div>{handle}</div>}
                </SortableProjectRow>
            </SortableContext>
        </DndContext>
    );

    expect(screen.getByRole('button', { name: 'Drag' })).toBeInTheDocument();
});

// The actions strip is `shrink-0`; inline, it starves the title in a container
// as narrow as a section column. These pin the escape hatch, not the styling.
describe.each([
    ['SortableProjectTaskRow', SortableProjectTaskRow],
    ['DraggableProjectTaskRow', DraggableProjectTaskRow],
] as const)('%s narrow rows (#1019)', (_name, Row) => {
    it('lifts the actions out of the row flow when narrow', () => {
        const props = renderRow(true, Row);

        expect(props.actionsOverlay).toBe(true);
        expect(props.showStatusSelect).toBe(false);
    });

    it('keeps the inline actions at full width', () => {
        const props = renderRow(false, Row);

        expect(props.actionsOverlay).toBeUndefined();
        expect(props.showStatusSelect).toBeUndefined();
    });
});
