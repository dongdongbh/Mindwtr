import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { configureDateFormatting, getDateFormattingConfig, useTaskStore } from '@mindwtr/core';
import App from './App';
import { LanguageProvider } from './contexts/language-context';
import { dispatchDesktopOnboardingEvent } from './lib/desktop-onboarding-events';
import { loadWindowsRegionalDate } from './lib/system-locale';
import * as tauriInvoke from './lib/tauri-invoke';
import { useUiStore } from './store/ui-store';
import * as runtime from './lib/runtime';
import * as tauriEvent from '@tauri-apps/api/event';

vi.mock('@tauri-apps/api/event', { spy: true });

const renderWithProviders = (ui: React.ReactElement) => {
    return render(
        <LanguageProvider>
            {ui}
        </LanguageProvider>
    );
};


Object.defineProperty(window, 'electronAPI', {
    value: {
        saveData: vi.fn(),
        getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
    },
    writable: true,
});

describe('App', () => {
    beforeEach(() => {
        window.localStorage.clear();
        window.history.replaceState(null, '', '/');
        useTaskStore.setState((state) => ({
            ...state,
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _tasksById: new Map(),
            _projectsById: new Map(),
            _sectionsById: new Map(),
            _areasById: new Map(),
            settings: {},
            isLoading: false,
            error: null,
        }));
        useUiStore.setState((state) => ({
            ...state,
            projectView: { selectedProjectId: null },
            hiddenSidebarViews: [],
            toasts: [],
        }));
    });

    it('renders Focus by default', () => {
        const { getByRole } = renderWithProviders(<App />);
        expect(getByRole('heading', { name: 'Focus' })).toBeInTheDocument();
    });

    it('opens Inbox on the first render when Focus is hidden', () => {
        useUiStore.setState({ hiddenSidebarViews: ['agenda'] });
        const { queryByRole } = renderWithProviders(<App />);
        expect(queryByRole('heading', { name: 'Focus' })).toBeNull();
        expect(window.location.search).toBe('?view=inbox');
    });

    it('renders Sidebar navigation', () => {
        const { getByRole } = renderWithProviders(<App />);
        expect(getByRole('button', { name: 'Projects' })).toBeInTheDocument();
    });

    it('opens Settings when the native application menu requests it', async () => {
        const runtimeSpy = vi.spyOn(runtime, 'isTauriRuntime').mockReturnValue(true);
        let openSettings: (() => void) | undefined;
        const eventSpy = vi.spyOn(tauriEvent, 'listen').mockImplementation(async (name, handler) => {
            if (name === 'open-settings') {
                openSettings = () => handler({ event: name, id: 1, payload: undefined as never });
            }
            return () => {};
        });
        tauriInvoke.setNativeInvokeTransport(async (command) => {
            if (command === 'list_system_fonts') return [] as never;
            throw new Error(`Unexpected native command: ${command}`);
        });
        const { getByRole, unmount } = renderWithProviders(<App />);
        try {
            await waitFor(() => expect(openSettings).toBeDefined());
            act(() => openSettings?.());
            await waitFor(() => expect(getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page'));
        } finally {
            unmount();
            tauriInvoke.setNativeInvokeTransport(null);
            eventSpy.mockRestore();
            runtimeSpy.mockRestore();
        }
    });

    it('prefers the view in the URL over the restored last view (#931)', async () => {
        window.localStorage.setItem('mindwtr-last-view', JSON.stringify({ view: 'projects', at: Date.now() }));
        window.history.replaceState(null, '', '?view=settings');

        const { getByRole } = renderWithProviders(<App />);


        await waitFor(() => {
            expect(getByRole('heading', { name: 'General' })).toBeInTheDocument();
        }, { timeout: 5000 });
    });

    it('opens Settings from the URL even though it is excluded from the restore snapshot (#931)', async () => {
        window.history.replaceState(null, '', '?view=settings');

        const { getByRole } = renderWithProviders(<App />);

        await waitFor(() => {
            expect(getByRole('heading', { name: 'General' })).toBeInTheDocument();
        }, { timeout: 5000 });
    });

    it('falls back past an unknown URL view instead of rendering blank (#931)', () => {
        window.history.replaceState(null, '', '?view=not-a-real-view');

        const { getByRole } = renderWithProviders(<App />);

        expect(getByRole('heading', { name: 'Focus' })).toBeInTheDocument();
    });

    it('falls back to the default view for ?view=timeline while Timeline is off (#1111)', async () => {
        window.history.replaceState(null, '', '?view=timeline');

        const { container, getByRole } = renderWithProviders(<App />);


        await waitFor(() => {
            expect(getByRole('heading', { name: 'Focus' })).toBeInTheDocument();
            expect(window.location.search).toBe('?view=agenda');
            expect(container.querySelector('[data-sidebar-item][data-view="agenda"]')).toHaveClass('bg-primary/5');
            expect(getByRole('main')).not.toHaveClass('max-w-screen-2xl');
        });
    });

    it('opens ?view=timeline once the Timeline feature is switched on (#1111)', async () => {
        useTaskStore.setState((state) => ({ ...state, settings: { features: { timeline: true } } }));
        window.history.replaceState(null, '', '?view=timeline');

        const { getByRole } = renderWithProviders(<App />);

        await waitFor(() => {
            expect(getByRole('heading', { name: 'Timeline' })).toBeInTheDocument();
        }, { timeout: 5000 });
    });

    it('writes the resolved initial view back into the URL on a fresh load with no ?view= param (#931 follow-up)', async () => {
        window.history.replaceState(null, '', '/');
        expect(window.location.search).toBe('');

        renderWithProviders(<App />);


        await waitFor(() => {
            expect(window.location.search).toBe('?view=agenda');
        });
    });

    it('opens the manual onboarding flow and seeds data from Start using Mindwtr', async () => {
        const { getByRole, queryByRole } = renderWithProviders(<App />);

        act(() => {
            dispatchDesktopOnboardingEvent();
        });

        expect(getByRole('dialog', { name: /welcome to mindwtr/i })).toBeInTheDocument();
        fireEvent.click(getByRole('button', { name: /^start using mindwtr/i }));

        await waitFor(() => {
            expect(queryByRole('dialog', { name: /welcome to mindwtr/i })).not.toBeInTheDocument();
        });
        expect(useTaskStore.getState().projects.some((project) => project.title === 'Getting Started')).toBe(true);
        expect(useTaskStore.getState().tasks).toHaveLength(9);
        expect(useUiStore.getState().projectView.selectedProjectId).toBe(
            useTaskStore.getState().projects.find((project) => project.title === 'Getting Started')?.id
        );
    });

    it('does not mark onboarding dismissed when routing to sync setup', async () => {
        const { getByRole, queryByRole } = renderWithProviders(<App />);

        act(() => {
            dispatchDesktopOnboardingEvent();
        });

        fireEvent.click(getByRole('button', { name: /set up sync/i }));

        await waitFor(() => {
            expect(queryByRole('dialog', { name: /welcome to mindwtr/i })).not.toBeInTheDocument();
        });
        expect(window.localStorage.getItem('mindwtr:desktop:first-run-onboarding:v1')).not.toBe('dismissed');
    });

    it('applies system regional date formatting to rendered tasks on mount and when dateFormat changes', async () => {
        const previousFormatting = getDateFormattingConfig();
        const previousShowDetails = useUiStore.getState().listOptions.showDetails;
        const invokeSpy = vi.spyOn(tauriInvoke, 'invokeNative').mockResolvedValueOnce(['en-US', 'dd-MM-yyyy']);
        await loadWindowsRegionalDate();
        configureDateFormatting({ language: 'en', dateFormat: 'mdy', systemLocale: 'en-US' });
        window.history.replaceState(null, '', '?view=agenda');
        const task = {
            id: 'regional-date-task',
            title: 'Regional format task',
            status: 'next' as const,
            isFocusedToday: true,
            tags: [],
            contexts: [],
            dueDate: '2027-11-23',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        useTaskStore.setState((state) => ({
            ...state,
            tasks: [task],
            _allTasks: [task],
            _tasksById: new Map([[task.id, task]]),
            settings: { dateFormat: 'system' },
        }));
        useUiStore.setState((state) => ({
            ...state,
            listOptions: { ...state.listOptions, showDetails: true },
        }));

        try {
            const { getByText } = renderWithProviders(<App />);
            await waitFor(() => {
                expect(getByText('23-11-2027')).toBeInTheDocument();
            });

            act(() => {
                useTaskStore.setState((state) => ({
                    ...state,
                    settings: { ...state.settings, dateFormat: 'mdy' },
                }));
            });
            await waitFor(() => {
                expect(getByText('11/23/2027')).toBeInTheDocument();
            });

            act(() => {
                useTaskStore.setState((state) => ({
                    ...state,
                    settings: { ...state.settings, dateFormat: 'system' },
                }));
            });
            await waitFor(() => {
                expect(getByText('23-11-2027')).toBeInTheDocument();
            });
        } finally {
            invokeSpy.mockResolvedValueOnce(null);
            await loadWindowsRegionalDate();
            invokeSpy.mockRestore();
            useUiStore.setState((state) => ({
                ...state,
                listOptions: { ...state.listOptions, showDetails: previousShowDetails },
            }));
            configureDateFormatting(previousFormatting);
        }
    });
});
