import { format } from 'date-fns';
import type { DragEvent } from 'react';
import { Check, Clock, MoreHorizontal, Plus, X } from 'lucide-react';
import { getProjectedRecurrenceDisplayLabel, hasTimeComponent, isProjectedRecurringTask, safeFormatDate, safeParseDate } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { reportError } from '../../../lib/report-error';
import { setCalendarTaskDragData } from '../../../lib/calendar-task-drag';
import { TimeInput } from '../../ui/TimeInput';
import type { DesktopCalendarController } from './useDesktopCalendarController';

type CalendarSelectedDayPanelController = Pick<
    DesktopCalendarController,
    | 'beginEditScheduledTime'
    | 'calendarNameById'
    | 'cancelEditScheduledTime'
    | 'closeSelectedDay'
    | 'commitEditScheduledTime'
    | 'createTaskFromExternalEvent'
    | 'editingTimeTaskId'
    | 'editingTimeValue'
    | 'getExternalCalendarColor'
    | 'getTaskAccentColor'
    | 'isExternalLoading'
    | 'markTaskDone'
    | 'openQuickAddForDate'
    | 'openTaskFromCalendar'
    | 'resolveText'
    | 'scheduleCandidates'
    | 'scheduleError'
    | 'scheduleQuery'
    | 'scheduleTaskOnSelectedDate'
    | 'selectedAllDayEvents'
    | 'selectedDate'
    | 'selectedExternalEvents'
    | 'selectedTaskRows'
    | 'selectedTimedEvents'
    | 't'
    | 'timeEstimateToMinutes'
    | 'updateEditingTimeValue'
    | 'updateScheduleQuery'
    | 'updateTask'
>;

type CalendarSelectedDayPanelProps = {
    controller: CalendarSelectedDayPanelController;
};

export function CalendarSelectedDayPanel({ controller }: CalendarSelectedDayPanelProps) {
    const {
        beginEditScheduledTime,
        calendarNameById,
        cancelEditScheduledTime,
        closeSelectedDay,
        commitEditScheduledTime,
        createTaskFromExternalEvent,
        editingTimeTaskId,
        editingTimeValue,
        getExternalCalendarColor,
        getTaskAccentColor,
        isExternalLoading,
        markTaskDone,
        openQuickAddForDate,
        openTaskFromCalendar,
        resolveText,
        scheduleCandidates,
        scheduleError,
        scheduleQuery,
        scheduleTaskOnSelectedDate,
        selectedAllDayEvents,
        selectedDate,
        selectedExternalEvents,
        selectedTaskRows,
        selectedTimedEvents,
        t,
        timeEstimateToMinutes,
        updateEditingTimeValue,
        updateScheduleQuery,
        updateTask,
    } = controller;
    const handleTaskDragStart = (event: DragEvent<HTMLElement>, taskId: string, kind: 'scheduled' | 'deadline') => {
        event.stopPropagation();
        setCalendarTaskDragData(event.dataTransfer, taskId, { itemKind: kind });
    };

    if (!selectedDate) return null;

    return (


        <div className="rounded-lg border border-border bg-card [container-type:inline-size]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                    <div className="text-sm font-semibold">{format(selectedDate, 'PPPP')}</div>
                    <div className="text-xs text-muted-foreground">
                        {selectedTaskRows.length + selectedExternalEvents.length} {resolveText('calendar.items', 'items')}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/40"
                        onClick={() => openQuickAddForDate(selectedDate)}
                    >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('calendar.addTask')}
                    </button>
                    <button
                        type="button"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        onClick={closeSelectedDay}
                        aria-label={t('common.close')}
                        title={t('common.close')}
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
            </div>

            <div className="grid gap-4 p-4 [@container_(min-width:58rem)]:grid-cols-[minmax(0,1fr)_18rem]">
                <div className="space-y-5">
                    {selectedAllDayEvents.length > 0 && (
                        <section className="space-y-2">
                            <h3 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{t('calendar.allDay')}</h3>
                            <div className="space-y-1">
                                {selectedAllDayEvents.map((event) => {
                                    const sourceLabel = calendarNameById.get(event.sourceId);
                                    return (
                                        <div
                                            key={event.id}
                                            className="flex items-center gap-3 rounded-md border-l-[3px] bg-muted/50 px-3 py-2 text-sm"
                                            style={{ borderLeftColor: getExternalCalendarColor(event.sourceId) }}
                                        >
                                            <span className="min-w-0 flex-1 truncate">{event.title}</span>
                                            {sourceLabel && <span className="truncate text-xs text-muted-foreground">{sourceLabel}</span>}
                                            <button
                                                type="button"
                                                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 text-xs font-medium text-primary hover:bg-primary/15 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                                onClick={() => void createTaskFromExternalEvent(event)}
                                                aria-label={`${resolveText('calendar.createTaskFromEvent', 'Create task')}: ${event.title}`}
                                                title={resolveText('calendar.createTaskFromEvent', 'Create task')}
                                            >
                                                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                                {resolveText('calendar.createTaskFromEvent', 'Create task')}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    )}

                    <section className="space-y-2">
                        <h3 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{t('calendar.events')}</h3>
                        <div className="space-y-1">
                            {isExternalLoading && (
                                <div className="rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                                    {resolveText('common.loading', 'Loading...')}
                                </div>
                            )}
                            {selectedTimedEvents.map((event) => {
                                const start = safeParseDate(event.start);
                                const end = safeParseDate(event.end);
                                const timeLabel = start && end
                                    ? `${safeFormatDate(start, 'p')}-${safeFormatDate(end, 'p')}`
                                    : '';
                                const sourceLabel = calendarNameById.get(event.sourceId);
                                return (
                                    <div
                                        key={event.id}
                                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border-l-[3px] bg-muted/50 px-3 py-2 text-sm"
                                        style={{ borderLeftColor: getExternalCalendarColor(event.sourceId) }}
                                    >
                                        <span className="w-28 shrink-0 text-xs font-medium text-muted-foreground">{timeLabel}</span>
                                        {                                                                                         }
                                        <span className="min-w-[8rem] flex-1 truncate">{event.title}</span>
                                        {sourceLabel && <span className="truncate text-xs text-muted-foreground">{sourceLabel}</span>}
                                        <button
                                            type="button"
                                            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 text-xs font-medium text-primary hover:bg-primary/15 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                            onClick={() => void createTaskFromExternalEvent(event)}
                                            aria-label={`${resolveText('calendar.createTaskFromEvent', 'Create task')}: ${event.title}`}
                                            title={resolveText('calendar.createTaskFromEvent', 'Create task')}
                                        >
                                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                            {resolveText('calendar.createTaskFromEvent', 'Create task')}
                                        </button>
                                    </div>
                                );
                            })}
                            {!isExternalLoading && selectedTimedEvents.length === 0 && (
                                <div className="rounded-md bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                                    {t('calendar.noTasks')}
                                </div>
                            )}
                        </div>
                    </section>

                    <section className="space-y-2">
                        <h3 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{resolveText('calendar.tasks', 'Tasks')}</h3>
                        <div className="space-y-1">
                            {selectedTaskRows.map(({ id, kind, task, start }) => {
                                const projected = isProjectedRecurringTask(task);
                                const projectedLabel = projected
                                    ? getProjectedRecurrenceDisplayLabel(task, resolveText('calendar.projectedRecurrence', 'Projected'), safeFormatDate)
                                    : '';
                                const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
                                const isAllDayScheduled = kind === 'scheduled' && !hasTimeComponent(task.startTime);
                                const end = start && kind === 'scheduled' && !isAllDayScheduled
                                    ? new Date(start.getTime() + durationMinutes * 60 * 1000)
                                    : null;
                                const timeLabel = isAllDayScheduled
                                    ? t('calendar.allDay')
                                    : start && end
                                    ? `${safeFormatDate(start, 'p')}-${safeFormatDate(end, 'p')}`
                                    : kind === 'deadline'
                                        ? hasTimeComponent(task.dueDate) && start
                                            ? `${t('calendar.due')} ${safeFormatDate(start, 'p')}`
                                            : t('calendar.deadline')
                                        : '';
                                const isEditing = editingTimeTaskId === task.id;
                                const draggable = !projected && !(hasTimeComponent(task.dueDate) && (kind === 'deadline' || !hasTimeComponent(task.startTime)));

                                return (
                                    <div
                                        key={id}
                                        data-task-id={task.id}
                                        draggable={draggable}
                                        onDragStart={(event) => {
                                            if (draggable) handleTaskDragStart(event, task.id, kind);
                                        }}
                                        className={cn(
                                            "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted/50",
                                            projected
                                                ? "border border-dashed border-primary/50 bg-primary/5"
                                                : kind === 'scheduled' ? "bg-primary/5" : "border-l-[3px] border-muted-foreground/60 bg-background/60"
                                        )}
                                        style={!projected && kind !== 'scheduled'
                                            ? { borderLeftColor: getTaskAccentColor(task) }
                                            : undefined}
                                    >
                                        <button
                                            type="button"
                                            {...(!projected ? { 'data-task-edit-trigger': true } : {})}
                                            disabled={projected}
                                            onClick={() => {
                                                if (!projected) openTaskFromCalendar(task);
                                            }}
                                            className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-left text-foreground focus:outline-none focus:underline"
                                        >
                                            <span className="inline-flex w-28 shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
                                                {kind === 'scheduled' && <Clock className="h-3 w-3" aria-hidden="true" />}
                                                {timeLabel}
                                            </span>
                                            {
                                                                                                                  }
                                            <span className="min-w-[8rem] flex-1 truncate">{task.title}</span>
                                        </button>
                                        {projected && (
                                            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                                                {projectedLabel}
                                            </span>
                                        )}
                                        {!projected && isEditing ? (
                                            <div className="flex shrink-0 items-center gap-1">
                                                <TimeInput
                                            aria-label={t('calendar.time')}
                                                    value={editingTimeValue}
                                                    onChange={updateEditingTimeValue}
                                                    className="h-8 rounded border border-border bg-background px-2 text-xs"
                                                />
                                                <button
                                                    type="button"
                                                    className="h-8 rounded bg-primary px-2 text-xs text-primary-foreground"
                                                    onClick={commitEditScheduledTime}
                                                >
                                                    {t('common.save')}
                                                </button>
                                                <button
                                                    type="button"
                                                    className="h-8 rounded bg-muted px-2 text-xs hover:bg-muted/80"
                                                    onClick={cancelEditScheduledTime}
                                                >
                                                    {t('common.cancel')}
                                                </button>
                                            </div>
                                        ) : !projected ? (
                                            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                                <button
                                                    type="button"
                                                    className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-success/15 text-success hover:bg-success/25"
                                                    onClick={() => markTaskDone(task.id)}
                                                    aria-label={t('status.done')}
                                                    title={t('status.done')}
                                                >
                                                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                                </button>
                                                {kind === 'scheduled' && (
                                                    <button
                                                        type="button"
                                                        className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground hover:text-foreground"
                                                        onClick={() => beginEditScheduledTime(task.id)}
                                                        aria-label={t('common.edit')}
                                                        title={t('common.edit')}
                                                    >
                                                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                                                    </button>
                                                )}
                                                {kind === 'scheduled' && (
                                                    <button
                                                        type="button"
                                                        className="h-8 rounded-md bg-muted px-2 text-xs text-muted-foreground hover:text-foreground"
                                                        onClick={() => updateTask(task.id, { startTime: undefined, relativeStartOffset: undefined })
                                                            .catch((error) => reportError('Failed to clear scheduled time', error))}
                                                        title={t('calendar.unschedule')}
                                                    >
                                                        {t('calendar.unschedule')}
                                                    </button>
                                                )}
                                            </div>
                                        ) : null}
                                    </div>
                                );
                            })}
                            {selectedTaskRows.length === 0 && (
                                <div className="rounded-md bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                                    {t('calendar.noTasks')}
                                </div>
                            )}
                        </div>
                    </section>
                </div>

                <aside className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
                    <div>
                        <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                            {t('calendar.scheduleResults')}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {resolveText('calendar.scheduleHelp', 'Find a task and set its calendar time.')}
                        </p>
                    </div>
                    <input
                        type="text"
                        value={scheduleQuery}
                        onChange={(e) => updateScheduleQuery(e.target.value)}
                        placeholder={t('calendar.schedulePlaceholder')}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    {scheduleError && (
                        <div className="text-xs text-destructive">{scheduleError}</div>
                    )}
                    {scheduleCandidates.length > 0 && (
                        <div className="space-y-1">
                            {scheduleCandidates.map((task) => (
                                <button
                                    key={task.id}
                                    type="button"
                                    className="block w-full truncate rounded-md bg-muted px-2 py-1.5 text-left text-xs hover:bg-muted/80"
                                    onClick={() => scheduleTaskOnSelectedDate(task.id)}
                                    title={task.title}
                                >
                                    {task.title}
                                </button>
                            ))}
                        </div>
                    )}
                </aside>
            </div>
        </div>
    );
}
