import { describe, expect, it, vi } from 'vitest';
import {
    chooseDeterministicWinner,
    normalizeAreaForContentComparison,
    normalizeProjectForContentComparison,
    normalizeSectionForContentComparison,
    normalizeTaskForContentComparison,
    getMergeComparableSignature,
    setSignatureCacheValidationForTests,
    toComparableSignature,
} from './sync-signatures';
import type { Area, Project, Section, Task } from './types';

const area = (updates: Partial<Area> = {}): Area => ({
    id: 'area-1',
    name: 'Work',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...updates,
});

const task = (updates: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 2,
    revBy: 'device-a',
    ...updates,
});

const section = (updates: Partial<Section> = {}): Section => ({
    id: 'section-1',
    projectId: 'project-1',
    title: 'Section',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 2,
    revBy: 'device-a',
    ...updates,
});

const project = (updates: Partial<Project> = {}): Project => ({
    id: 'project-1',
    title: 'Project',
    status: 'active',
    color: '#6B7280',
    order: 0,
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...updates,
});

describe('sync signatures', () => {
    it('treats default, undefined, null, and missing project taskSortBy as equal', () => {
        const missing = toComparableSignature(normalizeProjectForContentComparison(project()));
        const undefinedValue = toComparableSignature(normalizeProjectForContentComparison(project({ taskSortBy: undefined })));
        const defaultValue = toComparableSignature(normalizeProjectForContentComparison(project({ taskSortBy: 'default' })));
        const nullValue = toComparableSignature(normalizeProjectForContentComparison({
            ...project(),
            taskSortBy: null,
        } as unknown as Project));
        const invalidValue = toComparableSignature(normalizeProjectForContentComparison({
            ...project(),
            taskSortBy: 'done-desc',
        } as unknown as Project));
        const dueValue = toComparableSignature(normalizeProjectForContentComparison(project({ taskSortBy: 'due' })));

        expect(undefinedValue).toBe(missing);
        expect(defaultValue).toBe(missing);
        expect(nullValue).toBe(missing);
        expect(invalidValue).toBe(missing);
        expect(dueValue).not.toBe(missing);
    });

    it('omits repeatReminderMinutes from the task signature when off, includes it when set', () => {
        const undef = toComparableSignature(normalizeTaskForContentComparison(task()));
        const zero = toComparableSignature(normalizeTaskForContentComparison(task({ repeatReminderMinutes: 0 })));
        const set15 = toComparableSignature(normalizeTaskForContentComparison(task({ repeatReminderMinutes: 15 })));
        expect(zero).toBe(undef);
        expect(set15).not.toBe(undef);
    });

    it('omits timeSpentMinutes from the task signature when zero, includes it when set', () => {
        const undef = toComparableSignature(normalizeTaskForContentComparison(task()));
        const zero = toComparableSignature(normalizeTaskForContentComparison(task({ timeSpentMinutes: 0 })));
        const set75 = toComparableSignature(normalizeTaskForContentComparison(task({ timeSpentMinutes: 75 })));
        expect(zero).toBe(undef);
        expect(set75).not.toBe(undef);
    });

    it('ignores unknown legacy task fields in content signatures', () => {
        const base = normalizeTaskForContentComparison(task());
        const withLegacyField = normalizeTaskForContentComparison({
            ...task(),
            removedLegacyField: 'stale remote value',
        } as Task & Record<string, unknown>);

        expect(toComparableSignature(withLegacyField)).toBe(toComparableSignature(base));
        expect(withLegacyField).not.toHaveProperty('removedLegacyField');
    });

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

    it('returns byte-identical signatures for an entity and its clone (identity memo parity)', () => {
        const first = normalizeAreaForContentComparison(area({ rev: 3, revBy: 'device-a' }));
        const clone = { ...first };

        // First call caches by identity; the clone takes the uncached path.
        expect(toComparableSignature(first)).toBe(toComparableSignature(clone));
        // Repeat on the cached reference: same answer.
        expect(toComparableSignature(first)).toBe(toComparableSignature(clone));
    });

    it('computes the same object signature once (identity memo has teeth)', () => {
        // Cache-hit validation recomputes on every hit under NODE_ENV=test; turn
        // it off so the spy can observe the true memoized path.
        setSignatureCacheValidationForTests(false);
        try {
            const item = normalizeAreaForContentComparison(area({ rev: 4, name: 'Memoized' }));
            toComparableSignature(item);
            const stringifySpy = vi.spyOn(JSON, 'stringify');
            toComparableSignature(item);
            expect(stringifySpy).not.toHaveBeenCalled();
            stringifySpy.mockRestore();
        } finally {
            setSignatureCacheValidationForTests(true);
        }
    });

    it('a cached entity mutated in place fails loudly under test validation', () => {
        const item = normalizeAreaForContentComparison(area({ rev: 6, name: 'Guarded' }));
        toComparableSignature(item);
        (item as Record<string, unknown>).name = 'Mutated in place';
        expect(() => toComparableSignature(item)).toThrow(/mutated in place/);
    });

    it('applies the merge normalizer inside getMergeComparableSignature and matches the manual pipeline', () => {
        setSignatureCacheValidationForTests(false);
        try {
            const raw = area({ rev: 5, name: 'Merge' });
            const viaMemo = getMergeComparableSignature(raw, normalizeAreaForContentComparison);
            const manual = toComparableSignature(normalizeAreaForContentComparison({ ...raw }));
            expect(viaMemo).toBe(manual);
            // Cached on the raw object: second call computes nothing.
            const stringifySpy = vi.spyOn(JSON, 'stringify');
            expect(getMergeComparableSignature(raw, normalizeAreaForContentComparison)).toBe(viaMemo);
            expect(stringifySpy).not.toHaveBeenCalled();
            stringifySpy.mockRestore();
        } finally {
            setSignatureCacheValidationForTests(true);
        }
    });

    it('ignores project archive task sidecars in comparable and deterministic signatures', () => {
        const local = normalizeTaskForContentComparison(task({
            projectArchivedAt: '2099-01-01T00:00:00.000Z',
            statusBeforeProjectArchive: 'next',
            completedAtBeforeProjectArchive: '2098-01-01T00:00:00.000Z',
            isFocusedTodayBeforeProjectArchive: true,
        }));
        const incoming = normalizeTaskForContentComparison(task({
            projectArchivedAt: '2026-01-01T00:00:00.000Z',
            statusBeforeProjectArchive: 'waiting',
            completedAtBeforeProjectArchive: null,
            isFocusedTodayBeforeProjectArchive: false,
        }));

        expect(toComparableSignature(local)).toBe(toComparableSignature(incoming));
        expect(chooseDeterministicWinner(local, incoming)).toBe(incoming);
    });

    it('ignores stale recurrence preview flags on non-recurring tasks', () => {
        const local = normalizeTaskForContentComparison(task({
            showFutureRecurrence: true,
        }));
        const incoming = normalizeTaskForContentComparison(task());

        expect(toComparableSignature(local)).toBe(toComparableSignature(incoming));
    });

    it('keeps recurrence preview flags meaningful for recurring tasks', () => {
        const local = normalizeTaskForContentComparison(task({
            recurrence: { rule: 'weekly' },
            showFutureRecurrence: true,
        }));
        const incoming = normalizeTaskForContentComparison(task({
            recurrence: { rule: 'weekly' },
        }));

        expect(toComparableSignature(local)).not.toBe(toComparableSignature(incoming));
    });

    it('ignores project archive section sidecars in comparable signatures', () => {
        const local = normalizeSectionForContentComparison(section({
            projectArchivedAt: '2099-01-01T00:00:00.000Z',
            deletedAtBeforeProjectArchive: null,
        }));
        const incoming = normalizeSectionForContentComparison(section({
            projectArchivedAt: '2026-01-01T00:00:00.000Z',
            deletedAtBeforeProjectArchive: '2025-12-31T00:00:00.000Z',
        }));

        expect(toComparableSignature(local)).toBe(toComparableSignature(incoming));
    });
});
