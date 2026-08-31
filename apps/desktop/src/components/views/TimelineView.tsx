import React from 'react';
import { addDays, differenceInCalendarDays, startOfDay } from 'date-fns';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
    compareProjectsByOrder,
    getCalendarDayOfMonth,
    getCalendarMonthIndex,
    getWeekStartsOnIndex,
    hasTimeComponent,
    isTaskVisibleInArea,
    safeFormatDate,
    safeParseDate,
    tFallback,
    useTaskStore,
    type Project,
    type Task,
} from '@mindwtr/core';

import { ErrorBoundary } from '../ErrorBoundary';
import { cn } from '../../lib/utils';
import { getTaskAccentColor } from '../../lib/task-accent-color';
import { useLanguage } from '../../contexts/language-context';
import { useAreaVisibility } from '../../hooks/useVisibleTaskContext';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { useLocalDayKey } from '../../hooks/useLocalDayKey';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { ListEmptyState } from './list/ListEmptyState';
import { CalendarOpenTaskModal } from './calendar/CalendarModals';
import { resolveCalendarLocale } from './calendar-locale';

const TIMELINE_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:timeline:v1';

const ZOOM_LEVELS = ['day', 'week', 'month'] as const;
type TimelineZoom = (typeof ZOOM_LEVELS)[number];

/** Column width in pixels for one calendar day at each zoom level. */
const DAY_WIDTH: Record<TimelineZoom, number> = { day: 32, week: 12, month: 4 };
/** Floor for a span bar, so a one-day span is still a bar and not a hairline. */
const MIN_BAR_WIDTH = 10;
/** A task dated on one side only is a moment, not a span: a small dot on its day. */
const MARKER_WIDTH = 14;
const MARKER_HEIGHT = 14;
const ROW_HEIGHT = 30;
const BAR_HEIGHT = 20;
const AXIS_HEIGHT = 44;
/** The sticky name column: every row's title lives here, not floating on the canvas. */
const GUTTER_WIDTH = 224;
/** Breathing room right of the last column when the track scrolls. */
const TRACK_TAIL = 24;
/** Narrower than this and a title on the bar is all ellipsis. */
const ON_BAR_LABEL_MIN_WIDTH = 64;
const MIN_MAJOR_LABEL_GAP = 68;
const MIN_MINOR_LABEL_GAP = 26;
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

/**
 * Rec. 709 luma, enough to pick black or white for a title sitting on a bar.
 * Area and project colors are hex from the tailwind-500 family (#1085 allows a
 * custom one); an 8-digit #RRGGBBAA is read as its opaque prefix.
 */
function isLightColor(hex: string): boolean {
    const value = hex.trim().replace('#', '');
    const full = value.length === 3
        ? value.split('').map((channel) => channel + channel).join('')
        : value.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return false;
    const int = Number.parseInt(full, 16);
    const luma = 0.2126 * ((int >> 16) & 255) + 0.7152 * ((int >> 8) & 255) + 0.0722 * (int & 255);
    return luma / 255 > 0.62;
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

/**
 * Column widths are minimums, not fixed sizes: a range that fits the pane
 * stretches to fill it (the calendar's content-fit grid), and only a range too
 * wide at the minimum scrolls. `viewportWidth` of 0 is the pre-measure paint.
 */
export function resolveTimelineTrack(
    days: number,
    minDayWidth: number,
    viewportWidth: number,
): { dayWidth: number; trackWidth: number; fitted: boolean } {
    if (days <= 0) return { dayWidth: minDayWidth, trackWidth: 0, fitted: false };
    // Fitted returns the measured width verbatim rather than days * dayWidth, so
    // float division can never round the track past the pane and add a scrollbar.
    return viewportWidth > 0 && days * minDayWidth <= viewportWidth
        ? { dayWidth: viewportWidth / days, trackWidth: viewportWidth, fitted: true }
        : { dayWidth: minDayWidth, trackWidth: days * minDayWidth, fitted: false };
}

type AxisTick = { left: number; label: string };

/**
 * Drop every label that would land within `gap` of the one before it. A tick at
 * the very left edge is the partial leading period, so a real boundary that
 * collides with it wins the slot instead of being the one dropped.
 */
function thinTicks(ticks: AxisTick[], gap: number): AxisTick[] {
    const kept: AxisTick[] = [];
    for (const tick of ticks) {
        const previous = kept[kept.length - 1];
        if (previous && tick.left - previous.left < gap) {
            if (previous.left !== 0) continue;
            kept.pop();
        }
        kept.push(tick);
    }
    return kept;
}

type TimelineRow =
    | { kind: 'group'; key: string; label: string; color: string | undefined }
    | { kind: 'task'; key: string; task: Task; color: string | undefined; lo: number; hi: number; single: boolean };

export function TimelineView() {
    const perf = usePerformanceMonitor('TimelineView');
    const tasks = useTaskStore((state) => state.tasks);
    const weekStart = useTaskStore((state) => state.settings?.weekStart);
    const calendarSystem = useTaskStore((state) => state.settings?.calendarSystem);
    const dateFormat = useTaskStore((state) => state.settings?.dateFormat);
    const language = useTaskStore((state) => state.settings?.language);
    const { t } = useLanguage();
    const visibility = useAreaVisibility();
    const { areaById, projectById } = visibility;
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        TIMELINE_VIEW_STATE_STORAGE_KEY,
        DEFAULT_TIMELINE_VIEW_STATE,
        sanitizeTimelineViewState,
    );
    const zoom = persistedViewState.zoom;
    const weekStartsOn = getWeekStartsOnIndex(weekStart);
    const calendarLocale = React.useMemo(() => resolveCalendarLocale({
        language,
        dateFormat,
        calendarSystem,
        systemLocale: typeof navigator === 'undefined' ? undefined : navigator.language,
    }), [calendarSystem, dateFormat, language]);
    const axisDateFormatters = React.useMemo(() => {
        const create = (options: Intl.DateTimeFormatOptions) => {
            try {
                return new Intl.DateTimeFormat(calendarLocale, options);
            } catch {
                return new Intl.DateTimeFormat('en-US', options);
            }
        };
        return {
            day: create({ day: 'numeric' }),
            month: create({ month: 'short' }),
            monthYear: create({ month: 'short', year: 'numeric' }),
            year: create({ year: 'numeric' }),
        };
    }, [calendarLocale]);
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const [viewportWidth, setViewportWidth] = React.useState(0);
    const [openTaskId, setOpenTaskId] = React.useState<string | null>(null);
    const [windowStart, setWindowStart] = React.useState<Date | null>(null);
    const localDayKey = useLocalDayKey();

    React.useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('TimelineView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const today = React.useMemo(() => startOfDay(new Date()), [localDayKey]);

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
        if (windowStart && differenceInCalendarDays(max, min) > MAX_SPAN_DAYS) {
            const latestFrom = addDays(max, -MAX_SPAN_DAYS);
            const from = windowStart < min
                ? min
                : windowStart > latestFrom
                    ? latestFrom
                    : windowStart;
            const requestedTo = addDays(from, MAX_SPAN_DAYS);
            const to = requestedTo > max ? max : requestedTo;
            return { from, to, days: differenceInCalendarDays(to, from) + 1 };
        }
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
    }, [datedTasks, today, windowStart]);

    const timelineRows = React.useMemo(() => {
        perf.trackUseMemo();
        if (!range) return { rows: [] as TimelineRow[], earlierOmitted: 0, laterOmitted: 0 };
        const dayIndex = (day: Date) => differenceInCalendarDays(day, range.from);
        const byProject = new Map<string, TimelineRow[]>();
        let earlierOmitted = 0;
        let laterOmitted = 0;
        for (const task of datedTasks) {
            const { start, due } = taskDays(task);
            const a = start ? dayIndex(start) : null;
            const b = due ? dayIndex(due) : null;
            const single = a === null || b === null;
            // Reversed dates (due before start) still draw as the span they cover.
            const lo = Math.min(a ?? b!, b ?? a!);
            const hi = Math.max(a ?? b!, b ?? a!);
            if (hi < 0) {
                earlierOmitted += 1;
                continue;
            }
            if (lo > range.days - 1) {
                laterOmitted += 1;
                continue;
            }
            const color = getTaskAccentColor(task, projectById, areaById);
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
            // Project first, then its area — the same order the bars use.
            const groupColor = group.project
                ? group.project.color || (group.project.areaId ? areaById.get(group.project.areaId)?.color : undefined) || undefined
                : undefined;
            flattened.push({
                kind: 'group',
                key: `group:${group.project?.id ?? 'none'}`,
                label: group.project?.title ?? tFallback(t, 'inbox.noProject', 'No project'),
                color: groupColor,
            });
            flattened.push(...group.rows);
        }
        return { rows: flattened, earlierOmitted, laterOmitted };
    }, [areaById, datedTasks, projectById, range, t]);

    const { rows, earlierOmitted, laterOmitted } = timelineRows;
    const omittedCount = earlierOmitted + laterOmitted;
    const taskRowCount = rows.reduce((count, row) => (row.kind === 'task' ? count + 1 : count), 0);
    const hasDatedTasks = datedTasks.length > 0;
    const hasRows = Boolean(range) && rows.length > 0;
    const { dayWidth, trackWidth, fitted } = resolveTimelineTrack(
        range?.days ?? 0,
        DAY_WIDTH[zoom],
        Math.max(0, viewportWidth - GUTTER_WIDTH),
    );
    const contentWidth = GUTTER_WIDTH + trackWidth + (fitted ? 0 : TRACK_TAIL);
    const todayIndex = range ? differenceInCalendarDays(today, range.from) : -1;
    const todayVisible = range ? todayIndex >= 0 && todayIndex < range.days : false;
    const todayLeft = todayIndex * dayWidth;

    // Two tiers so no label ever has to share a slot: the top one carries the
    // coarser unit (the year once the columns are months), the bottom one the
    // minor ticks for the zoom. Both are thinned to a minimum pixel spacing.
    const axis = React.useMemo(() => {
        if (!range) return { major: [] as AxisTick[], minor: [] as AxisTick[], monthLines: [] as number[] };
        const majorCandidates: AxisTick[] = [];
        const minorCandidates: AxisTick[] = [];
        const monthLines: number[] = [];
        for (let index = 0; index < range.days; index += 1) {
            const day = addDays(range.from, index);
            const left = index * dayWidth;
            const isMonthStart = getCalendarDayOfMonth(day, calendarSystem) === 1;
            if (isMonthStart && index > 0) monthLines.push(left);
            const isMajor = index === 0
                || (zoom === 'month' ? isMonthStart && getCalendarMonthIndex(day, calendarSystem) === 0 : isMonthStart);
            if (isMajor) {
                majorCandidates.push({
                    left,
                    label: (zoom === 'month' ? axisDateFormatters.year : axisDateFormatters.monthYear).format(day),
                });
            }
            const isMinor = zoom === 'day'
                ? true
                : zoom === 'week'
                    ? day.getDay() === weekStartsOn
                    : isMonthStart;
            if (isMinor) {
                minorCandidates.push({
                    left,
                    label: (zoom === 'month' ? axisDateFormatters.month : axisDateFormatters.day).format(day),
                });
            }
        }
        return {
            major: thinTicks(majorCandidates, MIN_MAJOR_LABEL_GAP),
            minor: thinTicks(minorCandidates, MIN_MINOR_LABEL_GAP),
            monthLines,
        };
    }, [axisDateFormatters, calendarSystem, dayWidth, range, weekStartsOn, zoom]);

    // Minor gridlines are a repeating gradient rather than one div per tick:
    // at day zoom that is 400 columns the browser paints for free.
    const minorGridStyle = React.useMemo<React.CSSProperties | undefined>(() => {
        if (!range || zoom === 'month') return undefined;
        const step = zoom === 'day' ? dayWidth : dayWidth * 7;
        const offset = zoom === 'week'
            ? ((weekStartsOn - range.from.getDay() + 7) % 7) * dayWidth
            : 0;
        return {
            backgroundImage: `repeating-linear-gradient(to right, hsl(var(--border) / 0.5) 0 1px, transparent 1px ${step}px)`,
            backgroundPosition: `${offset}px 0`,
            backgroundRepeat: 'repeat',
        };
    }, [dayWidth, range, weekStartsOn, zoom]);

    const shouldVirtualize = rows.length > VIRTUALIZE_ABOVE_ROWS;
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? rows.length : 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    });

    // Same shape as ProjectsView's sidebar measurement: observer where there is
    // one, window resize otherwise.
    React.useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        const measure = () => setViewportWidth(scroller.clientWidth);
        measure();
        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(measure);
            observer.observe(scroller);
            return () => observer.disconnect();
        }
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [hasRows]);

    const scrollToToday = React.useCallback(() => {
        const scroller = scrollRef.current;
        if (!scroller || !todayVisible) return;
        scroller.scrollLeft = Math.max(0, GUTTER_WIDTH + todayLeft - scroller.clientWidth / 2);
    }, [todayLeft, todayVisible]);

    const showEarlierWindow = React.useCallback(() => {
        if (!range || earlierOmitted === 0) return;
        setWindowStart(addDays(range.from, -MAX_SPAN_DAYS));
    }, [earlierOmitted, range]);

    const showLaterWindow = React.useCallback(() => {
        if (!range || laterOmitted === 0) return;
        setWindowStart(addDays(range.from, MAX_SPAN_DAYS));
    }, [laterOmitted, range]);

    const openTask = React.useMemo(
        () => (openTaskId ? tasks.find((task) => task.id === openTaskId) ?? null : null),
        [openTaskId, tasks],
    );
    const openProject = openTask?.projectId ? projectById.get(openTask.projectId) : undefined;

    const renderRow = (row: TimelineRow) => {
        if (row.kind === 'group') {
            return (
                <div className="flex border-y border-border/60" style={{ height: ROW_HEIGHT }}>
                    <div
                        data-testid="timeline-group"
                        className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-border/60 bg-muted pl-3 pr-2 text-xs font-semibold text-foreground"
                        style={{ width: GUTTER_WIDTH }}
                    >
                        <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: row.color || 'hsl(var(--primary))' }}
                        />
                        <span className="min-w-0 truncate">{row.label}</span>
                    </div>
                    <div className="min-w-0 flex-1 bg-muted/60" />
                </div>
            );
        }
        const width = row.single
            ? MARKER_WIDTH
            : Math.max(MIN_BAR_WIDTH, (row.hi - row.lo + 1) * dayWidth);
        const barHeight = row.single ? MARKER_HEIGHT : BAR_HEIGHT;
        const left = row.single
            ? Math.max(0, row.lo * dayWidth + (dayWidth - MARKER_WIDTH) / 2)
            : row.lo * dayWidth;
        const onBar = !row.single && width >= ON_BAR_LABEL_MIN_WIDTH;
        // Full-strength area→project color; the app's accent when a task has
        // neither, never muted-foreground.
        const background = row.color || 'hsl(var(--primary))';
        const onBarColor = row.color
            ? (isLightColor(row.color) ? 'rgba(0, 0, 0, 0.84)' : 'rgba(255, 255, 255, 0.96)')
            : 'hsl(var(--primary-foreground))';
        const dateDescription = [
            row.task.startTime
                ? `${tFallback(
                    t,
                    hasTimeComponent(row.task.startTime) ? 'task.aria.startTime' : 'task.aria.startDate',
                    hasTimeComponent(row.task.startTime) ? 'Start time' : 'Start date',
                )}: ${safeFormatDate(row.task.startTime, hasTimeComponent(row.task.startTime) ? 'PPp' : 'PP', row.task.startTime)}`
                : null,
            row.task.dueDate
                ? `${tFallback(
                    t,
                    hasTimeComponent(row.task.dueDate) ? 'task.aria.dueTime' : 'task.aria.dueDate',
                    hasTimeComponent(row.task.dueDate) ? 'Due time' : 'Due date',
                )}: ${safeFormatDate(row.task.dueDate, hasTimeComponent(row.task.dueDate) ? 'PPp' : 'PP', row.task.dueDate)}`
                : null,
        ].filter((part): part is string => Boolean(part)).join('. ');
        const taskActionLabel = dateDescription
            ? `${row.task.title}. ${dateDescription}`
            : row.task.title;
        return (
            <div className="group/timeline-row flex border-b border-border/40" style={{ height: ROW_HEIGHT }}>
                {/* The name column is the row's primary click target; the bar is a
                    secondary one, so a 14px dot never has to carry the interaction. */}
                <button
                    type="button"
                    data-testid="timeline-row-label"
                    data-task-id={row.task.id}
                    title={row.task.title}
                    aria-label={taskActionLabel}
                    onClick={() => setOpenTaskId(row.task.id)}
                    className={cn(
                        'sticky left-0 z-20 flex shrink-0 items-center border-r border-border/60 bg-card pl-6 pr-3 text-left',
                        'text-xs text-foreground transition-colors hover:bg-muted group-hover/timeline-row:bg-muted',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                    )}
                    style={{ width: GUTTER_WIDTH }}
                >
                    <span className="min-w-0 truncate">{row.task.title}</span>
                </button>
                <div className="relative min-w-0 flex-1 transition-colors group-hover/timeline-row:bg-muted/40">
                    <div
                        data-testid="timeline-bar"
                        data-task-id={row.task.id}
                        data-variant={row.single ? 'mini' : 'bar'}
                        title={row.task.title}
                        aria-hidden="true"
                        onClick={() => setOpenTaskId(row.task.id)}
                        className={cn(
                            'absolute z-10 flex cursor-pointer items-center rounded-full shadow-sm transition-[filter] hover:brightness-110',
                            onBar && 'overflow-hidden px-2.5',
                        )}
                        style={{
                            left,
                            width,
                            height: barHeight,
                            top: (ROW_HEIGHT - barHeight) / 2,
                            backgroundColor: background,
                        }}
                    >
                        {onBar && (
                            <span
                                className="truncate text-[11px] font-medium leading-none"
                                style={{ color: onBarColor }}
                            >
                                {row.task.title}
                            </span>
                        )}
                    </div>
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
                <div className="flex shrink-0 items-center justify-between pb-3">
                    <div className="flex items-baseline gap-3">
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
                                className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                {tFallback(t, 'calendar.today', 'Today')}
                            </button>
                        )}
                        <div className="flex items-center rounded-md border border-border bg-card p-0.5" role="group">
                            {ZOOM_LEVELS.map((level) => (
                                <button
                                    key={level}
                                    type="button"
                                    aria-pressed={zoom === level}
                                    onClick={() => setPersistedViewState({ zoom: level })}
                                    className={cn(
                                        'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                                        zoom === level
                                            ? 'bg-muted text-foreground'
                                            : 'text-muted-foreground hover:text-foreground',
                                    )}
                                >
                                    {zoomLabels[level]}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {!hasDatedTasks ? (
                    <div>
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
                    <>
                        {omittedCount > 0 && (
                            <div
                                data-testid="timeline-omitted-notice"
                                className="mb-3 flex shrink-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2"
                            >
                                <span className="text-xs text-muted-foreground">
                                    +{omittedCount} {t('common.tasks')}
                                </span>
                                <div className="flex items-center gap-2">
                                    {earlierOmitted > 0 && (
                                        <button
                                            type="button"
                                            onClick={showEarlierWindow}
                                            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                                        >
                                            {tFallback(t, 'list.completedGroup.earlier', 'Earlier')}
                                        </button>
                                    )}
                                    {laterOmitted > 0 && (
                                        <button
                                            type="button"
                                            onClick={showLaterWindow}
                                            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                                        >
                                            {tFallback(t, 'settings.later', 'Later')}
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                        {hasRows && (
                            // One surface, like the calendar and the board: the card hugs
                            // its rows (no stretched empty canvas below the last one) and
                            // only scrolls once they outgrow the viewport.
                            <div className="min-h-0 flex-1 pb-4">
                        <div className="flex max-h-full flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
                            <div ref={scrollRef} className="min-h-0 overflow-auto">
                                <div className="relative flex flex-col" style={{ width: contentWidth }}>
                                    <div
                                        className="sticky top-0 z-30 flex border-b border-border bg-card"
                                        style={{ height: AXIS_HEIGHT }}
                                    >
                                        <div
                                            className="sticky left-0 z-40 shrink-0 border-r border-border/60 bg-card"
                                            style={{ width: GUTTER_WIDTH }}
                                        />
                                        <div className="relative h-full" style={{ width: trackWidth }}>
                                            {axis.monthLines.map((left) => (
                                                <div
                                                    key={`axis-month-${left}`}
                                                    className="absolute inset-y-0 w-px bg-border"
                                                    style={{ left }}
                                                />
                                            ))}
                                            {axis.major.map((tick) => (
                                                <div
                                                    key={`axis-major-${tick.left}`}
                                                    data-testid="timeline-axis-major"
                                                    className="absolute top-0 whitespace-nowrap pl-2 text-[11px] font-semibold leading-[22px] text-foreground"
                                                    style={{ left: tick.left }}
                                                >
                                                    {tick.label}
                                                </div>
                                            ))}
                                            {axis.minor.map((tick) => (
                                                <div
                                                    key={`axis-minor-${tick.left}`}
                                                    data-testid="timeline-axis-minor"
                                                    className="absolute bottom-0 whitespace-nowrap pl-2 text-[10px] leading-[22px] tabular-nums text-muted-foreground"
                                                    style={{ left: tick.left }}
                                                >
                                                    {tick.label}
                                                </div>
                                            ))}
                                            {todayVisible && (
                                                <div
                                                    className="pointer-events-none absolute bottom-0 flex flex-col items-center"
                                                    style={{ left: todayLeft - 3, top: 18, width: 6 }}
                                                >
                                                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                                                    <span className="w-0.5 flex-1 bg-primary" />
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div
                                        className="relative"
                                        style={{ minHeight: shouldVirtualize ? rowVirtualizer.getTotalSize() : rows.length * ROW_HEIGHT }}
                                    >
                                        <div
                                            aria-hidden
                                            className="pointer-events-none absolute inset-y-0 z-0"
                                            style={{ left: GUTTER_WIDTH, width: trackWidth, ...minorGridStyle }}
                                        >
                                            {axis.monthLines.map((left) => (
                                                <div
                                                    key={`grid-month-${left}`}
                                                    className="absolute inset-y-0 w-px bg-border"
                                                    style={{ left }}
                                                />
                                            ))}
                                        </div>
                                        {todayVisible && (
                                            <div
                                                data-testid="timeline-today-line"
                                                className="pointer-events-none absolute inset-y-0 z-[5] w-0.5 bg-primary"
                                                style={{ left: GUTTER_WIDTH + todayLeft - 1 }}
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
                        </div>
                            </div>
                        )}
                    </>
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
