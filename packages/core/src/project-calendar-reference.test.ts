import { describe, expect, it } from 'vitest';
import { safeParseDate } from './date';
import { parseIcs, type ExternalCalendarSubscription } from './ics';
import { createProjectCalendarReference, getProjectCalendarReferenceCandidates, resolveProjectCalendarReference } from './project-calendar-reference';

const calendars: ExternalCalendarSubscription[] = [{ id: 'feed', name: 'Work', url: 'https://calendar.invalid/feed', enabled: true }];
const now = new Date('2026-11-01T00:00:00Z');
const parse = (entries: string[][], sourceId = 'feed') => parseIcs(['BEGIN:VCALENDAR', 'VERSION:2.0',
    ...entries.flatMap(lines => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']), 'END:VCALENDAR'].join('\n'),
    { sourceId, rangeStart: now, rangeEnd: new Date('2026-12-01T00:00:00Z'), splitByCategory: true });
const meeting = (start = '20261119T140000Z') => ['UID:proposal', 'SUMMARY:Proposal', `DTSTART:${start}`, 'DURATION:PT1H'];

describe('project calendar references', () => {
    it('follows a moved event by source and UID without changing the saved snapshot', () => {
        const [original] = parse([meeting()]);
        const reference = createProjectCalendarReference(original, calendars)!;
        const [moved] = parse([meeting('20261120T150000Z')]);
        expect(moved.id).not.toBe(original.id);
        expect(resolveProjectCalendarReference(reference, [moved], true, now)).toEqual({ status: 'scheduled', event: moved });
        expect(reference.start).toBe(original.start);
        expect(reference).not.toHaveProperty('url');
    });
    it('follows one recurring instance by original recurrence ID, not its new time', () => {
        const series = [...meeting(), 'RRULE:FREQ=DAILY;COUNT=3'];
        const occurrences = parse([series]);
        const reference = createProjectCalendarReference(occurrences[1], calendars)!;
        const moved = parse([series, [...meeting('20261122T170000Z'), 'RECURRENCE-ID:20261120T140000Z']]);
        const result = resolveProjectCalendarReference(reference, moved, true, now);
        expect(result.event?.start).toBe('2026-11-22T17:00:00.000Z');
        expect(result.event?.recurrenceId).toBe('2026-11-20T14:00:00.000Z');
        expect(result.status).toBe('scheduled');
    });
    it.each([
        ['DTSTART;VALUE=DATE:20261119', 'RECURRENCE-ID;VALUE=DATE:20261120', 'DTSTART;VALUE=DATE:20261122', 'DATE:2026-11-20'],
        ['DTSTART:20261119T140000', 'RECURRENCE-ID:20261120T140000', 'DTSTART:20261122T170000', 'FLOAT:2026-11-20T14:00:00'],
    ])('preserves civil occurrence identity for %s', (start, recurrence, movedStart, expected) => {
        const series = ['UID:civil', 'SUMMARY:Calendar', start, 'RRULE:FREQ=DAILY;COUNT=3'];
        const occurrences = parse([series]);
        expect(occurrences[1].recurrenceId).toBe(expected);
        const reference = createProjectCalendarReference(occurrences[1], calendars)!;
        expect(reference).toBeDefined();
        const updated = parse([series, ['UID:civil', 'SUMMARY:Moved', movedStart, recurrence]]);
        expect(resolveProjectCalendarReference(reference, updated, true, now).event?.title).toBe('Moved');
    });

    it('retains root feed identity when a category changes', () => {
        const [event] = parse([[...meeting(), 'CATEGORIES:Office']]);
        const reference = createProjectCalendarReference(event, [{ ...calendars[0], id: 'feed#Office' }])!;
        expect(reference.sourceId).toBe('feed');
        const [moved] = parse([[...meeting(), 'CATEGORIES:Elsewhere']]);
        expect(resolveProjectCalendarReference(reference, [moved], true, now).event).toBe(moved);
    });
    it('does not match another feed, missing calendars, cancelled or ambiguous occurrences', () => {
        const [event] = parse([meeting()]);
        const reference = createProjectCalendarReference(event, calendars)!;
        for (const events of [[], parse([meeting()], 'another'), parse([[...meeting(), 'STATUS:CANCELLED']]), [event, event]])
            expect(resolveProjectCalendarReference(reference, events, true, now)).toEqual({ status: 'unavailable' });
        expect(resolveProjectCalendarReference(reference, [event], false, now)).toEqual({ status: 'unavailable' });
        expect(reference.title).toBe('Proposal');
    });
    it('reports elapsed time without completing or modifying a project', () => {
        const [event] = parse([meeting()]);
        const reference = createProjectCalendarReference(event, calendars)!;
        expect(resolveProjectCalendarReference(reference, [event], true, new Date('2026-11-21T00:00:00Z')).status).toBe('elapsed');
    });
    it('builds a complete candidate set while excluding ambiguous or unstable identities', () => {
        const [event] = parse([meeting()]);
        const events = Array.from({ length: 5000 }, (_, index) => ({ ...event, id: `event-${index}`, uid: `occurrence-${index}` }));
        const candidates = getProjectCalendarReferenceCandidates([...events, { ...events[0], id: 'duplicate' }, { ...event, uid: undefined }], calendars, now);
        expect(candidates).toHaveLength(4999);
        expect(candidates.some(candidate => candidate.uid === 'occurrence-0')).toBe(false);
        expect(candidates.some(candidate => candidate.uid === 'occurrence-4999')).toBe(true);
    });
    it('keeps all-day snapshot dates civil across time zones', () => {
        const previousZone = process.env.TZ;
        try {
            for (const zone of ['Pacific/Honolulu', 'Asia/Tokyo']) {
                process.env.TZ = zone;
                const event = { id: 'all-day', sourceId: 'feed', calendarSourceId: 'feed', uid: 'civil-day', title: 'All day',
                    start: new Date(2026, 10, 19).toISOString(), end: new Date(2026, 10, 20).toISOString(), allDay: true };
                const reference = createProjectCalendarReference(event, calendars);
                expect(reference?.start).toBe('2026-11-19');
                expect(reference?.end).toBe('2026-11-20');
                process.env.TZ = zone === 'Asia/Tokyo' ? 'Pacific/Honolulu' : 'Asia/Tokyo';
                expect(safeParseDate(reference?.start)?.getDate()).toBe(19);
                expect(safeParseDate(reference?.end)?.getDate()).toBe(20);
            }
        } finally {
            if (previousZone === undefined) delete process.env.TZ;
            else process.env.TZ = previousZone;
        }
    });
    it('does not invent stable identity for native events or disabled sources', () => {
        const [event] = parse([meeting()]);
        expect(createProjectCalendarReference({ ...event, uid: undefined }, calendars)).toBeUndefined();
        expect(createProjectCalendarReference(event, [{ ...calendars[0], enabled: false }])).toBeUndefined();
    });
});
