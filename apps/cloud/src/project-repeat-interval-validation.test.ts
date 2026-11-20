import { describe, expect, it } from 'vitest';
import { validateAppData } from './server-validation';

const document = (months?: unknown) => ({
    tasks: [],
    projects: [{
        id: 'project', title: 'Project', status: 'active', color: '#6b7280', order: 0, tagIds: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        ...(months === undefined ? {} : { repeatAfterMonths: months }),
    }],
    areas: [], sections: [], settings: {},
});

describe('project repeat interval validation', () => {
    it.each([undefined, 1, 1200])('accepts a supported repeat interval %s', (months) => {
        expect(validateAppData(document(months)).ok).toBe(true);
    });

    it.each([null, 0, 1.5, 1201, '6', true])('rejects an invalid repeat interval %s', (months) => {
        expect(validateAppData(document(months))).toEqual({ ok: false, error: 'Invalid data: project project: Invalid project repeatAfterMonths' });
    });
});
