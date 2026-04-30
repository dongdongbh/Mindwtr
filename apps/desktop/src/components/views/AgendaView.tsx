import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ErrorBoundary } from '../ErrorBoundary';
import { shallow, useTaskStore, TaskPriority, TimeEstimate, getUsedTaskTokens, matchesHierarchicalToken, safeParseDate, safeParseDueDate, isDueForReview, isTaskInActiveProject, sortFocusNextActions, translateWithFallback } from '@mindwtr/core';
import type { Task, TaskEnergyLevel } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { cn } from '../../lib/utils';
import { useUiStore } from '../../store/ui-store';
import { Clock, Star, ArrowRight, Folder, CheckCircle2 } from 'lucide-react';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { projectMatchesAreaFilter, resolveAreaFilter, taskMatchesAreaFilter } from '../../lib/area-filter';
import { PomodoroPanel } from './PomodoroPanel';
import { AgendaFiltersPanel, type AgendaActiveFilterChip, type AgendaProjectFilterOption } from './agenda/AgendaFiltersPanel';
import { AgendaHeader } from './agenda/AgendaHeader';
import { AgendaCollapsibleSection, AgendaProjectSection } from './agenda/AgendaSections';
import { StoreTaskItem } from './list/StoreTaskItem';
import { groupTasksByArea, groupTasksByContext, groupTasksByProject, type TaskGroup } from './list/next-grouping';

const AGENDA_VIRTUALIZATION_THRESHOLD = 25;
const NO_PROJECT_FILTER_ID = '__no_project__';

function getAgendaScrollElement(containerElement: HTMLDivElement | null): HTMLElement | null {
    if (containerElement) {
        const closestMainContent = containerElement.closest<HTMLElement>('[data-main-content]');
        if (closestMainContent) return closestMainContent;
    }
    if (typeof document === 'undefined') return null;
    return document.querySelector<HTMLElement>('[data-main-content]');
}

function getAgendaScrollMargin(containerElement: HTMLDivElement, scrollElement: HTMLElement) {
    const containerRect = containerElement.getBoundingClientRect();
    const scrollRect = scrollElement.getBoundingClientRect();
    return containerRect.top - scrollRect.top + scrollElement.scrollTop;
}

function AgendaTaskList({
    tasks,
    buildFocusToggle,
    showListDetails,
    highlightTaskId,
}: {
    tasks: Task[];
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
    // Desktop views scroll inside the shared main content pane, not the window.
    const scrollElement = useMemo(
        () => getAgendaScrollElement(containerElement),
        [containerElement]
    );
    const shouldVirtualize = Boolean(scrollElement) && !highlightTaskId && tasks.length > AGENDA_VIRTUALIZATION_THRESHOLD;
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? tasks.length : 0,
        getScrollElement: () => scrollElement,
        estimateSize: () => (showListDetails ? 96 : 82),
        overscan: 4,
        scrollMargin,
        getItemKey: (index) => tasks[index]?.id ?? index,
    });

    const updateScrollMargin = useCallback(() => {
        if (!containerElement || !scrollElement) return;
        const nextScrollMargin = getAgendaScrollMargin(containerElement, scrollElement);
        setScrollMargin((current) => (Math.abs(current - nextScrollMargin) < 1 ? current : nextScrollMargin));
    }, [containerElement, scrollElement]);

    useLayoutEffect(() => {
        updateScrollMargin();
    });

    useEffect(() => {
        if (!containerElement || !scrollElement || typeof window === 'undefined') return;
        window.addEventListener('resize', updateScrollMargin);
        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => updateScrollMargin())
            : null;
        resizeObserver?.observe(containerElement);
        resizeObserver?.observe(scrollElement);
        return () => {
            window.removeEventListener('resize', updateScrollMargin);
            resizeObserver?.disconnect();
        };
    }, [containerElement, scrollElement, updateScrollMargin]);

    if (!shouldVirtualize) {
        return (
            <div className="divide-y divide-border/30">
                {tasks.map((task) => (
                    <StoreTaskItem
                        key={task.id}
                        taskId={task.id}
                        buildFocusToggle={buildFocusToggle}
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
                        <StoreTaskItem
                            taskId={task.id}
                            buildFocusToggle={buildFocusToggle}
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
    const { showListDetails, nextGroupBy, setListOptions, collapseAllTaskDetails } = useUiStore((state) => ({
        showListDetails: state.listOptions.showDetails,
        nextGroupBy: state.listOptions.nextGroupBy,
        setListOptions: state.setListOptions,
        collapseAllTaskDetails: state.collapseAllTaskDetails,
    }));
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
    const [selectedEnergyLevels, setSelectedEnergyLevels] = useState<TaskEnergyLevel[]>([]);
    const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
    const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [top3Only, setTop3Only] = useState(false);
    const [expandedSections, setExpandedSections] = useState({
        schedule: true,
        nextActions: true,
        reviewDue: true,
    });
    const prioritiesEnabled = settings?.features?.priorities !== false;
    const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
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
    const energyLevelOptions: TaskEnergyLevel[] = ['low', 'medium', 'high'];
    const timeEstimateOptions: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const projectOptions = useMemo<AgendaProjectFilterOption[]>(() => {
        const activeProjectIds = new Set(
            activeTasks
                .map((task) => task.projectId)
                .filter((projectId): projectId is string => Boolean(projectId))
        );
        return [...projects]
            .filter((project) => !project.deletedAt && project.status !== 'archived' && activeProjectIds.has(project.id))
            .sort((a, b) => {
                const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
                const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.title.localeCompare(b.title);
            })
            .map((project) => ({
                id: project.id,
                title: project.title,
                dotColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || project.color || undefined,
            }));
    }, [activeTasks, areaById, projects]);
    const showNoProjectOption = useMemo(
        () => activeTasks.some((task) => !task.projectId),
        [activeTasks]
    );
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
        if (selectedProjects.length > 0) {
            const matchesProject = selectedProjects.some((selectedProjectId) => (
                selectedProjectId === NO_PROJECT_FILTER_ID
                    ? !task.projectId
                    : task.projectId === selectedProjectId
            ));
            if (!matchesProject) return false;
        }
        if (activePriorities.length > 0 && (!task.priority || !activePriorities.includes(task.priority))) return false;
        if (selectedEnergyLevels.length > 0 && (!task.energyLevel || !selectedEnergyLevels.includes(task.energyLevel))) return false;
        if (activeTimeEstimates.length > 0 && (!task.timeEstimate || !activeTimeEstimates.includes(task.timeEstimate))) return false;
        return true;
    }, [selectedProjects, selectedTokens, activePriorities, selectedEnergyLevels, activeTimeEstimates]);
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const matchesSearchQuery = useCallback((title: string) => {
        if (!normalizedSearchQuery) return true;
        return title.toLowerCase().includes(normalizedSearchQuery);
    }, [normalizedSearchQuery]);
    const resolveText = useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);
    const activeFilterChips = useMemo<AgendaActiveFilterChip[]>(() => {
        const chips: AgendaActiveFilterChip[] = [];
        selectedTokens.forEach((token) => {
            chips.push({
                id: `token:${token}`,
                label: token,
            });
        });
        selectedProjects.forEach((projectId) => {
            if (projectId === NO_PROJECT_FILTER_ID) {
                chips.push({
                    id: `project:${projectId}`,
                    label: resolveText('taskEdit.noProjectOption', 'No project'),
                });
                return;
            }
            const project = projectMap.get(projectId);
            if (!project) return;
            chips.push({
                id: `project:${project.id}`,
                label: project.title,
                dotColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || project.color || undefined,
            });
        });
        activePriorities.forEach((priority) => {
            chips.push({
                id: `priority:${priority}`,
                label: t(`priority.${priority}`),
            });
        });
        selectedEnergyLevels.forEach((energyLevel) => {
            chips.push({
                id: `energy:${energyLevel}`,
                label: t(`energyLevel.${energyLevel}`),
            });
        });
        activeTimeEstimates.forEach((estimate) => {
            chips.push({
                id: `time:${estimate}`,
                label: formatEstimate(estimate),
            });
        });
        return chips;
    }, [
        activePriorities,
        activeTimeEstimates,
        areaById,
        formatEstimate,
        projectMap,
        resolveText,
        selectedEnergyLevels,
        selectedProjects,
        selectedTokens,
        t,
    ]);

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
    const hasFilters = (
        selectedTokens.length > 0
        || selectedProjects.length > 0
        || activePriorities.length > 0
        || selectedEnergyLevels.length > 0
        || activeTimeEstimates.length > 0
    );
    const hasTaskFilters = hasFilters || Boolean(normalizedSearchQuery);
    const showFiltersPanel = filtersOpen;
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
    const toggleProjectFilter = (projectId: string) => {
        setSelectedProjects((prev) =>
            prev.includes(projectId) ? prev.filter((item) => item !== projectId) : [...prev, projectId]
        );
    };
    const toggleEnergyFilter = (energyLevel: TaskEnergyLevel) => {
        setSelectedEnergyLevels((prev) =>
            prev.includes(energyLevel) ? prev.filter((item) => item !== energyLevel) : [...prev, energyLevel]
        );
    };
    const toggleTimeFilter = (estimate: TimeEstimate) => {
        setSelectedTimeEstimates((prev) =>
            prev.includes(estimate) ? prev.filter((item) => item !== estimate) : [...prev, estimate]
        );
    };
    const clearFilters = () => {
        setSelectedTokens([]);
        setSelectedProjects([]);
        setSelectedPriorities([]);
        setSelectedEnergyLevels([]);
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

    // Categorize tasks
    const sections = useMemo(() => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
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
            if (task.status !== 'next') return false;
            if (isSequentialBlocked(task)) return false;
            const dueDate = safeParseDueDate(task.dueDate);
            const startDate = safeParseDate(task.startTime);
            const startsToday = Boolean(
                startDate
                && startDate >= startOfToday
                && startDate <= endOfToday
            );
            return Boolean(dueDate && dueDate <= endOfToday)
                || startsToday;
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
            nextActions: sortFocusNextActions(nextActions, {
                now,
                prioritizeByPriority: prioritiesEnabled,
            }),
            reviewDue: sortWith(reviewDue, (task) => safeParseDate(task.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY),
        };
    }, [filteredActiveTasks, reviewDueCandidates, prioritiesEnabled, sequentialProjectIds]);
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
        if (nextGroupBy === 'project') {
            return groupTasksByProject({
                tasks: sections.nextActions,
                projectMap,
                noProjectLabel: resolveText('taskEdit.noProjectOption', 'No project'),
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

    const toggleSection = useCallback((sectionKey: keyof typeof expandedSections) => {
        setExpandedSections((current) => ({
            ...current,
            [sectionKey]: !current[sectionKey],
        }));
    }, []);

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
    const handleToggleDetails = useCallback(() => {
        if (showListDetails) {
            collapseAllTaskDetails();
            setListOptions({ showDetails: false });
            return;
        }
        setListOptions({ showDetails: true });
    }, [collapseAllTaskDetails, setListOptions, showListDetails]);

    return (
        <ErrorBoundary>
            <div className="space-y-6 w-full">
            <AgendaHeader
                nextActionsCount={nextActionsCount}
                nextGroupBy={nextGroupBy}
                onChangeGroupBy={(value) => setListOptions({ nextGroupBy: value })}
                onToggleDetails={handleToggleDetails}
                onToggleTop3={() => setTop3Only((prev) => !prev)}
                resolveText={resolveText}
                showListDetails={showListDetails}
                t={t}
                top3Only={top3Only}
            />

            {pomodoroEnabled && <PomodoroPanel tasks={pomodoroTasks} />}

            <AgendaFiltersPanel
                allTokens={allTokens}
                activeFilterChips={activeFilterChips}
                energyLevelOptions={energyLevelOptions}
                formatEstimate={formatEstimate}
                hasFilters={hasFilters}
                onClearFilters={clearFilters}
                onSearchChange={setSearchQuery}
                onToggleEnergy={toggleEnergyFilter}
                onToggleFiltersOpen={() => setFiltersOpen((prev) => !prev)}
                onToggleProject={toggleProjectFilter}
                onTogglePriority={togglePriorityFilter}
                onToggleTime={toggleTimeFilter}
                onToggleToken={toggleTokenFilter}
                prioritiesEnabled={prioritiesEnabled}
                projectOptions={projectOptions}
                priorityOptions={priorityOptions}
                searchQuery={searchQuery}
                selectedEnergyLevels={selectedEnergyLevels}
                selectedProjects={selectedProjects}
                selectedPriorities={selectedPriorities}
                selectedTimeEstimates={selectedTimeEstimates}
                selectedTokens={selectedTokens}
                showNoProjectOption={showNoProjectOption}
                showFiltersPanel={showFiltersPanel}
                t={t}
                timeEstimateOptions={timeEstimateOptions}
                timeEstimatesEnabled={timeEstimatesEnabled}
            />

            {top3Only ? (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <h3 className="font-semibold">{t('agenda.top3Title')}</h3>
                                {top3Tasks.length > 0 ? (
                            <div className="divide-y divide-border/30">
                                {top3Tasks.map(task => (
                                    <StoreTaskItem
                                        key={task.id}
                                        taskId={task.id}
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
                                    <StoreTaskItem
                                        key={task.id}
                                        taskId={task.id}
                                        buildFocusToggle={buildFocusToggle}
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
                        {sections.schedule.length > 0 && (
                            <AgendaCollapsibleSection
                                title={t('focus.schedule') || t('agenda.dueToday')}
                                icon={Clock}
                                color="text-yellow-600"
                                count={sections.schedule.length}
                                expanded={expandedSections.schedule}
                                onToggle={() => toggleSection('schedule')}
                                controlsId="agenda-section-schedule"
                            >
                                <AgendaTaskList
                                    tasks={sections.schedule}
                                    buildFocusToggle={buildFocusToggle}
                                    showListDetails={showListDetails}
                                    highlightTaskId={highlightTaskId}
                                />
                            </AgendaCollapsibleSection>
                        )}

                        {nextGroupBy === 'none' ? (
                            sections.nextActions.length > 0 && (
                                <AgendaCollapsibleSection
                                    title={t('agenda.nextActions')}
                                    icon={ArrowRight}
                                    color="text-blue-600"
                                    count={sections.nextActions.length}
                                    expanded={expandedSections.nextActions}
                                    onToggle={() => toggleSection('nextActions')}
                                    controlsId="agenda-section-nextActions"
                                >
                                    <AgendaTaskList
                                        tasks={sections.nextActions}
                                        buildFocusToggle={buildFocusToggle}
                                        showListDetails={showListDetails}
                                        highlightTaskId={highlightTaskId}
                                    />
                                </AgendaCollapsibleSection>
                            )
                        ) : (
                            sections.nextActions.length > 0 && (
                                <AgendaCollapsibleSection
                                    title={t('agenda.nextActions')}
                                    icon={ArrowRight}
                                    color="text-blue-600"
                                    count={sections.nextActions.length}
                                    expanded={expandedSections.nextActions}
                                    onToggle={() => toggleSection('nextActions')}
                                    controlsId="agenda-section-nextActions"
                                >
                                    <div className="space-y-2">
                                        {nextActionGroups.map((group) => (
                                            <div key={group.id} className="rounded-md border border-border/40 bg-card/30">
                                                <div className={cn(
                                                    'border-b border-border/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide',
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
                                                    buildFocusToggle={buildFocusToggle}
                                                    showListDetails={showListDetails}
                                                    highlightTaskId={highlightTaskId}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </AgendaCollapsibleSection>
                            )
                        )}

                        {sections.reviewDue.length > 0 && (
                            <AgendaCollapsibleSection
                                title={t('agenda.reviewDue') || 'Review Due'}
                                icon={Clock}
                                color="text-purple-600"
                                count={sections.reviewDue.length}
                                expanded={expandedSections.reviewDue}
                                onToggle={() => toggleSection('reviewDue')}
                                controlsId="agenda-section-reviewDue"
                            >
                                <AgendaTaskList
                                    tasks={sections.reviewDue}
                                    buildFocusToggle={buildFocusToggle}
                                    showListDetails={showListDetails}
                                    highlightTaskId={highlightTaskId}
                                />
                            </AgendaCollapsibleSection>
                        )}

                        <AgendaProjectSection
                            title={t('agenda.reviewDueProjects') || 'Projects to review'}
                            icon={Folder}
                            projects={reviewDueProjects}
                            color="text-indigo-600"
                            t={t}
                        />
                    </div>
                </>
            )}

            {visibleActive === 0 && (
                <div className="text-center py-12 text-muted-foreground flex flex-col items-center gap-2">
                    <CheckCircle2 className="w-10 h-10 text-emerald-500/80" aria-hidden="true" strokeWidth={1.5} />
                    <p className="text-lg font-medium text-foreground">{t('agenda.allClear')}</p>
                    <p className="text-sm">{hasTaskFilters ? t('filters.noMatch') : t('agenda.noTasks')}</p>
                </div>
            )}
            </div>
        </ErrorBoundary>
    );
}
