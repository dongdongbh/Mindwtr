import type {
    ExternalCalendarEvent,
    ExternalCalendarSubscription,
} from './ics';
import { hasCalendarPushTaskMarker } from './calendar-scheduling';
import type { Area } from './types';
import type { AreaFilterSelection } from './area-filter';

const MINDWTR_PUSHED_EVENT_PREFIX = 'mindwtr: ';
const MINDWTR_MIRROR_CALENDAR_NAMES = new Set([
    'mindwtr',
    'mindwtr calendar',
    'mindwtrcal',
]);

export type ExternalCalendarSourceResult = {
    calendars: ExternalCalendarSubscription[];
    events: ExternalCalendarEvent[];
};


export function calendarMatchesAreaSelection(
    calendar: Pick<ExternalCalendarSubscription, 'areaIds'>,
    selection: AreaFilterSelection,
    areas: readonly Area[],
): boolean {
    const active = new Set(areas.filter((area) => !area.deletedAt).map((area) => area.id));
    const associated = Array.isArray(calendar.areaIds)
        ? calendar.areaIds.filter((id) => active.has(id))
        : [];
    if (associated.length === 0) return true;
    const surviving = associated.filter((id) => !selection.excluded.includes(id));
    if (surviving.length === 0) return false;
    if (selection.included.length === 0) return true;
    return surviving.some((id) => selection.included.includes(id));
}

export function filterCalendarEventsForAreas(
    events: readonly ExternalCalendarEvent[],
    calendars: readonly ExternalCalendarSubscription[],
    selection: AreaFilterSelection,
    areas: readonly Area[],
): ExternalCalendarEvent[] {
    const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
    const visibleIds = new Set(calendars
        .filter((calendar) => calendar.enabled && calendarMatchesAreaSelection(calendar, selection, areas))
        .map((calendar) => calendar.id));
    return events.filter((event) => {
        const calendar = byId.get(event.sourceId) ?? byId.get(event.sourceId.split('#')[0]);
        return !calendar || visibleIds.has(calendar.id);
    });
}

export function isMindwtrMirrorCalendar(
    calendar: Pick<ExternalCalendarSubscription, 'name'>,
): boolean {
    return MINDWTR_MIRROR_CALENDAR_NAMES.has(
        calendar.name.trim().toLowerCase().replace(/\s+/g, ' '),
    );
}

export function isMindwtrMirrorEvent(
    event: Pick<ExternalCalendarEvent, 'sourceId' | 'title' | 'description'>,
    calendarById: ReadonlyMap<string, ExternalCalendarSubscription>,
): boolean {
    const calendar = calendarById.get(event.sourceId);
    if (calendar && isMindwtrMirrorCalendar(calendar)) return true;
    if (hasCalendarPushTaskMarker(event.description)) return true;
    return event.title.trim().toLowerCase().startsWith(
        MINDWTR_PUSHED_EVENT_PREFIX,
    );
}

export function mergeExternalCalendarSources(
    sources: readonly ExternalCalendarSourceResult[],
): ExternalCalendarSourceResult {
    const calendarById = new Map<string, ExternalCalendarSubscription>();
    for (const source of sources) {
        for (const calendar of source.calendars) {
            calendarById.set(calendar.id, calendar);
        }
    }

    const eventByKey = new Map<string, ExternalCalendarEvent>();
    for (const source of sources) {
        for (const event of source.events) {
            if (isMindwtrMirrorEvent(event, calendarById)) continue;
            eventByKey.set(
                `${event.sourceId}:${event.id}:${event.start}:${event.end}`,
                event,
            );
        }
    }

    const events = Array.from(eventByKey.values());
    events.sort((left, right) => {
        if (left.start === right.start) {
            return left.title.localeCompare(right.title);
        }
        return left.start.localeCompare(right.start);
    });

    return {
        calendars: Array.from(calendarById.values()).filter(
            (calendar) => !isMindwtrMirrorCalendar(calendar),
        ),
        events,
    };
}
