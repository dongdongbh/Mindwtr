import { safeParseDate } from './date';
import { tFallback, type TranslateFn } from './i18n';
import type { ExternalCalendarEvent, ExternalCalendarSubscription } from './ics';
import type { ProjectCalendarReference } from './types';
import { normalizeProjectCalendarReference } from './project-calendar-reference-schema';

const calendarCivilDate = (value: string): string => {
    const date = safeParseDate(value);
    return date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : value;
};

export function createProjectCalendarReference(
    event: ExternalCalendarEvent,
    calendars: readonly ExternalCalendarSubscription[],
): ProjectCalendarReference | undefined {
    if (!event.uid || !event.calendarSourceId) return undefined;
    const source = calendars.find(calendar => calendar.id === event.sourceId)
        ?? calendars.find(calendar => calendar.id === event.calendarSourceId);
    if (!source?.enabled) return undefined;
    return normalizeProjectCalendarReference({
        sourceId: event.calendarSourceId, uid: event.uid,
        ...(event.recurrenceId ? { recurrenceId: event.recurrenceId } : {}),
        sourceName: source.name, title: event.title,
        start: event.allDay ? calendarCivilDate(event.start) : event.start,
        end: event.allDay ? calendarCivilDate(event.end) : event.end, allDay: event.allDay,
    }) ?? undefined;
}

export const PROJECT_CALENDAR_REFERENCE_PICKER_LIMIT = 200;

export function getProjectCalendarReferenceCandidates(
    events: readonly ExternalCalendarEvent[],
    calendars: readonly ExternalCalendarSubscription[],
    now: Date = new Date(),
): ProjectCalendarReference[] {
    const identities = new Map<string, number>();
    const identity = (event: ExternalCalendarEvent) => JSON.stringify([event.calendarSourceId, event.uid, event.recurrenceId ?? null]);
    for (const event of events) {
        const occurrence = identity(event);
        identities.set(occurrence, (identities.get(occurrence) ?? 0) + 1);
    }
    const bySource = new Map(calendars.map(calendar => [calendar.id, calendar]));
    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + 90);
    return events.flatMap(event => {
        if (identities.get(identity(event)) !== 1 || Date.parse(event.start) < now.getTime() || Date.parse(event.start) >= horizon.getTime()) return [];
        const source = bySource.get(event.sourceId) ?? (event.calendarSourceId ? bySource.get(event.calendarSourceId) : undefined);
        const reference = source ? createProjectCalendarReference(event, [source]) : undefined;
        return reference ? [reference] : [];
    }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function resolveProjectCalendarReference(
    reference: ProjectCalendarReference,
    events: readonly ExternalCalendarEvent[],
    available: boolean,
    now: Date = new Date(),
): { status: 'scheduled' | 'elapsed' | 'unavailable'; event?: ExternalCalendarEvent } {
    if (!available) return { status: 'unavailable' };
    const matches = events.filter(event => event.calendarSourceId === reference.sourceId
        && event.uid === reference.uid && event.recurrenceId === reference.recurrenceId);
    if (matches.length !== 1) return { status: 'unavailable' };
    const event = matches[0];
    if (!Number.isFinite(Date.parse(event.end))) return { status: 'unavailable' };
    return { status: Date.parse(event.end) <= now.getTime() ? 'elapsed' : 'scheduled', event };
}

export function getProjectCalendarReferenceSummary(reference: ProjectCalendarReference, t: TranslateFn): string {
    const at = safeParseDate(reference.start);
    const date = at
        ? reference.allDay ? at.toLocaleDateString() : at.toLocaleString()
        : reference.start;
    return `${tFallback(t, 'projects.calendarReviewStep', 'Review scheduled next step')}: ${reference.title} · ${date} · ${tFallback(t, 'projects.calendarLastKnown', 'Last known event details')}`;
}
