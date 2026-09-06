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
    projectMatchesAreaFilterSelection,
    safeFormatDate,
    safeParseDate,
    tFallback,
    useTaskStore,
    type Project,
    type Task,
} from '@mindwtr/core';

import { ErrorBoundary } from '../ErrorBoundary';
import { cn } from '../../lib/utils';
import { dispatchNavigateEvent } from '../../lib/navigation-events';
import { useUiStore } from '../../store/ui-store';
import { getProjectAccentColor, getTaskAccentColor } from '../../lib/task-accent-color';
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
const MARKER_WIDTH = 12;
const MARKER_HEIGHT = 12;
const ROW_HEIGHT = 30;
const BAR_HEIGHT = 10;
/** The project bar is the thicker, solid one, so it reads as the parent of the thin tinted task bars (#1111). */
const PROJECT_BAR_HEIGHT = 14;
const AXIS_HEIGHT = 44;
/** The sticky name column: every row's title lives here, not floating on the canvas. */
const GUTTER_WIDTH = 224;
/** Breathing room right of the last column when the track scrolls. */
const TRACK_TAIL = 24;
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
 * "255, 0, 0" from a row color. Area and project colors are hex from the
 * tailwind-500 family (#1085 allows a custom one); an 8-digit #RRGGBBAA is
 * read as its opaque prefix.
 */
function hexChannels(hex: string): string | null {
    const value = hex.trim().replace('#', '');
    const full = value.length === 3
        ? value.split('').map((channel) => channel + channel).join('')
        : value.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    const int = Number.parseInt(full, 16);
    return `${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}`;
}

/**
 * A task bar is a child of the project bar above it, so it wears the same color
 * at a calmer strength: a translucent fill inside a thin border of that color.
 * Both stay visible on the light card and on the dark one, and every project
 * keeps its own hue. The accent falls back to the primary token.
 */
export function taskBarTint(color: string | undefined): { fill: string; border: string } {
    const channels = color ? hexChannels(color) : null;
    return channels
        ? { fill: `rgba(${channels}, 0.25)`, border: `rgba(${channels}, 0.7)` }
        : { fill: 'hsl(var(--primary) / 0.25)', border: 'hsl(var(--primary) / 0.7)' };
}

/** "Start date: 3 May. Due date: 9 May" — the spoken half of a bar's label. */
function describeDates(
    t: (key: string) => string,
    start: string | undefined,
    due: string | undefined,
): string {
    return [
        start
            ? `${tFallback(
                t,
                hasTimeComponent(start) ? 'task.aria.startTime' : 'task.aria.startDate',
                hasTimeComponent(start) ? 'Start time' : 'Start date',
            )}: ${safeFormatDate(start, hasTimeComponent(start) ? 'PPp' : 'PP', start)}`
            : null,
        due
            ? `${tFallback(
                t,
                hasTimeComponent(due) ? 'task.aria.dueTime' : 'task.aria.dueDate',
                hasTimeComponent(due) ? 'Due time' : 'Due date',
            )}: ${safeFormatDate(due, hasTimeComponent(due) ? 'PPp' : 'PP', due)}`
            : null,
    ].filter((part): part is string => Boolean(part)).join('. ');
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
    | {
        kind: 'group';
        key: string;
        label: string;
        color: string | undefined;
        project: Project | undefined;
        /** Day indexes of the project's own bar, absent when it has no dates. */
        span: { lo: number; hi: number } | undefined;
    }
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
    const { areaById, projectById, resolvedAreaFilter } = visibility;
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

    // A dated project is plan-worthy on its own: a project whose steps have no
    // dates yet still gets its span drawn. Same scope as the task filter —
    // nothing deleted, nothing archived, nothing outside the area filter.
    const projectSpans = React.useMemo(() => {
        perf.trackUseMemo();
        const spans = new Map<string, { start: Date | null; due: Date | null }>();
        for (const project of projectById.values()) {
            if (project.deletedAt || project.status === 'archived') continue;
            const start = safeParseDate(project.startDate);
            const due = safeParseDate(project.dueDate);
            if (!start && !due) continue;
            if (!projectMatchesAreaFilterSelection(project, resolvedAreaFilter, areaById)) continue;
            spans.set(project.id, {
                start: start ? startOfDay(start) : null,
                due: due ? startOfDay(due) : null,
            });
        }
        return spans;
    }, [areaById, projectById, resolvedAreaFilter]);

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
        // A project deadline past its last dated task still has to fit on the axis.
        for (const span of projectSpans.values()) {
            for (const day of [span.start, span.due]) {
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
    }, [datedTasks, projectSpans, today, windowStart]);

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
        // A dated project with no dated task still earns its row: the group
        // header and its bar, with nothing under it.
        for (const projectId of projectSpans.keys()) {
            if (byProject.has(projectId)) continue;
            const project = projectById.get(projectId);
            if (project) projectGroups.push({ project, rows: [] });
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
            // Project first, then its area — the same helper the bars use, so a
            // never-recolored project (placeholder grey) shows its area color.
            const groupColor = group.project ? getProjectAccentColor(group.project, areaById) : undefined;
            // The group's extents, measured once here: the render loop never
            // walks a group's rows again.
            const projectSpan = group.project ? projectSpans.get(group.project.id) : undefined;
            let span: { lo: number; hi: number } | undefined;
            if (projectSpan) {
                let taskLo = Number.POSITIVE_INFINITY;
                let taskHi = Number.NEGATIVE_INFINITY;
                for (const row of group.rows) {
                    if (row.kind !== 'task') continue;
                    if (row.lo < taskLo) taskLo = row.lo;
                    if (row.hi > taskHi) taskHi = row.hi;
                }
                // One project date given, the other borrowed from the work under
                // it — and from the given date itself when there is no work.
                const from = projectSpan.start
                    ? dayIndex(projectSpan.start)
                    : Number.isFinite(taskLo) ? taskLo : dayIndex(projectSpan.due!);
                const to = projectSpan.due
                    ? dayIndex(projectSpan.due)
                    : Number.isFinite(taskHi) ? taskHi : from;
                const lo = Math.min(from, to);
                const hi = Math.max(from, to);
                // Clamped, not dropped: a bar reaching out of the window still
                // shows the part of the project that falls inside it.
                if (hi >= 0 && lo <= range.days - 1) {
                    span = { lo: Math.max(0, lo), hi: Math.min(range.days - 1, hi) };
                } else if (group.rows.length === 0) {
                    // Whole project outside the window and every task row under
                    // it omitted: a header with a dot, a title and a blank track
                    // tells the reader nothing. Count it in the same notice the
                    // omitted tasks go to, so Earlier/Later brings it back.
                    if (hi < 0) earlierOmitted += 1;
                    else laterOmitted += 1;
                    continue;
                }
            }
            flattened.push({
                kind: 'group',
                key: `group:${group.project?.id ?? 'none'}`,
                label: group.project?.title ?? tFallback(t, 'inbox.noProject', 'No project'),
                color: groupColor,
                project: group.project,
                span,
            });
            flattened.push(...group.rows);
        }
        return { rows: flattened, earlierOmitted, laterOmitted };
    }, [areaById, datedTasks, projectById, projectSpans, range, t]);

    const { rows, earlierOmitted, laterOmitted } = timelineRows;
    const omittedCount = earlierOmitted + laterOmitted;
    const taskRowCount = rows.reduce((count, row) => (row.kind === 'task' ? count + 1 : count), 0);
    const hasDatedWork = datedTasks.length > 0 || projectSpans.size > 0;
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
        if (!range) return { major: [] as AxisTick[], minor: [] as AxisTick[], monthLines: [] as number[], minorLines: [] as number[] };
        const majorCandidates: AxisTick[] = [];
        const minorCandidates: AxisTick[] = [];
        const monthLines: number[] = [];
        const minorLines: number[] = [];
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
                // Minor gridlines are real elements, never a repeating gradient:
                // a gradient with a fractional period is resampled on scaled
                // displays into soft vertical bands that testers read as
                // shading (#1111). Month starts already have their own line.
                if (zoom !== 'month' && index > 0 && !isMonthStart) minorLines.push(left);
            }
        }
        return {
            major: thinTicks(majorCandidates, MIN_MAJOR_LABEL_GAP),
            minor: thinTicks(minorCandidates, MIN_MINOR_LABEL_GAP),
            monthLines,
            minorLines,
        };
    }, [axisDateFormatters, calendarSystem, dayWidth, range, weekStartsOn, zoom]);

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

    // Open on today and re-center whenever the zoom changes, once the pane is
    // measured (#1111). Data edits never re-center: a user who scrolled away
    // stays where they are.
    const centeredZoomRef = React.useRef<TimelineZoom | null>(null);
    React.useLayoutEffect(() => {
        if (viewportWidth === 0 || centeredZoomRef.current === zoom) return;
        centeredZoomRef.current = zoom;
        scrollToToday();
    }, [scrollToToday, viewportWidth, zoom]);

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

    const setProjectView = useUiStore((state) => state.setProjectView);
    const goToProject = React.useCallback((projectId: string) => {
        setProjectView({ selectedProjectId: projectId });
        dispatchNavigateEvent('projects');
    }, [setProjectView]);

    const renderRow = (row: TimelineRow, index: number) => {
        if (row.kind === 'group') {
            const project = row.project;
            const groupDates = project ? describeDates(t, project.startDate, project.dueDate) : '';
            const groupActionLabel = groupDates ? `${row.label}. ${groupDates}` : row.label;
            const gutterClassName = 'sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-border/60 bg-muted pl-3 pr-2 text-left text-xs font-semibold text-foreground';
            const dot = (
                <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: row.color || 'hsl(var(--primary))' }}
                />
            );
            // The first row is always a group, so any later group opens a new
            // block: it gets a full-strength rule across gutter and track.
            const showSeparator = index > 0;
            return (
                <div
                    data-testid={showSeparator ? 'timeline-group-separator' : undefined}
                    className={cn(
                        'flex border-b border-t border-b-border/60',
                        showSeparator ? 'border-t-border' : 'border-t-border/60',
                    )}
                    style={{ height: ROW_HEIGHT }}
                >
                    {project ? (
                        // The project name is the row's click target, the way a task
                        // row's name is: the rail below is a 10px secondary one.
                        <button
                            type="button"
                            data-testid="timeline-group"
                            data-project-id={project.id}
                            title={row.label}
                            aria-label={groupActionLabel}
                            onClick={() => goToProject(project.id)}
                            className={cn(
                                gutterClassName,
                                'transition-colors hover:bg-muted/70',
                                'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                            )}
                            style={{ width: GUTTER_WIDTH }}
                        >
                            {dot}
                            <span className="min-w-0 truncate">{row.label}</span>
                        </button>
                    ) : (
                        <div
                            data-testid="timeline-group"
                            className={gutterClassName}
                            style={{ width: GUTTER_WIDTH }}
                        >
                            {dot}
                            <span className="min-w-0 truncate">{row.label}</span>
                        </div>
                    )}
                    <div className="relative min-w-0 flex-1 bg-muted/60">
                        {row.span && project && (
                            <div
                                data-testid="timeline-project-bar"
                                data-project-id={project.id}
                                title={row.label}
                                aria-hidden="true"
                                onClick={() => goToProject(project.id)}
                                className="absolute z-10 cursor-pointer rounded-[3px] shadow-sm transition-[filter] hover:brightness-110"
                                style={{
                                    left: row.span.lo * dayWidth,
                                    width: Math.max(MIN_BAR_WIDTH, (row.span.hi - row.span.lo + 1) * dayWidth),
                                    height: PROJECT_BAR_HEIGHT,
                                    top: (ROW_HEIGHT - PROJECT_BAR_HEIGHT) / 2,
                                    backgroundColor: row.color || 'hsl(var(--primary))',
                                }}
                            />
                        )}
                    </div>
                </div>
            );
        }
        // Keep each task's source dates intact for labels and ordering, but draw
        // only the part that intersects the bounded axis.
        const drawingLo = Math.max(0, row.lo);
        const drawingHi = Math.min(range!.days - 1, row.hi);
        const naturalWidth = row.single
            ? MARKER_WIDTH
            : Math.max(MIN_BAR_WIDTH, (drawingHi - drawingLo + 1) * dayWidth);
        const width = Math.min(naturalWidth, trackWidth);
        const barHeight = row.single ? MARKER_HEIGHT : BAR_HEIGHT;
        const naturalLeft = row.single
            ? drawingLo * dayWidth + (dayWidth - MARKER_WIDTH) / 2
            : drawingLo * dayWidth;
        // Centered markers and the minimum bar width can be wider than a day
        // cell at month zoom. Shift them inward instead of widening the track.
        const left = Math.min(Math.max(0, naturalLeft), Math.max(0, trackWidth - width));
        // The project bar keeps the full-strength area→project color; the work
        // under it is drawn as a tint of the same one. Mini markers included.
        const tint = taskBarTint(row.color);
        const dateDescription = describeDates(t, row.task.startTime, row.task.dueDate);
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
                        // No title on the bar: the sticky name column already
                        // carries it, and the tooltip repeats it on hover.
                        className="absolute z-10 cursor-pointer rounded-full transition-[filter] hover:brightness-110"
                        style={{
                            left,
                            width,
                            height: barHeight,
                            top: (ROW_HEIGHT - barHeight) / 2,
                            backgroundColor: tint.fill,
                            border: `1px solid ${tint.border}`,
                        }}
                    />
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
                        <div
                            className="flex items-center rounded-md border border-border bg-card p-0.5"
                            role="group"
                            aria-label={tFallback(t, 'timeline.zoomLabel', 'Timeline zoom')}
                        >
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

                {!hasDatedWork ? (
                    <div>
                        <ListEmptyState
                            hasFilters={false}
                            emptyState={{
                                title: tFallback(t, 'timeline.empty', 'Nothing scheduled yet'),
                                body: tFallback(t, 'timeline.emptyHint', 'Projects and tasks with a start or due date appear here as bars.'),
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
                                    {t('timeline.omittedItems').replace('{{count}}', String(omittedCount))}
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
                            {/* Focusable so the horizontal track can be scrolled with the
                                arrow keys; without a tab stop the only way across the
                                window was a pointer drag or the scrollbar. */}
                            <div
                                ref={scrollRef}
                                data-testid="timeline-scroller"
                                className="min-h-0 overflow-auto"
                                tabIndex={0}
                                role="region"
                                aria-label={tFallback(t, 'timeline.trackRegionLabel', 'Timeline track')}
                            >
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
                                            style={{ left: GUTTER_WIDTH, width: trackWidth }}
                                        >
                                            {axis.minorLines.map((left) => (
                                                <div
                                                    key={`grid-minor-${left}`}
                                                    data-testid="timeline-gridline-minor"
                                                    className="absolute inset-y-0 w-px bg-border/50"
                                                    style={{ left }}
                                                />
                                            ))}
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
                                                    {renderRow(rows[virtualRow.index], virtualRow.index)}
                                                </div>
                                            ))
                                            : rows.map((row, index) => (
                                                <React.Fragment key={row.key}>{renderRow(row, index)}</React.Fragment>
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
