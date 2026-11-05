import { render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '@mindwtr/core';

import { DraggableProjectTaskRow, SortableProjectRow, SortableProjectTaskRow } from './SortableRows';

const dragState = vi.hoisted(() => ({ activeTask: false }));
vi.mock('@dnd-kit/sortable', async () => {
    const actual = await vi.importActual<typeof import('@dnd-kit/sortable')>('@dnd-kit/sortable');
    return {
        ...actual,
        useSortable: (options: Parameters<typeof actual.useSortable>[0]) => {
            const result = actual.useSortable(options);
            return dragState.activeTask
                ? { ...result, isOver: true, active: { data: { current: { type: 'task' } } } }
                : result;
        },
    };
});
afterEach(() => { dragState.activeTask = false; });

const taskItemProps = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('../../TaskItem', () => ({
    TaskItem: (props: Record<string, unknown>) => {
        taskItemProps.calls.push(props);
        return <div data-task-id={(props.task as Task).id}>{props.dragHandle as React.ReactNode}</div>;
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

const renderRow = (
    narrow: boolean,
    Row: typeof SortableProjectTaskRow | typeof DraggableProjectTaskRow,
    interactionDisabled = false,
) => {
    taskItemProps.calls = [];
    render(
        <DndContext>
            <SortableContext items={[task.id]}>
                <Row
                    task={task}
                    project={project}
                    narrow={narrow}
                    interactionDisabled={interactionDisabled}
                    availableSequenceLabel="Available"
                    laterSequenceLabel="Later"
                    dragLabel="Drag task: Move to project or area…"
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

it.each(['active', 'deferred', 'archived'] as const)('highlights a hovered %s project only when it accepts a task move', (section) => {
    dragState.activeTask = true;
    render(
        <DndContext>
            <SortableContext items={[project.id]}>
                <SortableProjectRow projectId={project.id} section={section}>
                    {({ isTaskOver }) => <span data-testid="task-drop-highlight">{String(isTaskOver)}</span>}
                </SortableProjectRow>
            </SortableContext>
        </DndContext>
    );
    expect(screen.getByTestId('task-drop-highlight')).toHaveTextContent(String(section !== 'archived'));
});


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

    it('labels the task grip with its supported sidebar move action', () => {
        renderRow(false, Row);

        const handle = screen.getByRole('button', { name: 'Drag task: Move to project or area…' });
        expect(handle).toHaveAttribute('title', 'Drag task: Move to project or area…');
        expect(handle).not.toHaveAttribute('draggable');
        expect(handle).toHaveAttribute('aria-roledescription', Row === SortableProjectTaskRow ? 'sortable' : 'draggable');
    });

    it('removes drag and mutation capabilities for a read-only project row', () => {
        const props = renderRow(false, Row, true);

        expect(props.interactionDisabled).toBe(true);
        expect(props.dragHandle).toBeUndefined();
    });
});
