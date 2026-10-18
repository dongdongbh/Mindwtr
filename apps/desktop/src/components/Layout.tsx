import { usePersistedViewState } from '../hooks/usePersistedViewState';
import { ViewSidebarContext } from '../contexts/view-sidebar-context';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
    Calendar,
    GanttChartSquare,
    Kanban,
    Tag,
    CheckCircle2,
    ChevronDown,
    Folder,
    Settings,
    Target,
    Search,
    ChevronsLeft,
    ChevronsRight,
    Trash2,
    History as HistoryIcon,
    BookOpen,
    AlertTriangle,
    Plus,
    RefreshCw,
    type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { isSandboxMode, shallow, useTaskStore, resolveFeatureFlags, safeFormatDate, tFallback, formatTaskMovedMessage, isSyncFileLockUnavailableError } from '@mindwtr/core';
import type { StoreActionResult, TaskStatus } from '@mindwtr/core';
import { showUndoToast } from '../lib/undo-registry';
import { undoTaskCompletion } from '../lib/undo-task-completion';
import { useLanguage } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';
import { useObsidianStore } from '../store/obsidian-store';
import { reportError } from '../lib/report-error';
import { showSyncErrorToast } from '../lib/sync-error-toast';
import { ToastHost } from './ToastHost';
import { areaFilterSelectionToFilters, isTaskVisibleInInbox, resolveAreaFilterSelection, type AreaFilterSelection } from '@mindwtr/core';
import { SyncService } from '../lib/sync-service';
import { SidebarAreaFilter } from './ui/SidebarAreaFilter';
import { getCalendarTaskDragTaskId, hasCalendarTaskDragData } from '../lib/calendar-task-drag';
import { stageCalendarDropLanding } from '../lib/calendar-view-params';
import { SandboxBanner } from './sandbox/SandboxBanner';
import { getWorkspaceCache } from '../lib/workspace-cache';
import { TASK_STATUS_ICONS } from '../lib/task-status-icons';
import { dismissCleartextSyncWarning, getCleartextSyncDestination, isCleartextSyncDismissed } from '../lib/cleartext-sync-warning';

function clampSidebarNavigationHeight(value: unknown, fallback = 60): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(20, Math.min(80, Math.round(value)))
        : fallback;
}

interface LayoutProps {
    children: React.ReactNode;
    currentView: string;
    contentView?: string;
    onViewChange: (view: string) => void;
    onOpenSyncSettings?: () => void;
}

type NavItem = {
    id: string;
    labelKey?: string;
    fallbackLabel?: string;
    icon: LucideIcon;
    count?: number;
    tone?: 'primary' | 'normal' | 'recessed';
    activeIds?: string[];
};

type NavSection = {
    key: string;
    label: string;
    items: NavItem[];
};

// Safety net only: drop and dragend clear the highlight immediately in every
// ordinary case, so this just catches a drag that ended without either (a source
// unmounted mid-drag). Kept well above the ~350ms browsers idle between dragover
// events on a stationary pointer, so the cue never flickers off mid-drag.
const TASK_DRAG_IDLE_MS = 1_000;

// Sidebar entries a dragged task can be dropped on to reclassify it. Only lists
// that ARE a status qualify: Focus is a flag rather than a status, Projects and
// the views below it are not destinations, and Trash is deliberately absent so a
// stray drag can never delete a task.
const NAV_DROP_STATUSES: Record<string, TaskStatus> = {
    inbox: 'inbox',
    someday: 'someday',
    waiting: 'waiting',
    reference: 'reference',
    // Done and Archived share the History entry; it opens on Done, so a drop files there.
    history: 'done',
};
const SECTION_COLLAPSE_STORAGE_KEY = 'mindwtr:sidebar:collapsedSections';
const DEFAULT_COLLAPSED_SECTION_KEYS = ['secondary'];

function createDefaultCollapsedSections(): Set<string> {
    return new Set(DEFAULT_COLLAPSED_SECTION_KEYS);
}

function loadCollapsedSections(): Set<string> {
    if (typeof window === 'undefined') return new Set();
    try {
        const raw = getWorkspaceCache()?.getItem(SECTION_COLLAPSE_STORAGE_KEY);
        if (!raw) return createDefaultCollapsedSections();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return createDefaultCollapsedSections();
        const stored = new Set(parsed.filter((v): v is string => typeof v === 'string'));
        // The old Archive section became part of More. Preserve an explicit
        // legacy collapse instead of resetting it during the regrouping.
        if (stored.has('archive')) stored.add('secondary');
        return stored;
    } catch {
        return createDefaultCollapsedSections();
    }
}

function saveCollapsedSections(keys: Set<string>) {
    if (typeof window === 'undefined') return;
    try {
        getWorkspaceCache()?.setItem(SECTION_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(keys)));
    } catch {
        // storage unavailable — fall back to in-memory only
    }
}

export function Layout({
    children,
    currentView,
    contentView = currentView,
    onViewChange,
    onOpenSyncSettings,
}: LayoutProps) {
    const sandboxMode = isSandboxMode();
    const { tasks, projects, areas, settings, updateSettings, error, setError } = useTaskStore((state) => ({
        tasks: state.tasks,
        projects: state.projects,
        areas: state.areas,
        settings: state.settings,
        updateSettings: state.updateSettings,
        error: state.error,
        setError: state.setError,
    }), shallow);
    const { t } = useLanguage();
    const userSidebarCollapsed = settings?.sidebarCollapsed ?? false;
    const [compactViewport, setCompactViewport] = useState(() => (
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(max-width: 1023px)').matches
    ));
    const isCollapsed = userSidebarCollapsed || compactViewport;
    const calendarDragNavTimeoutRef = useRef<number | null>(null);
    const sidebarSplitRef = useRef<HTMLDivElement | null>(null);
    const [sidebarNavigationHeight, setSidebarNavigationHeight] = usePersistedViewState(
        'mindwtr:sidebar-navigation-height:v1', 60, clampSidebarNavigationHeight,
    );
    const resizeSidebarFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
        const bounds = sidebarSplitRef.current?.getBoundingClientRect();
        if (!bounds || bounds.height <= 0) return;
        setSidebarNavigationHeight(clampSidebarNavigationHeight((event.clientY - bounds.top) / bounds.height * 100));
    };
    const [viewSidebarSlot, setViewSidebarSlot] = useState<HTMLDivElement | null>(null);
    const hasViewSidebar = (contentView === 'projects' || contentView === 'contexts') && !isCollapsed;
    const isFocusMode = useUiStore((state) => state.isFocusMode);
    const hiddenSidebarViews = useUiStore((state) => state.hiddenSidebarViews);
    const showToast = useUiStore((state) => state.showToast);
    const isObsidianEnabled = useObsidianStore((state) => state.config.enabled);
    // Timeline is opt-in (#1111): hidden from navigation until it is switched on.
    const isTimelineEnabled = resolveFeatureFlags(settings).timeline;
    const [syncStatus, setSyncStatus] = useState(() => SyncService.getSyncStatus());
    const [isManualSyncing, setIsManualSyncing] = useState(false);
    const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
    const [cleartextSyncWarning, setCleartextSyncWarning] = useState<{ destination: string; message: string } | null>(null);
    const dismissedCleartextDestinations = useRef(new Set<string>());
    const searchShortcutHint = useMemo(() => (
        typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl+K'
    ), []);
    const lastSyncAt = settings?.lastSyncAt;
    const lastSyncStatus = settings?.lastSyncStatus;
    const persistedLastSyncError = settings?.lastSyncError?.trim();
    const lastSyncError = persistedLastSyncError && isSyncFileLockUnavailableError(persistedLastSyncError)
        ? tFallback(
            t,
            'settings.syncFileLockUnavailable',
            'Mindwtr cannot safely lock this File Sync location. Re-select the folder, restart or update Mindwtr, or use WebDAV.',
        )
        : persistedLastSyncError;
    const lastSyncStats = settings?.lastSyncStats;

    // Compute sync freshness bucket on a 60-second timer instead of every render
    // to prevent idle re-render flicker from Date.now() changing each frame.
    const getSyncFreshnessBucket = useCallback((syncAt: string | undefined): 'fresh' | 'stale' | 'old' | 'none' => {
        if (!syncAt) return 'none';
        const ageMs = Math.max(0, Date.now() - Date.parse(syncAt));
        if (ageMs > 2 * 60 * 60 * 1000) return 'old';
        if (ageMs > 30 * 60 * 1000) return 'stale';
        return 'fresh';
    }, []);
    const [syncFreshness, setSyncFreshness] = useState(() => getSyncFreshnessBucket(lastSyncAt));
    const lastSyncAtRef = useRef(lastSyncAt);
    const shownConflictToastKeyRef = useRef<string | null>(null);
    lastSyncAtRef.current = lastSyncAt;
    useEffect(() => {
        setSyncFreshness(getSyncFreshnessBucket(lastSyncAt));
        const timer = setInterval(() => {
            setSyncFreshness(getSyncFreshnessBucket(lastSyncAtRef.current));
        }, 60_000);
        return () => clearInterval(timer);
    }, [lastSyncAt, getSyncFreshnessBucket]);

    const syncConflictNotice = tFallback(t,
        'settings.syncConflictNotice',
        'Sync conflict resolved with last-write-wins. Open sync settings to review the details.'
    );
    const syncConflictToastKey = useMemo(() => {
        if (lastSyncStatus !== 'conflict') return null;
        if (!lastSyncStats) return `${lastSyncAt ?? 'unknown'}:${lastSyncStatus}`;
        const conflictEntities = [
            ['tasks', lastSyncStats.tasks],
            ['projects', lastSyncStats.projects],
            ['sections', lastSyncStats.sections],
            ['areas', lastSyncStats.areas],
        ] as const;
        const countParts = conflictEntities.map(([name, stats]) => `${name}:${stats.conflicts || 0}`);
        const conflictIds = conflictEntities
            .flatMap(([, stats]) => stats.conflictIds || [])
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .sort();
        const conflictSamples = conflictEntities
            .flatMap(([name, stats]) => (stats.conflictSamples || []).map((sample) => [
                name,
                sample.id,
                sample.winner,
                (sample.reasons || []).join('+'),
                sample.localComparableHash,
                sample.incomingComparableHash,
            ].join(':')))
            .sort();
        return `${countParts.join('|')}:ids:${conflictIds.join(',')}:samples:${conflictSamples.join(',')}`;
    }, [lastSyncAt, lastSyncStats, lastSyncStatus]);
    useEffect(() => {
        // Wait until the backend is known, and stay quiet when sync is off — a
        // persisted conflict status can never be cleared by a sync that will
        // never run again, so it would re-toast at every launch (#1001).
        if (syncStatus.backend === null || syncStatus.backend === 'off') return;
        if (lastSyncStatus !== 'conflict' || !syncConflictToastKey) return;
        if (shownConflictToastKeyRef.current === syncConflictToastKey) return;
        shownConflictToastKeyRef.current = syncConflictToastKey;
        showToast(syncConflictNotice, 'info', 6000);
    }, [lastSyncStatus, showToast, syncConflictNotice, syncConflictToastKey, syncStatus.backend]);

    // A sync cycle that queues a follow-up drops inFlight between runs while queued stays
    // true. Reading inFlight alone made the footer flicker on every hand-off — the status dot
    // stopped pulsing, the Sync now button re-enabled (swapping its cursor and hover
    // background), and re-adding animate-spin restarted the spinner from 0deg, which reads as
    // the icon jumping about while you hover it. Queued work is still sync work, so treat it
    // as busy and the footer stays put for the whole cycle.
    const syncBusy = syncStatus.inFlight || syncStatus.queued;
    // Sync affordances disappear entirely while sync is off (#1001). `null`
    // means "not read yet"; keep the footer visible then so it doesn't blink
    // in a heartbeat later for the common sync-enabled case.
    const syncOff = sandboxMode || syncStatus.backend === 'off';
    const syncFreshnessDotClass = syncBusy
        ? 'bg-info'
        : !isOnline
        ? 'bg-muted-foreground'
        : lastSyncStatus === 'error'
            ? 'bg-destructive'
            : lastSyncStatus === 'conflict'
                ? 'bg-warning'
            : syncFreshness === 'none'
                ? 'bg-muted-foreground/40'
                : syncFreshness === 'old'
                    ? 'bg-destructive'
                    : syncFreshness === 'stale'
                        ? 'bg-warning'
                        : 'bg-success';
    const fullSyncTimestamp = lastSyncAt ? safeFormatDate(lastSyncAt, 'PPpp', lastSyncAt) : t('settings.lastSyncNever');
    const syncTooltip = !isOnline
        ? (tFallback(t, 'common.offline', 'Offline'))
        : lastSyncStatus === 'error' && lastSyncError
            ? `${tFallback(t, 'settings.lastSyncError', 'Sync failed')}: ${lastSyncError}\n${tFallback(t, 'settings.lastSync', 'Last sync')}: ${fullSyncTimestamp}`
            : lastSyncStatus === 'conflict'
                ? `${tFallback(t, 'settings.lastSyncConflict', 'Conflicts resolved')}\n${syncConflictNotice}\n${tFallback(t, 'settings.lastSync', 'Last sync')}: ${fullSyncTimestamp}`
            : `${tFallback(t, 'settings.lastSync', 'Last sync')}: ${fullSyncTimestamp}`;
    const syncStatusLabel = syncBusy
        ? tFallback(t, 'settings.syncing', 'Syncing...')
        : !isOnline
            ? tFallback(t, 'common.offline', 'Offline')
            : lastSyncStatus === 'error'
                ? tFallback(t, 'settings.lastSyncError', 'Sync failed')
                : lastSyncStatus === 'conflict'
                    ? tFallback(t, 'settings.lastSyncConflict', 'Conflicts resolved')
                    : syncFreshness === 'old'
                        ? tFallback(t, 'settings.syncStatusOld', 'Old')
                        : syncFreshness === 'stale'
                            ? tFallback(t, 'settings.syncStatusStale', 'Stale')
                            : syncFreshness === 'fresh'
                                ? tFallback(t, 'settings.syncStatusFresh', 'Fresh')
                                : tFallback(t, 'settings.syncStatusNever', 'Not synced');
    const syncStatusDescription = `${syncStatusLabel}. ${syncTooltip}`;
    const syncNowLabel = tFallback(t, 'settings.syncNow', 'Sync now');
    const manualSyncBusy = syncBusy || isManualSyncing;
    const formatCompactSyncTime = useCallback((iso: string) => {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return iso;
        return new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(date);
    }, []);
    const compactSyncTimeLabel = lastSyncAt
        ? formatCompactSyncTime(lastSyncAt)
        : tFallback(t, 'settings.lastSyncNever', 'Never');
    const dismissLabel = t('common.dismiss');
    const dismissText = dismissLabel && dismissLabel !== 'common.dismiss' ? dismissLabel : 'Dismiss';
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilterSelection(settings?.filters, areas),
        [settings?.filters, areas],
    );
    const sortedAreas = useMemo(() => [...areas].sort((a, b) => a.order - b.order), [areas]);
    const inboxCount = useMemo(() => {
        let count = 0;
        for (const task of tasks) {
            if (task.status !== 'inbox') continue;
            if (!isTaskVisibleInInbox(task, { projectById: projectMap })) continue;
            count += 1;
        }
        return count;
    }, [tasks, projectMap]);
    const wideViews = new Set([
        'inbox',
        'next',
        'focus',
        'someday',
        'reference',
        'waiting',
        'history',
        'done',
        'archived',
        'trash',
        'review',
        'projects',
        'contexts',
        'search',
        'agenda',
        'obsidian',
    ]);
    const isWideView = wideViews.has(contentView);
    const fullWidthViews = new Set([
        'board',
        'projects',
        'contexts',
        'obsidian',
        'settings',
    ]);
    const isFullWidthView = fullWidthViews.has(contentView);

    const navSections = useMemo<NavSection[]>(() => ([
        {
            key: 'focus',
            label: tFallback(t, 'nav.sectionFocus', 'Focus'),
            items: [
                { id: 'agenda', labelKey: 'nav.agenda', icon: Target, tone: 'primary' },
                { id: 'inbox', labelKey: 'nav.inbox', icon: TASK_STATUS_ICONS.inbox, count: inboxCount, tone: 'primary' },
            ],
        },
        {
            key: 'lists',
            label: tFallback(t, 'nav.sectionLists', 'Lists'),
            items: [
                { id: 'projects', labelKey: 'nav.projects', icon: Folder, tone: 'primary' },
                { id: 'someday', labelKey: 'nav.someday', icon: TASK_STATUS_ICONS.someday },
                { id: 'waiting', labelKey: 'nav.waiting', icon: TASK_STATUS_ICONS.waiting },
            ],
        },
        {
            key: 'organize',
            label: tFallback(t, 'nav.sectionOrganize', 'Organize'),
            items: [
                { id: 'calendar', labelKey: 'nav.calendar', icon: Calendar },
                { id: 'review', labelKey: 'nav.review', icon: CheckCircle2 },
                { id: 'contexts', labelKey: 'nav.contexts', icon: Tag },
            ],
        },
        {
            key: 'secondary',
            label: tFallback(t, 'common.more', 'More'),
            items: [
                { id: 'reference', labelKey: 'nav.reference', icon: TASK_STATUS_ICONS.reference },
                ...(isObsidianEnabled
                    ? [{ id: 'obsidian', labelKey: 'nav.obsidian', fallbackLabel: 'Obsidian', icon: BookOpen }]
                    : []),
                { id: 'board', labelKey: 'nav.board', icon: Kanban },
                ...(isTimelineEnabled
                    ? [{ id: 'timeline', labelKey: 'nav.timeline', fallbackLabel: 'Timeline', icon: GanttChartSquare }]
                    : []),
                {
                    id: 'history',
                    labelKey: 'nav.history',
                    fallbackLabel: 'History',
                    icon: HistoryIcon,
                    tone: 'recessed',
                    activeIds: ['done', 'archived'],
                },
                { id: 'trash', labelKey: 'nav.trash', icon: Trash2, tone: 'recessed' },
            ],
        },
    ] satisfies NavSection[])
        .map((section) => ({
            ...section,
            items: section.items.filter((item) => {
                if (item.id === 'history') {
                    return !(hiddenSidebarViews.includes('done') && hiddenSidebarViews.includes('archived'));
                }
                return !hiddenSidebarViews.includes(item.id as (typeof hiddenSidebarViews)[number]);
            }),
        }))
        .filter((section) => section.items.length > 0), [hiddenSidebarViews, inboxCount, isObsidianEnabled, isTimelineEnabled, t]);

    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => loadCollapsedSections());

    useEffect(() => {
        saveCollapsedSections(collapsedSections);
    }, [collapsedSections]);

    // Auto-expand the section containing the active view so it's never hidden.
    useEffect(() => {
        const activeSection = navSections.find((section) => section.items.some(
            (item) => item.id === currentView || item.activeIds?.includes(currentView),
        ));
        if (!activeSection) return;
        setCollapsedSections((prev) => {
            if (!prev.has(activeSection.key)) return prev;
            const next = new Set(prev);
            next.delete(activeSection.key);
            return next;
        });
    }, [currentView, navSections]);

    const toggleSection = useCallback((key: string) => {
        setCollapsedSections((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);
    const clearCalendarDragNavTimeout = useCallback(() => {
        if (calendarDragNavTimeoutRef.current === null) return;
        window.clearTimeout(calendarDragNavTimeoutRef.current);
        calendarDragNavTimeoutRef.current = null;
    }, []);

    useEffect(() => clearCalendarDragNavTimeout, [clearCalendarDragNavTimeout]);

    // This nav item is the only place a task dragged out of a list can be dropped,
    // and nothing pointed at it: the row-wide grab cursor in lists without manual
    // ordering read as "reorder me" and the capability was undiscoverable (#867).
    // The drag starts on a task row anywhere in the app, so the flag comes from a
    // document listener rather than being threaded through every list view.
    const [taskDragActive, setTaskDragActive] = useState(false);
    const [dragOverNavId, setDragOverNavId] = useState<string | null>(null);
    // A folded group hides its drop targets. Opening it for the length of the drag
    // is kept out of `collapsedSections`, which is saved as the user's fold choice.
    const [dragOpenedSectionKey, setDragOpenedSectionKey] = useState<string | null>(null);

    useEffect(() => {
        // Neither end-of-drag signal is trustworthy on the path this highlight
        // exists for. Dropping on the calendar grid stops propagation, so a
        // bubbling `drop` listener never sees it; and the spring-loaded jump to
        // the calendar unmounts the list the drag started in, so `dragend` fires
        // on a detached node that no longer reaches the document. Left relying on
        // those two, the highlight stayed lit for the rest of the session. Hence
        // capture-phase listeners (which beat stopPropagation) plus a heartbeat:
        // once `dragover` goes quiet the drag is over however it ended.
        let idleTimer: number | null = null;
        const endDrag = () => {
            if (idleTimer !== null) {
                window.clearTimeout(idleTimer);
                idleTimer = null;
            }
            setTaskDragActive(false);
            setDragOverNavId(null);
            setDragOpenedSectionKey(null);
        };
        const keepAlive = () => {
            if (idleTimer !== null) window.clearTimeout(idleTimer);
            idleTimer = window.setTimeout(endDrag, TASK_DRAG_IDLE_MS);
        };
        const handleDragStart = (event: globalThis.DragEvent) => {
            if (!hasCalendarTaskDragData(event.dataTransfer)) return;
            setTaskDragActive(true);
            keepAlive();
        };
        const handleDragOver = (event: globalThis.DragEvent) => {
            if (!hasCalendarTaskDragData(event.dataTransfer)) return;
            keepAlive();
        };
        // dragstart listens on the BUBBLE phase on purpose: the task row populates
        // the transfer in its own dragstart handler, so a capture listener runs
        // first and sees an empty dataTransfer — the drag then goes unrecognised
        // and no target ever lights up. Only the endings need capture, to beat the
        // calendar grid's stopPropagation.
        document.addEventListener('dragstart', handleDragStart);
        document.addEventListener('dragover', handleDragOver, true);
        document.addEventListener('dragend', endDrag, true);
        document.addEventListener('drop', endDrag, true);
        return () => {
            if (idleTimer !== null) window.clearTimeout(idleTimer);
            document.removeEventListener('dragstart', handleDragStart);
            document.removeEventListener('dragover', handleDragOver, true);
            document.removeEventListener('dragend', endDrag, true);
            document.removeEventListener('drop', endDrag, true);
        };
    }, []);

    const handleNavDragEnter = useCallback((event: DragEvent<HTMLButtonElement>, navId: string) => {
        if (!hasCalendarTaskDragData(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDragOverNavId(navId);
        // Spring-loading is calendar-only: dropping on a status list finishes the
        // job where you are, so yanking the view out from under the pointer would
        // just lose your place in the list you were working through.
        if (navId !== 'calendar') return;
        if (currentView === 'calendar' || calendarDragNavTimeoutRef.current !== null) return;
        calendarDragNavTimeoutRef.current = window.setTimeout(() => {
            stageCalendarDropLanding();
            onViewChange('calendar');
            calendarDragNavTimeoutRef.current = null;
        }, 350);
    }, [currentView, onViewChange]);
    const handleNavDragOver = useCallback((event: DragEvent<HTMLButtonElement>) => {
        if (!hasCalendarTaskDragData(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);
    const handleNavDragLeave = useCallback((event: DragEvent<HTMLButtonElement>) => {
        const relatedTarget = event.relatedTarget;
        if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
        setDragOverNavId(null);
        clearCalendarDragNavTimeout();
    }, [clearCalendarDragNavTimeout]);
    const handleNavDrop = useCallback((event: DragEvent<HTMLButtonElement>, navId: string) => {
        if (!hasCalendarTaskDragData(event.dataTransfer)) return;
        event.preventDefault();
        setDragOverNavId(null);
        clearCalendarDragNavTimeout();

        if (navId === 'calendar') {
            if (currentView !== 'calendar') {
                stageCalendarDropLanding();
                onViewChange('calendar');
            }
            return;
        }

        const nextStatus = NAV_DROP_STATUSES[navId];
        const taskId = getCalendarTaskDragTaskId(event.dataTransfer);
        if (!nextStatus || !taskId) return;
        const task = useTaskStore.getState()._tasksById.get(taskId);
        if (!task || task.status === nextStatus) return;

        const previousStatus = task.status;
        const wasFocusedToday = task.isFocusedToday === true;
        const title = task.title;
        void Promise.resolve(useTaskStore.getState().moveTask(taskId, nextStatus))
            .then((result) => {
                const outcome = result as StoreActionResult | undefined;
                if (outcome && outcome.success === false) {
                    throw new Error(outcome.error || 'Failed to change task status');
                }
                showUndoToast(formatTaskMovedMessage(t, title, nextStatus), () => {
                    // A drop on History completes the task, and completion has side
                    // effects (the next occurrence of a repeating task, the Today
                    // star), so undoing it goes through the shared core rule — the
                    // same branch the status chord uses.
                    if (nextStatus === 'done') {
                        void undoTaskCompletion(taskId, previousStatus, wasFocusedToday)
                            .catch((error) => reportError('Failed to undo task status change', error));
                        return;
                    }
                    void Promise.resolve(useTaskStore.getState().moveTask(taskId, previousStatus))
                        .catch((error) => reportError('Failed to undo task status change', error));
                }, t);
            })
            .catch((error) => reportError('Failed to change task status', error));
    }, [clearCalendarDragNavTimeout, currentView, onViewChange, t]);

    const triggerSearch = () => {
        window.dispatchEvent(new CustomEvent('mindwtr:open-search'));
    };

    const triggerInboxCapture = () => {
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: { initialProps: { status: 'inbox' } },
        }));
    };
    const addTaskLabel = tFallback(t, 'nav.addTask', 'Add Task');
    const inboxLabel = tFallback(t, 'nav.inbox', 'Inbox');
    const inboxCaptureLabel = `${addTaskLabel} (${inboxLabel})`;
    const searchTitleLabel = tFallback(t, 'search.title', 'Search');
    const searchScopeLabel = tFallback(t, 'search.scopeHint', 'Tasks, projects, people');

    const savedSearches = settings?.savedSearches || [];

    const toggleSidebar = () => {
        updateSettings({ sidebarCollapsed: !userSidebarCollapsed }).catch((error) => reportError('Failed to update settings', error));
    };

    const handleManualSyncNow = useCallback(async () => {
        if (manualSyncBusy) return;
        setIsManualSyncing(true);
        try {
            const result = await SyncService.performSync({ manual: true });
            if (result.skipped === 'disabled') {
                showToast(tFallback(t, 'settings.syncTurnedOff', 'Sync is turned off'), 'info');
                return;
            }
            if (result.skipped === 'requeued') {
                showToast(tFallback(t, 'settings.syncRetryQueued', 'Local changes arrived during sync. Retry queued.'), 'info');
            } else if (
                result.success
                && !result.remoteWriteDeferred
                && result.fileAttachmentUploadBlocked === 'too-large'
            ) {
                showToast(tFallback(
                    t,
                    'settings.syncFileAttachmentTooLarge',
                    'Mindwtr kept the local attachment. File Sync can only sync attachments under 100 MB. Replace it with a smaller file or remove the attachment, then sync again.',
                ), 'info', 6000);
            } else if (result.success && result.remoteWriteDeferred) {
                showSyncErrorToast(result.error || settings?.lastSyncError || tFallback(t, 'settings.lastSyncError', 'Sync failed'));
            } else if (result.success && result.attachmentWriteDeferred) {
                showToast(tFallback(
                    t,
                    'settings.syncAttachmentWriteDeferred',
                    'Some attachment changes could not finish. Restore any missing local files or remove the affected attachments, then sync again.',
                ), 'info', 6000);
            } else if (result.success && result.fileSyncLockDeferred === 'busy') {
                showToast(tFallback(
                    t,
                    'settings.syncFileLockBusy',
                    'Another Mindwtr operation is using File Sync. Wait for it to finish; Mindwtr will retry automatically.',
                ), 'info', 6000);
            } else if (result.success && result.fileSyncLockDeferred === 'cleanup') {
                showToast(tFallback(
                    t,
                    'settings.syncFileLockCleanupDeferred',
                    'Sync completed, but Mindwtr could not release the File Sync lock. Restart Mindwtr before syncing again. No retry is needed.',
                ), 'info', 6000);
            } else if (result.fileSyncLockUnavailable) {
                showToast(tFallback(
                    t,
                    'settings.syncFileLockUnavailable',
                    'Mindwtr cannot safely lock this File Sync location. Re-select the folder, restart or update Mindwtr, or use WebDAV.',
                ), 'error', 6000);
            } else if (result.success && result.remoteFenceDeferred === 'busy') {
                showToast(tFallback(
                    t,
                    'settings.syncRemoteBusy',
                    'Another compatible Mindwtr device is updating this sync location. Wait for it to finish, then sync again.',
                ), 'info', 6000);
            } else if (result.success && result.remoteFenceDeferred === 'cleanup') {
                showToast(tFallback(
                    t,
                    'settings.syncRemoteCleanupDeferred',
                    'The sync operation completed. Mindwtr could not remove the temporary sync lock, but it expires automatically. No retry is needed.',
                ), 'info', 6000);
            } else if (result.success) {
                showToast(tFallback(t, 'settings.lastSyncSuccess', 'Sync completed'), 'success');
            } else {
                showSyncErrorToast(result.error || tFallback(t, 'settings.lastSyncError', 'Sync failed'));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            reportError('Sync failed', error, { toast: false });
            showSyncErrorToast(message);
        } finally {
            setIsManualSyncing(false);
        }
    }, [manualSyncBusy, showToast, t, settings?.lastSyncError]);

    useEffect(() => {
        if (areas.length === 0) return;
        // Write back the normalized selection whenever the stored one differs —
        // seeds the default and drops ids whose area was deleted.
        const stored = settings?.filters;
        const next = areaFilterSelectionToFilters(resolvedAreaFilter);
        if (stored?.areaId === next.areaId
            && (stored?.areaIds ?? []).join('\0') === next.areaIds.join('\0')
            && (stored?.excludedAreaIds ?? []).join('\0') === next.excludedAreaIds.join('\0')) return;
        updateSettings({ filters: { ...(stored ?? {}), ...next } })
            .catch((error) => reportError('Failed to update area filter', error));
    }, [areas.length, resolvedAreaFilter, settings?.filters, updateSettings]);

    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    // Derive from an already-known configuration snapshot: no lock,
    // no native call. Drives both the synchronous first-frame seed and the
    // refresh after a configuration commit (PERF-02) — the 30s poll this
    // replaced re-read the locked, persisted configuration on a timer with no
    // in-flight guard, so its ticks queued behind whole sync cycles (tens of
    // seconds on WebDAV) and drained as a burst of lock acquisitions.
    const applyCleartextWarningFromConfiguration = useCallback((
        configuration: ReturnType<typeof SyncService.getLastKnownSyncSelection>['configuration'],
    ) => {
        if (!configuration) return;
        const destination = configuration.backend === 'webdav'
            ? getCleartextSyncDestination('webdav', configuration.webdav.url)
            : configuration.backend === 'cloud' && configuration.cloudProvider === 'selfhosted'
                ? getCleartextSyncDestination('cloud', configuration.cloud.url)
                : null;
        if (!destination || dismissedCleartextDestinations.current.has(destination) || isCleartextSyncDismissed(destination)) {
            setCleartextSyncWarning(null);
            return;
        }
        if (configuration.backend === 'webdav') {
            setCleartextSyncWarning({ destination, message: tFallback(t,
                'settings.cleartextSyncWarningWebdav',
                'WebDAV sync is using HTTP. Data is unencrypted; use it only on a trusted network.'
            ) });
            return;
        }
        if (configuration.backend === 'cloud') {
            setCleartextSyncWarning({ destination, message: tFallback(t,
                'settings.cleartextSyncWarningCloud',
                'Self-hosted sync is using HTTP. Data is unencrypted; use it only on a trusted network.'
            ) });
            return;
        }
        setCleartextSyncWarning(null);
    }, [t]);

    useEffect(() => {
        if (sandboxMode) return;
        void SyncService.refreshSyncBackendStatus();
        // refreshSyncBackendStatus() runs at the end of every
        // commitProvenSyncConfiguration (sync-service.ts), so this
        // subscription doubles as the "a configuration actually committed"
        // signal — re-deriving the banner here needs no extra lock read,
        // getLastKnownSyncSelection() is already fresh by the time it fires.
        return SyncService.subscribeSyncStatus((status) => {
            setSyncStatus(status);
            applyCleartextWarningFromConfiguration(SyncService.getLastKnownSyncSelection().configuration);
        });
    }, [applyCleartextWarningFromConfiguration, sandboxMode]);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mediaQuery = window.matchMedia('(max-width: 1023px)');
        const updateCompactViewport = () => setCompactViewport(mediaQuery.matches);
        updateCompactViewport();
        mediaQuery.addEventListener?.('change', updateCompactViewport);
        return () => mediaQuery.removeEventListener?.('change', updateCompactViewport);
    }, []);

    // Full (locked) read, kept only for events that can reflect a change this
    // session did not itself make — another window or process editing the
    // sync configuration on disk.
    const refreshCleartextSyncWarning = useCallback(async () => {
        try {
            const configuration = await SyncService.getPersistedSyncConfigurationSnapshot();
            applyCleartextWarningFromConfiguration(configuration);
        } catch {
            setCleartextSyncWarning(null);
        }
    }, [applyCleartextWarningFromConfiguration]);

    useEffect(() => {
        if (sandboxMode) return;
        // Synchronous first-frame seed — no lock, no wait behind a sync cycle —
        // painted immediately, then corrected (usually a no-op) by the queued
        // read below once it resolves.
        applyCleartextWarningFromConfiguration(SyncService.getLastKnownSyncSelection().configuration);
        void refreshCleartextSyncWarning();
        const handleStorage = () => void refreshCleartextSyncWarning();
        const handleFocus = () => void refreshCleartextSyncWarning();
        window.addEventListener('storage', handleStorage);
        window.addEventListener('focus', handleFocus);
        return () => {
            window.removeEventListener('storage', handleStorage);
            window.removeEventListener('focus', handleFocus);
        };
    }, [applyCleartextWarningFromConfiguration, refreshCleartextSyncWarning, sandboxMode]);

    const handleAreaFilterChange = (selection: AreaFilterSelection) => {
        updateSettings({ filters: { ...(settings?.filters ?? {}), ...areaFilterSelectionToFilters(selection) } })
            .catch((error) => reportError('Failed to update area filter', error));
    };


    return (
        <ViewSidebarContext.Provider value={viewSidebarSlot}>
        <div className={cn(
            "flex h-screen overflow-hidden bg-background text-foreground",
            sandboxMode && "pt-10",
        )}>
            <SandboxBanner />
            <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded-md focus:bg-primary focus:text-primary-foreground"
            >
                {tFallback(t, 'accessibility.skipToContent', 'Skip to content')}
            </a>
            {/* Sidebar */}
            {!isFocusMode && (
                <aside className={cn(
                    "border-r border-border bg-card flex flex-col",
                    isCollapsed ? "w-16 shrink-0 p-2" : "w-64 shrink-0 px-3 pt-5 pb-3"
                )}>
                <div className={cn(
                    "flex items-center gap-2 px-1.5 mb-6",
                    isCollapsed && "flex-col justify-center"
                )}>
                    {!isCollapsed && (
                        <img
                            src="/logo.png"
                            alt="Mindwtr"
                            className="w-7 h-7 rounded-md"
                        />
                    )}
                    {!isCollapsed && <h1 className="text-base font-semibold tracking-tight">{t('app.name')}</h1>}
                    <div className={cn("ml-auto flex items-center gap-1", isCollapsed && "ml-0 flex-col")}>
                        <button
                            onClick={toggleSidebar}
                            className={cn(
                                "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                                compactViewport && "hidden"
                            )}
                            title={t('keybindings.toggleSidebar')}
                            aria-label={t('keybindings.toggleSidebar')}
                        >
                            {isCollapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
                        </button>
                    </div>
                </div>

                {/* Search Button */}
                <button
                    onClick={triggerSearch}
                    className={cn(
                        "w-full flex items-center gap-2.5 px-2.5 py-2 mb-4 rounded-md border border-border/70 bg-background/60 text-[13px] font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-primary/40",
                        isCollapsed && "justify-center px-2"
                    )}
                    title={`${searchTitleLabel} (${searchShortcutHint})`}
                    aria-label={searchTitleLabel}
                >
                    <Search className="w-3.5 h-3.5 text-primary" />
                    {!isCollapsed && (
                        <>
                            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                                <span>{searchTitleLabel}</span>
                                <span className="truncate text-[11px] font-normal text-muted-foreground">{searchScopeLabel}</span>
                            </span>
                            <span className="rounded border border-border/70 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground">{searchShortcutHint}</span>
                        </>
                    )}
                </button>

                <button
                    onClick={triggerInboxCapture}
                    className={cn(
                        "w-full flex h-9 items-center gap-2.5 px-2.5 mb-6 rounded-md border border-primary/40 bg-primary/5 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/40",
                        isCollapsed && "h-10 justify-center px-2"
                    )}
                    title={inboxCaptureLabel}
                    aria-label={inboxCaptureLabel}
                >
                    <Plus className="w-4 h-4" />
                    {!isCollapsed && (
                        <span className="flex-1 text-left">{addTaskLabel}</span>
                    )}
                </button>

                <div ref={sidebarSplitRef} data-sidebar-split className={cn("flex-1 min-h-0", hasViewSidebar && "grid")}
                    style={hasViewSidebar ? { gridTemplateRows: `minmax(0, ${sidebarNavigationHeight}fr) 12px minmax(0, ${100 - sidebarNavigationHeight}fr)` } : undefined}>
                <div id="sidebar-navigation-panel" className={cn("min-h-0 overflow-y-auto pr-1", !hasViewSidebar && "h-full")}>
                    {savedSearches.length > 0 && (
                        <div className={cn("mb-2 space-y-1", isCollapsed && "mb-2")}>
                            {!isCollapsed && (
                                <div className="px-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.16em]">
                                    {t('search.savedSearches')}
                                </div>
                            )}
                            {savedSearches.map((search) => (
                                <button
                                    key={search.id}
                                    onClick={() => onViewChange(`savedSearch:${search.id}`)}
                                    className={cn(
                                        "w-full flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset",
                                        currentView === `savedSearch:${search.id}`
                                            ? "bg-primary/5 text-primary"
                                            : "hover:bg-accent text-muted-foreground",
                                        isCollapsed && "justify-center px-2"
                                    )}
                                    title={search.name}
                                >
                                    <Search className="w-4 h-4" />
                                    {!isCollapsed && <span className="truncate">{search.name}</span>}
                                </button>
                            ))}
                        </div>
                    )}

                    <nav className="space-y-3.5 pb-2" data-sidebar-nav>
                        {navSections.map((section) => {
                            const isSectionCollapsed = !isCollapsed && collapsedSections.has(section.key) && dragOpenedSectionKey !== section.key;
                            const sectionId = `sidebar-section-${section.key}`;
                            return (
                            <div key={section.key} className="space-y-1" data-sidebar-section>
                                {!isCollapsed && (
                                    <button
                                        type="button"
                                        onClick={() => toggleSection(section.key)}
                                        onDragEnter={(event) => {
                                            if (!hasCalendarTaskDragData(event.dataTransfer)) return;
                                            if (section.items.some((item) => item.id === 'calendar' || NAV_DROP_STATUSES[item.id] !== undefined)) {
                                                setDragOpenedSectionKey(section.key);
                                            }
                                        }}
                                        aria-expanded={!isSectionCollapsed}
                                        aria-controls={sectionId}
                                        data-sidebar-section-toggle
                                        className="group w-full flex h-7 items-center gap-1 rounded-md px-2.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.16em] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer"
                                    >
                                        <ChevronDown
                                            className={cn(
                                                "w-3 h-3 transition-transform duration-150 opacity-70",
                                                isSectionCollapsed && "-rotate-90"
                                            )}
                                        />
                                        <span>{section.label}</span>
                                    </button>
                                )}
                                <div
                                    id={sectionId}
                                    hidden={isSectionCollapsed}
                                    className={cn("space-y-1", isSectionCollapsed && "hidden")}
                                >
                                {section.items.map((item) => {
                                    const itemLabel = item.labelKey ? tFallback(t, item.labelKey, item.fallbackLabel ?? item.id) : (item.fallbackLabel ?? item.id);
                                    const isActiveItem = currentView === item.id || item.activeIds?.includes(currentView) === true;
                                    const isDropTarget = item.id === 'calendar' || NAV_DROP_STATUSES[item.id] !== undefined;
                                    const tone = item.tone ?? 'normal';
                                    const inactiveItemClass = tone === 'primary'
                                        ? 'text-foreground hover:bg-accent/80 hover:text-foreground'
                                        : tone === 'recessed'
                                            ? 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                                            : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground';
                                    const inactiveIconClass = tone === 'primary'
                                        ? 'text-primary/80'
                                        : tone === 'recessed'
                                            ? 'text-muted-foreground/80'
                                            : 'text-muted-foreground';
                                    const itemWeightClass = isActiveItem
                                        ? 'font-medium'
                                        : tone === 'primary'
                                            ? 'font-semibold'
                                            : tone === 'recessed'
                                                ? 'font-normal'
                                                : 'font-medium';
                                    return (
                                    <button
                                        key={item.id}
                                        onClick={() => onViewChange(item.id)}
                                        onDragEnter={isDropTarget ? (event) => handleNavDragEnter(event, item.id) : undefined}
                                        onDragOver={isDropTarget ? handleNavDragOver : undefined}
                                        onDragLeave={isDropTarget ? handleNavDragLeave : undefined}
                                        onDrop={isDropTarget ? (event) => handleNavDrop(event, item.id) : undefined}
                                        data-sidebar-item
                                        data-view={item.id}
                                        data-active-views={item.activeIds?.join(' ')}
                                        className={cn(
                                            "w-full flex items-center rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset",
                                            itemWeightClass,
                                            isActiveItem ? "bg-primary/5 text-primary" : inactiveItemClass,
                                            isCollapsed ? "h-10 justify-center px-2" : "h-9 justify-between px-2.5",
                                            // Last so they win the merge: the drop target has to read as
                                            // available even on the active item's own tinted background.
                                            // Every destination reads as available at a glance, and the one
                                            // under the pointer is unmistakably the one that will take the
                                            // drop. A dashed edge is the conventional "drop zone" cue and
                                            // distinguishes an available target from the solid ring the
                                            // focused item already uses.
                                            isDropTarget && taskDragActive && "outline-dashed outline-2 -outline-offset-2 outline-primary/50 bg-primary/10 text-primary",
                                            isDropTarget && dragOverNavId === item.id && "outline outline-2 -outline-offset-2 outline-primary bg-primary/25 text-primary"
                                        )}
                                        aria-current={isActiveItem ? 'page' : undefined}
                                        title={itemLabel}
                                    >
                                        <div className={cn("flex min-w-0 items-center gap-2.5", isCollapsed && "gap-0")}>
                                            <item.icon className={cn("w-4 h-4 shrink-0", isActiveItem ? "text-primary" : inactiveIconClass)} />
                                            {!isCollapsed && <span className="truncate">{itemLabel}</span>}
                                        </div>
                                        {!isCollapsed && item.count !== undefined && item.count > 0 && (
                                            <span className={cn(
                                                "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold",
                                                isActiveItem
                                                    ? "bg-primary text-primary-foreground"
                                                    : "bg-muted text-muted-foreground"
                                            )}>
                                                {item.count}
                                            </span>
                                        )}
                                    </button>
                                    );
                                })}
                                </div>
                            </div>
                            );
                        })}
                    </nav>
                </div>
                    {hasViewSidebar && <>
                        <div role="separator" tabIndex={0} aria-orientation="horizontal"
                            aria-label={tFallback(t, 'nav.resizeSubmenu', 'Resize navigation and submenu')}
                            aria-controls="sidebar-navigation-panel view-sidebar-panel"
                            aria-valuemin={20} aria-valuemax={80} aria-valuenow={sidebarNavigationHeight}
                            title={tFallback(t, 'nav.resizeSubmenu', 'Resize navigation and submenu')}
                            className="group flex cursor-row-resize touch-none select-none items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            onPointerDown={(event) => {
                                if (event.button !== 0) return;
                                event.preventDefault();
                                event.currentTarget.setPointerCapture(event.pointerId);
                                resizeSidebarFromPointer(event);
                            }}
                            onPointerMove={(event) => {
                                if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeSidebarFromPointer(event);
                            }}
                            onPointerUp={(event) => {
                                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                            }}
                            onDoubleClick={() => setSidebarNavigationHeight(60)}
                            onKeyDown={(event) => {
                                if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                                event.preventDefault();
                                setSidebarNavigationHeight((height) => clampSidebarNavigationHeight(
                                    event.key === 'Home' ? 20 : event.key === 'End' ? 80 : height + (event.key === 'ArrowUp' ? -5 : 5),
                                ));
                            }}>
                            <span aria-hidden="true" className="h-1 w-10 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary/60" />
                        </div>
                        <div ref={setViewSidebarSlot} id="view-sidebar-panel" data-view-sidebar-slot className="min-h-0 overflow-y-auto pr-1 pt-2" />
                    </>}
                </div>

                <div className="mt-auto border-t border-border/60 px-2 py-1.5" data-sidebar-footer>
                    <div className={cn("pb-1.5", isCollapsed && "flex justify-center")}>
                        <SidebarAreaFilter
                            areas={sortedAreas}
                            selection={resolvedAreaFilter}
                            onChange={handleAreaFilterChange}
                            ariaLabel={t('projects.areaFilter')}
                            allAreasLabel={t('projects.allAreas')}
                            noAreaLabel={t('projects.noArea')}
                            excludedLabel={tFallback(t, 'filters.excluded', 'Excluded')}
                            collapsed={isCollapsed}
                        />
                    </div>
                    <div className={cn(!isCollapsed && "border-t border-border/50 pt-1.5")}>
                        <div className={cn("flex gap-1.5", isCollapsed ? "flex-col items-center" : "items-center")}>
                            <button
                                type="button"
                                onClick={() => onViewChange('settings')}
                                className={cn(
                                    "group relative w-full rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset",
                                    isCollapsed ? "flex h-10 items-center justify-center px-0" : "h-9 min-w-0 flex-1 px-2",
                                    currentView === 'settings'
                                        ? "bg-primary/5 text-primary"
                                        : "text-muted-foreground hover:bg-accent/70 hover:text-accent-foreground"
                                )}
                                aria-current={currentView === 'settings' ? 'page' : undefined}
                                title={t('nav.settings')}
                                aria-label={isCollapsed && !syncOff ? `${t('nav.settings')}. ${syncTooltip}` : t('nav.settings')}
                            >
                                <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
                                    <Settings className="h-4 w-4 shrink-0" />
                                    {!isCollapsed && <span>{t('nav.settings')}</span>}
                                </span>
                                {isCollapsed && !syncOff && (
                                    <span
                                        className={cn(
                                            "absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-card",
                                            syncFreshnessDotClass,
                                            syncBusy && "animate-pulse"
                                        )}
                                        title={syncTooltip}
                                        aria-hidden="true"
                                    />
                                )}
                            </button>
                            {!isCollapsed && !syncOff && (
                                <button
                                    type="button"
                                    onClick={onOpenSyncSettings ?? (() => onViewChange('settings'))}
                                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
                                    title={syncStatusDescription}
                                    aria-label={syncStatusDescription}
                                    data-sidebar-sync-status
                                >
                                    <span
                                        className={cn(
                                            "h-2 w-2 shrink-0 rounded-full",
                                            syncFreshnessDotClass,
                                            syncBusy && "animate-pulse"
                                        )}
                                        data-sidebar-sync-dot
                                        aria-hidden="true"
                                    />
                                    <span className="sr-only" role="status" aria-live="polite">
                                        {syncStatusLabel}
                                    </span>
                                    <span className="shrink-0 tabular-nums text-muted-foreground">{compactSyncTimeLabel}</span>
                                </button>
                            )}
                            {!syncOff && (
                                <button
                                    type="button"
                                    onClick={handleManualSyncNow}
                                    disabled={manualSyncBusy}
                                    // overflow-hidden matters on engines where the spinner still turns on
                                    // the compositor (no `@property`; see `.animate-spin` in index.css).
                                    // Elsewhere the spinner has no layer at all and this is a no-op.
                                    // There (#1251): Chromium cannot bound a running rotate animation, so
                                    // it assumes the spinner may reach
                                    // anywhere inside its nearest clip. With no clip that was the whole
                                    // window: every positioned box painted after the sidebar (each task
                                    // row) was lifted into its own transparent layer for "overlap", and
                                    // text in a transparent layer drops from ClearType to grey
                                    // antialiasing. Clipping here keeps the spinner's reach to the button.
                                    className={cn(
                                        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60",
                                        "hover:bg-accent/70 hover:text-accent-foreground",
                                        isCollapsed ? "h-10 w-10" : "h-9 w-9"
                                    )}
                                    title={`${syncNowLabel}. ${syncTooltip}`}
                                    aria-label={`${syncNowLabel}. ${syncTooltip}`}
                                >
                                    <RefreshCw className={cn("h-4 w-4", manualSyncBusy && "animate-spin")} aria-hidden="true" />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
                </aside>
            )}

            {/* Main Content */}
            <main
                id="main-content"
                // tabIndex=-1 makes this a programmatic focus target for the
                // "enter list" fallback; it is never keyboard-tabbable, so it
                // must not paint a focus ring around the whole list (#890).
                className="flex-1 overflow-auto focus:outline-none"
                data-main-content
                tabIndex={-1}
                role="main"
                aria-label={tFallback(t, 'accessibility.mainContent', 'Main content')}
            >
                <div className={cn(
                    // No bottom padding: this box is `h-full`, so a `pb-*` here
                    // is a dead band below every view that scrolls inside it and
                    // is skipped entirely by every view that overflows it. Each
                    // view puts LIST_END_GAP on its own scrolled content instead
                    // (#977).
                    (contentView === 'projects' || contentView === 'contexts') ? "mx-auto h-full" : "mx-auto h-full px-4 pt-4 lg:px-6 lg:pt-6 2xl:px-8 2xl:pt-8",
                    isFocusMode
                        ? "max-w-[800px]"
                        : isFullWidthView
                            ? "w-full max-w-none"
                            // The week/month grids want more room than a list does, but going
                            // edge-to-edge looks wrong, so the calendar keeps its side margins (#966).
                            // The timeline is the same shape of chart and takes the same box (#1111).
                            : contentView === 'calendar' || contentView === 'timeline'
                            ? "w-full max-w-screen-2xl"
                            : isWideView
                            ? "w-full max-w-6xl"
                            : "max-w-4xl"
                )}>
                    {error && (
                        <div
                            role="alert"
                            aria-live="assertive"
                            className="mb-4 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                        >
                            <span>{error}</span>
                            <button
                                type="button"
                                className="text-destructive/80 hover:text-destructive underline underline-offset-2"
                                onClick={() => setError(null)}
                            >
                                {dismissText}
                            </button>
                        </div>
                    )}
                    {cleartextSyncWarning && (
                        <div
                            role="status"
                            aria-live="polite"
                            className="mb-4 flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground"
                        >
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                            <span className="flex-1">{cleartextSyncWarning.message}</span>
                            <button
                                type="button"
                                className="shrink-0 underline underline-offset-2 hover:text-muted-foreground"
                                onClick={() => {
                                    dismissedCleartextDestinations.current.add(cleartextSyncWarning.destination);
                                    dismissCleartextSyncWarning(cleartextSyncWarning.destination);
                                    setCleartextSyncWarning(null);
                                }}
                            >
                                {tFallback(t, 'settings.cleartextSyncDismiss', 'Dismiss for this sync destination')}
                            </button>
                        </div>
                    )}
                    {children}
                </div>
            </main>
            <ToastHost />
        </div>
        </ViewSidebarContext.Provider>
    );
}
