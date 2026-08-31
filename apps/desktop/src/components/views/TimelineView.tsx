import React from 'react';
import { addDays, differenceInCalendarDays, format, startOfDay } from 'date-fns';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
    compareProjectsByOrder,
    isTaskVisibleInArea,
    safeParseDate,
    tFallback,
    useTaskStore,
    type Project,
    type Task,
} from '@mindwtr/core';

import { ErrorBoundary } from '../ErrorBoundary';
import { useLanguage } from '../../contexts/language-context';
import { useAreaVisibility } from '../../hooks/useVisibleTaskContext';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { ListEmptyState } from './list/ListEmptyState';
import { CalendarOpenTaskModal } from './calendar/CalendarModals';

const TIMELINE_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:timeline:v1';

const ZOOM_LEVELS = ['day', 'week', 'month'] as const;
type TimelineZoom = (typeof ZOOM_LEVELS)[number];

/** Column width in pixels for one calendar day at each zoom level. */
const DAY_WIDTH: Record<TimelineZoom, number> = { day: 32, week: 12, month: 4 };
/** Width of the single-date marker and the floor for any bar. */
const MIN_BAR_WIDTH = 10;
const GUTTER_WIDTH = 220;
const ROW_HEIGHT = 28;
/** Day numbers only fit once a column is wide enough to hold two digits. */
const DAY_LABEL_MIN_WIDTH = 20;
// ponytail: a fixed 400-day window instead of paging. Tasks dated entirely
// outside it are not drawn (the header count reports what is drawn); add
// paging only if real stores turn out to span more than that.
const MAX_SPAN_DAYS = 400;
/** Below this, rendering every row outright is cheaper than measuring them. */
const VIRTUALIZE_ABOVE_ROWS = 100;

type TimelinePersistedViewState = {
    zoom: TimelineZoom;
};

const DEFAULT_TIMELINE_VIEW_STATE: TimelinePersistedViewState = { zoom: 'week' };

function sanitizeTimelineViewState(
    value: unknown,
    fallback: TimelinePersistedViewState,
): TimelinePersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<TimelinePersistedViewState>
        : {};
    return {
        zoom: ZOOM_LEVELS.includes(parsed.zoom as TimelineZoom) ? parsed.zoom as TimelineZoom : fallback.zoom,
    };
}

/** The task's dates reduced to local calendar days — the same day the calendar files it under. */
function taskDays(task: Task): { start: Date | null; due: Date | null } {
    const start = safeParseDate(task.startTime);
    const due = safeParseDate(task.dueDate);
    return {
        start: start ? startOfDay(start) : null,
        due: due ? startOfDay(due) : null,
    };
}

type TimelineRow =
    | { kind: 'group'; key: string; label: string; color: string | undefined }
    | { kind: 'task'; key: string; task: Task; color: string | undefined; lo: number; hi: number; single: boolean };

export function TimelineView() {
    const perf = usePerformanceMonitor('TimelineView');
    const tasks = useTaskStore((state) => state.tasks);
    const { t } = useLanguage();
    const visibility = useAreaVisibility();
    const { areaById, projectById } = visibility;
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        TIMELINE_VIEW_STATE_STORAGE_KEY,
        DEFAULT_TIMELINE_VIEW_STATE,
        sanitizeTimelineViewState,
    );
    const zoom = persistedViewState.zoom;
    const dayWidth = DAY_WIDTH[zoom];
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const [openTaskId, setOpenTaskId] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('TimelineView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const today = React.useMemo(() => startOfDay(new Date()), []);

    // Same scope as the board: no deleted tasks, no tasks parked out of the
    // active area filter. Finished and filed work has no place on a plan, so
    // done/archived/reference drop out too.
    const datedTasks = React.useMemo(() => {
        perf.trackUseMemo();
        return tasks.filter((task) => {
            if (task.deletedAt) return false;
            if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return false;
            if (!task.startTime && !task.dueDate) return false;
            return isTaskVisibleInArea(task, visibility);
        });
    }, [tasks, visibility]);

    const range = React.useMemo(() => {
        perf.trackUseMemo();
        let min: Date | null = null;
        let max: Date | null = null;
        for (const task of datedTasks) {
            const { start, due } = taskDays(task);
            for (const day of [start, due]) {
                if (!day) continue;
                if (!min || day < min) min = day;
                if (!max || day > max) max = day;
            }
        }
        if (!min || !max) return null;
        // Today is part of the axis whenever it fits, so the today line and the
        // Today button are there even when every task is dated ahead.
        let from = min < today ? min : today;
        let to = max > today ? max : today;
        if (differenceInCalendarDays(to, from) > MAX_SPAN_DAYS) {
            // Too wide: give up the padding to today first, then window the data
            // itself around today when today is inside it.
            from = min;
            to = max;
            if (differenceInCalendarDays(to, from) > MAX_SPAN_DAYS) {
                const anchor = today < min
                    ? min
                    : today > max
                        ? addDays(max, -MAX_SPAN_DAYS)
                        : addDays(today, -Math.floor(MAX_SPAN_DAYS / 2));
                from = anchor < min ? min : anchor;
                to = addDays(from, MAX_SPAN_DAYS);
                if (to > max) to = max;
            }
        }
        return { from, to, days: differenceInCalendarDays(to, from) + 1 };
    }, [datedTasks, today]);

    const rows = React.useMemo<TimelineRow[]>(() => {
        perf.trackUseMemo();
        if (!range) return [];
        const dayIndex = (day: Date) => differenceInCalendarDays(day, range.from);
        const byProject = new Map<string, TimelineRow[]>();
        for (const task of datedTasks) {
            const { start, due } = taskDays(task);
            const a = start ? dayIndex(start) : null;
            const b = due ? dayIndex(due) : null;
            const single = a === null || b === null;
            // Reversed dates (due before start) still draw as the span they cover.
            const lo = Math.min(a ?? b!, b ?? a!);
            const hi = Math.max(a ?? b!, b ?? a!);
            if (hi < 0 || lo > range.days - 1) continue;
            const project = task.projectId ? projectById.get(task.projectId) : undefined;
            const color = (project?.areaId ? areaById.get(project.areaId)?.color : undefined) || project?.color || undefined;
            const key = task.projectId ?? '';
            const list = byProject.get(key);
            const row: TimelineRow = { kind: 'task', key: task.id, task, color, lo, hi, single };
            if (list) list.push(row);
            else byProject.set(key, [row]);
        }

        const projectGroups: { project: Project | undefined; rows: TimelineRow[] }[] = [];
        for (const [projectId, groupRows] of byProject) {
            if (!projectId) continue;
            projectGroups.push({ project: projectById.get(projectId), rows: groupRows });
        }
        projectGroups.sort((a, b) => {
            if (a.project && b.project) return compareProjectsByOrder(a.project, b.project);
            return a.project ? -1 : b.project ? 1 : 0;
        });
        const noProjectRows = byProject.get('');
        if (noProjectRows) projectGroups.push({ project: undefined, rows: noProjectRows });

        const flattened: TimelineRow[] = [];
        for (const group of projectGroups) {
            // Earliest first, then oldest first — the order the work was planned in.
            group.rows.sort((a, b) => {
                if (a.kind !== 'task' || b.kind !== 'task') return 0;
                if (a.lo !== b.lo) return a.lo - b.lo;
                return (safeParseDate(a.task.createdAt)?.getTime() ?? 0) - (safeParseDate(b.task.createdAt)?.getTime() ?? 0);
            });
            const groupColor = group.project
                ? (group.project.areaId ? areaById.get(group.project.areaId)?.color : undefined) || group.project.color || undefined
                : undefined;
            flattened.push({
                kind: 'group',
                key: `group:${group.project?.id ?? 'none'}`,
                label: group.project?.title ?? tFallback(t, 'inbox.noProject', 'No project'),
                color: groupColor,
            });
            flattened.push(...group.rows);
        }
        return flattened;
    }, [areaById, datedTasks, projectById, range, t]);

    const taskRowCount = rows.reduce((count, row) => (row.kind === 'task' ? count + 1 : count), 0);
    const trackWidth = (range?.days ?? 0) * dayWidth;
    const todayIndex = range ? differenceInCalendarDays(today, range.from) : -1;
    const todayVisible = range ? todayIndex >= 0 && todayIndex < range.days : false;

    const shouldVirtualize = rows.length > VIRTUALIZE_ABOVE_ROWS;
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? rows.length : 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    });

    const scrollToToday = React.useCallback(() => {
        const scroller = scrollRef.current;
        if (!scroller || !todayVisible) return;
        scroller.scrollLeft = Math.max(0, todayIndex * dayWidth - scroller.clientWidth / 2 + GUTTER_WIDTH);
    }, [dayWidth, todayIndex, todayVisible]);

    const openTask = React.useMemo(
        () => (openTaskId ? tasks.find((task) => task.id === openTaskId) ?? null : null),
        [openTaskId, tasks],
    );
    const openProject = openTask?.projectId ? projectById.get(openTask.projectId) : undefined;

    const renderRow = (row: TimelineRow) => {
        if (row.kind === 'group') {
            return (
                <div className="flex items-center" style={{ height: ROW_HEIGHT }}>
                    <div
                        className="sticky left-0 z-20 flex h-full items-center gap-2 bg-background pr-3 text-xs font-semibold"
                        style={{ width: GUTTER_WIDTH, minWidth: GUTTER_WIDTH }}
                    >
                        <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: row.color || 'hsl(var(--muted-foreground))' }}
                        />
                        <span className="truncate">{row.label}</span>
                    </div>
                </div>
            );
        }
        const left = row.single
            ? row.lo * dayWidth + Math.max(0, (dayWidth - MIN_BAR_WIDTH) / 2)
            : row.lo * dayWidth;
        const width = row.single
            ? Math.min(MIN_BAR_WIDTH, Math.max(dayWidth, 4))
            : Math.max(MIN_BAR_WIDTH, (row.hi - row.lo + 1) * dayWidth);
        return (
            <div className="flex items-center" style={{ height: ROW_HEIGHT }}>
                <div
                    className="sticky left-0 z-20 flex h-full items-center bg-background pl-4 pr-3 text-xs text-muted-foreground"
                    style={{ width: GUTTER_WIDTH, minWidth: GUTTER_WIDTH }}
                >
                    <span className="truncate">{row.task.title}</span>
                </div>
                <div className="relative h-full" style={{ width: trackWidth, minWidth: trackWidth }}>
                    <button
                        type="button"
                        data-testid="timeline-bar"
                        data-task-id={row.task.id}
                        data-variant={row.single ? 'mini' : 'bar'}
                        title={row.task.title}
                        onClick={() => setOpenTaskId(row.task.id)}
                        className="absolute top-1 z-10 h-[calc(100%-0.5rem)] rounded-sm border border-black/10 hover:brightness-110"
                        style={{ left, width, backgroundColor: row.color || 'hsl(var(--muted-foreground))' }}
                    >
                        <span className="sr-only">{row.task.title}</span>
                    </button>
                </div>
            </div>
        );
    };

    const zoomLabels: Record<TimelineZoom, string> = {
        day: tFallback(t, 'calendar.day', 'Day'),
        week: tFallback(t, 'calendar.week', 'Week'),
        month: tFallback(t, 'calendar.month', 'Month'),
    };

    return (
        <ErrorBoundary>
            <div className="flex h-full min-h-0 flex-col">
                <div className="flex shrink-0 items-center justify-between px-4 pb-4">
                    <div className="flex items-center gap-3">
                        <h2 className="text-2xl font-bold tracking-tight">{tFallback(t, 'nav.timeline', 'Timeline')}</h2>
                        <span className="text-xs text-muted-foreground">
                            {taskRowCount} {t('common.tasks')}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        {todayVisible && (
                            <button
                                type="button"
                                onClick={scrollToToday}
                                className="rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                            >
                                {tFallback(t, 'calendar.today', 'Today')}
                            </button>
                        )}
                        <div className="flex items-center rounded border border-border" role="group">
                            {ZOOM_LEVELS.map((level) => (
                                <button
                                    key={level}
                                    type="button"
                                    aria-pressed={zoom === level}
                                    onClick={() => setPersistedViewState({ zoom: level })}
                                    className={`px-2 py-1 text-xs transition-colors ${zoom === level ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                                >
                                    {zoomLabels[level]}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {!range || rows.length === 0 ? (
                    <div className="px-4">
                        <ListEmptyState
                            hasFilters={false}
                            emptyState={{
                                title: tFallback(t, 'timeline.empty', 'Nothing scheduled yet'),
                                body: tFallback(t, 'timeline.emptyHint', 'Tasks with a start or due date appear here as bars.'),
                            }}
                            onAddTask={() => undefined}
                            t={t}
                        />
                    </div>
                ) : (
                    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto pb-4">
                        <div className="relative" style={{ width: GUTTER_WIDTH + trackWidth }}>
                            <div className="sticky top-0 z-30 flex bg-background">
                                <div
                                    className="sticky left-0 z-40 bg-background"
                                    style={{ width: GUTTER_WIDTH, minWidth: GUTTER_WIDTH }}
                                />
                                <div className="relative h-9 border-b border-border" style={{ width: trackWidth }}>
                                    {Array.from({ length: range.days }, (_, index) => {
                                        const day = addDays(range.from, index);
                                        const isMonthStart = index === 0 || day.getDate() === 1;
                                        return (
                                            <React.Fragment key={index}>
                                                {isMonthStart && (
                                                    <div
                                                        className="absolute top-0 whitespace-nowrap border-l border-border px-1 text-[11px] font-medium text-muted-foreground"
                                                        style={{ left: index * dayWidth }}
                                                    >
                                                        {format(day, 'MMM yyyy')}
                                                    </div>
                                                )}
                                                {dayWidth >= DAY_LABEL_MIN_WIDTH && (
                                                    <div
                                                        className="absolute bottom-0 text-center text-[10px] text-muted-foreground"
                                                        style={{ left: index * dayWidth, width: dayWidth }}
                                                    >
                                                        {day.getDate()}
                                                    </div>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </div>
                            </div>

                            <div
                                className="relative"
                                style={{ height: shouldVirtualize ? rowVirtualizer.getTotalSize() : rows.length * ROW_HEIGHT }}
                            >
                                {todayVisible && (
                                    <div
                                        data-testid="timeline-today-line"
                                        className="pointer-events-none absolute top-0 bottom-0 z-0 w-px bg-primary/70"
                                        style={{ left: GUTTER_WIDTH + todayIndex * dayWidth }}
                                    />
                                )}
                                {shouldVirtualize
                                    ? rowVirtualizer.getVirtualItems().map((virtualRow) => (
                                        <div
                                            key={rows[virtualRow.index].key}
                                            className="absolute left-0 right-0"
                                            style={{ top: virtualRow.start, height: virtualRow.size }}
                                        >
                                            {renderRow(rows[virtualRow.index])}
                                        </div>
                                    ))
                                    : rows.map((row) => (
                                        <React.Fragment key={row.key}>{renderRow(row)}</React.Fragment>
                                    ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>
            <CalendarOpenTaskModal
                controller={{
                    closeOpenTask: () => setOpenTaskId(null),
                    openProject,
                    openTask,
                    t,
                }}
            />
        </ErrorBoundary>
    );
}
