import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { useCallback, useEffect, useState } from 'react';
import { useTaskStore } from '@mindwtr/core';
import { LanguageProvider } from './language-context';
import { KeybindingProvider } from './keybinding-context';
import { useKeybindings } from './keybinding-context';
import { useUiStore } from '../store/ui-store';
import { AREA_FILTER_ALL } from '../lib/area-filter';

const DummyList = () => {
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
            toggleDoneSelected: vi.fn(),
            deleteSelected: vi.fn(),
        });
        return () => registerTaskListScope(null);
    }, [registerTaskListScope, selectNext, selectPrev, selectFirst, selectLast]);

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

const setVisibleRect = (element: HTMLElement | null) => {
    if (!element) return;
    element.getBoundingClientRect = () =>
        ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            bottom: 32,
            right: 320,
            width: 320,
            height: 32,
            toJSON: () => ({}),
        }) as DOMRect;
};

const FallbackTaskList = ({
    onEditTask1,
    onEditTask2,
}: {
    onEditTask1: () => void;
    onEditTask2: () => void;
}) => {
    return (
        <div data-main-content tabIndex={-1}>
            <input
                type="text"
                data-view-filter-input
                ref={setVisibleRect}
                placeholder="Search..."
                defaultValue=""
            />
            <div data-task-id="1" ref={setVisibleRect}>
                <button type="button" aria-expanded={false}>
                    Task 1
                </button>
                <button type="button" data-task-edit-trigger onClick={onEditTask1}>
                    Edit 1
                </button>
            </div>
            <div data-task-id="2" ref={setVisibleRect}>
                <button type="button" aria-expanded={false}>
                    Task 2
                </button>
                <button type="button" data-task-edit-trigger onClick={onEditTask2}>
                    Edit 2
                </button>
            </div>
        </div>
    );
};

const FallbackTaskListWithoutEditTrigger = ({
    onOpenTask1,
    onOpenTask2,
}: {
    onOpenTask1: () => void;
    onOpenTask2: () => void;
}) => {
    return (
        <div data-main-content tabIndex={-1}>
            <div data-task-id="1" data-task-edit-trigger ref={setVisibleRect} onClick={onOpenTask1}>
                Task 1
            </div>
            <div data-task-id="2" ref={setVisibleRect}>
                <button type="button" onClick={onOpenTask2}>
                    Open Task 2
                </button>
            </div>
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
            areas: [
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

        fireEvent.keyDown(window, { key: 'a' });
        fireEvent.keyDown(window, { key: '2' });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe('area-errands');
        });
    });

    it('clears the global area filter with a0', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            areas: [
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

        fireEvent.keyDown(window, { key: 'a' });
        fireEvent.keyDown(window, { key: '0' });

        await waitFor(() => {
            expect(useTaskStore.getState().settings?.filters?.areaId).toBe(AREA_FILTER_ALL);
        });
    });

    it('falls back to visible task cards in views without registered scope', () => {
        const onEditTask1 = vi.fn();
        const onEditTask2 = vi.fn();

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                    <FallbackTaskList onEditTask1={onEditTask1} onEditTask2={onEditTask2} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'o' });
        expect(document.activeElement?.getAttribute('data-view-filter-input')).not.toBeNull();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(document.activeElement?.getAttribute('data-view-filter-input')).toBeNull();

        fireEvent.keyDown(window, { key: 'j' });
        fireEvent.keyDown(window, { key: 'e' });
        expect(onEditTask2).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(window, { key: 'g' });
        fireEvent.keyDown(window, { key: 'g' });
        fireEvent.keyDown(window, { key: 'e' });
        expect(onEditTask1).toHaveBeenCalledTimes(1);
    });

    it('falls back to clickable task row when explicit edit trigger is absent', () => {
        const onOpenTask1 = vi.fn();
        const onOpenTask2 = vi.fn();

        render(
            <LanguageProvider>
                <KeybindingProvider currentView="calendar" onNavigate={vi.fn()}>
                    <FallbackTaskListWithoutEditTrigger onOpenTask1={onOpenTask1} onOpenTask2={onOpenTask2} />
                </KeybindingProvider>
            </LanguageProvider>
        );

        fireEvent.keyDown(window, { key: 'j' });
        fireEvent.keyDown(window, { key: 'e' });
        expect(onOpenTask2).toHaveBeenCalledTimes(1);
    });
});
