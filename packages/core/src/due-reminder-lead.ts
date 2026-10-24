/** A bounded lead time; absent, zero and malformed values leave advance reminders off. */
export function normalizeDueReminderLeadMinutes(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_080 ? value : undefined;
}
