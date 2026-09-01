import { describe, expect, it, vi } from 'vitest';
import {
    buildEntityMap,
    clearDeletedTaskProjectArchiveMetadata,
    computeProjectDerivedState,
    computeTaskDerivedState,
    createProjectOrderReserver,
    applyTaskUpdates,
    getNextProjectOrder,
    hasSameEntityIdentity,
    normalizeTaskUpdate,
    persist,
    reconcileEntityCollection,
    replaceEntitiesInArray,
    replaceEntityInArray,
    replaceEntityInMap,
    restoreSectionFromProjectArchive,
    restoreTaskFromProjectArchive,
    reuseArrayIfShallowEqual,
    reuseSettingsIfEquivalent,
    selectFocusedCount,
} from './store-helpers';
import type { Project, Section, Task } from './types';
import type { SaveBaseState } from './store-types';

const createTask = (
    id: string,
    projectId = 'project-1',
    orderNum = 0,
    overrides: Partial<Task> = {}
): Task => ({
    id,
    title: `Task ${id}`,
    status: 'inbox',
    tags: [],
    contexts: [],
    projectId,
    orderNum,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const createProject = (id: string, overrides: Partial<Project> = {}): Project => ({
    id,
    title: `Project ${id}`,
    status: 'active',
    color: '#2563EB',
    order: 0,
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const createSection = (
    id: string,
    projectId = 'project-1',
    order = 0,
    overrides: Partial<Section> = {}
): Section => ({
    id,
    projectId,
    title: `Section ${id}`,
    order,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

describe('recurrence updates', () => {
    it('preserves finite-series progress only when editing the same series', () => {
        const task = createTask('t1', undefined, undefined, {
            recurrence: {
                rule: 'daily',
                seriesId: 'series-1',
                count: 8,
                completedOccurrences: 3,
            },
        });

        expect(normalizeTaskUpdate(task, {
            recurrence: { rule: 'weekly', count: 10 },
        }).recurrence).toEqual({
            rule: 'weekly',
            seriesId: 'series-1',
            count: 10,
            completedOccurrences: 3,
        });
        const newSeries = normalizeTaskUpdate(task, {
            recurrence: { rule: 'weekly', seriesId: 'series-2', count: 10 },
        }).recurrence;
        expect(newSeries).toMatchObject({
            rule: 'weekly',
            seriesId: 'series-2',
            count: 10,
        });
        expect(newSeries).not.toHaveProperty('completedOccurrences');
    });
});

describe('reference task invariants', () => {
    it('clears actionable scheduling, reminder, and focus state', () => {
        const task = createTask('reference', undefined, undefined, {
            status: 'next',
            startTime: '2026-08-01',
            dueDate: '2026-08-02',
            relativeStartOffset: { amount: -1, unit: 'day' },
            reviewAt: '2026-08-03',
            recurrence: { rule: 'daily' },
            priority: 'high',
            timeEstimate: '30min',
            suppressMindwtrReminders: true,
            repeatReminderMinutes: 15,
            showFutureRecurrence: true,
            isFocusedToday: true,
            focusOrder: 2,
            boardOrder: 4,
            pushCount: 3,
        });

        const { updatedTask } = applyTaskUpdates(
            task,
            { status: 'reference' },
            '2026-07-31T12:00:00.000Z',
        );

        expect(updatedTask).toMatchObject({
            status: 'reference',
            isFocusedToday: false,
            pushCount: 0,
        });
        for (const field of [
            'startTime',
            'dueDate',
            'relativeStartOffset',
            'reviewAt',
            'recurrence',
            'priority',
            'timeEstimate',
            'suppressMindwtrReminders',
            'repeatReminderMinutes',
            'showFutureRecurrence',
            'focusOrder',
            'boardOrder',
        ] as const) {
            expect(updatedTask[field]).toBeUndefined();
        }
    });

    it('restores an explicit push count when undo restores the due date', () => {
        const original = createTask('reference-undo', undefined, undefined, {
            status: 'inbox',
            dueDate: '2026-09-15',
            pushCount: 3,
        });
        const reference = applyTaskUpdates(
            original,
            { status: 'reference' },
            '2026-08-26T12:00:00.000Z',
        ).updatedTask;

        const restored = applyTaskUpdates(reference, {
            status: 'inbox',
            dueDate: original.dueDate,
            pushCount: original.pushCount,
        }, '2026-08-26T12:01:00.000Z').updatedTask;

        expect(restored).toMatchObject({
            status: 'inbox',
            dueDate: '2026-09-15',
            pushCount: 3,
        });
    });
});

describe('relative start updates', () => {
    it('recomputes startTime from the stored due-date offset when dueDate changes', () => {
        const task = createTask('t1', undefined, undefined, {
            dueDate: '2026-04-24',
            startTime: '2026-04-21',
            relativeStartOffset: { amount: -3, unit: 'day' },
        } as Partial<Task>);

        const { updatedTask } = applyTaskUpdates(task, {
            dueDate: '2026-05-01',
        }, '2026-04-20T10:00:00.000Z');

        expect(updatedTask.dueDate).toBe('2026-05-01');
        expect(updatedTask.startTime).toBe('2026-04-28');
        expect((updatedTask as Task & { relativeStartOffset?: unknown }).relativeStartOffset).toEqual({
            amount: -3,
            unit: 'day',
        });
    });

    it('sets startTime when a relative offset is added to a task with a dueDate', () => {
        const task = createTask('t1', undefined, undefined, {
            dueDate: '2026-04-24',
            startTime: undefined,
        });

        const { updatedTask } = applyTaskUpdates(task, {
            relativeStartOffset: { amount: -1, unit: 'week' },
        }, '2026-04-20T10:00:00.000Z');

        expect(updatedTask.startTime).toBe('2026-04-17');
        expect(updatedTask.relativeStartOffset).toEqual({ amount: -1, unit: 'week' });
    });

    it('recomputes when full-form saves include an unchanged startTime', () => {
        const task = createTask('t1', undefined, undefined, {
            dueDate: '2026-04-24',
            startTime: '2026-04-21',
            relativeStartOffset: { amount: -3, unit: 'day' },
        } as Partial<Task>);

        const { updatedTask } = applyTaskUpdates(task, {
            dueDate: '2026-05-01',
            startTime: '2026-04-21',
        }, '2026-04-20T10:00:00.000Z');

        expect(updatedTask.startTime).toBe('2026-04-28');
        expect(updatedTask.relativeStartOffset).toEqual({ amount: -3, unit: 'day' });
    });

    it('clears the relative start link when startTime is edited directly', () => {
        const task = createTask('t1', undefined, undefined, {
            dueDate: '2026-04-24',
            startTime: '2026-04-21',
            relativeStartOffset: { amount: -3, unit: 'day' },
        } as Partial<Task>);

        const { updatedTask } = applyTaskUpdates(task, {
            startTime: '2026-04-22',
        }, '2026-04-20T10:00:00.000Z');

        expect(updatedTask.startTime).toBe('2026-04-22');
        expect((updatedTask as Task & { relativeStartOffset?: unknown }).relativeStartOffset).toBeUndefined();
    });

    it('keeps the current startTime as absolute when dueDate is removed', () => {
        const task = createTask('t1', undefined, undefined, {
            dueDate: '2026-04-24',
            startTime: '2026-04-21',
            relativeStartOffset: { amount: -3, unit: 'day' },
        } as Partial<Task>);

        const { updatedTask } = applyTaskUpdates(task, {
            dueDate: undefined,
        }, '2026-04-20T10:00:00.000Z');

        expect(updatedTask.dueDate).toBeUndefined();
        expect(updatedTask.startTime).toBe('2026-04-21');
        expect((updatedTask as Task & { relativeStartOffset?: unknown }).relativeStartOffset).toBeUndefined();
    });
});

describe('entity collection helpers', () => {
    it('reuses the previous array when items are shallow-equal', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const previous = [first, second];
        const next = [first, second];

        expect(reuseArrayIfShallowEqual(previous, next)).toBe(previous);
    });

    it('falls back to the next array when any item ref changes', () => {
        const previous = [createTask('t1'), createTask('t2')];
        const changed = createTask('t2', 'project-1', 0, { updatedAt: '2026-01-02T00:00:00.000Z' });
        const next = [previous[0], changed];

        expect(reuseArrayIfShallowEqual(previous, next)).toBe(next);
    });

    it('patches one array slot while preserving unchanged refs', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const changed = createTask('t2', 'project-1', 0, { updatedAt: '2026-01-02T00:00:00.000Z' });

        const next = replaceEntityInArray([first, second], second.id, changed);

        expect(next).toEqual([first, changed]);
        expect(next[0]).toBe(first);
    });

    it('patches one map entry while preserving unchanged values', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const changed = createTask('t2', 'project-1', 0, { updatedAt: '2026-01-02T00:00:00.000Z' });
        const previous = buildEntityMap([first, second]);

        const next = replaceEntityInMap(previous, changed);

        expect(next).not.toBe(previous);
        expect(next.get(first.id)).toBe(first);
        expect(next.get(second.id)).toBe(changed);
    });

    it('patches multiple array slots while preserving unchanged refs', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const third = createTask('t3');
        const changedFirst = createTask('t1', 'project-1', 0, { updatedAt: '2026-01-02T00:00:00.000Z' });
        const changedThird = createTask('t3', 'project-1', 0, { updatedAt: '2026-01-03T00:00:00.000Z' });

        const next = replaceEntitiesInArray([first, second, third], [changedFirst, changedThird]);

        expect(next).toEqual([changedFirst, second, changedThird]);
        expect(next[1]).toBe(second);
    });

    it('compares entity identity only through sync-tracked fields', () => {
        const base = createTask('t1');

        expect(hasSameEntityIdentity(base, { ...base, title: 'Updated title' })).toBe(true);
        expect(hasSameEntityIdentity(base, { ...base, rev: 2 })).toBe(false);
        expect(hasSameEntityIdentity(base, { ...base, revBy: 'device-b' })).toBe(false);
        expect(hasSameEntityIdentity(base, { ...base, deletedAt: '2026-01-03T00:00:00.000Z' })).toBe(false);
        expect(hasSameEntityIdentity(base, { ...base, purgedAt: '2026-01-03T00:00:00.000Z' })).toBe(false);
    });

    it('reuses previous refs and map when incoming entities are unchanged', () => {
        const existing = [createTask('t1'), createTask('t2')];
        const existingById = buildEntityMap(existing);
        const incoming = existing.map((task) => ({ ...task }));

        const result = reconcileEntityCollection(existing, existingById, incoming);

        expect(result.items).toBe(existing);
        expect(result.byId).toBe(existingById);
        expect(result.items[0]).toBe(existing[0]);
        expect(result.items[1]).toBe(existing[1]);
    });

    it('keeps unchanged refs when one task changes', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const third = createTask('t3');
        const existing = [first, second, third];
        const existingById = buildEntityMap(existing);
        const changedSecond = createTask('t2', 'project-1', 0, {
            title: 'Task t2 updated',
            updatedAt: '2026-01-02T00:00:00.000Z',
            rev: 2,
        });

        const result = reconcileEntityCollection(existing, existingById, [
            { ...first },
            changedSecond,
            { ...third },
        ]);

        expect(result.items[0]).toBe(first);
        expect(result.items[1]).toBe(changedSecond);
        expect(result.items[2]).toBe(third);
        expect(result.byId.get(first.id)).toBe(first);
        expect(result.byId.get(second.id)).toBe(changedSecond);
        expect(result.byId.get(third.id)).toBe(third);
    });

    it('removes deleted items from the rebuilt map', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const existing = [first, second];
        const existingById = buildEntityMap(existing);

        const result = reconcileEntityCollection(existing, existingById, [{ ...first }]);

        expect(result.items).toEqual([first]);
        expect(result.byId.has(second.id)).toBe(false);
        expect(result.byId.get(first.id)).toBe(first);
    });

    it('counts replaced identities for diagnostics', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const existing = [first, second];
        const existingById = buildEntityMap(existing);
        const changedSecond = createTask('t2', 'project-1', 0, {
            updatedAt: '2026-01-02T00:00:00.000Z',
            rev: 2,
        });
        const added = createTask('t3');

        const unchanged = reconcileEntityCollection(existing, existingById, [{ ...first }, { ...second }]);
        expect(unchanged.replacedCount).toBe(0);

        const changed = reconcileEntityCollection(existing, existingById, [{ ...first }, changedSecond, added]);
        expect(changed.replacedCount).toBe(2);
    });

    it('preserves stable refs by id when incoming items are reordered', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const third = createTask('t3');
        const existing = [first, second, third];
        const existingById = buildEntityMap(existing);

        const result = reconcileEntityCollection(existing, existingById, [
            { ...third },
            { ...first },
            { ...second },
        ]);

        expect(result.items).toEqual([third, first, second]);
        expect(result.items[0]).toBe(third);
        expect(result.items[1]).toBe(first);
        expect(result.items[2]).toBe(second);
        expect(result.byId.get(first.id)).toBe(first);
        expect(result.byId.get(second.id)).toBe(second);
        expect(result.byId.get(third.id)).toBe(third);
    });
});

describe('reuseSettingsIfEquivalent', () => {
    const baseSettings = {
        deviceId: 'device-a',
        theme: 'nord',
        gtd: { focusGroupBy: 'none' },
    };

    it('reuses the previous identity when content is unchanged', () => {
        const previous = { ...baseSettings, gtd: { ...baseSettings.gtd } };
        const next = { ...baseSettings, gtd: { ...baseSettings.gtd } };
        expect(reuseSettingsIfEquivalent(previous, next)).toBe(previous);
    });

    it('reuses the previous identity when only lastSync* status keys differ', () => {
        const previous = {
            ...baseSettings,
            lastSyncAt: '2026-07-18T00:00:00.000Z',
            lastSyncStatus: 'success',
        };
        const next = {
            ...baseSettings,
            lastSyncAt: '2026-07-18T00:01:00.000Z',
            lastSyncStatus: 'success',
            lastSyncStats: { conflicts: 0 },
        };
        expect(reuseSettingsIfEquivalent(previous, next)).toBe(previous);
    });

    it('returns the incoming settings when real content changed', () => {
        const previous = { ...baseSettings };
        const next = { ...baseSettings, theme: 'e-ink' };
        expect(reuseSettingsIfEquivalent(previous, next)).toBe(next);

        const nestedNext = { ...baseSettings, gtd: { focusGroupBy: 'context' } };
        expect(reuseSettingsIfEquivalent(previous, nestedNext)).toBe(nestedNext);
    });

    it('returns the incoming settings when there is no previous object', () => {
        const next = { ...baseSettings };
        expect(reuseSettingsIfEquivalent(undefined, next)).toBe(next);
    });
});

describe('project archive restore helpers', () => {
    it('restores reversible task archive metadata and bumps sync identity', () => {
        const archivedAt = '2026-01-05T00:00:00.000Z';
        const restoredAt = '2026-01-06T00:00:00.000Z';
        const task = createTask('restore-task', 'project-1', 0, {
            status: 'done',
            completedAt: archivedAt,
            isFocusedToday: false,
            statusBeforeProjectArchive: 'next',
            completedAtBeforeProjectArchive: '2026-01-03T00:00:00.000Z',
            isFocusedTodayBeforeProjectArchive: true,
            projectArchivedAt: archivedAt,
            rev: 4,
        });

        const restored = restoreTaskFromProjectArchive(task, restoredAt, 'device-b');

        expect(restored).not.toBe(task);
        expect(restored.status).toBe('next');
        expect(restored.completedAt).toBe('2026-01-03T00:00:00.000Z');
        expect(restored.isFocusedToday).toBe(true);
        expect(restored.statusBeforeProjectArchive).toBeUndefined();
        expect(restored.completedAtBeforeProjectArchive).toBeUndefined();
        expect(restored.isFocusedTodayBeforeProjectArchive).toBeUndefined();
        expect(restored.projectArchivedAt).toBeUndefined();
        expect(restored.updatedAt).toBe(restoredAt);
        expect(restored.rev).toBe(5);
        expect(restored.revBy).toBe('device-b');
    });

    it('does not rewrite deleted project-archive task snapshots', () => {
        const archivedAt = '2026-01-05T00:00:00.000Z';
        const task = createTask('deleted-task', 'project-1', 0, {
            status: 'done',
            completedAt: archivedAt,
            deletedAt: '2026-01-05T12:00:00.000Z',
            statusBeforeProjectArchive: 'next',
            completedAtBeforeProjectArchive: null,
            isFocusedTodayBeforeProjectArchive: false,
            projectArchivedAt: archivedAt,
            rev: 4,
            updatedAt: archivedAt,
        });

        expect(restoreTaskFromProjectArchive(task, '2026-01-06T00:00:00.000Z', 'device-b')).toBe(task);
    });

    it('clears project-archive metadata from deleted task tombstones without bumping sync identity', () => {
        const archivedAt = '2026-01-05T00:00:00.000Z';
        const task = createTask('deleted-task', 'project-1', 0, {
            status: 'done',
            completedAt: archivedAt,
            deletedAt: '2026-01-05T12:00:00.000Z',
            statusBeforeProjectArchive: 'next',
            completedAtBeforeProjectArchive: null,
            isFocusedTodayBeforeProjectArchive: false,
            projectArchivedAt: archivedAt,
            rev: 4,
            updatedAt: archivedAt,
        });

        const cleaned = clearDeletedTaskProjectArchiveMetadata(task);

        expect(cleaned).not.toBe(task);
        expect(cleaned.deletedAt).toBe(task.deletedAt);
        expect(cleaned.updatedAt).toBe(task.updatedAt);
        expect(cleaned.rev).toBe(task.rev);
        expect(cleaned.revBy).toBe(task.revBy);
        expect(cleaned.statusBeforeProjectArchive).toBeUndefined();
        expect(cleaned.completedAtBeforeProjectArchive).toBeUndefined();
        expect(cleaned.isFocusedTodayBeforeProjectArchive).toBeUndefined();
        expect(cleaned.projectArchivedAt).toBeUndefined();
    });

    it('does not rewrite manually changed project-archive task snapshots', () => {
        const archivedAt = '2026-01-05T00:00:00.000Z';
        const task = createTask('changed-task', 'project-1', 0, {
            status: 'done',
            completedAt: '2026-01-05T12:00:00.000Z',
            statusBeforeProjectArchive: 'waiting',
            completedAtBeforeProjectArchive: null,
            isFocusedTodayBeforeProjectArchive: false,
            projectArchivedAt: archivedAt,
            rev: 4,
            updatedAt: '2026-01-05T12:00:00.000Z',
        });

        expect(restoreTaskFromProjectArchive(task, '2026-01-06T00:00:00.000Z', 'device-b')).toBe(task);
    });

    it('restores only sections hidden by project archive', () => {
        const archivedAt = '2026-01-05T00:00:00.000Z';
        const restoredAt = '2026-01-06T00:00:00.000Z';
        const hiddenSection = createSection('restore-section', 'project-1', 0, {
            deletedAt: archivedAt,
            deletedAtBeforeProjectArchive: null,
            projectArchivedAt: archivedAt,
            rev: 7,
        });
        const preDeletedSection = createSection('deleted-section', 'project-1', 1, {
            deletedAt: '2026-01-04T00:00:00.000Z',
            deletedAtBeforeProjectArchive: '2026-01-04T00:00:00.000Z',
            projectArchivedAt: archivedAt,
            rev: 7,
        });

        const restored = restoreSectionFromProjectArchive(hiddenSection, restoredAt, 'device-b');

        expect(restored).not.toBe(hiddenSection);
        expect(restored.deletedAt).toBeUndefined();
        expect(restored.deletedAtBeforeProjectArchive).toBeUndefined();
        expect(restored.projectArchivedAt).toBeUndefined();
        expect(restored.updatedAt).toBe(restoredAt);
        expect(restored.rev).toBe(8);
        expect(restored.revBy).toBe('device-b');
        expect(restoreSectionFromProjectArchive(preDeletedSection, restoredAt, 'device-b')).toBe(preDeletedSection);
    });
});

describe('getNextProjectOrder', () => {
    it('returns deterministic next project order without mutating shared cache', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];

        expect(getNextProjectOrder('project-1', tasks)).toBe(2);
        expect(getNextProjectOrder('project-1', tasks)).toBe(2);
        expect(getNextProjectOrder('project-1', tasks)).toBe(2);
    });

    it('starts from zero for unseen projects on repeated calls', () => {
        const tasks = [createTask('t1', 'project-1', 0)];

        expect(getNextProjectOrder('project-2', tasks)).toBe(0);
        expect(getNextProjectOrder('project-2', tasks)).toBe(0);
    });

    it('reserves unique project orders with an explicit reserver', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];
        const reserveProjectOrder = createProjectOrderReserver(tasks);

        expect(reserveProjectOrder('project-1')).toBe(2);
        expect(reserveProjectOrder('project-1')).toBe(3);
        expect(reserveProjectOrder('project-2')).toBe(0);
        expect(reserveProjectOrder('project-2')).toBe(1);
    });

    it('does not carry reserved orders across reserver instances', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];

        expect(createProjectOrderReserver(tasks)('project-1')).toBe(2);

        const refreshedTasks = tasks.map((task) => ({ ...task }));
        expect(createProjectOrderReserver(refreshedTasks)('project-1')).toBe(2);
    });
});

describe('derived store state helpers', () => {
    it('counts only active focused-today tasks toward the focus limit', () => {
        const derived = computeTaskDerivedState([
            createTask('active-focused', 'project-1', 0, { status: 'next', isFocusedToday: true }),
            createTask('done-focused', 'project-1', 1, { status: 'done', isFocusedToday: true }),
            createTask('reference-focused', 'project-1', 2, { status: 'reference', isFocusedToday: true }),
            createTask('deleted-focused', 'project-1', 3, {
                status: 'next',
                isFocusedToday: true,
                deletedAt: '2026-01-02T00:00:00.000Z',
            }),
        ]);

        expect(derived.focusedCount).toBe(1);
    });

    it('selectFocusedCount agrees with computeTaskDerivedState.focusedCount on a mixed fixture', () => {
        const tasks = [
            createTask('active-focused', 'project-1', 0, { status: 'next', isFocusedToday: true }),
            createTask('active-unfocused', 'project-1', 1, { status: 'next', isFocusedToday: false }),
            createTask('done-focused', 'project-1', 2, { status: 'done', isFocusedToday: true }),
            createTask('reference-focused', 'project-1', 3, { status: 'reference', isFocusedToday: true }),
            createTask('archived-focused', 'project-1', 4, { status: 'archived', isFocusedToday: true }),
            createTask('waiting-focused', 'project-1', 5, { status: 'waiting', isFocusedToday: true }),
            createTask('deleted-focused', 'project-1', 6, {
                status: 'next',
                isFocusedToday: true,
                deletedAt: '2026-01-02T00:00:00.000Z',
            }),
        ];

        expect(selectFocusedCount(tasks)).toBe(computeTaskDerivedState(tasks).focusedCount);
        expect(selectFocusedCount(tasks)).toBe(2);
        // Same array identity: cached hit still agrees.
        expect(selectFocusedCount(tasks)).toBe(computeTaskDerivedState(tasks).focusedCount);
        // A different array identity recomputes and still agrees.
        const fewer = tasks.slice(0, 1);
        expect(selectFocusedCount(fewer)).toBe(computeTaskDerivedState(fewer).focusedCount);
    });

    // A-04 pin, written BEFORE folding token accumulation into the main loop:
    // collectTaskTokenUsage skips deletedAt and nothing else (archived/done still count), and
    // returns tokens in first-seen order with per-task dedupe. The fold must reproduce all
    // three exactly, so this asserts the full shape rather than just membership.
    it('counts tokens from every non-deleted task, in first-seen order', () => {
        const derived = computeTaskDerivedState([
            createTask('a', undefined, 0, {
                contexts: ['@phone', '@phone', '@home'],
                tags: ['#urgent'],
                updatedAt: '2026-01-03T00:00:00.000Z',
            }),
            createTask('archived', undefined, 1, {
                status: 'archived',
                contexts: ['@home'],
                tags: ['#urgent'],
                updatedAt: '2026-01-05T00:00:00.000Z',
            }),
            createTask('deleted', undefined, 2, {
                contexts: ['@ghost'],
                tags: ['#ghost'],
                deletedAt: '2026-01-04T00:00:00.000Z',
                updatedAt: '2026-01-09T00:00:00.000Z',
            }),
        ]);

        expect(derived.contextTokenUsage).toEqual([
            { token: '@phone', count: 1, lastUsedAt: Date.parse('2026-01-03T00:00:00.000Z') },
            { token: '@home', count: 2, lastUsedAt: Date.parse('2026-01-05T00:00:00.000Z') },
        ]);
        expect(derived.tagTokenUsage).toEqual([
            { token: '#urgent', count: 2, lastUsedAt: Date.parse('2026-01-05T00:00:00.000Z') },
        ]);
        // allContexts/allTags are the sorted projection of the same usage.
        expect(derived.allContexts).toEqual(['@home', '@phone']);
        expect(derived.allTags).toEqual(['#urgent']);
    });

    it('derives transient date-coherence issues without mutating tasks', () => {
        const incoherent = createTask('incoherent', 'project-1', 0, {
            startTime: '2026-04-25',
            dueDate: '2026-04-24',
        });
        const coherent = createTask('coherent', 'project-1', 1, {
            startTime: '2026-04-24',
            dueDate: '2026-04-24',
        });

        const derived = computeTaskDerivedState([incoherent, coherent]);

        expect(derived.dateCoherenceIssuesByTaskId.get('incoherent')).toEqual([{
            code: 'start_after_due',
            field: 'startTime',
            relatedField: 'dueDate',
        }]);
        expect(derived.dateCoherenceIssuesByTaskId.has('coherent')).toBe(false);
        expect(incoherent.startTime).toBe('2026-04-25');
        expect(incoherent.dueDate).toBe('2026-04-24');
    });

    it('derives query-scoped task indexes in one pass', () => {
        const nextTask = createTask('next', 'project-1', 0, {
            status: 'next',
            contexts: ['@office'],
            tags: ['#deep'],
            isFocusedToday: true,
        });
        const doneTask = createTask('done', 'project-1', 1, {
            status: 'done',
            contexts: ['@office'],
            tags: ['#done'],
            isFocusedToday: true,
        });
        const waitingTask = createTask('waiting', 'project-2', 2, {
            status: 'waiting',
            contexts: ['@home'],
            tags: ['#deep'],
        });

        const derived = computeTaskDerivedState([nextTask, doneTask, waitingTask]);

        expect(derived.tasksByProjectId.get('project-1')?.map((task) => task.id)).toEqual(['next', 'done']);
        expect(derived.tasksByContext.get('@office')?.map((task) => task.id)).toEqual(['next', 'done']);
        expect(derived.tasksByTag.get('#deep')?.map((task) => task.id)).toEqual(['next', 'waiting']);
        expect(derived.focusedTasks.map((task) => task.id)).toEqual(['next']);
        expect(derived.projectTaskSummaryById.get('project-1')).toEqual({
            activeTaskCount: 1,
            nextAction: nextTask,
        });
        expect(derived.projectTaskSummaryById.get('project-2')).toEqual({
            activeTaskCount: 1,
        });
    });

    it('picks the project next action by manual order, not creation order', () => {
        const createdFirstOrderedLast = createTask('created-first', 'project-1', 2, {
            status: 'next',
            createdAt: '2026-01-01T00:00:00.000Z',
        });
        const createdLastOrderedFirst = createTask('created-later', 'project-1', 1, {
            status: 'next',
            createdAt: '2026-02-01T00:00:00.000Z',
        });
        const unordered = [
            createTask('older', 'project-2', 0, {
                status: 'next',
                orderNum: undefined,
                createdAt: '2026-01-05T00:00:00.000Z',
            }),
            createTask('newer', 'project-2', 0, {
                status: 'next',
                orderNum: undefined,
                createdAt: '2026-01-01T00:00:00.000Z',
            }),
        ];

        const derived = computeTaskDerivedState([
            createdFirstOrderedLast,
            createdLastOrderedFirst,
            ...unordered,
        ]);

        expect(derived.projectTaskSummaryById.get('project-1')?.nextAction?.id).toBe('created-later');
        // Without a manual order the earliest-created next task still wins.
        expect(derived.projectTaskSummaryById.get('project-2')?.nextAction?.id).toBe('newer');
    });

    it('derives focused project count while ignoring tombstones', () => {
        const derived = computeProjectDerivedState([
            createProject('focused-a', { isFocused: true }),
            createProject('focused-b', { isFocused: true, status: 'archived' }),
            createProject('deleted-focused', {
                isFocused: true,
                deletedAt: '2026-01-02T00:00:00.000Z',
            }),
            createProject('plain'),
        ]);

        expect(derived.focusedProjectCount).toBe(2);
    });

    it('derives section-scoped sequential project ids', () => {
        const derived = computeProjectDerivedState([
            createProject('project-wide', { isSequential: true }),
            createProject('section-wide', { isSequential: true, sequentialScope: 'section' }),
            createProject('parallel-section', { isSequential: false, sequentialScope: 'section' }),
        ]);

        expect([...derived.sequentialProjectIds]).toEqual(['project-wide', 'section-wide']);
        expect([...derived.sequentialWithinSectionProjectIds]).toEqual(['section-wide']);
    });
});

describe('completion timestamp updates', () => {
    const now = '2026-07-08T10:00:00.000Z';

    it('uses a caller-supplied completedAt when completing a task', () => {
        const task = createTask('t1', undefined, 0, { status: 'next' });
        const { updatedTask } = applyTaskUpdates(
            task,
            { status: 'done', completedAt: '2026-07-07T18:00:00.000Z' },
            now
        );
        expect(updatedTask.completedAt).toBe('2026-07-07T18:00:00.000Z');
        expect(updatedTask.status).toBe('done');
    });

    it('falls back to now when the supplied completedAt is invalid', () => {
        const task = createTask('t2', undefined, 0, { status: 'next' });
        const { updatedTask } = applyTaskUpdates(
            task,
            { status: 'done', completedAt: 'not-a-date' },
            now
        );
        expect(updatedTask.completedAt).toBe(now);
    });

    it('anchors after-completion recurrence to the backdated completion time', () => {
        const task = createTask('t3', undefined, 0, {
            status: 'next',
            dueDate: '2026-07-01',
            recurrence: { rule: 'weekly', strategy: 'fluid' },
        });
        const { nextRecurringTask } = applyTaskUpdates(
            task,
            { status: 'done', completedAt: '2026-07-04T09:00:00.000Z' },
            now
        );
        // Fluid weekly: next due = completed date + 7 days, not click date + 7.
        expect(nextRecurringTask?.dueDate).toBe('2026-07-11');
    });

    it('keeps click-time anchoring when no completedAt is supplied', () => {
        const task = createTask('t4', undefined, 0, {
            status: 'next',
            dueDate: '2026-07-01',
            recurrence: { rule: 'weekly', strategy: 'fluid' },
        });
        const { nextRecurringTask } = applyTaskUpdates(task, { status: 'done' }, now);
        expect(nextRecurringTask?.dueDate).toBe('2026-07-15');
    });

    it('uses a caller-supplied completedAt when archiving a task', () => {
        const task = createTask('t5', undefined, 0, { status: 'next' });
        const { updatedTask } = applyTaskUpdates(
            task,
            { status: 'archived', completedAt: '2026-07-06T08:00:00.000Z' },
            now
        );
        expect(updatedTask.completedAt).toBe('2026-07-06T08:00:00.000Z');
    });

    it('preserves the completion time when moving an archived task back to done', () => {
        const completedAt = '2026-07-06T08:00:00.000Z';
        const task = createTask('t5-return', undefined, 0, {
            status: 'archived',
            completedAt,
        });

        const { updatedTask } = applyTaskUpdates(task, { status: 'done' }, now);

        expect(updatedTask.status).toBe('done');
        expect(updatedTask.completedAt).toBe(completedAt);
    });

    it('does not create another recurring occurrence when moving archived back to done', () => {
        const task = createTask('t5-recurring', undefined, 0, {
            status: 'archived',
            completedAt: '2026-07-06T08:00:00.000Z',
            dueDate: '2026-07-06',
            recurrence: { rule: 'weekly', strategy: 'fluid' },
        });

        const { nextRecurringTask } = applyTaskUpdates(task, { status: 'done' }, now);

        expect(nextRecurringTask).toBeNull();
    });

    it('preserves attachments when completing a task', () => {
        const task = createTask('t7', undefined, 0, {
            status: 'next',
            attachments: [{
                id: 'att-1',
                kind: 'file',
                uri: 'file:///doc.pdf',
                title: 'doc.pdf',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }],
        });
        const { updatedTask } = applyTaskUpdates(task, { status: 'done' }, now);
        expect(updatedTask.status).toBe('done');
        expect(updatedTask.attachments).toEqual(task.attachments);
    });

    it('passes completedAt edits through on an already-done task', () => {
        const task = createTask('t6', undefined, 0, {
            status: 'done',
            completedAt: '2026-07-08T09:00:00.000Z',
        });
        const { updatedTask, nextRecurringTask } = applyTaskUpdates(
            task,
            { completedAt: '2026-07-05T12:00:00.000Z' },
            now
        );
        expect(updatedTask.completedAt).toBe('2026-07-05T12:00:00.000Z');
        expect(updatedTask.status).toBe('done');
        expect(nextRecurringTask).toBeNull();
    });

    it('clears focusOrder when completing a focused task', () => {
        const task = createTask('t8', undefined, 0, {
            status: 'next',
            isFocusedToday: true,
            focusOrder: 2,
        });
        const { updatedTask } = applyTaskUpdates(task, { status: 'done' }, now);
        expect(updatedTask.isFocusedToday).toBe(false);
        expect(updatedTask.focusOrder).toBeUndefined();
    });

    it('clears focusOrder when archiving a focused task', () => {
        const task = createTask('t9', undefined, 0, {
            status: 'next',
            isFocusedToday: true,
            focusOrder: 1,
        });
        const { updatedTask } = applyTaskUpdates(task, { status: 'archived' }, now);
        expect(updatedTask.isFocusedToday).toBe(false);
        expect(updatedTask.focusOrder).toBeUndefined();
    });

    it('preserves an explicit focusOrder supplied in the same completion update', () => {
        const task = createTask('t10', undefined, 0, {
            status: 'next',
            isFocusedToday: true,
            focusOrder: 3,
        });
        const { updatedTask } = applyTaskUpdates(task, { status: 'done', focusOrder: 7 }, now);
        expect(updatedTask.focusOrder).toBe(7);
    });
});

describe('persist', () => {
    const baseState: SaveBaseState = {
        _allTasks: [createTask('t1'), createTask('t2')],
        _allProjects: [],
        _allSections: [],
        _allAreas: [],
        _allPeople: [],
        settings: {},
    };

    it('builds the full snapshot via buildSaveSnapshot and enqueues it through the caller-provided debouncedSave', () => {
        const set = vi.fn();
        const debouncedSave = vi.fn();

        persist(set, debouncedSave, baseState, { tasks: [createTask('t1'), createTask('t2'), createTask('t3')] });

        expect(debouncedSave).toHaveBeenCalledTimes(1);
        const [snapshot, onError] = debouncedSave.mock.calls[0];
        expect(snapshot.tasks.map((task: Task) => task.id)).toEqual(['t1', 't2', 't3']);
        expect(snapshot.projects).toBe(baseState._allProjects);
        expect(snapshot.settings).toBe(baseState.settings);

        // The enqueue's own error callback writes through the caller's `set`,
        // same as every hand-written call site used to.
        onError('save failed');
        expect(set).toHaveBeenCalledWith({ error: 'save failed' });
    });

    it('refuses to enqueue a snapshot that drops an existing task, and never calls debouncedSave', () => {
        const set = vi.fn();
        const debouncedSave = vi.fn();

        // Only t1 survives -- t2 silently disappeared, the exact partial-snapshot
        // bug the guard exists to catch (store-settings.ts's fetchData used to
        // bypass this by hand-building its save payload instead of routing
        // through buildSaveSnapshot).
        expect(() => persist(set, debouncedSave, baseState, { tasks: [createTask('t1')] }))
            .toThrow(/Refusing to save a partial task snapshot/);
        expect(debouncedSave).not.toHaveBeenCalled();
    });

    it('refuses a same-length snapshot that swaps an existing task for a new one', () => {
        const set = vi.fn();
        const debouncedSave = vi.fn();

        // t2 disappeared while t3 arrived, so the collection length is unchanged --
        // a drop the guard must still catch.
        expect(() => persist(set, debouncedSave, baseState, { tasks: [createTask('t1'), createTask('t3')] }))
            .toThrow(/Refusing to save a partial task snapshot; missing existing ids: t2/);
        expect(debouncedSave).not.toHaveBeenCalled();
    });
});
