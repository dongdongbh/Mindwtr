import { ChevronDown, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { safeFormatDate, safeParseDueDate, type Task } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { setCalendarTaskDragData } from '../../../lib/calendar-task-drag';
import type { DesktopCalendarController } from './useDesktopCalendarController';

type CalendarPlanningPanelController = Pick<
    DesktopCalendarController,
    | 'locale'
    | 'planningTasks'
    | 'resolveText'
    | 'scheduleError'
    | 'schedulePlanningTask'
    | 'selectedDate'
>;

type CalendarPlanningPanelProps = {
    controller: CalendarPlanningPanelController;
    isCollapsed: boolean;
    onCollapsedChange: (collapsed: boolean) => void;
};

const getDueLabel = (task: Task, fallback: string): string | null => {
    if (!task.dueDate) return null;
    const due = safeParseDueDate(task.dueDate);
    if (!due) return null;
    const label = safeFormatDate(due, 'PP');
    return label ? `${fallback}: ${label}` : null;
};

export function CalendarPlanningPanel({
    controller,
    isCollapsed,
    onCollapsedChange,
}: CalendarPlanningPanelProps) {
    const {
        locale,
        planningTasks,
        resolveText,
        scheduleError,
        schedulePlanningTask,
        selectedDate,
    } = controller;
    const selectedDateLabel = selectedDate
        ? selectedDate.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })
        : null;
    const targetLabel = selectedDateLabel
        ? resolveText('calendar.planningForDate', 'Plan for {date}').replace('{date}', selectedDateLabel)
        : resolveText('calendar.selectDayToPlan', 'Select a day to plan first.');
    const collapseLabel = resolveText('calendar.collapsePlanningPanel', 'Collapse planning panel');
    const expandLabel = resolveText('calendar.expandPlanningPanel', 'Expand planning panel');

    if (isCollapsed) {
        return (


            <aside className="rounded-lg border border-border bg-card p-2 shadow-sm">
                <button
                    type="button"
                    onClick={() => onCollapsedChange(false)}
                    className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 xl:h-full xl:min-h-10"
                    aria-label={expandLabel}
                    title={expandLabel}
                >
                    <span className="text-sm font-medium xl:hidden">
                        {resolveText('calendar.planningTitle', 'Plan next actions')}
                    </span>
                    <ChevronDown className="h-4 w-4 xl:hidden" aria-hidden="true" />
                    <ChevronLeft className="hidden h-4 w-4 xl:block" aria-hidden="true" />
                </button>
            </aside>
        );
    }

    return (
        <aside className="space-y-3 rounded-lg border border-border bg-card p-3 shadow-sm">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                    <div className="text-sm font-semibold text-foreground">
                        {resolveText('calendar.planningTitle', 'Plan next actions')}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {resolveText('calendar.planningHelp', 'Pick existing next actions and place them around your hard landscape.')}
                    </p>
                    <p className={cn("text-xs font-medium", selectedDate ? "text-primary" : "text-muted-foreground")}>
                        {targetLabel}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => onCollapsedChange(true)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    aria-label={collapseLabel}
                    title={collapseLabel}
                >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
            </div>

            {scheduleError && (
                <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                    {scheduleError}
                </div>
            )}

            <div className="divide-y divide-border/70">
                {planningTasks.map((task) => {
                    const dueLabel = getDueLabel(task, resolveText('taskEdit.dueDateLabel', 'Due date'));
                    return (
                        <div
                            key={task.id}
                            data-planning-task-id={task.id}
                            draggable
                            onDragStart={(event) => setCalendarTaskDragData(event.dataTransfer, task.id)}
                            className="flex cursor-grab items-center gap-3 py-2 first:pt-0 last:pb-0"
                        >
                            <div className="min-w-0 flex-1">
                                <div
                                    data-task-id={task.id}
                                    className="truncate text-sm font-medium text-foreground"
                                    title={task.title}
                                >
                                    {task.title}
                                </div>
                                {dueLabel && (
                                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                        {dueLabel}
                                    </div>
                                )}
                            </div>
                            <span
                                className="inline-flex shrink-0"
                                title={selectedDate ? undefined : targetLabel}
                            >
                                <button
                                    type="button"
                                    disabled={!selectedDate}
                                    aria-describedby={!selectedDate ? `calendar-planning-schedule-hint-${task.id}` : undefined}
                                    onClick={() => schedulePlanningTask(task.id)}
                                    className={cn(
                                        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/40",
                                        selectedDate
                                            ? "bg-primary/10 text-primary hover:bg-primary/15"
                                            : "pointer-events-none cursor-not-allowed bg-muted text-muted-foreground"
                                    )}
                                >
                                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                                    {resolveText('calendar.scheduleAction', 'Schedule')}
                                </button>
                            </span>
                            {!selectedDate && (
                                <span id={`calendar-planning-schedule-hint-${task.id}`} className="sr-only">
                                    {targetLabel}
                                </span>
                            )}
                        </div>
                    );
                })}
                {planningTasks.length === 0 && (
                    <div className="py-2 text-sm text-muted-foreground">
                        {resolveText('calendar.planningEmpty', 'No unscheduled next actions.')}
                    </div>
                )}
            </div>
        </aside>
    );
}
