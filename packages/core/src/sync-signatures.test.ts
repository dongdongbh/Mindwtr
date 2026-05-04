import { describe, expect, it } from 'vitest';
import { normalizeAreaForContentComparison, toComparableSignature } from './sync-signatures';
import type { Area } from './types';

const area = (updates: Partial<Area> = {}): Area => ({
    id: 'area-1',
    name: 'Work',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...updates,
});

describe('sync signatures', () => {
    it('normalizes area default color and ordering for content comparison', () => {
        const local = normalizeAreaForContentComparison(area({
            color: '#6B7280',
            order: 10,
            name: '  Work  ',
        }));
        const incoming = normalizeAreaForContentComparison(area({
            order: 1,
            name: 'Work',
        }));

        expect(toComparableSignature(local)).toBe(toComparableSignature(incoming));
    });
});
