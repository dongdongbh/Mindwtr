import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { isSandboxMode, resolveFeatureFlags, shallow, useTaskStore } from '@mindwtr/core';
import { useLanguage } from './language-context';
import { KeybindingHelpModal } from '../components/KeybindingHelpModal';
import { isFlatpakRuntime, isTauriRuntime } from '../lib/runtime';
import { reportError } from '../lib/report-error';
import { nextDensityMode } from '../lib/density';
import { takeUndoableAction } from '../lib/undo-registry';
import { logInfo, logWarn } from '../lib/app-log';
import { useUiStore } from '../store/ui-store';
import { saveStoredFullscreen } from '../lib/window-state';
import {
    applyGlobalQuickAddShortcut,
    type GlobalQuickAddShortcutSetting,
    matchesGlobalQuickAddShortcut,
    normalizeGlobalQuickAddShortcut,
} from '../lib/global-quick-add-shortcut';
import { areaFilterSelectionToFilters } from '@mindwtr/core';
import type { TaskStatus } from '@mindwtr/core';
import { getWorkspaceCache } from '../lib/workspace-cache';

export type KeybindingStyle = 'vim' | 'emacs' | 'standard';

function isKeybindingStyle(value: unknown): value is KeybindingStyle {
    return value === 'vim' || value === 'emacs' || value === 'standard';
}

export interface TaskListScope {
    kind: 'taskList';
    selectNext: () => void;
    selectPrev: () => void;
    selectFirst: () => void;
    selectLast: () => void;
    editSelected: () => void;
    openSelected?: () => void;
    openQuickActions?: () => void;
    toggleDoneSelected: () => void;
    toggleSelectSelected?: () => void;
    toggleFocusSelected?: () => void;
    renameSelected?: () => void;
    deleteSelected: () => void;
    setStatusSelected?: (status: TaskStatus) => void;
    copySelected?: (includeDescription: boolean, requireHighlight?: boolean) => boolean;
    focusAddInput?: () => boolean;
    // Move DOM focus onto the currently selected task's title and render its
    // highlight, so entering the list from the sidebar (ArrowRight / `l`)
    // selects a task instead of focusing the scroll container (#890). Returns
    // false when there is no task to select so the caller can fall back to
    // focusing the main-content container.
    focusSelected?: () => boolean;
}

export interface ProjectListScope {
    kind: 'projectList';
    selectNext: () => void;
    selectPrev: () => void;
    selectFirst: () => void;
    selectLast: () => void;
    focusSelected: () => boolean;
    activateSelected?: () => void;
    ownsFocus: () => boolean;
}

// Status chord: `s` then a letter sets the selected task's status (#860).
// Letters mirror the g-navigation chords (gi/gn/gw/gs/gd/ga).
const STATUS_CHORD_MAP: Record<string, TaskStatus> = {
    i: 'inbox',
    n: 'next',
    w: 'waiting',
    s: 'someday',
    d: 'done',
    a: 'archived',
};

interface KeybindingContextType {
    style: KeybindingStyle;
    setStyle: (style: KeybindingStyle) => void;
    quickAddShortcut: GlobalQuickAddShortcutSetting;
    setQuickAddShortcut: (shortcut: GlobalQuickAddShortcutSetting) => void;
    registerTaskListScope: (scope: TaskListScope | null) => void;
    registerProjectListScope: (scope: ProjectListScope | null) => void;
    openHelp: () => void;
}

const KeybindingContext = createContext<KeybindingContextType | undefined>(undefined);

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
        || target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

// An open modal dialog (global search, quick add, prompts) owns the keyboard:
// list shortcuts must never act on the view behind it. Without this, a stray
// Enter or 'e' with focus outside the dialog's input completed a task in the
// background Focus list from inside search (same class as the #848 menu fix).
function hasModalDialogOpen(): boolean {
    return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

// Dropdown panels are mounted only while open. Their trigger can retain focus,
// so target.closest() alone cannot protect the copy chord.
function hasOpenPopup(): boolean {
    return document.querySelector('[role="menu"], [role="listbox"]') !== null;
}

// Enter must keep activating whatever control actually has focus (buttons,
// menu items, links); the list-level Enter binding only fires when nothing
// interactive is focused.
function hasInteractiveFocus(): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    return Boolean(active.closest(
        'button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="link"], [contenteditable="true"]'
    ));
}

function hasTaskRowFocus(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.closest('[data-task-id]') !== null;
}

function hasProjectNestedControlFocus(target: EventTarget | null): boolean {
    const candidate = target instanceof Element
        ? target
        : document.activeElement instanceof Element
            ? document.activeElement
            : null;
    return candidate?.closest('[data-project-navigation-item] [data-project-selection-ignore="true"]') !== null;
}

const SIDEBAR_FOCUS_TARGET_SELECTOR = '[data-sidebar-section-toggle], [data-sidebar-item]';

function isAvailableSidebarFocusTarget(item: HTMLElement): boolean {
    if (item.matches(':disabled, [aria-disabled="true"]')) return false;
    return item.closest('[hidden], [aria-hidden="true"], [inert]') === null;
}

function getSidebarFocusTargets(root: ParentNode): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(SIDEBAR_FOCUS_TARGET_SELECTOR))
        .filter(isAvailableSidebarFocusTarget);
}

function moveSidebarFocus(target: EventTarget | null, direction: 'next' | 'prev'): boolean {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const origin = active ?? (target instanceof HTMLElement ? target : null);
    if (!origin) return false;
    const sidebar = origin.closest('[data-sidebar-nav]');
    if (!sidebar || origin.closest('[data-project-navigation-root], [data-context-navigation-root]')) return false;
    const items = getSidebarFocusTargets(sidebar);
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
    const currentItem = Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-item]'))
        .find((item) => (
            item.dataset.view === view
            || item.dataset.activeViews?.split(/\s+/).includes(view) === true
        ));
    const visibleItems = getSidebarFocusTargets(document);
    if (visibleItems.length === 0) return false;
    const owningSectionToggle = currentItem
        ?.closest('[data-sidebar-section]')
        ?.querySelector<HTMLElement>('[data-sidebar-section-toggle]');
    const match = currentItem && isAvailableSidebarFocusTarget(currentItem)
        ? currentItem
        : owningSectionToggle && isAvailableSidebarFocusTarget(owningSectionToggle)
            ? owningSectionToggle
            : visibleItems[0];
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

// Click the current view's visible add-task affordance so a keyboard add
// inherits its context — a project view's trigger presets that project —
// instead of always landing in the Inbox (#978).
function clickVisibleAddTaskTrigger(): boolean {
    const root = document.querySelector<HTMLElement>('[data-main-content]') ?? document.body;
    const target = Array.from(root.querySelectorAll<HTMLElement>('[data-add-task-trigger]'))
        .find((element) => {
            if ('disabled' in element && Boolean((element as HTMLButtonElement).disabled)) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
        });
    if (!target) return false;
    target.focus();
    target.click();
    return true;
}

function getAppScopedShortcutKey(event: KeyboardEvent): string {
    if (event.key.length !== 1) return event.key;
    // Caps Lock reports 'A' without Shift; decide the a/A pair by Shift alone
    // so Caps Lock doesn't arm the area chord instead of quick add (#865).
    if (event.key.toLowerCase() === 'a') return event.shiftKey ? 'A' : 'a';
    return event.key;
}

// A modifier pressed mid-chord (re-pressing Shift before the digit) must not
// consume and cancel the pending chord (#865).
const CHORD_MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

function getAreaChordKey(event: KeyboardEvent): string {
    // Users often hold Shift from the chord prefix into the digit (Shift+1
    // reports '!'), and some layouts put digits on shifted keys. Read the
    // digit from the physical key so the chord still lands (#865).
    const digit = /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    return digit ?? event.key;
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
    const sandboxMode = isSandboxMode();
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

    const initialStyle: KeybindingStyle = isKeybindingStyle(settings.keybindingStyle)
        ? settings.keybindingStyle
        : 'vim';
    const [style, setStyleState] = useState<KeybindingStyle>(initialStyle);
    const [isHelpOpen, setIsHelpOpen] = useState(false);
    const quickAddShortcut = useMemo(
        () => normalizeGlobalQuickAddShortcut(settings.globalQuickAddShortcut, {
            isFlatpak: isFlatpakRuntime(),
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
        updateSettings({ appearance: { density: nextDensityMode(settings.appearance?.density) } })
            .catch((error) => reportError('Failed to update density', error));
    }, [settings.appearance?.density, updateSettings]);
    const applyAreaFilterShortcut = useCallback((key: string): boolean => {
        const applySelection = (included: string[]) => {
            updateSettings({
                filters: {
                    ...(useTaskStore.getState().settings?.filters ?? {}),
                    ...areaFilterSelectionToFilters({ included, excluded: [] }),
                },
            }).catch((error) => reportError('Failed to update area filter', error));
        };

        if (key === '0') {
            applySelection([]);
            return true;
        }

        if (!/^[1-9]$/.test(key)) return false;

        const areaIndex = Number(key) - 1;
        const targetArea = sortedAreas[areaIndex];
        if (!targetArea) return false;

        applySelection([targetArea.id]);
        return true;
    }, [sortedAreas, updateSettings]);

    const scopeRef = useRef<TaskListScope | null>(null);
    const projectScopeRef = useRef<ProjectListScope | null>(null);
    const pendingRef = useRef<{ key: string | null; timestamp: number }>({ key: null, timestamp: 0 });

    useEffect(() => {
        if (isTest) return;
        const nextStyle = settings.keybindingStyle;
        if (isKeybindingStyle(nextStyle)) {
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
        if (pendingRef.current.key === 'y') pendingRef.current.key = null;
        scopeRef.current = scope;
    }, []);

    const registerProjectListScope = useCallback((scope: ProjectListScope | null) => {
        if (pendingRef.current.key === 'y') pendingRef.current.key = null;
        projectScopeRef.current = scope;
    }, []);

    useEffect(() => {
        const clearCopyChord = () => {
            if (pendingRef.current.key === 'y') pendingRef.current.key = null;
        };
        window.addEventListener('pointerdown', clearCopyChord);
        window.addEventListener('focusin', clearCopyChord);
        window.addEventListener('blur', clearCopyChord);
        return () => {
            window.removeEventListener('pointerdown', clearCopyChord);
            window.removeEventListener('focusin', clearCopyChord);
            window.removeEventListener('blur', clearCopyChord);
        };
    }, []);

    useEffect(() => {
        if (pendingRef.current.key === 'y') pendingRef.current.key = null;
    }, [currentView, style]);

    // Every task list decision — which task is selected, what a key does to it —
    // belongs to a registered TaskListScope built from the view's own ordered
    // task array (see `views/list/task-list-scope.ts`). A view that cannot
    // supply one (the calendar grid) registers nothing and keeps a single
    // last-resort affordance: entering the list focuses the first task row so
    // Tab/Enter still reach it (#890).
    const focusFirstTaskRow = useCallback((): boolean => {
        const root = document.querySelector<HTMLElement>('[data-main-content]') ?? document.body;
        const row = root.querySelector<HTMLElement>('[data-task-id]');
        if (!row) return false;
        row.scrollIntoView?.({ block: 'nearest' });
        // A comma selector returns the first match in document order, which is
        // the done button — Enter would then complete the task (#847). Prefer
        // the title toggle so Enter opens the task instead.
        const focusTarget = row.querySelector<HTMLElement>('[data-task-view-toggle]')
            ?? row.querySelector<HTMLElement>('button, [tabindex]:not([tabindex="-1"])');
        if (!focusTarget) return false;
        focusTarget.focus();
        return true;
    }, []);

    // Entering the list from the sidebar (ArrowRight / `l`) should focus the
    // selected task, not the scroll container — focusing the container painted
    // its focus ring around the whole list and left no task visibly selected
    // (#890). Fall back to the container only when there is no task to select.
    const focusTaskSelection = useCallback((): boolean => {
        if (scopeRef.current?.focusSelected?.()) return true;
        if (focusFirstTaskRow()) return true;
        return focusMainContent();
    }, [focusFirstTaskRow]);

    const focusActiveSelection = useCallback((): boolean => {
        if (currentView === 'projects' && projectScopeRef.current) {
            if (projectScopeRef.current.ownsFocus()) {
                projectScopeRef.current.activateSelected?.();
                return focusTaskSelection();
            }
            const active = document.activeElement;
            const focusIsInProjectWorkspace = active instanceof HTMLElement
                && (
                    active.closest('[data-project-workspace]') !== null
                    || active.closest('[data-task-id]') !== null
                );
            if (!focusIsInProjectWorkspace) {
                return projectScopeRef.current.focusSelected();
            }
        }
        return focusTaskSelection();
    }, [currentView, focusTaskSelection]);

    const focusPreviousPane = useCallback((): boolean => {
        const active = document.activeElement;
        const projectScope = projectScopeRef.current;
        if (
            currentView === 'projects'
            && projectScope
            && !projectScope.ownsFocus()
            && active instanceof HTMLElement
            && (
                active.closest('[data-project-workspace], [data-task-id]') !== null
                // Empty projects enter the main-content container instead of a task.
                || active.matches('[data-main-content]')
            )
            && projectScope.focusSelected()
        ) {
            return true;
        }
        return focusSidebarCurrentView(currentView);
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
            const storage = getWorkspaceCache();
            if (storage) saveStoredFullscreen(nextFullscreen, storage);
        } catch (error) {
            void logWarn('Failed to toggle fullscreen', {
                scope: 'keybinding',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
    }, []);

    // Timeline is opt-in (#1111), so its go-to key only exists while the view
    // does; with the flag off the key falls through like any unbound letter.
    const timelineEnabled = resolveFeatureFlags(settings).timeline;

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
        ...(timelineEnabled ? { t: 'timeline' } : {}),
        d: 'done',
        a: 'archived',
        // Capital T: lowercase t is Timeline. Trash can be hidden from the
        // sidebar (#1115), so a go-to chord is its only keyboard route.
        T: 'trash',
    }), [timelineEnabled]);

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
        ...(timelineEnabled ? { t: 'timeline' } : {}),
        d: 'done',
        A: 'archived',
        T: 'trash',
    }), [timelineEnabled]);

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
            if (hasModalDialogOpen()) return;

            const scope = scopeRef.current;
            const projectScope = projectScopeRef.current;
            const projectListOwnsFocus = projectScope?.ownsFocus() ?? false;
            const navigationScope = projectListOwnsFocus ? projectScope : scope;
            const now = Date.now();
            if (pendingRef.current.key && now - pendingRef.current.timestamp > 700) {
                pendingRef.current.key = null;
            }

            const pending = pendingRef.current.key;
            if (pending) {
                if (CHORD_MODIFIER_KEYS.has(e.key)) return;
                e.preventDefault();
                if (pending === 'g') {
                    if (e.key === 'g') {
                        navigationScope?.selectFirst();
                    } else if (vimGoMap[e.key]) {
                        onNavigate(vimGoMap[e.key]);
                    }
                } else if (pending === 'A') {
                    applyAreaFilterShortcut(getAreaChordKey(e));
                } else if (pending === 'd') {
                    if (!projectListOwnsFocus && e.key === 'd') {
                        scope?.deleteSelected();
                    }
                } else if (pending === 'y') {
                    if (!projectListOwnsFocus && !e.repeat && (e.key === 'y' || e.key === 'i')) {
                        scope?.copySelected?.(e.key === 'i');
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
                    navigationScope?.selectNext();
                    break;
                case 'k':
                    if (moveSidebarFocus(e.target, 'prev')) {
                        e.preventDefault();
                        break;
                    }
                    e.preventDefault();
                    navigationScope?.selectPrev();
                    break;
                case 'h':
                    if (focusPreviousPane()) {
                        e.preventDefault();
                    }
                    break;
                case 'l':
                    if (focusActiveSelection()) {
                        e.preventDefault();
                    }
                    break;
                case 'G':
                    e.preventDefault();
                    navigationScope?.selectLast();
                    break;
                case 'e':
                    e.preventDefault();
                    if (!projectListOwnsFocus) scope?.editSelected();
                    break;
                case '.':
                    e.preventDefault();
                    if (!projectListOwnsFocus) scope?.openQuickActions?.();
                    break;
                case 'x':
                    e.preventDefault();
                    if (!projectListOwnsFocus) scope?.toggleDoneSelected();
                    break;
                case 'Enter':
                    if (hasInteractiveFocus()) break;
                    e.preventDefault();
                    scope?.openSelected?.();
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
                case 'd':
                    e.preventDefault();
                    if (e.key !== 'd' || !projectListOwnsFocus) {
                        pendingRef.current = { key: e.key, timestamp: now };
                    }
                    break;
                case 'y':
                    if (!projectListOwnsFocus && scope && !hasOpenPopup()) {
                        e.preventDefault();
                        if (!e.repeat) pendingRef.current = { key: 'y', timestamp: now };
                    }
                    break;
                default:
                    break;
            }
        };

        // Gmail/Superhuman/Todoist-style task-action cluster: e done, x select,
        // Enter open, z undo, # delete. Navigation matches the Vim preset since
        // Gmail uses j/k and g-chords too.
        const handleStandard = (e: KeyboardEvent) => {
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
            if (hasModalDialogOpen()) return;

            const scope = scopeRef.current;
            const projectScope = projectScopeRef.current;
            const projectListOwnsFocus = projectScope?.ownsFocus() ?? false;
            const navigationScope = projectListOwnsFocus ? projectScope : scope;
            const now = Date.now();
            if (pendingRef.current.key && now - pendingRef.current.timestamp > 700) {
                pendingRef.current.key = null;
            }

            const pending = pendingRef.current.key;
            if (pending) {
                if (CHORD_MODIFIER_KEYS.has(e.key)) return;
                e.preventDefault();
                if (pending === 'g') {
                    if (e.key === 'g') {
                        navigationScope?.selectFirst();
                    } else if (vimGoMap[e.key]) {
                        onNavigate(vimGoMap[e.key]);
                    }
                } else if (pending === 'A') {
                    applyAreaFilterShortcut(getAreaChordKey(e));
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
                    navigationScope?.selectNext();
                    break;
                case 'k':
                    if (moveSidebarFocus(e.target, 'prev')) {
                        e.preventDefault();
                        break;
                    }
                    e.preventDefault();
                    navigationScope?.selectPrev();
                    break;
                case 'h':
                    if (focusPreviousPane()) {
                        e.preventDefault();
                    }
                    break;
                case 'l':
                    if (focusActiveSelection()) {
                        e.preventDefault();
                    }
                    break;
                case 'G':
                    e.preventDefault();
                    navigationScope?.selectLast();
                    break;
                case 'e':
                    e.preventDefault();
                    if (!projectListOwnsFocus) scope?.toggleDoneSelected();
                    break;
                case 'x':
                    e.preventDefault();
                    if (!projectListOwnsFocus) scope?.toggleSelectSelected?.();
                    break;
                case 'S':
                    e.preventDefault();
                    if (!projectListOwnsFocus) scope?.toggleFocusSelected?.();
                    break;
                case 'F2':
                    e.preventDefault();
                    if (!projectListOwnsFocus) scope?.renameSelected?.();
                    break;
                case '#':
                    e.preventDefault();
                    if (!projectListOwnsFocus) scope?.deleteSelected();
                    break;
                case 'z': {
                    const undo = takeUndoableAction();
                    if (undo) {
                        e.preventDefault();
                        undo();
                    }
                    break;
                }
                case 'Enter':
                    if (e.shiftKey && (!hasInteractiveFocus() || hasTaskRowFocus())) {
                        e.preventDefault();
                        scope?.editSelected();
                        break;
                    }
                    if (hasInteractiveFocus()) break;
                    e.preventDefault();
                    scope?.openSelected?.();
                    break;
                case '.':
                    e.preventDefault();
                    if (!projectListOwnsFocus) scope?.openQuickActions?.();
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
            if (hasModalDialogOpen()) return;
            const scope = scopeRef.current;
            const projectScope = projectScopeRef.current;
            const projectListOwnsFocus = projectScope?.ownsFocus() ?? false;
            const navigationScope = projectListOwnsFocus ? projectScope : scope;

            if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === 'Enter') {
                if (hasInteractiveFocus()) return;
                e.preventDefault();
                scope?.openSelected?.();
                return;
            }

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
                        if (moveSidebarFocus(e.target, 'next')) {
                            e.preventDefault();
                            break;
                        }
                        e.preventDefault();
                        navigationScope?.selectNext();
                        break;
                    case 'p':
                        if (moveSidebarFocus(e.target, 'prev')) {
                            e.preventDefault();
                            break;
                        }
                        e.preventDefault();
                        navigationScope?.selectPrev();
                        break;
                    case 'e':
                        e.preventDefault();
                        if (!projectListOwnsFocus) scope?.editSelected();
                        break;
                    case '.':
                        e.preventDefault();
                        if (!projectListOwnsFocus) scope?.openQuickActions?.();
                        break;
                    case 't':
                        e.preventDefault();
                        if (!projectListOwnsFocus) scope?.toggleDoneSelected();
                        break;
                    case 'd':
                        e.preventDefault();
                        if (!projectListOwnsFocus) scope?.deleteSelected();
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
            if (e.defaultPrevented) return;
            if (pendingRef.current.key === 'y' && (style !== 'vim' || e.key === 'F11' || e.metaKey || e.ctrlKey || e.altKey
                || CHORD_MODIFIER_KEYS.has(e.key) || editingTaskIdRef.current || isEditableTarget(e.target)
                || hasModalDialogOpen()
                || hasOpenPopup()
                || hasProjectNestedControlFocus(e.target)
            )) pendingRef.current.key = null;
            const isHelpToggleShortcut = style === 'emacs'
                ? e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'h' || e.key === '?')
                : !e.metaKey && !e.ctrlKey && !e.altKey && e.key === '?';
            if (isHelpOpen && (e.key === 'Escape' || isHelpToggleShortcut)) {
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
            // Open menus and listboxes own the keyboard: don't fire list
            // shortcuts (j/k, e, x, dd…) while focus sits in a popup (#848).
            if (
                e.target instanceof HTMLElement
                && e.target.closest('[role="menu"], [role="listbox"]')
            ) return;
            // Same for modal dialogs: arrows and app shortcuts must not reach
            // the list behind global search / quick add / prompts.
            if (hasModalDialogOpen()) return;
            // Project row controls (focus toggle and dnd handle) own their
            // keystrokes. In particular, dnd-kit uses Space/Arrow keys and
            // must not also move or mutate a stale task selection.
            if (hasProjectNestedControlFocus(e.target)) return;
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
                if (
                    !e.repeat
                    && !isEditableTarget(e.target)
                    && !isEditableTarget(document.activeElement)
                    && !window.getSelection()?.toString()
                    && !hasOpenPopup()
                    && !(projectScopeRef.current?.ownsFocus() ?? false)
                    && scopeRef.current?.copySelected?.(false, true)
                ) e.preventDefault();
                return;
            }
            if (pendingRef.current.key === 'y') {
                handleVim(e);
                return;
            }
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'Comma') {
                e.preventDefault();
                onNavigate('settings');
                return;
            }
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !isEditableTarget(e.target)) {
                const undo = takeUndoableAction();
                if (undo) {
                    e.preventDefault();
                    undo();
                }
                return;
            }
            if (!e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)) {
                const appShortcutKey = getAppScopedShortcutKey(e);
                const now = Date.now();
                if ((pendingRef.current.key === 'A' || pendingRef.current.key === 's') && now - pendingRef.current.timestamp > 700) {
                    pendingRef.current.key = null;
                }
                if (pendingRef.current.key && CHORD_MODIFIER_KEYS.has(e.key)) return;
                if (pendingRef.current.key === 'A') {
                    e.preventDefault();
                    applyAreaFilterShortcut(getAreaChordKey(e));
                    pendingRef.current.key = null;
                    return;
                }
                if (pendingRef.current.key === 's') {
                    e.preventDefault();
                    const status = STATUS_CHORD_MAP[e.key];
                    if (!(projectScopeRef.current?.ownsFocus() ?? false) && status) {
                        scopeRef.current?.setStatusSelected?.(status);
                    }
                    pendingRef.current.key = null;
                    return;
                }
                if (!pendingRef.current.key && appShortcutKey === 'A') {
                    e.preventDefault();
                    pendingRef.current = { key: 'A', timestamp: now };
                    return;
                }
                if (!pendingRef.current.key && appShortcutKey === 'a') {
                    e.preventDefault();
                    if (!scopeRef.current?.focusAddInput?.() && !clickVisibleAddTaskTrigger()) {
                        triggerQuickAdd();
                    }
                    return;
                }
                if (!pendingRef.current.key && appShortcutKey === 's') {
                    e.preventDefault();
                    if (!(projectScopeRef.current?.ownsFocus() ?? false)) {
                        pendingRef.current = { key: 's', timestamp: now };
                    }
                    return;
                }
                // Bare digits switch the area filter directly (1-9, 0 clears) —
                // the no-modifier complement of the Shift+A chord (#865). Read
                // from the physical key like the chord digits; unassigned digits
                // fall through untouched.
                if (!pendingRef.current.key && !e.shiftKey) {
                    const bareDigit = /^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1];
                    if (bareDigit && applyAreaFilterShortcut(bareDigit)) {
                        e.preventDefault();
                        return;
                    }
                }
                if (e.key === 'Insert') {
                    e.preventDefault();
                    if (!scopeRef.current?.focusAddInput?.() && !clickVisibleAddTaskTrigger()) {
                        triggerQuickAdd();
                    }
                    return;
                }
                if (e.key === 'ArrowDown') {
                    if (moveSidebarFocus(e.target, 'next')) {
                        e.preventDefault();
                        return;
                    }
                    e.preventDefault();
                    if (projectScopeRef.current?.ownsFocus()) {
                        projectScopeRef.current.selectNext();
                    } else {
                        scopeRef.current?.selectNext();
                    }
                    return;
                }
                if (e.key === 'ArrowUp') {
                    if (moveSidebarFocus(e.target, 'prev')) {
                        e.preventDefault();
                        return;
                    }
                    e.preventDefault();
                    if (projectScopeRef.current?.ownsFocus()) {
                        projectScopeRef.current.selectPrev();
                    } else {
                        scopeRef.current?.selectPrev();
                    }
                    return;
                }
                if (style !== 'emacs' && e.key === 'ArrowLeft') {
                    if (focusPreviousPane()) {
                        e.preventDefault();
                        return;
                    }
                }
                if (style !== 'emacs' && e.key === 'ArrowRight') {
                    if (focusActiveSelection()) {
                        e.preventDefault();
                        return;
                    }
                }
            }
            // Native builds give this shortcut one owner: Tauri opens the
            // standalone window. Browser/PWA builds keep the webview fallback.
            if (
                !isTauriRuntime()
                && !isEditableTarget(e.target)
                && matchesGlobalQuickAddShortcut(e, quickAddShortcut)
            ) {
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
            } else if (style === 'standard') {
                handleStandard(e);
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
        focusActiveSelection,
        focusPreviousPane,
        applyAreaFilterShortcut,
    ]);

    // Only apply the shortcut once the settings document has loaded (deviceId is
    // stamped on every load). Before that, `quickAddShortcut` is the platform
    // default, and persisting the registration fallback into the not-yet-loaded
    // store wiped the on-disk data on machines where registration fails (#852).
    const isStoreHydrated = Boolean(settings.deviceId);
    useEffect(() => {
        if (sandboxMode || isTest || !isTauriRuntime() || !isStoreHydrated) return;
        let cancelled = false;
        applyGlobalQuickAddShortcut(quickAddShortcut)
            .then((result) => {
                if (cancelled) return;
                const appliedShortcut = normalizeGlobalQuickAddShortcut(result?.shortcut, {
                    isFlatpak: isFlatpakRuntime(),
                    isMac,
                    isWindows,
                });
                void logInfo('Hydrated global quick add shortcut applied', {
                    scope: 'shortcuts',
                    force: true,
                    extra: {
                        releaseCheck: 'v1.3.4/global-shortcut-startup',
                        requestedShortcut: quickAddShortcut,
                        appliedShortcut,
                        outcome: appliedShortcut === quickAddShortcut ? 'applied' : 'fallback',
                    },
                });
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
    }, [isTest, isMac, isWindows, isStoreHydrated, quickAddShortcut, showToast, updateSettings]);

    const contextValue = useMemo<KeybindingContextType>(() => ({
        style,
        setStyle,
        quickAddShortcut,
        setQuickAddShortcut,
        registerTaskListScope,
        registerProjectListScope,
        openHelp,
    }), [style, setStyle, quickAddShortcut, setQuickAddShortcut, registerTaskListScope, registerProjectListScope, openHelp]);

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

// Views register their task list opportunistically: one rendered outside the
// provider (unit tests, embedded previews) simply has no keyboard scope.
export function useOptionalKeybindings(): KeybindingContextType | null {
    return useContext(KeybindingContext) ?? null;
}

export function useKeybindings(): KeybindingContextType {
    const context = useContext(KeybindingContext);
    if (!context) {
        throw new Error('useKeybindings must be used within a KeybindingProvider');
    }
    return context;
}
