import { format, isValid, parseISO } from 'date-fns';

/**
 * Safely formats a date string, handling undefined, null, or invalid dates.
 * 
 * @param dateStr - The date string to format (e.g. ISO string) or Date object
 * @param formatStr - The format string (date-fns format)
 * @param fallback - Optional fallback string (default: '')
 * @returns Formatted date string or fallback
 */
export function safeFormatDate(
    dateStr: string | Date | undefined | null,
    formatStr: string,
    fallback: string = ''
): string {
    if (!dateStr) return fallback;

    try {
        const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
        if (!isValid(date)) return fallback;
        return format(date, formatStr);
    } catch {
        return fallback;
    }
}

/**
 * Safely parses a date string to a Date object.
 * Returns null if invalid.
 */
export function safeParseDate(dateStr: string | undefined | null): Date | null {
    if (!dateStr) return null;
    try {
        const date = parseISO(dateStr);
        return isValid(date) ? date : null;
    } catch {
        return null;
    }
}
