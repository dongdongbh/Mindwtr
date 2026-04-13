import { parseIcs, type ExternalCalendarEvent, type ExternalCalendarSubscription } from '@mindwtr/core';
import { ExternalCalendarService } from './external-calendar-service';
import { isTauriRuntime } from './runtime';
import { fetchSystemCalendarEvents } from './system-calendar';

export const summarizeExternalCalendarWarnings = (warnings: string[]): string | null => {
    if (warnings.length === 0) return null;
    if (warnings.length === 1) return warnings[0];
    return `${warnings[0]} (+${warnings.length - 1} more)`;
};

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
    if (isTauriRuntime()) {
        const mod: any = await import('@tauri-apps/plugin-http');
        const tauriFetch: any = mod.fetch;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await tauriFetch(url, { method: 'GET', signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } finally {
            clearTimeout(timeout);
        }
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export async function fetchExternalCalendarEvents(
    rangeStart: Date,
    rangeEnd: Date,
): Promise<{
    calendars: ExternalCalendarSubscription[];
    events: ExternalCalendarEvent[];
    warnings: string[];
}> {
    const calendars = await ExternalCalendarService.getCalendars();
    const enabled = calendars.filter((calendar) => calendar.enabled);

    const [icsResults, systemResults] = await Promise.all([
        Promise.allSettled(
            enabled.map(async (calendar) => {
                const text = await fetchTextWithTimeout(calendar.url, 15_000);
                return parseIcs(text, { sourceId: calendar.id, rangeStart, rangeEnd });
            })
        ),
        fetchSystemCalendarEvents(rangeStart, rangeEnd),
    ]);

    const events: ExternalCalendarEvent[] = [...systemResults.events];
    const warnings: string[] = [];
    for (const [index, result] of icsResults.entries()) {
        if (result.status !== 'fulfilled') {
            const calendar = enabled[index];
            const label = (calendar?.name || calendar?.url || 'Unnamed calendar').trim();
            const detail = result.reason instanceof Error ? result.reason.message : String(result.reason ?? 'Unknown error');
            warnings.push(`Failed to load "${label}": ${detail}`);
            continue;
        }
        events.push(...result.value);
    }

    const mergedCalendars = [...calendars];
    const existingIds = new Set(mergedCalendars.map((calendar) => calendar.id));
    for (const systemCalendar of systemResults.calendars) {
        if (existingIds.has(systemCalendar.id)) continue;
        existingIds.add(systemCalendar.id);
        mergedCalendars.push(systemCalendar);
    }

    events.sort((a, b) => {
        if (a.start === b.start) return a.title.localeCompare(b.title);
        return a.start.localeCompare(b.start);
    });

    return { calendars: mergedCalendars, events, warnings };
}
