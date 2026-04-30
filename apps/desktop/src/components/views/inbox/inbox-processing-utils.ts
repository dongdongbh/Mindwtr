import { hasTimeComponent, normalizeClockTimeInput, safeFormatDate, safeParseDate } from '@mindwtr/core';

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

export const normalizeTimeInput = normalizeClockTimeInput;

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
