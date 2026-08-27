import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
    Calendar,
    Inbox,
    CheckSquare,
    Archive,
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
    PauseCircle,
    Book,
    Clock3,
    BookOpen,
    AlertTriangle,
    Plus,
    RefreshCw,
    type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { shallow, useTaskStore, safeFormatDate, tFallback, isAllowedInsecureUrl, formatTaskMovedMessage } from '@mindwtr/core';
import type { StoreActionResult, TaskStatus } from '@mindwtr/core';
import { showUndoToast } from '../lib/undo-registry';
import { useLanguage } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';
import { useObsidianStore } from '../store/obsidian-store';
import { reportError } from '../lib/report-error';
import { ToastHost } from './ToastHost';
import { areaFilterSelectionToFilters, resolveAreaFilterSelection, taskMatchesAreaFilterSelection, type AreaFilterSelection } from '@mindwtr/core';
import { SyncService } from '../lib/sync-service';
import { SidebarAreaFilter } from './ui/SidebarAreaFilter';
import { getCalendarTaskDragTaskId, hasCalendarTaskDragData } from '../lib/calendar-task-drag';
import { stageCalendarDropLanding } from '../lib/calendar-view-params';

interface LayoutProps {
    children: React.ReactNode;
    currentView: string;
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
    done: 'done',
    archived: 'archived',
};
const SECTION_COLLAPSE_STORAGE_KEY = 'mindwtr:sidebar:collapsedSections';
const DEFAULT_COLLAPSED_SECTION_KEYS: string[] = [];

function createDefaultCollapsedSections(): Set<string> {
    return new Set(DEFAULT_COLLAPSED_SECTION_KEYS);
}

function loadCollapsedSections(): Set<string> {
    if (typeof window === 'undefined') return new Set();
    try {
        const raw = window.localStorage.getItem(SECTION_COLLAPSE_STORAGE_KEY);
        if (!raw) return createDefaultCollapsedSections();
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : createDefaultCollapsedSections();
    } catch {
        return createDefaultCollapsedSections();
    }
}

function saveCollapsedSections(keys: Set<string>) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(SECTION_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(keys)));
    } catch {
        // storage unavailable — fall back to in-memory only
    }
}

export function Layout({ children, currentView, onViewChange, onOpenSyncSettings }: LayoutProps) {
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
    const isFocusMode = useUiStore((state) => state.isFocusMode);
    const showToast = useUiStore((state) => state.showToast);
    const isObsidianEnabled = useObsidianStore((state) => state.config.enabled);
    const [syncStatus, setSyncStatus] = useState(() => SyncService.getSyncStatus());
    const [isManualSyncing, setIsManualSyncing] = useState(false);
    const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
    const [cleartextSyncWarning, setCleartextSyncWarning] = useState<string | null>(null);
    const searchShortcutHint = useMemo(() => (
        typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl+K'
    ), []);
    const lastSyncAt = settings?.lastSyncAt;
    const lastSyncStatus = settings?.lastSyncStatus;
    const lastSyncError = settings?.lastSyncError?.trim();
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
    const syncOff = syncStatus.backend === 'off';
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
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilterSelection(settings?.filters, areas),
        [settings?.filters, areas],
    );
    const sortedAreas = useMemo(() => [...areas].sort((a, b) => a.order - b.order), [areas]);
    const inboxCount = useMemo(() => {
        let count = 0;
        for (const task of tasks) {
            if (task.deletedAt) continue;
            if (task.status !== 'inbox') continue;
            if (!taskMatchesAreaFilterSelection(task, resolvedAreaFilter, projectMap, areaById)) continue;
            count += 1;
        }
        return count;
    }, [tasks, resolvedAreaFilter, projectMap, areaById]);
    const wideViews = new Set([
        'inbox',
        'next',
        'focus',
        'someday',
        'reference',
        'waiting',
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
    const isWideView = wideViews.has(currentView);
    const fullWidthViews = new Set([
        'board',
        'projects',
        'contexts',
        'obsidian',
        'settings',
    ]);
    const isFullWidthView = fullWidthViews.has(currentView);

    const navSections = useMemo<NavSection[]>(() => ([
        {
            key: 'focus',
            label: tFallback(t, 'nav.sectionFocus', 'Focus'),
            items: [
                { id: 'agenda', labelKey: 'nav.agenda', icon: Target, tone: 'primary' },
                { id: 'inbox', labelKey: 'nav.inbox', icon: Inbox, count: inboxCount, tone: 'primary' },
            ],
        },
        {
            key: 'lists',
            label: tFallback(t, 'nav.sectionLists', 'Lists'),
            items: [
                { id: 'projects', labelKey: 'nav.projects', icon: Folder, tone: 'primary' },
                { id: 'someday', labelKey: 'nav.someday', icon: Clock3 },
                { id: 'waiting', labelKey: 'nav.waiting', icon: PauseCircle },
                { id: 'reference', labelKey: 'nav.reference', icon: Book },
            ],
        },
        {
            key: 'organize',
            label: tFallback(t, 'nav.sectionOrganize', 'Organize'),
            items: [
                { id: 'calendar', labelKey: 'nav.calendar', icon: Calendar },
                { id: 'review', labelKey: 'nav.review', icon: CheckCircle2 },
                { id: 'contexts', labelKey: 'nav.contexts', icon: Tag },
                ...(isObsidianEnabled
                    ? [{ id: 'obsidian', labelKey: 'nav.obsidian', fallbackLabel: 'Obsidian', icon: BookOpen }]
                    : []),
                { id: 'board', labelKey: 'nav.board', icon: Kanban },
            ],
        },
        {
            key: 'archive',
            label: tFallback(t, 'nav.sectionArchive', 'Archive'),
            items: [
                { id: 'done', labelKey: 'nav.done', icon: CheckSquare, tone: 'recessed' },
                { id: 'archived', labelKey: 'nav.archived', icon: Archive, tone: 'recessed' },
                { id: 'trash', labelKey: 'nav.trash', icon: Trash2, tone: 'recessed' },
            ],
        },
    ]), [inboxCount, isObsidianEnabled, t]);

    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => loadCollapsedSections());

    useEffect(() => {
        saveCollapsedSections(collapsedSections);
    }, [collapsedSections]);

    // Auto-expand the section containing the active view so it's never hidden.
    useEffect(() => {
        const activeSection = navSections.find((section) => section.items.some((item) => item.id === currentView));
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
        const title = task.title;
        void Promise.resolve(useTaskStore.getState().moveTask(taskId, nextStatus))
            .then((result) => {
                const outcome = result as StoreActionResult | undefined;
                if (outcome && outcome.success === false) {
                    throw new Error(outcome.error || 'Failed to change task status');
                }
                showUndoToast(formatTaskMovedMessage(t, title, nextStatus), () => {
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
            } else if (result.remoteFenceDeferred) {
                showToast(tFallback(t, 'settings.syncRetryQueued', 'Local changes arrived during sync. Retry queued.'), 'info');
            } else if (result.success && result.remoteWriteDeferred) {
                showToast(result.error || settings?.lastSyncError || tFallback(t, 'settings.lastSyncError', 'Sync failed'), 'error');
            } else if (result.success) {
                showToast(tFallback(t, 'settings.lastSyncSuccess', 'Sync completed'), 'success');
            } else {
                showToast(result.error || tFallback(t, 'settings.lastSyncError', 'Sync failed'), 'error');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            reportError('Sync failed', error);
            showToast(`${tFallback(t, 'settings.lastSyncError', 'Sync failed')}: ${message}`, 'error');
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

    useEffect(() => {
        void SyncService.refreshSyncBackendStatus();
        return SyncService.subscribeSyncStatus(setSyncStatus);
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mediaQuery = window.matchMedia('(max-width: 1023px)');
        const updateCompactViewport = () => setCompactViewport(mediaQuery.matches);
        updateCompactViewport();
        mediaQuery.addEventListener?.('change', updateCompactViewport);
        return () => mediaQuery.removeEventListener?.('change', updateCompactViewport);
    }, []);

    const refreshCleartextSyncWarning = useCallback(async () => {
        // Loopback HTTP never leaves the machine, so the cleartext banner would
        // nag about a setup the app itself auto-allows (base-options
        // isAllowedInsecureUrl admits exactly https and loopback http). LAN HTTP
        // keeps the banner: that traffic really does cross a network.
        const isCleartextNetworkUrl = (rawUrl: string): boolean => {
            const url = rawUrl.trim().toLowerCase();
            return url.startsWith('http://') && !isAllowedInsecureUrl(url);
        };
        try {
            const configuration = await SyncService.getPersistedSyncConfigurationSnapshot();
            if (configuration.backend === 'webdav') {
                if (isCleartextNetworkUrl(configuration.webdav.url)) {
                    setCleartextSyncWarning(tFallback(t,
                        'settings.cleartextSyncWarningWebdav',
                        'WebDAV sync is using HTTP. Data is unencrypted; use it only on a trusted network.'
                    ));
                    return;
                }
            } else if (
                configuration.backend === 'cloud'
                && configuration.cloudProvider === 'selfhosted'
            ) {
                if (isCleartextNetworkUrl(configuration.cloud.url)) {
                    setCleartextSyncWarning(tFallback(t,
                        'settings.cleartextSyncWarningCloud',
                        'Self-hosted sync is using HTTP. Data is unencrypted; use it only on a trusted network.'
                    ));
                    return;
                }
            }
            setCleartextSyncWarning(null);
        } catch {
            setCleartextSyncWarning(null);
        }
    }, [t]);

    useEffect(() => {
        void refreshCleartextSyncWarning();
        const handleStorage = () => void refreshCleartextSyncWarning();
        const handleFocus = () => void refreshCleartextSyncWarning();
        window.addEventListener('storage', handleStorage);
        window.addEventListener('focus', handleFocus);
        const timer = setInterval(() => {
            void refreshCleartextSyncWarning();
        }, 30_000);
        return () => {
            window.removeEventListener('storage', handleStorage);
            window.removeEventListener('focus', handleFocus);
            clearInterval(timer);
        };
    }, [refreshCleartextSyncWarning]);

    const handleAreaFilterChange = (selection: AreaFilterSelection) => {
        updateSettings({ filters: { ...(settings?.filters ?? {}), ...areaFilterSelectionToFilters(selection) } })
            .catch((error) => reportError('Failed to update area filter', error));
    };


    return (
        <div className="flex h-screen overflow-hidden bg-background text-foreground">
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
                    isCollapsed ? "w-16 p-2" : "w-64 px-3 pt-5 pb-3"
                )}>
                <div className={cn("flex items-center gap-2 px-1.5 mb-6", isCollapsed && "justify-center")}>
                    {!isCollapsed && (
                        <img
                            src="/logo.png"
                            alt="Mindwtr"
                            className="w-7 h-7 rounded-md"
                        />
                    )}
                    {!isCollapsed && <h1 className="text-base font-semibold tracking-tight">{t('app.name')}</h1>}
                    <button
                        onClick={toggleSidebar}
                        className={cn(
                            "ml-auto p-1 rounded-md hover:bg-accent transition-colors text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/40",
                            isCollapsed && "ml-0",
                            compactViewport && "hidden"
                        )}
                        title={t('keybindings.toggleSidebar')}
                        aria-label={t('keybindings.toggleSidebar')}
                    >
                        {isCollapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
                    </button>
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

                <div className="flex-1 min-h-0 overflow-y-auto pr-1">
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
                            const isSectionCollapsed = !isCollapsed && collapsedSections.has(section.key);
                            const sectionId = `sidebar-section-${section.key}`;
                            return (
                            <div key={section.key} className="space-y-1">
                                {!isCollapsed && (
                                    <button
                                        type="button"
                                        onClick={() => toggleSection(section.key)}
                                        aria-expanded={!isSectionCollapsed}
                                        aria-controls={sectionId}
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
                                <div id={sectionId} className={cn("space-y-1", isSectionCollapsed && "hidden")}>
                                {section.items.map((item) => {
                                    const itemLabel = item.labelKey ? tFallback(t, item.labelKey, item.fallbackLabel ?? item.id) : (item.fallbackLabel ?? item.id);
                                    const isActiveItem = currentView === item.id;
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
                                    className={cn(
                                        "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60",
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
                    "mx-auto h-full px-4 pt-4 lg:px-6 lg:pt-6 2xl:px-8 2xl:pt-8",
                    isFocusMode
                        ? "max-w-[800px]"
                        : isFullWidthView
                            ? "w-full max-w-none"
                            // The week/month grids want more room than a list does, but going
                            // edge-to-edge looks wrong, so the calendar keeps its side margins (#966).
                            : currentView === 'calendar'
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
                            <span>{cleartextSyncWarning}</span>
                        </div>
                    )}
                    {children}
                </div>
            </main>
            <ToastHost />
        </div>
    );
}
