import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Calendar, CalendarClock, Check, ChevronRight, Copy, Flag, Folder, FolderPlus, MapPin, Pencil, Rows3, Tag, Trash2 } from 'lucide-react';
import {
    getAdvancedReviewDate,
    isDueForReview,
    safeParseDate,
    tFallback,
    type Area,
    type Project,
    type StoreActionResult,
    type Task,
    type TaskPriority,
    type TaskStatus,
} from '@mindwtr/core';
import { joinDateTime, splitDateTime } from '@mindwtr/core/date-draft';

import { reportError } from '../../lib/report-error';
import { cn } from '../../lib/utils';
import { FocusStarIcon } from '../FocusStarIcon';
import { Button } from '../ui/Button';
import { AreaSelector } from '../ui/AreaSelector';
import { ProjectSelector } from '../ui/ProjectSelector';
import { normalizeDateInputValue } from './task-item-helpers';
import { ContextsField } from './fields/TaskMetadataFields';
import { PriorityFlag } from './PriorityFlag';
import { DateField } from '../ui/DateField';

const VIEWPORT_MARGIN_PX = 8;
const PANEL_GAP_PX = 8;
const MENU_WIDTH_PX = 224;

type QuickPanelId = 'startTime' | 'dueDate' | 'reviewAt' | 'project' | 'area' | 'contexts' | 'priority' | null;

export interface TaskQuickActionMenuProps {
    task: Task;
    x: number;
    y: number;
    t: (key: string) => string;
    dateFormatSetting?: string | null;
    nativeDateInputLocale: string;
    contextOptions: string[];
    contextSuggestions?: string[];
    areas: Area[];
    projects: Project[];
    readOnly: boolean;
    prioritiesEnabled: boolean;
    focusAction?: {
        isFocused: boolean;
        canToggle: boolean;
        label: string;
        title: string;
        onToggle: () => void;
    };
    /**
     * `restoreFocus: false` marks a dismissal where focus should follow the
     * pointer (outside click/right-click, scroll) instead of returning to the
     * row's trigger — a deferred focus-return there lands after whatever the
     * pointer opened next and paints the old row's focus ring (#999).
     */
    onClose: (options?: { restoreFocus?: boolean }) => void;
    onRename?: () => void;
    onDuplicate: () => void;
    onPromoteToProject?: () => void;
    onConvertToSection?: () => void;
    onDelete: () => void;
    onStatusChange: (status: TaskStatus) => void;
    onCreateArea: (name: string) => Promise<string | null>;
    onUpdateTask: (updates: Partial<Task>) => Promise<StoreActionResult>;
    /** Extra entries rendered above Delete. Generic by design — the menu does not interpret them. */
    extraActions?: Array<{
        id: string;
        label: string;
        onSelect: () => void;
    }>;
}

const clamp = (value: number, min: number, max: number) => {
    if (max <= min) return min;
    return Math.min(Math.max(value, min), max);
};

// The mousedown that dismisses the menu (an "outside" click) must not also
// activate whatever control is underneath it — closing unmounts the menu
// synchronously, so a listener scoped to its own effect would already be
// gone by the time the matching `click` event arrives. Registered directly
// on window, independent of any component's lifecycle, so it survives.
const suppressDismissClick = () => {
    const cleanup = () => {
        window.removeEventListener('click', swallow, true);
        window.removeEventListener('mouseup', endGesture, true);
        window.removeEventListener('dragstart', cleanup, true);
    };
    function swallow(event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
        cleanup();
    }
    // The swallower must last exactly one gesture: long enough to eat that
    // gesture's click, and no longer. Both bounds have bitten:
    // - A timer started at mousedown fires while the button is still held, since
    //   `click` only arrives after `mouseup` — the swallower is gone before the
    //   click it exists for.
    // - Removing it only on the click leaks when no click ever comes, and the
    //   stale listener then eats an unrelated later one.
    // mouseup is the end of the press, and the click that belongs to it is
    // dispatched immediately afterwards in the same task, so cleaning up in a
    // task scheduled from mouseup always runs after the click was swallowed.
    function endGesture() {
        window.setTimeout(cleanup, 0);
    }
    window.addEventListener('click', swallow, { capture: true, once: true });
    window.addEventListener('mouseup', endGesture, { capture: true, once: true });
    // A press that becomes a drag produces neither mouseup nor click.
    window.addEventListener('dragstart', cleanup, { capture: true, once: true });
};

const parseTokenInput = (value: string) => Array.from(new Set(
    value
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)
));

const preserveFocusedDatePanelLayout = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Keep focus on the date input while Save/Cancel is pressed so DateField's
    // blur teardown does not run mid-click.
    event.preventDefault();
};

export function TaskQuickActionMenu({
    task,
    x,
    y,
    t,
    dateFormatSetting,
    nativeDateInputLocale,
    contextOptions,
    contextSuggestions = contextOptions,
    areas,
    projects,
    readOnly,
    prioritiesEnabled,
    focusAction,
    onClose,
    onRename,
    onDuplicate,
    onPromoteToProject,
    onConvertToSection,
    onDelete,
    onStatusChange,
    onCreateArea,
    onUpdateTask,
    extraActions = [],
}: TaskQuickActionMenuProps) {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const focusedPanelRef = useRef<QuickPanelId>(null);
    const initialLayoutScrollSettledRef = useRef(false);
    const startButtonRef = useRef<HTMLButtonElement | null>(null);
    const dueButtonRef = useRef<HTMLButtonElement | null>(null);
    const reviewButtonRef = useRef<HTMLButtonElement | null>(null);
    const projectButtonRef = useRef<HTMLButtonElement | null>(null);
    const areaButtonRef = useRef<HTMLButtonElement | null>(null);
    const contextsButtonRef = useRef<HTMLButtonElement | null>(null);
    const priorityButtonRef = useRef<HTMLButtonElement | null>(null);
    const [activePanel, setActivePanel] = useState<QuickPanelId>(null);
    const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
    const [menuSize, setMenuSize] = useState({ width: MENU_WIDTH_PX, height: 1 });
    const initialStartDraft = splitDateTime(task.startTime);
    const initialDueDraft = splitDateTime(task.dueDate);
    const initialReviewDraft = splitDateTime(task.reviewAt);
    const initialProjectDraft = task.projectId || '';
    const initialAreaDraft = task.areaId || '';
    const initialContextsDraft = task.contexts?.join(', ') || '';
    const [startDateDraft, setStartDateDraft] = useState(initialStartDraft.date);
    const [startTimeDraft, setStartTimeDraft] = useState(initialStartDraft.time);
    const [dueDateDraft, setDueDateDraft] = useState(initialDueDraft.date);
    const [dueTimeDraft, setDueTimeDraft] = useState(initialDueDraft.time);
    const [reviewDateDraft, setReviewDateDraft] = useState(initialReviewDraft.date);
    const [reviewTimeDraft, setReviewTimeDraft] = useState(initialReviewDraft.time);
    const [projectDraft, setProjectDraft] = useState(initialProjectDraft);
    const [areaDraft, setAreaDraft] = useState(initialAreaDraft);
    const [contextsDraft, setContextsDraft] = useState(initialContextsDraft);
    const [savingPanel, setSavingPanel] = useState<Exclude<QuickPanelId, null> | null>(null);
    const startLabel = tFallback(t, 'taskEdit.startDateLabel', 'Start Date');
    const dueLabel = tFallback(t, 'taskEdit.dueDateLabel', 'Due Date');
    const reviewLabel = tFallback(t, 'taskEdit.reviewDateLabel', 'Review Date');
    const projectLabel = tFallback(t, 'taskEdit.projectLabel', 'Project');
    const areaLabel = tFallback(t, 'taskEdit.areaLabel', 'Area');
    const contextsLabel = tFallback(t, 'taskEdit.contextsLabel', 'Contexts');
    const priorityLabel = tFallback(t, 'taskEdit.priorityLabel', 'Priority');
    const clearPriorityLabel = tFallback(t, 'common.clear', 'Clear');
    const priorityChoices: Array<{ value: TaskPriority | ''; label: string }> = [
        { value: '', label: clearPriorityLabel },
        { value: 'low', label: tFallback(t, 'priority.low', 'Low') },
        { value: 'medium', label: tFallback(t, 'priority.medium', 'Medium') },
        { value: 'high', label: tFallback(t, 'priority.high', 'High') },
        { value: 'urgent', label: tFallback(t, 'priority.urgent', 'Urgent') },
    ];
    const noProjectLabel = tFallback(t, 'taskEdit.noProjectOption', 'No Project');
    const searchProjectsLabel = tFallback(t, 'projects.search', 'Search projects');
    const noAreaLabel = tFallback(t, 'taskEdit.noAreaOption', 'No Area');
    const renameLabel = tFallback(t, 'task.renameTitle', 'Rename task');
    const duplicateLabel = tFallback(t, 'projects.duplicate', 'Duplicate');
    const promoteToProjectLabel = t('task.createProjectFromTask');
    const deleteLabel = tFallback(t, 'common.delete', 'Delete');
    const convertToReferenceLabel = tFallback(t, 'task.convertToReference', 'Convert to Reference');
    const convertToSectionLabel = tFallback(t, 'task.convertToSection', 'Convert to Section');
    const markReviewedLabel = tFallback(t, 'review.markReviewed', 'Mark reviewed');
    const advanceReviewLabel = tFallback(t, 'review.advanceWeek', 'Review in 1 week');
    const saveLabel = tFallback(t, 'common.save', 'Save');
    const cancelLabel = tFallback(t, 'common.cancel', 'Cancel');
    const moreOptionsLabel = tFallback(t, 'taskEdit.moreOptions', 'More options');
    const searchAreasLabel = tFallback(t, 'areas.search', 'Search areas');
    const noMatchesLabel = tFallback(t, 'common.noMatches', 'No matches');
    const createAreaLabel = tFallback(t, 'areas.create', 'Create area');
    const canEditArea = !task.projectId;
    const canMarkReviewed = isDueForReview(task.reviewAt);
    const normalizedInitialContexts = parseTokenInput(initialContextsDraft);
    const normalizedDraftContexts = parseTokenInput(contextsDraft);
    const startDraftChanged = startDateDraft !== initialStartDraft.date || startTimeDraft !== initialStartDraft.time;
    const dueDraftChanged = dueDateDraft !== initialDueDraft.date || dueTimeDraft !== initialDueDraft.time;
    const reviewDraftChanged = reviewDateDraft !== initialReviewDraft.date || reviewTimeDraft !== initialReviewDraft.time;
    const projectDraftChanged = projectDraft !== initialProjectDraft;
    const areaDraftChanged = areaDraft !== initialAreaDraft;
    const contextsDraftChanged = normalizedDraftContexts.join('\u0000') !== normalizedInitialContexts.join('\u0000');

    useEffect(() => {
        const nextStartDraft = splitDateTime(task.startTime);
        const nextDueDraft = splitDateTime(task.dueDate);
        const nextReviewDraft = splitDateTime(task.reviewAt);
        setStartDateDraft(nextStartDraft.date);
        setStartTimeDraft(nextStartDraft.time);
        setDueDateDraft(nextDueDraft.date);
        setDueTimeDraft(nextDueDraft.time);
        setReviewDateDraft(nextReviewDraft.date);
        setReviewTimeDraft(nextReviewDraft.time);
        setProjectDraft(task.projectId || '');
        setAreaDraft(task.areaId || '');
        setContextsDraft(task.contexts?.join(', ') || '');
    }, [task.areaId, task.contexts, task.dueDate, task.id, task.projectId, task.reviewAt, task.startTime]);

    // Focus the menu container, not the first item — like native context menus,
    // nothing is highlighted until the first arrow press, and key events still
    // land inside the menu so the app-wide shortcuts stay suppressed.
    useEffect(() => {
        menuRef.current?.focus();
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            initialLayoutScrollSettledRef.current = true;
        }, 120);
        return () => window.clearTimeout(timer);
    }, []);

    useEffect(() => {
        const isInsideMenuSurface = (target: Node | null) => {
            if (!target) return false;
            if (menuRef.current?.contains(target) || panelRef.current?.contains(target)) return true;
            const targetElement = target instanceof Element ? target : target.parentElement;
            return Boolean(targetElement?.closest('[data-selector-dropdown="true"]'));
        };
        const handlePointer = (event: Event) => {
            const target = event.target as Node | null;
            if (isInsideMenuSurface(target)) return;
            // Only mousedown has a click that could follow it in the same
            // gesture — contextmenu (a right-click elsewhere) never fires one.
            if (event.type === 'mousedown') suppressDismissClick();
            onClose({ restoreFocus: false });
        };
        const handleScrollOrResize = (event: Event) => {
            if (event.type === 'scroll') {
                if (!initialLayoutScrollSettledRef.current) return;
                // A scroll from the menu's own surface must not dismiss it: its
                // panels and dropdowns scroll, and focusing a partially clipped
                // item on mousedown scrolls it into view — closing here killed
                // the click before mouseup, a menu tap that silently did
                // nothing. The list scrolling behind the menu still closes it.
                const scrollTarget = event.target instanceof Node ? event.target : null;
                if (isInsideMenuSurface(scrollTarget)) return;
            }
            onClose({ restoreFocus: false });
        };
        const getMenuItems = () => Array.from(
            menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
        );
        const moveMenuFocus = (delta: number) => {
            const items = getMenuItems();
            if (items.length === 0) return;
            const currentIndex = items.findIndex((item) => item === document.activeElement);
            const nextIndex = currentIndex < 0
                ? (delta > 0 ? 0 : items.length - 1)
                : (currentIndex + delta + items.length) % items.length;
            items[nextIndex]?.focus();
        };
        const getPanelAnchor = (panelId: Exclude<QuickPanelId, null>) => (
            panelId === 'startTime'
                ? startButtonRef.current
                : panelId === 'dueDate'
                    ? dueButtonRef.current
                    : panelId === 'reviewAt'
                        ? reviewButtonRef.current
                        : panelId === 'project'
                            ? projectButtonRef.current
                            : panelId === 'area'
                                ? areaButtonRef.current
                                : panelId === 'priority'
                                    ? priorityButtonRef.current
                                    : contextsButtonRef.current
        );
        const closeActivePanel = () => {
            if (!activePanel) return;
            const anchor = getPanelAnchor(activePanel);
            setActivePanel(null);
            anchor?.focus();
        };
        // Runs in the capture phase so the app-wide shortcut handler never sees
        // keys the open menu consumes (arrows would otherwise move the list
        // selection behind the menu and close it via the scroll listener).
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Node ? event.target : null;
            const inSelectorDropdown = Boolean(
                target instanceof Element && target.closest('[data-selector-dropdown="true"]'),
            );
            if (event.key === 'Escape') {
                // An open selector dropdown is one layer deeper — it closes
                // itself on Escape; the panel takes the next press.
                if (inSelectorDropdown) return;
                event.preventDefault();
                event.stopPropagation();
                if (activePanel) {
                    closeActivePanel();
                    return;
                }
                onClose();
                return;
            }
            const inPanelSurface = inSelectorDropdown
                || Boolean(target && panelRef.current?.contains(target));
            if (inPanelSurface) return;

            switch (event.key) {
                case 'ArrowDown':
                    moveMenuFocus(1);
                    break;
                case 'ArrowUp':
                    moveMenuFocus(-1);
                    break;
                case 'Home':
                    getMenuItems()[0]?.focus();
                    break;
                case 'End': {
                    const items = getMenuItems();
                    items[items.length - 1]?.focus();
                    break;
                }
                case 'ArrowRight': {
                    const active = document.activeElement;
                    if (
                        active instanceof HTMLElement
                        && menuRef.current?.contains(active)
                        && active.getAttribute('aria-haspopup') === 'dialog'
                        && active.getAttribute('aria-expanded') !== 'true'
                    ) {
                        active.click();
                        break;
                    }
                    return;
                }
                case 'ArrowLeft':
                    if (!activePanel) return;
                    closeActivePanel();
                    break;
                default:
                    return;
            }
            event.preventDefault();
            event.stopPropagation();
        };
        window.addEventListener('mousedown', handlePointer);
        window.addEventListener('scroll', handleScrollOrResize, true);
        window.addEventListener('resize', handleScrollOrResize);
        window.addEventListener('contextmenu', handlePointer);
        window.addEventListener('keydown', handleKeyDown, true);
        return () => {
            window.removeEventListener('mousedown', handlePointer);
            window.removeEventListener('scroll', handleScrollOrResize, true);
            window.removeEventListener('resize', handleScrollOrResize);
            window.removeEventListener('contextmenu', handlePointer);
            window.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [activePanel, onClose]);

    const menuPosition = {
        left: clamp(
            x,
            VIEWPORT_MARGIN_PX,
            window.innerWidth - menuSize.width - VIEWPORT_MARGIN_PX,
        ),
        top: clamp(
            y,
            VIEWPORT_MARGIN_PX,
            window.innerHeight - menuSize.height - VIEWPORT_MARGIN_PX,
        ),
    };

    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (!menu) return;
        const rect = menu.getBoundingClientRect();
        const nextSize = {
            width: Math.ceil(rect.width) || MENU_WIDTH_PX,
            height: Math.ceil(rect.height) || 1,
        };
        setMenuSize((current) => (
            current.width === nextSize.width && current.height === nextSize.height
                ? current
                : nextSize
        ));
    }, [canEditArea, readOnly]);

    useLayoutEffect(() => {
        if (!activePanel) {
            setPanelPosition(null);
            return;
        }
        const anchor = activePanel === 'startTime'
            ? startButtonRef.current
            : activePanel === 'dueDate'
                ? dueButtonRef.current
                : activePanel === 'reviewAt'
                    ? reviewButtonRef.current
                    : activePanel === 'project'
                        ? projectButtonRef.current
                        : activePanel === 'area'
                            ? areaButtonRef.current
                            : activePanel === 'priority'
                                ? priorityButtonRef.current
                                : contextsButtonRef.current;
        const panel = panelRef.current;
        if (!anchor || !panel) return;
        const anchorRect = anchor.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const preferredLeft = anchorRect.right + PANEL_GAP_PX;
        const fallbackLeft = anchorRect.left - panelRect.width - PANEL_GAP_PX;
        const shouldOpenLeft = preferredLeft + panelRect.width > window.innerWidth - VIEWPORT_MARGIN_PX
            && fallbackLeft >= VIEWPORT_MARGIN_PX;

        setPanelPosition({
            left: clamp(
                shouldOpenLeft ? fallbackLeft : preferredLeft,
                VIEWPORT_MARGIN_PX,
                window.innerWidth - panelRect.width - VIEWPORT_MARGIN_PX,
            ),
            top: clamp(
                anchorRect.top,
                VIEWPORT_MARGIN_PX,
                window.innerHeight - panelRect.height - VIEWPORT_MARGIN_PX,
            ),
        });
    }, [activePanel, menuPosition.left, menuPosition.top]);

    useEffect(() => {
        if (!activePanel || !panelPosition) {
            if (!activePanel) focusedPanelRef.current = null;
            return;
        }
        if (focusedPanelRef.current === activePanel) return;
        focusedPanelRef.current = activePanel;
        const focusable = panelRef.current?.querySelector<HTMLElement>(
            'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        focusable?.focus();
    }, [activePanel, panelPosition]);

    if (typeof document === 'undefined') return null;

    const openPanel = (panelId: Exclude<QuickPanelId, null>) => {
        if (panelId === activePanel) {
            setPanelPosition(null);
            setActivePanel(null);
            return;
        }
        setPanelPosition(null);
        if (panelId === 'startTime') {
            const nextStartDraft = splitDateTime(task.startTime);
            setStartDateDraft(nextStartDraft.date);
            setStartTimeDraft(nextStartDraft.time);
        } else if (panelId === 'dueDate') {
            const nextDueDraft = splitDateTime(task.dueDate);
            setDueDateDraft(nextDueDraft.date);
            setDueTimeDraft(nextDueDraft.time);
        } else if (panelId === 'reviewAt') {
            const nextReviewDraft = splitDateTime(task.reviewAt);
            setReviewDateDraft(nextReviewDraft.date);
            setReviewTimeDraft(nextReviewDraft.time);
        } else if (panelId === 'project') {
            setProjectDraft(task.projectId || '');
        } else if (panelId === 'area') {
            setAreaDraft(task.areaId || '');
        } else if (panelId === 'priority') {
            // The priority panel applies immediately from task state; no draft to reset.
        } else {
            setContextsDraft(task.contexts?.join(', ') || '');
        }
        setActivePanel(panelId);
    };

    const handleStartDateSave = async (
        dateDraft = startDateDraft,
        timeDraft = startTimeDraft,
    ) => {
        setSavingPanel('startTime');
        try {
            const normalizedDate = normalizeDateInputValue(dateDraft);
            const nextStartTime = normalizedDate ? joinDateTime(normalizedDate, timeDraft) : undefined;
            const result = await onUpdateTask({ startTime: nextStartTime });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task start date');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task start date from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleDueDateSave = async (
        dateDraft = dueDateDraft,
        timeDraft = dueTimeDraft,
    ) => {
        setSavingPanel('dueDate');
        try {
            const normalizedDate = normalizeDateInputValue(dateDraft);
            const nextDueDate = normalizedDate ? joinDateTime(normalizedDate, timeDraft) : undefined;
            const result = await onUpdateTask({ dueDate: nextDueDate });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task due date');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task due date from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleReviewDateSave = async (
        dateDraft = reviewDateDraft,
        timeDraft = reviewTimeDraft,
    ) => {
        setSavingPanel('reviewAt');
        try {
            const normalizedDate = normalizeDateInputValue(dateDraft);
            const nextReviewAt = normalizedDate ? joinDateTime(normalizedDate, timeDraft) : undefined;
            const result = await onUpdateTask({ reviewAt: nextReviewAt });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task review date');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task review date from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleMarkReviewed = async () => {
        setSavingPanel('reviewAt');
        try {
            const result = await onUpdateTask({ reviewAt: undefined });
            if (!result.success) {
                throw new Error(result.error || 'Failed to mark task reviewed');
            }
            onClose();
        } catch (error) {
            reportError('Failed to mark task reviewed from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleAdvanceReview = async () => {
        setSavingPanel('reviewAt');
        try {
            const result = await onUpdateTask({ reviewAt: getAdvancedReviewDate(task.reviewAt) });
            if (!result.success) {
                throw new Error(result.error || 'Failed to advance task review date');
            }
            onClose();
        } catch (error) {
            reportError('Failed to advance task review date from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleProjectSave = async () => {
        setSavingPanel('project');
        try {
            // A section belongs to one project, so leaving the project drops it.
            const result = await onUpdateTask({ projectId: projectDraft || undefined, sectionId: undefined });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task project');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task project from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleAreaSave = async () => {
        setSavingPanel('area');
        try {
            const result = await onUpdateTask({ areaId: areaDraft || undefined });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task area');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task area from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleContextsSave = async () => {
        setSavingPanel('contexts');
        try {
            const result = await onUpdateTask({ contexts: parseTokenInput(contextsDraft) });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task contexts');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task contexts from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handlePrioritySave = async (nextPriority: TaskPriority | '') => {
        setSavingPanel('priority');
        try {
            const result = await onUpdateTask({ priority: nextPriority || undefined });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task priority');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task priority from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    // Enter in a panel field confirms like the Save button (#992). Buttons act
    // on Enter natively, and an open selector dropdown / suggestion list
    // consumes it one layer deeper (arriving here already default-prevented or
    // not at all), so both are left alone.
    const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' || event.defaultPrevented || !activePanel) return;
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest('button, [data-selector-dropdown="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
        if (savingPanel) return;
        if (activePanel === 'startTime') {
            if (startDraftChanged) void handleStartDateSave();
            else onClose();
        } else if (activePanel === 'dueDate') {
            if (dueDraftChanged) void handleDueDateSave();
            else onClose();
        } else if (activePanel === 'reviewAt') {
            if (reviewDraftChanged) void handleReviewDateSave();
            else onClose();
        } else if (activePanel === 'project') {
            if (projectDraftChanged) void handleProjectSave();
            else onClose();
        } else if (activePanel === 'area') {
            if (areaDraftChanged) void handleAreaSave();
            else onClose();
        } else if (contextsDraftChanged) {
            void handleContextsSave();
        } else {
            onClose();
        }
    };

    const renderMenuAction = ({
        key,
        ref,
        icon,
        label,
        active = false,
        onClick,
        showChevron = false,
        disabled = false,
        title,
    }: {
        key?: string;
        ref?: RefObject<HTMLButtonElement | null>;
        icon?: ReactNode;
        label: string;
        active?: boolean;
        onClick: () => void;
        showChevron?: boolean;
        disabled?: boolean;
        title?: string;
    }) => (
        <button
            key={key}
            ref={ref}
            type="button"
            role="menuitem"
            aria-haspopup={showChevron ? 'dialog' : undefined}
            aria-expanded={showChevron ? active : undefined}
            disabled={disabled}
            title={title}
            onClick={onClick}
            className={cn(
                // Plain focus: styles, not focus-visible: — keyboard traversal
                // moves focus programmatically, and WebKit does not always mark
                // that focus-visible, which left the focused item unhighlighted.
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus:outline-none focus:bg-muted focus-visible:ring-2 focus-visible:ring-primary/40',
                disabled
                    ? 'cursor-not-allowed text-muted-foreground/50'
                    : active
                        ? 'bg-muted text-foreground'
                        : 'text-foreground hover:bg-muted',
            )}
        >
            <span className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center',
                disabled ? 'text-muted-foreground/50' : 'text-muted-foreground',
            )}>{icon}</span>
            <span className="flex-1 truncate">{label}</span>
            {showChevron ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : null}
        </button>
    );

    return createPortal(
        <>
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label={moreOptionsLabel}
                    tabIndex={-1}
                    className="fixed z-50 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl focus:outline-none"
                    style={{ top: menuPosition.top, left: menuPosition.left }}
                    onContextMenu={(event) => event.preventDefault()}
                >
                {!readOnly && focusAction && renderMenuAction({
                    icon: (
                        <FocusStarIcon
                            className={cn(
                                'h-4 w-4',
                                focusAction.isFocused && 'text-warning',
                            )}
                            filled={focusAction.isFocused}
                        />
                    ),
                    label: focusAction.label,
                    title: focusAction.title,
                    disabled: !focusAction.canToggle,
                    onClick: () => {
                        if (!focusAction.canToggle) return;
                        focusAction.onToggle();
                        onClose();
                    },
                })}
                {!readOnly && focusAction ? <div className="my-1 h-px bg-border/70" role="separator" /> : null}
                {!readOnly && onRename && renderMenuAction({
                    icon: <Pencil className="h-4 w-4" />,
                    label: renameLabel,
                    onClick: () => {
                        onRename();
                        onClose();
                    },
                })}
                {!readOnly && renderMenuAction({
                    ref: startButtonRef,
                    icon: <Calendar className="h-4 w-4" />,
                    label: `${startLabel}…`,
                    active: activePanel === 'startTime',
                    onClick: () => openPanel('startTime'),
                    showChevron: true,
                })}
                {!readOnly && renderMenuAction({
                    ref: dueButtonRef,
                    icon: <Calendar className="h-4 w-4" />,
                    label: `${dueLabel}…`,
                    active: activePanel === 'dueDate',
                    onClick: () => openPanel('dueDate'),
                    showChevron: true,
                })}
                {!readOnly && renderMenuAction({
                    ref: reviewButtonRef,
                    icon: <CalendarClock className="h-4 w-4" />,
                    label: `${reviewLabel}…`,
                    active: activePanel === 'reviewAt',
                    onClick: () => openPanel('reviewAt'),
                    showChevron: true,
                })}
                {!readOnly && canMarkReviewed && renderMenuAction({
                    icon: <CalendarClock className="h-4 w-4" />,
                    label: markReviewedLabel,
                    onClick: () => { void handleMarkReviewed(); },
                })}
                {!readOnly && canMarkReviewed && renderMenuAction({
                    icon: <CalendarClock className="h-4 w-4" />,
                    label: advanceReviewLabel,
                    onClick: () => { void handleAdvanceReview(); },
                })}
                {!readOnly && renderMenuAction({
                    ref: projectButtonRef,
                    icon: <Folder className="h-4 w-4" />,
                    label: `${projectLabel}…`,
                    active: activePanel === 'project',
                    onClick: () => openPanel('project'),
                    showChevron: true,
                })}
                {!readOnly && canEditArea && renderMenuAction({
                    ref: areaButtonRef,
                    icon: <MapPin className="h-4 w-4" />,
                    label: `${areaLabel}…`,
                    active: activePanel === 'area',
                    onClick: () => openPanel('area'),
                    showChevron: true,
                })}
                {!readOnly && renderMenuAction({
                    ref: contextsButtonRef,
                    icon: <Tag className="h-4 w-4" />,
                    label: `${contextsLabel}…`,
                    active: activePanel === 'contexts',
                    onClick: () => openPanel('contexts'),
                    showChevron: true,
                })}
                {!readOnly && prioritiesEnabled && renderMenuAction({
                    ref: priorityButtonRef,
                    icon: <Flag className="h-4 w-4" />,
                    label: `${priorityLabel}…`,
                    active: activePanel === 'priority',
                    onClick: () => openPanel('priority'),
                    showChevron: true,
                })}
                {!readOnly && task.status !== 'reference' && renderMenuAction({
                    icon: <BookOpen className="h-4 w-4" />,
                    label: convertToReferenceLabel,
                    onClick: () => {
                        onStatusChange('reference');
                        onClose();
                    },
                })}
                {!readOnly && task.projectId && onConvertToSection && renderMenuAction({
                    icon: <Rows3 className="h-4 w-4" />,
                    label: convertToSectionLabel,
                    onClick: () => {
                        onConvertToSection();
                        onClose();
                    },
                })}
                {!readOnly ? <div className="my-1 h-px bg-border/70" role="separator" /> : null}
                {renderMenuAction({
                    icon: <Copy className="h-4 w-4" />,
                    label: duplicateLabel,
                    onClick: () => {
                        onDuplicate();
                        onClose();
                    },
                })}
                {!readOnly && onPromoteToProject && renderMenuAction({
                    icon: <FolderPlus className="h-4 w-4" />,
                    label: promoteToProjectLabel,
                    onClick: () => {
                        onPromoteToProject();
                        onClose();
                    },
                })}
                {extraActions.map((action) => renderMenuAction({
                    key: action.id,
                    label: action.label,
                    onClick: () => {
                        action.onSelect();
                        onClose();
                    },
                }))}
                {renderMenuAction({
                    icon: <Trash2 className="h-4 w-4" />,
                    label: deleteLabel,
                    onClick: () => {
                        onDelete();
                        onClose();
                    },
                })}
            </div>

            {activePanel && (
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label={
                        activePanel === 'startTime'
                            ? startLabel
                            : activePanel === 'dueDate'
                                ? dueLabel
                                : activePanel === 'reviewAt'
                                    ? reviewLabel
                                    : activePanel === 'project'
                                        ? projectLabel
                                        : activePanel === 'area'
                                            ? areaLabel
                                            : activePanel === 'priority'
                                                ? priorityLabel
                                                : contextsLabel
                    }
                    className="fixed z-50 w-[min(30rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
                    style={{
                        top: panelPosition?.top ?? menuPosition.top,
                        left: panelPosition?.left ?? (menuPosition.left + 188),
                        visibility: panelPosition ? 'visible' : 'hidden',
                    }}
                    onContextMenu={(event) => event.preventDefault()}
                    onKeyDown={handlePanelKeyDown}
                >
                    {activePanel === 'startTime' ? (
                        <div className="space-y-3">
                            <DateField
                                t={t}
                                label={startLabel}
                                dateAriaLabel={startLabel}
                                dateValue={startDateDraft}
                                selectedDate={safeParseDate(startDateDraft)}
                                dateFormatSetting={dateFormatSetting}
                                nativeDateInputLocale={nativeDateInputLocale}
                                dateInputClassName="rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                timeInput={
                                    <input
                                        type="time"
                                        lang={nativeDateInputLocale}
                                        aria-label={t('task.aria.startTime')}
                                        value={startTimeDraft}
                                        disabled={!startDateDraft}
                                        onChange={(event) => setStartTimeDraft(event.target.value)}
                                        className="w-24 shrink-0 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                }
                                onDateChange={(value) => {
                                    setStartDateDraft(value);
                                    if (!value) setStartTimeDraft('');
                                }}
                                onClear={() => {
                                    setStartDateDraft('');
                                    setStartTimeDraft('');
                                }}
                                hasValue={Boolean(startDateDraft || startTimeDraft)}
                            />
                            <div
                                className="flex items-center justify-end gap-2"
                                onMouseDown={preserveFocusedDatePanelLayout}
                            >
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setStartDateDraft(initialStartDraft.date);
                                        setStartTimeDraft(initialStartDraft.time);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => void handleStartDateSave()}
                                    loading={savingPanel === 'startTime'}
                                    disabled={!startDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : activePanel === 'dueDate' ? (
                        <div className="space-y-3">
                            <DateField
                                t={t}
                                label={dueLabel}
                                dateAriaLabel={dueLabel}
                                dateValue={dueDateDraft}
                                selectedDate={safeParseDate(dueDateDraft)}
                                dateFormatSetting={dateFormatSetting}
                                nativeDateInputLocale={nativeDateInputLocale}
                                dateInputClassName="rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                timeInput={
                                    <input
                                        type="time"
                                        lang={nativeDateInputLocale}
                                        aria-label={t('task.aria.dueTime')}
                                        value={dueTimeDraft}
                                        disabled={!dueDateDraft}
                                        onChange={(event) => setDueTimeDraft(event.target.value)}
                                        className="w-24 shrink-0 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                }
                                onDateChange={(value) => {
                                    setDueDateDraft(value);
                                    if (!value) setDueTimeDraft('');
                                }}
                                onClear={() => {
                                    setDueDateDraft('');
                                    setDueTimeDraft('');
                                }}
                                hasValue={Boolean(dueDateDraft || dueTimeDraft)}
                            />
                            <div
                                className="flex items-center justify-end gap-2"
                                onMouseDown={preserveFocusedDatePanelLayout}
                            >
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setDueDateDraft(initialDueDraft.date);
                                        setDueTimeDraft(initialDueDraft.time);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => void handleDueDateSave()}
                                    loading={savingPanel === 'dueDate'}
                                    disabled={!dueDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : activePanel === 'reviewAt' ? (
                        <div className="space-y-3">
                            <DateField
                                t={t}
                                label={reviewLabel}
                                dateAriaLabel={reviewLabel}
                                dateValue={reviewDateDraft}
                                selectedDate={safeParseDate(reviewDateDraft)}
                                dateFormatSetting={dateFormatSetting}
                                nativeDateInputLocale={nativeDateInputLocale}
                                dateInputClassName="rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                timeInput={
                                    <input
                                        type="time"
                                        lang={nativeDateInputLocale}
                                        aria-label={t('task.aria.reviewTime')}
                                        value={reviewTimeDraft}
                                        disabled={!reviewDateDraft}
                                        onChange={(event) => setReviewTimeDraft(event.target.value)}
                                        className="w-24 shrink-0 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                }
                                onDateChange={(value) => {
                                    setReviewDateDraft(value);
                                    if (!value) setReviewTimeDraft('');
                                }}
                                onClear={() => {
                                    setReviewDateDraft('');
                                    setReviewTimeDraft('');
                                }}
                                hasValue={Boolean(reviewDateDraft || reviewTimeDraft)}
                            />
                            <div
                                className="flex items-center justify-end gap-2"
                                onMouseDown={preserveFocusedDatePanelLayout}
                            >
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setReviewDateDraft(initialReviewDraft.date);
                                        setReviewTimeDraft(initialReviewDraft.time);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => void handleReviewDateSave()}
                                    loading={savingPanel === 'reviewAt'}
                                    disabled={!reviewDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : activePanel === 'project' ? (
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">{projectLabel}</label>
                                <ProjectSelector
                                    projects={projects}
                                    value={projectDraft}
                                    onChange={setProjectDraft}
                                    placeholder={noProjectLabel}
                                    noProjectLabel={noProjectLabel}
                                    searchPlaceholder={searchProjectsLabel}
                                    noMatchesLabel={noMatchesLabel}
                                    className="w-full"
                                />
                            </div>
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setProjectDraft(initialProjectDraft);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleProjectSave}
                                    loading={savingPanel === 'project'}
                                    disabled={!projectDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : activePanel === 'area' ? (
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">{areaLabel}</label>
                                <AreaSelector
                                    areas={areas}
                                    value={areaDraft}
                                    onChange={setAreaDraft}
                                    onCreateArea={onCreateArea}
                                    placeholder={noAreaLabel}
                                    noAreaLabel={noAreaLabel}
                                    searchPlaceholder={searchAreasLabel}
                                    noMatchesLabel={noMatchesLabel}
                                    createAreaLabel={createAreaLabel}
                                    className="w-full"
                                />
                            </div>
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setAreaDraft(initialAreaDraft);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleAreaSave}
                                    loading={savingPanel === 'area'}
                                    disabled={!areaDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : activePanel === 'priority' ? (
                        <div className="space-y-1">
                            {priorityChoices.map(({ value, label }) => {
                                const isSelected = (task.priority || '') === value;
                                return (
                                    <button
                                        key={value || 'none'}
                                        type="button"
                                        aria-pressed={isSelected}
                                        disabled={savingPanel === 'priority'}
                                        onClick={() => { void handlePrioritySave(value); }}
                                        className={cn(
                                            'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus:outline-none focus:bg-muted focus-visible:ring-2 focus-visible:ring-primary/40',
                                            isSelected
                                                ? 'bg-muted text-foreground'
                                                : 'text-foreground hover:bg-muted/60'
                                        )}
                                    >
                                        {value ? <PriorityFlag priority={value} /> : null}
                                        <span className="flex-1 truncate">{label}</span>
                                        {isSelected ? <Check className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <ContextsField
                                t={t}
                                value={contextsDraft}
                                options={contextOptions}
                                suggestions={contextSuggestions}
                                onChange={setContextsDraft}
                            />
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setContextsDraft(initialContextsDraft);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleContextsSave}
                                    loading={savingPanel === 'contexts'}
                                    disabled={!contextsDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </>,
        document.body,
    );
}
