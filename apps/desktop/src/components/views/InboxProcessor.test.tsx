import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AppData, Area, ClarifyResponse, Project, Task } from '@mindwtr/core';

import { LanguageProvider } from '../../contexts/language-context';
import { InboxProcessor } from './InboxProcessor';
import { reportError } from '../../lib/report-error';
import { useUiStore } from '../../store/ui-store';

const clarifyTask = vi.hoisted(() => vi.fn());

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return { ...actual, createAIProvider: () => ({ clarifyTask }) };
});

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

const inboxTaskTwo: Task = {
    id: 'task-2',
    title: 'Follow up with Casey',
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

const workArea: Area = {
    id: 'area-work',
    name: 'Work',
    color: '#2563eb',
    order: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
};

const homeArea: Area = {
    id: 'area-home',
    name: 'Home',
    color: '#16a34a',
    order: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
};

const workProject: Project = {
    id: 'project-work',
    title: 'Work Project',
    color: '#2563eb',
    status: 'active',
    order: 0,
    tagIds: [],
    areaId: workArea.id,
    createdAt: nowIso,
    updatedAt: nowIso,
};

const homeProject: Project = {
    id: 'project-home',
    title: 'Home Project',
    color: '#16a34a',
    status: 'active',
    order: 1,
    tagIds: [],
    areaId: homeArea.id,
    createdAt: nowIso,
    updatedAt: nowIso,
};

type RenderResult = {
    addTask: ReturnType<typeof vi.fn>;
    addProject: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
    deleteTask: ReturnType<typeof vi.fn>;
} & ReturnType<typeof render>;

type RenderInboxProcessorOptions = {
    settings?: AppData['settings'];
    tasks?: Task[];
    projects?: Project[];
    areas?: Area[];
    allContexts?: string[];
    allTags?: string[];
};

const isRenderInboxProcessorOptions = (
    options: AppData['settings'] | RenderInboxProcessorOptions | undefined,
): options is RenderInboxProcessorOptions => (
    !!options
    && (
        'settings' in options
        || 'tasks' in options
        || 'projects' in options
        || 'areas' in options
        || 'allContexts' in options
        || 'allTags' in options
    )
);

const renderInboxProcessor = (options?: AppData['settings'] | RenderInboxProcessorOptions): RenderResult => {
    const renderOptions = isRenderInboxProcessorOptions(options)
        ? options
        : { settings: options };
        const addTask = vi.fn(async () => ({ success: true }));
    const addProject = vi.fn(async () => createdProject);
        const updateTask = vi.fn(async () => ({ success: true }));
        const deleteTask = vi.fn(async () => ({ success: true }));
    const tasks = renderOptions.tasks ?? [inboxTask];
    const projects = renderOptions.projects ?? [];
    const areas = renderOptions.areas ?? [];

    const TestHarness = () => {
        const [isProcessing, setIsProcessing] = useState(false);
        return (
            <LanguageProvider>
            <InboxProcessor
                t={(key) => key}
                isInbox
                tasks={tasks}
                projects={projects}
                areas={areas}
                settings={renderOptions.settings}
                addTask={addTask}
                addProject={addProject}
                updateTask={updateTask}
                deleteTask={deleteTask}
                allContexts={renderOptions.allContexts ?? []}
                allTags={renderOptions.allTags ?? []}
                isProcessing={isProcessing}
                setIsProcessing={setIsProcessing}
            />
            </LanguageProvider>
        );
    };

    return {
        ...render(<TestHarness />),
        addTask,
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
                        message: 'Failed to create project',
                        tone: 'error',
                    }),
                ]),
            );
        });
    });

    it('creates extra next actions in the new project when added at the split step (#827)', async () => {
        const { getByRole, getByText, getAllByPlaceholderText, addTask, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepYes'));

        fireEvent.click(getByText('+ process.addAnotherAction'));
        fireEvent.click(getByText('+ process.addAnotherAction'));
        const actionInputs = getAllByPlaceholderText('taskEdit.titleLabel');
        expect(actionInputs).toHaveLength(3);
        fireEvent.change(actionInputs[1], { target: { value: 'Book venue' } });
        fireEvent.change(actionInputs[2], { target: { value: '   ' } });

        fireEvent.click(getByText('process.createProject'));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
                projectId: 'project-1',
                status: 'next',
            }));
            expect(addTask).toHaveBeenCalledTimes(1);
            expect(addTask).toHaveBeenCalledWith('Book venue', {
                status: 'inbox',
                projectId: 'project-1',
            });
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

    it('preselects the area already assigned to the inbox task', () => {
        const { getByRole } = renderInboxProcessor({
            settings: {
                gtd: {
                    inboxProcessing: {
                        defaultMode: 'quick',
                    },
                },
            },
            tasks: [{ ...inboxTask, areaId: 'area-work' }],
            areas: [workArea],
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));

        // The dropdown must reflect what apply will save; resetting it to empty
        // silently dropped an area assigned while the task sat in the inbox.
        expect(getByRole('button', { name: 'Work' })).toBeTruthy();
    });

    it('filters quick processing project choices by the selected area', () => {
        const { getByRole, queryByRole } = renderInboxProcessor({
            settings: {
                gtd: {
                    inboxProcessing: {
                        defaultMode: 'quick',
                    },
                },
            },
            areas: [workArea, homeArea],
            projects: [workProject, homeProject],
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'projects.noArea' }));
        fireEvent.click(getByRole('option', { name: 'Work' }));
        fireEvent.click(getByRole('button', { name: 'process.project' }));

        expect(getByRole('option', { name: 'Work Project' })).toBeTruthy();
        expect(queryByRole('option', { name: 'Home Project' })).toBeNull();
    });

    it('shows area before project in guided project-first processing and filters projects', () => {
        const { container, getByRole, queryByRole } = renderInboxProcessor({
            settings: {
                gtd: {
                    inboxProcessing: {
                        projectFirst: true,
                    },
                },
            },
            areas: [workArea, homeArea],
            projects: [workProject, homeProject],
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));

        expect(container.innerHTML.indexOf('taskEdit.areaLabel')).toBeLessThan(
            container.innerHTML.indexOf('taskEdit.projectLabel'),
        );

        fireEvent.click(getByRole('button', { name: 'projects.noArea' }));
        fireEvent.click(getByRole('option', { name: 'Work' }));
        fireEvent.click(getByRole('button', { name: 'process.project' }));

        expect(getByRole('option', { name: 'Work Project' })).toBeTruthy();
        expect(queryByRole('option', { name: 'Home Project' })).toBeNull();
    });

    it('keeps processing cards from clipping project dropdowns', () => {
        const { getByRole, getByText } = renderInboxProcessor({
            gtd: {
                inboxProcessing: {
                    defaultMode: 'quick',
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        expect(getByText('process.quickDesc').closest('.rounded-xl')).toHaveClass('overflow-visible');

        fireEvent.click(getByRole('button', { name: 'process.modeGuided' }));
        expect(getByText('process.refineDesc').closest('.rounded-xl')).toHaveClass('overflow-visible');
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

    it('keeps scheduling hidden by default while reference stays available', () => {
        const { getByRole, getByText, queryByText } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));

        expect(queryByText('process.reference')).toBeNull();
        fireEvent.click(getByText('inbox.no'));
        expect(getByText('process.reference')).toBeTruthy();
        fireEvent.click(getByText('common.back'));

        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));

        expect(getByText('process.nextStepDesc')).toBeTruthy();
        expect(queryByText('taskEdit.startDateLabel')).toBeNull();
    });

    it('shows reference even when the old inbox reference setting is disabled', () => {
        const { getByRole, getByText } = renderInboxProcessor({
            gtd: {
                inboxProcessing: {
                    referenceEnabled: false,
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));

        fireEvent.click(getByText('inbox.no'));
        expect(getByText('process.reference')).toBeTruthy();
    });

    it('shows context and tag fields for quick Reference processing', async () => {
        const { getByRole, getByText, getByLabelText, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'process.modeQuick' }));
        fireEvent.click(getByText('process.reference'));
        fireEvent.change(getByLabelText('taskEdit.contextsLabel'), {
            target: { value: '@docs, @desk' },
        });
        fireEvent.change(getByLabelText('taskEdit.tagsLabel'), {
            target: { value: '#reference, #launch' },
        });

        fireEvent.click(getByRole('button', { name: 'process.next' }));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'reference',
                    contexts: ['@docs', '@desk'],
                    tags: ['#reference', '#launch'],
                }),
            );
        });
    });

    it('shows context and tag fields before confirming guided Reference processing', async () => {
        const user = userEvent.setup();
        const { getAllByRole, getByPlaceholderText, getByRole, getByText, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('inbox.no'));
        fireEvent.click(getByText('process.reference'));

        await user.type(getByPlaceholderText('@home'), '@docs, @desk');
        fireEvent.click(getAllByRole('button', { name: '+' })[0]);
        await user.type(getByPlaceholderText('#deep-work'), '#reference, #launch');
        fireEvent.click(getAllByRole('button', { name: '+' })[1]);

        fireEvent.click(getByRole('button', { name: /process\.next/ }));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'reference',
                    contexts: ['@docs', '@desk'],
                    tags: ['#reference', '#launch'],
                }),
            );
        });
    });

    it('shows scheduling options when enabled in settings and visible in the task editor layout', () => {
        const { getByRole, getByText } = renderInboxProcessor({
            gtd: {
                inboxProcessing: {
                    scheduleEnabled: true,
                },
                taskEditor: {
                    hidden: [],
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));

        fireEvent.click(getByText('inbox.no'));
        expect(getByText('process.reference')).toBeTruthy();
        fireEvent.click(getByText('common.back'));

        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));

        expect(getByText('taskEdit.startDateLabel')).toBeTruthy();
        expect(getByText('taskEdit.dueDateLabel')).toBeTruthy();
        expect(getByText('taskEdit.reviewDateLabel')).toBeTruthy();
    });

    it('moves a task to next with a date-only start date from the guided Start later shortcut', async () => {
        const { getByRole, getByText, getByLabelText, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        // Deferring a decided action is an actionable outcome, so it is offered
        // beside the question rather than under "No, not actionable" (#1089).
        fireEvent.click(getByText('Start later'));
        fireEvent.change(getByLabelText('taskEdit.startDateLabel'), {
            target: { value: '2026-03-23' },
        });
        fireEvent.click(getByText('Start later'));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'next',
                    startTime: '2026-03-23',
                }),
            );
        });
    });

    it('scrolls the processing panel back into view when advancing to the next task (#841)', async () => {
        const scrollIntoView = vi.fn();
        Element.prototype.scrollIntoView = scrollIntoView;
        const inboxTaskTwo: Task = { ...inboxTask, id: 'task-2', title: 'Second capture' };
        const { getByRole, updateTask } = renderInboxProcessor({
            settings: {
                gtd: {
                    inboxProcessing: {
                        defaultMode: 'quick',
                    },
                },
            },
            tasks: [inboxTask, inboxTaskTwo],
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        scrollIntoView.mockClear();
        fireEvent.click(getByRole('button', { name: 'process.next' }));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalled();
        });
        await waitFor(() => {
            expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
        });
    });

    it('moves a task to next with a date-only start date from the quick Start later outcome', async () => {
        const { getByRole, getByText, getByLabelText, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'process.modeQuick' }));
        fireEvent.click(getByText('Start later'));
        fireEvent.change(getByLabelText('taskEdit.startDateLabel'), {
            target: { value: '2026-03-24' },
        });
        fireEvent.click(getByRole('button', { name: 'process.next' }));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'next',
                    startTime: '2026-03-24',
                }),
            );
        });
    });

    // #1089: incubating parks the item without deciding what it is, and brings
    // it back to this pass on a date. Someday + a review date, which Daily and
    // Weekly Review already read as "due to reconsider".
    it('incubates a capture as Someday with the return date', async () => {
        const { getByRole, getByText, getByLabelText, updateTask } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('inbox.no'));
        fireEvent.click(getByText('Incubate'));
        fireEvent.change(getByLabelText('taskEdit.reviewDateLabel'), {
            target: { value: '2026-09-10' },
        });
        fireEvent.click(getByText('Incubate'));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'someday',
                    reviewAt: '2026-09-10',
                }),
            );
        });
    });

    it('brings a due incubated item back into the pass and says where it came from', async () => {
        const returning: Task = {
            id: 'task-returning',
            title: "Mom's birthday",
            status: 'someday',
            reviewAt: '2026-01-01',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const { getByRole, getByText } = renderInboxProcessor({ tasks: [returning] });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));

        expect(getByText("Mom's birthday")).toBeTruthy();
        expect(getByText('Back to clarify')).toBeTruthy();
    });

    it('hides organization fields when the task editor layout disables them', () => {
        const { getByRole, getByText, queryByLabelText } = renderInboxProcessor({
            gtd: {
                taskEditor: {
                    hidden: ['energyLevel', 'assignedTo', 'timeEstimate'],
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'process.modeQuick' }));

        expect(queryByLabelText('taskEdit.energyLevel')).toBeNull();
        expect(queryByLabelText('taskEdit.assignedTo')).toBeNull();
        expect(queryByLabelText('taskEdit.timeEstimateLabel')).toBeNull();

        fireEvent.click(getByRole('button', { name: 'process.modeGuided' }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));
        fireEvent.click(getByText('process.doIt'));

        expect(queryByLabelText('taskEdit.energyLevel')).toBeNull();
        expect(queryByLabelText('taskEdit.assignedTo')).toBeNull();
        expect(queryByLabelText('taskEdit.timeEstimateLabel')).toBeNull();
    });

    it('processes a task from quick mode with all visible organization and scheduling fields', async () => {
        const { getByRole, getByLabelText, updateTask } = renderInboxProcessor({
            gtd: {
                inboxProcessing: {
                    scheduleEnabled: true,
                },
                taskEditor: {
                    hidden: [],
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
        fireEvent.change(getByLabelText('taskEdit.timeEstimateLabel'), {
            target: { value: '30min' },
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
                    timeEstimate: '30min',
                    assignedTo: 'Morgan',
                    priority: 'high',
                    startTime: '2026-03-23',
                    dueDate: '2026-03-24',
                    reviewAt: '2026-03-25',
                }),
            );
        });
    });

    it('commits quick processing with Enter from title input and advances to the next item', async () => {
        const { getByRole, getByLabelText, getByDisplayValue, updateTask } = renderInboxProcessor({
            settings: {
                gtd: {
                    inboxProcessing: {
                        defaultMode: 'quick',
                    },
                },
            },
            tasks: [inboxTask, inboxTaskTwo],
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.change(getByLabelText('taskEdit.titleLabel'), {
            target: { value: 'Clarified launch' },
        });
        fireEvent.keyDown(getByLabelText('taskEdit.titleLabel'), { key: 'Enter' });

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    title: 'Clarified launch',
                    status: 'next',
                }),
            );
        });
        expect(getByDisplayValue('Follow up with Casey')).toBeTruthy();
    });

    it('commits quick processing with Ctrl+Enter without requiring input focus', async () => {
        const { getByRole, getByDisplayValue, updateTask } = renderInboxProcessor({
            settings: {
                gtd: {
                    inboxProcessing: {
                        defaultMode: 'quick',
                    },
                },
            },
            tasks: [inboxTask, inboxTaskTwo],
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true });

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    title: 'Plan launch',
                    status: 'next',
                }),
            );
        });
        expect(getByDisplayValue('Follow up with Casey')).toBeTruthy();
    });

    it('commits quick processing with Cmd+Enter from the description textarea', async () => {
        const { getByRole, getByLabelText, updateTask } = renderInboxProcessor({
            settings: {
                gtd: {
                    inboxProcessing: {
                        defaultMode: 'quick',
                    },
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.change(getByLabelText('taskEdit.descriptionLabel'), {
            target: { value: 'Captured context' },
        });
        fireEvent.keyDown(getByLabelText('taskEdit.descriptionLabel'), { key: 'Enter', metaKey: true });

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    description: 'Captured context',
                    status: 'next',
                }),
            );
        });
    });

    it('does not commit quick processing when Enter is used in the description textarea', () => {
        const { getByRole, getByLabelText, updateTask } = renderInboxProcessor({
            gtd: {
                inboxProcessing: {
                    defaultMode: 'quick',
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.keyDown(getByLabelText('taskEdit.descriptionLabel'), { key: 'Enter' });

        expect(updateTask).not.toHaveBeenCalled();
    });

    it('keeps quick context and tag inputs editable while typing multiple tokens', async () => {
        const user = userEvent.setup();
        const { getByRole, getByLabelText, updateTask } = renderInboxProcessor({
            gtd: {
                taskEditor: {
                    hidden: [],
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'process.modeQuick' }));

        const contextsInput = getByLabelText('taskEdit.contextsLabel') as HTMLInputElement;
        const tagsInput = getByLabelText('taskEdit.tagsLabel') as HTMLInputElement;
        await user.type(contextsInput, '@home, @desk');
        await user.type(tagsInput, '#deep, #writing');

        expect(contextsInput.value).toBe('@home, @desk');
        expect(tagsInput.value).toBe('#deep, #writing');

        fireEvent.click(getByRole('button', { name: 'process.next' }));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'next',
                    contexts: ['@home', '@desk'],
                    tags: ['#deep', '#writing'],
                }),
            );
        });
    });

    it('autocompletes quick processing context and tag inputs with ranked local labels', async () => {
        const user = userEvent.setup();
        const { getByRole, getByLabelText, updateTask } = renderInboxProcessor({
            settings: {
                gtd: {
                    taskEditor: {
                        hidden: [],
                    },
                },
            },
            allContexts: ['@school', '@office', '@chores'],
            allTags: ['#deep-work', '#writing'],
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'process.modeQuick' }));

        const contextsInput = getByLabelText('taskEdit.contextsLabel') as HTMLInputElement;
        const tagsInput = getByLabelText('taskEdit.tagsLabel') as HTMLInputElement;
        await user.type(contextsInput, 'of');
        fireEvent.keyDown(contextsInput, { key: 'ArrowDown' });
        fireEvent.keyDown(contextsInput, { key: 'Tab' });
        await waitFor(() => {
            expect(contextsInput.value).toBe('@office, ');
        });

        await user.type(tagsInput, 'wr');
        fireEvent.keyDown(tagsInput, { key: 'ArrowDown' });
        fireEvent.keyDown(tagsInput, { key: 'Tab' });
        await waitFor(() => {
            expect(tagsInput.value).toBe('#writing, ');
        });

        fireEvent.click(getByRole('button', { name: 'process.next' }));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'next',
                    contexts: ['@office'],
                    tags: ['#writing'],
                }),
            );
        });
    });

    it('adds multiple custom contexts and tags from guided processing inputs', async () => {
        const user = userEvent.setup();
        const { getAllByRole, getByPlaceholderText, getByRole, getByText, updateTask } = renderInboxProcessor({
            gtd: {
                taskEditor: {
                    hidden: [],
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));
        fireEvent.click(getByText('process.doIt'));

        await user.type(getByPlaceholderText('@home'), '@home, @desk');
        fireEvent.click(getAllByRole('button', { name: '+' })[0]);
        await user.type(getByPlaceholderText('#deep-work'), '#deep, #writing');
        fireEvent.click(getAllByRole('button', { name: '+' })[1]);

        fireEvent.click(getByRole('button', { name: /process\.next/ }));
        fireEvent.click(getByRole('button', { name: /process\.noProject/ }));

        await waitFor(() => {
            expect(updateTask).toHaveBeenCalledWith(
                'task-1',
                expect.objectContaining({
                    status: 'next',
                    contexts: ['@home', '@desk'],
                    tags: ['#deep', '#writing'],
                }),
            );
        });
    });

    it('prefills quick mode scheduling fields with the configured default time', async () => {
        const { getByRole, getByLabelText, updateTask } = renderInboxProcessor({
            gtd: {
                defaultScheduleTime: '09:00',
                inboxProcessing: {
                    scheduleEnabled: true,
                },
                taskEditor: {
                    hidden: [],
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'process.modeQuick' }));
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
                    startTime: '2026-03-23T09:00',
                    dueDate: '2026-03-24T09:00',
                    reviewAt: '2026-03-25T09:00',
                }),
            );
        });
    });

    it('parses quick-add date commands from the guided refine title before saving', async () => {
        const { getByRole, getByText, getByDisplayValue, updateTask } = renderInboxProcessor({
            quickAddAutoClean: true,
        });

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

    it('processes a task from guided mode with enabled optional organization fields', async () => {
        const { getByRole, getByText, updateTask } = renderInboxProcessor({
            gtd: {
                taskEditor: {
                    hidden: [],
                },
            },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByText('process.refineNext'));
        fireEvent.click(getByText('process.yesActionable'));
        fireEvent.click(getByText('process.moreThanOneStepNo'));
        fireEvent.click(getByText('process.takesLonger'));
        fireEvent.click(getByText('process.doIt'));
        fireEvent.change(getByRole('combobox', { name: 'taskEdit.energyLevel' }), {
            target: { value: 'high' },
        });
        fireEvent.change(getByRole('combobox', { name: 'taskEdit.timeEstimateLabel' }), {
            target: { value: '1hr' },
        });
        fireEvent.change(getByRole('combobox', { name: 'taskEdit.assignedTo' }), {
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
                    timeEstimate: '1hr',
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

    it('offers AI clarify in the guided refine step when AI is on (#1022)', () => {
        const { getByRole } = renderInboxProcessor({
            settings: { ai: { enabled: true, provider: 'openai' } },
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));

        expect(getByRole('button', { name: 'taskEdit.aiClarify' })).toBeInTheDocument();
    });

    it('does not show a delayed AI clarify response on the next inbox task', async () => {
        let resolveClarify!: (response: ClarifyResponse) => void;
        const delayedResponse = new Promise<ClarifyResponse>((resolve) => {
            resolveClarify = resolve;
        });
        clarifyTask.mockReturnValueOnce(delayedResponse);
        const { getByRole, getByText, queryByText } = renderInboxProcessor({
            settings: {
                ai: {
                    enabled: true,
                    provider: 'openai',
                    baseUrl: 'http://localhost:11434/v1',
                },
            },
            tasks: [inboxTask, inboxTaskTwo],
        });

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));
        fireEvent.click(getByRole('button', { name: 'taskEdit.aiClarify' }));
        await waitFor(() => {
            expect(clarifyTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Plan launch' }));
        });

        fireEvent.click(getByRole('button', { name: 'inbox.skip' }));
        await waitFor(() => {
            expect(getByText('Follow up with Casey')).toBeInTheDocument();
        });

        await act(async () => {
            resolveClarify({
                question: 'Which launch?',
                options: [{ label: 'Launch website', action: 'Launch website' }],
            });
            await delayedResponse;
        });

        expect(queryByText('Which launch?')).not.toBeInTheDocument();
        expect(queryByText('Launch website')).not.toBeInTheDocument();
    });

    it('leaves the refine step free of AI actions when AI is off', () => {
        const { getByRole, queryByRole } = renderInboxProcessor();

        fireEvent.click(getByRole('button', { name: /process\.btn/i }));

        expect(queryByRole('button', { name: 'taskEdit.aiClarify' })).not.toBeInTheDocument();
    });
});
