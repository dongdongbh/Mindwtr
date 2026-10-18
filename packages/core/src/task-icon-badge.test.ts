import { describe, expect, it } from 'vitest';
import { countTasksForIconBadge } from './task-icon-badge';
import type { Project, Section, Task } from './types';

const now = new Date(2026, 9, 18, 12);
const task = (overrides: Partial<Task> = {}): Task => ({
    id: 'task', title: 'Task', status: 'next', tags: [], contexts: [],
    createdAt: now.toISOString(), updatedAt: now.toISOString(), dueDate: '2026-10-18', ...overrides,
});
const project = (overrides: Partial<Project> = {}): Project => ({
    id: 'project', title: 'Project', status: 'active', color: '#000', order: 0, tagIds: [],
    createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides,
});
const section: Section = { id: 'section', projectId: 'project', title: 'Section', order: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() };

describe('countTasksForIconBadge', () => {
    it.each(['inbox', 'next', 'waiting', 'someday'] as const)('counts due %s tasks regardless of future start', (status) => {
        expect(countTasksForIconBadge([task({ status, startTime: '2099-01-01' })], [], [], now)).toBe(1);
    });
    it.each(['done', 'archived', 'reference'] as const)('excludes %s despite overdue dates', (status) => {
        expect(countTasksForIconBadge([task({ status, dueDate: '2020-01-01' })], [], [], now)).toBe(0);
    });
    it('excludes deleted/cancelled rows, missing and invalid dates', () => {
        expect(countTasksForIconBadge([
            task({ deletedAt: now.toISOString() }), task({ status: 'archived', cancelledAt: now.toISOString() }),
            task({ dueDate: undefined }), task({ dueDate: 'invalid' }), task({ dueDate: '2026-02-30' }),
        ], [], [], now)).toBe(0);
    });
    it('includes today until local end of day and all overdue; excludes tomorrow', () => {
        expect(countTasksForIconBadge([
            task({ dueDate: '2020-01-01' }), task(),
            task({ dueDate: new Date(2026, 9, 18, 23, 59, 59, 999).toISOString() }),
            task({ dueDate: '2026-10-19' }), task({ dueDate: new Date(2026, 9, 19).toISOString() }),
        ], [], [], now)).toBe(3);
    });
    it.each([
        { deletedAt: now.toISOString() }, { status: 'archived' as const, isFocused: true },
        { status: 'archived' as const, cancelledAt: now.toISOString() },
    ])('excludes tasks under unavailable projects through direct and section-only parenting: %j', (overrides) => {
        expect(countTasksForIconBadge([
            task({ projectId: 'project' }), task({ sectionId: 'section' }),
        ], [project(overrides)], [section], now)).toBe(0);
    });
    it('keeps due tasks in deferred and missing projects, using direct project before section fallback', () => {
        expect(countTasksForIconBadge([
            task({ projectId: 'waiting' }), task({ projectId: 'someday' }), task({ projectId: 'missing' }),
            task({ projectId: 'active', sectionId: 'section' }),
        ], [project({ id: 'waiting', status: 'waiting' }), project({ id: 'someday', status: 'someday' }),
            project({ id: 'active' }), project({ status: 'archived' })], [section], now)).toBe(4);
    });
    it('counts one persisted recurring instance, without expanding future occurrences or mutating data', () => {
        const tasks = [task({ recurrence: { rule: 'daily' } })];
        const before = JSON.stringify(tasks);
        expect(countTasksForIconBadge(tasks, [], [], now)).toBe(1);
        expect(JSON.stringify(tasks)).toBe(before);
    });
    it('handles 5,000 canonical rows in one pass', () => {
        const tasks = Array.from({ length: 5_000 }, (_, i) => task({ id: String(i), status: i % 2 ? 'done' : 'next' }));
        expect(countTasksForIconBadge(tasks, [], [], now)).toBe(2_500);
    });
    it('handles invalid clock and local midnight rollover', () => {
        expect(countTasksForIconBadge([task()], [], [], new Date(NaN))).toBe(0);
        expect(countTasksForIconBadge([task({ dueDate: '2026-10-19' })], [], [], new Date(2026, 9, 18, 23, 59))).toBe(0);
        expect(countTasksForIconBadge([task({ dueDate: '2026-10-19' })], [], [], new Date(2026, 9, 19))).toBe(1);
    });
});
