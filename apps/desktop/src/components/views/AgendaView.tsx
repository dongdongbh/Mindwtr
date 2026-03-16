import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ErrorBoundary } from '../ErrorBoundary';
import { shallow, useTaskStore, TaskPriority, TimeEstimate, getUsedTaskTokens, matchesHierarchicalToken, safeFormatDate, safeParseDate, safeParseDueDate, isDueForReview, isTaskInActiveProject } from '@mindwtr/core';
import type { Task, Project } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { cn } from '../../lib/utils';
import { useUiStore } from '../../store/ui-store';
import { Clock, Star, Calendar, ArrowRight, Filter, Folder, List, ChevronDown, type LucideIcon } from 'lucide-react';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { TaskItem } from '../TaskItem';
import { projectMatchesAreaFilter, resolveAreaFilter, taskMatchesAreaFilter } from '../../lib/area-filter';
import { PomodoroPanel } from './PomodoroPanel';
import { groupTasksByArea, groupTasksByContext, type NextGroupBy, type TaskGroup } from './list/next-grouping';

const AGENDA_VIRTUALIZATION_THRESHOLD = 25;

function AgendaTaskList({
    tasks,
    projectMap,
    buildFocusToggle,
    showListDetails,
    highlightTaskId,
}: {
    tasks: Task[];
    projectMap: Map<string, Project>;
    buildFocusToggle: (task: Task) => {
        isFocused: boolean;
        canToggle: boolean;
        onToggle: () => void;
        title: string;
        ariaLabel: string;
        alwaysVisible?: boolean;
    };
    showListDetails: boolean;
    highlightTaskId: string | null;
}) {
    const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);
    const shouldVirtualize = !highlightTaskId && tasks.length > AGENDA_VIRTUALIZATION_THRESHOLD;
    const rowVirtualizer = useWindowVirtualizer({
        count: shouldVirtualize ? tasks.length : 0,
        estimateSize: () => (showListDetails ? 96 : 82),
        overscan: 4,
        scrollMargin,
    });

    useEffect(() => {
        if (!containerElement || typeof window === 'undefined') return;
        const updateScrollMargin = () => {
            const rect = containerElement.getBoundingClientRect();
            setScrollMargin(rect.top + window.scrollY);
        };
        updateScrollMargin();
        window.requestAnimationFrame(updateScrollMargin);
        window.addEventListener('resize', updateScrollMargin);
        return () => window.removeEventListener('resize', updateScrollMargin);
    }, [containerElement, tasks.length, showListDetails]);

    if (!shouldVirtualize) {
        return (
            <div className="divide-y divide-border/30">
                {tasks.map((task) => (
                    <TaskItem
                        key={task.id}
                        task={task}
                        project={task.projectId ? projectMap.get(task.projectId) : undefined}
                        focusToggle={buildFocusToggle(task)}
                        showProjectBadgeInActions={false}
                        compactMetaEnabled={showListDetails}
                        enableDoubleClickEdit
                    />
                ))}
            </div>
        );
    }

    const virtualRows = rowVirtualizer.getVirtualItems();
        return (
            <div
                ref={setContainerElement}
                className="relative"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
            {virtualRows.map((virtualRow) => {
                const task = tasks[virtualRow.index];
                if (!task) return null;
                const isLast = virtualRow.index === tasks.length - 1;
                return (
                    <div
                        key={virtualRow.key}
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        className={cn(!isLast && 'border-b border-border/30')}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                        }}
                    >
                        <TaskItem
                            task={task}
                            project={task.projectId ? projectMap.get(task.projectId) : undefined}
                            focusToggle={buildFocusToggle(task)}
                            showProjectBadgeInActions={false}
                            compactMetaEnabled={showListDetails}
                            enableDoubleClickEdit
                        />
                    </div>
                );
            })}
        </div>
    );
}

export function AgendaView() {
    const perf = usePerformanceMonitor('AgendaView');
    const { tasks, projects, areas, updateTask, settings, highlightTaskId, setHighlightTask } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            projects: state.projects,
            areas: state.areas,
            updateTask: state.updateTask,
            settings: state.settings,
            highlightTaskId: state.highlightTaskId,
            setHighlightTask: state.setHighlightTask,
        }),
        shallow
    );
    const getDerivedState = useTaskStore((state) => state.getDerivedState);
    const { projectMap, sequentialProjectIds } = getDerivedState();
    const { t } = useLanguage();
    const { showListDetails, nextGroupBy, setListOptions } = useUiStore((state) => ({
        showListDetails: state.listOptions.showDetails,
        nextGroupBy: state.listOptions.nextGroupBy,
        setListOptions: state.setListOptions,
    }));
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
    const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [top3Only, setTop3Only] = useState(false);
    const prioritiesEnabled = settings?.features?.priorities === true;
    const timeEstimatesEnabled = settings?.features?.timeEstimates === true;
    const pomodoroEnabled = settings?.features?.pomodoro === true;
    const activePriorities = prioritiesEnabled ? selectedPriorities : [];
    const activeTimeEstimates = timeEstimatesEnabled ? selectedTimeEstimates : [];
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('AgendaView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    // Filter active tasks
    const { activeTasks, allTokens } = useMemo(() => {
        const active = tasks.filter(t =>
            !t.deletedAt
            && t.status !== 'done'
            && t.status !== 'reference'
            && isTaskInActiveProject(t, projectMap)
            && taskMatchesAreaFilter(t, resolvedAreaFilter, projectMap, areaById)
        );
        return {
            activeTasks: active,
            allTokens: getUsedTaskTokens(active, (task) => [...(task.contexts || []), ...(task.tags || [])]),
        };
    }, [tasks, projectMap, resolvedAreaFilter, areaById]);
    const priorityOptions: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
    const timeEstimateOptions: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const formatEstimate = (estimate: TimeEstimate) => {
        if (estimate.endsWith('min')) return estimate.replace('min', 'm');
        if (estimate.endsWith('hr+')) return estimate.replace('hr+', 'h+');
        if (estimate.endsWith('hr')) return estimate.replace('hr', 'h');
        return estimate;
    };
    const matchesFilters = useCallback((task: Task) => {
        const taskTokens = [...(task.contexts || []), ...(task.tags || [])];
        if (selectedTokens.length > 0) {
            const matchesAll = selectedTokens.every((token) =>
                taskTokens.some((taskToken) => matchesHierarchicalToken(token, taskToken))
            );
            if (!matchesAll) return false;
        }
        if (activePriorities.length > 0 && (!task.priority || !activePriorities.includes(task.priority))) return false;
        if (activeTimeEstimates.length > 0 && (!task.timeEstimate || !activeTimeEstimates.includes(task.timeEstimate))) return false;
        return true;
    }, [selectedTokens, activePriorities, activeTimeEstimates]);
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const matchesSearchQuery = useCallback((title: string) => {
        if (!normalizedSearchQuery) return true;
        return title.toLowerCase().includes(normalizedSearchQuery);
    }, [normalizedSearchQuery]);
    const resolveText = useCallback((key: string, fallback: string) => {
        const value = t(key);
        return value === key ? fallback : value;
    }, [t]);

    const { filteredActiveTasks, reviewDueCandidates } = useMemo(() => {
        const now = new Date();
        const filtered = activeTasks.filter((task) =>
            matchesFilters(task)
            && matchesSearchQuery(task.title)
        );
        const reviewDue = tasks
            .filter((task) => {
                if (task.deletedAt) return false;
                if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return false;
                if (!isDueForReview(task.reviewAt, now)) return false;
                if (task.projectId) {
                    const project = projectMap.get(task.projectId);
                    if (project?.deletedAt) return false;
                    if (project?.status === 'archived') return false;
                }
                if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)) return false;
                if (!matchesSearchQuery(task.title)) return false;
                return true;
            })
            .filter(matchesFilters);
        return { filteredActiveTasks: filtered, reviewDueCandidates: reviewDue };
    }, [activeTasks, tasks, projectMap, matchesFilters, matchesSearchQuery, resolvedAreaFilter, areaById]);

    const reviewDueProjects = useMemo(() => {
        const now = new Date();
        return projects
            .filter((project) => {
                if (project.deletedAt) return false;
                if (project.status === 'archived') return false;
                if (!projectMatchesAreaFilter(project, resolvedAreaFilter, areaById)) return false;
                if (!matchesSearchQuery(project.title)) return false;
                return isDueForReview(project.reviewAt, now);
            })
            .sort((a, b) => {
                const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
                const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
                if (aReview !== bReview) return aReview - bReview;
                return a.title.localeCompare(b.title);
            });
    }, [projects, matchesSearchQuery, resolvedAreaFilter, areaById]);
    const hasFilters = selectedTokens.length > 0 || activePriorities.length > 0 || activeTimeEstimates.length > 0;
    const hasTaskFilters = hasFilters || Boolean(normalizedSearchQuery);
    const showFiltersPanel = filtersOpen || hasFilters;
    const toggleTokenFilter = (token: string) => {
        setSelectedTokens((prev) =>
            prev.includes(token) ? prev.filter((item) => item !== token) : [...prev, token]
        );
    };
    const togglePriorityFilter = (priority: TaskPriority) => {
        setSelectedPriorities((prev) =>
            prev.includes(priority) ? prev.filter((item) => item !== priority) : [...prev, priority]
        );
    };
    const toggleTimeFilter = (estimate: TimeEstimate) => {
        setSelectedTimeEstimates((prev) =>
            prev.includes(estimate) ? prev.filter((item) => item !== estimate) : [...prev, estimate]
        );
    };
    const clearFilters = () => {
        setSelectedTokens([]);
        setSelectedPriorities([]);
        setSelectedTimeEstimates([]);
    };
    useEffect(() => {
        if (!prioritiesEnabled && selectedPriorities.length > 0) {
            setSelectedPriorities([]);
        }
        if (!timeEstimatesEnabled && selectedTimeEstimates.length > 0) {
            setSelectedTimeEstimates([]);
        }
    }, [prioritiesEnabled, timeEstimatesEnabled, selectedPriorities.length, selectedTimeEstimates.length]);

    useEffect(() => {
        if (!highlightTaskId) return;
        const el = document.querySelector(`[data-task-id="${highlightTaskId}"]`) as HTMLElement | null;
        if (el && typeof (el as any).scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center' });
        }
        const timer = window.setTimeout(() => setHighlightTask(null), 4000);
        return () => window.clearTimeout(timer);
    }, [highlightTaskId, setHighlightTask]);
    // Today's Focus: tasks marked as isFocusedToday (max 3)
    const focusedTasks = useMemo(() =>
        filteredActiveTasks.filter(t => t.isFocusedToday).slice(0, 3),
        [filteredActiveTasks]
    );

    const projectOrderMap = useMemo(() => {
        const sorted = [...projects]
            .filter((project) => !project.deletedAt)
            .sort((a, b) => {
                const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
                const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.title.localeCompare(b.title);
            });
        const map = new Map<string, number>();
        sorted.forEach((project, index) => map.set(project.id, index));
        return map;
    }, [projects]);

    const sortByProjectOrder = useCallback((items: Task[]) => {
        return [...items].sort((a, b) => {
            const aProjectOrder = a.projectId ? (projectOrderMap.get(a.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            const bProjectOrder = b.projectId ? (projectOrderMap.get(b.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            if (aProjectOrder !== bProjectOrder) return aProjectOrder - bProjectOrder;
            const aOrder = Number.isFinite(a.order)
                ? (a.order as number)
                : Number.isFinite(a.orderNum)
                    ? (a.orderNum as number)
                    : Number.POSITIVE_INFINITY;
            const bOrder = Number.isFinite(b.order)
                ? (b.order as number)
                : Number.isFinite(b.orderNum)
                    ? (b.orderNum as number)
                    : Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) return aOrder - bOrder;
            const aCreated = safeParseDate(a.createdAt)?.getTime() ?? 0;
            const bCreated = safeParseDate(b.createdAt)?.getTime() ?? 0;
            return aCreated - bCreated;
        });
    }, [projectOrderMap]);

    // Categorize tasks
    const sections = useMemo(() => {
        const now = new Date();
        const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        const isDeferred = (task: Task) => {
            const start = safeParseDate(task.startTime);
            return Boolean(start && start > endOfToday);
        };
        const priorityRank: Record<TaskPriority, number> = {
            low: 1,
            medium: 2,
            high: 3,
            urgent: 4,
        };
        const sortWith = (items: Task[], getTime: (task: Task) => number) => {
            return [...items].sort((a, b) => {
                const timeDiff = getTime(a) - getTime(b);
                if (timeDiff !== 0) return timeDiff;
                if (prioritiesEnabled) {
                    const priorityDiff = (priorityRank[b.priority as TaskPriority] || 0) - (priorityRank[a.priority as TaskPriority] || 0);
                    if (priorityDiff !== 0) return priorityDiff;
                }
                const aCreated = safeParseDate(a.createdAt)?.getTime() ?? 0;
                const bCreated = safeParseDate(b.createdAt)?.getTime() ?? 0;
                return aCreated - bCreated;
            });
        };
        const tasksByProject = new Map<string, Task[]>();
        for (const task of filteredActiveTasks) {
            if (task.deletedAt || !task.projectId) continue;
            if (!sequentialProjectIds.has(task.projectId)) continue;
            const list = tasksByProject.get(task.projectId) ?? [];
            list.push(task);
            tasksByProject.set(task.projectId, list);
        }
        const sequentialFirstTasks = new Set<string>();
        tasksByProject.forEach((tasksForProject: Task[]) => {
            const hasOrder = tasksForProject.some((task) => Number.isFinite(task.order) || Number.isFinite(task.orderNum));
            let firstTaskId: string | null = null;
            let bestKey = Number.POSITIVE_INFINITY;
            tasksForProject.forEach((task) => {
                const taskOrder = Number.isFinite(task.order)
                    ? (task.order as number)
                    : Number.isFinite(task.orderNum)
                        ? (task.orderNum as number)
                        : Number.POSITIVE_INFINITY;
                const key = hasOrder
                    ? taskOrder
                    : new Date(task.createdAt).getTime();
                if (!firstTaskId || key < bestKey) {
                    firstTaskId = task.id;
                    bestKey = key;
                }
            });
            if (firstTaskId) sequentialFirstTasks.add(firstTaskId);
        });
        const isSequentialBlocked = (task: Task) => {
            if (!task.projectId) return false;
            if (!sequentialProjectIds.has(task.projectId)) return false;
            return !sequentialFirstTasks.has(task.id);
        };
        const schedule = filteredActiveTasks.filter((task) => {
            if (task.isFocusedToday) return false;
            if (isSequentialBlocked(task)) return false;
            const dueDate = safeParseDueDate(task.dueDate);
            const startDate = safeParseDate(task.startTime);
            const startReady = !startDate || startDate <= endOfToday;
            return Boolean(startReady && dueDate && dueDate <= endOfToday)
                || Boolean(startReady && startDate && startDate <= endOfToday);
        });
        const scheduleIds = new Set(schedule.map((task) => task.id));
        const nextActions = filteredActiveTasks.filter((task) => {
            if (task.status !== 'next' || task.isFocusedToday) return false;
            if (isDeferred(task)) return false;
            if (isSequentialBlocked(task)) return false;
            return !scheduleIds.has(task.id);
        });
        const reviewDue = reviewDueCandidates.filter(t => !t.isFocusedToday);
        const scheduleSortTime = (task: Task) => {
            const due = safeParseDueDate(task.dueDate)?.getTime();
            const start = safeParseDate(task.startTime)?.getTime();
            if (typeof due === 'number' && typeof start === 'number') return Math.min(due, start);
            if (typeof due === 'number') return due;
            if (typeof start === 'number') return start;
            return Number.POSITIVE_INFINITY;
        };

        return {
            schedule: sortWith(schedule, scheduleSortTime),
            nextActions: sortByProjectOrder(nextActions),
            reviewDue: sortWith(reviewDue, (task) => safeParseDate(task.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY),
        };
    }, [filteredActiveTasks, reviewDueCandidates, prioritiesEnabled, sortByProjectOrder, sequentialProjectIds]);
    const nextActionGroups = useMemo(() => {
        if (nextGroupBy === 'none') return [] as TaskGroup[];
        if (nextGroupBy === 'area') {
            return groupTasksByArea({
                areas,
                tasks: sections.nextActions,
                projectMap,
                generalLabel: resolveText('settings.general', 'General'),
            });
        }
        return groupTasksByContext({
            tasks: sections.nextActions,
            noContextLabel: resolveText('contexts.none', 'No context'),
        });
    }, [areas, nextGroupBy, projectMap, resolveText, sections.nextActions]);
    const focusedCount = focusedTasks.length;
    const { top3Tasks, remainingCount } = useMemo(() => {
        const byId = new Map<string, Task>();
        [...sections.schedule, ...sections.nextActions, ...sections.reviewDue].forEach((task) => {
            byId.set(task.id, task);
        });
        const candidates = Array.from(byId.values());
        const priorityRank: Record<TaskPriority, number> = {
            low: 1,
            medium: 2,
            high: 3,
            urgent: 4,
        };
        const parseDue = (value?: string) => {
            if (!value) return Number.POSITIVE_INFINITY;
            const parsed = safeParseDueDate(value);
            return parsed ? parsed.getTime() : Number.POSITIVE_INFINITY;
        };
        const sorted = [...candidates].sort((a, b) => {
            if (prioritiesEnabled) {
                const priorityDiff = (priorityRank[b.priority as TaskPriority] || 0) - (priorityRank[a.priority as TaskPriority] || 0);
                if (priorityDiff !== 0) return priorityDiff;
            }
            const dueDiff = parseDue(a.dueDate) - parseDue(b.dueDate);
            if (dueDiff !== 0) return dueDiff;
            const aCreated = safeParseDate(a.createdAt)?.getTime() ?? 0;
            const bCreated = safeParseDate(b.createdAt)?.getTime() ?? 0;
            return aCreated - bCreated;
        });
        const top3 = sorted.slice(0, 3);
        return {
            top3Tasks: top3,
            remainingCount: Math.max(candidates.length - top3.length, 0),
        };
    }, [sections, prioritiesEnabled]);

    const handleToggleFocus = (taskId: string) => {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        if (task.isFocusedToday) {
            updateTask(taskId, { isFocusedToday: false });
        } else if (focusedCount < 3) {
            updateTask(taskId, {
                isFocusedToday: true,
                ...(task.status !== 'next' ? { status: 'next' as const } : {}),
            });
        }
    };

    const buildFocusToggle = useCallback((task: Task) => {
        const isFocused = Boolean(task.isFocusedToday);
        const canToggle = isFocused || focusedCount < 3;
        const title = isFocused
            ? t('agenda.removeFromFocus')
            : focusedCount >= 3
                ? t('agenda.maxFocusItems')
                : t('agenda.addToFocus');
        return {
            isFocused,
            canToggle,
            onToggle: () => handleToggleFocus(task.id),
            title,
            ariaLabel: title,
            alwaysVisible: true,
        };
    }, [focusedCount, handleToggleFocus, t]);

    const Section = ({ title, icon: Icon, tasks, color }: {
        title: string;
        icon: LucideIcon;
        tasks: Task[];
        color: string;
    }) => {
        if (tasks.length === 0) return null;

        return (
            <div className="space-y-3">
                <h3 className={cn("font-semibold flex items-center gap-2", color)}>
                    <Icon className="w-5 h-5" />
                    {title}
                    <span className="text-muted-foreground font-normal">({tasks.length})</span>
                </h3>
                <AgendaTaskList
                    tasks={tasks}
                    projectMap={projectMap}
                    buildFocusToggle={buildFocusToggle}
                    showListDetails={showListDetails}
                    highlightTaskId={highlightTaskId}
                />
            </div>
        );
    };

    const ProjectSection = ({ title, icon: Icon, projects, color }: {
        title: string;
        icon: LucideIcon;
        projects: Project[];
        color: string;
    }) => {
        if (projects.length === 0) return null;

        return (
            <div className="space-y-3">
                <h3 className={cn("font-semibold flex items-center gap-2", color)}>
                    <Icon className="w-5 h-5" />
                    {title}
                    <span className="text-muted-foreground font-normal">({projects.length})</span>
                </h3>
                <div className="space-y-2">
                    {projects.map((project) => (
                        <div
                            key={project.id}
                            className="flex items-center justify-between rounded-lg border border-border bg-card/80 px-3 py-2"
                        >
                            <div className="flex items-center gap-2">
                                <Folder className="w-4 h-4" style={{ color: project.color }} />
                                <span className="text-sm font-medium text-foreground">{project.title}</span>
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                                    {t(`status.${project.status}`)}
                                </span>
                            </div>
                            {project.reviewAt && (
                                <span className="text-xs text-muted-foreground">
                                    {safeFormatDate(project.reviewAt, 'P')}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    const visibleActive = filteredActiveTasks.length;
    const nextActionsCount = sections.nextActions.length;
    const pomodoroTasks = useMemo(() => {
        const ordered = [
            ...focusedTasks,
            ...sections.schedule,
            ...sections.nextActions,
            ...sections.reviewDue,
        ];
        const byId = new Map<string, Task>();
        ordered.forEach((task) => {
            if (task.deletedAt) return;
            byId.set(task.id, task);
        });
        return Array.from(byId.values());
    }, [focusedTasks, sections]);

    return (
        <ErrorBoundary>
            <div className="space-y-6 w-full">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                        <Calendar className="w-8 h-8" />
                        {t('agenda.title')}
                    </h2>
                    <p className="text-muted-foreground">
                        {nextActionsCount} {t('list.next') || t('agenda.nextActions')}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setTop3Only((prev) => !prev)}
                        className={cn(
                            "inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border transition-colors",
                            top3Only
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
                        )}
                    >
                        {t('agenda.top3Only')}
                    </button>
                    <button
                        type="button"
                        onClick={() => setListOptions({ showDetails: !showListDetails })}
                        aria-pressed={showListDetails}
                        className={cn(
                            "text-xs px-3 py-1.5 rounded-full border transition-colors inline-flex items-center gap-1.5",
                            showListDetails
                                ? "bg-primary/10 text-primary border-primary"
                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                        )}
                        title={showListDetails ? (t('list.details') || 'Details on') : (t('list.detailsOff') || 'Details off')}
                    >
                        <List className="w-3.5 h-3.5" />
                        {showListDetails ? (t('list.details') || 'Details') : (t('list.detailsOff') || 'Details off')}
                    </button>
                    <div className="relative">
                        <select
                            value={nextGroupBy}
                            onChange={(event) => setListOptions({ nextGroupBy: event.target.value as NextGroupBy })}
                            aria-label={resolveText('list.groupBy', 'Group')}
                            className={cn(
                                "min-w-[136px] appearance-none text-xs leading-none rounded-full border pl-3 pr-8 py-1.5 transition-colors",
                                "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                                "focus:outline-none focus:ring-2 focus:ring-primary/40"
                            )}
                        >
                            <option value="none">{resolveText('list.groupByNone', 'No grouping')}</option>
                            <option value="context">{resolveText('list.groupByContext', 'Context')}</option>
                            <option value="area">{resolveText('list.groupByArea', 'Area')}</option>
                        </select>
                        <ChevronDown
                            className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                    </div>
                </div>
            </header>

            {pomodoroEnabled && <PomodoroPanel tasks={pomodoroTasks} />}

            <div className="bg-card border border-border rounded-lg p-3 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                        <Filter className="w-4 h-4" />
                        {t('filters.label')}
                    </div>
                    <div className="flex items-center gap-2">
                        {hasFilters && (
                            <button
                                type="button"
                                onClick={clearFilters}
                                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                                {t('filters.clear')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setFiltersOpen((prev) => !prev)}
                            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                            {showFiltersPanel ? t('filters.hide') : t('filters.show')}
                        </button>
                    </div>
                </div>
                <input
                    type="text"
                    data-view-filter-input
                    placeholder={t('common.search')}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                {showFiltersPanel && (
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('filters.contexts')}</div>
                            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                                {allTokens.map((token) => {
                                    const isActive = selectedTokens.includes(token);
                                    return (
                                        <button
                                            key={token}
                                            type="button"
                                            onClick={() => toggleTokenFilter(token)}
                                            aria-pressed={isActive}
                                            className={cn(
                                                "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                                                isActive
                                                    ? "bg-primary text-primary-foreground"
                                                    : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                            )}
                                        >
                                            {token}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        {prioritiesEnabled && (
                            <div className="space-y-2">
                                <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('filters.priority')}</div>
                                <div className="flex flex-wrap gap-2">
                                    {priorityOptions.map((priority) => {
                                        const isActive = selectedPriorities.includes(priority);
                                        return (
                                            <button
                                                key={priority}
                                                type="button"
                                                onClick={() => togglePriorityFilter(priority)}
                                                aria-pressed={isActive}
                                                className={cn(
                                                    "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                                                    isActive
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                                )}
                                            >
                                                {t(`priority.${priority}`)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {timeEstimatesEnabled && (
                            <div className="space-y-2">
                                <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('filters.timeEstimate')}</div>
                                <div className="flex flex-wrap gap-2">
                                    {timeEstimateOptions.map((estimate) => {
                                        const isActive = selectedTimeEstimates.includes(estimate);
                                        return (
                                            <button
                                                key={estimate}
                                                type="button"
                                                onClick={() => toggleTimeFilter(estimate)}
                                                aria-pressed={isActive}
                                                className={cn(
                                                    "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                                                    isActive
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                                )}
                                            >
                                                {formatEstimate(estimate)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {top3Only ? (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <h3 className="font-semibold">{t('agenda.top3Title')}</h3>
                        {top3Tasks.length > 0 ? (
                            <div className="divide-y divide-border/30">
                                {top3Tasks.map(task => (
                                    <TaskItem
                                        key={task.id}
                                        task={task}
                                        project={task.projectId ? projectMap.get(task.projectId) : undefined}
                                        showProjectBadgeInActions={false}
                                        compactMetaEnabled={showListDetails}
                                        enableDoubleClickEdit
                                    />
                                ))}
                            </div>
                        ) : (
                            <p className="text-muted-foreground text-sm">{t('agenda.noTasks')}</p>
                        )}
                    </div>
                    {remainingCount > 0 && (
                        <button
                            type="button"
                            onClick={() => setTop3Only(false)}
                            className="text-xs px-3 py-2 rounded bg-muted/50 text-muted-foreground hover:bg-muted transition-colors"
                        >
                            {t('agenda.showMore').replace('{{count}}', `${remainingCount}`)}
                        </button>
                    )}
                </div>
            ) : (
                <>
                    {focusedTasks.length > 0 && (
                        <div className="bg-gradient-to-r from-yellow-50 to-orange-50 dark:from-yellow-900/40 dark:to-amber-900/25 border border-yellow-200 dark:border-amber-500/30 rounded-xl p-6">
                            <h3 className="font-bold text-lg flex items-center gap-2 mb-4 text-slate-900 dark:text-amber-100">
                                <Star className="w-5 h-5 text-yellow-500 fill-yellow-500 dark:text-amber-300 dark:fill-amber-300" />
                                {t('agenda.todaysFocus')}
                                <span className="text-sm font-normal text-slate-600 dark:text-amber-200">
                                    ({focusedCount}/3)
                                </span>
                            </h3>

                            <div className="divide-y divide-border/30">
                                {focusedTasks.map(task => (
                                    <TaskItem
                                        key={task.id}
                                        task={task}
                                        project={task.projectId ? projectMap.get(task.projectId) : undefined}
                                        focusToggle={buildFocusToggle(task)}
                                        showProjectBadgeInActions={false}
                                        compactMetaEnabled={showListDetails}
                                        enableDoubleClickEdit
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Other Sections */}
                    <div className="space-y-6">
                        <Section
                            title={t('focus.schedule') || t('agenda.dueToday')}
                            icon={Calendar}
                            tasks={sections.schedule}
                            color="text-yellow-600"
                        />

                        {nextGroupBy === 'none' ? (
                            <Section
                                title={t('agenda.nextActions')}
                                icon={ArrowRight}
                                tasks={sections.nextActions}
                                color="text-blue-600"
                            />
                        ) : (
                            <div className="space-y-3">
                                <h3 className="font-semibold flex items-center gap-2 text-blue-600">
                                    <ArrowRight className="w-5 h-5" />
                                    {t('agenda.nextActions')}
                                    <span className="text-muted-foreground font-normal">({sections.nextActions.length})</span>
                                </h3>
                                <div className="space-y-2">
                                    {nextActionGroups.map((group) => (
                                        <div key={group.id} className="rounded-md border border-border/40 bg-card/30">
                                            <div className={cn(
                                                'px-3 py-2 text-xs font-semibold uppercase tracking-wide border-b border-border/30',
                                                group.muted ? 'text-muted-foreground' : 'text-foreground/90',
                                            )}>
                                                <span className="inline-flex items-center gap-1.5">
                                                    {group.dotColor && (
                                                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: group.dotColor }} aria-hidden="true" />
                                                    )}
                                                    <span>{group.title}</span>
                                                </span>
                                                <span className="ml-2 text-muted-foreground">{group.tasks.length}</span>
                                            </div>
                                            <AgendaTaskList
                                                tasks={group.tasks}
                                                projectMap={projectMap}
                                                buildFocusToggle={buildFocusToggle}
                                                showListDetails={showListDetails}
                                                highlightTaskId={highlightTaskId}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <Section
                            title={t('agenda.reviewDue') || 'Review Due'}
                            icon={Clock}
                            tasks={sections.reviewDue}
                            color="text-purple-600"
                        />

                        <ProjectSection
                            title={t('agenda.reviewDueProjects') || 'Projects to review'}
                            icon={Folder}
                            projects={reviewDueProjects}
                            color="text-indigo-600"
                        />
                    </div>
                </>
            )}

            {visibleActive === 0 && (
                <div className="text-center py-12 text-muted-foreground">
                    <p className="text-4xl mb-4">✨</p>
                    <p className="text-lg font-medium">{t('agenda.allClear')}</p>
                    <p>{hasTaskFilters ? t('filters.noMatch') : t('agenda.noTasks')}</p>
                </div>
            )}
            </div>
        </ErrorBoundary>
    );
}
