import { describe, expect, it } from 'vitest';
import { validateAppData } from './server-validation';

const document = (interval: Record<string, unknown>) => ({
    tasks: [],
    projects: [{
        id: 'project', title: 'Project', status: 'active', color: '#6b7280', order: 0, tagIds: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        ...interval,
    }],
    areas: [], sections: [], settings: {},
});

describe('project repeat interval validation', () => {
    it.each([
        {}, { repeatAfterMonths: 6 }, { repeatAfterCount: 1, repeatAfterUnit: 'day' },
        { repeatAfterCount: 1200, repeatAfterUnit: 'week' }, { repeatAfterCount: 1, repeatAfterUnit: 'month' },
        { repeatAfterCount: 1, repeatAfterUnit: 'year' },
    ])('accepts a supported repeat interval %j', (interval) => {
        expect(validateAppData(document(interval)).ok).toBe(true);
    });

    it.each([
        ...[null, 0, 1.5, 1201, '6', true].map(repeatAfterCount => ({ repeatAfterCount, repeatAfterUnit: 'month' })),
        { repeatAfterCount: 6 }, { repeatAfterUnit: 'month' }, { repeatAfterCount: 6, repeatAfterUnit: 'months' },
        { repeatAfterMonths: '6' }, { repeatAfterMonths: 6, repeatAfterCount: 6 },
    ])('rejects an invalid repeat interval %j', (interval) => {
        expect(validateAppData(document(interval))).toEqual({ ok: false, error: 'Invalid data: project project: Invalid project repeat interval' });
    });
});
