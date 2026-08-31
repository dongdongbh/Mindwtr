import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@mindwtr/core';
import { resolveDoneTaskSortBy, resolveNonDoneTaskSortBy } from './task-list-sort';

const settingsWith = (timeEstimates: boolean) => ({ features: { timeEstimates } } as AppSettings);

describe('task list sort preferences', () => {
    it('keeps legacy completion sorting in Done and out of every ordinary view', () => {
        expect(resolveDoneTaskSortBy('completed', undefined, undefined)).toBe('completed');
        expect(resolveNonDoneTaskSortBy('completed', undefined)).toBe('default');
    });

    it('keeps the device-local Done preference separate from the synced ordinary preference', () => {
        expect(resolveDoneTaskSortBy('title', 'completed', undefined)).toBe('completed');
        expect(resolveDoneTaskSortBy('title', undefined, undefined)).toBe('default');
        expect(resolveNonDoneTaskSortBy('title', undefined)).toBe('title');
    });

    it('falls back to the default order while Time estimates is off (#1107)', () => {
        expect(resolveNonDoneTaskSortBy('timeEstimate', settingsWith(false))).toBe('default');
        expect(resolveDoneTaskSortBy('title', 'timeEstimate', settingsWith(false))).toBe('default');
    });

    it('keeps the time-estimate order with the feature on or unset', () => {
        expect(resolveNonDoneTaskSortBy('timeEstimate', settingsWith(true))).toBe('timeEstimate');
        expect(resolveNonDoneTaskSortBy('timeEstimate', undefined)).toBe('timeEstimate');
        expect(resolveDoneTaskSortBy('title', 'timeEstimate', settingsWith(true))).toBe('timeEstimate');
    });
});
