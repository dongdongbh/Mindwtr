import { useState, useEffect, useId, useMemo, useRef } from 'react';
import { Search, FileText, CheckCircle, Save, SlidersHorizontal, X } from 'lucide-react';
import {
    shallow,
    useTaskStore,
    Task,
    generateUUID,
    SavedSearch,
    SearchProjectResult,
    SearchResults,
    SearchTaskResult,
    getStorageAdapter,
    TaskStatus,
} from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { cn } from '../lib/utils';
import { PromptModal } from './PromptModal';
import { useUiStore } from '../store/ui-store';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, resolveAreaFilter } from '../lib/area-filter';
import { computeGlobalSearchResults, type DuePreset, type GlobalSearchScope } from './global-search-filtering';
import { resolveTaskNavigationView } from '../lib/task-navigation';

interface GlobalSearchProps {
    onNavigate: (view: string, itemId?: string) => void;
}

export const resolveGlobalSearchTaskView = resolveTaskNavigationView;

export function GlobalSearch({ onNavigate }: GlobalSearchProps) {
    const dialogTitleId = useId();
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [showSavePrompt, setShowSavePrompt] = useState(false);
    const [savePromptDefault, setSavePromptDefault] = useState('');
    const [includeCompleted, setIncludeCompleted] = useState(false);
    const [includeReference, setIncludeReference] = useState(true);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [selectedStatuses, setSelectedStatuses] = useState<TaskStatus[]>([]);
    const [selectedArea, setSelectedArea] = useState<string>('all');
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const [duePreset, setDuePreset] = useState<DuePreset>('any');
    const [scope, setScope] = useState<GlobalSearchScope>('all');
    const [ftsResults, setFtsResults] = useState<SearchResults | null>(null);
    const [ftsLoading, setFtsLoading] = useState(false);
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const resultsRef = useRef<HTMLDivElement>(null);
    const isOpenRef = useRef(false);
    const { _allTasks, projects, areas, settings, updateSettings, setHighlightTask, getDerivedState } = useTaskStore(
        (state) => ({
            _allTasks: state._allTasks,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
            updateSettings: state.updateSettings,
            setHighlightTask: state.setHighlightTask,
            getDerivedState: state.getDerivedState,
        }),
        shallow
    );
    const { allContexts, allTags } = getDerivedState();
    const setProjectView = useUiStore((state) => state.setProjectView);
    const { t } = useLanguage();

    const globalAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );

    // Toggle search with Cmd+K / Ctrl+K
    useEffect(() => {
        isOpenRef.current = isOpen;
    }, [isOpen, globalAreaFilter]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                setIsOpen(prev => !prev);
            }
            if (e.key === 'Escape' && isOpenRef.current) {
                setIsOpen(false);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    useEffect(() => {
        const handleOpen: EventListener = () => setIsOpen(true);
        window.addEventListener('mindwtr:open-search', handleOpen);
        return () => window.removeEventListener('mindwtr:open-search', handleOpen);
    }, []);

    // Auto-focus input when opened
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => inputRef.current?.focus(), 50);
            setQuery('');
            setSelectedIndex(0);
            setShowSavePrompt(false);
            setIncludeCompleted(false);
            setIncludeReference(true);
            setFiltersOpen(false);
            setSelectedStatuses([]);
            const initialArea = globalAreaFilter === AREA_FILTER_ALL
                ? 'all'
                : globalAreaFilter === AREA_FILTER_NONE
                    ? 'none'
                    : globalAreaFilter;
            setSelectedArea(initialArea);
            setSelectedTokens([]);
            setDuePreset('any');
            setScope('all');
        }
    }, [isOpen]);

    const trimmedQuery = query.trim();
    const highlightQuery = trimmedQuery && !/\b\w+:/i.test(trimmedQuery) ? trimmedQuery : '';
    const highlightRegex = useMemo(() => {
        if (!highlightQuery) return null;
        const escaped = highlightQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(${escaped})`, 'ig');
    }, [highlightQuery]);
    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDebouncedQuery(trimmedQuery);
        }, 200);
        return () => window.clearTimeout(timer);
    }, [trimmedQuery]);

    const shouldUseFts = debouncedQuery.length > 0 && !/\b\w+:/i.test(debouncedQuery);

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
                if (!cancelled) setFtsResults(results);
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
        return Array.from(new Set([...allContexts, ...allTags])).sort();
    }, [allContexts, allTags]);
    const includeCompletedLabel = t('search.includeCompleted');
    const includeCompletedText = includeCompletedLabel === 'search.includeCompleted'
        ? 'Include Done and Archived tasks'
        : includeCompletedLabel;
    const includeReferenceLabel = t('search.includeReference');
    const includeReferenceText = includeReferenceLabel === 'search.includeReference'
        ? 'Include Reference tasks'
        : includeReferenceLabel;
    const { totalResults, results, isTruncated } = useMemo(() => computeGlobalSearchResults({
        query,
        tasks: _allTasks,
        projects,
        areas,
        globalAreaFilter,
        includeCompleted,
        includeReference,
        selectedStatuses,
        selectedArea,
        selectedTokens,
        duePreset,
        scope,
        weekStart: settings?.weekStart === 'monday' ? 'monday' : 'sunday',
        ftsResults,
    }), [
        query,
        _allTasks,
        projects,
        areas,
        globalAreaFilter,
        includeCompleted,
        includeReference,
        selectedStatuses,
        selectedArea,
        selectedTokens,
        duePreset,
        scope,
        settings?.weekStart,
        ftsResults,
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
        if (!highlightRegex) return text;
        const parts = text.split(highlightRegex);
        return parts.map((part, index) => (
            index % 2 === 1
                ? <span key={`${part}-${index}`} className="text-primary font-semibold">{part}</span>
                : <span key={`${part}-${index}`}>{part}</span>
        ));
    };

    // Keyboard navigation
    const handleListKeyDown = (e: React.KeyboardEvent) => {
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

    const handleSelect = (result: { type: 'project'; item: SearchProjectResult } | { type: 'task'; item: SearchTaskResult }) => {
        setIsOpen(false);
        if (result.type === 'project') {
            setProjectView({ selectedProjectId: result.item.id });
            onNavigate('projects', result.item.id);
        } else {
            // Map task status to appropriate view
            const task = result.item;
            setHighlightTask(task.id);
            if (task.projectId) {
                setProjectView({ selectedProjectId: task.projectId });
                onNavigate('projects', task.id);
                return;
            }
            const targetView = resolveGlobalSearchTaskView(task as Task);
            onNavigate(targetView, task.id);
        }
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
            ? (t('taskEdit.noAreaOption') || 'No area')
            : (areas.find((area) => area.id === selectedArea)?.name ?? selectedArea);
        activeChips.push({
            key: `area:${selectedArea}`,
            label: `Area: ${label}`,
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
    if (duePreset !== 'any') {
        const labels: Record<string, string> = {
            overdue: 'Overdue',
            today: 'Today',
            tomorrow: 'Tomorrow',
            this_week: 'This week',
            next_week: 'Next week',
            none: 'No due date',
        };
        activeChips.push({
            key: `due:${duePreset}`,
            label: `Due: ${labels[duePreset] ?? duePreset}`,
            onRemove: () => setDuePreset('any'),
        });
    }
    if (scope !== 'all') {
        const labels: Record<string, string> = {
            projects: 'Projects only',
            tasks: 'Tasks only',
            project_tasks: 'Tasks in projects',
        };
        activeChips.push({
            key: `scope:${scope}`,
            label: labels[scope] ?? scope,
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

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-background/80 backdrop-blur-sm animate-in fade-in-0"
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
        >
            <div
                className="w-full max-w-lg bg-popover text-popover-foreground rounded-xl border shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-100"
                onClick={(e) => e.stopPropagation()}
            >
                <h2 id={dialogTitleId} className="sr-only">{t('search.title')}</h2>
                <div className="flex items-center border-b px-4 py-3 gap-3">
                    <Search className="w-5 h-5 text-muted-foreground" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={e => {
                            setQuery(e.target.value);
                            setSelectedIndex(0);
                        }}
                        onKeyDown={handleListKeyDown}
                        placeholder={t('search.placeholder') || "Search tasks and projects..."}
                        className="flex-1 bg-transparent border-none outline-none text-lg placeholder:text-muted-foreground"
                    />
                    {canSave && (
                        <button
                            onClick={handleSaveSearch}
                            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
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
                    <div className="px-4 py-2 border-b flex flex-wrap gap-2">
                        {activeChips.map((chip) => (
                            <button
                                key={chip.key}
                                type="button"
                                onClick={chip.onRemove}
                                className="flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60"
                            >
                                <span>{chip.label}</span>
                                <X className="w-3 h-3" />
                            </button>
                        ))}
                    </div>
                )}
                {filtersOpen && (
                    <div className="px-4 py-3 border-b space-y-3 text-xs">
                        <div className="space-y-2">
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">State</div>
                            <div className="flex flex-wrap gap-2">
                                {(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'] as TaskStatus[]).map((status) => (
                                    <button
                                        key={status}
                                        type="button"
                                        onClick={() => toggleStatus(status)}
                                        className={cn(
                                            "px-2 py-1 rounded-full border text-xs transition-colors",
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
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Scope</div>
                            <div className="flex flex-wrap gap-2">
                                {[
                                    { id: 'all', label: 'All' },
                                    { id: 'projects', label: 'Projects only' },
                                    { id: 'tasks', label: 'Tasks only' },
                                    { id: 'project_tasks', label: 'Tasks in projects' },
                                ].map((option) => (
                                    <button
                                        key={option.id}
                                        type="button"
                                        onClick={() => setScope(option.id as typeof scope)}
                                        className={cn(
                                            "px-2 py-1 rounded-full border text-xs transition-colors",
                                            scope === option.id
                                                ? "bg-primary/15 text-primary border-primary/40"
                                                : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"
                                        )}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-2">
                                <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Area</div>
                                <select
                                    value={selectedArea}
                                    onChange={(event) => setSelectedArea(event.target.value)}
                                    className="w-full rounded border border-border bg-muted/40 px-2 py-1 text-xs"
                                >
                                    <option value="all">{t('projects.allAreas') || 'All areas'}</option>
                                    <option value="none">{t('taskEdit.noAreaOption') || 'No area'}</option>
                                    {areas.map((area) => (
                                        <option key={area.id} value={area.id}>{area.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="space-y-2">
                                <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Due</div>
                                <select
                                    value={duePreset}
                                    onChange={(event) => setDuePreset(event.target.value as DuePreset)}
                                    className="w-full rounded border border-border bg-muted/40 px-2 py-1 text-xs"
                                >
                                    <option value="any">Any</option>
                                    <option value="overdue">Overdue</option>
                                    <option value="today">Today</option>
                                    <option value="tomorrow">Tomorrow</option>
                                    <option value="this_week">This week</option>
                                    <option value="next_week">Next week</option>
                                    <option value="none">No due date</option>
                                </select>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Contexts & Tags</div>
                            <div className="flex flex-wrap gap-2 max-h-20 overflow-y-auto">
                                {allTokens.map((token) => (
                                    <button
                                        key={token}
                                        type="button"
                                        onClick={() => toggleToken(token)}
                                        className={cn(
                                            "px-2 py-1 rounded-full border text-xs transition-colors",
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
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                aria-pressed={includeCompleted}
                                onClick={() => setIncludeCompleted((prev) => !prev)}
                                className={cn(
                                    "px-2 py-1 rounded-full border text-xs transition-colors",
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
                                    "px-2 py-1 rounded-full border text-xs transition-colors",
                                    includeReference
                                        ? "bg-primary/15 text-primary border-primary/40"
                                        : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"
                                )}
                            >
                                {includeReferenceText}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setSelectedStatuses([]);
                                    setSelectedArea('all');
                                    setSelectedTokens([]);
                                    setDuePreset('any');
                                    setScope('all');
                                    setIncludeCompleted(false);
                                    setIncludeReference(true);
                                }}
                                className="text-xs text-muted-foreground hover:text-foreground"
                            >
                                Clear filters
                            </button>
                        </div>
                    </div>
                )}

                <div ref={resultsRef} className="max-h-[60vh] overflow-y-auto p-2">
                    {isTruncated && (
                        <div className="px-3 pb-2 text-xs text-muted-foreground">
                            {t('search.showingFirst')
                                .replace('{shown}', String(results.length))
                                .replace('{total}', String(totalResults))}
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
                    {!ftsLoading && results.length === 0 && trimmedQuery !== '' && (
                        <div className="text-center py-8 text-muted-foreground text-sm">
                            {t('search.noResults')} "{trimmedQuery}"
                        </div>
                    )}

                    {!ftsLoading && results.length === 0 && trimmedQuery === '' && (
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
                                <FileText className="w-4 h-4 text-blue-500" />
                            ) : (
                                <CheckCircle className={cn("w-4 h-4", (result.item as SearchTaskResult).status === 'done' ? "text-green-500" : "text-gray-400")} />
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

            {/* Click backdrop to close */}
            <button
                type="button"
                className="absolute inset-0 -z-10"
                aria-label={t('common.close')}
                onClick={() => setIsOpen(false)}
            />
        </div>
    );
}
