import { hasTimeComponent, safeFormatDate, safeParseDate } from '@mindwtr/core';

export const parseTokenListInput = (value: string, prefix: '@' | '#'): string[] => Array.from(
    new Set(
        value
            .split(/[,\n]+/)
            .map((part) => part.trim())
            .map((part) => part.replace(/^[@#]+/, '').trim())
            .filter(Boolean)
            .map((part) => `${prefix}${part}`)
    )
);

export const mergeSuggestedTokens = (...groups: string[][]): string[] =>
    Array.from(new Set(groups.flat()));

export const normalizeTimeInput = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    const compact = trimmed.replace(/\s+/g, '');
    let hours: number;
    let minutes: number;
    if (/^\d{1,2}:\d{2}$/.test(compact)) {
        const [h, m] = compact.split(':');
        hours = Number(h);
        minutes = Number(m);
    } else if (/^\d{3,4}$/.test(compact)) {
        if (compact.length === 3) {
            hours = Number(compact.slice(0, 1));
            minutes = Number(compact.slice(1));
        } else {
            hours = Number(compact.slice(0, 2));
            minutes = Number(compact.slice(2));
        }
    } else {
        return null;
    }
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

export const getDateFieldDraft = (value?: string): { date: string; time: string; timeDraft: string } => {
    const parsed = value ? safeParseDate(value) : null;
    const date = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
    const time = parsed && value && hasTimeComponent(value)
        ? safeFormatDate(parsed, 'HH:mm')
        : '';

    return {
        date,
        time,
        timeDraft: time,
    };
};

export const resolveCommittedTime = (
    draft: string,
    committed: string,
): { time: string; timeDraft: string } => {
    const normalized = normalizeTimeInput(draft);
    if (normalized === null) {
        return {
            time: committed,
            timeDraft: committed,
        };
    }

    return {
        time: normalized,
        timeDraft: normalized,
    };
};

export const buildDateTimeUpdate = (
    date: string,
    timeDraft: string,
    committedTime: string,
): string | undefined => {
    if (!date) return undefined;
    const normalized = normalizeTimeInput(timeDraft);
    const resolvedTime = normalized === null ? committedTime : normalized;
    return resolvedTime ? `${date}T${resolvedTime}` : date;
};
