import { describe, expect, it } from 'vitest';
import { validateAppData, validateEntityProps } from './server-validation';

const reference = { sourceId: 'feed', uid: 'event', sourceName: 'Calendar', title: 'Meeting',
    start: '2026-11-01T10:00:00.000Z', end: '2026-11-01T11:00:00.000Z', allDay: false };

describe('Project calendar reference API validation', () => {
    it('accepts a bounded reference, explicit removal and older payload omission', () => {
        for (const value of [{ calendarReference: reference }, { calendarReference: null }, {}]) {
            expect(validateEntityProps('project', 'create', value).ok).toBe(true);
            expect(validateEntityProps('project', 'patch', value).ok).toBe(true);
        }
    });

    it('rejects invalid snapshots in writes and full synced documents', () => {
        for (const value of [true, {}, { ...reference, uid: 'x'.repeat(2049) }, { ...reference, allDay: 1 },
            { ...reference, end: '2026-10-31T00:00:00.000Z' }, { ...reference, url: 'https://example.com/private' }]) {
            expect(validateEntityProps('project', 'create', { calendarReference: value }).ok).toBe(false);
            expect(validateEntityProps('project', 'patch', { calendarReference: value }).ok).toBe(false);
            expect(validateAppData({ tasks: [], projects: [{ id: 'p', title: 'P', status: 'active', color: '#6b7280',
                createdAt: reference.start, updatedAt: reference.start, order: 0, tagIds: [], calendarReference: value }],
                areas: [], sections: [], settings: {} }).ok).toBe(false);
        }
    });
});
