import { beforeEach, describe, it, expect } from 'vitest';
import { act, render, fireEvent, waitFor, within } from '@testing-library/react';
import { TaskItem } from './TaskItem';
import { Task, useTaskStore } from '@mindwtr/core';
import { LanguageProvider } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();

const baseTask: Task = {
    id: 'repro-836',
    title: 'Repro Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
};

const seed = (task: Task) => {
    act(() => {
        useTaskStore.setState((state) => ({
            ...state,
            tasks: [task],
            _allTasks: [task],
            _tasksById: new Map([[task.id, task]]),
            projects: [],
            _allProjects: [],
            _projectsById: new Map(),
            sections: [],
            _allSections: [],
            _sectionsById: new Map(),
            areas: [],
            _allAreas: [],
            _areasById: new Map(),
        }));
    });
};

describe('task attachments survive completion (#836)', () => {
    beforeEach(() => {
        act(() => {
            useTaskStore.setState(initialTaskState, true);
            useUiStore.setState(initialUiState, true);
        });
        useUiStore.setState({
            ...useUiStore.getState(),
            editingTaskId: null,
            expandedTaskIds: {},
        });
    });

    it('row quick-done keeps saved attachments', async () => {
        const task: Task = {
            ...baseTask,
            attachments: [{
                id: 'att-1',
                kind: 'file',
                title: 'doc.pdf',
                uri: 'C:\\Users\\me\\doc.pdf',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }],
        };
        seed(task);
        const { getAllByRole } = render(
            <LanguageProvider>
                <TaskItem task={task} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: 'Done' })[0]);
        });

        await waitFor(() => {
            const updated = useTaskStore.getState()._tasksById.get(task.id);
            expect(updated?.status).toBe('done');
        });
        const updated = useTaskStore.getState()._tasksById.get(task.id);
        expect(updated?.attachments?.filter((a) => !a.deletedAt)).toHaveLength(1);
    });

    it('editor Done saves a draft attachment that was never explicitly saved', async () => {
        const task: Task = { ...baseTask };
        seed(task);
        const { getAllByRole, getByRole, getByDisplayValue, container } = render(
            <LanguageProvider>
                <TaskItem task={task} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        await waitFor(() => expect(getByDisplayValue('Repro Task')).toBeInTheDocument());

        // Open the collapsed Details section, then add a link attachment (buffer-only until save)
        // The contextual Help: Details button is a separate control.
        const detailsToggle = getByRole('button', { name: /^details\b/i, expanded: false });
        await act(async () => {
            fireEvent.click(detailsToggle);
        });
        expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
        const addLink = await waitFor(() => getAllByRole('button', { name: /add link/i })[0]);
        await act(async () => {
            fireEvent.click(addLink);
        });
        const dialog = await waitFor(() => getByRole('dialog'));
        const input = within(dialog).getByRole('combobox');
        await act(async () => {
            fireEvent.change(input, { target: { value: 'https://example.com/spec' } });
        });
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: /save/i }));
        });

        // Attachment should now be listed in the editor draft
        await waitFor(() => expect(container.ownerDocument.body.textContent).toContain('example.com'));

        // Press the editor's Done check instead of Save
        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: 'Done' })[0]);
        });

        await waitFor(() => {
            const updated = useTaskStore.getState()._tasksById.get(task.id);
            expect(updated?.status).toBe('done');
        });
        const updated = useTaskStore.getState()._tasksById.get(task.id);
        expect(updated?.attachments?.filter((a) => !a.deletedAt)).toHaveLength(1);
    });
});
