import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, fireEvent, waitFor, within } from '@testing-library/react';
import { TaskItem } from './TaskItem';
import { Task, useTaskStore } from '@mindwtr/core';
import { LanguageProvider } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';

const dictationMocks = vi.hoisted(() => ({
    startAudioCapture: vi.fn(),
    processAudioCapture: vi.fn(),
    resolveSpeechCapture: vi.fn(async () => ({ ready: true, config: {} })),
    remove: vi.fn(async () => undefined),
}));

vi.mock('../lib/audio-capture', () => ({
    startAudioCapture: dictationMocks.startAudioCapture,
}));
vi.mock('../lib/speech-to-text', () => ({
    processAudioCapture: dictationMocks.processAudioCapture,
    resolveSpeechCapture: dictationMocks.resolveSpeechCapture,
}));
vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => ({
    ...await importOriginal<typeof import('@tauri-apps/plugin-fs')>(),
    remove: dictationMocks.remove,
}));

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
        vi.clearAllMocks();
        dictationMocks.resolveSpeechCapture.mockResolvedValue({ ready: true, config: {} });
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
            fireEvent.click(getAllByRole('button', { name: 'Mark Done' })[0]);
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
        const input = within(dialog).getByRole('textbox', { name: 'Add link' });
        await act(async () => {
            fireEvent.change(input, { target: { value: 'https://example.com/spec' } });
        });
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: /save/i }));
        });


        await waitFor(() => expect(container.ownerDocument.body.textContent).toContain('example.com'));


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

    it('keeps failed dictation in the attachment draft so Save can retry without overwriting other attachments', async () => {
        const task: Task = { ...baseTask, id: 'dictation-retry' };
        const latestStoreAttachment = {
            id: 'latest-store-file',
            kind: 'file' as const,
            title: 'Latest store file',
            uri: '/data/mindwtr/attachments/latest-store-file.pdf',
            createdAt: '2026-09-22T00:00:00.000Z',
            updatedAt: '2026-09-22T00:00:00.000Z',
        };
        const capture = {
            path: '/data/audio-captures/mindwtr-audio-20260922T100000-uuid.wav',
            name: 'mindwtr-audio-20260922T100000-uuid.wav',
            mimeType: 'audio/wav' as const,
            size: 64,
            bytes: async () => new Uint8Array([1, 2, 3]),
        };
        const updateTask = vi.fn()
            .mockResolvedValueOnce({ success: false as const, error: 'Store rejected update' })
            .mockResolvedValueOnce({ success: true as const });
        dictationMocks.startAudioCapture.mockResolvedValue({
            backend: 'native',
            stop: async () => capture,
            cancel: async () => undefined,
        });
        dictationMocks.processAudioCapture.mockRejectedValue(new Error('Whisper model not found'));
        seed(task);
        act(() => useTaskStore.setState({ updateTask }));
        const view = render(
            <LanguageProvider>
                <TaskItem task={task} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(view.getAllByRole('button', { name: /edit/i })[0]);
        });
        const detailsToggle = view.getByRole('button', { name: /^details\b/i, expanded: false });
        await act(async () => fireEvent.click(detailsToggle));
        await act(async () => fireEvent.click(view.getAllByRole('button', { name: /add link/i })[0]));
        const linkDialog = await waitFor(() => view.getByRole('dialog'));
        fireEvent.change(within(linkDialog).getByRole('textbox', { name: 'Add link' }), {
            target: { value: 'https://example.com/unsaved' },
        });
        await act(async () => fireEvent.click(within(linkDialog).getByRole('button', { name: /save/i })));

        await act(async () => fireEvent.click(view.getByRole('button', { name: 'Dictate description' })));
        act(() => {
            const latestTask = { ...task, attachments: [latestStoreAttachment] };
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [latestTask],
                _allTasks: [latestTask],
                _tasksById: new Map([[latestTask.id, latestTask]]),
            }));
        });
        await act(async () => fireEvent.click(view.getByRole('button', { name: 'Stop dictation' })));
        await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1));

        fireEvent.change(view.getByDisplayValue('Repro Task'), {
            target: { value: 'Edited after Keep' },
        });
        await act(async () => fireEvent.click(view.getByRole('button', { name: 'Save' })));
        await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(2));

        const retryPatch = updateTask.mock.calls[1]?.[1] as Partial<Task>;
        expect(retryPatch.title).toBe('Edited after Keep');
        expect(retryPatch.attachments?.map((attachment) => attachment.uri)).toEqual([
            latestStoreAttachment.uri,
            'https://example.com/unsaved',
            capture.path,
        ]);
        expect(dictationMocks.remove).not.toHaveBeenCalledWith(capture.path);
    });
});
