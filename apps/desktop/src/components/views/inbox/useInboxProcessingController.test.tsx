import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Area, Project, Task } from '@mindwtr/core';
import { useInboxProcessingController } from './useInboxProcessingController';

const makeTask = (id: string, status: Task['status'] = 'inbox'): Task => ({
    id,
    title: `Task ${id}`,
    status,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
} as Task);

describe('useInboxProcessingController session reconciliation', () => {
    it('advances when the current task leaves Inbox and closes when none remain', async () => {
        const setProcessingSpy = vi.fn();
        const initialTasks = [makeTask('one'), makeTask('two')];
        const { result, rerender } = renderHook(
            ({ tasks }: { tasks: Task[] }) => {
                const [isProcessing, setIsProcessingState] = useState(true);
                const setIsProcessing = (value: boolean) => {
                    setProcessingSpy(value);
                    setIsProcessingState(value);
                };
                return {
                    isProcessing,
                    controller: useInboxProcessingController({
                        t: (key) => key,
                        tasks,
                        projects: [],
                        areas: [],
                        settings: {},
                        addProject: async () => null,
                        addTask: async () => ({ success: true }),
                        updateTask: async () => ({ success: true }),
                        deleteTask: async () => ({ success: true }),
                        allContexts: [],
                        allTags: [],
                        isProcessing,
                        setIsProcessing,
                    }),
                };
            },
            { initialProps: { tasks: initialTasks } },
        );

        await waitFor(() => {
            expect(result.current.controller.wizardProps.processingTask?.id).toBe('one');
        });

        rerender({ tasks: [makeTask('one', 'next'), makeTask('two')] });

        await waitFor(() => {
            expect(result.current.controller.wizardProps.processingTask?.id).toBe('two');
        });

        rerender({ tasks: [makeTask('one', 'next'), makeTask('two', 'done')] });

        await waitFor(() => {
            expect(result.current.isProcessing).toBe(false);
        });
        expect(setProcessingSpy).toHaveBeenLastCalledWith(false);
    });
});

describe('useInboxProcessingController not-actionable destinations', () => {
    const tasks = [makeTask('one')];
    const projects = [
        { id: 'p1', title: 'Project', status: 'active' } as Project,
        { id: 'p2', title: 'Work Project', status: 'active', areaId: 'area-1' } as Project,
    ];
    const areas: never[] = [];
    const tokens: string[] = [];
    const settings = {};

    const renderController = (
        updateTask: ReturnType<typeof vi.fn>,
        controllerSettings: Parameters<typeof useInboxProcessingController>[0]['settings'] = settings,
    ) => renderHook(() => {
        // The session closes itself once the queue drains, so isProcessing has
        // to be real state or the reconciliation effect never settles.
        const [isProcessing, setIsProcessing] = useState(true);
        return useInboxProcessingController({
            t: (key) => key,
            tasks,
            projects,
            areas,
            settings: controllerSettings,
            addProject: async () => null,
            addTask: async () => ({ success: true }),
            updateTask,
            deleteTask: async () => ({ success: true }),
            allContexts: tokens,
            allTags: tokens,
            isProcessing,
            setIsProcessing,
        });
    });

    // #958: picking a project and then sending the item to Reference/Someday
    // used to write only the status, silently dropping the project.
    it.each([
        ['reference', (wizard: ReturnType<typeof renderController>['result']['current']['wizardProps']) => wizard.handleConfirmReference()],
        ['someday', (wizard: ReturnType<typeof renderController>['result']['current']['wizardProps']) => wizard.handleConfirmSomeday()],
    ] as const)('keeps the picked project when the item goes to %s', async (status, commit) => {
        const updateTask = vi.fn(async () => ({ success: true }));
        const { result } = renderController(updateTask);

        await waitFor(() => {
            expect(result.current.wizardProps.processingTask?.id).toBe('one');
        });

        act(() => {
            result.current.wizardProps.setField('projectId', 'p1');
        });
        await act(async () => {
            await commit(result.current.wizardProps);
        });

        expect(updateTask).toHaveBeenCalledWith('one', expect.objectContaining({
            status,
            projectId: 'p1',
        }));
    });

    it('routes guided Someday through organization controls before committing', async () => {
        const updateTask = vi.fn(async () => ({ success: true }));
        const { result } = renderController(updateTask);

        await waitFor(() => {
            expect(result.current.wizardProps.processingTask?.id).toBe('one');
        });
        await act(async () => {
            await result.current.wizardProps.handleNotActionable('someday');
        });

        expect(result.current.wizardProps.processingStep).toBe('someday');
        expect(updateTask).not.toHaveBeenCalled();
    });

    it('keeps picked organization fields when delegated to Waiting', async () => {
        const updateTask = vi.fn(async () => ({ success: true }));
        const { result } = renderController(updateTask);

        await waitFor(() => {
            expect(result.current.wizardProps.processingTask?.id).toBe('one');
        });

        act(() => {
            result.current.wizardProps.setField('projectId', 'p1');
            result.current.wizardProps.toggleContext('@work');
            result.current.wizardProps.toggleTag('#follow-up');
        });
        await act(async () => {
            await result.current.wizardProps.handleConfirmWaiting();
        });

        expect(updateTask).toHaveBeenCalledWith('one', expect.objectContaining({
            status: 'waiting',
            projectId: 'p1',
            contexts: ['@work'],
            tags: ['#follow-up'],
        }));
    });

    it('lets the explicit Waiting follow-up override a parsed review command', async () => {
        const updateTask = vi.fn(async () => ({ success: true }));
        const { result } = renderController(updateTask);

        await waitFor(() => {
            expect(result.current.wizardProps.processingTask?.id).toBe('one');
        });

        act(() => {
            result.current.wizardProps.setField('title', 'Task one /review:2026-09-10');
            result.current.wizardProps.setDelegateFollowUp('2026-09-20');
        });
        await act(async () => {
            await result.current.wizardProps.handleConfirmWaiting();
        });

        expect(updateTask).toHaveBeenCalledWith('one', expect.objectContaining({
            status: 'waiting',
            reviewAt: new Date('2026-09-20T09:00:00').toISOString(),
        }));
    });

    it('lets the explicit Later date override a parsed start command', async () => {
        const updateTask = vi.fn(async () => ({ success: true }));
        const { result } = renderController(updateTask);

        await waitFor(() => {
            expect(result.current.wizardProps.processingTask?.id).toBe('one');
        });

        act(() => {
            result.current.wizardProps.setField(
                'title',
                'Task one /start:2026-09-10 /due:2026-09-11 /review:2026-09-12',
            );
            result.current.wizardProps.scheduleFields.start.onDateChange('2026-09-20');
        });
        await act(async () => {
            await result.current.wizardProps.handleLater();
        });

        expect(updateTask).toHaveBeenCalledWith('one', expect.objectContaining({
            status: 'next',
            startTime: '2026-09-20',
            dueDate: expect.stringContaining('2026-09-11'),
            reviewAt: expect.stringContaining('2026-09-12'),
        }));
    });

    it.each([
        ['start', 'startTime', '/start:2026-09-10'],
        ['due', 'dueDate', '/due:2026-09-10'],
        ['review', 'reviewAt', '/review:2026-09-10'],
    ] as const)(
        'lets a changed visible %s control override its parsed title command',
        async (control, field, command) => {
            const updateTask = vi.fn(async () => ({ success: true }));
            const { result } = renderController(updateTask, {
                gtd: {
                    inboxProcessing: { scheduleEnabled: true },
                    taskEditor: { hidden: [] },
                },
            });

            await waitFor(() => {
                expect(result.current.wizardProps.processingTask?.id).toBe('one');
            });

            act(() => {
                result.current.wizardProps.setField('title', `Call Sam ${command}`);
                result.current.wizardProps.scheduleFields[control].onDateChange('2026-09-20');
            });
            await act(async () => {
                await result.current.wizardProps.handleSetProject(null);
            });

            expect(updateTask).toHaveBeenCalledWith('one', expect.objectContaining({
                status: 'next',
                [field]: '2026-09-20',
            }));
        },
    );

    it('lets an explicitly cleared visible date control override a parsed command on Complete', async () => {
        const updateTask = vi.fn(async () => ({ success: true }));
        const { result } = renderController(updateTask, {
            gtd: {
                inboxProcessing: { scheduleEnabled: true },
                taskEditor: { hidden: [] },
            },
        });

        await waitFor(() => {
            expect(result.current.wizardProps.processingTask?.id).toBe('one');
        });

        act(() => {
            result.current.wizardProps.setField('title', 'Call Sam /review:2026-09-10');
            result.current.wizardProps.scheduleFields.review.onClear();
        });
        await act(async () => {
            await result.current.wizardProps.handleTwoMinDone();
        });

        expect(updateTask).toHaveBeenCalledWith('one', expect.objectContaining({
            status: 'done',
            reviewAt: undefined,
        }));
    });

    it('keeps a parsed due command on Next when scheduling controls are off', async () => {
        const updateTask = vi.fn(async () => ({ success: true }));
        const { result } = renderController(updateTask);

        await waitFor(() => {
            expect(result.current.wizardProps.processingTask?.id).toBe('one');
        });

        act(() => {
            result.current.wizardProps.setField('title', 'Call Sam /due:2026-09-21');
        });
        await act(async () => {
            await result.current.wizardProps.handleSetProject(null);
        });

        expect(updateTask).toHaveBeenCalledWith('one', expect.objectContaining({
            status: 'next',
            dueDate: expect.stringContaining('2026-09-21'),
        }));
    });

    it('keeps a parsed review command on Complete when scheduling controls are off', async () => {
        const updateTask = vi.fn(async () => ({ success: true }));
        const { result } = renderController(updateTask);

        await waitFor(() => {
            expect(result.current.wizardProps.processingTask?.id).toBe('one');
        });

        act(() => {
            result.current.wizardProps.setField('title', 'Call Sam /review:2026-09-22');
        });
        await act(async () => {
            await result.current.wizardProps.handleTwoMinDone();
        });

        expect(updateTask).toHaveBeenCalledWith('one', expect.objectContaining({
            status: 'done',
            reviewAt: expect.stringContaining('2026-09-22'),
        }));
    });
});

describe('useInboxProcessingController draft writes', () => {
    const tasks = [makeTask('one')];
    const projects = [
        { id: 'p1', title: 'Project', status: 'active' } as Project,
        { id: 'p2', title: 'Work Project', status: 'active', areaId: 'area-1' } as Project,
    ];

    const renderController = () => renderHook(() => {
        const [isProcessing, setIsProcessing] = useState(true);
        return useInboxProcessingController({
            t: (key) => key,
            tasks,
            projects,
            areas: [],
            settings: {},
            addProject: async () => null,
            addTask: async () => ({ success: true }),
            updateTask: async () => ({ success: true }),
            deleteTask: async () => ({ success: true }),
            allContexts: [],
            allTags: [],
            isProcessing,
            setIsProcessing,
        });
    });

    const openFirstTask = async (result: ReturnType<typeof renderController>['result']) => {
        await waitFor(() => {
            expect(result.current.wizardProps.processingTask?.id).toBe('one');
        });
    };

    it('routes field writes through the core draft reducer', async () => {
        const { result } = renderController();
        await openFirstTask(result);

        act(() => {
            result.current.wizardProps.setField('title', 'Clarified');
        });
        const draft = result.current.wizardProps.draft;
        expect(draft.title).toBe('Clarified');

        // The reducer hands back the same draft when the value is unchanged; a
        // hand-rolled spread would allocate a new one on every keystroke.
        act(() => {
            result.current.wizardProps.setField('title', 'Clarified');
        });
        expect(result.current.wizardProps.draft).toBe(draft);
    });

    it('drops a project that lives outside a newly picked area, and keeps one inside it', async () => {
        const { result } = renderController();
        await openFirstTask(result);

        act(() => {
            result.current.wizardProps.setField('projectId', 'p1');
        });
        act(() => {
            result.current.wizardProps.setField('areaId', 'area-1');
        });
        expect(result.current.wizardProps.draft).toMatchObject({ areaId: 'area-1', projectId: '' });

        act(() => {
            result.current.wizardProps.setField('projectId', 'p2');
        });
        act(() => {
            result.current.wizardProps.setField('areaId', 'area-1');
        });
        expect(result.current.wizardProps.draft).toMatchObject({ areaId: 'area-1', projectId: 'p2' });
    });
});

// #1088: the clarify title used to run a date-only parser, so it was the one
// editable task title in the app with a smaller grammar than quick add.
describe('useInboxProcessingController title grammar', () => {
    const tasks = [makeTask('one')];
    const projects = [{ id: 'p1', title: 'Vacation', status: 'active' } as Project];
    const areas = [{ id: 'a1', name: 'Work', order: 0 } as Area];

    const renderController = (updateTask: ReturnType<typeof vi.fn>) => renderHook(() => {
        const [isProcessing, setIsProcessing] = useState(true);
        return useInboxProcessingController({
            t: (key) => key,
            tasks,
            projects,
            areas,
            settings: {},
            addProject: async () => null,
            addTask: async () => ({ success: true }),
            updateTask,
            deleteTask: async () => ({ success: true }),
            allContexts: [],
            allTags: [],
            isProcessing,
            setIsProcessing,
        });
    });

    it('applies the quick-add tokens typed into the title to the clarified task', async () => {
        const updateTask = vi.fn(async () => ({ success: true }));
        const { result } = renderController(updateTask);

        await waitFor(() => {
            expect(result.current.wizardProps.processingTask?.id).toBe('one');
        });

        act(() => {
            result.current.wizardProps.toggleContext('@office');
            result.current.wizardProps.setField(
                'title',
                'Call Alice @phone #urgent !Work /due:2026-09-01',
            );
        });
        await act(async () => {
            await result.current.wizardProps.handleSetProject(null);
        });

        expect(updateTask).toHaveBeenCalledWith('one', expect.objectContaining({
            status: 'next',
            title: 'Call Alice',
            // The typed context joins the chip the user toggled; it never wins alone.
            contexts: ['@office', '@phone'],
            tags: ['#urgent'],
            areaId: 'a1',
        }));
        expect(updateTask).toHaveBeenCalledWith('one', expect.objectContaining({
            dueDate: expect.stringContaining('2026-09-01'),
        }));
    });
});
