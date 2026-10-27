import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeTaskForLoad, normalizeCancellationTimestamp, isTaskFinished, normalizeTaskStatus, type TaskLoadTemporalContext } from './task-status';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeDueReminderLeadMinutes, normalizeRepeatReminderMinutes } from './schedule-utils';
import { normalizeTimeSpentMinutes } from './time-spent';
import { normalizeRelativeStartOffset } from './task-relative-start';
import { preserveShallowIdentity, sameShallowRecord } from './shallow-identity';
import { safeParseDate } from './date';
import type { AppData, Task } from './types';

// The load normalizer runs over every task on every load (230 of 482 ms in the native boot's activation at 5,000 tasks on the S23's
// QuickJS). Its one-pass form must give exactly what the two-pass form gave: the same values, the same key order, and the input
// back exactly when that form gave it back.

// ---- Frozen reference: normalizeTaskLifecycleFields and normalizeTaskForLoad as of commit 1a1559e8e (task-status.ts), test-only. ----
const isFutureStart = (task: Pick<Task, 'startTime'>, now: Date, temporal?: TaskLoadTemporalContext): boolean => {
    if (temporal) {
        const parsedAt = task.startTime ? temporal.dates.get(task.startTime)?.parsedAt : null;
        return parsedAt != null && parsedAt > Date.parse(temporal.futureBoundary);
    }
    const start = safeParseDate(task.startTime);
    if (!start) return false;
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return start > endOfToday;
};
function frozenLifecycle(task: Task): Task {
    const cancelledAt = task.status === 'archived'
        ? normalizeCancellationTimestamp(task.cancelledAt)
        : undefined;
    const completedAt = cancelledAt
        ? undefined
        : isTaskFinished(task.status)
            ? (task.completedAt || task.updatedAt || task.createdAt)
            : undefined;
    const isTerminal = isTaskFinished(task.status);
    const next: Task = {
        ...task,
        cancelledAt,
        completedAt,
        ...(isTerminal ? { isFocusedToday: false, focusOrder: undefined } : {}),
    };
    return sameShallowRecord(task, next) ? task : next;
}

function frozenNormalizeTaskForLoad(task: Task, nowIso: string = new Date().toISOString(), temporal?: TaskLoadTemporalContext): Task {
    const normalizedStatus = normalizeTaskStatus((task as any).status);
    const { rev: _legacyRev, revBy: _legacyRevBy, ...rest } = task as Task & { rev?: unknown; revBy?: unknown };

    let createdAtIso = typeof task.createdAt === 'string' ? task.createdAt : nowIso;
    const createdAtMs = Date.parse(createdAtIso);
    if (!Number.isFinite(createdAtMs)) {
        createdAtIso = nowIso;
    }
    let updatedAtIso = typeof task.updatedAt === 'string' ? task.updatedAt : createdAtIso;
    const updatedAtMs = Date.parse(updatedAtIso);
    if (!Number.isFinite(updatedAtMs) || updatedAtMs < Date.parse(createdAtIso)) {
        updatedAtIso = createdAtIso;
    }

    const hasValidPushCount = typeof task.pushCount === 'number' && Number.isFinite(task.pushCount);
    const projectId =
        typeof task.projectId === 'string' && task.projectId.trim().length > 0
            ? task.projectId
            : undefined;
    const areaId =
        typeof task.areaId === 'string' && task.areaId.trim().length > 0
            ? task.areaId
            : undefined;
    const resolvedAreaId = projectId ? undefined : areaId;
    const textDirection =
        typeof task.textDirection === 'string' && ['auto', 'ltr', 'rtl'].includes(task.textDirection)
            ? task.textDirection
            : undefined;
    const rawRev = (task as any).rev;
    const rev = typeof rawRev === 'number'
        && Number.isFinite(rawRev)
        && Number.isInteger(rawRev)
        && rawRev >= 0
        ? rawRev
        : 0;
    const rawRevBy = (task as any).revBy;
    const revBy = typeof rawRevBy === 'string' && rawRevBy.trim().length > 0
        ? rawRevBy.trim()
        : undefined;
    const normalizedOrder = Number.isFinite(task.order)
        ? (task.order as number)
        : Number.isFinite((task as Task & { orderNum?: unknown }).orderNum)
            ? ((task as Task & { orderNum?: number }).orderNum as number)
            : undefined;
    const relativeStartOffset = task.dueDate
        ? preserveShallowIdentity(task.relativeStartOffset, normalizeRelativeStartOffset(task.relativeStartOffset))
        : undefined;
    const next: Task = {
        ...rest,
        createdAt: createdAtIso,
        updatedAt: updatedAtIso,
        status: normalizedStatus,
        projectId,
        areaId: resolvedAreaId,
        order: normalizedOrder,
        orderNum: normalizedOrder,
        recurrence: preserveShallowIdentity(task.recurrence, normalizeRecurrenceForLoad(task.recurrence)),
        repeatReminderMinutes: normalizeRepeatReminderMinutes(task.repeatReminderMinutes),
        dueReminderLeadMinutes: normalizeDueReminderLeadMinutes(task.dueReminderLeadMinutes),
        timeSpentMinutes: normalizeTimeSpentMinutes(task.timeSpentMinutes),
        relativeStartOffset,
        rev,
        ...(revBy ? { revBy } : {}),
        ...(textDirection ? { textDirection } : {}),
        // Purged tombstones stay in their compacted shape: backfilling
        // pushCount: 0 here while the merge normalizers strip it again made
        // every loaded tombstone differ from its merged twin, so each sync
        // cycle rewrote every purged row and requeued itself (#766 — the
        // content-oscillation sibling of the rev-bump loop fixed earlier;
        // stats.tombstoneRepairs stayed 0 because rev never changed).
        ...(hasValidPushCount || task.purgedAt ? {} : { pushCount: 0 }),
    };

    const lifecycleNormalized = frozenLifecycle(next);

    // A future-start Next action keeps its queued star across load and sync.
    // focusOrder only applies once it has reached Today's Focus.
    if (lifecycleNormalized.isFocusedToday && isFutureStart(lifecycleNormalized, new Date(nowIso), temporal)) {
        if (lifecycleNormalized.status !== 'next') lifecycleNormalized.isFocusedToday = false;
        lifecycleNormalized.focusOrder = undefined;
    }

    // Hand back the input when nothing actually changed, so an already-normalized
    // task keeps its identity through the merge normalizers (#766 — see
    // shallow-identity.ts). The time-dependent branches above naturally produce a
    // differing object on the cycle they fire, so this stays a pure no-change check.
    return sameShallowRecord(task, lifecycleNormalized) ? task : lifecycleNormalized;
}
// ---- end of the frozen reference ----

const NOW = '2026-10-27T10:00:00.000Z';
const AT = '2026-01-01T00:00:00.000Z';
const base = (extra: Record<string, unknown> = {}): Task => ({ id: 't', title: 'Task', status: 'next', tags: [], contexts: [],
    createdAt: AT, updatedAt: AT, ...extra } as Task);
const future = '2099-01-01T09:00:00.000Z';
const temporal: TaskLoadTemporalContext = { futureBoundary: '2026-10-27T23:59:59.999Z',
    dates: new Map([[future, { parsedAt: Date.parse(future) }]]) };
// Every field the normalizer writes, in its odd shapes, plus the plain ones.
const corpus = (): Array<[string, Task]> => [
    ['plain', base()],
    ['normalized', frozenNormalizeTaskForLoad(base({ rev: 3, revBy: 'device', pushCount: 1 }), NOW)],
    ['legacy status', base({ status: 'planned' })], ['upper status', base({ status: ' DONE ' })], ['bad status', base({ status: 7 })],
    ['missing created', base({ createdAt: undefined })], ['bad created', base({ createdAt: 'never' })],
    ['missing updated', base({ updatedAt: undefined })], ['bad updated', base({ updatedAt: 'never' })],
    ['updated before created', base({ updatedAt: '2025-01-01T00:00:00.000Z' })],
    ['blank project', base({ projectId: '  ' })], ['project and area', base({ projectId: 'p', areaId: 'a' })], ['area only', base({ areaId: 'a' })],
    ['blank area', base({ areaId: ' ' })], ['text direction rtl', base({ textDirection: 'rtl' })], ['bad text direction', base({ textDirection: 'up' })],
    ['float rev', base({ rev: 1.5 })], ['string rev', base({ rev: '2' })], ['negative rev', base({ rev: -1 })], ['good rev', base({ rev: 4 })],
    ['blank revBy', base({ revBy: '  ' })], ['padded revBy', base({ revBy: ' dev ' })], ['revBy null', base({ revBy: null })],
    ['order only', base({ order: 5 })], ['orderNum only', base({ orderNum: 6 })], ['both orders', base({ order: 5, orderNum: 9 })],
    ['bad order', base({ order: Number.NaN })],
    ['no pushCount live', base({ pushCount: undefined })], ['no pushCount purged', base({ purgedAt: AT, deletedAt: AT })],
    ['pushCount NaN', base({ pushCount: Number.NaN })],
    ['done no completedAt', base({ status: 'done' })], ['done with completedAt', base({ status: 'done', completedAt: '2026-02-01T00:00:00.000Z' })],
    ['archived cancelled', base({ status: 'archived', cancelledAt: '2026-02-01T00:00:00.000Z' })],
    ['archived bad cancel', base({ status: 'archived', cancelledAt: '2026-02-01' })],
    ['next with cancelledAt', base({ cancelledAt: '2026-02-01T00:00:00.000Z', completedAt: AT })],
    ['done focused', base({ status: 'done', isFocusedToday: true, focusOrder: 2 })],
    ['future start focused next', base({ isFocusedToday: true, focusOrder: 1, startTime: future })],
    ['future start focused waiting', base({ status: 'waiting', isFocusedToday: true, focusOrder: 1, startTime: future })],
    ['past start focused', base({ isFocusedToday: true, focusOrder: 1, startTime: '2020-01-01T09:00:00.000Z' })],
    ['due with relative start', base({ dueDate: '2026-11-01', relativeStartOffset: { value: 2, unit: 'days' } })],
    ['relative start without due', base({ relativeStartOffset: { value: 2, unit: 'days' } })],
    ['recurrence string', base({ recurrence: 'weekly' })], ['recurrence object', base({ recurrence: { rule: 'daily' } })],
    ['reminder minutes', base({ repeatReminderMinutes: 15, dueReminderLeadMinutes: -5, timeSpentMinutes: 12.5 })],
    ['bad minutes', base({ repeatReminderMinutes: 'x', dueReminderLeadMinutes: Number.NaN, timeSpentMinutes: -3 })],
];
const same = (task: Task, now: string, temporalContext?: TaskLoadTemporalContext) => {
    const expected = frozenNormalizeTaskForLoad(task, now, temporalContext);
    const actual = normalizeTaskForLoad(task, now, temporalContext);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    expect(actual).toEqual(expected);
    expect(actual === task).toBe(expected === task);
};

describe('normalizeTaskForLoad in one pass', () => {
    afterEach(() => { vi.resetModules(); vi.doUnmock('./task-status'); });

    it.each(corpus())('gives what the two-pass form gave: %s', (_name, task) => {
        same(task, NOW);
        same(task, NOW, temporal);
    });

    it('gives what the two-pass form gave over a 2,000-task synthetic library, raw and normalized', async () => {
        const { fixture } = await import('../../../scripts/performance/fixture.mjs');
        const tasks = (fixture(2000) as { data: AppData }).data.tasks;
        for (const task of tasks) {
            same(task, NOW);
            same(frozenNormalizeTaskForLoad(task, NOW), NOW);
        }
    }, 60_000);

    it('hands an already normalized task back as the same object', () => {
        for (const [, task] of corpus()) {
            const once = normalizeTaskForLoad(task, NOW);
            expect(normalizeTaskForLoad(once, NOW)).toBe(once);
        }
    });

    it('never hands back a normalized task with any normalized field changed', () => {
        const normalized = normalizeTaskForLoad(base({ status: 'archived', cancelledAt: '2026-02-01T00:00:00.000Z', rev: 2, revBy: 'dev',
            pushCount: 1, order: 3, projectId: 'p', textDirection: 'ltr', dueDate: '2026-11-01', relativeStartOffset: { value: 1, unit: 'days' },
            repeatReminderMinutes: 15, dueReminderLeadMinutes: 10, timeSpentMinutes: 5 }), NOW);
        expect(normalizeTaskForLoad(normalized, NOW)).toBe(normalized);
        const changes: Record<string, unknown> = {
            status: 'Archived', createdAt: 'never', updatedAt: '2000-01-01T00:00:00.000Z', projectId: ' ', areaId: 'a', order: 'x', orderNum: 99,
            recurrence: 'weekly', repeatReminderMinutes: 'x', dueReminderLeadMinutes: Number.NaN, timeSpentMinutes: -1, relativeStartOffset: 'x',
            rev: -1, revBy: ' dev ', pushCount: 'x', cancelledAt: 'bad', completedAt: AT, isFocusedToday: true, focusOrder: 4,
        };
        for (const [field, value] of Object.entries(changes)) {
            const mutated = { ...normalized, [field]: value } as Task;
            expect(normalizeTaskForLoad(mutated, NOW), field).not.toBe(mutated);
        }
    });

    it('keeps an unknown text direction as stored, as the two-pass form did', () => {
        // textDirection is only written when valid; an unknown value stays in the record untouched (not a normalized field).
        const stored = normalizeTaskForLoad(base({ textDirection: 'up', rev: 1, revBy: 'dev', pushCount: 0 }), NOW);
        expect(stored.textDirection).toBe('up');
        expect(normalizeTaskForLoad(stored, NOW)).toBe(stored);
        same(base({ textDirection: 'up' }), NOW);
    });

    it('loads byte-identical store state as the two-pass form did', async () => {
        const { fixture } = await import('../../../scripts/performance/fixture.mjs');
        const library = (fixture(500) as { data: AppData }).data;
        const shapes: AppData = { ...library, tasks: [...library.tasks, ...corpus().map(([name, task], index) => ({ ...task, id: `shape-${index}`, title: name }))],
            settings: { ...library.settings, deviceId: 'device', analyticsProfileId: 'profile' } as AppData['settings'] };
        const load = async (frozen: boolean) => {
            vi.resetModules();
            if (frozen) vi.doMock('./task-status', async (original) => ({ ...(await original<typeof import('./task-status')>()), normalizeTaskForLoad: frozenNormalizeTaskForLoad }));
            else vi.doUnmock('./task-status');
            vi.useFakeTimers({ now: new Date(NOW) });
            try {
                const store = await import('./store');
                store.resetForTests();
                store.setStorageAdapter({ getData: async () => structuredClone(shapes), saveData: async () => {} });
                await store.useTaskStore.getState().fetchData({ throwOnError: true });
                const state = store.useTaskStore.getState();
                return JSON.stringify({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections, areas: state._allAreas, settings: state.settings });
            } finally { vi.useRealTimers(); }
        };
        const actual = await load(false), expected = await load(true);
        if (actual !== expected) {
            const a = JSON.parse(actual), b = JSON.parse(expected);
            const diff = (x: any, y: any, path: string): string[] => JSON.stringify(x) === JSON.stringify(y) ? [] : (x && y && typeof x === 'object' && typeof y === 'object')
                ? [...new Set([...Object.keys(x), ...Object.keys(y)])].flatMap((k) => diff(x[k], y[k], `${path}.${k}`)).slice(0, 5) : [`${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`];
            console.log('DIFF', diff(a, b, '').join(' | '));
        }
        expect(actual).toBe(expected);
    // It imports the store twice (with and without the frozen normalizer): seconds of module loading on a loaded machine, so the
    // default 5 s timeout would make it flaky.
    }, 60_000);
});
