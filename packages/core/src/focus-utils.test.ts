import { describe, expect, it } from 'vitest';
import {
    DEFAULT_FOCUS_TASK_LIMIT,
    FOCUS_TASK_LIMIT_OPTIONS,
    MAX_FOCUS_TASK_LIMIT,
    MIN_FOCUS_TASK_LIMIT,
    formatFocusTaskLimitText,
    normalizeFocusTaskLimit,
} from './focus-utils';

describe('focus-utils', () => {
    it('normalizes focus task limits with a conservative default', () => {
        expect(normalizeFocusTaskLimit(undefined)).toBe(DEFAULT_FOCUS_TASK_LIMIT);
        expect(normalizeFocusTaskLimit('5')).toBe(5);
        expect(normalizeFocusTaskLimit(5.8)).toBe(5);
        expect(normalizeFocusTaskLimit(0)).toBe(MIN_FOCUS_TASK_LIMIT);
        expect(normalizeFocusTaskLimit(99)).toBe(MAX_FOCUS_TASK_LIMIT);
    });

    it('round-trips every focus limit option through normalization', () => {
        for (const option of FOCUS_TASK_LIMIT_OPTIONS) {
            expect(normalizeFocusTaskLimit(option)).toBe(option);
        }
    });

    it('formats dynamic focus limit text from new and legacy labels', () => {
        expect(formatFocusTaskLimitText('Max {{count}} focus items', 5)).toBe('Max 5 focus items');
        expect(formatFocusTaskLimitText('Max 3 focus items', 10)).toBe('Max 10 focus items');
        expect(formatFocusTaskLimitText('Max {{count}} focus item(s)', 1)).toBe('Max 1 focus item(s)');
    });
});
