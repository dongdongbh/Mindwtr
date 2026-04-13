import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { AppData, Area, Project, Task } from '@mindwtr/core';

import { InboxProcessor } from './InboxProcessor';
import { reportError } from '../../lib/report-error';
import { useUiStore } from '../../store/ui-store';

vi.mock('../../lib/report-error', () => ({
    reportError: vi.fn(),
}));

const nowIso = new Date().toISOString();

const inboxTask: Task = {
    id: 'task-1',
    title: 'Plan launch',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: nowIso,
    updatedAt: nowIso,
};

const createdProject: Project = {
    id: 'project-1',
    title: 'Plan launch',
    color: '#94a3b8',
    status: 'active',
    order: 0,
    tagIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
};

type RenderResult = {
    addProject: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
    deleteTask: ReturnType<typeof vi.fn>;
} & ReturnType<typeof render>;

const renderInboxProcessor = (settings?: AppData['settings']): RenderResult => {
    const addProject = vi.fn(async () => createdProject);
    const updateTask = vi.fn(async () => undefined);
    const deleteTask = vi.fn(async () => undefined);
    const tasks = [inboxTask];
    const projects: Project[] = [];
    const areas: Area[] = [];

    const TestHarness = () => {
        const [isProcessing, setIsProcessing] = useState(false);
        return (
            <InboxProcessor
                t={(key) => key}
                isInbox
                tasks={tasks}
                projects={projects}
                areas={areas}
                settings={settings}
                addProject={addProject}
                updateTask={updateTask}
                deleteTask={deleteTask}
                allContexts={[]}
                isProcessing={isProcessing}
                setIsProcessing={setIsProcessing}
            />
        );
    };

    return {
        ...render(<TestHarness />),
        addProject,
        updateTask,
        deleteTask,
    };
};

describe('InboxProcessor', () => {
    afterEach(() => {
        cleanup();
    });

    it('shows an error toast when project conversion fails', async () => {
        useUiStore.setState({ toasts: [] });
        const { getByRole, getByText, addProject } = renderInboxProcessor();
        addProject.mockRejectedValueOnce(new Error('disk full'));

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepYes'));
        fireEvent.click(getByText('process.createProject'));

        await waitFor(() => {
            expect(useUiStore.getState().toasts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        message: 'projects.createFailed',
                        tone: 'error',
                    }),
                ]),
            );
        });
    });

    it('opens in quick mode when configured as the default inbox processing mode', () => {
        const { getByRole, getByText, queryByText } = renderInboxProcessor({
            gtd: {
                inboxProcessing: {
                    defaultMode: 'quick',
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));

        expect(getByText('process.quickDesc')).toBeTruthy();
        expect(queryByText('process.refineDesc')).toBeNull();
    });

    it('routes actionable multi-step tasks directly to project conversion', async () => {
        const { getByRole, getByText, addProject, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepYes'));

        fireEvent.click(getByText('process.createProject'));

        await waitFor(() => {
            expect(addProject).toHaveBeenCalledTimes(1);
        });
        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    title: 'Plan launch',
                    status: 'next',
                    projectId: 'project-1',
                }),
            );
        });
    });

    it('reports addProject failures instead of throwing from project conversion', async () => {
        const { getByRole, getByText, addProject, updateTask } = renderInboxProcessor();
        addProject.mockRejectedValueOnce(new Error('disk full'));

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepYes'));
        fireEvent.click(getByText('process.createProject'));

        await waitFor(() => {
            expect(reportError).toHaveBeenCalledWith(
                'Failed to create project from inbox processing',
                expect.any(Error),
            );
        });
        expect(updateTask).not.toHaveBeenCalled();
    });

    it('continues to normal two-minute flow when item is a single action', () => {
        const { getByRole, getByText } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));

        expect(getByText('process.twoMinDesc')).toBeTruthy();
    });

    it('merges the two-minute shortcut into the actionable step by default', async () => {
        const { getByRole, getByText, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));

        fireEvent.click(getByText('process.doneIt'));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'done',
                }),
            );
        });
    });

    it('keeps scheduling and reference branches hidden by default', () => {
        const { getByRole, getByText, queryByText } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));

        expect(queryByText('process.reference')).toBeNull();

        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));

        expect(getByText('process.nextStepDesc')).toBeTruthy();
        expect(queryByText('taskEdit.startDateLabel')).toBeNull();
    });

    it('shows scheduling and reference options when enabled in settings', () => {
        const { getByRole, getByText } = renderInboxProcessor({
            gtd: {
                inboxProcessing: {
                    scheduleEnabled: true,
                    referenceEnabled: true,
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));

        expect(getByText('process.reference')).toBeTruthy();

        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));

        expect(getByText('taskEdit.startDateLabel')).toBeTruthy();
        expect(getByText('taskEdit.dueDateLabel')).toBeTruthy();
        expect(getByText('taskEdit.reviewDateLabel')).toBeTruthy();
    });

    it('hides energy and assigned-to fields when the task editor layout disables them', () => {
        const { getByRole, getByText, queryByLabelText } = renderInboxProcessor({
            gtd: {
                taskEditor: {
                    hidden: ['energyLevel', 'assignedTo'],
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'process.modeQuick' }));

        expect(queryByLabelText('taskEdit.energyLevel')).toBeNull();
        expect(queryByLabelText('taskEdit.assignedTo')).toBeNull();

        fireEvent.click(getByRole('button', { name: 'process.modeGuided' }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));
        fireEvent.click(getByText('process.doIt'));

        expect(queryByLabelText('taskEdit.energyLevel')).toBeNull();
        expect(queryByLabelText('taskEdit.assignedTo')).toBeNull();
    });

    it('processes a task from quick mode with start, due, review, contexts, tags, and priority by default', async () => {
        const { getByRole, getByLabelText, updateTask } = renderInboxProcessor({
            gtd: {
                inboxProcessing: {
                    scheduleEnabled: true,
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'process.modeQuick' }));

        fireEvent.change(getByLabelText('taskEdit.titleLabel'), {
            target: { value: 'Clarified task' },
        });
        fireEvent.change(getByLabelText('taskEdit.descriptionLabel'), {
            target: { value: 'Updated description' },
        });
        fireEvent.change(getByLabelText('taskEdit.contextsLabel'), {
            target: { value: '@home, @desk' },
        });
        fireEvent.change(getByLabelText('taskEdit.tagsLabel'), {
            target: { value: '#deep, #writing' },
        });
        fireEvent.change(getByLabelText('taskEdit.energyLevel'), {
            target: { value: 'medium' },
        });
        fireEvent.change(getByLabelText('taskEdit.assignedTo'), {
            target: { value: 'Morgan' },
        });
        fireEvent.click(getByRole('button', { name: 'priority.high' }));
        fireEvent.change(getByLabelText('taskEdit.startDateLabel'), {
            target: { value: '2026-03-23' },
        });
        fireEvent.change(getByLabelText('taskEdit.dueDateLabel'), {
            target: { value: '2026-03-24' },
        });
        fireEvent.change(getByLabelText('taskEdit.reviewDateLabel'), {
            target: { value: '2026-03-25' },
        });

        fireEvent.click(getByRole('button', { name: 'process.next' }));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    title: 'Clarified task',
                    description: 'Updated description',
                    status: 'next',
                    contexts: ['@home', '@desk'],
                    tags: ['#deep', '#writing'],
                    energyLevel: 'medium',
                    assignedTo: 'Morgan',
                    priority: 'high',
                    startTime: '2026-03-23',
                    dueDate: '2026-03-24',
                    reviewAt: '2026-03-25',
                }),
            );
        });
    });

    it('parses quick-add date commands from the guided refine title before saving', async () => {
        const { getByRole, getByText, getByDisplayValue, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.change(getByDisplayValue('Plan launch'), {
            target: {
                value: 'Clarified task /start:2026-03-23 12:00 /due:2026-03-24 13:00 /review:2026-03-25 14:00',
            },
        });
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));
        fireEvent.click(getByText('process.doIt'));
        fireEvent.click(getByRole('button', { name: /process\.next/ }));
        fireEvent.click(getByRole('button', { name: /process\.noProject/ }));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    title: 'Clarified task',
                    status: 'next',
                    startTime: expect.stringContaining('2026-03-23'),
                    dueDate: expect.stringContaining('2026-03-24'),
                    reviewAt: expect.stringContaining('2026-03-25'),
                }),
            );
        });
    });

    it('shows an error toast and blocks processing when the title contains an invalid date command', async () => {
        useUiStore.setState({ toasts: [] });
        const { getByRole, getByLabelText, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'process.modeQuick' }));
        fireEvent.change(getByLabelText('taskEdit.titleLabel'), {
            target: { value: 'Broken task /due:2026-04-31' },
        });

        fireEvent.click(getByRole('button', { name: 'process.next' }));

        await waitFor(() => {
            expect(useUiStore.getState().toasts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        message: 'quickAdd.invalidDateCommand: /due:2026-04-31',
                        tone: 'error',
                    }),
                ]),
            );
        });
        expect(updateTask).not.toHaveBeenCalled();
    });

    it('processes a task from guided mode with priority in the context step by default', async () => {
        const { getByRole, getByText, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));
        fireEvent.click(getByText('process.doIt'));
        fireEvent.change(getByRole('combobox', { name: 'taskEdit.energyLevel' }), {
            target: { value: 'high' },
        });
        fireEvent.change(getByRole('textbox', { name: 'taskEdit.assignedTo' }), {
            target: { value: 'Casey' },
        });
        fireEvent.click(getByRole('button', { name: 'priority.urgent' }));
        fireEvent.click(getByRole('button', { name: /process\.next/ }));
        fireEvent.click(getByRole('button', { name: /process\.noProject/ }));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'next',
                    energyLevel: 'high',
                    assignedTo: 'Casey',
                    priority: 'urgent',
                }),
            );
        });
    });

    it('moves delegated tasks to waiting with assignedTo instead of mutating the description', async () => {
        const { getByRole, getByText, getByPlaceholderText, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));
        fireEvent.click(getByText('process.delegate'));
        fireEvent.change(getByPlaceholderText('process.delegateWhoPlaceholder'), {
            target: { value: 'Alex' },
        });

        fireEvent.click(getByText('process.delegateMoveToWaiting'));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'waiting',
                    assignedTo: 'Alex',
                }),
            );
        });

        const [, updates] = updateTask.mock.calls[updateTask.mock.calls.length - 1] as [string, Task];
        expect(updates.description).toBeUndefined();
    });
});
