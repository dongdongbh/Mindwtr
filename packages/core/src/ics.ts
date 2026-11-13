import { addDays } from 'date-fns';
import { normalizeDerivedIcsColor } from './external-calendar-colors';

export interface ExternalCalendarSubscription {
    id: string;
    name: string;
    url: string;
    enabled: boolean;
    color?: string;

    areaIds?: string[];

    feedColor?: string;
}

export interface ExternalCalendarEvent {

    id: string;
    sourceId: string;

    nativeEventId?: string;
    uid?: string;
    recurrenceId?: string;
    calendarSourceId?: string;
    title: string;
    start: string;
    end: string;
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


    splitByCategory?: boolean;
}

export interface IcsCategoryInfo {
    names: string[];
    hasUncategorized: boolean;

    colors?: Record<string, string>;
}

export interface ParseIcsResult {
    events: ExternalCalendarEvent[];

    categoryInfo: IcsCategoryInfo;

    calendarColor?: string;
}


const MAX_CATEGORY_CALENDARS = 8;
const DEFAULT_MAX_OCCURRENCES_PER_EVENT = 1000;

const categoryCalendarPrefix = (sourceId: string): string => `${sourceId}#`;

type IcsParams = Record<string, string>;

type ParsedRRule = {
    freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
    interval: number;
    until?: Date;
    count?: number;
    byDay?: Array<{
        weekday: number;
        ordinal?: number;
    }>;
    byMonth?: number[];
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


    recurrenceId?: Date;
    recurrenceIdentity?: string;
    floating?: boolean;
    timeZone?: string;

    cancelled?: boolean;

    excludedStarts?: Set<number>;

    category?: string;

    categoryColor?: string;
};


const CSS3_COLOR_NAMES: Record<string, string> = {
    aliceblue: '#F0F8FF', antiquewhite: '#FAEBD7', aqua: '#00FFFF', aquamarine: '#7FFFD4', azure: '#F0FFFF',
    beige: '#F5F5DC', bisque: '#FFE4C4', black: '#000000', blanchedalmond: '#FFEBCD', blue: '#0000FF',
    blueviolet: '#8A2BE2', brown: '#A52A2A', burlywood: '#DEB887', cadetblue: '#5F9EA0', chartreuse: '#7FFF00',
    chocolate: '#D2691E', coral: '#FF7F50', cornflowerblue: '#6495ED', cornsilk: '#FFF8DC', crimson: '#DC143C',
    cyan: '#00FFFF', darkblue: '#00008B', darkcyan: '#008B8B', darkgoldenrod: '#B8860B', darkgray: '#A9A9A9',
    darkgreen: '#006400', darkgrey: '#A9A9A9', darkkhaki: '#BDB76B', darkmagenta: '#8B008B', darkolivegreen: '#556B2F',
    darkorange: '#FF8C00', darkorchid: '#9932CC', darkred: '#8B0000', darksalmon: '#E9967A', darkseagreen: '#8FBC8F',
    darkslateblue: '#483D8B', darkslategray: '#2F4F4F', darkslategrey: '#2F4F4F', darkturquoise: '#00CED1', darkviolet: '#9400D3',
    deeppink: '#FF1493', deepskyblue: '#00BFFF', dimgray: '#696969', dimgrey: '#696969', dodgerblue: '#1E90FF',
    firebrick: '#B22222', floralwhite: '#FFFAF0', forestgreen: '#228B22', fuchsia: '#FF00FF', gainsboro: '#DCDCDC',
    ghostwhite: '#F8F8FF', gold: '#FFD700', goldenrod: '#DAA520', gray: '#808080', green: '#008000',
    greenyellow: '#ADFF2F', grey: '#808080', honeydew: '#F0FFF0', hotpink: '#FF69B4', indianred: '#CD5C5C',
    indigo: '#4B0082', ivory: '#FFFFF0', khaki: '#F0E68C', lavender: '#E6E6FA', lavenderblush: '#FFF0F5',
    lawngreen: '#7CFC00', lemonchiffon: '#FFFACD', lightblue: '#ADD8E6', lightcoral: '#F08080', lightcyan: '#E0FFFF',
    lightgoldenrodyellow: '#FAFAD2', lightgray: '#D3D3D3', lightgreen: '#90EE90', lightgrey: '#D3D3D3', lightpink: '#FFB6C1',
    lightsalmon: '#FFA07A', lightseagreen: '#20B2AA', lightskyblue: '#87CEFA', lightslategray: '#778899', lightslategrey: '#778899',
    lightsteelblue: '#B0C4DE', lightyellow: '#FFFFE0', lime: '#00FF00', limegreen: '#32CD32', linen: '#FAF0E6',
    magenta: '#FF00FF', maroon: '#800000', mediumaquamarine: '#66CDAA', mediumblue: '#0000CD', mediumorchid: '#BA55D3',
    mediumpurple: '#9370DB', mediumseagreen: '#3CB371', mediumslateblue: '#7B68EE', mediumspringgreen: '#00FA9A', mediumturquoise: '#48D1CC',
    mediumvioletred: '#C71585', midnightblue: '#191970', mintcream: '#F5FFFA', mistyrose: '#FFE4E1', moccasin: '#FFE4B5',
    navajowhite: '#FFDEAD', navy: '#000080', oldlace: '#FDF5E6', olive: '#808000', olivedrab: '#6B8E23',
    orange: '#FFA500', orangered: '#FF4500', orchid: '#DA70D6', palegoldenrod: '#EEE8AA', palegreen: '#98FB98',
    paleturquoise: '#AFEEEE', palevioletred: '#DB7093', papayawhip: '#FFEFD5', peachpuff: '#FFDAB9', peru: '#CD853F',
    pink: '#FFC0CB', plum: '#DDA0DD', powderblue: '#B0E0E6', purple: '#800080', rebeccapurple: '#663399',
    red: '#FF0000', rosybrown: '#BC8F8F', royalblue: '#4169E1', saddlebrown: '#8B4513', salmon: '#FA8072',
    sandybrown: '#F4A460', seagreen: '#2E8B57', seashell: '#FFF5EE', sienna: '#A0522D', silver: '#C0C0C0',
    skyblue: '#87CEEB', slateblue: '#6A5ACD', slategray: '#708090', slategrey: '#708090', snow: '#FFFAFA',
    springgreen: '#00FF7F', steelblue: '#4682B4', tan: '#D2B48C', teal: '#008080', thistle: '#D8BFD8',
    tomato: '#FF6347', turquoise: '#40E0D0', violet: '#EE82EE', wheat: '#F5DEB3', white: '#FFFFFF',
    whitesmoke: '#F5F5F5', yellow: '#FFFF00', yellowgreen: '#9ACD32',
};

function resolveCssColorName(value: string): string | undefined {
    return CSS3_COLOR_NAMES[value.trim().toLowerCase()];
}


function argbIntToHex(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) return undefined;
    const parsed = parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) return undefined;
    const rgb = (parsed >>> 0) & 0xFFFFFF;
    return `#${rgb.toString(16).padStart(6, '0').toUpperCase()}`;
}

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

    return value
        .replace(/\\\\/g, '\\')
        .replace(/\\n/gi, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';');
}


function splitIcsTextList(value: string): string[] {
    const out: string[] = [];
    let current = '';
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char === '\\' && index + 1 < value.length) {
            current += char + value[index + 1];
            index += 1;
            continue;
        }
        if (char === ',') {
            out.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    out.push(current);
    return out;
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

    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
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

function parseIcsDateTime(value: string, params: IcsParams): { date: Date; allDay: boolean; timeZone?: string } | null {
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
        return { date: new Date(Date.UTC(year, month - 1, day, hour, minute, second)), allDay: false, timeZone: 'UTC' };
    }

    const tzid = params.TZID;
    if (tzid) {
        try {
            return {
                date: zonedDateTimeToInstant({ year, month, day, hour, minute, second }, tzid),
                allDay: false,
                timeZone: tzid,
            };
        } catch {

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
    if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

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

    const byMonth = map.BYMONTH
        ? map.BYMONTH
            .split(',')
            .map((token) => parseInt(token.trim(), 10))
            .filter((m) => Number.isFinite(m) && m >= 1 && m <= 12)
        : undefined;

    const byMonthDay = map.BYMONTHDAY
        ? map.BYMONTHDAY
            .split(',')
            .map((token) => parseInt(token.trim(), 10))

            .filter((d) => Number.isFinite(d) && ((d > 0 && d <= 31) || d === -1))
        : undefined;

    return {
        freq,
        interval,
        until,
        count: count && Number.isFinite(count) ? count : undefined,
        byDay: byDay && byDay.length > 0
            ? Array.from(new Map(byDay.map((token) => [`${token.ordinal ?? ''}:${token.weekday}`, token])).values())
            : undefined,
        byMonth: byMonth && byMonth.length > 0 ? Array.from(new Set(byMonth)) : undefined,
        byMonthDay: byMonthDay && byMonthDay.length > 0 ? Array.from(new Set(byMonthDay)) : undefined,
    };
}

function recurrenceDate(date: Date, timeZone?: string): Date {
    if (timeZone) return new Date(date.getTime() + (timeZone === 'UTC' ? 0 : getTimeZoneOffsetMillis(date, timeZone)));
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()));
}

function recurrenceInstant(date: Date, timeZone?: string): Date {
    const components = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
        hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
    return timeZone === 'UTC' ? date : timeZone ? zonedDateTimeToInstant(components, timeZone)
        : new Date(components.year, components.month - 1, components.day, components.hour, components.minute, components.second);
}

function addRecurrenceDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
}

function addRecurrenceMonths(date: Date, months: number): Date {
    const next = new Date(date);
    next.setUTCMonth(next.getUTCMonth() + months);
    return next;
}

function recurrenceWeekStart(date: Date): Date {
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    return addRecurrenceDays(day, -((day.getUTCDay() + 6) % 7));
}

function getNthWeekdayOfMonth(year: number, month: number, weekday: number, ordinal: number): Date | null {
    if (!Number.isFinite(ordinal) || ordinal === 0) return null;

    if (ordinal > 0) {
        const firstOfMonth = new Date(Date.UTC(year, month, 1));
        const offset = (weekday - firstOfMonth.getUTCDay() + 7) % 7;
        const day = 1 + offset + (ordinal - 1) * 7;
        const candidate = new Date(Date.UTC(year, month, day));
        return candidate.getUTCMonth() === month ? candidate : null;
    }

    const lastOfMonth = new Date(Date.UTC(year, month + 1, 0));
    const offset = (lastOfMonth.getUTCDay() - weekday + 7) % 7;
    const lastMatchingDay = lastOfMonth.getUTCDate() - offset;
    const day = lastMatchingDay + (ordinal + 1) * 7;
    const candidate = new Date(Date.UTC(year, month, day));
    return candidate.getUTCMonth() === month ? candidate : null;
}

function getMonthlyCandidates(
    monthCursor: Date,
    rule: ParsedRRule,
    eventTime: { h: number; m: number; s: number; ms: number },
    fallbackMonthDay: number
): Date[] {
    const year = monthCursor.getUTCFullYear();
    const month = monthCursor.getUTCMonth();

    if (rule.byMonthDay && rule.byMonthDay.length > 0) {
        return rule.byMonthDay

            .map((monthDay) => (monthDay === -1
                ? new Date(Date.UTC(year, month + 1, 0, eventTime.h, eventTime.m, eventTime.s, eventTime.ms))
                : new Date(Date.UTC(year, month, monthDay, eventTime.h, eventTime.m, eventTime.s, eventTime.ms))))
            .filter((candidate) => candidate.getUTCMonth() === month)
            .sort((a, b) => a.getTime() - b.getTime());
    }

    if (rule.byDay && rule.byDay.length > 0) {
        const candidates = new Map<number, Date>();
        for (const token of rule.byDay) {
            if (typeof token.ordinal === 'number') {
                const nth = getNthWeekdayOfMonth(year, month, token.weekday, token.ordinal);
                if (!nth) continue;
                const candidate = new Date(Date.UTC(year, month, nth.getUTCDate(), eventTime.h, eventTime.m, eventTime.s, eventTime.ms));
                candidates.set(candidate.getTime(), candidate);
                continue;
            }

            const firstOfMonth = new Date(Date.UTC(year, month, 1));
            const offset = (token.weekday - firstOfMonth.getUTCDay() + 7) % 7;
            let day = 1 + offset;
            while (true) {
                const candidate = new Date(Date.UTC(year, month, day, eventTime.h, eventTime.m, eventTime.s, eventTime.ms));
                if (candidate.getUTCMonth() !== month) break;
                candidates.set(candidate.getTime(), candidate);
                day += 7;
            }
        }

        return Array.from(candidates.values()).sort((a, b) => a.getTime() - b.getTime());
    }

    return [new Date(Date.UTC(year, month, fallbackMonthDay, eventTime.h, eventTime.m, eventTime.s, eventTime.ms))]
        .filter((candidate) => candidate.getUTCMonth() === month);
}

function getYearlyCandidates(
    year: number,
    rule: ParsedRRule,
    eventTime: { h: number; m: number; s: number; ms: number },
    fallbackMonth: number,
    fallbackMonthDay: number,
): Date[] {
    const monthNumbers = rule.byMonth && rule.byMonth.length > 0 ? rule.byMonth : [fallbackMonth];
    const candidates = new Map<number, Date>();

    for (const monthNumber of monthNumbers) {
        const month = monthNumber - 1;

        if (rule.byMonthDay && rule.byMonthDay.length > 0) {
            for (const monthDay of rule.byMonthDay) {
                const candidate = monthDay === -1
                    ? new Date(Date.UTC(year, month + 1, 0, eventTime.h, eventTime.m, eventTime.s, eventTime.ms))
                    : new Date(Date.UTC(year, month, monthDay, eventTime.h, eventTime.m, eventTime.s, eventTime.ms));
                if (candidate.getUTCMonth() === month) {
                    candidates.set(candidate.getTime(), candidate);
                }
            }
            continue;
        }

        if (rule.byDay && rule.byDay.length > 0) {
            for (const token of rule.byDay) {
                if (typeof token.ordinal === 'number') {
                    const nth = getNthWeekdayOfMonth(year, month, token.weekday, token.ordinal);
                    if (!nth) continue;
                    const candidate = new Date(Date.UTC(year, month, nth.getUTCDate(), eventTime.h, eventTime.m, eventTime.s, eventTime.ms));
                    candidates.set(candidate.getTime(), candidate);
                    continue;
                }

                const firstOfMonth = new Date(Date.UTC(year, month, 1));
                const offset = (token.weekday - firstOfMonth.getUTCDay() + 7) % 7;
                let day = 1 + offset;
                while (true) {
                    const candidate = new Date(Date.UTC(year, month, day, eventTime.h, eventTime.m, eventTime.s, eventTime.ms));
                    if (candidate.getUTCMonth() !== month) break;
                    candidates.set(candidate.getTime(), candidate);
                    day += 7;
                }
            }
            continue;
        }

        const candidate = new Date(Date.UTC(year, month, fallbackMonthDay, eventTime.h, eventTime.m, eventTime.s, eventTime.ms));
        if (candidate.getUTCMonth() === month) {
            candidates.set(candidate.getTime(), candidate);
        }
    }

    return Array.from(candidates.values()).sort((a, b) => a.getTime() - b.getTime());
}

function intersectsRange(start: Date, end: Date, rangeStart: Date, rangeEnd: Date): boolean {
    return start.getTime() < rangeEnd.getTime() && end.getTime() > rangeStart.getTime();
}

function createStableEventId(sourceId: string, uid: string, startIso: string): string {
    return `${sourceId}:${uid}:${startIso}`;
}

function occurrenceIdentity(date: Date, allDay: boolean, floating: boolean): string {
    if (!allDay && !floating) return date.toISOString();
    const pad = (value: number) => String(value).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return allDay ? `DATE:${day}` : `FLOAT:${day}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function expandRecurringEvent(event: ParsedVEvent, options: ParseIcsOptions): ExternalCalendarEvent[] {
    const { sourceId, rangeStart, rangeEnd } = options;
    const maxPerEvent = options.maxOccurrencesPerEvent ?? DEFAULT_MAX_OCCURRENCES_PER_EVENT;
    const maxCandidateVisits = Math.max(maxPerEvent, DEFAULT_MAX_OCCURRENCES_PER_EVENT) + 2;

    const durationMs = Math.max(0, event.allDay
        ? Date.UTC(event.end.getFullYear(), event.end.getMonth(), event.end.getDate())
            - Date.UTC(event.start.getFullYear(), event.start.getMonth(), event.start.getDate())
        : event.end.getTime() - event.start.getTime());
    const recurrenceStart = recurrenceDate(event.start, event.timeZone);
    const earliest = event.allDay ? new Date(recurrenceDate(rangeStart).getTime() - durationMs)
        : recurrenceDate(new Date(rangeStart.getTime() - durationMs), event.timeZone);
    const windowStart = addRecurrenceDays(earliest, -1);
    const windowEnd = addRecurrenceDays(recurrenceDate(rangeEnd, event.timeZone), 1);

    const out: ExternalCalendarEvent[] = [];

    const addOccurrence = (candidate: Date) => {
        if (out.length >= maxPerEvent) return;
        const start = recurrenceInstant(candidate, event.timeZone);


        if (event.excludedStarts?.has(start.getTime())) return;
        const end = event.allDay ? addDays(start, durationMs / 86_400_000) : new Date(start.getTime() + durationMs);
        if (!intersectsRange(start, end, rangeStart, rangeEnd)) return;
        const startIso = start.toISOString();
        out.push({
            id: createStableEventId(sourceId, event.uid, startIso),
            sourceId,
            uid: event.uid,
            ...(event.recurrenceId || event.rrule ? { recurrenceId: event.recurrenceIdentity ?? occurrenceIdentity(start, event.allDay, Boolean(event.floating)) } : {}),
            title: event.summary,
            start: startIso,
            end: end.toISOString(),
            allDay: event.allDay,
            description: event.description,
            location: event.location,
        });
    };


    const rule = event.recurrenceId ? undefined : event.rrule;
    if (!rule) {
        if (intersectsRange(event.start, event.end, rangeStart, rangeEnd)) {
            addOccurrence(recurrenceStart);
        }
        return out;
    }

    let generated = 0;
    const until = rule.until;
    const countLimit = rule.count;

    const shouldStop = (candidateStart: Date) => {
        if (out.length >= maxPerEvent) return true;
        if (until && recurrenceInstant(candidateStart, event.timeZone).getTime() > until.getTime()) return true;
        if (countLimit && generated >= countLimit) return true;
        if (generated >= maxCandidateVisits) return true;
        return false;
    };

    if (countLimit && countLimit > 0) {
        if (rule.freq === 'DAILY') {
            let current = recurrenceStart;
            while (current.getTime() <= windowEnd.getTime() && !shouldStop(current)) {
                addOccurrence(current);
                generated += 1;
                current = addRecurrenceDays(current, rule.interval);
            }
            return out;
        }

        if (rule.freq === 'WEEKLY') {
            const byDays = rule.byDay && rule.byDay.length > 0
                ? Array.from(new Set(rule.byDay.map((token) => token.weekday)))
                : [recurrenceStart.getUTCDay()];
            const eventTime = { h: recurrenceStart.getUTCHours(), m: recurrenceStart.getUTCMinutes(), s: recurrenceStart.getUTCSeconds(), ms: recurrenceStart.getUTCMilliseconds() };

            const baseWeekStart = recurrenceWeekStart(recurrenceStart);
            let weekCursor = baseWeekStart;

            while (weekCursor.getTime() <= windowEnd.getTime() && generated < maxCandidateVisits) {
                for (const day of byDays) {
                    const offset = (day - weekCursor.getUTCDay() + 7) % 7;
                    const candidate = addRecurrenceDays(weekCursor, offset);
                    candidate.setUTCHours(eventTime.h, eventTime.m, eventTime.s, eventTime.ms);
                    if (candidate.getTime() < recurrenceStart.getTime()) continue;
                    if (candidate.getTime() > windowEnd.getTime()) return out;
                    if (shouldStop(candidate)) return out;
                    addOccurrence(candidate);
                    generated += 1;
                    if (countLimit && generated >= countLimit) return out;
                    if (generated >= maxCandidateVisits) return out;
                }
                weekCursor = addRecurrenceDays(weekCursor, rule.interval * 7);
            }

            return out;
        }

        if (rule.freq === 'MONTHLY') {
            const eventTime = { h: recurrenceStart.getUTCHours(), m: recurrenceStart.getUTCMinutes(), s: recurrenceStart.getUTCSeconds(), ms: recurrenceStart.getUTCMilliseconds() };

            let monthCursor = new Date(Date.UTC(recurrenceStart.getUTCFullYear(), recurrenceStart.getUTCMonth(), 1, 0, 0, 0, 0));
            while (monthCursor.getTime() <= windowEnd.getTime() && generated < maxCandidateVisits) {
                for (const candidate of getMonthlyCandidates(monthCursor, rule, eventTime, recurrenceStart.getUTCDate())) {
                    if (candidate.getTime() < recurrenceStart.getTime()) continue;
                    if (candidate.getTime() > windowEnd.getTime()) return out;
                    if (shouldStop(candidate)) return out;
                    addOccurrence(candidate);
                    generated += 1;
                    if (countLimit && generated >= countLimit) return out;
                    if (generated >= maxCandidateVisits) return out;
                }
                monthCursor = addRecurrenceMonths(monthCursor, rule.interval);
            }

            return out;
        }

        const eventTime = { h: recurrenceStart.getUTCHours(), m: recurrenceStart.getUTCMinutes(), s: recurrenceStart.getUTCSeconds(), ms: recurrenceStart.getUTCMilliseconds() };
        let yearCursor = recurrenceStart.getUTCFullYear();
        while (yearCursor <= windowEnd.getUTCFullYear() && generated < maxCandidateVisits) {
            const candidates = getYearlyCandidates(yearCursor, rule, eventTime, recurrenceStart.getUTCMonth() + 1, recurrenceStart.getUTCDate());
            for (const candidate of candidates) {
                if (candidate.getTime() < recurrenceStart.getTime()) continue;
                if (candidate.getTime() > windowEnd.getTime()) return out;
                if (shouldStop(candidate)) return out;
                addOccurrence(candidate);
                generated += 1;
                if (countLimit && generated >= countLimit) return out;
                if (generated >= maxCandidateVisits) return out;
            }
            yearCursor += rule.interval;
        }

        return out;
    }

    if (rule.freq === 'DAILY') {
        let current = recurrenceStart;
        if (current.getTime() < windowStart.getTime()) {
            const diffDays = Math.floor((windowStart.getTime() - current.getTime()) / 86_400_000);
            const jumps = Math.floor(diffDays / rule.interval);
            current = addRecurrenceDays(current, jumps * rule.interval);
            while (current.getTime() < windowStart.getTime()) {
                current = addRecurrenceDays(current, rule.interval);
            }
        }

        while (current.getTime() <= windowEnd.getTime() && !shouldStop(current)) {
            if (current.getTime() >= recurrenceStart.getTime()) {
                addOccurrence(current);
                generated += 1;
            }
            current = addRecurrenceDays(current, rule.interval);
        }

        return out;
    }

    if (rule.freq === 'WEEKLY') {
        const byDays = rule.byDay && rule.byDay.length > 0
            ? Array.from(new Set(rule.byDay.map((token) => token.weekday)))
            : [recurrenceStart.getUTCDay()];
        const eventTime = { h: recurrenceStart.getUTCHours(), m: recurrenceStart.getUTCMinutes(), s: recurrenceStart.getUTCSeconds(), ms: recurrenceStart.getUTCMilliseconds() };

        const baseWeekStart = recurrenceWeekStart(recurrenceStart);
        let weekCursor = baseWeekStart;

        if (weekCursor.getTime() < windowStart.getTime()) {
            const diffDays = Math.floor((windowStart.getTime() - weekCursor.getTime()) / 86_400_000);
            const diffWeeks = Math.floor(diffDays / 7);
            const jumps = Math.floor(diffWeeks / rule.interval);
            weekCursor = addRecurrenceDays(weekCursor, jumps * rule.interval * 7);
            while (addRecurrenceDays(weekCursor, 7).getTime() < windowStart.getTime()) {
                weekCursor = addRecurrenceDays(weekCursor, rule.interval * 7);
            }
        }

        while (weekCursor.getTime() <= windowEnd.getTime() && generated < maxCandidateVisits) {
            for (const day of byDays) {
                const offset = (day - weekCursor.getUTCDay() + 7) % 7;
                const candidate = addRecurrenceDays(weekCursor, offset);
                candidate.setUTCHours(eventTime.h, eventTime.m, eventTime.s, eventTime.ms);
                if (candidate.getTime() < recurrenceStart.getTime()) continue;
                if (candidate.getTime() > windowEnd.getTime()) continue;
                if (shouldStop(candidate)) return out;
                addOccurrence(candidate);
                generated += 1;
                if (countLimit && generated >= countLimit) return out;
                if (generated >= maxCandidateVisits) return out;
            }
            weekCursor = addRecurrenceDays(weekCursor, rule.interval * 7);
        }

        return out;
    }

    if (rule.freq === 'MONTHLY') {
        const eventTime = { h: recurrenceStart.getUTCHours(), m: recurrenceStart.getUTCMinutes(), s: recurrenceStart.getUTCSeconds(), ms: recurrenceStart.getUTCMilliseconds() };

        let monthCursor = new Date(Date.UTC(recurrenceStart.getUTCFullYear(), recurrenceStart.getUTCMonth(), 1, 0, 0, 0, 0));
        if (monthCursor.getTime() < windowStart.getTime()) {
            const approxMonths = (windowStart.getUTCFullYear() - monthCursor.getUTCFullYear()) * 12 + (windowStart.getUTCMonth() - monthCursor.getUTCMonth());
            const jumps = Math.floor(approxMonths / rule.interval);
            monthCursor = addRecurrenceMonths(monthCursor, jumps * rule.interval);
            while (addRecurrenceMonths(monthCursor, rule.interval).getTime() < windowStart.getTime()) {
                monthCursor = addRecurrenceMonths(monthCursor, rule.interval);
            }
        }

        while (monthCursor.getTime() <= windowEnd.getTime() && generated < maxCandidateVisits) {
            for (const candidate of getMonthlyCandidates(monthCursor, rule, eventTime, recurrenceStart.getUTCDate())) {
                if (candidate.getTime() < recurrenceStart.getTime()) continue;
                if (candidate.getTime() > windowEnd.getTime()) continue;
                if (shouldStop(candidate)) return out;
                addOccurrence(candidate);
                generated += 1;
                if (countLimit && generated >= countLimit) return out;
                if (generated >= maxCandidateVisits) return out;
            }
            monthCursor = addRecurrenceMonths(monthCursor, rule.interval);
        }

        return out;
    }

    const eventTime = { h: recurrenceStart.getUTCHours(), m: recurrenceStart.getUTCMinutes(), s: recurrenceStart.getUTCSeconds(), ms: recurrenceStart.getUTCMilliseconds() };
    let yearCursor = recurrenceStart.getUTCFullYear();
    if (yearCursor < windowStart.getUTCFullYear()) {
        const diffYears = windowStart.getUTCFullYear() - yearCursor;
        yearCursor += Math.floor(diffYears / rule.interval) * rule.interval;
    }

    while (yearCursor <= windowEnd.getUTCFullYear() && generated < maxCandidateVisits) {
        for (const candidate of getYearlyCandidates(yearCursor, rule, eventTime, recurrenceStart.getUTCMonth() + 1, recurrenceStart.getUTCDate())) {
            if (candidate.getTime() < recurrenceStart.getTime()) continue;
            if (candidate.getTime() > windowEnd.getTime()) return out;
            if (shouldStop(candidate)) return out;
            addOccurrence(candidate);
            generated += 1;
            if (generated >= maxCandidateVisits) return out;
        }
        yearCursor += rule.interval;
    }

    return out;
}

export function parseIcs(input: string, options: ParseIcsOptions): ExternalCalendarEvent[] {
    return parseIcsWithMetadata(input, options).events;
}

export function parseIcsWithMetadata(input: string, options: ParseIcsOptions): ParseIcsResult {
    const lines = unfoldIcsLines(input);

    const events: ParsedVEvent[] = [];
    let current: Partial<ParsedVEvent> | null = null;
    let currentDurationMs: number | null = null;
    let calendarColorRfc: string | undefined;
    let calendarColorApple: string | undefined;


    const componentStack: string[] = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const beginMatch = /^BEGIN:(\S+)$/i.exec(line);
        if (beginMatch) {
            const component = beginMatch[1].toUpperCase();
            componentStack.push(component);
            if (component === 'VEVENT') {
                current = {};
                currentDurationMs = null;
            }
            continue;
        }

        const endMatch = /^END:(\S+)$/i.exec(line);
        if (endMatch) {
            const component = endMatch[1].toUpperCase();
            if (componentStack[componentStack.length - 1] === component) componentStack.pop();
            if (component === 'VEVENT') {
                if (!current) continue;


                if (!current.start && current.recurrenceId) current.start = current.recurrenceId;
                if (!current.uid || !current.start || (!current.summary && !current.cancelled)) {
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

                    end = allDay ? addDays(current.start, 1) : new Date(current.start.getTime() + 60 * 60 * 1000);
                }

                events.push({
                    uid: current.uid,
                    summary: current.summary ?? '',
                    description: current.description,
                    location: current.location,
                    start: current.start,
                    end,
                    allDay,
                    rrule: current.rrule,
                    recurrenceId: current.recurrenceId,
                    recurrenceIdentity: current.recurrenceIdentity,
                    floating: current.floating,
                    timeZone: current.timeZone,
                    cancelled: current.cancelled,
                    excludedStarts: current.excludedStarts,
                    category: current.category,
                    categoryColor: current.categoryColor,
                });
                current = null;
                currentDurationMs = null;
            }
            continue;
        }

        if (!current) {


            const directlyInVcalendar = componentStack.length === 1 && componentStack[0] === 'VCALENDAR';
            if (directlyInVcalendar && (!calendarColorRfc || !calendarColorApple)) {
                const calendarProp = parseIcsLine(line);
                if (calendarProp?.name === 'COLOR' && !calendarColorRfc) {
                    calendarColorRfc = resolveCssColorName(calendarProp.value);
                } else if (calendarProp?.name === 'X-APPLE-CALENDAR-COLOR' && !calendarColorApple) {
                    calendarColorApple = normalizeDerivedIcsColor(calendarProp.value);
                }
            }
            continue;
        }

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
                current.floating = !dt.timeZone;
                current.timeZone = dt.timeZone;
            }
        } else if (name === 'DTEND') {
            const dt = parseIcsDateTime(value, params);
            if (dt) current.end = dt.date;
        } else if (name === 'DURATION') {
            currentDurationMs = parseIcsDurationMs(value);
        } else if (name === 'RRULE') {
            const rule = parseRRule(value);
            if (rule) current.rrule = rule;
        } else if (name === 'EXDATE') {


            for (const entry of value.split(',')) {
                const dt = parseIcsDateTime(entry, params);
                if (!dt) continue;
                if (!current.excludedStarts) current.excludedStarts = new Set();
                current.excludedStarts.add(dt.date.getTime());
            }
        } else if (name === 'RECURRENCE-ID') {
            const dt = parseIcsDateTime(value, params);
            if (dt) {
                current.recurrenceId = dt.date;
                current.recurrenceIdentity = occurrenceIdentity(dt.date, dt.allDay, !dt.timeZone);
            }
        } else if (name === 'STATUS') {
            current.cancelled = value.trim().toUpperCase() === 'CANCELLED';
        } else if (name === 'CATEGORIES' && !current.category) {
            current.category = splitIcsTextList(value)
                .map((entry) => unescapeIcsText(entry).trim())
                .find((entry) => entry.length > 0);
        } else if (name === 'X-FOSSIFY-CATEGORY-COLOR' && !current.categoryColor) {
            current.categoryColor = argbIntToHex(value);
        } else if (name === 'COLOR' && !current.categoryColor) {
            current.categoryColor = resolveCssColorName(value);
        }
    }


    const mastersByUid = new Map<string, ParsedVEvent>();
    for (const event of events) {
        if (event.recurrenceId || !event.rrule || mastersByUid.has(event.uid)) continue;
        mastersByUid.set(event.uid, event);
    }
    for (const event of events) {
        if (!event.recurrenceId) continue;
        const master = mastersByUid.get(event.uid);
        if (!master) continue;
        if (!master.excludedStarts) master.excludedStarts = new Set();
        master.excludedStarts.add(event.recurrenceId.getTime());
    }


    const categories = new Set(
        options.splitByCategory
            ? events.map((event) => event.category).filter((category): category is string => Boolean(category))
            : [],
    );
    const splitByCategory = categories.size > 0 && categories.size <= MAX_CATEGORY_CALENDARS;


    const categoryColors: Record<string, string> = {};
    if (splitByCategory) {
        for (const event of events) {
            if (!event.category || !event.categoryColor || categoryColors[event.category]) continue;
            categoryColors[event.category] = event.categoryColor;
        }
    }

    const occurrences: ExternalCalendarEvent[] = [];
    const maxTotal = options.maxTotalOccurrences ?? 5000;
    for (const event of events) {
        if (occurrences.length >= maxTotal) break;


        if (event.cancelled) continue;
        const expanded = expandRecurringEvent(
            event,
            splitByCategory && event.category
                ? { ...options, sourceId: `${categoryCalendarPrefix(options.sourceId)}${event.category}` }
                : options,
        );
        for (const occ of expanded) {
            occurrences.push({ ...occ, calendarSourceId: options.sourceId });
            if (occurrences.length >= maxTotal) break;
        }
    }


    occurrences.sort((a, b) => a.start.localeCompare(b.start));
    return {
        events: occurrences,
        categoryInfo: {
            names: splitByCategory
                ? [...categories].sort((left, right) => left.localeCompare(right))
                : [],
            hasUncategorized: splitByCategory && events.some((event) => !event.category),
            colors: Object.keys(categoryColors).length > 0 ? categoryColors : undefined,
        },
        calendarColor: calendarColorApple ?? calendarColorRfc,
    };
}


export function expandCategoryCalendars(
    subscription: ExternalCalendarSubscription,
    events: readonly ExternalCalendarEvent[],
    categoryInfo?: IcsCategoryInfo,

    calendarColor?: string,
): ExternalCalendarSubscription[] {
    const prefix = categoryCalendarPrefix(subscription.id);
    const categories: string[] = categoryInfo ? [...categoryInfo.names] : [];
    const seen = new Set<string>();
    let hasUncategorized = categoryInfo?.hasUncategorized ?? false;

    if (!categoryInfo) {
        for (const event of events) {
            if (!event.sourceId.startsWith(prefix)) {
                if (event.sourceId === subscription.id) hasUncategorized = true;
                continue;
            }
            const category = event.sourceId.slice(prefix.length);
            if (!category || seen.has(category)) continue;
            seen.add(category);
            categories.push(category);
        }
    }

    const withFeedColor: ExternalCalendarSubscription = calendarColor
        ? { ...subscription, feedColor: calendarColor }
        : subscription;

    if (categories.length === 0) return [withFeedColor];

    categories.sort((left, right) => left.localeCompare(right));
    const calendars = categories.map((category) => ({
        id: `${prefix}${category}`,
        name: category,
        url: subscription.url,
        enabled: subscription.enabled,
        areaIds: subscription.areaIds,
        feedColor: categoryInfo?.colors?.[category] ?? calendarColor,
    }));
    return hasUncategorized ? [withFeedColor, ...calendars] : calendars;
}
