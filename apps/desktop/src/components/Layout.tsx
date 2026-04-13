import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Calendar,
    Inbox,
    CheckSquare,
    Archive,
    Layers,
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
    RefreshCw,
    BookOpen,
    type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { shallow, useTaskStore, safeParseDate, safeFormatDate } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';
import { useObsidianStore } from '../store/obsidian-store';
import { reportError } from '../lib/report-error';
import { ToastHost } from './ToastHost';
import { AREA_FILTER_ALL, resolveAreaFilter, taskMatchesAreaFilter } from '../lib/area-filter';
import { SyncService } from '../lib/sync-service';
import { SidebarAreaFilter } from './ui/SidebarAreaFilter';

interface LayoutProps {
    children: React.ReactNode;
    currentView: string;
    onViewChange: (view: string) => void;
}

type NavItem = {
    id: string;
    labelKey?: string;
    fallbackLabel?: string;
    icon: LucideIcon;
    count?: number;
};

type NavSection = {
    key: string;
    label: string;
    items: NavItem[];
};

const SECTION_COLLAPSE_STORAGE_KEY = 'mindwtr:sidebar:collapsedSections';

function loadCollapsedSections(): Set<string> {
    if (typeof window === 'undefined') return new Set();
    try {
        const raw = window.localStorage.getItem(SECTION_COLLAPSE_STORAGE_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
    } catch {
        return new Set();
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

export function Layout({ children, currentView, onViewChange }: LayoutProps) {
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
    const isCollapsed = settings?.sidebarCollapsed ?? false;
    const isFocusMode = useUiStore((state) => state.isFocusMode);
    const isObsidianEnabled = useObsidianStore((state) => state.config.enabled);
    const tOrFallback = (key: string, fallback: string) => {
        const value = t(key);
        return value === key ? fallback : value;
    };
    const [syncStatus, setSyncStatus] = useState(() => SyncService.getSyncStatus());
    const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
    const searchShortcutHint = useMemo(() => (
        typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl+K'
    ), []);
    const lastSyncAt = settings?.lastSyncAt;
    const lastSyncStatus = settings?.lastSyncStatus;
    const lastSyncError = settings?.lastSyncError?.trim();

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
    lastSyncAtRef.current = lastSyncAt;
    useEffect(() => {
        setSyncFreshness(getSyncFreshnessBucket(lastSyncAt));
        const timer = setInterval(() => {
            setSyncFreshness(getSyncFreshnessBucket(lastSyncAtRef.current));
        }, 60_000);
        return () => clearInterval(timer);
    }, [lastSyncAt, getSyncFreshnessBucket]);

    const syncFreshnessDotClass = !isOnline
        ? 'bg-destructive'
        : lastSyncStatus === 'error'
            ? 'bg-orange-400'
            : syncFreshness === 'none'
                ? 'bg-muted-foreground/40'
                : syncFreshness === 'old'
                    ? 'bg-destructive'
                    : syncFreshness === 'stale'
                        ? 'bg-amber-400'
                        : 'bg-emerald-400';
    const fullSyncTimestamp = lastSyncAt ? safeFormatDate(lastSyncAt, 'PPpp', lastSyncAt) : t('settings.lastSyncNever');
    const syncTooltip = !isOnline
        ? (t('common.offline') || 'Offline')
        : lastSyncStatus === 'error' && lastSyncError
            ? `${tOrFallback('settings.lastSyncError', 'Sync failed')}: ${lastSyncError}\n${tOrFallback('settings.lastSync', 'Last sync')}: ${fullSyncTimestamp}`
            : `${tOrFallback('settings.lastSync', 'Last sync')}: ${fullSyncTimestamp}`;
    const formatCompactSyncTime = useCallback((iso: string) => {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return iso;
        return new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(date);
    }, []);
    const compactSyncLabel = syncStatus.inFlight
        ? tOrFallback('settings.syncing', 'Syncing...')
        : lastSyncAt
            ? `${tOrFallback('settings.lastSync', 'Last sync')}: ${formatCompactSyncTime(lastSyncAt)}`
            : tOrFallback('settings.lastSyncNever', 'Never');
    const dismissLabel = t('common.dismiss');
    const dismissText = dismissLabel && dismissLabel !== 'common.dismiss' ? dismissLabel : 'Dismiss';
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );
    const sortedAreas = useMemo(() => [...areas].sort((a, b) => a.order - b.order), [areas]);
    const inboxCount = useMemo(() => {
        const now = Date.now();
        let count = 0;
        for (const task of tasks) {
            if (task.deletedAt) continue;
            if (task.status !== 'inbox') continue;
            const start = safeParseDate(task.startTime);
            if (start && start.getTime() > now) continue;
            if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)) continue;
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
            label: t('nav.sectionFocus') || 'Focus',
            items: [
                { id: 'inbox', labelKey: 'nav.inbox', icon: Inbox, count: inboxCount },
                { id: 'agenda', labelKey: 'nav.agenda', icon: Target },
            ],
        },
        {
            key: 'lists',
            label: t('nav.sectionLists') || 'Lists',
            items: [
                { id: 'projects', labelKey: 'nav.projects', icon: Folder },
                { id: 'someday', labelKey: 'nav.someday', icon: Clock3 },
                { id: 'waiting', labelKey: 'nav.waiting', icon: PauseCircle },
                { id: 'reference', labelKey: 'nav.reference', icon: Book },
            ],
        },
        {
            key: 'organize',
            label: t('nav.sectionOrganize') || 'Organize',
            items: [
                { id: 'calendar', labelKey: 'nav.calendar', icon: Calendar },
                { id: 'review', labelKey: 'nav.review', icon: CheckCircle2 },
                { id: 'contexts', labelKey: 'nav.contexts', icon: Tag },
                ...(isObsidianEnabled
                    ? [{ id: 'obsidian', labelKey: 'nav.obsidian', fallbackLabel: 'Obsidian', icon: BookOpen }]
                    : []),
                { id: 'board', labelKey: 'nav.board', icon: Layers },
            ],
        },
        {
            key: 'archive',
            label: t('nav.sectionArchive') || 'Archive',
            items: [
                { id: 'done', labelKey: 'nav.done', icon: CheckSquare },
                { id: 'archived', labelKey: 'nav.archived', icon: Archive },
                { id: 'trash', labelKey: 'nav.trash', icon: Trash2 },
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

    const triggerSearch = () => {
        window.dispatchEvent(new CustomEvent('mindwtr:open-search'));
    };

    const savedSearches = settings?.savedSearches || [];

    const toggleSidebar = () => {
        updateSettings({ sidebarCollapsed: !isCollapsed }).catch((error) => reportError('Failed to update settings', error));
    };

    useEffect(() => {
        if (areas.length === 0) return;
        if (!settings?.filters?.areaId) {
            updateSettings({ filters: { ...(settings?.filters ?? {}), areaId: AREA_FILTER_ALL } })
                .catch((error) => reportError('Failed to set default area filter', error));
            return;
        }
        if (resolvedAreaFilter === settings?.filters?.areaId) return;
        updateSettings({ filters: { ...(settings?.filters ?? {}), areaId: resolvedAreaFilter } })
            .catch((error) => reportError('Failed to update area filter', error));
    }, [areas.length, resolvedAreaFilter, settings?.filters?.areaId, updateSettings]);

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
        return SyncService.subscribeSyncStatus(setSyncStatus);
    }, []);

    const handleAreaFilterChange = (value: string) => {
        updateSettings({ filters: { ...(settings?.filters ?? {}), areaId: value } })
            .catch((error) => reportError('Failed to update area filter', error));
    };


    return (
        <div className="flex h-screen overflow-hidden bg-background text-foreground">
            <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded-md focus:bg-primary focus:text-primary-foreground"
            >
                {tOrFallback('accessibility.skipToContent', 'Skip to content')}
            </a>
            {/* Sidebar */}
            {!isFocusMode && (
                <aside className={cn(
                    "border-r border-border bg-card flex flex-col transition-all duration-150",
                    isCollapsed ? "w-16 p-2" : "w-64 p-4"
                )}>
                <div className={cn("flex items-center gap-2 px-2 mb-4", isCollapsed && "justify-center")}>
                    {!isCollapsed && (
                        <img
                            src="/logo.png"
                            alt="Mindwtr"
                            className="w-8 h-8 rounded-lg"
                        />
                    )}
                    {!isCollapsed && <h1 className="text-xl font-bold">{t('app.name')}</h1>}
                    <button
                        onClick={toggleSidebar}
                        className={cn(
                            "ml-auto p-1 rounded hover:bg-accent transition-colors text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/40",
                            isCollapsed && "ml-0"
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
                        "w-full flex items-center gap-3 px-3 py-2 mb-4 rounded-md text-sm font-medium transition-colors bg-muted/50 hover:bg-accent hover:text-accent-foreground text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/40",
                        isCollapsed && "justify-center px-2"
                    )}
                    title={t('search.placeholder')}
                >
                    <Search className="w-4 h-4" />
                    {!isCollapsed && (
                        <>
                            <span className="flex-1 text-left">{t('search.placeholder') || 'Search...'}</span>
                            <span className="text-xs opacity-50">{searchShortcutHint}</span>
                        </>
                    )}
                </button>

                <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                    {savedSearches.length > 0 && (
                        <div className={cn("mb-4 space-y-1", isCollapsed && "mb-2")}>
                            {!isCollapsed && (
                                <div className="px-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    {t('search.savedSearches')}
                                </div>
                            )}
                            {savedSearches.map((search) => (
                                <button
                                    key={search.id}
                                    onClick={() => onViewChange(`savedSearch:${search.id}`)}
                                    className={cn(
                                        "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset",
                                        currentView === `savedSearch:${search.id}`
                                            ? "bg-primary/10 text-primary"
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

                    <nav className="space-y-4 pb-4" data-sidebar-nav>
                        {navSections.map((section) => {
                            const isSectionCollapsed = !isCollapsed && collapsedSections.has(section.key);
                            const sectionId = `sidebar-section-${section.key}`;
                            return (
                            <div key={section.key} className="space-y-0.5">
                                {!isCollapsed && (
                                    <button
                                        type="button"
                                        onClick={() => toggleSection(section.key)}
                                        aria-expanded={!isSectionCollapsed}
                                        aria-controls={sectionId}
                                        className="group w-full flex items-center gap-1 px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded cursor-pointer"
                                    >
                                        <ChevronDown
                                            className={cn(
                                                "w-3 h-3 transition-transform duration-150",
                                                isSectionCollapsed && "-rotate-90"
                                            )}
                                        />
                                        <span>{section.label}</span>
                                    </button>
                                )}
                                <div id={sectionId} className={cn("space-y-0.5", isSectionCollapsed && "hidden")}>
                                {section.items.map((item) => (
                                    <button
                                        key={item.id}
                                        onClick={() => onViewChange(item.id)}
                                        data-sidebar-item
                                        data-view={item.id}
                                        className={cn(
                                            "w-full flex items-center rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset",
                                            currentView === item.id
                                                ? "bg-primary/10 text-primary"
                                                : "hover:bg-accent text-muted-foreground",
                                            isCollapsed ? "justify-center px-2 py-2.5" : "justify-between px-3 py-2.5"
                                        )}
                                        aria-current={currentView === item.id ? 'page' : undefined}
                                    title={item.labelKey ? tOrFallback(item.labelKey, item.fallbackLabel ?? item.id) : (item.fallbackLabel ?? item.id)}
                                    >
                                        <div className={cn("flex items-center gap-3", isCollapsed && "gap-0")}>
                                            <item.icon className={cn("w-4 h-4", currentView === item.id && "text-primary")} />
                                            {!isCollapsed && (item.labelKey ? tOrFallback(item.labelKey, item.fallbackLabel ?? item.id) : (item.fallbackLabel ?? item.id))}
                                        </div>
                                        {!isCollapsed && item.count !== undefined && item.count > 0 && (
                                            <span className={cn(
                                                "text-xs px-2 py-0.5 rounded-full font-medium",
                                                currentView === item.id
                                                    ? "bg-primary text-primary-foreground"
                                                    : "bg-muted text-muted-foreground"
                                            )}>
                                                {item.count}
                                            </span>
                                        )}
                                    </button>
                                ))}
                                </div>
                            </div>
                            );
                        })}
                    </nav>
                </div>

                <div className="mt-auto pt-2">
                    {!isCollapsed && (
                        <div className="px-2 pb-2">
                            <SidebarAreaFilter
                                areas={sortedAreas}
                                value={resolvedAreaFilter}
                                onChange={handleAreaFilterChange}
                                ariaLabel={t('projects.areaFilter')}
                                allAreasLabel={t('projects.allAreas')}
                                noAreaLabel={t('projects.noArea')}
                            />
                        </div>
                    )}
                    <div className="border-t border-border" />
                    <div className="px-2 pb-2 pt-2">
                        <button
                            onClick={() => onViewChange('settings')}
                            className={cn(
                                "w-full rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset text-xs font-medium h-9 px-3 flex items-center",
                                isCollapsed ? "justify-center" : "justify-between",
                                currentView === 'settings'
                                    ? "border-primary/50 bg-primary/10 text-primary"
                                    : "border-border bg-muted/40 hover:bg-accent text-muted-foreground"
                            )}
                            aria-current={currentView === 'settings' ? 'page' : undefined}
                            title={!isCollapsed ? `${t('nav.settings')} • ${syncTooltip}` : t('nav.settings')}
                            aria-label={isCollapsed ? `${t('nav.settings')}. ${syncTooltip}` : t('nav.settings')}
                        >
                            <span className="inline-flex items-center gap-2">
                                <Settings className="w-4 h-4" />
                                {!isCollapsed && <span>{t('nav.settings')}</span>}
                            </span>
                            {!isCollapsed && (
                                <span
                                    className="inline-flex items-center gap-2 text-[11px]"
                                    role="status"
                                    aria-live="polite"
                                    aria-label={syncTooltip}
                                >
                                    <RefreshCw className={cn("w-3.5 h-3.5", syncStatus.inFlight && "animate-spin")} />
                                    <span>{compactSyncLabel}</span>
                                    <span
                                        className={cn("w-2 h-2 rounded-full shrink-0", syncFreshnessDotClass)}
                                        title={syncTooltip}
                                        aria-hidden="true"
                                    />
                                </span>
                            )}
                        </button>
                    </div>
                </div>
                </aside>
            )}

            {/* Main Content */}
            <main
                id="main-content"
                className="flex-1 overflow-auto"
                data-main-content
                tabIndex={-1}
                role="main"
                aria-label={tOrFallback('accessibility.mainContent', 'Main content')}
            >
                <div className={cn(
                    "mx-auto p-8 h-full",
                    isFocusMode
                        ? "max-w-[800px]"
                        : isFullWidthView
                            ? "w-full max-w-none"
                            : (isWideView || currentView === 'calendar')
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
                    {children}
                </div>
            </main>
            <ToastHost />
        </div>
    );
}
