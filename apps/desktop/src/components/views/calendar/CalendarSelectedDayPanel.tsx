import { format } from 'date-fns';
import { Check, Clock, MoreHorizontal, Plus, X } from 'lucide-react';
import { safeFormatDate, safeParseDate } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { reportError } from '../../../lib/report-error';
import type { DesktopCalendarController } from './useDesktopCalendarController';

type CalendarSelectedDayPanelController = Pick<
    DesktopCalendarController,
    | 'beginEditScheduledTime'
    | 'calendarNameById'
    | 'cancelEditScheduledTime'
    | 'commitEditScheduledTime'
    | 'editingTimeTaskId'
    | 'editingTimeValue'
    | 'externalCalendarColor'
    | 'isExternalLoading'
    | 'markTaskDone'
    | 'openQuickAddForDate'
    | 'openTaskFromCalendar'
    | 'resetSelectedDayState'
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
    | 'setEditingTimeValue'
    | 'setScheduleError'
    | 'setScheduleQuery'
    | 'setSelectedDate'
    | 't'
    | 'timeEstimateToMinutes'
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
        commitEditScheduledTime,
        editingTimeTaskId,
        editingTimeValue,
        externalCalendarColor,
        isExternalLoading,
        markTaskDone,
        openQuickAddForDate,
        openTaskFromCalendar,
        resetSelectedDayState,
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
        setEditingTimeValue,
        setScheduleError,
        setScheduleQuery,
        setSelectedDate,
        t,
        timeEstimateToMinutes,
        updateTask,
    } = controller;

    if (!selectedDate) return null;

    return (
        <div className="rounded-lg border border-border bg-card">
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
                        onClick={() => {
                            setSelectedDate(null);
                            resetSelectedDayState();
                        }}
                        aria-label={t('common.close')}
                        title={t('common.close')}
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
            </div>

            <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
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
                                            style={{ borderLeftColor: externalCalendarColor(event.sourceId) }}
                                        >
                                            <span className="min-w-0 flex-1 truncate">{event.title}</span>
                                            {sourceLabel && <span className="truncate text-xs text-muted-foreground">{sourceLabel}</span>}
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
                                        className="flex items-center gap-3 rounded-md border-l-[3px] bg-muted/50 px-3 py-2 text-sm"
                                        style={{ borderLeftColor: externalCalendarColor(event.sourceId) }}
                                    >
                                        <span className="w-28 shrink-0 text-xs font-medium text-muted-foreground">{timeLabel}</span>
                                        <span className="min-w-0 flex-1 truncate">{event.title}</span>
                                        {sourceLabel && <span className="truncate text-xs text-muted-foreground">{sourceLabel}</span>}
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
                                const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
                                const end = start && kind === 'scheduled'
                                    ? new Date(start.getTime() + durationMinutes * 60 * 1000)
                                    : null;
                                const timeLabel = start && end
                                    ? `${safeFormatDate(start, 'p')}-${safeFormatDate(end, 'p')}`
                                    : kind === 'deadline'
                                        ? t('calendar.deadline')
                                        : '';
                                const isEditing = editingTimeTaskId === task.id;

                                return (
                                    <div
                                        key={id}
                                        data-task-id={task.id}
                                        className={cn(
                                            "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted/50",
                                            kind === 'scheduled' ? "bg-primary/5" : "border-l-[3px] border-destructive/70 bg-background/60"
                                        )}
                                    >
                                        <button
                                            type="button"
                                            data-task-edit-trigger
                                            onClick={() => openTaskFromCalendar(task)}
                                            className="min-w-0 flex-1 truncate text-left text-foreground focus:outline-none focus:underline"
                                        >
                                            <span className="mr-2 inline-flex w-28 items-center gap-1 text-xs font-medium text-muted-foreground">
                                                {kind === 'scheduled' && <Clock className="h-3 w-3" aria-hidden="true" />}
                                                {timeLabel}
                                            </span>
                                            {task.title}
                                        </button>
                                        {isEditing ? (
                                            <div className="flex shrink-0 items-center gap-1">
                                                <input
                                                    type="time"
                                                    value={editingTimeValue}
                                                    onChange={(e) => setEditingTimeValue(e.target.value)}
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
                                        ) : (
                                            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                                <button
                                                    type="button"
                                                    className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300"
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
                                                        onClick={() => updateTask(task.id, { startTime: undefined })
                                                            .catch((error) => reportError('Failed to clear scheduled time', error))}
                                                        title={t('calendar.unschedule')}
                                                    >
                                                        {t('calendar.unschedule')}
                                                    </button>
                                                )}
                                            </div>
                                        )}
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
                        onChange={(e) => {
                            setScheduleQuery(e.target.value);
                            if (scheduleError) setScheduleError(null);
                        }}
                        placeholder={t('calendar.schedulePlaceholder')}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    {scheduleError && (
                        <div className="text-xs text-red-400">{scheduleError}</div>
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
