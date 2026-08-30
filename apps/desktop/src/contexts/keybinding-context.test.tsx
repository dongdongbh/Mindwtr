import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { useCallback, useEffect, useState } from 'react';
import { useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';
import { LanguageProvider } from './language-context';
import { useTaskListScope } from '../components/views/list/task-list-scope';
import { KeybindingProvider } from './keybinding-context';
import { useKeybindings } from './keybinding-context';
import { useUiStore } from '../store/ui-store';
import { AREA_FILTER_ALL } from '@mindwtr/core';
import {
    GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N,
    GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q,
    GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT,
    GLOBAL_QUICK_ADD_SHORTCUT_LEGACY,
    type GlobalQuickAddShortcutSetting,
} from '../lib/global-quick-add-shortcut';

type ShortcutRuntimeWindow = Window & {
    __MINDWTR_FLATPAK__?: boolean;
    __TAURI_INTERNALS__?: object;
};

const shortcutCases: Array<{
    label: string;
    shortcut: GlobalQuickAddShortcutSetting;
    event: {
        key: string;
        code: string;
        ctrlKey?: boolean;
        metaKey?: boolean;
        altKey?: boolean;
        shiftKey?: boolean;
    };
}> = [
    {
        label: 'Ctrl+Alt+M',
        shortcut: GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT,
        event: { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true },
    },
    {
        label: 'Ctrl+Alt+N',
        shortcut: GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N,
        event: { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true },
    },
    {
        label: 'Ctrl+Alt+Q',
        shortcut: GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q,
        event: { key: 'q', code: 'KeyQ', ctrlKey: true, altKey: true },
    },
    {
        label: 'Ctrl+Shift+A',
        shortcut: GLOBAL_QUICK_ADD_SHORTCUT_LEGACY,
        event: { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true },
    },
    {
        label: 'Cmd+Shift+A',
        shortcut: GLOBAL_QUICK_ADD_SHORTCUT_LEGACY,
        event: { key: 'a', code: 'KeyA', metaKey: true, shiftKey: true },
    },
];

const shortcutRuntimeCases = [
    { runtimeLabel: 'native Tauri', isTauri: true, isFlatpak: false, expectedInAppOpens: 0 },
    { runtimeLabel: 'Flatpak Tauri', isTauri: true, isFlatpak: true, expectedInAppOpens: 0 },
    { runtimeLabel: 'browser/PWA', isTauri: false, isFlatpak: false, expectedInAppOpens: 1 },
].flatMap((runtime) => shortcutCases.map((shortcutCase) => ({
    ...runtime,
    ...shortcutCase,
    shortcutLabel: shortcutCase.label,
})));

const DummyList = ({ focusAddInput, openSelected, setStatusSelected }: { focusAddInput?: () => boolean; openSelected?: () => void; setStatusSelected?: (status: string) => void } = {}) => {
    const { registerTaskListScope } = useKeybindings();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const ids = ['1', '2'];

    const selectNext = useCallback(() => {
        setSelectedIndex((i) => Math.min(i + 1, ids.length - 1));
    }, [ids.length]);

    const selectPrev = useCallback(() => {
        setSelectedIndex((i) => Math.max(i - 1, 0));
    }, []);

    const selectFirst = useCallback(() => setSelectedIndex(0), []);
    const selectLast = useCallback(() => setSelectedIndex(ids.length - 1), [ids.length]);

    useEffect(() => {
        registerTaskListScope({
            kind: 'taskList',
            selectNext,
            selectPrev,
            selectFirst,
            selectLast,
            editSelected: vi.fn(),
            openSelected,
            toggleDoneSelected: vi.fn(),
            deleteSelected: vi.fn(),
            setStatusSelected,
            focusAddInput,
        });
        return () => registerTaskListScope(null);
    }, [focusAddInput, openSelected, registerTaskListScope, selectNext, selectPrev, selectFirst, selectLast, setStatusSelected]);

    return (
        <div>
            {ids.map((id, index) => (
                <div key={id} data-task-id={id} className={index === selectedIndex ? 'ring-2' : ''}>
                    Task {id}
                </div>
            ))}
        </div>
    );
};

const scopedTask = (id: string): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
} as Task);

// Stands in for any view that registers the shared scope over its own ordered
// visible-task array (Focus, Board, Projects, Search, Contexts, Review).
const ScopedTaskList = ({
    tasks,
    onEdit,
    toggleSelect,
}: {
    tasks: Task[];
    onEdit?: (taskId: string) => void;
    toggleSelect?: (task: Task) => void;
}) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    useTaskListScope({
        getTasks: () => tasks,
        getSelectedIndex: () => selectedIndex,
        setSelectedIndex,
        t: (key: string) => key,
        toggleSelect,
    });

    return (
        <div data-main-content tabIndex={-1}>
            <input
                type="text"
                data-view-filter-input
                placeholder="Search..."
                defaultValue=""
            />
            {tasks.map((task) => (
                <div key={task.id} data-task-id={task.id}>
                    <button type="button" aria-label="Done">Done circle</button>
                    <button type="button" data-task-view-toggle aria-expanded={false}>
                        {task.title}
                    </button>
                    <button type="button" data-other-task-control>Other task control {task.id}</button>
                    <button type="button" data-task-edit-trigger onClick={() => onEdit?.(task.id)}>
                        Edit {task.id}
                    </button>
                </div>
            ))}
        </div>
    );
};

// A registered list scope that exposes focusSelected the way useListSelection
// does: entering the list focuses the selected task's title toggle (#890).
const ListWithFocusSelected = () => {
    const { registerTaskListScope } = useKeybindings();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const ids = ['1', '2'];

    const selectNext = useCallback(() => {
        setSelectedIndex((i) => Math.min(i + 1, ids.length - 1));
    }, [ids.length]);
    const selectPrev = useCallback(() => {
        setSelectedIndex((i) => Math.max(i - 1, 0));
    }, []);
    const focusSelected = useCallback(() => {
        const id = ids[selectedIndex];
        const toggle = document.querySelector(
            `[data-task-id="${id}"] [data-task-view-toggle]`,
        ) as HTMLElement | null;
        toggle?.focus();
        return true;
    }, [ids, selectedIndex]);

    useEffect(() => {
        registerTaskListScope({
            kind: 'taskList',
            selectNext,
            selectPrev,
            selectFirst: vi.fn(),
            selectLast: vi.fn(),
            editSelected: vi.fn(),
            toggleDoneSelected: vi.fn(),
            deleteSelected: vi.fn(),
            focusSelected,
        });
        return () => registerTaskListScope(null);
    }, [registerTaskListScope, selectNext, selectPrev, focusSelected]);

    return (
        <div data-main-content tabIndex={-1}>
            {ids.map((id, index) => (
                <div key={id} data-task-id={id} className={index === selectedIndex ? 'ring-2' : ''}>
                    <button type="button" data-task-view-toggle aria-expanded={false}>
                        Task {id}
                    </button>
                </div>
            ))}
        </div>
    );
};

describe('KeybindingProvider (vim)', () => {
    beforeEach(() => {
        useUiStore.setState({ editingTaskId: null });
        useTaskStore.setState((state) => ({
            settings: {
                ...state.settings,
                keybindingStyle: 'vim',
            },
        }));
    });

    afterEach(() => {
        const runtimeWindow = window as ShortcutRuntimeWindow;
        delete runtimeWindow.__TAURI_INTERNALS__;
        delete runtimeWindow.__MINDWTR_FLATPAK__;
    });

    it('toggles keyboard shortcut help closed with a second question mark', async () => {
        const { queryByRole } = render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: '?' });
        expect(queryByRole('dialog')).not.toBeNull();

        fireEvent.keyDown(window, { key: '?' });
        await waitFor(() => expect(queryByRole('dialog')).toBeNull());
    });

    it('moves selection with j/k', async () => {
        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        const first = document.querySelector('[data-task-id="1"]');
        const second = document.querySelector('[data-task-id="2"]');

        expect(first?.className).toMatch(/ring-2/);
        expect(second?.className).not.toMatch(/ring-2/);

        await waitFor(() => {
            expect(document.querySelector('[data-task-id="1"]')?.className).toMatch(/ring-2/);
        });

        fireEvent.keyDown(window, { key: 'j' });

        await waitFor(() => {
            expect(document.querySelector('[data-task-id="2"]')?.className).toMatch(/ring-2/);
        });
    });

    it('triggers quick add with Ctrl+Alt+M', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true });

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it.each(shortcutRuntimeCases)(
        'routes $shortcutLabel through the correct owner in $runtimeLabel',
        ({ shortcut, event, isTauri, isFlatpak, expectedInAppOpens }) => {
            const runtimeWindow = window as ShortcutRuntimeWindow;
            if (isTauri) runtimeWindow.__TAURI_INTERNALS__ = {};
            if (isFlatpak) runtimeWindow.__MINDWTR_FLATPAK__ = true;
            useTaskStore.setState((state) => ({
                settings: {
                    ...state.settings,
                    globalQuickAddShortcut: shortcut,
                },
            }));

            const quickAddListener = vi.fn();
            window.addEventListener('mindwtr:quick-add', quickAddListener);

            render(
                <LanguageProvider>
                    <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                        <DummyList />
                    </KeybindingProvider>
                </LanguageProvider>
            );

            fireEvent.keyDown(window, event);

            expect(quickAddListener).toHaveBeenCalledTimes(expectedInAppOpens);
            window.removeEventListener('mindwtr:quick-add', quickAddListener);
        }
    );

    it.each(['vim', 'emacs'] as const)('a focuses the scope add input instead of the global quick add in %s style (#978)', (style) => {
        const focusAddInput = vi.fn(() => true);
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);
        useTaskStore.setState((state) => ({
            settings: {
                ...state.settings,
                keybindingStyle: style,
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList focusAddInput={focusAddInput} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'a' });

        expect(focusAddInput).toHaveBeenCalledTimes(1);
        expect(quickAddListener).not.toHaveBeenCalled();
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('a clicks the view add-task trigger when the scope has no add input (#978)', () => {
        const quickAddListener = vi.fn();
        const triggerClick = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);
        useTaskStore.setState((state) => ({
            settings: {
                ...state.settings,
                keybindingStyle: 'vim',
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                    <div data-main-content>
                        <button type="button" data-add-task-trigger onClick={triggerClick}>Add task</button>
                        <DummyList />
                    </div>
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'a' });

        expect(triggerClick).toHaveBeenCalledTimes(1);
        expect(quickAddListener).not.toHaveBeenCalled();
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('a falls back to the global quick add when the view has no add affordance', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);
        useTaskStore.setState((state) => ({
            settings: {
                ...state.settings,
                keybindingStyle: 'vim',
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'a' });

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('does not use o as an add-task shortcut', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'o' });

        expect(quickAddListener).not.toHaveBeenCalled();
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('opens settings with Cmd+,', () => {
        const onNavigate = vi.fn();
        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={onNavigate}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true });

        expect(onNavigate).toHaveBeenCalledWith('settings');
    });

    it('dispatches global edit cancel on Escape while editing', () => {
        const cancelListener = vi.fn();
        window.addEventListener('mindwtr:cancel-task-edit', cancelListener);
        useUiStore.setState({ editingTaskId: 'task-123' });

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'Escape' });

        expect(cancelListener).toHaveBeenCalledTimes(1);
        const event = cancelListener.mock.calls[0]?.[0] as CustomEvent<{ taskId: string }>;
        expect(event.detail.taskId).toBe('task-123');
        window.removeEventListener('mindwtr:cancel-task-edit', cancelListener);
    });

    it('switches the global area filter with a number chord in sidebar order', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            _allAreas: [
                { id: 'area-work', name: 'Work', order: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                { id: 'area-errands', name: 'Errands', order: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: 'area-work',
                },
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'A', shiftKey: true });
        fireEvent.keyDown(window, { key: '2' });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe('area-errands');
        });
    });

    it('clears the global area filter with A0', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            _allAreas: [
                { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: 'area-home',
                },
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'A', shiftKey: true });
        fireEvent.keyDown(window, { key: '0' });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe(AREA_FILTER_ALL);
        });
    });

    it('switches the area filter with a bare digit, no chord prefix', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            _allAreas: [
                { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                { id: 'area-errands', name: 'Errands', order: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: 'area-home',
                },
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: '2', code: 'Digit2' });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe('area-errands');
        });
    });

    it('clears the area filter with a bare 0 and ignores digits with no matching area', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            _allAreas: [
                { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: 'area-home',
                },
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: '9', code: 'Digit9' });
        expect(useTaskStore.getState().settings?.filters?.areaId).toBe('area-home');

        fireEvent.keyDown(window, { key: '0', code: 'Digit0' });
        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe(AREA_FILTER_ALL);
        });
    });

    it('starts the area filter chord when Shift+a reports lowercase a', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            _allAreas: [
                { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                { id: 'area-work', name: 'Work', order: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: AREA_FILTER_ALL,
                },
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'a', shiftKey: true });
        fireEvent.keyDown(window, { key: '2' });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe('area-work');
        });
    });

    it('applies the area chord when Shift stays held through the digit', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            _allAreas: [
                { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                { id: 'area-work', name: 'Work', order: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: AREA_FILTER_ALL,
                },
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'A', shiftKey: true });
        fireEvent.keyDown(window, { key: '!', code: 'Digit2', shiftKey: true });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe('area-work');
        });
    });

    it('keeps the area chord pending when Shift is pressed before the digit', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            _allAreas: [
                { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: AREA_FILTER_ALL,
                },
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'A', shiftKey: true });
        fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
        fireEvent.keyDown(window, { key: '1', code: 'Digit1' });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe('area-home');
        });
    });

    it('opens quick add for Caps Lock A without Shift instead of arming the chord', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            _allAreas: [
                { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: AREA_FILTER_ALL,
                },
            },
        }));
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'A', shiftKey: false });
        // Quick add firing on the 'A' itself proves the chord was not armed.
        expect(quickAddListener).toHaveBeenCalledTimes(1);

        // The follow-up digit is picked up by the bare-digit area shortcut
        // (in the real app the open quick-add dialog gates it out).
        fireEvent.keyDown(window, { key: '1', code: 'Digit1' });
        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe('area-home');
        });
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('can switch area filters repeatedly with A number chords', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            _allAreas: [
                { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                { id: 'area-work', name: 'Work', order: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: AREA_FILTER_ALL,
                },
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'A', shiftKey: true });
        fireEvent.keyDown(window, { key: '1' });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe('area-home');
        });

        fireEvent.keyDown(window, { key: 'A', shiftKey: true });
        fireEvent.keyDown(window, { key: '2' });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe('area-work');
        });

        fireEvent.keyDown(window, { key: 'A', shiftKey: true });
        fireEvent.keyDown(window, { key: '0' });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe(AREA_FILTER_ALL);
        });
    });

    it('ignores list shortcuts while focus is inside an open menu', () => {
        const editSelected = vi.fn();
        const toggleDoneSelected = vi.fn();

        const MenuHarness = () => {
            const { registerTaskListScope } = useKeybindings();
            useEffect(() => {
                registerTaskListScope({
                    kind: 'taskList',
                    selectNext: vi.fn(),
                    selectPrev: vi.fn(),
                    selectFirst: vi.fn(),
                    selectLast: vi.fn(),
                    editSelected,
                    toggleDoneSelected,
                    deleteSelected: vi.fn(),
                });
                return () => registerTaskListScope(null);
            }, [registerTaskListScope]);
            return (
                <div role="menu">
                    <button type="button" role="menuitem">Duplicate</button>
                </div>
            );
        };

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <MenuHarness />
                </KeybindingProvider>
            </LanguageProvider>
        );

        const item = document.querySelector('[role="menuitem"]') as HTMLButtonElement;
        item.focus();
        fireEvent.keyDown(item, { key: 'e' });
        fireEvent.keyDown(item, { key: 'x' });

        expect(editSelected).not.toHaveBeenCalled();
        expect(toggleDoneSelected).not.toHaveBeenCalled();
    });

    it('ignores list shortcuts while a modal dialog is open, even with focus outside it', () => {
        const editSelected = vi.fn();
        const toggleDoneSelected = vi.fn();
        const openSelected = vi.fn();
        const selectNext = vi.fn();

        const DialogHarness = () => {
            const { registerTaskListScope } = useKeybindings();
            useEffect(() => {
                registerTaskListScope({
                    kind: 'taskList',
                    selectNext,
                    selectPrev: vi.fn(),
                    selectFirst: vi.fn(),
                    selectLast: vi.fn(),
                    editSelected,
                    openSelected,
                    toggleDoneSelected,
                    deleteSelected: vi.fn(),
                });
                return () => registerTaskListScope(null);
            }, [registerTaskListScope]);
            // Same shape as the global search / quick add overlays.
            return <div role="dialog" aria-modal="true" />;
        };

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DialogHarness />
                </KeybindingProvider>
            </LanguageProvider>
        );

        // Focus is nowhere interactive (e.g. after clicking a non-focusable
        // element inside the dialog) — the exact state that used to let Enter
        // and action keys reach the task list behind the dialog.
        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 'ArrowDown' });
        fireEvent.keyDown(window, { key: 'Enter' });
        fireEvent.keyDown(window, { key: 'e' });
        fireEvent.keyDown(window, { key: 'x' });

        expect(selectNext).not.toHaveBeenCalled();
        expect(openSelected).not.toHaveBeenCalled();
        expect(editSelected).not.toHaveBeenCalled();
        expect(toggleDoneSelected).not.toHaveBeenCalled();
    });

    it('opens the selected task with Enter when nothing interactive is focused', () => {
        const openSelected = vi.fn();

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList openSelected={openSelected} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 'Enter' });

        expect(openSelected).toHaveBeenCalledTimes(1);
    });

    it('leaves Enter alone while a button has focus', () => {
        const openSelected = vi.fn();

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList openSelected={openSelected} />
                    <button type="button">Focused control</button>
                </KeybindingProvider>
            </LanguageProvider>
        );

        (document.querySelector('button') as HTMLButtonElement).focus();
        fireEvent.keyDown(window, { key: 'Enter' });

        expect(openSelected).not.toHaveBeenCalled();
    });

    it('focuses the title toggle, not the done button, when navigation reveals a row', () => {
        render(
            <LanguageProvider>
                <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                    <ScopedTaskList tasks={[scopedTask('1')]} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'j' });

        expect(document.activeElement).toBe(document.querySelector('[data-task-view-toggle]'));
    });

    it('navigates and edits through a view-registered task scope', () => {
        const onEdit = vi.fn();

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                    <ScopedTaskList tasks={[scopedTask('1'), scopedTask('2')]} onEdit={onEdit} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'j' });
        fireEvent.keyDown(window, { key: 'e' });
        expect(onEdit).toHaveBeenLastCalledWith('2');

        fireEvent.keyDown(window, { key: 'g' });
        fireEvent.keyDown(window, { key: 'g' });
        fireEvent.keyDown(window, { key: 'e' });
        expect(onEdit).toHaveBeenLastCalledWith('1');
    });

    it('ArrowRight focuses the selected task title, not the list container (#890)', () => {
        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <ListWithFocusSelected />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'ArrowRight' });

        const toggles = document.querySelectorAll('[data-task-view-toggle]');
        expect(document.activeElement).toBe(toggles[0]);
        expect(document.activeElement).not.toBe(document.querySelector('[data-main-content]'));
    });

    it('registered view: ArrowRight selects the first task and the next ArrowDown moves exactly one row (#890)', () => {
        render(
            <LanguageProvider>
                <KeybindingProvider currentView="agenda" onNavigate={vi.fn()}>
                    <ScopedTaskList tasks={[scopedTask('1'), scopedTask('2')]} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        const toggles = document.querySelectorAll('[data-task-view-toggle]');

        // Entering the list highlights/focuses the FIRST task — not the
        // container, and not off-by-one to the second row.
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(document.activeElement).toBe(toggles[0]);

        // The first ArrowDown then moves exactly one row.
        fireEvent.keyDown(window, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(toggles[1]);
    });

    it('shows an undo toast when keyboard delete soft-deletes the selected task', async () => {
        const deleteTask = vi.fn(async () => ({ success: true }));
        const restoreTask = vi.fn(async () => ({ success: true }));
        const showToast = vi.fn();
        useUiStore.setState({ showToast });
        useTaskStore.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                keybindingStyle: 'vim',
                undoNotificationsEnabled: true,
            },
            deleteTask,
            restoreTask,
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                    <ScopedTaskList tasks={[scopedTask('1'), scopedTask('2')]} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'd' });
        fireEvent.keyDown(window, { key: 'd' });

        await waitFor(() => {
            expect(deleteTask).toHaveBeenCalledWith('1');
            expect(showToast).toHaveBeenCalledWith(
                expect.any(String),
                'info',
                5000,
                expect.objectContaining({ label: expect.any(String) })
            );
        });

        const undoAction = showToast.mock.calls[0]?.[3];
        undoAction.onClick();
        expect(restoreTask).toHaveBeenCalledWith('1');
    });

    it('undoes the last keyboard delete with Ctrl+Z even when toasts are disabled', async () => {
        const deleteTask = vi.fn(async () => ({ success: true }));
        const restoreTask = vi.fn(async () => ({ success: true }));
        const showToast = vi.fn();
        useUiStore.setState({ showToast });
        useTaskStore.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                keybindingStyle: 'vim',
                undoNotificationsEnabled: false,
            },
            deleteTask,
            restoreTask,
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                    <ScopedTaskList tasks={[scopedTask('1'), scopedTask('2')]} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'd' });
        fireEvent.keyDown(window, { key: 'd' });

        await waitFor(() => {
            expect(deleteTask).toHaveBeenCalledWith('1');
        });
        expect(showToast).not.toHaveBeenCalled();

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

        expect(restoreTask).toHaveBeenCalledWith('1');
    });

    it.each(['vim', 'emacs', 'standard'] as const)('sets status with the s chord in %s style', (style) => {
        const setStatusSelected = vi.fn();
        useTaskStore.setState((state) => ({
            settings: {
                ...state.settings,
                keybindingStyle: style,
            },
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList setStatusSelected={setStatusSelected} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 's' });
        fireEvent.keyDown(window, { key: 'n' });

        expect(setStatusSelected).toHaveBeenCalledTimes(1);
        expect(setStatusSelected).toHaveBeenCalledWith('next');
    });

    it('finishes the status chord with a as archived instead of opening quick add', () => {
        const setStatusSelected = vi.fn();
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList setStatusSelected={setStatusSelected} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 's' });
        fireEvent.keyDown(window, { key: 'a' });

        expect(setStatusSelected).toHaveBeenCalledWith('archived');
        expect(quickAddListener).not.toHaveBeenCalled();
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('does not navigate when s starts the status chord after g navigation chords', () => {
        const onNavigate = vi.fn();
        const setStatusSelected = vi.fn();

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={onNavigate}>
                    <DummyList setStatusSelected={setStatusSelected} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 'g' });
        fireEvent.keyDown(window, { key: 's' });

        expect(onNavigate).toHaveBeenCalledWith('someday');
        expect(setStatusSelected).not.toHaveBeenCalled();
    });

    it('focuses the add-task input with Insert', () => {
        const focusAddInput = vi.fn(() => true);
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <DummyList focusAddInput={focusAddInput} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 'Insert' });

        expect(focusAddInput).toHaveBeenCalledTimes(1);
        expect(quickAddListener).not.toHaveBeenCalled();
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('falls back to quick add on Insert when the registered list has no add input', () => {
        const focusAddInput = vi.fn(() => false);
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="someday" onNavigate={vi.fn()}>
                    <DummyList focusAddInput={focusAddInput} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 'Insert' });

        expect(focusAddInput).toHaveBeenCalledTimes(1);
        expect(quickAddListener).toHaveBeenCalledTimes(1);
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('falls back to quick add on Insert when the scope has no add input', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                    <div data-main-content tabIndex={-1} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 'Insert' });

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('moves the selected task with the status chord and offers undo', async () => {
        const moveTask = vi.fn(async () => ({ success: true }));
        const showToast = vi.fn();
        useUiStore.setState({ showToast });
        useTaskStore.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                keybindingStyle: 'vim',
                undoNotificationsEnabled: true,
            },
            moveTask,
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                    <ScopedTaskList tasks={[scopedTask('1'), scopedTask('2')]} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 's' });
        fireEvent.keyDown(window, { key: 's' });

        await waitFor(() => {
            expect(moveTask).toHaveBeenCalledWith('1', 'someday');
            expect(showToast).toHaveBeenCalledWith(
                expect.any(String),
                'info',
                5000,
                expect.objectContaining({ label: expect.any(String) })
            );
        });

        const undoAction = showToast.mock.calls[0]?.[3];
        undoAction.onClick();
        expect(moveTask).toHaveBeenCalledWith('1', 'next');
    });
});

describe('KeybindingProvider (standard)', () => {
    const StandardScopeList = ({
        toggleDoneSelected,
        toggleSelectSelected,
        toggleFocusSelected,
        renameSelected,
        deleteSelected,
        openSelected,
        editSelected,
    }: {
        toggleDoneSelected: () => void;
        toggleSelectSelected: () => void;
        toggleFocusSelected?: () => void;
        renameSelected?: () => void;
        deleteSelected: () => void;
        openSelected: () => void;
        editSelected: () => void;
    }) => {
        const { registerTaskListScope } = useKeybindings();
        useEffect(() => {
            registerTaskListScope({
                kind: 'taskList',
                selectNext: vi.fn(),
                selectPrev: vi.fn(),
                selectFirst: vi.fn(),
                selectLast: vi.fn(),
                editSelected,
                openSelected,
                toggleDoneSelected,
                toggleSelectSelected,
                toggleFocusSelected,
                renameSelected,
                deleteSelected,
            });
            return () => registerTaskListScope(null);
        }, [deleteSelected, editSelected, openSelected, registerTaskListScope, renameSelected, toggleDoneSelected, toggleFocusSelected, toggleSelectSelected]);
        return (
            <div data-task-id="1">
                <button type="button" data-task-view-toggle>Task 1</button>
                <button type="button" data-other-task-control>Other task control</button>
            </div>
        );
    };

    beforeEach(() => {
        useUiStore.setState({ editingTaskId: null });
        useTaskStore.setState((state) => ({
            settings: {
                ...state.settings,
                keybindingStyle: 'standard',
            },
        }));
    });

    it('maps e/x/S/F2/#/Enter/Shift+Enter to done/select/focus/rename/delete/open/edit', () => {
        const toggleDoneSelected = vi.fn();
        const toggleSelectSelected = vi.fn();
        const toggleFocusSelected = vi.fn();
        const renameSelected = vi.fn();
        const deleteSelected = vi.fn();
        const openSelected = vi.fn();
        const editSelected = vi.fn();

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <StandardScopeList
                        toggleDoneSelected={toggleDoneSelected}
                        toggleSelectSelected={toggleSelectSelected}
                        toggleFocusSelected={toggleFocusSelected}
                        renameSelected={renameSelected}
                        deleteSelected={deleteSelected}
                        openSelected={openSelected}
                        editSelected={editSelected}
                    />
                </KeybindingProvider>
            </LanguageProvider>
        );

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 'e' });
        fireEvent.keyDown(window, { key: 'x' });
        fireEvent.keyDown(window, { key: 'S', code: 'KeyS', shiftKey: true });
        fireEvent.keyDown(window, { key: 'F2', code: 'F2' });
        fireEvent.keyDown(window, { key: '#', shiftKey: true });
        fireEvent.keyDown(window, { key: 'Enter' });
        fireEvent.keyDown(window, { key: 'Enter', shiftKey: true });

        expect(toggleDoneSelected).toHaveBeenCalledTimes(1);
        expect(toggleSelectSelected).toHaveBeenCalledTimes(1);
        expect(toggleFocusSelected).toHaveBeenCalledTimes(1);
        expect(renameSelected).toHaveBeenCalledTimes(1);
        expect(deleteSelected).toHaveBeenCalledTimes(1);
        expect(openSelected).toHaveBeenCalledTimes(1);
        expect(editSelected).toHaveBeenCalledTimes(1);
    });

    it('edits with Shift+Enter while the selected task title has focus', () => {
        const openSelected = vi.fn();
        const editSelected = vi.fn();

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <StandardScopeList
                        toggleDoneSelected={vi.fn()}
                        toggleSelectSelected={vi.fn()}
                        deleteSelected={vi.fn()}
                        openSelected={openSelected}
                        editSelected={editSelected}
                    />
                </KeybindingProvider>
            </LanguageProvider>
        );

        const title = document.querySelector('[data-task-view-toggle]') as HTMLButtonElement;
        title.focus();
        fireEvent.keyDown(title, { key: 'Enter', shiftKey: true });

        expect(editSelected).toHaveBeenCalledTimes(1);
        expect(openSelected).not.toHaveBeenCalled();
    });

    it('edits with Shift+Enter while another control in the selected task has focus', () => {
        const openSelected = vi.fn();
        const editSelected = vi.fn();

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                    <StandardScopeList
                        toggleDoneSelected={vi.fn()}
                        toggleSelectSelected={vi.fn()}
                        deleteSelected={vi.fn()}
                        openSelected={openSelected}
                        editSelected={editSelected}
                    />
                </KeybindingProvider>
            </LanguageProvider>
        );

        const control = document.querySelector('[data-other-task-control]') as HTMLButtonElement;
        control.focus();
        const propagated = fireEvent.keyDown(control, { key: 'Enter', shiftKey: true });

        expect(propagated).toBe(false);
        expect(editSelected).toHaveBeenCalledTimes(1);
        expect(openSelected).not.toHaveBeenCalled();
    });

    it('uses x to multi-select the task the focus sits in', async () => {
        const toggleSelect = vi.fn();
        const { container } = render(
            <LanguageProvider>
                <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                    <ScopedTaskList
                        tasks={[scopedTask('1'), scopedTask('2')]}
                        toggleSelect={toggleSelect}
                    />
                </KeybindingProvider>
            </LanguageProvider>
        );

        const firstControl = container.querySelector('[data-task-id="1"] [data-other-task-control]') as HTMLButtonElement;
        firstControl.focus();
        fireEvent.keyDown(firstControl, { key: 'x' });
        await waitFor(() => expect(toggleSelect).toHaveBeenCalledWith(expect.objectContaining({ id: '1' })));

        const secondControl = container.querySelector('[data-task-id="2"] [data-other-task-control]') as HTMLButtonElement;
        secondControl.focus();
        fireEvent.keyDown(secondControl, { key: 'x' });

        await waitFor(() => expect(toggleSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: '2' })));
        expect(toggleSelect).toHaveBeenCalledTimes(2);
    });

    it('navigates views with g chords in standard style', () => {
        const onNavigate = vi.fn();

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="inbox" onNavigate={onNavigate}>
                    <div data-main-content tabIndex={-1} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'g' });
        fireEvent.keyDown(window, { key: 'n' });

        expect(onNavigate).toHaveBeenCalledWith('next');
    });

    it('undoes the last complete/delete with plain z', async () => {
        const deleteTask = vi.fn(async () => ({ success: true }));
        const restoreTask = vi.fn(async () => ({ success: true }));
        useUiStore.setState({ showToast: vi.fn() });
        useTaskStore.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                keybindingStyle: 'standard',
                undoNotificationsEnabled: false,
            },
            deleteTask,
            restoreTask,
        }));

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                    <ScopedTaskList tasks={[scopedTask('1'), scopedTask('2')]} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: '#', shiftKey: true });

        await waitFor(() => {
            expect(deleteTask).toHaveBeenCalledWith('1');
        });

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 'z' });

        expect(restoreTask).toHaveBeenCalledWith('1');
    });
});
