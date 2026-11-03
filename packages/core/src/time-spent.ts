


export const TIME_SPENT_MAX_MINUTES = 100_000;


export function normalizeTimeSpentMinutes(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const rounded = Math.round(value);
    if (rounded <= 0) return undefined;
    return Math.min(rounded, TIME_SPENT_MAX_MINUTES);
}


export function formatTimeSpentLabel(value: unknown): string | null {
    const minutes = normalizeTimeSpentMinutes(value);
    if (minutes === undefined) return null;
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hrs <= 0) return `${mins}m`;
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}


export function addTimeSpentMinutes(current: unknown, addMinutes: number): number | undefined {
    const base = normalizeTimeSpentMinutes(current) ?? 0;
    const add = normalizeTimeSpentMinutes(addMinutes) ?? 0;
    return normalizeTimeSpentMinutes(base + add);
}
