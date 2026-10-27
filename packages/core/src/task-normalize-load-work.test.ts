import { describe, expect, it, vi } from 'vitest';

// The load normalizer's work per task: one record comparison (and one built object), not one per step. At 5,000 tasks the two-step
// form cost 230 ms of the native boot on the S23's QuickJS.
const counts = vi.hoisted(() => ({ compared: 0 }));
vi.mock('./shallow-identity', async (original) => {
    const actual = await original<typeof import('./shallow-identity')>();
    return { ...actual, sameShallowRecord: (input: object, candidate: object) => { counts.compared += 1; return actual.sameShallowRecord(input, candidate); } };
});

describe('normalizeTaskForLoad work', () => {
    it('compares each task with its normalized form once', async () => {
        const { normalizeTaskForLoad } = await import('./task-status');
        const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, title: `t${i}`, status: i % 2 ? 'done' : 'next', tags: [], contexts: [],
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
        counts.compared = 0;
        for (const task of tasks) normalizeTaskForLoad(task as never, '2026-10-27T10:00:00.000Z');
        expect(counts.compared).toBe(tasks.length);
    });
});
