import { addDays, addMonths, addWeeks, differenceInCalendarDays, startOfWeek } from 'date-fns';

export interface ExternalCalendarSubscription {
    id: string;
    name: string;
    url: string;
    enabled: boolean;
}

export interface ExternalCalendarEvent {
    /** Stable id: `${sourceId}:${uid}:${startIso}` */
    id: string;
    sourceId: string;
    /** Device calendar event id when the event came from the OS calendar provider. */
    nativeEventId?: string;
    title: string;
    start: string; // ISO string
    end: string; // ISO string
    allDay: boolean;
    description?: string;
    location?: string;
}

export interface ParseIcsOptions {
    sourceId: string;
    rangeStart: Date;
    rangeEnd: Date;
    maxOccurrencesPerEvent?: number;
    maxTotalOccurrences?: number;
}

type IcsParams = Record<string, string>;

type ParsedRRule = {
    freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    interval: number;
    until?: Date;
    count?: number;
    byDay?: Array<{
        weekday: number; // 0=Sun..6=Sat
        ordinal?: number;
    }>;
    byMonthDay?: number[];
};

type ParsedVEvent = {
    uid: string;
    summary: string;
    description?: string;
    location?: string;
    start: Date;
    end: Date;
    allDay: boolean;
    rrule?: ParsedRRule;
};

function unfoldIcsLines(input: string): string[] {
    const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rawLines = normalized.split('\n');
    const lines: string[] = [];

    for (const raw of rawLines) {
        if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length > 0) {
            lines[lines.length - 1] += raw.slice(1);
        } else {
            lines.push(raw);
        }
    }

    return lines;
}

function unescapeIcsText(value: string): string {
    // RFC 5545 TEXT escaping.
    return value
        .replace(/\\\\/g, '\\')
        .replace(/\\n/gi, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';');
}

function parseIcsLine(line: string): { name: string; params: IcsParams; value: string } | null {
    const idx = line.indexOf(':');
    if (idx < 0) return null;

    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const parts = left.split(';');
    const name = (parts[0] || '').trim().toUpperCase();
    if (!name) return null;

    const params: IcsParams = {};
    for (const paramPart of parts.slice(1)) {
        const eq = paramPart.indexOf('=');
        if (eq < 0) continue;
        const key = paramPart.slice(0, eq).trim().toUpperCase();
        const rawVal = paramPart.slice(eq + 1).trim();
        if (!key) continue;
        params[key] = rawVal;
    }

    return { name, params, value };
}

function parseIcsDurationMs(value: string): number | null {
    // Supports PnW, PnD, PTnHnMnS forms.
    const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
    if (!match) return null;
    const weeks = parseInt(match[1] || '0', 10);
    const days = parseInt(match[2] || '0', 10);
    const hours = parseInt(match[3] || '0', 10);
    const minutes = parseInt(match[4] || '0', 10);
    const seconds = parseInt(match[5] || '0', 10);
    const totalSeconds = ((((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60) + seconds;
    return totalSeconds * 1000;
}

function getTimeZoneOffsetMillis(date: Date, timeZone: string): number {
    // Offset = (timeZoneLocalAsUTC - actualUTC)
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });

    const parts = dtf.formatToParts(date);
    const lookup: Record<string, string> = {};
    for (const part of parts) {
        if (part.type === 'literal') continue;
        lookup[part.type] = part.value;
    }

    const year = parseInt(lookup.year || '0', 10);
    const month = parseInt(lookup.month || '1', 10);
    const day = parseInt(lookup.day || '1', 10);
    const hour = parseInt(lookup.hour || '0', 10);
    const minute = parseInt(lookup.minute || '0', 10);
    const second = parseInt(lookup.second || '0', 10);

    const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    return asUtc - date.getTime();
}

function zonedDateTimeToInstant(
    components: { year: number; month: number; day: number; hour: number; minute: number; second: number },
    timeZone: string
): Date {
    const utcBase = Date.UTC(components.year, components.month - 1, components.day, components.hour, components.minute, components.second);
    let guess = new Date(utcBase);

    for (let i = 0; i < 3; i++) {
        const offset = getTimeZoneOffsetMillis(guess, timeZone);
        const adjusted = utcBase - offset;
        if (adjusted === guess.getTime()) break;
        guess = new Date(adjusted);
    }

    return guess;
}

function parseIcsDateTime(value: string, params: IcsParams): { date: Date; allDay: boolean } | null {
    const trimmed = value.trim();
    const valueType = (params.VALUE || '').toUpperCase();

    if (valueType === 'DATE' || /^\d{8}$/.test(trimmed)) {
        const year = parseInt(trimmed.slice(0, 4), 10);
        const month = parseInt(trimmed.slice(4, 6), 10);
        const day = parseInt(trimmed.slice(6, 8), 10);
        if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
        return { date: new Date(year, month - 1, day, 0, 0, 0, 0), allDay: true };
    }

    const isUtc = trimmed.endsWith('Z');
    const base = isUtc ? trimmed.slice(0, -1) : trimmed;
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(base);
    if (!match) return null;

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const hour = parseInt(match[4], 10);
    const minute = parseInt(match[5], 10);
    const second = parseInt(match[6], 10);

    if (isUtc) {
        return { date: new Date(Date.UTC(year, month - 1, day, hour, minute, second)), allDay: false };
    }

    const tzid = params.TZID;
    if (tzid) {
        try {
            return {
                date: zonedDateTimeToInstant({ year, month, day, hour, minute, second }, tzid),
                allDay: false,
            };
        } catch {
            // Fall through to local parsing.
        }
    }

    return { date: new Date(year, month - 1, day, hour, minute, second, 0), allDay: false };
}

function parseRRule(raw: string): ParsedRRule | null {
    const pairs = raw.split(';').map((part) => part.split('='));
    const map: Record<string, string> = {};
    for (const [key, value] of pairs) {
        if (!key || !value) continue;
        map[key.trim().toUpperCase()] = value.trim();
    }

    const freq = map.FREQ?.toUpperCase();
    if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;

    const interval = Math.max(1, parseInt(map.INTERVAL || '1', 10) || 1);
    const count = map.COUNT ? parseInt(map.COUNT, 10) : undefined;
    const until = map.UNTIL ? parseIcsDateTime(map.UNTIL, {})?.date : undefined;

    const byDay = map.BYDAY
        ? map.BYDAY
            .split(',')
            .map((token) => token.trim().toUpperCase())
            .map((token) => {
                const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
                if (!match) return null;
                const days: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
                const weekday = days[match[2]];
                if (weekday === undefined) return null;
                const ordinal = match[1] ? parseInt(match[1], 10) : undefined;
                if (ordinal !== undefined && (!Number.isFinite(ordinal) || ordinal === 0)) return null;
                return ordinal === undefined ? { weekday } : { weekday, ordinal };
            })
            .filter((token): token is NonNullable<typeof token> => Boolean(token))
        : undefined;

    const byMonthDay = map.BYMONTHDAY
        ? map.BYMONTHDAY
            .split(',')
            .map((token) => parseInt(token.trim(), 10))
            .filter((d) => Number.isFinite(d) && d > 0 && d <= 31)
        : undefined;

    return {
        freq,
        interval,
        until,
        count: count && Number.isFinite(count) ? count : undefined,
        byDay: byDay && byDay.length > 0
            ? Array.from(new Map(byDay.map((token) => [`${token.ordinal ?? ''}:${token.weekday}`, token])).values())
            : undefined,
        byMonthDay: byMonthDay && byMonthDay.length > 0 ? Array.from(new Set(byMonthDay)) : undefined,
    };
}

function getNthWeekdayOfMonth(year: number, month: number, weekday: number, ordinal: number): Date | null {
    if (!Number.isFinite(ordinal) || ordinal === 0) return null;

    if (ordinal > 0) {
        const firstOfMonth = new Date(year, month, 1);
        const offset = (weekday - firstOfMonth.getDay() + 7) % 7;
        const day = 1 + offset + (ordinal - 1) * 7;
        const candidate = new Date(year, month, day);
        return candidate.getMonth() === month ? candidate : null;
    }

    const lastOfMonth = new Date(year, month + 1, 0);
    const offset = (lastOfMonth.getDay() - weekday + 7) % 7;
    const lastMatchingDay = lastOfMonth.getDate() - offset;
    const day = lastMatchingDay + (ordinal + 1) * 7;
    const candidate = new Date(year, month, day);
    return candidate.getMonth() === month ? candidate : null;
}

function getMonthlyCandidates(
    monthCursor: Date,
    rule: ParsedRRule,
    eventTime: { h: number; m: number; s: number; ms: number },
    fallbackMonthDay: number
): Date[] {
    const year = monthCursor.getFullYear();
    const month = monthCursor.getMonth();

    if (rule.byMonthDay && rule.byMonthDay.length > 0) {
        return rule.byMonthDay
            .map((monthDay) => new Date(year, month, monthDay, eventTime.h, eventTime.m, eventTime.s, eventTime.ms))
            .filter((candidate) => candidate.getMonth() === month)
            .sort((a, b) => a.getTime() - b.getTime());
    }

    if (rule.byDay && rule.byDay.length > 0) {
        const candidates = new Map<number, Date>();
        for (const token of rule.byDay) {
            if (typeof token.ordinal === 'number') {
                const nth = getNthWeekdayOfMonth(year, month, token.weekday, token.ordinal);
                if (!nth) continue;
                const candidate = new Date(year, month, nth.getDate(), eventTime.h, eventTime.m, eventTime.s, eventTime.ms);
                candidates.set(candidate.getTime(), candidate);
                continue;
            }

            const firstOfMonth = new Date(year, month, 1);
            const offset = (token.weekday - firstOfMonth.getDay() + 7) % 7;
            let day = 1 + offset;
            while (true) {
                const candidate = new Date(year, month, day, eventTime.h, eventTime.m, eventTime.s, eventTime.ms);
                if (candidate.getMonth() !== month) break;
                candidates.set(candidate.getTime(), candidate);
                day += 7;
            }
        }

        return Array.from(candidates.values()).sort((a, b) => a.getTime() - b.getTime());
    }

    return [new Date(year, month, fallbackMonthDay, eventTime.h, eventTime.m, eventTime.s, eventTime.ms)]
        .filter((candidate) => candidate.getMonth() === month);
}

function intersectsRange(start: Date, end: Date, rangeStart: Date, rangeEnd: Date): boolean {
    return start.getTime() < rangeEnd.getTime() && end.getTime() > rangeStart.getTime();
}

function createStableEventId(sourceId: string, uid: string, startIso: string): string {
    return `${sourceId}:${uid}:${startIso}`;
}

function expandRecurringEvent(event: ParsedVEvent, options: ParseIcsOptions): ExternalCalendarEvent[] {
    const { sourceId, rangeStart, rangeEnd } = options;
    const maxPerEvent = options.maxOccurrencesPerEvent ?? 1000;

    const durationMs = Math.max(0, event.end.getTime() - event.start.getTime());
    const windowStart = new Date(rangeStart.getTime() - durationMs);
    const windowEnd = rangeEnd;

    const out: ExternalCalendarEvent[] = [];

    const addOccurrence = (start: Date) => {
        const end = new Date(start.getTime() + durationMs);
        if (!intersectsRange(start, end, rangeStart, rangeEnd)) return;
        const startIso = start.toISOString();
        out.push({
            id: createStableEventId(sourceId, event.uid, startIso),
            sourceId,
            title: event.summary,
            start: startIso,
            end: end.toISOString(),
            allDay: event.allDay,
            description: event.description,
            location: event.location,
        });
    };

    const rule = event.rrule;
    if (!rule) {
        if (intersectsRange(event.start, event.end, rangeStart, rangeEnd)) {
            addOccurrence(event.start);
        }
        return out;
    }

    let generated = 0;
    const until = rule.until;
    const countLimit = rule.count;

    const shouldStop = (candidateStart: Date) => {
        if (until && candidateStart.getTime() > until.getTime()) return true;
        if (countLimit && generated >= countLimit) return true;
        if (generated >= maxPerEvent) return true;
        return false;
    };

    if (countLimit && countLimit > 0) {
        if (rule.freq === 'DAILY') {
            let current = event.start;
            while (current.getTime() <= windowEnd.getTime() && !shouldStop(current)) {
                addOccurrence(current);
                generated += 1;
                current = addDays(current, rule.interval);
            }
            return out;
        }

        if (rule.freq === 'WEEKLY') {
            const byDays = rule.byDay && rule.byDay.length > 0
                ? Array.from(new Set(rule.byDay.map((token) => token.weekday)))
                : [event.start.getDay()];
            const eventTime = { h: event.start.getHours(), m: event.start.getMinutes(), s: event.start.getSeconds(), ms: event.start.getMilliseconds() };

            const baseWeekStart = startOfWeek(event.start, { weekStartsOn: 1 });
            let weekCursor = baseWeekStart;

            while (weekCursor.getTime() <= windowEnd.getTime() && generated < maxPerEvent) {
                for (const day of byDays) {
                    const offset = (day - weekCursor.getDay() + 7) % 7;
                    const candidate = addDays(weekCursor, offset);
                    candidate.setHours(eventTime.h, eventTime.m, eventTime.s, eventTime.ms);
                    if (candidate.getTime() < event.start.getTime()) continue;
                    if (candidate.getTime() > windowEnd.getTime()) return out;
                    if (shouldStop(candidate)) return out;
                    addOccurrence(candidate);
                    generated += 1;
                    if (countLimit && generated >= countLimit) return out;
                    if (generated >= maxPerEvent) return out;
                }
                weekCursor = addWeeks(weekCursor, rule.interval);
            }

            return out;
        }

        // MONTHLY
        const eventTime = { h: event.start.getHours(), m: event.start.getMinutes(), s: event.start.getSeconds(), ms: event.start.getMilliseconds() };

        let monthCursor = new Date(event.start.getFullYear(), event.start.getMonth(), 1, 0, 0, 0, 0);
        while (monthCursor.getTime() <= windowEnd.getTime() && generated < maxPerEvent) {
            for (const candidate of getMonthlyCandidates(monthCursor, rule, eventTime, event.start.getDate())) {
                if (candidate.getTime() < event.start.getTime()) continue;
                if (candidate.getTime() > windowEnd.getTime()) return out;
                if (shouldStop(candidate)) return out;
                addOccurrence(candidate);
                generated += 1;
                if (countLimit && generated >= countLimit) return out;
                if (generated >= maxPerEvent) return out;
            }
            monthCursor = addMonths(monthCursor, rule.interval);
        }

        return out;
    }

    if (rule.freq === 'DAILY') {
        let current = event.start;
        if (current.getTime() < windowStart.getTime()) {
            const diffDays = differenceInCalendarDays(windowStart, current);
            const jumps = Math.floor(diffDays / rule.interval);
            current = addDays(current, jumps * rule.interval);
            while (current.getTime() < windowStart.getTime()) {
                current = addDays(current, rule.interval);
            }
        }

        while (current.getTime() <= windowEnd.getTime() && !shouldStop(current)) {
            if (current.getTime() >= event.start.getTime()) {
                addOccurrence(current);
                generated += 1;
            }
            current = addDays(current, rule.interval);
        }

        return out;
    }

    if (rule.freq === 'WEEKLY') {
        const byDays = rule.byDay && rule.byDay.length > 0
            ? Array.from(new Set(rule.byDay.map((token) => token.weekday)))
            : [event.start.getDay()];
        const eventTime = { h: event.start.getHours(), m: event.start.getMinutes(), s: event.start.getSeconds(), ms: event.start.getMilliseconds() };

        const baseWeekStart = startOfWeek(event.start, { weekStartsOn: 1 });
        let weekCursor = baseWeekStart;

        if (weekCursor.getTime() < windowStart.getTime()) {
            const diffDays = differenceInCalendarDays(windowStart, weekCursor);
            const diffWeeks = Math.floor(diffDays / 7);
            const jumps = Math.floor(diffWeeks / rule.interval);
            weekCursor = addWeeks(weekCursor, jumps * rule.interval);
            while (addDays(weekCursor, 7).getTime() < windowStart.getTime()) {
                weekCursor = addWeeks(weekCursor, rule.interval);
            }
        }

        while (weekCursor.getTime() <= windowEnd.getTime() && generated < maxPerEvent) {
            for (const day of byDays) {
                const offset = (day - weekCursor.getDay() + 7) % 7;
                const candidate = addDays(weekCursor, offset);
                candidate.setHours(eventTime.h, eventTime.m, eventTime.s, eventTime.ms);
                if (candidate.getTime() < event.start.getTime()) continue;
                if (candidate.getTime() > windowEnd.getTime()) continue;
                if (shouldStop(candidate)) return out;
                addOccurrence(candidate);
                generated += 1;
                if (countLimit && generated >= countLimit) return out;
                if (generated >= maxPerEvent) return out;
            }
            weekCursor = addWeeks(weekCursor, rule.interval);
        }

        return out;
    }

    // MONTHLY
    const eventTime = { h: event.start.getHours(), m: event.start.getMinutes(), s: event.start.getSeconds(), ms: event.start.getMilliseconds() };

    let monthCursor = new Date(event.start.getFullYear(), event.start.getMonth(), 1, 0, 0, 0, 0);
    if (monthCursor.getTime() < windowStart.getTime()) {
        const approxMonths = (windowStart.getFullYear() - monthCursor.getFullYear()) * 12 + (windowStart.getMonth() - monthCursor.getMonth());
        const jumps = Math.floor(approxMonths / rule.interval);
        monthCursor = addMonths(monthCursor, jumps * rule.interval);
        while (addMonths(monthCursor, rule.interval).getTime() < windowStart.getTime()) {
            monthCursor = addMonths(monthCursor, rule.interval);
        }
    }

    while (monthCursor.getTime() <= windowEnd.getTime() && generated < maxPerEvent) {
        for (const candidate of getMonthlyCandidates(monthCursor, rule, eventTime, event.start.getDate())) {
            if (candidate.getTime() < event.start.getTime()) continue;
            if (candidate.getTime() > windowEnd.getTime()) continue;
            if (shouldStop(candidate)) return out;
            addOccurrence(candidate);
            generated += 1;
            if (countLimit && generated >= countLimit) return out;
            if (generated >= maxPerEvent) return out;
        }
        monthCursor = addMonths(monthCursor, rule.interval);
    }

    return out;
}

export function parseIcs(input: string, options: ParseIcsOptions): ExternalCalendarEvent[] {
    const lines = unfoldIcsLines(input);

    const events: ParsedVEvent[] = [];
    let current: Partial<ParsedVEvent> | null = null;
    let currentDurationMs: number | null = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.toUpperCase() === 'BEGIN:VEVENT') {
            current = {};
            currentDurationMs = null;
            continue;
        }
        if (line.toUpperCase() === 'END:VEVENT') {
            if (!current) continue;
            if (!current.uid || !current.summary || !current.start) {
                current = null;
                currentDurationMs = null;
                continue;
            }

            const allDay = Boolean(current.allDay);
            let end = current.end;
            if (!end && currentDurationMs !== null) {
                end = new Date(current.start.getTime() + currentDurationMs);
            }
            if (!end) {
                // Reasonable defaults.
                end = allDay ? addDays(current.start, 1) : new Date(current.start.getTime() + 60 * 60 * 1000);
            }

            events.push({
                uid: current.uid,
                summary: current.summary,
                description: current.description,
                location: current.location,
                start: current.start,
                end,
                allDay,
                rrule: current.rrule,
            });
            current = null;
            currentDurationMs = null;
            continue;
        }

        if (!current) continue;

        const parsed = parseIcsLine(line);
        if (!parsed) continue;

        const { name, params, value } = parsed;

        if (name === 'UID') {
            current.uid = value.trim();
        } else if (name === 'SUMMARY') {
            current.summary = unescapeIcsText(value.trim());
        } else if (name === 'DESCRIPTION') {
            current.description = unescapeIcsText(value.trim());
        } else if (name === 'LOCATION') {
            current.location = unescapeIcsText(value.trim());
        } else if (name === 'DTSTART') {
            const dt = parseIcsDateTime(value, params);
            if (dt) {
                current.start = dt.date;
                current.allDay = dt.allDay;
            }
        } else if (name === 'DTEND') {
            const dt = parseIcsDateTime(value, params);
            if (dt) current.end = dt.date;
        } else if (name === 'DURATION') {
            currentDurationMs = parseIcsDurationMs(value);
        } else if (name === 'RRULE') {
            const rule = parseRRule(value);
            if (rule) current.rrule = rule;
        }
    }

    const occurrences: ExternalCalendarEvent[] = [];
    const maxTotal = options.maxTotalOccurrences ?? 5000;
    for (const event of events) {
        if (occurrences.length >= maxTotal) break;
        const expanded = expandRecurringEvent(event, options);
        for (const occ of expanded) {
            occurrences.push(occ);
            if (occurrences.length >= maxTotal) break;
        }
    }

    // Stable ordering
    occurrences.sort((a, b) => a.start.localeCompare(b.start));
    return occurrences;
}
