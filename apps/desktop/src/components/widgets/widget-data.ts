import type { AppData, Task } from '@mindwtr/core';

export type DesktopWidgetKind = 'calendar' | 'today';

export const DESKTOP_WIDGET_PARAM = 'desktopWidget';

export const DESKTOP_WIDGET_WINDOW_PREFIX = 'desktop-widget-';

/**
 * Default window sizes per widget kind (logical pixels). The calendar aims for
 * roughly half the desktop so its cells match the main window's month view.
 */
export function desktopWidgetDefaultSize(kind: DesktopWidgetKind): { width: number; height: number } {
    if (kind === 'today') return { width: 380, height: 560 };
    const width = Math.min(Math.round((window.screen?.availWidth ?? 1920) * 0.5), 1280);
    const height = Math.min(Math.round((window.screen?.availHeight ?? 1080) * 0.68), 900);
    return { width: Math.max(width, 620), height: Math.max(height, 480) };
}

/** Smallest allowed sizes; the calendar needs room for its task cells. */
export const DESKTOP_WIDGET_MIN_SIZE: Record<DesktopWidgetKind, { width: number; height: number }> = {
    calendar: { width: 620, height: 480 },
    today: { width: 280, height: 380 },
};

export const WIDGET_LOCK_STORAGE_PREFIX = 'mindwtr.widget.locked.';

const WIDGET_OPACITY_STORAGE_PREFIX = 'mindwtr.widget.opacity.';

const MIN_WIDGET_OPACITY = 40;

/** Widget opacity, 40-100%. Stored per widget kind. */
export function readWidgetOpacity(kind: DesktopWidgetKind): number {
    try {
        const raw = localStorage.getItem(`${WIDGET_OPACITY_STORAGE_PREFIX}${kind}`);
        const parsed = raw === null ? Number.NaN : Number(raw);
        if (Number.isFinite(parsed)) return Math.min(100, Math.max(MIN_WIDGET_OPACITY, Math.round(parsed)));
    } catch {
        // Fall through to the default.
    }
    return 100;
}

export function writeWidgetOpacity(kind: DesktopWidgetKind, opacity: number): void {
    try {
        localStorage.setItem(
            `${WIDGET_OPACITY_STORAGE_PREFIX}${kind}`,
            String(Math.min(100, Math.max(MIN_WIDGET_OPACITY, Math.round(opacity)))),
        );
    } catch {
        // Best effort only.
    }
}

/** Widgets start unlocked; users can flip the lock once the widget is placed. */
export function isWidgetLocked(kind: DesktopWidgetKind): boolean {
    try {
        return localStorage.getItem(`${WIDGET_LOCK_STORAGE_PREFIX}${kind}`) === '1';
    } catch {
        return false;
    }
}

export function setWidgetLocked(kind: DesktopWidgetKind, locked: boolean): void {
    try {
        localStorage.setItem(`${WIDGET_LOCK_STORAGE_PREFIX}${kind}`, locked ? '1' : '0');
    } catch {
        // Best effort only.
    }
}

export function isDesktopWidgetKind(value: string | null): value is DesktopWidgetKind {
    return value === 'calendar' || value === 'today';
}

/** Detects whether this webview was opened as a desktop widget window. */
export function isDesktopWidgetLocation(location: Pick<Location, 'search'> = window.location): boolean {
    return getDesktopWidgetKindFromLocation(location) !== null;
}

export function getDesktopWidgetKindFromLocation(
    location: Pick<Location, 'search'> = window.location,
): DesktopWidgetKind | null {
    const value = new URLSearchParams(location.search).get(DESKTOP_WIDGET_PARAM);
    return isDesktopWidgetKind(value) ? value : null;
}

const ACTIVE_STATUSES = new Set<Task['status']>(['inbox', 'next', 'waiting', 'reference']);

function toDayKey(value: string): string {
    return value.slice(0, 10);
}

export function getTodayKey(now: Date = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Tasks relevant for a widget day: active tasks due or starting on that day,
 * plus tasks completed on that day when the widget shows completed items.
 * Pure function so the selection rules stay unit-testable without a Tauri runtime.
 */
export function selectWidgetTasksForDay(
    data: AppData | null,
    dayKey: string,
    options: { includeCompleted: boolean; now?: Date },
): { dueToday: Task[]; completedToday: Task[] } {
    if (!data) return { dueToday: [], completedToday: [] };
    const dueToday: Task[] = [];
    const completedToday: Task[] = [];
    for (const task of data.tasks) {
        if (ACTIVE_STATUSES.has(task.status)) {
            const due = task.dueDate ? toDayKey(task.dueDate) : null;
            const start = task.startTime ? toDayKey(task.startTime) : null;
            if (due === dayKey || start === dayKey) {
                dueToday.push(task);
            }
            continue;
        }
        if (options.includeCompleted && task.status === 'done' && task.completedAt) {
            if (toDayKey(task.completedAt) === dayKey) {
                completedToday.push(task);
            }
        }
    }
    dueToday.sort(compareWidgetTasks);
    completedToday.sort(compareWidgetTasks);
    return { dueToday, completedToday };
}

function compareWidgetTasks(a: Task, b: Task): number {
    const priorityRank = (task: Task): number => (task.priority === 'high' ? 0 : task.priority === 'medium' ? 1 : task.priority === 'low' ? 3 : 2);
    const priorityDelta = priorityRank(a) - priorityRank(b);
    if (priorityDelta !== 0) return priorityDelta;
    if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
    if (a.startTime) return 1; // All-day / unscheduled tasks float to the top.
    if (b.startTime) return -1;
    return a.title.localeCompare(b.title);
}

export type WidgetWeekStart = 'sunday' | 'monday' | 'saturday';

export function resolveWeekStart(setting: AppData['settings']['weekStart'], localeCode: string): WidgetWeekStart {
    if (setting === 'monday' || setting === 'sunday' || setting === 'saturday') return setting;
    const region = localeCode.split('-')[1]?.toUpperCase() ?? '';
    // Match the Intl weekend research default: most of the world starts Monday;
    // the US/Canada/Japan/China Sunday rule keeps the familiar wall-calendar look.
    if (['US', 'CA', 'JP', 'CN', 'TW', 'HK', 'KR'].includes(region)) return 'sunday';
    return 'monday';
}

export interface WidgetCalendarCell {
    day: number;
    key: string;
    inMonth: boolean;
    isToday: boolean;
    isWeekend: boolean;
    hasDue: boolean;
}

export interface WidgetMonthGrid {
    weekdayLabels: string[];
    leadingBlanks: number;
    cells: WidgetCalendarCell[];
}

/** Builds a month grid for the widget. Pure so calendar math is testable. */
export function buildWidgetMonthGrid(
    year: number,
    monthIndex: number,
    options: { weekStart: WidgetWeekStart; todayKey: string; dueKeys: ReadonlySet<string>; localeCode: string },
): WidgetMonthGrid {
    const formatter = new Intl.DateTimeFormat(options.localeCode, { weekday: 'narrow' });
    const anchor = new Date(Date.UTC(2023, 0, 1)); // 2023-01-01 is a Sunday; stable narrow labels.
    const orderedWeekdays = ((): number[] => {
        const order = [0, 1, 2, 3, 4, 5, 6];
        const shift = options.weekStart === 'monday' ? 1 : options.weekStart === 'saturday' ? 6 : 0;
        return [...order.slice(shift), ...order.slice(0, shift)];
    })();
    const weekdayLabels = orderedWeekdays.map((weekday) => formatter.format(new Date(anchor.getTime() + weekday * 86_400_000)));

    const firstOfMonth = new Date(year, monthIndex, 1);
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const leadingBlanks = (firstOfMonth.getDay() - orderedWeekdays[0] + 7) % 7;

    const cells: WidgetCalendarCell[] = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, monthIndex, day);
        const key = getTodayKey(date);
        const weekday = date.getDay();
        cells.push({
            day,
            key,
            inMonth: true,
            isToday: key === options.todayKey,
            isWeekend: weekday === 0 || weekday === 6,
            hasDue: options.dueKeys.has(key),
        });
    }
    return { weekdayLabels, leadingBlanks, cells };
}
