import React from 'react';
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { Modal, Platform, Text } from 'react-native';
import { TaskEditModal } from './task-edit-modal';

import {
    buildProjectNextActionPromptState,
    presentProjectNextActionPrompt,
    ProjectNextActionPromptProvider,
    ProjectNextActionEditor,
} from './project-next-action-prompt';

const { addTask, updateTask, updateProject, showToast, flushSave, persistSnapshot, logInfo, parseNextActionInput, storeState } = vi.hoisted(() => ({
    addTask: vi.fn(),
    updateTask: vi.fn(),
    updateProject: vi.fn(),
    showToast: vi.fn(),
    flushSave: vi.fn(),
    persistSnapshot: vi.fn(),
    logInfo: vi.fn().mockResolvedValue(undefined),
    parseNextActionInput: vi.fn((input: string, context: { projectId: string; sectionId?: string | null }) => ({
        title: `parsed:${input}`,
        props: { status: 'waiting', projectId: context.projectId, sectionId: context.sectionId },
    })),
    storeState: {
        addTask: vi.fn(),
        updateTask: vi.fn(),
        updateProject: vi.fn(),
        persistSnapshot: vi.fn(),
        projects: [] as any[],
        _allProjects: [] as any[],
        tasks: [] as any[],
        _allTasks: [] as any[],
        _tasksById: new Map<string, any>(),
        areas: [] as any[],
        settings: { gtd: {} } as any,
    },
}));

const translate = vi.hoisted(() => {
    const labels: Record<string, string> = {
        'common.skip': 'Skip',
        'projects.nextActionPromptTitle': "What's the next action?",
        'projects.nextActionPromptDesc': 'Choose or add the next action for {{project}}.',
        'projects.nextActionPromptChooseExisting': 'Choose an existing task',
        'projects.nextActionPromptAddNew': 'Add a new next action',
        'projects.nextActionPromptPlaceholder': 'New next action...',
        'projects.nextActionPromptAddButton': 'Add next action',
        'projects.nextActionPromptComplete': 'Complete project',
        'status.waiting': 'Waiting',
    };
    return (key: string) => labels[key] ?? key;
});

vi.mock('@mindwtr/core', async (importOriginal) => {
    const { mockCore } = await import('../test-support/mock-core');
    storeState.addTask = addTask;
    storeState.updateTask = updateTask;
    storeState.updateProject = updateProject;
    storeState.persistSnapshot = persistSnapshot;


    return mockCore(importOriginal, () => storeState, {
        parseProjectNextActionInput: parseNextActionInput,
        flushPendingSave: flushSave,
    });
});

vi.mock('../contexts/language-context', () => ({
    useLanguage: () => ({ t: translate }),
}));

vi.mock('../hooks/use-theme-colors', () => ({
    useThemeColors: () => ({
        cardBg: '#ffffff',
        text: '#111111',
        secondaryText: '#666666',
        border: '#dddddd',
        inputBg: '#f3f4f6',
        filterBg: '#e5e7eb',
        tint: '#2563eb',
        onTint: '#ffffff',
    }),
}));

vi.mock('../contexts/toast-context', () => ({
    ToastViewport: () => null,
    useToast: () => ({
        showToast,
    }),
}));

vi.mock('./task-edit-modal', () => ({
    TaskEditModal: vi.fn(() => null),
}));
vi.mock('../lib/app-log', () => ({ logInfo }));

describe('ProjectNextActionPromptProvider', () => {
    afterEach(async () => { await vi.dynamicImportSettled(); });
    const flattenText = (value: unknown): string => {
        if (typeof value === 'string' || typeof value === 'number') return String(value);
        if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
        if (value && typeof value === 'object') {
            const item = value as { children?: unknown; props?: { children?: unknown } };
            return flattenText(item.props?.children ?? item.children);
        }
        return '';
    };

    const hasText = (tree: renderer.ReactTestRenderer, text: string) =>
        tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;

    const currentTask = {
        id: 'current',
        title: 'Finish current step',
        status: 'next',
        projectId: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const candidateTask = {
        id: 'candidate',
        title: 'Draft follow-up',
        status: 'waiting',
        projectId: 'project-1',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
    };

    const project = {
        id: 'project-1',
        title: 'Launch plan',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        storeState.projects = [project];
        storeState._allProjects = [project];
        storeState.tasks = [currentTask, candidateTask];
        storeState._allTasks = [currentTask, candidateTask];
        storeState._tasksById = new Map([
            [currentTask.id, currentTask],
            [candidateTask.id, candidateTask],
        ]);
        addTask.mockResolvedValue({ success: true, id: 'created-task' });
        updateTask.mockResolvedValue({ success: true });
        updateProject.mockResolvedValue({ success: true });
        flushSave.mockResolvedValue(undefined);
        persistSnapshot.mockResolvedValue(undefined);
    });

    it('builds prompt data from an optimistic completed task snapshot', () => {
        const promptState = buildProjectNextActionPromptState({
            ...currentTask,
            status: 'done',
        } as any);

        expect(promptState?.projectId).toBe('project-1');
        expect(promptState?.candidates.map((task) => task.id)).toEqual(['candidate']);
    });

    it('releases the editor when the task has disappeared', async () => {
        const onClose = vi.fn();
        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(<ProjectNextActionEditor taskId="missing" onClose={onClose} />);
        });
        expect(onClose).toHaveBeenCalledOnce();
        expect(tree.root.findAllByType(TaskEditModal)).toHaveLength(0);
        await renderer.act(async () => { tree.unmount(); });
    });

    const openFilledPrompt = async () => {
        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(<ProjectNextActionPromptProvider><Text>App</Text></ProjectNextActionPromptProvider>);
        });
        await renderer.act(async () => {
            presentProjectNextActionPrompt({ ...currentTask, status: 'done', sectionId: 'section-1' } as any);
        });
        await renderer.act(async () => {
            tree.root.findByType('TextInput' as any).props.onChangeText('Follow up /inbox');
        });
        return tree;
    };

    it('saves once before opening the new task in the full editor', async () => {
        const created = { ...currentTask, id: 'created-task', sectionId: 'section-1', status: 'inbox' };
        let resolveSave!: (value: any) => void;
        addTask.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
        const tree = await openFilledPrompt();
        const button = tree.root.find((node) => node.props.accessibilityLabel === 'Save & edit');
        await renderer.act(async () => {
            button.props.onPress();
            button.props.onPress();
        });
        expect(addTask).toHaveBeenCalledTimes(1);
        expect(tree.root.findAllByType(TaskEditModal)).toHaveLength(0);
        await renderer.act(async () => {
            storeState.tasks = [...storeState.tasks, created];
            storeState._tasksById.set(created.id, created);
            resolveSave({ success: true, id: created.id });
        });
        const editor = tree.root.findByType(TaskEditModal);
        expect(editor.props.task).toEqual(created);
        expect(editor.props.defaultTab).toBe('task');
        expect(addTask).toHaveBeenCalledWith('parsed:Follow up /inbox', expect.objectContaining({ projectId: 'project-1', sectionId: 'section-1' }));
        await renderer.act(async () => {
            await editor.props.onSave(created.id, { status: 'inbox', dueDate: '2026-09-20', priority: 'high' });
        });
        expect(updateTask).toHaveBeenCalledWith(created.id, { status: 'inbox', dueDate: '2026-09-20', priority: 'high' });
        await renderer.act(async () => { tree.unmount(); });
    });

    it('keeps the title and does not open the editor after failed creation', async () => {
        addTask.mockResolvedValueOnce({ success: false, error: 'Storage unavailable' });
        const tree = await openFilledPrompt();
        await renderer.act(async () => {
            tree.root.find((node) => node.props.accessibilityLabel === 'Save & edit').props.onPress();
        });
        expect(tree.root.findByType('TextInput' as any).props.value).toBe('Follow up /inbox');
        expect(tree.root.findAllByType(TaskEditModal)).toHaveLength(0);
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Storage unavailable' }));
        await renderer.act(async () => { tree.unmount(); });
    });

    it('waits for disk persistence and retries the same optimistic task after a flush failure', async () => {
        const created = { ...currentTask, id: 'created-task' };
        let rejectFlush!: (error: Error) => void;
        flushSave.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFlush = reject; }));
        addTask.mockImplementationOnce(async () => {
            storeState._tasksById.set(created.id, created);
            return { success: true, id: created.id };
        });
        const tree = await openFilledPrompt();
        await renderer.act(async () => {
            tree.root.find((node) => node.props.accessibilityLabel === 'Save & edit').props.onPress();
        });
        expect(tree.root.findAllByType(TaskEditModal)).toHaveLength(0);
        await renderer.act(async () => { rejectFlush(new Error('Disk unavailable')); });
        expect(tree.root.findByType('TextInput' as any).props.editable).toBe(false);
        expect(tree.root.findAllByType(TaskEditModal)).toHaveLength(0);
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Disk unavailable' }));
        expect(logInfo).not.toHaveBeenCalled();
        await renderer.act(async () => {
            tree.root.find((node) => node.props.accessibilityLabel === 'Save & edit').props.onPress();
        });
        expect(addTask).toHaveBeenCalledOnce();
        expect(persistSnapshot).toHaveBeenCalledOnce();
        expect(flushSave).toHaveBeenCalledTimes(2);
        expect(tree.root.findByType(TaskEditModal).props.task.id).toBe(created.id);
        await vi.dynamicImportSettled();
        expect(logInfo).toHaveBeenCalledWith('Project next action saved for editing', {
            scope: 'project-next-action',
            extra: { releaseCheck: 'v1.3.1/next-action-save-edit', stage: 'persisted' },
        });
        await renderer.act(async () => { tree.unmount(); });
    });

    it('waits for iOS prompt dismissal before presenting the editor', async () => {
        const originalOS = Platform.OS;
        Platform.OS = 'ios';
        try {
            const created = { ...currentTask, id: 'created-task' };
            addTask.mockImplementationOnce(async () => {
                storeState._tasksById.set(created.id, created);
                return { success: true, id: created.id };
            });
            const tree = await openFilledPrompt();
            await renderer.act(async () => {
                tree.root.find((node) => node.props.accessibilityLabel === 'Save & edit').props.onPress();
            });
            expect(tree.root.findAllByType(TaskEditModal)).toHaveLength(0);
            const promptModal = tree.root.findByType(Modal);
            expect(promptModal.props.visible).toBe(false);
            await renderer.act(async () => { promptModal.props.onDismiss(); });
            expect(tree.root.findByType(TaskEditModal).props.task.id).toBe(created.id);
            await renderer.act(async () => { tree.unmount(); });
        } finally {
            Platform.OS = originalOS;
        }
    });

    it('keeps the prompt mounted after the triggering row unmounts', async () => {
        function Trigger({ visible }: { visible: boolean }) {
            if (!visible) return null;
            return (
                <Text
                    accessibilityLabel="Open next action prompt"
                    onPress={() => presentProjectNextActionPrompt({ ...currentTask, status: 'done' } as any)}
                >
                    Open
                </Text>
            );
        }

        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(
                <ProjectNextActionPromptProvider>
                    <Trigger visible />
                </ProjectNextActionPromptProvider>,
            );
            await Promise.resolve();
        });

        const trigger = tree.root.find((node) => node.props.accessibilityLabel === 'Open next action prompt');
        await renderer.act(async () => {
            trigger.props.onPress();
            await Promise.resolve();
        });

        expect(hasText(tree, "What's the next action?")).toBe(true);
        expect(hasText(tree, 'Draft follow-up')).toBe(true);

        await renderer.act(async () => {
            tree.update(
                <ProjectNextActionPromptProvider>
                    <Trigger visible={false} />
                </ProjectNextActionPromptProvider>,
            );
            await Promise.resolve();
        });

        expect(hasText(tree, 'Draft follow-up')).toBe(true);

        const candidate = tree.root.find((node) => node.props.accessibilityLabel === 'Draft follow-up');
        await renderer.act(async () => {
            candidate.props.onPress();
            await Promise.resolve();
        });

        expect(updateTask).toHaveBeenCalledWith('candidate', { status: 'next' });
    });

    it('keeps the prompt open and reports failed next-action updates', async () => {
        updateTask.mockResolvedValueOnce({ success: false, error: 'Project is locked' });

        function Trigger() {
            return (
                <Text
                    accessibilityLabel="Open next action prompt"
                    onPress={() => presentProjectNextActionPrompt({ ...currentTask, status: 'done' } as any)}
                >
                    Open
                </Text>
            );
        }

        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(
                <ProjectNextActionPromptProvider>
                    <Trigger />
                </ProjectNextActionPromptProvider>,
            );
            await Promise.resolve();
        });

        const trigger = tree.root.find((node) => node.props.accessibilityLabel === 'Open next action prompt');
        await renderer.act(async () => {
            trigger.props.onPress();
            await Promise.resolve();
        });

        const candidate = tree.root.find((node) => node.props.accessibilityLabel === 'Draft follow-up');
        await renderer.act(async () => {
            candidate.props.onPress();
            await Promise.resolve();
        });

        expect(hasText(tree, "What's the next action?")).toBe(true);
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Project is locked',
            tone: 'error',
        }));
    });

    it('keeps the prompt open and reports a synchronously thrown next-action update', async () => {
        updateTask.mockImplementationOnce(() => {
            throw new Error('Adapter failed immediately');
        });

        function Trigger() {
            return (
                <Text
                    accessibilityLabel="Open next action prompt"
                    onPress={() => presentProjectNextActionPrompt({ ...currentTask, status: 'done' } as any)}
                >
                    Open
                </Text>
            );
        }

        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(
                <ProjectNextActionPromptProvider>
                    <Trigger />
                </ProjectNextActionPromptProvider>,
            );
            await Promise.resolve();
        });

        const trigger = tree.root.find((node) => node.props.accessibilityLabel === 'Open next action prompt');
        await renderer.act(async () => {
            trigger.props.onPress();
            await Promise.resolve();
        });

        const candidate = tree.root.find((node) => node.props.accessibilityLabel === 'Draft follow-up');
        await renderer.act(async () => {
            candidate.props.onPress();
            await Promise.resolve();
        });

        expect(hasText(tree, "What's the next action?")).toBe(true);
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Adapter failed immediately',
            tone: 'error',
        }));
    });

    it('archives the project when the complete action is chosen', async () => {
        function Trigger() {
            return (
                <Text
                    accessibilityLabel="Open next action prompt"
                    onPress={() => presentProjectNextActionPrompt({ ...currentTask, status: 'done' } as any)}
                >
                    Open
                </Text>
            );
        }

        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(
                <ProjectNextActionPromptProvider>
                    <Trigger />
                </ProjectNextActionPromptProvider>,
            );
            await Promise.resolve();
        });

        const trigger = tree.root.find((node) => node.props.accessibilityLabel === 'Open next action prompt');
        await renderer.act(async () => {
            trigger.props.onPress();
            await Promise.resolve();
        });

        const completeButton = tree.root.find((node) => node.props.accessibilityLabel === 'Complete project');
        await renderer.act(async () => {
            completeButton.props.onPress();
            await Promise.resolve();
        });

        expect(updateProject).toHaveBeenCalledWith('project-1', { status: 'archived' });
        expect(hasText(tree, "What's the next action?")).toBe(false);
    });

    it('routes new next-action input through the quick-add parser (#859)', async () => {
        function Trigger() {
            return (
                <Text
                    accessibilityLabel="Open next action prompt"
                    onPress={() => presentProjectNextActionPrompt({ ...currentTask, status: 'done', sectionId: 'section-1' } as any)}
                >
                    Open
                </Text>
            );
        }

        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(
                <ProjectNextActionPromptProvider>
                    <Trigger />
                </ProjectNextActionPromptProvider>,
            );
            await Promise.resolve();
        });

        const trigger = tree.root.find((node) => node.props.accessibilityLabel === 'Open next action prompt');
        await renderer.act(async () => {
            trigger.props.onPress();
            await Promise.resolve();
        });

        const input = tree.root.find((node) => node.props.placeholder === 'New next action...');
        await renderer.act(async () => {
            input.props.onChangeText('Chase reply /waiting');
            await Promise.resolve();
        });

        const addButton = tree.root.find((node) => flattenText(node.props?.children) === 'Add next action' && Boolean(node.props.onPress));
        await renderer.act(async () => {
            addButton.props.onPress();
            await Promise.resolve();
        });

        expect(parseNextActionInput).toHaveBeenCalledWith('Chase reply /waiting', expect.objectContaining({
            projectId: 'project-1',
            sectionId: 'section-1',
            projects: storeState.projects,
        }));
        expect(addTask).toHaveBeenCalledWith('parsed:Chase reply /waiting', {
            status: 'waiting',
            projectId: 'project-1',
            sectionId: 'section-1',
        });
    });

    it('parses new next actions with the shared quick-add options', async () => {
        const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
        parseNextActionInput.mockImplementationOnce(actual.parseProjectNextActionInput as never);
        const settings = storeState.settings;
        storeState.settings = { gtd: {}, features: { priorities: false, timeEstimates: false } };
        try {
            function Trigger() {
                return (
                    <Text
                        accessibilityLabel="Open next action prompt"
                        onPress={() => presentProjectNextActionPrompt({ ...currentTask, status: 'done' } as any)}
                    >
                        Open
                    </Text>
                );
            }

            let tree!: renderer.ReactTestRenderer;
            await renderer.act(async () => {
                tree = renderer.create(
                    <ProjectNextActionPromptProvider>
                        <Trigger />
                    </ProjectNextActionPromptProvider>,
                );
                await Promise.resolve();
            });
            await renderer.act(async () => {
                tree.root.find((node) => node.props.accessibilityLabel === 'Open next action prompt').props.onPress();
                await Promise.resolve();
            });
            await renderer.act(async () => {
                tree.root.find((node) => node.props.placeholder === 'New next action...').props.onChangeText('Call vendor /priority:high /estimate:45m');
                await Promise.resolve();
            });
            await renderer.act(async () => {
                tree.root.find((node) => flattenText(node.props?.children) === 'Add next action' && Boolean(node.props.onPress)).props.onPress();
                await Promise.resolve();
            });

            expect(addTask).toHaveBeenCalledTimes(1);
            const props = addTask.mock.calls[0][1];
            expect(props).not.toHaveProperty('priority');
            expect(props).not.toHaveProperty('timeEstimate');
        } finally {
            storeState.settings = settings;
        }
    });
});
