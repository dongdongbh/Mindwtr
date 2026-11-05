import { useState, useEffect, useId, useMemo, useRef, useCallback } from 'react';
import { Search, FileText, CheckCircle, Save, SlidersHorizontal, X } from 'lucide-react';
import { shallow,
    useTaskStore,
    Task,
    Project,
    generateUUID,
    getUsedTaskTokens,
    SavedSearch,
    SearchProjectResult,
    SearchResults,
    SearchTaskResult,
    getStorageAdapter,
    normalizeWeekStartSetting,
    formatI18nTemplate,
    hasTimeComponent,
    isTaskFinished,
    isTaskCancelled,
    isTaskCompleted,
    safeFormatDate,
    TaskStatus,
    areaFilterSelectionToFilters,
    isAreaFilterSelectionActive,
    resolveAreaFilterSelection,
    taskMatchesAreaFilterSelection,
    projectMatchesAreaFilterSelection, tFallback,
    createSearchHighlighter,
    shouldRequestGlobalSearchFts,
    } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { cn } from '../lib/utils';
import { isImeComposing } from '../lib/ime';
import { getUrgencyColor } from './Task/TaskItemDisplay';
import { PromptModal } from './PromptModal';
import { Dialog } from './ui/Dialog';
import { useUiStore } from '../store/ui-store';
import {
    computeGlobalSearchResults,
    getGlobalSearchFilterPresentation,
    type DuePreset,
    type GlobalSearchScope,
} from '@mindwtr/core/global-search-filter';
import { resolveTaskNavigationView } from '../lib/task-navigation';
import { useFutureStartRevealTick, useLocalDayKey } from '../hooks/useLocalDayKey';
import { runAfterTaskEditExit } from './Task/task-edit-session';

interface GlobalSearchProps {


    onNavigate: (view: string, itemId?: string, options?: { highlightTaskId?: string }) => void;


    defaultIncludeCompleted?: boolean;
}

export type OpenGlobalSearchDetail = {
    query?: string;
    includeCompleted?: boolean;
};

export const resolveGlobalSearchTaskView = resolveTaskNavigationView;

export function GlobalSearch({ onNavigate, defaultIncludeCompleted = false }: GlobalSearchProps) {
    const dialogTitleId = useId();
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');


    const [searchQuery, setSearchQuery] = useState('');
    const isComposingRef = useRef(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [showSavePrompt, setShowSavePrompt] = useState(false);
    const [savePromptDefault, setSavePromptDefault] = useState('');
    const [includeCompleted, setIncludeCompleted] = useState(false);
    const [includeReference, setIncludeReference] = useState(true);
    const [hideFutureTasks, setHideFutureTasks] = useState(false);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [selectedStatuses, setSelectedStatuses] = useState<TaskStatus[]>([]);
    const [selectedArea, setSelectedArea] = useState<string>('all');
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const [locationQuery, setLocationQuery] = useState('');
    const [duePreset, setDuePreset] = useState<DuePreset>('any');
    const [scope, setScope] = useState<GlobalSearchScope>('all');
    const [ftsResults, setFtsResults] = useState<SearchResults | null>(null);


    const [ftsQuery, setFtsQuery] = useState('');
    const [ftsLoading, setFtsLoading] = useState(false);
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const resultsRef = useRef<HTMLDivElement>(null);
    const isOpenRef = useRef(false);
    const { _allTasks, _tasksById, projects, areas, settings, updateSettings } = useTaskStore(
        (state) => ({
            _allTasks: state._allTasks,
            _tasksById: state._tasksById,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
            updateSettings: state.updateSettings,
        }),
        shallow
    );
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);


    const taskById = _tasksById;
    const activeAreaFilter = useMemo(
        () => resolveAreaFilterSelection(settings?.filters, areas),
        [settings?.filters, areas]
    );
    const setProjectView = useUiStore((state) => state.setProjectView);
    const showToast = useUiStore((state) => state.showToast);
    const { t } = useLanguage();
    const filterPresentation = getGlobalSearchFilterPresentation(t);
    const futureStartDayKey = useLocalDayKey(isOpen && hideFutureTasks);
    const futureStartRevealTick = useFutureStartRevealTick(_allTasks, isOpen && hideFutureTasks);

    const openSearch = useCallback((detail: OpenGlobalSearchDetail = {}) => {
        const requestedQuery = typeof detail.query === 'string' ? detail.query : '';
        setQuery(requestedQuery);
        setSearchQuery(requestedQuery);
        setSelectedIndex(0);
        setShowSavePrompt(false);
        setIncludeCompleted(detail.includeCompleted ?? defaultIncludeCompleted);
        setIncludeReference(true);
        setHideFutureTasks(false);
        setFiltersOpen(false);
        setSelectedStatuses([]);
        setSelectedArea('all');
        setSelectedTokens([]);
        setLocationQuery('');
        setDuePreset('any');
        setScope('all');


        isComposingRef.current = false;
        setIsOpen(true);
        setTimeout(() => inputRef.current?.focus(), 0);
    }, [defaultIncludeCompleted]);


    useEffect(() => {
        isOpenRef.current = isOpen;
    }, [isOpen]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                if (isOpenRef.current) setIsOpen(false);
                else openSearch();
            }

            if (e.key === 'Escape' && isOpenRef.current && !isImeComposing(e)) {
                setIsOpen(false);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [openSearch]);

    useEffect(() => {
        const handleOpen: EventListener = (event) => {
            const detail = event instanceof CustomEvent && event.detail && typeof event.detail === 'object'
                ? event.detail as OpenGlobalSearchDetail
                : {};
            openSearch(detail);
        };
        window.addEventListener('mindwtr:open-search', handleOpen);
        return () => window.removeEventListener('mindwtr:open-search', handleOpen);
    }, [openSearch]);


    useEffect(() => {
        if (isOpen) {
            inputRef.current?.focus();
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [isOpen]);

    const trimmedQuery = searchQuery.trim();
    const highlightText = useMemo(() => createSearchHighlighter(searchQuery), [searchQuery]);
    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDebouncedQuery(trimmedQuery);
        }, 200);
        return () => window.clearTimeout(timer);
    }, [trimmedQuery]);

    const shouldUseFts = shouldRequestGlobalSearchFts(debouncedQuery);

    useEffect(() => {
        let cancelled = false;
        if (!shouldUseFts) {
            setFtsResults(null);
            setFtsLoading(false);
            return;
        }
        const adapter = getStorageAdapter();
        if (!adapter.searchAll) {
            setFtsResults(null);
            setFtsLoading(false);
            return;
        }
        setFtsLoading(true);
        adapter.searchAll(debouncedQuery)
            .then((results) => {
                if (!cancelled) {
                    setFtsResults(results);
                    setFtsQuery(debouncedQuery);
                }
            })
            .catch(() => {
                if (!cancelled) setFtsResults(null);
            })
            .finally(() => {
                if (!cancelled) setFtsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [debouncedQuery, shouldUseFts]);

    const allTokens = useMemo(() => {
        if (!isOpen) return selectedTokens;
        if (scope === 'projects') return selectedTokens;


        const eligible = computeGlobalSearchResults({
            query: '', tasks: _allTasks, projects, areas,
            includeCompleted, includeReference, hideFutureTasks,
            selectedStatuses, selectedArea, selectedTokens: [], locationQuery,
            duePreset, scope: scope === 'all' ? 'tasks' : scope,
            weekStart: normalizeWeekStartSetting(settings?.weekStart),
            limit: Number.POSITIVE_INFINITY,
        });
        const eligibleIds = new Set(eligible.results.flatMap((result) =>
            result.type === 'task' ? [result.item.id] : []));
        const eligibleTasks = _allTasks.filter((task) => eligibleIds.has(task.id));
        return Array.from(new Set([
            ...getUsedTaskTokens(eligibleTasks, (task) => [...(task.contexts ?? []), ...(task.tags ?? [])], { includeAncestors: true }),
            ...selectedTokens,
        ])).sort();
    }, [
        _allTasks, projects, areas, isOpen, includeCompleted, includeReference,
        hideFutureTasks, selectedStatuses, selectedArea, locationQuery, duePreset,
        scope, settings?.weekStart, selectedTokens, futureStartDayKey, futureStartRevealTick,
    ]);
    const includeCompletedLabel = t('search.includeCompleted');
    const includeCompletedText = includeCompletedLabel === 'search.includeCompleted'
        ? 'Include Done and Archived tasks'
        : includeCompletedLabel;
    const includeReferenceLabel = t('search.includeReference');
    const includeReferenceText = includeReferenceLabel === 'search.includeReference'
        ? 'Include Reference tasks'
        : includeReferenceLabel;
    const hideFutureTasksLabel = t('filters.hideFutureTasks');
    const hideFutureTasksText = hideFutureTasksLabel === 'filters.hideFutureTasks'
        ? 'Hide future tasks'
        : hideFutureTasksLabel;
    const { totalResultsLabel, results, isTruncated, hasActiveSearch } = useMemo(() => computeGlobalSearchResults({
        query: searchQuery,
        tasks: _allTasks,
        projects,
        areas,
        includeCompleted,
        includeReference,
        hideFutureTasks,
        selectedStatuses,
        selectedArea,
        selectedTokens,
        locationQuery,
        duePreset,
        scope,
        weekStart: normalizeWeekStartSetting(settings?.weekStart),
        ftsResults,
        ftsQuery,
    }), [
        searchQuery,
        _allTasks,
        projects,
        areas,
        includeCompleted,
        includeReference,
        hideFutureTasks,
        selectedStatuses,
        selectedArea,
        selectedTokens,
        locationQuery,
        duePreset,
        scope,
        settings?.weekStart,
        ftsResults,
        ftsQuery,
        futureStartDayKey,
        futureStartRevealTick,
    ]);

    useEffect(() => {
        if (results.length === 0) {
            if (selectedIndex !== 0) setSelectedIndex(0);
            return;
        }
        if (selectedIndex >= results.length) {
            setSelectedIndex(results.length - 1);
        }
    }, [results.length, selectedIndex]);

    useEffect(() => {
        if (!isOpen) return;
        if (selectedIndex < 0 || selectedIndex >= results.length) return;
        const container = resultsRef.current;
        if (!container) return;
        const target = container.querySelector<HTMLElement>(`[data-search-index="${selectedIndex}"]`);
        target?.scrollIntoView({ block: 'nearest' });
    }, [isOpen, selectedIndex, results.length]);

    const renderHighlighted = (text: string) => {
        return highlightText(text).map((segment, index) => (
            segment.highlighted
                ? <span key={index} className="text-primary font-semibold">{segment.text}</span>
                : segment.text
        ));
    };


    const renderResultDate = (result: SearchTaskResult) => {
        const task = taskById.get(result.id);
        if (!task) return null;
        if (isTaskCancelled(task)) {
            return (
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                    {formatI18nTemplate(t('search.cancelledDate'), {
                        date: safeFormatDate(task.cancelledAt!, hasTimeComponent(task.cancelledAt) ? 'Pp' : 'P'),
                    })}
                </span>
            );
        }
        if (isTaskCompleted(task)) {
            if (!task.completedAt) return null;
            return (
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                    {formatI18nTemplate(t('search.completedDate'), {
                        date: safeFormatDate(task.completedAt, hasTimeComponent(task.completedAt) ? 'Pp' : 'P'),
                    })}
                </span>
            );
        }
        if (!task.dueDate) return null;
        return (
            <span className={cn("shrink-0 whitespace-nowrap text-xs", getUrgencyColor(task))}>
                {formatI18nTemplate(t('search.dueDate'), {
                    date: safeFormatDate(task.dueDate, hasTimeComponent(task.dueDate) ? 'Pp' : 'P'),
                })}
            </span>
        );
    };


    const handleListKeyDown = (e: React.KeyboardEvent) => {
        if (isComposingRef.current || isImeComposing(e)) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (results[selectedIndex]) {
                handleSelect(results[selectedIndex]);
            }
        }
    };


    const handleDialogKeyDown = (e: React.KeyboardEvent) => {
        if (e.target === inputRef.current) return;
        if (
            e.target instanceof HTMLElement
            && e.target.closest('button, a[href], input, select, textarea, [contenteditable="true"]')
        ) {
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
            handleListKeyDown(e);
            return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            inputRef.current?.focus();
        }
    };

    const handleSelect = (result: { type: 'project'; item: SearchProjectResult } | { type: 'task'; item: SearchTaskResult }) => {


        setIsOpen(false);
        runAfterTaskEditExit(() => {
            const shouldSwitchToAllAreas = isAreaFilterSelectionActive(activeAreaFilter) && (
                result.type === 'project'
                    ? !projectMatchesAreaFilterSelection(result.item as Project, activeAreaFilter, areaById)
                    : !taskMatchesAreaFilterSelection(result.item as Task, activeAreaFilter, projectMap, areaById)
            );
            if (shouldSwitchToAllAreas) {
                void updateSettings({ filters: { ...(settings?.filters ?? {}), ...areaFilterSelectionToFilters({ included: [], excluded: [] }) } })
                    .catch(() => showToast(t('search.areaFilterFailed'), 'error'));
                showToast(t('search.switchedToAllAreas'), 'info');
            }
            if (result.type === 'project') {
                setProjectView({ selectedProjectId: result.item.id });
                onNavigate('projects', result.item.id);
            } else {

                const task = result.item;


                if (task.projectId && !isTaskFinished(task as Task)) {
                    setProjectView({ selectedProjectId: task.projectId });
                    onNavigate('projects', task.id, { highlightTaskId: task.id });
                    return;
                }
                const targetView = resolveGlobalSearchTaskView(task as Task);
                onNavigate(targetView, task.id, { highlightTaskId: task.id });
            }
        });
    };

    if (!isOpen) return null;

    const savedSearches = settings?.savedSearches || [];
    const canSave = trimmedQuery.length > 0;

    const handleSaveSearch = async () => {
        if (!canSave) return;
        const existing = savedSearches.find(s => s.query === trimmedQuery);
        if (existing) {
            setIsOpen(false);
            onNavigate(`savedSearch:${existing.id}`);
            return;
        }
        setSavePromptDefault(trimmedQuery);
        setShowSavePrompt(true);
    };

    const toggleStatus = (status: TaskStatus) => {
        setSelectedStatuses((prev) => (
            prev.includes(status) ? prev.filter((item) => item !== status) : [...prev, status]
        ));
    };
    const toggleToken = (token: string) => {
        setSelectedTokens((prev) => (
            prev.includes(token) ? prev.filter((item) => item !== token) : [...prev, token]
        ));
    };
    const activeChips: Array<{ key: string; label: string; onRemove: () => void }> = [];
    selectedStatuses.forEach((status) => {
        activeChips.push({
            key: `status:${status}`,
            label: `${t(`status.${status}`) ?? status}`,
            onRemove: () => toggleStatus(status),
        });
    });
    if (selectedArea !== 'all') {
        const label = selectedArea === 'none'
            ? (tFallback(t, 'taskEdit.noAreaOption', 'No area'))
            : (areas.find((area) => area.id === selectedArea)?.name ?? selectedArea);
        activeChips.push({
            key: `area:${selectedArea}`,
            label: `${filterPresentation.sections.area}: ${label}`,
            onRemove: () => setSelectedArea('all'),
        });
    }
    selectedTokens.forEach((token) => {
        activeChips.push({
            key: `token:${token}`,
            label: token,
            onRemove: () => toggleToken(token),
        });
    });
    if (locationQuery.trim()) {
        activeChips.push({
            key: 'location',
            label: `${tFallback(t, 'taskEdit.locationLabel', 'Location')}: ${locationQuery.trim()}`,
            onRemove: () => setLocationQuery(''),
        });
    }
    if (duePreset !== 'any') {
        activeChips.push({
            key: `due:${duePreset}`,
            label: `${filterPresentation.sections.due}: ${filterPresentation.due[duePreset]}`,
            onRemove: () => setDuePreset('any'),
        });
    }
    if (scope !== 'all') {
        activeChips.push({
            key: `scope:${scope}`,
            label: filterPresentation.scope[scope],
            onRemove: () => setScope('all'),
        });
    }
    if (includeCompleted) {
        activeChips.push({
            key: 'includeCompleted',
            label: includeCompletedText,
            onRemove: () => setIncludeCompleted(false),
        });
    }
    if (includeReference) {
        activeChips.push({
            key: 'includeReference',
            label: includeReferenceText,
            onRemove: () => setIncludeReference(false),
        });
    }
    if (hideFutureTasks) {
        activeChips.push({
            key: 'hideFutureTasks',
            label: hideFutureTasksText,
            onRemove: () => setHideFutureTasks(false),
        });
    }

    return (
        <Dialog
            onClose={() => setIsOpen(false)}
            labelledBy={dialogTitleId}
            placement="top"
            overlayClassName="pt-[20vh] bg-background/80 backdrop-blur-sm animate-in fade-in-0"

            closeOnEscape={false}
            onKeyDown={handleDialogKeyDown}


            panelClassName="max-w-lg max-h-[76vh] animate-in zoom-in-95 duration-100"
        >
            <h2 id={dialogTitleId} className="sr-only">{t('search.title')}</h2>
            <div className="shrink-0 flex items-center border-b px-4 py-3 gap-3">
                <Search className="w-5 h-5 text-muted-foreground" />
                <input
                    ref={inputRef}
                    aria-label={t('search.title')}


                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={query}
                    onChange={e => {
                        setQuery(e.target.value);


                        if (!isComposingRef.current) {
                            setSearchQuery(e.target.value);
                            setSelectedIndex(0);
                        }
                    }}
                    onCompositionStart={() => {
                        isComposingRef.current = true;
                    }}
                    onCompositionEnd={(e) => {
                        isComposingRef.current = false;
                        setSearchQuery(e.currentTarget.value);
                        setSelectedIndex(0);
                    }}
                    onKeyDown={handleListKeyDown}
                    placeholder={tFallback(t, 'search.placeholder', "Search tasks and projects...")}
                    className="min-w-0 flex-1 bg-transparent border-none outline-none text-lg placeholder:text-muted-foreground"
                />
                {canSave && (
                    <button
                        onClick={handleSaveSearch}
                        className="flex items-center gap-1 whitespace-nowrap rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
                        title={t('search.saveSearch')}
                    >
                        <Save className="w-3 h-3" />
                        {t('search.saveSearch')}
                    </button>
                )}
                <div className="text-xs text-muted-foreground border rounded px-1.5 py-0.5 hidden sm:inline-block">
                    ESC
                </div>
                <button
                    type="button"
                    aria-label={t('filters.label')}
                    aria-expanded={filtersOpen}
                    onClick={() => setFiltersOpen((prev) => !prev)}
                    className={cn(
                        "p-1.5 rounded-md border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors",
                        filtersOpen && "bg-muted/60 text-foreground"
                    )}
                >
                    <SlidersHorizontal className="w-4 h-4" />
                </button>
            </div>
            {activeChips.length > 0 && (
                <div className="shrink-0 px-4 py-2 border-b flex flex-wrap gap-2">
                    {activeChips.map((chip) => (
                        <button
                            key={chip.key}
                            type="button"
                            onClick={chip.onRemove}
                            className="flex items-center gap-1 whitespace-nowrap rounded-full border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60"
                        >
                            <span>{chip.label}</span>
                            <X className="w-3 h-3" />
                        </button>
                    ))}
                </div>
            )}
            {filtersOpen && (
                <div className="min-h-0 overflow-y-auto px-4 py-3 border-b space-y-3 text-xs">
                    <div className="space-y-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">{filterPresentation.sections.status}</div>
                        <div className="flex flex-wrap gap-2">
                            {(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'] as TaskStatus[]).map((status) => (
                                <button
                                    key={status}
                                    type="button"
                                    onClick={() => toggleStatus(status)}
                                    className={cn(
                                        "whitespace-nowrap rounded-full border px-2 py-1 text-xs transition-colors",
                                        selectedStatuses.includes(status)
                                            ? "bg-primary/15 text-primary border-primary/40"
                                            : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"
                                    )}
                                >
                                    {t(`status.${status}`) ?? status}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="space-y-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">{filterPresentation.sections.scope}</div>
                        <div className="flex flex-wrap gap-2">
                            {(Object.keys(filterPresentation.scope) as GlobalSearchScope[]).map((option) => (
                                <button
                                    key={option}
                                    type="button"
                                    onClick={() => setScope(option)}
                                    className={cn(
                                        "whitespace-nowrap rounded-full border px-2 py-1 text-xs transition-colors",
                                        scope === option
                                            ? "bg-primary/15 text-primary border-primary/40"
                                            : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"
                                    )}
                                >
                                    {filterPresentation.scope[option]}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">{filterPresentation.sections.area}</div>
                            <select
                                aria-label={tFallback(t, 'taskEdit.areaLabel', 'Area')}
                                value={selectedArea}
                                onChange={(event) => setSelectedArea(event.target.value)}
                                className="w-full rounded border border-border bg-muted/40 px-2 py-1 text-xs"
                            >
                                <option value="all">{tFallback(t, 'projects.allAreas', 'All areas')}</option>
                                <option value="none">{tFallback(t, 'taskEdit.noAreaOption', 'No area')}</option>
                                {areas.map((area) => (
                                    <option key={area.id} value={area.id}>{area.name}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-2">
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">{filterPresentation.sections.due}</div>
                            <select
                                aria-label={filterPresentation.sections.due}
                                value={duePreset}
                                onChange={(event) => setDuePreset(event.target.value as DuePreset)}
                                className="w-full rounded border border-border bg-muted/40 px-2 py-1 text-xs"
                            >
                                {(Object.keys(filterPresentation.due) as DuePreset[]).map((value) => (
                                    <option key={value} value={value}>{filterPresentation.due[value]}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
                            {tFallback(t, 'taskEdit.locationLabel', 'Location')}
                        </div>
                        <input
                            type="text"
                            aria-label={tFallback(t, 'taskEdit.locationLabel', 'Location')}
                            value={locationQuery}
                            onChange={(event) => setLocationQuery(event.target.value)}
                            placeholder={tFallback(t, 'taskEdit.locationPlaceholder', 'e.g. Office')}
                            className="w-full rounded border border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground"
                        />
                    </div>
                    <div className="space-y-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">{filterPresentation.sections.tokens}</div>
                        <div className="flex flex-wrap gap-2 max-h-20 overflow-y-auto">
                            {allTokens.map((token) => (
                                <button
                                    key={token}
                                    type="button"
                                    onClick={() => toggleToken(token)}
                                    className={cn(
                                        "whitespace-nowrap rounded-full border px-2 py-1 text-xs transition-colors",
                                        selectedTokens.includes(token)
                                            ? "bg-primary/15 text-primary border-primary/40"
                                            : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"
                                    )}
                                >
                                    {token}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            aria-pressed={includeCompleted}
                            onClick={() => setIncludeCompleted((prev) => !prev)}
                            className={cn(
                                "whitespace-nowrap rounded-full border px-2 py-1 text-xs transition-colors",
                                includeCompleted
                                    ? "bg-primary/15 text-primary border-primary/40"
                                    : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"
                            )}
                        >
                            {includeCompletedText}
                        </button>
                        <button
                            type="button"
                            aria-pressed={includeReference}
                            onClick={() => setIncludeReference((prev) => !prev)}
                            className={cn(
                                "whitespace-nowrap rounded-full border px-2 py-1 text-xs transition-colors",
                                includeReference
                                    ? "bg-primary/15 text-primary border-primary/40"
                                    : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"
                            )}
                        >
                            {includeReferenceText}
                        </button>
                        <button
                            type="button"
                            aria-pressed={hideFutureTasks}
                            onClick={() => setHideFutureTasks((prev) => !prev)}
                            className={cn(
                                "whitespace-nowrap rounded-full border px-2 py-1 text-xs transition-colors",
                                hideFutureTasks
                                    ? "bg-primary/15 text-primary border-primary/40"
                                    : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"
                            )}
                        >
                            {hideFutureTasksText}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setSelectedStatuses([]);
                                setSelectedArea('all');
                                setSelectedTokens([]);
                                setLocationQuery('');
                                setDuePreset('any');
                                setScope('all');
                                setIncludeCompleted(false);
                                setIncludeReference(true);
                                setHideFutureTasks(false);
                            }}
                            className="text-xs text-muted-foreground hover:text-foreground"
                        >
                            {filterPresentation.clear}
                        </button>
                    </div>
                </div>
            )}

            <div ref={resultsRef} className="min-h-0 max-h-[60vh] overflow-y-auto p-2">
                {isTruncated && (
                    <div className="px-3 pb-2 text-xs text-muted-foreground">
                        {t('search.showingFirst')
                            .replace('{shown}', String(results.length))
                            .replace('{total}', totalResultsLabel)}
                    </div>
                )}
                {ftsLoading && trimmedQuery !== '' && (
                    <div className="py-3" role="status" aria-live="polite">
                        <div className="mb-2 text-center text-muted-foreground text-xs">
                            {t('search.searching')}
                        </div>
                        <div className="space-y-2 animate-pulse">
                            {Array.from({ length: 4 }).map((_, index) => (
                                <div key={index} className="px-3 py-2.5 rounded-lg border border-border/60 bg-muted/30">
                                    <div className="h-3.5 w-2/3 rounded bg-muted-foreground/20" />
                                    <div className="mt-2 h-2.5 w-1/3 rounded bg-muted-foreground/15" />
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                {!ftsLoading && results.length === 0 && hasActiveSearch && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                        {trimmedQuery
                            ? `${t('search.noResults')} "${trimmedQuery}"`
                            : t('search.noResults')}
                    </div>
                )}

                {


                    }
                {!ftsLoading && results.length === 0 && !hasActiveSearch && !filtersOpen && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                        {t('search.typeToSearch')}
                    </div>
                )}

                {results.map((result, index) => (
                    <button
                        key={`${result.type}-${result.item.id}`}
                        onClick={() => handleSelect(result)}
                        className={cn(
                            "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm transition-colors",
                            index === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"
                        )}
                        onMouseEnter={() => setSelectedIndex(index)}
                        data-search-index={index}
                    >
                        {result.type === 'project' ? (
                            <FileText className="w-4 h-4 text-info" />
                        ) : (
                            <CheckCircle className={cn("w-4 h-4", (result.item as SearchTaskResult).status === 'done' ? "text-success" : "text-muted-foreground")} />
                        )}

                        <div className="flex-1 flex flex-col overflow-hidden">
                            <span className="truncate font-medium">
                                {renderHighlighted(result.item.title)}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                                {result.type === 'project' ? t('search.resultProject') : t('search.resultTask')}
                                {result.type === 'task' && (result.item as SearchTaskResult).projectId ? ` • ${t('search.inProjectSuffix')}` : ''}
                            </span>
                        </div>

                        {result.type === 'task' && renderResultDate(result.item)}

                        {index === selectedIndex && (
                            <span className="text-xs text-muted-foreground">↵</span>
                        )}
                    </button>
                ))}

                {trimmedQuery !== '' && (
                    <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border mt-2">
                        {t('search.helpOperators')}
                    </div>
                )}
            </div>

        <PromptModal
            isOpen={showSavePrompt}
            title={t('search.saveSearch')}
            description={t('search.saveSearchPrompt')}
            placeholder={t('search.saveSearch')}
            defaultValue={savePromptDefault}
            confirmLabel={t('common.save')}
            cancelLabel={t('common.cancel')}
            onCancel={() => setShowSavePrompt(false)}
            onConfirm={async (value) => {
                const name = value.trim();
                if (!name) return;
                const newSearch: SavedSearch = {
                    id: generateUUID(),
                    name,
                    query: trimmedQuery,
                };
                await updateSettings({ savedSearches: [...savedSearches, newSearch] });
                setShowSavePrompt(false);
                setIsOpen(false);
                onNavigate(`savedSearch:${newSearch.id}`);
            }}
        />
        </Dialog>
    );
}
