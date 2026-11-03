import { describe, it, expect } from 'vitest';
import { expandCategoryCalendars, parseIcs, parseIcsWithMetadata } from './ics';

describe('ics', () => {
    it('parses a simple timed event', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:event-1',
            'SUMMARY:Team Meeting',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const events = parseIcs(ics, {
            sourceId: 'cal',
            rangeStart: new Date('2025-01-01T00:00:00Z'),
            rangeEnd: new Date('2025-01-02T00:00:00Z'),
        });

        expect(events).toHaveLength(1);
        expect(events[0].title).toBe('Team Meeting');
        expect(events[0].allDay).toBe(false);
        expect(events[0].start).toBe('2025-01-01T09:00:00.000Z');
        expect(events[0].end).toBe('2025-01-01T10:00:00.000Z');
        expect(events[0].id).toBe('cal:event-1:2025-01-01T09:00:00.000Z');
    });

    it('parses all-day date events', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:event-2',
            'SUMMARY:Holiday',
            'DTSTART;VALUE=DATE:20250102',
            'DTEND;VALUE=DATE:20250103',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const rangeStart = new Date(2025, 0, 2, 0, 0, 0, 0);
        const rangeEnd = new Date(2025, 0, 4, 0, 0, 0, 0);
        const events = parseIcs(ics, { sourceId: 'cal', rangeStart, rangeEnd });

        expect(events).toHaveLength(1);
        expect(events[0].title).toBe('Holiday');
        expect(events[0].allDay).toBe(true);
    });

    it('unfolds folded lines', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:event-3',
            'SUMMARY:LongTitle',
            'DESCRIPTION:Line1\\n',
            ' Line2',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const events = parseIcs(ics, {
            sourceId: 'cal',
            rangeStart: new Date('2025-01-01T00:00:00Z'),
            rangeEnd: new Date('2025-01-02T00:00:00Z'),
        });

        expect(events).toHaveLength(1);
        expect(events[0].description).toBe('Line1\nLine2');
    });

    it('expands weekly recurrence with BYDAY and COUNT', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:event-4',
            'SUMMARY:Standup',
            'DTSTART:20250107T090000Z',
            'DTEND:20250107T093000Z',
            'RRULE:FREQ=WEEKLY;BYDAY=MO,TU;COUNT=4',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const events = parseIcs(ics, {
            sourceId: 'cal',
            rangeStart: new Date('2025-01-01T00:00:00Z'),
            rangeEnd: new Date('2025-02-01T00:00:00Z'),
        });

        expect(events.map((e) => e.start)).toEqual([
            '2025-01-07T09:00:00.000Z',
            '2025-01-13T09:00:00.000Z',
            '2025-01-14T09:00:00.000Z',
            '2025-01-20T09:00:00.000Z',
        ]);
    });

    it('does not surface COUNT-limited recurrences long after they ended', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:event-5',
            'SUMMARY:Old Standup',
            'DTSTART:20121001T083000Z',
            'DTEND:20121001T090000Z',
            'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=66',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const events = parseIcs(ics, {
            sourceId: 'cal',
            rangeStart: new Date('2026-01-01T00:00:00Z'),
            rangeEnd: new Date('2026-02-01T00:00:00Z'),
        });

        expect(events).toHaveLength(0);
    });

    it('expands monthly recurrence with ordinal BYDAY', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:event-6',
            'SUMMARY:First Monday',
            'DTSTART:20250106T090000Z',
            'DTEND:20250106T100000Z',
            'RRULE:FREQ=MONTHLY;BYDAY=1MO',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const events = parseIcs(ics, {
            sourceId: 'cal',
            rangeStart: new Date('2025-01-01T00:00:00Z'),
            rangeEnd: new Date('2025-05-01T00:00:00Z'),
        });

        expect(events.map((event) => event.start.slice(0, 10))).toEqual([
            '2025-01-06',
            '2025-02-03',
            '2025-03-03',
            '2025-04-07',
        ]);
    });

    it('expands COUNT-limited monthly recurrence with ordinal BYDAY', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:event-7',
            'SUMMARY:Last Friday',
            'DTSTART:20250131T090000Z',
            'DTEND:20250131T100000Z',
            'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=4',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const events = parseIcs(ics, {
            sourceId: 'cal',
            rangeStart: new Date('2025-01-01T00:00:00Z'),
            rangeEnd: new Date('2025-05-01T00:00:00Z'),
        });

        expect(events.map((event) => event.start.slice(0, 10))).toEqual([
            '2025-01-31',
            '2025-02-28',
            '2025-03-28',
            '2025-04-25',
        ]);
    });

    it('expands yearly all-day recurrence with COUNT', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:event-8',
            'SUMMARY:New Years Day',
            'DTSTART;VALUE=DATE:20250101',
            'RRULE:FREQ=YEARLY;COUNT=5',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const events = parseIcs(ics, {
            sourceId: 'cal',
            rangeStart: new Date('2026-01-01T00:00:00.000Z'),
            rangeEnd: new Date('2026-01-02T00:00:00.000Z'),
        });

        expect(events).toHaveLength(1);
        expect(events[0].title).toBe('New Years Day');
        expect(events[0].allDay).toBe(true);
        expect(events[0].start.slice(0, 10)).toBe('2026-01-01');
        expect(events[0].end.slice(0, 10)).toBe('2026-01-02');
    });

    it('expands yearly recurrence with BYMONTH and ordinal BYDAY', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:event-9',
            'SUMMARY:Third Monday',
            'DTSTART;VALUE=DATE:20250120',
            'RRULE:FREQ=YEARLY;BYMONTH=1;BYDAY=3MO;COUNT=3',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const events = parseIcs(ics, {
            sourceId: 'cal',
            rangeStart: new Date('2025-01-01T00:00:00.000Z'),
            rangeEnd: new Date('2028-01-01T00:00:00.000Z'),
        });

        expect(events.map((event) => event.start.slice(0, 10))).toEqual([
            '2025-01-20',
            '2026-01-19',
            '2027-01-18',
        ]);
    });
});

describe('ics recurrence overrides (#1249)', () => {


    const range = {
        rangeStart: new Date('2026-01-01T00:00:00Z'),
        rangeEnd: new Date('2026-02-01T00:00:00Z'),
    };

    const buildIcs = (events: string[][]) => [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        ...events.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']),
        'END:VCALENDAR',
    ].join('\n');


    const weeklyMaster = (...extra: string[]) => [
        'UID:weekly-1',
        'SUMMARY:Standup',
        'DTSTART;TZID=Europe/London:20260105T090000',
        'DTEND;TZID=Europe/London:20260105T093000',
        'RRULE:FREQ=WEEKLY',
        ...extra,
    ];

    it('shows an edited occurrence once, at its new time', () => {
        const events = parseIcs(buildIcs([
            weeklyMaster(),
            [
                'UID:weekly-1',
                'SUMMARY:Standup (moved)',
                'RECURRENCE-ID;TZID=Europe/London:20260119T090000',
                'DTSTART;TZID=Europe/London:20260119T110000',
                'DTEND;TZID=Europe/London:20260119T113000',
            ],
        ]), { sourceId: 'cal', ...range });

        expect(events.map((event) => [event.start, event.title])).toEqual([
            ['2026-01-05T09:00:00.000Z', 'Standup'],
            ['2026-01-12T09:00:00.000Z', 'Standup'],
            ['2026-01-19T11:00:00.000Z', 'Standup (moved)'],
            ['2026-01-26T09:00:00.000Z', 'Standup'],
        ]);
    });

    it('matches a RECURRENCE-ID written in UTC against a TZID master', () => {
        const events = parseIcs(buildIcs([
            weeklyMaster(),
            [
                'UID:weekly-1',
                'SUMMARY:Standup (moved)',
                'RECURRENCE-ID:20260119T090000Z',
                'DTSTART:20260119T110000Z',
                'DTEND:20260119T113000Z',
            ],
        ]), { sourceId: 'cal', ...range });

        expect(events.map((event) => event.start)).toEqual([
            '2026-01-05T09:00:00.000Z',
            '2026-01-12T09:00:00.000Z',
            '2026-01-19T11:00:00.000Z',
            '2026-01-26T09:00:00.000Z',
        ]);
    });

    it('drops an occurrence listed in EXDATE', () => {
        const events = parseIcs(
            buildIcs([weeklyMaster('EXDATE;TZID=Europe/London:20260119T090000')]),
            { sourceId: 'cal', ...range },
        );

        expect(events.map((event) => event.start)).toEqual([
            '2026-01-05T09:00:00.000Z',
            '2026-01-12T09:00:00.000Z',
            '2026-01-26T09:00:00.000Z',
        ]);
    });

    it('reads every value of a comma-separated EXDATE and every repeated EXDATE line', () => {
        const events = parseIcs(buildIcs([weeklyMaster(
            'EXDATE;TZID=Europe/London:20260112T090000,20260119T090000',
            'EXDATE;TZID=Europe/London:20260126T090000',
        )]), { sourceId: 'cal', ...range });

        expect(events.map((event) => event.start)).toEqual(['2026-01-05T09:00:00.000Z']);
    });

    it('drops an occurrence whose override is STATUS:CANCELLED', () => {

        const events = parseIcs(buildIcs([
            weeklyMaster(),
            ['UID:weekly-1', 'RECURRENCE-ID;TZID=Europe/London:20260119T090000', 'STATUS:CANCELLED'],
        ]), { sourceId: 'cal', ...range });

        expect(events.map((event) => event.start)).toEqual([
            '2026-01-05T09:00:00.000Z',
            '2026-01-12T09:00:00.000Z',
            '2026-01-26T09:00:00.000Z',
        ]);
    });

    it('drops the whole series when the master is STATUS:CANCELLED', () => {
        const events = parseIcs(
            buildIcs([weeklyMaster('STATUS:CANCELLED')]),
            { sourceId: 'cal', ...range },
        );

        expect(events).toEqual([]);
    });

    it('drops an all-day occurrence listed in a VALUE=DATE EXDATE', () => {
        const events = parseIcs(buildIcs([[
            'UID:allday-1',
            'SUMMARY:Bin day',
            'DTSTART;VALUE=DATE:20260105',
            'DTEND;VALUE=DATE:20260106',
            'RRULE:FREQ=WEEKLY',
            'EXDATE;VALUE=DATE:20260112',
        ]]), {
            sourceId: 'cal',
            rangeStart: new Date(2026, 0, 1),
            rangeEnd: new Date(2026, 1, 1),
        });

        expect(events.map((event) => event.start)).toEqual(
            [5, 19, 26].map((day) => new Date(2026, 0, day).toISOString()),
        );
    });

    it('keeps an excluded occurrence counted against COUNT', () => {
        const events = parseIcs(buildIcs([[
            'UID:counted-1',
            'SUMMARY:Standup',
            'DTSTART;TZID=Europe/London:20260105T090000',
            'DTEND;TZID=Europe/London:20260105T093000',
            'RRULE:FREQ=WEEKLY;COUNT=3',
            'EXDATE;TZID=Europe/London:20260112T090000',
        ]]), { sourceId: 'cal', ...range });

        expect(events.map((event) => event.start)).toEqual([
            '2026-01-05T09:00:00.000Z',
            '2026-01-19T09:00:00.000Z',
        ]);
    });
});

describe('ics categories', () => {
    const subscription = { id: 'cal', name: 'Shared feed', url: 'https://example.test/f.ics', enabled: true };
    const range = {
        rangeStart: new Date('2025-01-01T00:00:00Z'),
        rangeEnd: new Date('2025-01-02T00:00:00Z'),
    };

    const buildIcs = (events: string[][]) => [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        ...events.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']),
        'END:VCALENDAR',
    ].join('\n');

    const timedEvent = (uid: string, categories?: string) => [
        `UID:${uid}`,
        `SUMMARY:${uid}`,
        'DTSTART:20250101T090000Z',
        'DTEND:20250101T100000Z',
        ...(categories ? [`CATEGORIES:${categories}`] : []),
    ];

    it('leaves categories alone unless the caller asks to split', () => {
        const events = parseIcs(buildIcs([timedEvent('a', 'Work')]), { sourceId: 'cal', ...range });

        expect(events.map((event) => event.sourceId)).toEqual(['cal']);
        expect(expandCategoryCalendars(subscription, events)).toEqual([subscription]);
    });

    it('gives each category its own calendar, and keeps the feed for uncategorized events', () => {
        const ics = buildIcs([
            timedEvent('a', 'Work'),
            timedEvent('b', 'Personal'),
            timedEvent('c'),
        ]);

        const events = parseIcs(ics, { sourceId: 'cal', ...range, splitByCategory: true });
        expect(events.map((event) => event.sourceId).sort()).toEqual(['cal', 'cal#Personal', 'cal#Work']);

        const calendars = expandCategoryCalendars(subscription, events);
        expect(calendars.map((calendar) => [calendar.id, calendar.name])).toEqual([
            ['cal', 'Shared feed'],
            ['cal#Personal', 'Personal'],
            ['cal#Work', 'Work'],
        ]);

        expect(calendars.every((calendar) => calendar.color === undefined)).toBe(true);
    });

    it('drops the feed itself once every event carries a category', () => {
        const events = parseIcs(buildIcs([timedEvent('a', 'Work'), timedEvent('b', 'Work')]), {
            sourceId: 'cal',
            ...range,
            splitByCategory: true,
        });

        expect(expandCategoryCalendars(subscription, events).map((calendar) => calendar.id)).toEqual(['cal#Work']);
    });

    it('takes the first category only, and honours escaped commas', () => {
        const events = parseIcs(buildIcs([timedEvent('a', 'Berlin\\, DE,Travel')]), {
            sourceId: 'cal',
            ...range,
            splitByCategory: true,
        });

        expect(events[0].sourceId).toBe('cal#Berlin, DE');
    });

    it('stays one calendar when a feed uses categories as free-form tags', () => {
        const tagged = Array.from({ length: 9 }, (_, index) => timedEvent(`e${index}`, `tag-${index}`));
        const events = parseIcs(buildIcs(tagged), { sourceId: 'cal', ...range, splitByCategory: true });

        expect(new Set(events.map((event) => event.sourceId))).toEqual(new Set(['cal']));
        expect(expandCategoryCalendars(subscription, events)).toEqual([subscription]);
    });

    it('keeps the full-feed category roster while paging a range with only one category', () => {
        const ics = buildIcs([
            timedEvent('january', 'Work'),
            ['UID:february', 'SUMMARY:february', 'DTSTART:20250205T090000Z', 'DTEND:20250205T100000Z', 'CATEGORIES:Personal'],
        ]);

        const january = parseIcsWithMetadata(ics, {
            sourceId: 'cal',
            rangeStart: new Date('2025-01-01T00:00:00Z'),
            rangeEnd: new Date('2025-02-01T00:00:00Z'),
            splitByCategory: true,
        });

        expect(january.events.map((event) => event.sourceId)).toEqual(['cal#Work']);
        expect(expandCategoryCalendars(subscription, january.events, january.categoryInfo)
            .map((calendar) => calendar.id)).toEqual(['cal#Personal', 'cal#Work']);
    });
});

describe('ics colors', () => {
    const range = {
        rangeStart: new Date('2025-01-01T00:00:00Z'),
        rangeEnd: new Date('2025-01-02T00:00:00Z'),
    };

    it('reads an RFC 7986 calendar COLOR name', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'COLOR:turquoise',
            'BEGIN:VEVENT',
            'UID:a',
            'SUMMARY:a',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        expect(parseIcsWithMetadata(ics, { sourceId: 'cal', ...range }).calendarColor).toBe('#40E0D0');
    });

    it('reads X-APPLE-CALENDAR-COLOR hex, stripping alpha', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'X-APPLE-CALENDAR-COLOR:#FF00807F',
            'BEGIN:VEVENT',
            'UID:a',
            'SUMMARY:a',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        expect(parseIcsWithMetadata(ics, { sourceId: 'cal', ...range }).calendarColor).toBe('#FF0080');
    });

    it('prefers X-APPLE-CALENDAR-COLOR over an RFC 7986 COLOR name when both are present', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'COLOR:turquoise',
            'X-APPLE-CALENDAR-COLOR:#123456',
            'BEGIN:VEVENT',
            'UID:a',
            'SUMMARY:a',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        expect(parseIcsWithMetadata(ics, { sourceId: 'cal', ...range }).calendarColor).toBe('#123456');
    });

    it('drops malformed calendar colors silently', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'COLOR:not-a-real-color',
            'X-APPLE-CALENDAR-COLOR:not-hex',
            'BEGIN:VEVENT',
            'UID:a',
            'SUMMARY:a',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        expect(parseIcsWithMetadata(ics, { sourceId: 'cal', ...range }).calendarColor).toBeUndefined();
    });

    it('does not read a COLOR inside a nested VTODO as the calendar color (#974)', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VTODO',
            'UID:t1',
            'COLOR:tomato',
            'END:VTODO',
            'BEGIN:VEVENT',
            'UID:a',
            'SUMMARY:a',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        expect(parseIcsWithMetadata(ics, { sourceId: 'cal', ...range }).calendarColor).toBeUndefined();
    });

    it('still reads a genuine calendar-level COLOR that comes after a nested VTODO', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VTODO',
            'UID:t1',
            'COLOR:tomato',
            'END:VTODO',
            'COLOR:turquoise',
            'BEGIN:VEVENT',
            'UID:a',
            'SUMMARY:a',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        expect(parseIcsWithMetadata(ics, { sourceId: 'cal', ...range }).calendarColor).toBe('#40E0D0');
    });

    it('converts a signed 32-bit ARGB X-FOSSIFY-CATEGORY-COLOR to #RRGGBB', () => {

        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:a',
            'SUMMARY:a',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'CATEGORIES:Work',
            'X-FOSSIFY-CATEGORY-COLOR:-16776961',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const result = parseIcsWithMetadata(ics, { sourceId: 'cal', ...range, splitByCategory: true });
        expect(result.categoryInfo.colors).toEqual({ Work: '#0000FF' });
    });

    it('drops an X-FOSSIFY-CATEGORY-COLOR that is not a plain integer, instead of truncating it', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:a',
            'SUMMARY:a',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'CATEGORIES:Work',
            'X-FOSSIFY-CATEGORY-COLOR:12abc',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const result = parseIcsWithMetadata(ics, { sourceId: 'cal', ...range, splitByCategory: true });
        expect(result.categoryInfo.colors).toBeUndefined();
    });

    it('keeps the first category color across paged ranges', () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:january',
            'SUMMARY:january',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'CATEGORIES:Work',
            'X-FOSSIFY-CATEGORY-COLOR:-16776961',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:february',
            'SUMMARY:february',
            'DTSTART:20250205T090000Z',
            'DTEND:20250205T100000Z',
            'CATEGORIES:Work',
            'X-FOSSIFY-CATEGORY-COLOR:-65536',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const february = parseIcsWithMetadata(ics, {
            sourceId: 'cal',
            rangeStart: new Date('2025-02-01T00:00:00Z'),
            rangeEnd: new Date('2025-03-01T00:00:00Z'),
            splitByCategory: true,
        });


        expect(february.categoryInfo.colors).toEqual({ Work: '#0000FF' });
    });

    it('carries the feed color through expandCategoryCalendars as feedColor, never color', () => {
        const subscription = { id: 'cal', name: 'Feed', url: 'https://example.test/f.ics', enabled: true };
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'X-APPLE-CALENDAR-COLOR:#123456',
            'BEGIN:VEVENT',
            'UID:a',
            'SUMMARY:a',
            'DTSTART:20250101T090000Z',
            'DTEND:20250101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');

        const result = parseIcsWithMetadata(ics, { sourceId: 'cal', ...range });
        const [calendar] = expandCategoryCalendars(subscription, result.events, result.categoryInfo, result.calendarColor);
        expect(calendar.feedColor).toBe('#123456');
        expect(calendar.color).toBeUndefined();
    });
});
