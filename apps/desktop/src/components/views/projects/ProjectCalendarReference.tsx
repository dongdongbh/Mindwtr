import { useState } from 'react';
import { PROJECT_CALENDAR_REFERENCE_PICKER_LIMIT, safeFormatDate, safeParseDate, type Project } from '@mindwtr/core';
import { Calendar } from 'lucide-react';
import { useProjectCalendarReference } from './useProjectCalendarReference';

export function ProjectCalendarReference({ project, readOnly, t }: {
    project: Project; readOnly: boolean; t: (key: string) => string;
}) {
    const calendar = useProjectCalendarReference(project, readOnly);
    const { reference, resolved, pickerOpen, saving, saveError, choices, load } = calendar;
    const [search, setSearch] = useState('');
    const query = search.trim().toLocaleLowerCase();
    const matches = choices.filter(event => `${event.title} ${event.sourceName}`.toLocaleLowerCase().includes(query));
    const visibleChoices = matches.slice(0, PROJECT_CALENDAR_REFERENCE_PICKER_LIMIT);
    const details = resolved?.event ?? reference;
    const dateText = (event: { start: string; end: string; allDay: boolean }) => {
        const start = safeFormatDate(event.start, event.allDay ? 'PP' : 'PPp');
        const lastDay = safeParseDate(event.end);
        if (!lastDay) return start;
        if (event.allDay) lastDay.setDate(lastDay.getDate() - 1);
        const end = safeFormatDate(lastDay, event.allDay ? 'PP' : 'PPp');
        return start === end ? start : `${start} – ${end}`;
    };
    const disabled = readOnly || project.status === 'archived' || saving;
    const actionClass = 'min-h-8 rounded-md border border-border px-3 py-1 text-sm hover:bg-muted/40 disabled:opacity-50';
    return <div className="space-y-2 border-b border-border/50 py-3" data-testid="project-calendar-reference">
        {reference && details && <>
            <h3 className="flex items-center gap-2 text-sm font-medium"><Calendar className="h-4 w-4" aria-hidden="true" />{t('projects.calendarTitle')}</h3>
            <p className="text-xs text-muted-foreground">{t('projects.calendarScheduled')}</p>
            <p className="break-words text-sm">{details.title}</p>
            <p className="text-xs text-muted-foreground">{dateText(details)} · {reference.sourceName}</p>
            {resolved?.status === 'elapsed' && <p className="text-xs text-muted-foreground">{t('projects.calendarElapsed')}</p>}
            {resolved?.status === 'unavailable' && <p className="text-xs text-muted-foreground">{t(load.status === 'idle' || load.status === 'loading' ? 'projects.calendarLastKnown' : 'projects.calendarUnavailable')}</p>}
        </>}
        <div className="flex flex-wrap gap-2">
            <button type="button" className={actionClass} disabled={disabled} aria-expanded={pickerOpen}
                onClick={() => calendar.setPickerOpen(!pickerOpen)}>{t(reference ? 'projects.calendarReplace' : 'projects.calendarLink')}</button>
            {reference && <button type="button" className={actionClass} disabled={disabled} onClick={() => { void calendar.save(null); }}>{t('projects.calendarUnlink')}</button>}
        </div>
        {pickerOpen && <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">{t('projects.calendarHelp')}</p>
            <p className="text-xs font-medium">{t('projects.calendarWindow')}</p>
            <input type="search" value={search} onChange={event => setSearch(event.target.value)} aria-label={t('common.search')}
                placeholder={t('common.search')} className="min-h-9 w-full rounded-md border border-border bg-background px-3 text-sm" />
            {matches.length > PROJECT_CALENDAR_REFERENCE_PICKER_LIMIT && <p className="text-xs text-muted-foreground">{t('projects.calendarLimit')}</p>}
            {load.status === 'loading' && <p className="text-sm">{t('common.loading')}</p>}
            {(load.status === 'error' || (load.status === 'ready' && !load.available)) && <p role="status" className="text-sm">{t('projects.calendarLoadFailed')}</p>}
            {load.status === 'ready' && load.available && matches.length === 0 && <p className="text-sm">{t(query ? 'common.noMatches' : 'projects.calendarEmpty')}</p>}
            {visibleChoices.length > 0 && <ul className="max-h-52 space-y-1 overflow-y-auto">
                {visibleChoices.map((event, index) => <li key={`${event.sourceId}/${event.uid}/${event.recurrenceId ?? ''}/${index}`}>
                    <button type="button" disabled={disabled} className="w-full rounded-md px-2 py-2 text-left hover:bg-muted/50 disabled:opacity-50"
                        onClick={() => { void calendar.save(event); }}>
                        <span className="block break-words text-sm">{event.title}</span>
                        <span className="block text-xs text-muted-foreground">{dateText(event)} · {event.sourceName}</span>
                    </button>
                </li>)}
            </ul>}
            <button type="button" className={actionClass} disabled={saving} onClick={() => calendar.setPickerOpen(false)}>{t('common.cancel')}</button>
        </div>}
        {saveError && <p role="alert" className="text-sm text-destructive">{t('projects.calendarSaveFailed')}</p>}
    </div>;
}
