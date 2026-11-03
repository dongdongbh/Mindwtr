import { parseIcs, type ExternalCalendarEvent, type ExternalCalendarSubscription } from '@mindwtr/core';
import { logInfo } from './app-log';
import { isTauriRuntime } from './runtime';
import { reportError } from './report-error';
import { invokeNative } from './tauri-invoke';

export type SystemCalendarPermissionStatus = 'undetermined' | 'granted' | 'denied' | 'unsupported';

export type SystemCalendarPushTarget = {
    id: string;
    name: string;
    sourceName?: string;
    color?: string;
    isMindwtrDedicated: boolean;
};

export type SystemCalendarEventDetails = {
    calendarId: string;
    title: string;
    start: string;
    end: string;
    startDate?: string;
    endDate?: string;
    allDay: boolean;
    notes?: string;
    location?: string;
};

type SystemCalendarReadResult = {
    permission: SystemCalendarPermissionStatus;
    calendars: ExternalCalendarSubscription[];
    events: ExternalCalendarEvent[];
};

type LinuxCalendarReadResult = {
    permission: SystemCalendarPermissionStatus;
    calendars: ExternalCalendarSubscription[];
    icsSources?: Array<{
        sourceId: string;
        ics: string[];
    }>;
};

type NativeCalendarEventWriteResult = {
    ok?: boolean;
    eventId?: string;
    error?: string;
};

export type SystemCalendarEventWriteResult = {
    ok: boolean;
    eventId: string | null;
    error?: string;
};

const UNSUPPORTED_RESULT: SystemCalendarReadResult = {
    permission: 'unsupported',
    calendars: [],
    events: [],
};

const normalizePermissionStatus = (value: unknown): SystemCalendarPermissionStatus => {
    if (value === 'undetermined' || value === 'granted' || value === 'denied' || value === 'unsupported') {
        return value;
    }
    return 'denied';
};

const calendarReadDiagnosticCounts = (
    calendars: ExternalCalendarSubscription[],
    events: ExternalCalendarEvent[],
): Record<string, string> => {
    let allDayCount = 0;
    let allDayNonMidnightCount = 0;
    let localDayAheadCount = 0;
    let localDayBehindCount = 0;

    for (const event of events) {
        if (event.allDay) allDayCount += 1;
        const start = new Date(event.start);
        if (!Number.isFinite(start.getTime())) continue;
        if (event.allDay && (
            start.getHours() !== 0
            || start.getMinutes() !== 0
            || start.getSeconds() !== 0
            || start.getMilliseconds() !== 0
        )) {
            allDayNonMidnightCount += 1;
        }
        const localDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
        const utcDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
        if (localDay > utcDay) localDayAheadCount += 1;
        else if (localDay < utcDay) localDayBehindCount += 1;
    }


    const nativeColorCount = calendars.filter((calendar) => (
        [calendar.color, calendar.feedColor].some((value) => typeof value === 'string' && value.trim().length > 0)
    )).length;

    return {
        calendarCount: String(calendars.length),
        eventCount: String(events.length),
        allDayCount: String(allDayCount),
        timedCount: String(events.length - allDayCount),
        allDayNonMidnightCount: String(allDayNonMidnightCount),
        localDayAheadCount: String(localDayAheadCount),
        localDayBehindCount: String(localDayBehindCount),
        nativeColorCount: String(nativeColorCount),
        fallbackColorCount: String(calendars.length - nativeColorCount),
    };
};

export type SystemCalendarPlatform = 'macos' | 'linux';

export const getSystemCalendarPlatform = (): SystemCalendarPlatform | null => {
    if (typeof navigator === 'undefined') return null;
    const source = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
    if (source.includes('mac')) return 'macos';
    if (source.includes('linux')) return 'linux';
    return null;
};

export async function getSystemCalendarPermissionStatus(): Promise<SystemCalendarPermissionStatus> {
    const platform = getSystemCalendarPlatform();
    if (!isTauriRuntime() || !platform) return 'unsupported';
    try {
        const command = platform === 'macos'
            ? 'get_macos_calendar_permission_status'
            : 'get_linux_calendar_permission_status';
        const status = await invokeNative<string>(command);
        return normalizePermissionStatus(status);
    } catch (error) {
        reportError('Failed to read system calendar permission status', error);
        return 'denied';
    }
}

export async function requestSystemCalendarPermission(): Promise<SystemCalendarPermissionStatus> {
    const platform = getSystemCalendarPlatform();
    if (!isTauriRuntime() || !platform) return 'unsupported';
    try {
        const command = platform === 'macos'
            ? 'request_macos_calendar_permission'
            : 'request_linux_calendar_permission';
        const status = await invokeNative<string>(command);
        return normalizePermissionStatus(status);
    } catch (error) {
        reportError('Failed to request system calendar permission', error);
        return 'denied';
    }
}

export async function fetchSystemCalendarEvents(rangeStart: Date, rangeEnd: Date): Promise<SystemCalendarReadResult> {
    const platform = getSystemCalendarPlatform();
    if (!isTauriRuntime() || !platform) return UNSUPPORTED_RESULT;
    try {
        const command = platform === 'macos' ? 'get_macos_calendar_events' : 'get_linux_calendar_events';
        const payload = await invokeNative<SystemCalendarReadResult | LinuxCalendarReadResult>(command, {
            rangeStart: rangeStart.toISOString(),
            rangeEnd: rangeEnd.toISOString(),
        });
        const events = platform === 'linux'
            ? ((payload as LinuxCalendarReadResult).icsSources ?? []).flatMap((source) => (
                Array.isArray(source.ics)
                    ? source.ics.flatMap((ics) => parseIcs(ics, {
                        sourceId: source.sourceId,
                        rangeStart,
                        rangeEnd,
                    }))
                    : []
            ))
            : (payload as SystemCalendarReadResult).events;
        const result = {
            permission: normalizePermissionStatus(payload?.permission),
            calendars: Array.isArray(payload?.calendars) ? payload.calendars : [],
            events: Array.isArray(events) ? events : [],
        };
        void logInfo('Calendar date and color diagnostic snapshot', {
            scope: 'calendar',
            extra: {
                releaseCheck: 'v1.3.1/calendar-date-color-diagnostics',
                platform,
                ...calendarReadDiagnosticCounts(result.calendars, result.events),
            },
        });
        return result;
    } catch (error) {
        reportError('Failed to read system calendar events', error);
        return {
            permission: 'denied',
            calendars: [],
            events: [],
        };
    }
}

const sanitizePushTarget = (target: SystemCalendarPushTarget): SystemCalendarPushTarget | null => {
    const id = typeof target?.id === 'string' ? target.id.trim() : '';
    if (!id) return null;
    const name = typeof target?.name === 'string' && target.name.trim().length > 0
        ? target.name.trim()
        : 'Calendar';
    return {
        id,
        name,
        sourceName: typeof target.sourceName === 'string' && target.sourceName.trim().length > 0
            ? target.sourceName.trim()
            : undefined,
        color: typeof target.color === 'string' && target.color.trim().length > 0 ? target.color.trim() : undefined,
        isMindwtrDedicated: target.isMindwtrDedicated === true,
    };
};

export async function getSystemCalendarPushTargets(): Promise<SystemCalendarPushTarget[]> {
    const platform = getSystemCalendarPlatform();
    if (!isTauriRuntime() || !platform) return [];
    try {
        const command = platform === 'macos'
            ? 'get_macos_writable_calendars'
            : 'get_linux_writable_calendars';
        const targets = await invokeNative<SystemCalendarPushTarget[]>(command);
        return Array.isArray(targets)
            ? targets.map(sanitizePushTarget).filter((target): target is SystemCalendarPushTarget => Boolean(target))
            : [];
    } catch (error) {
        reportError('Failed to read writable system calendars', error);
        return [];
    }
}

export async function ensureSystemMindwtrCalendar(storedCalendarId?: string | null): Promise<SystemCalendarPushTarget | null> {
    const platform = getSystemCalendarPlatform();
    if (!isTauriRuntime() || !platform) return null;
    try {
        const command = platform === 'macos'
            ? 'ensure_macos_mindwtr_calendar'
            : 'ensure_linux_mindwtr_calendar';
        const target = await invokeNative<SystemCalendarPushTarget | null>(command, {
            storedCalendarId: storedCalendarId?.trim() || null,
        });
        return target ? sanitizePushTarget(target) : null;
    } catch (error) {
        reportError('Failed to create Mindwtr system calendar', error);
        return null;
    }
}

const normalizeWriteResult = (result: NativeCalendarEventWriteResult | null | undefined): SystemCalendarEventWriteResult => {
    const eventId = typeof result?.eventId === 'string' ? result.eventId.trim() : '';
    const error = typeof result?.error === 'string' && result.error.trim().length > 0
        ? result.error.trim()
        : undefined;
    return {
        ok: result?.ok === true,
        eventId: eventId || null,
        error,
    };
};

export async function createSystemCalendarEventResult(details: SystemCalendarEventDetails): Promise<SystemCalendarEventWriteResult> {
    const platform = getSystemCalendarPlatform();
    if (!isTauriRuntime() || !platform) {
        return { ok: false, eventId: null, error: 'unsupported' };
    }
    try {
        const command = platform === 'macos' ? 'create_macos_calendar_event' : 'create_linux_calendar_event';
        const result = await invokeNative<NativeCalendarEventWriteResult>(command, { details });
        return normalizeWriteResult(result);
    } catch (error) {
        reportError('Failed to create system calendar event', error);
        return { ok: false, eventId: null, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function createSystemCalendarEvent(details: SystemCalendarEventDetails): Promise<string | null> {
    const result = await createSystemCalendarEventResult(details);
    return result.ok ? result.eventId : null;
}

export async function updateSystemCalendarEventResult(
    eventId: string,
    details: SystemCalendarEventDetails
): Promise<SystemCalendarEventWriteResult> {
    const platform = getSystemCalendarPlatform();
    if (!isTauriRuntime() || !platform) {
        return { ok: false, eventId: null, error: 'unsupported' };
    }
    try {
        const command = platform === 'macos' ? 'update_macos_calendar_event' : 'update_linux_calendar_event';
        const result = await invokeNative<NativeCalendarEventWriteResult>(command, { eventId, details });
        return normalizeWriteResult(result);
    } catch (error) {
        reportError('Failed to update system calendar event', error);
        return { ok: false, eventId: null, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function updateSystemCalendarEvent(eventId: string, details: SystemCalendarEventDetails): Promise<string | null> {
    const result = await updateSystemCalendarEventResult(eventId, details);
    return result.ok ? result.eventId : null;
}

export async function deleteSystemCalendarEventResult(eventId: string): Promise<SystemCalendarEventWriteResult> {
    const platform = getSystemCalendarPlatform();
    if (!isTauriRuntime() || !platform) {
        return { ok: false, eventId: null, error: 'unsupported' };
    }
    try {
        const command = platform === 'macos' ? 'delete_macos_calendar_event' : 'delete_linux_calendar_event';
        const result = await invokeNative<NativeCalendarEventWriteResult>(command, { eventId });
        return normalizeWriteResult(result);
    } catch (error) {
        reportError('Failed to delete system calendar event', error);
        return { ok: false, eventId: null, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function deleteSystemCalendarEvent(eventId: string): Promise<boolean> {
    const result = await deleteSystemCalendarEventResult(eventId);
    return result.ok;
}
