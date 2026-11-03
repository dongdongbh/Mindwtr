import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { Project, Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';

import { LanguageProvider } from '../contexts/language-context';
import { MINDWTR_NAVIGATE_EVENT } from '../lib/navigation-events';
import { useUiStore } from '../store/ui-store';
import { createInternalMarkdownLinkContext, InternalMarkdownLink } from './InternalMarkdownLink';

const openShellMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openShellMock }));

const sandboxState = vi.hoisted(() => ({ enabled: false }));
vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@mindwtr/core')>(),
    isSandboxMode: () => sandboxState.enabled,
}));

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();

describe('InternalMarkdownLink', () => {
    beforeEach(() => {
        sandboxState.enabled = false;
        openShellMock.mockReset();
        delete (window as any).__TAURI_INTERNALS__;
        vi.restoreAllMocks();
        act(() => {
            useTaskStore.setState(initialTaskState, true);
            useUiStore.setState(initialUiState, true);
        });
    });

    const currentLinkContext = () => {
        const taskState = useTaskStore.getState();
        const uiState = useUiStore.getState();
        return createInternalMarkdownLinkContext({
            tasks: taskState._allTasks,
            projects: taskState._allProjects,
            restoreTask: taskState.restoreTask,
            restoreProject: taskState.restoreProject,
            setHighlightTask: taskState.setHighlightTask,
            setProjectView: uiState.setProjectView,
        });
    };

    it('opens UpNote only on click and offers exact-link copy after a native failure', async () => {
        const uri = 'upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true';
        (window as any).__TAURI_INTERNALS__ = {};
        openShellMock.mockRejectedValue(new Error(`No handler for ${uri}`));
        const browserOpen = vi.spyOn(window, 'open');
        const copy = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
        const { getByRole, container } = render(
            <LanguageProvider><InternalMarkdownLink href={uri} linkContext={currentLinkContext()}>Note</InternalMarkdownLink></LanguageProvider>
        );
        expect(openShellMock).not.toHaveBeenCalled();
        expect(container.querySelector('[href]')).toBeNull();
        fireEvent.click(getByRole('link', { name: 'Note' }));
        await waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1));
        expect(openShellMock).toHaveBeenCalledWith(uri);
        expect(browserOpen).not.toHaveBeenCalled();
        const toast = useUiStore.getState().toasts[0];
        expect(toast.message).toContain('Make sure the app');
        expect(toast.message).not.toContain(uri);
        expect(toast.action?.label).toBe('Copy link');
        toast.action?.onClick();
        await waitFor(() => expect(copy).toHaveBeenCalledWith(uri));
    });

    it.each(['javascript:alert(1)', 'data:text/html,bad', 'file:///private/doc', 'obsidian:open?file=a', 'custom://open'])('keeps blocked Markdown href %s inert', (href) => {
        const { queryByRole } = render(
            <LanguageProvider><InternalMarkdownLink href={href} linkContext={currentLinkContext()}>Blocked</InternalMarkdownLink></LanguageProvider>
        );
        expect(queryByRole('link')).toBeNull();
        expect(openShellMock).not.toHaveBeenCalled();
    });

    it('keeps UpNote inert in sandbox', () => {
        sandboxState.enabled = true;
        const { getByRole } = render(
            <LanguageProvider><InternalMarkdownLink href="upnote://x-callback-url/openNote?noteId=a" linkContext={currentLinkContext()}>Note</InternalMarkdownLink></LanguageProvider>
        );
        fireEvent.click(getByRole('link', { name: 'Note' }));
        expect(getByRole('link', { name: 'Note' })).toBeDisabled();
        expect(openShellMock).not.toHaveBeenCalled();
    });

    it('renders RFC 2392 message-id links as safe external links', () => {
        const { getByRole } = render(
            <LanguageProvider>
                <InternalMarkdownLink href="mid:960830.1639@example.com" linkContext={currentLinkContext()}>Email</InternalMarkdownLink>
            </LanguageProvider>
        );

        expect(getByRole('link', { name: 'Email' })).toHaveAttribute('title', 'mid:960830.1639@example.com');
    });

    it('does not open an external application from sandbox markdown', () => {
        sandboxState.enabled = true;
        const open = vi.spyOn(window, 'open');
        const { getByRole } = render(
            <LanguageProvider>
                <InternalMarkdownLink href="mailto:example@example.com" linkContext={currentLinkContext()}>Email</InternalMarkdownLink>
            </LanguageProvider>
        );
        const link = getByRole('link', { name: 'Email' });
        expect(link).toBeDisabled();
        expect(link).toHaveAttribute('title', 'Unavailable in sandbox');
        fireEvent.click(link);
        expect(open).not.toHaveBeenCalled();
        open.mockRestore();
    });

    it('gives external links no href for the engine to preconnect to', () => {
        // #913: WebView2 speculatively resolves and connects to any href's
        // host on hover/click; the URL must live only in the click handler.
        const { getByRole, container } = render(
            <LanguageProvider>
                <InternalMarkdownLink href="https://example.com/page" linkContext={currentLinkContext()}>Example</InternalMarkdownLink>
            </LanguageProvider>
        );

        expect(getByRole('link', { name: 'Example' })).toHaveAttribute('title', 'https://example.com/page');
        expect(container.querySelector('[href]')).toBeNull();
    });

    it('restores deleted task links and navigates to the live task view', async () => {
        const deletedTask: Task = {
            id: 'task-1',
            title: 'Deleted task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2026-04-13T00:00:00.000Z',
            updatedAt: '2026-04-13T00:00:00.000Z',
            deletedAt: '2026-04-13T01:00:00.000Z',
        };
        const restoredTask: Task = {
            ...deletedTask,
            deletedAt: undefined,
        };
        const restoreTask = vi.fn(async () => {
            act(() => {
                useTaskStore.setState((state) => ({
                    ...state,
                    tasks: [restoredTask],
                    _allTasks: [restoredTask],
                }));
            });
            return { success: true, id: restoredTask.id };
        });
        const onNavigate = vi.fn();
        window.addEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [],
                _allTasks: [deletedTask],
                projects: [],
                _allProjects: [],
                restoreTask,
            }));
        });

        try {
            const { getByRole, getByText } = render(
                <LanguageProvider>
                    <InternalMarkdownLink href="mindwtr://task/task-1" linkContext={currentLinkContext()}>Deleted task</InternalMarkdownLink>
                </LanguageProvider>
            );

            expect(getByText('(deleted task)')).toBeInTheDocument();
            fireEvent.click(getByRole('button', { name: /restore/i }));

            await waitFor(() => {
                expect(restoreTask).toHaveBeenCalledWith('task-1');
                expect(onNavigate).toHaveBeenCalled();
            });
        } finally {
            window.removeEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);
        }
    });

    it('restores deleted project links and opens the projects view', async () => {
        const deletedProject: Project = {
            id: 'project-1',
            title: 'Deleted project',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            createdAt: '2026-04-13T00:00:00.000Z',
            updatedAt: '2026-04-13T00:00:00.000Z',
            deletedAt: '2026-04-13T01:00:00.000Z',
        };
        const restoredProject: Project = {
            ...deletedProject,
            deletedAt: undefined,
        };
        const restoreProject = vi.fn(async () => {
            act(() => {
                useTaskStore.setState((state) => ({
                    ...state,
                    projects: [restoredProject],
                    _allProjects: [restoredProject],
                }));
            });
            return { success: true, id: restoredProject.id };
        });
        const onNavigate = vi.fn();
        window.addEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                projects: [],
                _allProjects: [deletedProject],
                restoreProject,
            }));
        });

        try {
            const { getByRole, getByText } = render(
                <LanguageProvider>
                    <InternalMarkdownLink href="mindwtr://project/project-1" linkContext={currentLinkContext()}>Deleted project</InternalMarkdownLink>
                </LanguageProvider>
            );

            expect(getByText('(deleted project)')).toBeInTheDocument();
            fireEvent.click(getByRole('button', { name: /restore/i }));

            await waitFor(() => {
                expect(restoreProject).toHaveBeenCalledWith('project-1');
                expect(onNavigate).toHaveBeenCalled();
                expect(useUiStore.getState().projectView.selectedProjectId).toBe('project-1');
            });
        } finally {
            window.removeEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);
        }
    });

    it('offers no Restore for purged task and project links', () => {
        const purgedTask: Task = {
            id: 'task-1',
            title: '(deleted)',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2026-04-13T00:00:00.000Z',
            updatedAt: '2026-04-13T00:00:00.000Z',
            deletedAt: '2026-04-13T01:00:00.000Z',
            purgedAt: '2026-04-13T02:00:00.000Z',
        };
        const purgedProject: Project = {
            id: 'project-1',
            title: '(deleted)',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            createdAt: '2026-04-13T00:00:00.000Z',
            updatedAt: '2026-04-13T00:00:00.000Z',
            deletedAt: '2026-04-13T01:00:00.000Z',
            purgedAt: '2026-04-13T02:00:00.000Z',
        };

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [],
                _allTasks: [purgedTask],
                projects: [],
                _allProjects: [purgedProject],
            }));
        });

        const linkContext = currentLinkContext();
        const taskLink = render(
            <LanguageProvider>
                <InternalMarkdownLink href="mindwtr://task/task-1" linkContext={linkContext}>Purged task</InternalMarkdownLink>
            </LanguageProvider>
        );
        expect(taskLink.getByText('(deleted task)')).toBeInTheDocument();
        expect(taskLink.queryByRole('button', { name: /restore/i })).toBeNull();

        const projectLink = render(
            <LanguageProvider>
                <InternalMarkdownLink href="mindwtr://project/project-1" linkContext={linkContext}>Purged project</InternalMarkdownLink>
            </LanguageProvider>
        );
        expect(projectLink.getByText('(deleted project)')).toBeInTheDocument();
        expect(projectLink.queryByRole('button', { name: /restore/i })).toBeNull();
    });
});
