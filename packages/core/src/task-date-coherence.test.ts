import { describe, expect, it, vi } from 'vitest';
import {
    getTaskDateCoherence,
    getTaskDateCoherenceIssues,
    isTaskDateCoherent,
} from './task-date-coherence';

describe('task date coherence', () => {
    it('reports start dates after due dates', () => {
        expect(getTaskDateCoherenceIssues({
            startTime: '2026-04-25',
            dueDate: '2026-04-24',
        })).toEqual([{
            code: 'start_after_due',
            field: 'startTime',
            relatedField: 'dueDate',
        }]);
        expect(getTaskDateCoherence({
            startTime: '2026-04-25',
            dueDate: '2026-04-24',
        }).coherent).toBe(false);
    });

    it('treats missing and invalid dates as coherent', () => {
        expect(isTaskDateCoherent({ startTime: undefined, dueDate: '2026-04-24' })).toBe(true);
        expect(isTaskDateCoherent({ startTime: '2026-04-25', dueDate: undefined })).toBe(true);
        expect(isTaskDateCoherent({ startTime: 'not-a-date', dueDate: '2026-04-24' })).toBe(true);
        expect(isTaskDateCoherent({ startTime: '2026-04-25', dueDate: 'not-a-date' })).toBe(true);
    });

    it('allows equal dates and same-day date-only starts', () => {
        expect(isTaskDateCoherent({
            startTime: '2026-04-24',
            dueDate: '2026-04-24',
        })).toBe(true);
        expect(isTaskDateCoherent({
            startTime: '2026-04-24T22:30',
            dueDate: '2026-04-24',
        })).toBe(true);
        expect(isTaskDateCoherent({
            startTime: '2026-04-24T10:00',
            dueDate: '2026-04-24T10:00',
        })).toBe(true);
    });

    it('compares timed dates precisely when a due time exists', () => {
        expect(isTaskDateCoherent({
            startTime: '2026-04-24T10:30',
            dueDate: '2026-04-24T10:00',
        })).toBe(false);
        expect(isTaskDateCoherent({
            startTime: '2026-04-24',
            dueDate: '2026-04-24T10:00',
        })).toBe(true);
    });

    it('uses a frozen local start day for date-only due replay across timezone changes', () => {
        const task = { startTime: '2026-11-01T02:30:00.000Z', dueDate: '2026-10-31' };

        vi.stubEnv('TZ', 'UTC');
        expect(isTaskDateCoherent(task, { startLocalDay: '2026-10-31' })).toBe(true);
        expect(isTaskDateCoherent({ ...task, dueDate: '2026-10-30' }, { startLocalDay: '2026-10-31' })).toBe(false);
        expect(isTaskDateCoherent({ ...task, dueDate: '2026-11-01T02:00:00.000Z' },
            { startLocalDay: '2026-10-31' })).toBe(false);
        vi.unstubAllEnvs();
    });
});
