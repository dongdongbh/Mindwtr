import type { KeyboardEvent } from 'react';
import { isSameDay, isToday } from 'date-fns';
import { getCalendarDayOfMonth, isSameCalendarMonth, type CalendarSystemSetting } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { dayKey, type CalendarCellItem } from './calendar-primitives';

export type CalendarOverviewMonth = { month: Date; days: Date[] };

type CalendarOverviewGridProps = {
    months: readonly CalendarOverviewMonth[];
    calendarSystem: CalendarSystemSetting;
    locale: string;
    weekdayHeaders: readonly string[];
    getCalendarItemsForDate: (date: Date) => CalendarCellItem[];
    selectedDate: Date | null;
    referenceDate: Date;
    onOpenDay: (date: Date) => void;
    onDayKeyDown: (event: KeyboardEvent<HTMLElement>, date: Date) => void;
    resolveText: (key: string, fallback: string) => string;
};

/** Compact month grids used by the quarter and year views. */
export function CalendarOverviewGrid({
    months,
    calendarSystem,
    locale,
    weekdayHeaders,
    getCalendarItemsForDate,
    selectedDate,
    referenceDate,
    onOpenDay,
    onDayKeyDown,
    resolveText,
}: CalendarOverviewGridProps) {
    return (
        <div data-calendar-overview className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {months.map(({ month, days }) => (
                <section
                    key={dayKey(month)}
                    data-calendar-overview-month
                    className="min-w-0 rounded-lg border border-border bg-card p-3 shadow-sm"
                >
                    <h3 className="mb-2 truncate text-sm font-semibold capitalize">
                        {month.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
                    </h3>
                    <div className="grid grid-cols-7 gap-px overflow-hidden rounded bg-border">
                        {weekdayHeaders.map((label) => (
                            <div key={label} className="bg-muted/60 px-1 py-1 text-center text-[10px] font-medium text-muted-foreground">
                                {[...label].slice(0, 2).join('')}
                            </div>
                        ))}
                        {days.map((day) => {
                            const items = getCalendarItemsForDate(day);
                            const eventCount = items.filter((item) => item.kind === 'event').length;
                            const taskCount = items.length - eventCount;
                            const itemCount = items.length;
                            const inMonth = isSameCalendarMonth(day, month, calendarSystem);
                            const isSelected = Boolean(selectedDate && isSameDay(day, selectedDate));
                            const isReference = isSameDay(day, referenceDate);
                            const dateLabel = day.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
                            return (
                                <button
                                    key={dayKey(day)}
                                    type="button"
                                    data-calendar-overview-date={dayKey(day)}
                                    onClick={() => onOpenDay(day)}
                                    onKeyDown={(event) => onDayKeyDown(event, day)}
                                    className={cn(
                                        "flex h-8 flex-col items-center justify-center bg-card text-xs transition-colors hover:bg-accent/50 focus:outline-none focus:ring-2 focus:ring-primary/40",
                                        !inMonth && "bg-muted/40 text-muted-foreground/60",
                                        isSelected && "ring-2 ring-inset ring-primary",
                                        !isSelected && isReference && "bg-primary/10 font-semibold text-primary",
                                        isToday(day) && "font-semibold"
                                    )}
                                    aria-label={`${dateLabel}${itemCount > 0 ? `, ${itemCount} ${resolveText('calendar.items', 'items')}` : ''}, ${resolveText('calendar.openDayView', 'Open day view')}`}
                                    title={resolveText('calendar.openDayView', 'Open day view')}
                                >
                                    <span className={cn(
                                        "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums",
                                        isToday(day) && "bg-primary text-primary-foreground"
                                    )}>
                                        {getCalendarDayOfMonth(day, calendarSystem)}
                                    </span>
                                    <span aria-hidden="true" className="flex h-1.5 items-center justify-center gap-0.5">
                                        {itemCount > 0 && (
                                            <span className={cn("h-1.5 w-1.5 rounded-full", eventCount > 0 && taskCount === 0 ? "bg-muted-foreground" : "bg-primary")} />
                                        )}
                                        {itemCount > 1 && <span className="h-1.5 w-1.5 rounded-full bg-primary/60" />}
                                        {itemCount > 2 && <span className="h-1.5 w-1.5 rounded-full bg-primary/40" />}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </section>
            ))}
        </div>
    );
}
