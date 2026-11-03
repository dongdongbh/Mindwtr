


export type DateTimeParts = {
    date: string;
    time: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_PATTERN = /^\d{2}:\d{2}$/u;

export function splitDateTimeLocal(value: string): DateTimeParts {
    const [rawDate = '', rawTimeWithSeconds = ''] = String(value ?? '').split('T');
    const date = DATE_PATTERN.test(rawDate) ? rawDate : '';

    const time = rawTimeWithSeconds.slice(0, 5);
    return { date, time: TIME_PATTERN.test(time) ? time : '' };
}


export function joinDateTimeLocal({ date, time }: DateTimeParts): string {
    if (!DATE_PATTERN.test(date)) return '';
    return `${date}T${TIME_PATTERN.test(time) ? time : '00:00'}`;
}


export function parseDateTimeLocalDate(value: string): Date | null {
    const { date } = splitDateTimeLocal(value);
    if (!date) return null;
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
