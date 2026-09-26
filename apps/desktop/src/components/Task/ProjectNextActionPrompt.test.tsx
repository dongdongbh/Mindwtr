import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectNextActionPrompt } from './ProjectNextActionPrompt';

const labels: Record<string, string> = {
    'projects.nextActionPromptTitle': "What's the next action?",
    'projects.nextActionPromptDesc': 'Choose or add the next action for {{project}}.',
    'projects.nextActionPromptSectionDesc': 'Choose or add the next action for {{section}} in {{project}}.',
    'projects.nextActionPromptChooseExisting': 'Choose an existing task',
    'projects.nextActionPromptAddNew': 'Add a new next action',
    'projects.nextActionPromptPlaceholder': 'New next action...',
    'projects.nextActionPromptAddButton': 'Add next action',
    'projects.nextActionPromptComplete': 'Complete project',
    'quickAdd.saveAndEdit': 'Save & edit',
    'common.skip': 'Skip',
};

const t = (key: string) => labels[key] ?? key;

const renderPrompt = (overrides: Partial<React.ComponentProps<typeof ProjectNextActionPrompt>> = {}) =>
    render(
        <ProjectNextActionPrompt
            candidates={[]}
            isOpen
            newTitle=""
            projectTitle="Launch plan"
            onAddTask={vi.fn()}
            onAddTaskAndEdit={vi.fn()}
            onCancel={vi.fn()}
            onChooseTask={vi.fn()}
            onCompleteProject={vi.fn()}
            onNewTitleChange={vi.fn()}
            t={t}
            {...overrides}
        />,
    );

describe('ProjectNextActionPrompt', () => {
    it('names the section and project literally, even with $ replacement patterns', () => {
        renderPrompt({ projectTitle: 'Launch $&', scope: 'section', sectionTitle: 'Phase $$1 {{project}}' });

        expect(screen.getByText('Choose or add the next action for Phase $$1 {{project}} in Launch $&.')).toBeTruthy();
    });

    it('renders a Complete project action that fires the completion callback', () => {
        const onCompleteProject = vi.fn();
        renderPrompt({ onCompleteProject });

        fireEvent.click(screen.getByRole('button', { name: /complete project/i }));

        expect(onCompleteProject).toHaveBeenCalledTimes(1);
    });

    it('keeps adding the next action as the primary path', () => {
        const onAddTask = vi.fn();
        const onAddTaskAndEdit = vi.fn();
        const onCancel = vi.fn();
        renderPrompt({ newTitle: 'Draft the brief', onAddTask, onAddTaskAndEdit, onCancel });

        fireEvent.click(screen.getByRole('button', { name: /add next action/i }));
        expect(onAddTask).toHaveBeenCalledTimes(1);
        expect(onAddTaskAndEdit).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /save & edit/i }));
        expect(onAddTaskAndEdit).toHaveBeenCalledTimes(1);
        expect(onAddTask).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: /^skip$/i }));
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('prevents another save while a next action is being created', () => {
        renderPrompt({ newTitle: 'Draft the brief', isAddingTask: true });

        expect(screen.getByRole('button', { name: /add next action/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: /save & edit/i })).toBeDisabled();
    });

    it('lets an existing candidate be chosen as the next action', () => {
        const onChooseTask = vi.fn();
        renderPrompt({
            candidates: [{
                id: 'task-1',
                title: 'Review draft',
                status: 'waiting',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            } as never],
            onChooseTask,
        });

        fireEvent.click(screen.getByRole('button', { name: /review draft/i }));

        expect(onChooseTask).toHaveBeenCalledWith('task-1');
    });
});
