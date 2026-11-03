
export function normalizeDueReminderLeadMinutes(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_080 ? value : undefined;
}


export function normalizeStartReminderLeadMinutes(value: unknown): number | undefined {
    const minutes = normalizeDueReminderLeadMinutes(value);
    return minutes === 0 || minutes === 5 || minutes === 15 || minutes === 30 || minutes === 60 ? minutes : undefined;
}
