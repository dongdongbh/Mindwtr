import { differenceInCalendarDays } from 'date-fns';
import { createDateFormatter, hasTimeComponent, safeParseDate, safeParseDueDate, type DateFormattingConfig } from './date';
import { tFallback, type TranslateFn } from './i18n';

export type TaskScheduleDisplay = {
    label: string;
    exactLabel: string;
};

export function formatTaskScheduleDisplay(input: {
    value: string | undefined;
    kind: 'start' | 'due';
    relative: boolean;
    now: Date;
    dateFormatting: DateFormattingConfig;
    t: TranslateFn;
}): TaskScheduleDisplay | null {
    const date = input.kind === 'due' ? safeParseDueDate(input.value) : safeParseDate(input.value);
    if (!date) return null;
    const formatDate = createDateFormatter(input.dateFormatting);
    const timed = hasTimeComponent(input.value);
    const exactLabel = formatDate(date, timed ? 'Pp' : 'P');
    const days = differenceInCalendarDays(date, input.now);
    if (!input.relative || !Number.isFinite(days) || days < 0 || days >= 7) return { label: exactLabel, exactLabel };
    const day = days === 0
        ? tFallback(input.t, 'quickDate.today', 'Today')
        : days === 1 ? tFallback(input.t, 'quickDate.tomorrow', 'Tomorrow') : formatDate(date, 'EEEE');
    return { label: timed ? `${day} · ${formatDate(date, 'p')}` : day, exactLabel };
}
