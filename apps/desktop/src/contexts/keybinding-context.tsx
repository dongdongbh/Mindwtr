import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { shallow, useTaskStore } from '@mindwtr/core';
import { useLanguage } from './language-context';
import { KeybindingHelpModal } from '../components/KeybindingHelpModal';
import { isTauriRuntime } from '../lib/runtime';
import { reportError } from '../lib/report-error';
import { logWarn } from '../lib/app-log';
import { useUiStore } from '../store/ui-store';
import { saveStoredFullscreen } from '../lib/window-state';
import {
    type GlobalQuickAddShortcutSetting,
    matchesGlobalQuickAddShortcut,
    normalizeGlobalQuickAddShortcut,
} from '../lib/global-quick-add-shortcut';
import { AREA_FILTER_ALL } from '../lib/area-filter';

export type KeybindingStyle = 'vim' | 'emacs';

export interface TaskListScope {
    kind: 'taskList';
    selectNext: () => void;
    selectPrev: () => void;
    selectFirst: () => void;
    selectLast: () => void;
    editSelected: () => void;
    toggleDoneSelected: () => void;
    deleteSelected: () => void;
    focusAddInput?: () => void;
}

interface KeybindingContextType {
    style: KeybindingStyle;
    setStyle: (style: KeybindingStyle) => void;
    quickAddShortcut: GlobalQuickAddShortcutSetting;
    setQuickAddShortcut: (shortcut: GlobalQuickAddShortcutSetting) => void;
    registerTaskListScope: (scope: TaskListScope | null) => void;
    openHelp: () => void;
}

type GlobalQuickAddShortcutApplyResult = {
    shortcut?: string | null;
    warning?: string | null;
};

const KeybindingContext = createContext<KeybindingContextType | undefined>(undefined);

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function moveSidebarFocus(target: EventTarget | null, direction: 'next' | 'prev'): boolean {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const origin = active ?? (target instanceof HTMLElement ? target : null);
    if (!origin) return false;
    const sidebar = origin.closest('[data-sidebar-nav]');
    if (!sidebar) return false;
    const items = Array.from(sidebar.querySelectorAll<HTMLElement>('[data-sidebar-item]'));
    if (items.length === 0) return false;
    const currentIndex = active ? items.findIndex((item) => item === active) : -1;
    const nextIndex = currentIndex >= 0
        ? direction === 'next'
            ? Math.min(items.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex - 1)
        : direction === 'next'
            ? 0
            : items.length - 1;
    items[nextIndex]?.focus();
    return true;
}

function focusSidebarCurrentView(view: string): boolean {
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-item]'));
    if (items.length === 0) return false;
    const match = items.find((item) => item.dataset.view === view) ?? items[0];
    match?.focus();
    return Boolean(match);
}

function focusMainContent(): boolean {
    const main = document.querySelector<HTMLElement>('[data-main-content]');
    if (!main) return false;
    main.focus();
    return true;
}

function triggerGlobalSearch() {
    const isMacPlatform = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);
    const event = new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: isMacPlatform,
        ctrlKey: !isMacPlatform,
        bubbles: true,
    });
    window.dispatchEvent(event);
}

function triggerQuickAdd() {
    window.dispatchEvent(new Event('mindwtr:quick-add'));
}

function triggerTaskEditCancel(taskId: string) {
    const CancelEvent = typeof window.CustomEvent === 'function' ? window.CustomEvent : CustomEvent;
    window.dispatchEvent(new CancelEvent('mindwtr:cancel-task-edit', { detail: { taskId } }));
}

export function KeybindingProvider({
    children,
    currentView,
    onNavigate,
}: {
    children: React.ReactNode;
    currentView: string;
    onNavigate: (view: string) => void;
}) {
    const isTest = import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test';
    const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);
    const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);
    const { areas, settings, updateSettings } = useTaskStore(
        (state) => ({
            areas: state.areas,
            settings: state.settings,
            updateSettings: state.updateSettings,
        }),
        shallow
    );
    const { t } = useLanguage();
    const toggleFocusMode = useUiStore((state) => state.toggleFocusMode);
    const showToast = useUiStore((state) => state.showToast);
    const listOptions = useUiStore((state) => state.listOptions);
    const setListOptions = useUiStore((state) => state.setListOptions);
    const collapseAllTaskDetails = useUiStore((state) => state.collapseAllTaskDetails);
    const editingTaskId = useUiStore((state) => state.editingTaskId);
    const editingTaskIdRef = useRef<string | null>(editingTaskId);

    const initialStyle: KeybindingStyle =
        settings.keybindingStyle === 'vim' || settings.keybindingStyle === 'emacs'
            ? settings.keybindingStyle
            : 'vim';
    const [style, setStyleState] = useState<KeybindingStyle>(initialStyle);
    const [isHelpOpen, setIsHelpOpen] = useState(false);
    const quickAddShortcut = useMemo(
        () => normalizeGlobalQuickAddShortcut(settings.globalQuickAddShortcut, {
            isMac,
            isWindows,
        }),
        [isMac, isWindows, settings.globalQuickAddShortcut]
    );
    const sortedAreas = useMemo(
        () => [...areas].sort((a, b) => a.order - b.order),
        [areas],
    );

    const isSidebarCollapsed = settings.sidebarCollapsed ?? false;
    const toggleSidebar = useCallback(() => {
        updateSettings({ sidebarCollapsed: !isSidebarCollapsed }).catch((error) => reportError('Failed to update settings', error));
    }, [updateSettings, isSidebarCollapsed]);
    const toggleListDetails = useCallback(() => {
        if (listOptions.showDetails) {
            collapseAllTaskDetails();
            setListOptions({ showDetails: false });
            return;
        }
        setListOptions({ showDetails: true });
    }, [collapseAllTaskDetails, listOptions.showDetails, setListOptions]);
    const toggleDensity = useCallback(() => {
        const nextDensity = settings.appearance?.density === 'compact' ? 'comfortable' : 'compact';
        updateSettings({ appearance: { density: nextDensity } })
            .catch((error) => reportError('Failed to update density', error));
    }, [settings.appearance?.density, updateSettings]);
    const applyAreaFilterShortcut = useCallback((key: string): boolean => {
        if (key === '0') {
            updateSettings({
                filters: {
                    ...(useTaskStore.getState().settings?.filters ?? {}),
                    areaId: AREA_FILTER_ALL,
                },
            }).catch((error) => reportError('Failed to update area filter', error));
            return true;
        }

        if (!/^[1-9]$/.test(key)) return false;

        const areaIndex = Number(key) - 1;
        const targetArea = sortedAreas[areaIndex];
        if (!targetArea) return false;

        updateSettings({
            filters: {
                ...(useTaskStore.getState().settings?.filters ?? {}),
                areaId: targetArea.id,
            },
        }).catch((error) => reportError('Failed to update area filter', error));
        return true;
    }, [sortedAreas, updateSettings]);

    const scopeRef = useRef<TaskListScope | null>(null);
    const pendingRef = useRef<{ key: string | null; timestamp: number }>({ key: null, timestamp: 0 });
    const fallbackSelectedTaskIdRef = useRef<string | null>(null);

    useEffect(() => {
        if (isTest) return;
        const nextStyle = settings.keybindingStyle;
        if (nextStyle === 'vim' || nextStyle === 'emacs') {
            setStyleState((prev) => (prev === nextStyle ? prev : nextStyle));
        }
    }, [isTest, settings.keybindingStyle]);

    useEffect(() => {
        editingTaskIdRef.current = editingTaskId;
    }, [editingTaskId]);

    const setStyle = useCallback((next: KeybindingStyle) => {
        setStyleState(next);
        updateSettings({ keybindingStyle: next }).catch((error) => reportError('Failed to update settings', error));
    }, [updateSettings]);
    const setQuickAddShortcut = useCallback((shortcut: GlobalQuickAddShortcutSetting) => {
        updateSettings({ globalQuickAddShortcut: shortcut }).catch((error) => reportError('Failed to update settings', error));
    }, [updateSettings]);

    const registerTaskListScope = useCallback((scope: TaskListScope | null) => {
        scopeRef.current = scope;
    }, []);

    const focusFallbackFilterInput = useCallback(() => {
        const root = document.querySelector<HTMLElement>('[data-main-content]') ?? document.body;
        const input = Array.from(root.querySelectorAll<HTMLElement>('[data-view-filter-input]'))
            .find((element) => {
                const tagName = element.tagName.toLowerCase();
                if (tagName !== 'input' && tagName !== 'textarea') return false;
                if ('disabled' in element && Boolean((element as HTMLInputElement | HTMLTextAreaElement).disabled)) return false;
                const rect = element.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden';
            });
        input?.focus();
    }, []);

    const getFallbackTaskElements = useCallback((): HTMLElement[] => {
        const root = document.querySelector<HTMLElement>('[data-main-content]') ?? document.body;
        const items = Array.from(root.querySelectorAll<HTMLElement>('[data-task-id]'));
        const seen = new Set<string>();
        return items.filter((item) => {
            const taskId = item.dataset.taskId;
            if (!taskId || seen.has(taskId)) return false;
            const rect = item.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = window.getComputedStyle(item);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            seen.add(taskId);
            return true;
        });
    }, []);

    const activateFallbackTaskElement = useCallback((taskElement: HTMLElement | null) => {
        if (!taskElement) return;
        const taskId = taskElement.dataset.taskId;
        if (taskId) {
            fallbackSelectedTaskIdRef.current = taskId;
        }
        if (typeof taskElement.scrollIntoView === 'function') {
            taskElement.scrollIntoView({ block: 'nearest' });
        }
        taskElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const focusTarget = taskElement.querySelector<HTMLElement>(
            'button[aria-expanded], button[data-task-edit-trigger], button, [tabindex]:not([tabindex="-1"])'
        );
        focusTarget?.focus();
    }, []);

    const resolveFallbackSelectionIndex = useCallback((elements: HTMLElement[]): number => {
        if (elements.length === 0) return -1;
        const selectedTaskId = fallbackSelectedTaskIdRef.current;
        if (selectedTaskId) {
            const selectedIndex = elements.findIndex((item) => item.dataset.taskId === selectedTaskId);
            if (selectedIndex >= 0) return selectedIndex;
        }
        const activeTaskElement = document.activeElement instanceof HTMLElement
            ? document.activeElement.closest('[data-task-id]')
            : null;
        if (activeTaskElement instanceof HTMLElement) {
            const activeIndex = elements.findIndex((item) => item === activeTaskElement);
            if (activeIndex >= 0) return activeIndex;
        }
        return 0;
    }, []);

    const pickFallbackTaskElement = useCallback((): HTMLElement | null => {
        const elements = getFallbackTaskElements();
        if (elements.length === 0) return null;
        const selectedIndex = resolveFallbackSelectionIndex(elements);
        const safeIndex = selectedIndex >= 0 ? selectedIndex : 0;
        const element = elements[safeIndex] ?? null;
        activateFallbackTaskElement(element);
        return element;
    }, [activateFallbackTaskElement, getFallbackTaskElements, resolveFallbackSelectionIndex]);

    const fallbackSelectNext = useCallback(() => {
        const elements = getFallbackTaskElements();
        if (elements.length === 0) return;
        const selectedIndex = resolveFallbackSelectionIndex(elements);
        const nextIndex = selectedIndex < 0
            ? 0
            : Math.min(selectedIndex + 1, elements.length - 1);
        activateFallbackTaskElement(elements[nextIndex] ?? null);
    }, [activateFallbackTaskElement, getFallbackTaskElements, resolveFallbackSelectionIndex]);

    const fallbackSelectPrev = useCallback(() => {
        const elements = getFallbackTaskElements();
        if (elements.length === 0) return;
        const selectedIndex = resolveFallbackSelectionIndex(elements);
        const prevIndex = selectedIndex < 0
            ? elements.length - 1
            : Math.max(selectedIndex - 1, 0);
        activateFallbackTaskElement(elements[prevIndex] ?? null);
    }, [activateFallbackTaskElement, getFallbackTaskElements, resolveFallbackSelectionIndex]);

    const fallbackSelectFirst = useCallback(() => {
        const elements = getFallbackTaskElements();
        activateFallbackTaskElement(elements[0] ?? null);
    }, [activateFallbackTaskElement, getFallbackTaskElements]);

    const fallbackSelectLast = useCallback(() => {
        const elements = getFallbackTaskElements();
        activateFallbackTaskElement(elements.length > 0 ? elements[elements.length - 1] : null);
    }, [activateFallbackTaskElement, getFallbackTaskElements]);

    const fallbackEditSelected = useCallback(() => {
        const selectedElement = pickFallbackTaskElement();
        if (!selectedElement) return;
        const editTrigger = selectedElement.matches('[data-task-edit-trigger]')
            ? selectedElement
            : selectedElement.querySelector<HTMLElement>('[data-task-edit-trigger]');
        if (!editTrigger) {
            const openTrigger = selectedElement.querySelector<HTMLElement>('button, [role="button"], [tabindex]:not([tabindex="-1"])');
            if (openTrigger) {
                openTrigger.focus();
                openTrigger.click();
                return;
            }
            selectedElement.click();
            return;
        }
        editTrigger.focus();
        editTrigger.click();
    }, [pickFallbackTaskElement]);

    const fallbackToggleDoneSelected = useCallback(() => {
        const selectedElement = pickFallbackTaskElement();
        const selectedTaskId = selectedElement?.dataset.taskId;
        if (!selectedTaskId) return;
        const state = useTaskStore.getState();
        const task = state.tasks.find((item) => item.id === selectedTaskId);
        if (!task) return;
        const nextStatus = task.status === 'done' ? 'inbox' : 'done';
        void state.moveTask(task.id, nextStatus);
    }, [pickFallbackTaskElement]);

    const fallbackDeleteSelected = useCallback(() => {
        const selectedElement = pickFallbackTaskElement();
        const selectedTaskId = selectedElement?.dataset.taskId;
        if (!selectedTaskId) return;
        const state = useTaskStore.getState();
        void state.deleteTask(selectedTaskId);
        if (fallbackSelectedTaskIdRef.current === selectedTaskId) {
            fallbackSelectedTaskIdRef.current = null;
        }
    }, [pickFallbackTaskElement]);

    const fallbackTaskListScope = useMemo<TaskListScope>(() => ({
        kind: 'taskList',
        selectNext: fallbackSelectNext,
        selectPrev: fallbackSelectPrev,
        selectFirst: fallbackSelectFirst,
        selectLast: fallbackSelectLast,
        editSelected: fallbackEditSelected,
        toggleDoneSelected: fallbackToggleDoneSelected,
        deleteSelected: fallbackDeleteSelected,
        focusAddInput: focusFallbackFilterInput,
    }), [
        fallbackDeleteSelected,
        fallbackEditSelected,
        fallbackSelectFirst,
        fallbackSelectLast,
        fallbackSelectNext,
        fallbackSelectPrev,
        fallbackToggleDoneSelected,
        focusFallbackFilterInput,
    ]);

    const getActiveScope = useCallback((): TaskListScope => {
        return scopeRef.current ?? fallbackTaskListScope;
    }, [fallbackTaskListScope]);

    useEffect(() => {
        fallbackSelectedTaskIdRef.current = null;
    }, [currentView]);

    const openHelp = useCallback(() => setIsHelpOpen(true), []);
    const toggleFullscreen = useCallback(async () => {
        if (!isTauriRuntime()) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const current = getCurrentWindow();
            const isFullscreen = await current.isFullscreen();
            const nextFullscreen = !isFullscreen;
            await current.setFullscreen(nextFullscreen);
            saveStoredFullscreen(nextFullscreen, localStorage);
        } catch (error) {
            void logWarn('Failed to toggle fullscreen', {
                scope: 'keybinding',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
    }, []);

    const vimGoMap = useMemo<Record<string, string>>(() => ({
        i: 'inbox',
        n: 'next',
        f: 'agenda',
        p: 'projects',
        c: 'contexts',
        r: 'review',
        e: 'reference',
        w: 'waiting',
        s: 'someday',
        l: 'calendar',
        b: 'board',
        d: 'done',
        a: 'archived',
    }), []);

    const emacsAltMap = useMemo<Record<string, string>>(() => ({
        i: 'inbox',
        n: 'next',
        a: 'agenda',
        p: 'projects',
        c: 'contexts',
        r: 'review',
        e: 'reference',
        w: 'waiting',
        s: 'someday',
        l: 'calendar',
        b: 'board',
        d: 'done',
        A: 'archived',
    }), []);

    useEffect(() => {
        const handleVim = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === 'F11') {
                if (isTauriRuntime()) {
                    e.preventDefault();
                    void toggleFullscreen();
                }
                return;
            }
            if (editingTaskIdRef.current) return;
            if (isEditableTarget(e.target)) return;

            const scope = getActiveScope();
            const now = Date.now();
            if (pendingRef.current.key && now - pendingRef.current.timestamp > 700) {
                pendingRef.current.key = null;
            }

            const pending = pendingRef.current.key;
            if (pending) {
                e.preventDefault();
                if (pending === 'g') {
                    if (e.key === 'g') {
                        scope?.selectFirst();
                    } else if (vimGoMap[e.key]) {
                        onNavigate(vimGoMap[e.key]);
                    }
                } else if (pending === 'a') {
                    applyAreaFilterShortcut(e.key);
                } else if (pending === 'd') {
                    if (e.key === 'd') {
                        scope?.deleteSelected();
                    }
                }
                pendingRef.current.key = null;
                return;
            }

            switch (e.key) {
                case 'j':
                    if (moveSidebarFocus(e.target, 'next')) {
                        e.preventDefault();
                        break;
                    }
                    e.preventDefault();
                    scope?.selectNext();
                    break;
                case 'k':
                    if (moveSidebarFocus(e.target, 'prev')) {
                        e.preventDefault();
                        break;
                    }
                    e.preventDefault();
                    scope?.selectPrev();
                    break;
                case 'h':
                    if (focusSidebarCurrentView(currentView)) {
                        e.preventDefault();
                    }
                    break;
                case 'l':
                    if (focusMainContent()) {
                        e.preventDefault();
                    }
                    break;
                case 'G':
                    e.preventDefault();
                    scope?.selectLast();
                    break;
                case 'e':
                    e.preventDefault();
                    scope?.editSelected();
                    break;
                case 'x':
                    e.preventDefault();
                    scope?.toggleDoneSelected();
                    break;
                case 'o':
                    e.preventDefault();
                    scope?.focusAddInput?.();
                    break;
                case '/':
                    e.preventDefault();
                    triggerGlobalSearch();
                    break;
                case '?':
                    e.preventDefault();
                    setIsHelpOpen(true);
                    break;
                case 'g':
                case 'a':
                case 'd':
                    e.preventDefault();
                    pendingRef.current = { key: e.key, timestamp: now };
                    break;
                default:
                    break;
            }
        };

        const handleEmacs = (e: KeyboardEvent) => {
            if (e.key === 'F11') {
                if (isTauriRuntime()) {
                    e.preventDefault();
                    void toggleFullscreen();
                }
                return;
            }
            if (editingTaskIdRef.current) return;
            if (isEditableTarget(e.target)) return;
            const scope = getActiveScope();

            if (e.altKey && !e.ctrlKey && !e.metaKey) {
                const view = emacsAltMap[e.key];
                if (view) {
                    e.preventDefault();
                    onNavigate(view);
                }
                return;
            }

            if (e.ctrlKey && !e.metaKey && !e.altKey) {
                switch (e.key) {
                    case 'n':
                        e.preventDefault();
                        scope?.selectNext();
                        break;
                    case 'p':
                        e.preventDefault();
                        scope?.selectPrev();
                        break;
                    case 'e':
                        e.preventDefault();
                        scope?.editSelected();
                        break;
                    case 't':
                        e.preventDefault();
                        scope?.toggleDoneSelected();
                        break;
                    case 'd':
                        e.preventDefault();
                        scope?.deleteSelected();
                        break;
                    case 'o':
                        e.preventDefault();
                        scope?.focusAddInput?.();
                        break;
                    case 's':
                        e.preventDefault();
                        triggerGlobalSearch();
                        break;
                    case 'h':
                    case '?':
                        e.preventDefault();
                        setIsHelpOpen(true);
                        break;
                    default:
                        break;
                }
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (isHelpOpen && e.key === 'Escape') {
                e.preventDefault();
                setIsHelpOpen(false);
                return;
            }
            if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Escape') {
                const active = document.activeElement;
                if (
                    active instanceof HTMLElement
                    && active.matches('[data-view-filter-input]')
                ) {
                    e.preventDefault();
                    active.blur();
                    focusMainContent();
                    return;
                }
            }
            if (editingTaskIdRef.current) {
                if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Escape') {
                    e.preventDefault();
                    triggerTaskEditCancel(editingTaskIdRef.current);
                }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'Comma') {
                e.preventDefault();
                onNavigate('settings');
                return;
            }
            if (!e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)) {
                if (e.key === 'ArrowDown') {
                    if (moveSidebarFocus(e.target, 'next')) {
                        e.preventDefault();
                        return;
                    }
                    e.preventDefault();
                    getActiveScope().selectNext();
                    return;
                }
                if (e.key === 'ArrowUp') {
                    if (moveSidebarFocus(e.target, 'prev')) {
                        e.preventDefault();
                        return;
                    }
                    e.preventDefault();
                    getActiveScope().selectPrev();
                    return;
                }
                if (style === 'vim' && e.key === 'ArrowLeft') {
                    if (focusSidebarCurrentView(currentView)) {
                        e.preventDefault();
                        return;
                    }
                }
                if (style === 'vim' && e.key === 'ArrowRight') {
                    if (focusMainContent()) {
                        e.preventDefault();
                        return;
                    }
                }
            }
            if (!isEditableTarget(e.target) && matchesGlobalQuickAddShortcut(e, quickAddShortcut)) {
                e.preventDefault();
                triggerQuickAdd();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && !isEditableTarget(e.target)) {
                if (e.code === 'Backslash') {
                    e.preventDefault();
                    toggleFocusMode();
                    return;
                }
                if (e.code === 'KeyD') {
                    e.preventDefault();
                    toggleListDetails();
                    return;
                }
                if (e.code === 'KeyC') {
                    e.preventDefault();
                    toggleDensity();
                    return;
                }
            }
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'Backslash' && !isEditableTarget(e.target)) {
                e.preventDefault();
                toggleSidebar();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'b' && !isEditableTarget(e.target)) {
                e.preventDefault();
                toggleSidebar();
                return;
            }
            if (style === 'emacs') {
                handleEmacs(e);
            } else {
                handleVim(e);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [
        style,
        quickAddShortcut,
        vimGoMap,
        emacsAltMap,
        onNavigate,
        isHelpOpen,
        toggleSidebar,
        toggleFocusMode,
        toggleListDetails,
        toggleDensity,
        currentView,
        getActiveScope,
        applyAreaFilterShortcut,
    ]);

    useEffect(() => {
        if (isTest || !isTauriRuntime()) return;
        let cancelled = false;
        import('@tauri-apps/api/core')
            .then(({ invoke }) =>
                invoke<GlobalQuickAddShortcutApplyResult>('set_global_quick_add_shortcut', { shortcut: quickAddShortcut })
            )
            .then((result) => {
                if (cancelled) return;
                const appliedShortcut = normalizeGlobalQuickAddShortcut(result?.shortcut, { isMac, isWindows });
                if (result?.warning) {
                    showToast(result.warning, 'info', 6000);
                }
                if (appliedShortcut !== quickAddShortcut) {
                    updateSettings({ globalQuickAddShortcut: appliedShortcut })
                        .catch((error) => reportError('Failed to persist quick add shortcut fallback', error));
                }
            })
            .catch((error) => {
                if (cancelled) return;
                reportError('Failed to apply global quick add shortcut', error);
            });
        return () => {
            cancelled = true;
        };
    }, [isTest, isMac, isWindows, quickAddShortcut, showToast, updateSettings]);

    const contextValue = useMemo<KeybindingContextType>(() => ({
        style,
        setStyle,
        quickAddShortcut,
        setQuickAddShortcut,
        registerTaskListScope,
        openHelp,
    }), [style, setStyle, quickAddShortcut, setQuickAddShortcut, registerTaskListScope, openHelp]);

    return (
        <KeybindingContext.Provider value={contextValue}>
            {children}
            {isHelpOpen && (
                <KeybindingHelpModal
                    style={style}
                    onClose={() => setIsHelpOpen(false)}
                    currentView={currentView}
                    quickAddShortcut={quickAddShortcut}
                    t={t}
                />
            )}
        </KeybindingContext.Provider>
    );
}

export function useKeybindings(): KeybindingContextType {
    const context = useContext(KeybindingContext);
    if (!context) {
        throw new Error('useKeybindings must be used within a KeybindingProvider');
    }
    return context;
}
