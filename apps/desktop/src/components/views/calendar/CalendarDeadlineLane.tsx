import type { MouseEvent } from 'react';
import {
    getCalendarDeadlineMarkerGroups,
    getTaskCalendarOccurrenceDate,
    isProjectedRecurringTask,
    safeFormatDate,
    type CalendarDeadlineMarker,
    type Task,
} from '@mindwtr/core';
import { cn } from '../../../lib/utils';
import { DESKTOP_HOUR_HEIGHT } from './calendar-primitives';

const MARKER_ROW_HEIGHT = 32;
const MAX_VISIBLE_ROWS = 5;

type CalendarDeadlineLaneProps = {
    day: Date;
    markers: CalendarDeadlineMarker[];
    t: (key: string) => string;
    resolveText: (key: string, fallback: string) => string;
    getTaskAccentColor: (task: Task) => string | undefined;
    taskMenuRingClass: (taskId: string) => string | undefined;
    openTaskFromCalendar: (task: Task) => void;
    onContextMenu: (event: MouseEvent<HTMLElement>, task: Task, kind: 'deadline') => void;
};


export function CalendarDeadlineLane({
    day, markers, t, resolveText, getTaskAccentColor, taskMenuRingClass, openTaskFromCalendar, onContextMenu,
}: CalendarDeadlineLaneProps) {
    const groups = getCalendarDeadlineMarkerGroups(markers, {
        dayStart: day,

        minGapMinutes: (MARKER_ROW_HEIGHT + 4) / DESKTOP_HOUR_HEIGHT * 60,
        maxVisibleRows: MAX_VISIBLE_ROWS,
    });
    return (
        <div className="pointer-events-none absolute bottom-0 right-0 top-0 w-[42%] border-l border-border/60" data-calendar-deadline-lane>
            {markers.map((marker) => {
                const minutes = marker.start.getHours() * 60 + marker.start.getMinutes()
                    + marker.start.getSeconds() / 60 + marker.start.getMilliseconds() / 60_000;
                return (
                    <div key={marker.id} aria-hidden="true" className="absolute left-0 flex -translate-y-1/2 items-center text-muted-foreground"
                        style={{ top: minutes / 60 * DESKTOP_HOUR_HEIGHT, color: getTaskAccentColor(marker.task) }}>
                        <span className="h-1.5 w-1.5 rotate-45 border border-current bg-card" />
                        <span className="h-px w-2 bg-current" />
                    </div>
                );
            })}
            {groups.map((group) => (
                <div key={group.markers[0].id} data-calendar-deadline-group
                    className="pointer-events-auto absolute left-3 right-1 overflow-y-auto rounded border border-border/60 bg-card"
                    style={{ top: group.startMinutes / 60 * DESKTOP_HOUR_HEIGHT, maxHeight: MAX_VISIBLE_ROWS * MARKER_ROW_HEIGHT }}
                    onClick={(event) => event.stopPropagation()}>
                    {group.markers.map((marker) => {
                        const projected = isProjectedRecurringTask(marker.task);
                        const timeLabel = `${t('calendar.due')} ${safeFormatDate(marker.start, 'p')}`;
                        const projectedLabel = projected
                            ? `${resolveText('calendar.projectedRecurrence', 'Projected')} · ${safeFormatDate(getTaskCalendarOccurrenceDate(marker.task), 'MMM d')}`
                            : '';
                        return (
                            <button key={marker.id} type="button"
                                data-calendar-deadline-marker data-task-id={marker.task.id} data-deadline-time={marker.start.toISOString()}
                                {...(!projected ? { 'data-task-edit-trigger': true } : {})}
                                draggable={false} disabled={projected}
                                className={cn(
                                    'block h-8 w-full border-l-2 border-muted-foreground/60 px-1.5 text-left text-[10px] text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary/40',
                                    projected && 'border-dashed text-muted-foreground', taskMenuRingClass(marker.task.id),
                                )}
                                style={{ borderLeftColor: getTaskAccentColor(marker.task) }}
                                title={`${marker.title} · ${timeLabel}${projected ? ` · ${projectedLabel}` : ''}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    if (!projected) openTaskFromCalendar(marker.task);
                                }}
                                onContextMenu={(event) => {
                                    if (!projected) onContextMenu(event, marker.task, 'deadline');
                                }}>
                                <div className="whitespace-nowrap font-medium tabular-nums">{timeLabel}</div>
                                <div className="truncate">{marker.title}</div>
                            </button>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}
