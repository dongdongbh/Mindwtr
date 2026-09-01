import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useTaskStore } from '@mindwtr/core';
import type { ComponentProps } from 'react';

import { LanguageProvider } from '../contexts/language-context';
import { QuickAddModal } from './QuickAddModal';
import { QUICK_ADD_MAIN_WINDOW_LABEL, QUICK_ADD_SAVED_EVENT } from '../lib/quick-add-saved-event';
import { useUiStore } from '../store/ui-store';

const tauriMocks = vi.hoisted(() => ({
    emitTo: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
    invoke: vi.fn<(_command?: string) => Promise<unknown>>(async () => false),
    listen: vi.fn(async () => () => undefined),
}));
const fsMocks = vi.hoisted(() => ({
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array()),
    remove: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
}));
const pathMocks = vi.hoisted(() => ({
    dataDir: vi.fn(async () => '/data'),
    join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));
const dataTransferMocks = vi.hoisted(() => ({
    createDesktopRecoverySnapshot: vi.fn(async () => 'data.snapshot.json'),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: tauriMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
    emitTo: tauriMocks.emitTo,
    listen: tauriMocks.listen,
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        hide: tauriMocks.hide,
    }),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { Data: 'Data' },
    mkdir: fsMocks.mkdir,
    readFile: fsMocks.readFile,
    remove: fsMocks.remove,
    writeFile: fsMocks.writeFile,
}));

vi.mock('@tauri-apps/api/path', () => ({
    dataDir: pathMocks.dataDir,
    join: pathMocks.join,
}));

vi.mock('../lib/data-transfer', () => ({
    createDesktopRecoverySnapshot: dataTransferMocks.createDesktopRecoverySnapshot,
}));

const initialTaskState = useTaskStore.getState();

const renderQuickAddModal = (props?: ComponentProps<typeof QuickAddModal>) => render(
    <LanguageProvider>
        <QuickAddModal {...props} />
    </LanguageProvider>
);

const createDeferred = <T = void>() => {
    let resolvePromise!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => {
        resolvePromise = done;
    });
    return {
        promise,
        resolve: (value?: T) => resolvePromise(value as T),
    };
};

const createImageClipboardData = (file: File) => ({
    files: [file],
    items: [{
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
    }],
});

beforeEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.clearAllMocks();
    act(() => {
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState((state) => ({
            ...state,
            _allProjects: [],
            _allAreas: [],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: 'all',
                },
                gtd: {
                    ...(state.settings?.gtd ?? {}),
                    defaultCaptureMethod: 'text',
                },
            },
        }));
        useUiStore.setState({
            editingTaskId: null,
            projectView: { selectedProjectId: null },
        });
    });
});

describe('QuickAddModal', () => {
    it('submits once and exposes a busy, non-dismissible state while saving', async () => {
        const deferred = createDeferred<{ success: true; id: string }>();
        const addTask = vi.fn(() => deferred.promise);
        act(() => {
            useTaskStore.setState((state) => ({ ...state, addTask }));
        });
        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Single flight' },
            }));
            await Promise.resolve();
        });

        const save = screen.getByRole('button', { name: 'Save' });
        await act(async () => {
            fireEvent.click(save);
            fireEvent.click(save);
            await Promise.resolve();
        });

        expect(addTask).toHaveBeenCalledTimes(1);
        expect(save).toBeDisabled();
        expect(save).toHaveAttribute('aria-busy', 'true');
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();

        await act(async () => {
            deferred.resolve({ success: true, id: 'task-id' });
            await deferred.promise;
        });

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('ignores duplicate open requests while the first open is still committing', async () => {
        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'First capture' },
            }));
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Second capture' },
            }));
            await Promise.resolve();
        });

        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        expect(screen.getByPlaceholderText('Add Task')).toHaveValue('First capture');
    });

    it('opens the standalone quick add window before data refresh resolves', async () => {
        const deferred = createDeferred();
        const fetchData = vi.fn(() => deferred.promise) as unknown as typeof initialTaskState.fetchData;
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                fetchData,
            }));
        });

        renderQuickAddModal({ standaloneWindow: true });

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Fast capture' },
            }));
            await Promise.resolve();
        });

        expect(fetchData).toHaveBeenCalledTimes(1);
        const backdrop = document.querySelector('[role="presentation"]');
        expect(backdrop).toHaveClass('bg-popover');
        expect(backdrop).not.toHaveClass('bg-black/50');
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Add Task')).toHaveValue('Fast capture');

        await act(async () => {
            deferred.resolve();
            await deferred.promise;
        });
    });

    it('notifies the main window after a standalone text quick add is saved', async () => {
        (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        const fetchData = vi.fn(async () => undefined) as unknown as typeof initialTaskState.fetchData;
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
                fetchData,
            }));
        });

        renderQuickAddModal({ standaloneWindow: true });

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Fast capture' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(tauriMocks.emitTo).toHaveBeenCalledWith(
                QUICK_ADD_MAIN_WINDOW_LABEL,
                QUICK_ADD_SAVED_EVENT,
                expect.objectContaining({ savedAt: expect.any(String) }),
            );
        });
        expect(addTask).toHaveBeenCalledWith('Fast capture', expect.objectContaining({ status: 'inbox' }));
    });

    it('uses the current area filter when default area mode is active', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
                _allAreas: [
                    {
                        id: 'area-home',
                        name: 'Home',
                        color: '#10b981',
                        order: 0,
                        createdAt: '2026-07-01T00:00:00.000Z',
                        updatedAt: '2026-07-01T00:00:00.000Z',
                    },
                    {
                        id: 'area-work',
                        name: 'Work',
                        color: '#3b82f6',
                        order: 1,
                        createdAt: '2026-07-01T00:00:00.000Z',
                        updatedAt: '2026-07-01T00:00:00.000Z',
                    },
                ],
                settings: {
                    ...state.settings,
                    filters: { ...(state.settings?.filters ?? {}), areaId: 'area-work' },
                    gtd: {
                        ...(state.settings?.gtd ?? {}),
                        defaultAreaMode: 'active',
                        defaultAreaId: 'area-home',
                    },
                },
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Area filtered capture' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(addTask).toHaveBeenCalledWith('Area filtered capture', expect.objectContaining({
                areaId: 'area-work',
                status: 'inbox',
            }));
        });
    });

    it('asks native code to hide standalone quick add without promoting the main window', async () => {
        (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

        renderQuickAddModal({ standaloneWindow: true });

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Close quietly' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => {
            expect(tauriMocks.invoke).toHaveBeenCalledWith('hide_quick_add_window');
        });
        expect(tauriMocks.hide).not.toHaveBeenCalled();
    });

    it("stars a task for Today's Focus from the add task modal", async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'File Q3 estimated tax payment' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: "Add to today's focus" }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(addTask).toHaveBeenCalledWith('File Q3 estimated tax payment', expect.objectContaining({
                status: 'inbox',
                isFocusedToday: true,
            }));
        });
    });

    it('creates a new quick-add project in the parsed area', async () => {
        const addProject = vi.fn(async () => ({
            id: 'project-launch',
            title: 'Launch',
            color: '#3b82f6',
            order: 0,
            status: 'active' as const,
            tagIds: [],
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
        }));
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addProject,
                addTask,
                settings: {
                    ...state.settings,
                    quickAddAutoClean: true,
                },
                _allAreas: [{
                    id: 'area-work',
                    name: 'Work',
                    color: '#3b82f6',
                    order: 0,
                    createdAt: '2026-04-01T00:00:00.000Z',
                    updatedAt: '2026-04-01T00:00:00.000Z',
                }],
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Plan campaign +Launch !Work' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(addProject).toHaveBeenCalledWith('Launch', expect.any(String), { areaId: 'area-work' });
        });
        expect(addTask).toHaveBeenCalledWith('Plan campaign', expect.objectContaining({
            projectId: 'project-launch',
            areaId: undefined,
        }));
    });

    it('opens the created project task when save and edit is requested', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-created' }));
        const navigateListener = vi.fn();
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });
        window.addEventListener('mindwtr:navigate', navigateListener);

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: {
                    initialValue: 'Draft launch brief',
                    initialProps: { projectId: 'project-launch', status: 'next' },
                },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save & edit' }));

        await waitFor(() => {
            expect(addTask).toHaveBeenCalledWith('Draft launch brief', expect.objectContaining({
                projectId: 'project-launch',
                status: 'next',
            }));
        });
        expect(useUiStore.getState().projectView.selectedProjectId).toBe('project-launch');
        expect(useUiStore.getState().editingTaskId).toBe('task-created');
        expect(useTaskStore.getState().highlightTaskId).toBe('task-created');
        expect(navigateListener).toHaveBeenCalledWith(expect.objectContaining({
            detail: { view: 'projects' },
        }));
        window.removeEventListener('mindwtr:navigate', navigateListener);
    });

    it('flashes the created row on a plain save from a project-preset capture (#916)', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-created' }));
        act(() => {
            useTaskStore.setState((state) => ({ ...state, addTask }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: {
                    initialValue: 'Draft launch brief',
                    initialProps: { projectId: 'project-launch', status: 'next' },
                },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(addTask).toHaveBeenCalled();
        });
        expect(useTaskStore.getState().highlightTaskId).toBe('task-created');
    });

    it('does not flash on a global capture with no project preset (#916)', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-global' }));
        act(() => {
            useTaskStore.setState((state) => ({ ...state, addTask }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: {
                    initialValue: 'Loose thought',
                    initialProps: { status: 'inbox' },
                },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(addTask).toHaveBeenCalled();
        });
        expect(useTaskStore.getState().highlightTaskId).toBeNull();
    });

    it('saves and opens the task for editing on Ctrl+Enter', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-shortcut' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Draft launch brief' },
            }));
            await Promise.resolve();
        });

        fireEvent.keyDown(screen.getByPlaceholderText('Add Task'), { key: 'Enter', ctrlKey: true });

        await waitFor(() => {
            expect(addTask).toHaveBeenCalledWith('Draft launch brief', expect.anything());
        });
        // The editing session starts only after the async save resolves.
        await waitFor(() => {
            expect(useUiStore.getState().editingTaskId).toBe('task-shortcut');
        });
    });

    it('saves and keeps the dialog open for the next entry on Shift+Enter', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-batch' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'First batch entry' },
            }));
            await Promise.resolve();
        });

        fireEvent.keyDown(screen.getByPlaceholderText('Add Task'), { key: 'Enter', shiftKey: true });

        await waitFor(() => {
            expect(addTask).toHaveBeenCalledWith('First batch entry', expect.anything());
        });
        // The dialog stays open with a cleared input, ready for the next task.
        // The clear happens after the async save resolves, so wait for it.
        await waitFor(() => {
            expect(screen.getByPlaceholderText('Add Task')).toHaveValue('');
        });
        expect(useUiStore.getState().editingTaskId).toBeNull();
    });

    it('keeps the Esc chip and hidden file input out of the dialog tab order', async () => {
        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Check tab stops' },
            }));
            await Promise.resolve();
        });

        const dialog = screen.getByRole('dialog');
        const closeButton = screen.getByRole('button', { name: 'Close' });
        const fileInput = screen.getByLabelText('Import text file');
        expect(closeButton).toHaveAttribute('tabindex', '-1');
        expect(fileInput).toHaveAttribute('tabindex', '-1');
        expect(document.querySelector('[role="button"][tabindex="0"][aria-label="Close"]')).toBeNull();

        const focusable = Array.from(
            dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')
        ).filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'));
        expect(focusable).not.toContain(closeButton);
        expect(focusable).not.toContain(fileInput);

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) throw new Error('Expected focusable Quick Add controls');
        last.focus();
        fireEvent.keyDown(last, { key: 'Tab' });
        expect(document.activeElement).toBe(first);
        expect(document.activeElement).not.toBe(closeButton);
    });

    it('attaches a pasted image to a text quick-add task', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Capture receipt' },
            }));
            await Promise.resolve();
        });

        const file = new File([new Uint8Array([1, 2, 3])], 'receipt.png', { type: 'image/png' });
        fireEvent.paste(screen.getByPlaceholderText('Add Task'), {
            clipboardData: createImageClipboardData(file),
        });

        await waitFor(() => {
            expect(fsMocks.writeFile).toHaveBeenCalled();
            expect(screen.getByText('1 image attached')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(addTask).toHaveBeenCalled());
        expect(fsMocks.mkdir).toHaveBeenCalledWith('/data/mindwtr/quick-add-images', {
            recursive: true,
        });
        expect(fsMocks.writeFile).toHaveBeenCalledWith(
            expect.stringMatching(/^\/data\/mindwtr\/quick-add-images\/mindwtr-paste-/),
            expect.any(Uint8Array),
        );
        expect(addTask).toHaveBeenCalledWith('Capture receipt', expect.objectContaining({
            attachments: [
                expect.objectContaining({
                    kind: 'file',
                    title: expect.stringContaining('Screenshot'),
                    uri: expect.stringContaining('/data/mindwtr/quick-add-images/mindwtr-paste-'),
                    mimeType: 'image/png',
                    size: 3,
                }),
            ],
        }));
    });

    it('falls back to the async clipboard API when the paste event is empty (WebKitGTK)', async () => {
        // WebKitGTK delivers no items, no files, and no text for an image paste;
        // the image is only reachable through navigator.clipboard.read() (#690).
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });
        const read = vi.fn(async () => [{
            types: ['image/png'],
            getType: async () => new Blob([new Uint8Array([9, 9, 9, 9])], { type: 'image/png' }),
        }]);
        const originalClipboard = navigator.clipboard;
        Object.defineProperty(navigator, 'clipboard', { value: { read }, configurable: true });

        try {
            renderQuickAddModal();
            await act(async () => {
                window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                    detail: { initialValue: 'Capture screenshot' },
                }));
                await Promise.resolve();
            });

            fireEvent.paste(screen.getByPlaceholderText('Add Task'), {
                clipboardData: { getData: () => '', types: [], files: [], items: [] },
            });

            await waitFor(() => {
                expect(read).toHaveBeenCalled();
                expect(screen.getByText('1 image attached')).toBeInTheDocument();
            });
            expect(fsMocks.writeFile).toHaveBeenCalledWith(
                expect.stringMatching(/^\/data\/mindwtr\/quick-add-images\/mindwtr-paste-/),
                expect.any(Uint8Array),
            );
        } finally {
            Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
        }
    });

    it('does not touch the async clipboard API for an ordinary text paste', async () => {
        const read = vi.fn(async () => []);
        const originalClipboard = navigator.clipboard;
        Object.defineProperty(navigator, 'clipboard', { value: { read }, configurable: true });

        try {
            renderQuickAddModal();
            await act(async () => {
                window.dispatchEvent(new CustomEvent('mindwtr:quick-add', { detail: {} }));
                await Promise.resolve();
            });

            fireEvent.paste(screen.getByPlaceholderText('Add Task'), {
                clipboardData: { getData: () => 'plain text', types: ['text/plain'], files: [], items: [] },
            });

            await act(async () => {
                await Promise.resolve();
            });
            expect(read).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
        }
    });

    it('creates a screenshot-titled task for an image-only quick add paste', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add'));
            await Promise.resolve();
        });

        const file = new File([new Uint8Array([4, 5])], 'screenshot.png', { type: 'image/png' });
        fireEvent.paste(screen.getByPlaceholderText('Add Task'), {
            clipboardData: createImageClipboardData(file),
        });

        await waitFor(() => {
            expect(screen.getByText('1 image attached')).toBeInTheDocument();
        });

        const saveButton = screen.getByRole('button', { name: 'Save' });
        await waitFor(() => expect(saveButton).not.toBeDisabled());
        fireEvent.click(saveButton);

        await waitFor(() => expect(addTask).toHaveBeenCalled());
        const [title, props] = addTask.mock.calls[0] as unknown as [string, Record<string, unknown>];
        expect(title).toContain('Screenshot');
        expect(props).toEqual(expect.objectContaining({
            status: 'inbox',
            attachments: [
                expect.objectContaining({
                    kind: 'file',
                    title: expect.stringContaining('Screenshot'),
                    mimeType: 'image/png',
                    size: 2,
                }),
            ],
        }));
    });

    it('confirms and creates one task per nonblank pasted text line', async () => {
        const addTasks = vi.fn(async () => ({ success: true, ids: ['task-id'] }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTasks,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add'));
            await Promise.resolve();
        });

        fireEvent.paste(screen.getByPlaceholderText('Add Task'), {
            clipboardData: {
                files: [],
                items: [],
                getData: (type: string) => type === 'text/plain'
                    ? 'Email Bob\nCall Alice\nReview notes'
                    : '',
            },
        });

        expect(await screen.findByText('Create 3 tasks?')).toBeInTheDocument();
        expect(screen.getByText('Email Bob')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Create tasks' }));

        await waitFor(() => expect(addTasks).toHaveBeenCalledTimes(1));
        expect(addTasks).toHaveBeenCalledWith([
            { title: 'Email Bob', initialProps: expect.objectContaining({ status: 'inbox' }) },
            { title: 'Call Alice', initialProps: expect.objectContaining({ status: 'inbox' }) },
            { title: 'Review notes', initialProps: expect.objectContaining({ status: 'inbox' }) },
        ]);
    });

    it('automatically keeps blank-line-separated project text as one task', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: {
                    initialProps: {
                        projectId: 'project-id',
                        status: 'next',
                    },
                },
            }));
            await Promise.resolve();
        });

        fireEvent.paste(screen.getByPlaceholderText('Add Task'), {
            clipboardData: {
                files: [],
                items: [],
                getData: (type: string) => type === 'text/plain'
                    ? 'WeCom message one\n\nWeCom message two'
                    : '',
            },
        });

        expect(screen.getByPlaceholderText('Add Task')).toHaveValue('WeCom message one WeCom message two');
        expect(screen.queryByText('Create 2 tasks?')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(addTask).toHaveBeenCalledTimes(1));
        expect(addTask).toHaveBeenCalledWith(
            'WeCom message one WeCom message two',
            expect.objectContaining({ projectId: 'project-id', status: 'next' }),
        );
    });

    it('imports a text file through the same bulk quick-add confirmation', async () => {
        const addTasks = vi.fn(async () => ({ success: true, ids: ['task-id'] }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTasks,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add'));
            await Promise.resolve();
        });

        const file = new File(['First imported task\nSecond imported task\n'], 'tasks.txt', { type: 'text/plain' });
        fireEvent.change(screen.getByLabelText('Import text file'), {
            target: { files: [file] },
        });

        expect(await screen.findByText('Create 2 tasks?')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Create tasks' }));

        await waitFor(() => expect(addTasks).toHaveBeenCalledTimes(1));
        expect(dataTransferMocks.createDesktopRecoverySnapshot).toHaveBeenCalledOnce();
        expect(dataTransferMocks.createDesktopRecoverySnapshot.mock.invocationCallOrder[0])
            .toBeLessThan(addTasks.mock.invocationCallOrder[0]);
        expect(addTasks).toHaveBeenCalledWith([
            { title: 'First imported task', initialProps: expect.objectContaining({ status: 'inbox' }) },
            { title: 'Second imported task', initialProps: expect.objectContaining({ status: 'inbox' }) },
        ]);
    });

    it('shows a settings notice and keeps the dialog open when speech-to-text is unconfigured', async () => {
        // #886: voice capture with no STT model/key configured must surface a translated
        // notice pointing at Settings instead of showing a recording indicator and then
        // silently aborting.
        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Voice note' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Audio' }));

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
            await Promise.resolve();
        });

        await waitFor(() => {
            expect(useUiStore.getState().toasts.some((toast) => (
                toast.message === 'Enable a speech-to-text model in Settings to use voice input.'
            ))).toBe(true);
        });

        // Dialog stays open and the recorder never engages.
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Start recording' })).toBeInTheDocument();
        expect(tauriMocks.invoke).not.toHaveBeenCalledWith('start_audio_recording');
    });

    it('starts recording when speech-to-text is configured (record gate agrees with the transcribe gate)', async () => {
        // The record gate and the transcribe gate both resolve readiness through
        // resolveSpeechCapture from the same settings snapshot, so a configured
        // offline provider must let recording proceed rather than showing the
        // "unconfigured" notice from the test above.
        (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        act(() => {
            useUiStore.setState({ toasts: [] });
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    ai: {
                        ...state.settings?.ai,
                        speechToText: {
                            enabled: true,
                            provider: 'whisper',
                            offlineModelPath: '/models/whisper.bin',
                        },
                    },
                },
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Voice note' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Audio' }));

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
            await Promise.resolve();
        });

        expect(tauriMocks.invoke).toHaveBeenCalledWith('start_audio_recording');
        expect(useUiStore.getState().toasts.some((toast) => (
            toast.message === 'Enable a speech-to-text model in Settings to use voice input.'
        ))).toBe(false);
    });

    it('owns audio processing as a non-dismissible capture submission', async () => {
        const stoppedCapture = createDeferred<{
            path: string;
            sampleRate: number;
            channels: number;
            size: number;
        }>();
        const addTask = vi.fn(async () => ({ success: true, id: 'audio-task' }));
        (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        tauriMocks.invoke.mockImplementation(async (command?: string) => {
            if (command === 'start_audio_recording') return undefined;
            if (command === 'stop_audio_recording') return stoppedCapture.promise;
            return false;
        });
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
                settings: {
                    ...state.settings,
                    ai: {
                        ...state.settings?.ai,
                        speechToText: {
                            enabled: true,
                            provider: 'whisper',
                            offlineModelPath: '/models/whisper.bin',
                        },
                    },
                },
            }));
        });
        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', { detail: { captureMode: 'audio' } }));
            await Promise.resolve();
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
            await Promise.resolve();
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
            await Promise.resolve();
        });

        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        await act(async () => {
            stoppedCapture.resolve({
                path: '/data/audio-a.wav',
                sampleRate: 16_000,
                channels: 1,
                size: 128,
            });
            await stoppedCapture.promise;
        });
        await waitFor(() => expect(addTask).toHaveBeenCalledTimes(1));
    });

    it('does not let an unmounted audio capture create into a reopened session', async () => {
        const stoppedCapture = createDeferred<{
            path: string;
            sampleRate: number;
            channels: number;
            size: number;
        }>();
        const addTask = vi.fn(async () => ({ success: true, id: 'stale-audio-task' }));
        (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        tauriMocks.invoke.mockImplementation(async (command?: string) => {
            if (command === 'start_audio_recording') return undefined;
            if (command === 'stop_audio_recording') return stoppedCapture.promise;
            return false;
        });
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
                settings: {
                    ...state.settings,
                    ai: {
                        ...state.settings?.ai,
                        speechToText: {
                            enabled: true,
                            provider: 'whisper',
                            offlineModelPath: '/models/whisper.bin',
                        },
                    },
                },
            }));
        });
        const first = renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', { detail: { captureMode: 'audio' } }));
            await Promise.resolve();
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
            await Promise.resolve();
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
            await Promise.resolve();
        });

        first.unmount();
        renderQuickAddModal();
        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Second capture' },
            }));
            await Promise.resolve();
        });

        await act(async () => {
            stoppedCapture.resolve({
                path: '/data/audio-a.wav',
                sampleRate: 16_000,
                channels: 1,
                size: 128,
            });
            await stoppedCapture.promise;
            await Promise.resolve();
        });

        expect(addTask).not.toHaveBeenCalled();
        expect(screen.getByPlaceholderText('Add Task')).toHaveValue('Second capture');
    });

    it('creates a bulk import in a single store commit (#942)', async () => {
        const lines = Array.from({ length: 100 }, (_, index) => `Item ${index + 1} of Example bulk import #DeleteMe`);
        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', { detail: {} }));
            await Promise.resolve();
        });

        await act(async () => {
            fireEvent.paste(screen.getByPlaceholderText('Add Task'), {
                clipboardData: { getData: () => lines.join('\n'), files: [], items: [] },
            });
            await Promise.resolve();
        });

        // A per-line write loop still ends with 100 tasks, so counting tasks alone
        // cannot catch a regression: pin the number of store commits instead.
        let commits = 0;
        const unsubscribe = useTaskStore.subscribe((state, prevState) => {
            if (state.lastDataChangeAt !== prevState.lastDataChangeAt) commits += 1;
        });
        try {
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Create tasks' }));
                await Promise.resolve();
            });
        } finally {
            unsubscribe();
        }

        expect(useTaskStore.getState().tasks).toHaveLength(100);
        expect(commits).toBe(1);
    });
});
