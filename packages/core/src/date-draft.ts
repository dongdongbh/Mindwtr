import { hasTimeComponent, safeFormatDate, safeParseDate } from './date';

export type DateTimeDraft = {
    date: string;
    time: string;
};


export function splitDateTime(iso: string | undefined | null): DateTimeDraft {
    if (!iso) return { date: '', time: '' };
    const parsed = safeParseDate(iso);
    if (!parsed) return { date: '', time: '' };
    return {
        date: safeFormatDate(parsed, 'yyyy-MM-dd'),
        time: hasTimeComponent(iso) ? safeFormatDate(parsed, 'HH:mm') : '',
    };
}


export function joinDateTime(date: string, time: string, opts?: { defaultTime?: string }): string {
    if (!date) return '';
    if (time) return `${date}T${time}`;
    if (opts?.defaultTime) return `${date}T${opts.defaultTime}`;
    return date;
}
