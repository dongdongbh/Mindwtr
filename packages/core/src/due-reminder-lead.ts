/** A bounded lead time; absent, zero and malformed values leave advance reminders off. */
export function normalizeDueReminderLeadMinutes(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_080 ? value : undefined;
}

/** Start prealerts use the supported minute presets; zero is explicitly off. */
export function normalizeStartReminderLeadMinutes(value: unknown): number | undefined {
    const minutes = normalizeDueReminderLeadMinutes(value);
    return minutes === 0 || minutes === 5 || minutes === 15 || minutes === 30 || minutes === 60 ? minutes : undefined;
}
