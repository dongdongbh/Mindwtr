import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFocusControlsModel, DEFAULT_FOCUS_CONTROL_STATE, type FocusControlState } from './focus-controls';
import { FOCUS_MODEL_CLOCK_READERS, getFocusModelValidUntil } from './focus-sections';
import { splitTodayTasksByStartTime } from './task-utils';
import type { AppSettings, Project, Task } from './types';

// The native Focus model is built once and kept until getFocusModelValidUntil's instant (native-host-contract.ts focusSections).
// Here, minute by minute, a model kept that way must equal one built fresh: across two midnights, New York's spring-forward and
// fall-back, and every start, due-soon and review instant of a randomized store (also 1 ms either side of each).

// The full sweep (48 h minute by minute, every control state, every threshold, 5,000 tasks) runs on demand:
// MINDWTR_FOCUS_SWEEP=full, a few minutes; run it on a change to a clock predicate. The suite runs 6 h around the spring-forward
// night, two control states, 500 tasks.
const FULL = process.env.MINDWTR_FOCUS_SWEEP === 'full';
const TASKS = FULL ? 5000 : 500;

const ZONE = 'America/New_York';
const MINUTE = 60_000;

// A seeded generator (mulberry32): the same store on every run.
const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const localDateTime = (at: Date, second = 0) => `${localDay(at)}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(second)}`;

/**
 * Dates clustered over [from, to): date-only, local date-times, and UTC instants, as stored values come. `timedOnly`: local
 * date-times 17 s past a minute, so no value lands on a midnight and only the midnight boundary covers the day turning.
 */
function store(from: number, to: number, seed: number, timedOnly = false): { tasks: Task[]; projects: Project[] } {
    const next = random(seed);
    const pick = <T,>(values: readonly T[]) => values[Math.floor(next() * values.length)];
    // Half inside the swept window (its thresholds), half within 3 days either side (the days around it).
    const instant = () => (next() < 0.5
        ? new Date(from + Math.floor(next() * (to - from) / MINUTE) * MINUTE)
        : new Date(from - 3 * 24 * 60 * MINUTE + Math.floor(next() * (to - from + 6 * 24 * 60 * MINUTE) / MINUTE) * MINUTE));
    // Due dates partly 30 days out, so their due-soon thresholds (due less the window) fall inside the sweep.
    const DUE_SOON = 30 * 24 * 60 * MINUTE;
    const date = (shift = 0) => {
        const at = new Date(instant().getTime() + shift);
        if (timedOnly) return localDateTime(at, 17);
        const kind = next();
        return kind < 0.4 ? localDay(at) : kind < 0.8 ? localDateTime(at) : at.toISOString();
    };
    const AT = '2026-01-01T00:00:00.000Z';
    const projects: Project[] = Array.from({ length: 50 }, (_, index) => ({
        id: `p${index}`, title: `Project ${index}`, status: pick(['active', 'active', 'someday', 'waiting', 'archived'] as const),
        color: '#94a3b8', order: index, createdAt: AT, updatedAt: AT,
        ...(next() < 0.3 ? { reviewAt: date() } : {}),
        ...(next() < 0.3 ? { dueDate: date() } : {}),
        ...(next() < 0.2 ? { isSequential: true } : {}),
    } as Project));
    const tasks: Task[] = Array.from({ length: TASKS }, (_, index) => {
        const status = pick(['next', 'next', 'next', 'inbox', 'waiting', 'someday', 'done', 'reference'] as const);
        return {
            id: `t${index}`, title: `Task ${index}`, status, tags: next() < 0.3 ? [`#tag${index % 5}`] : [],
            contexts: next() < 0.3 ? [`@ctx${index % 4}`] : [], createdAt: AT, updatedAt: AT, order: index,
            ...(next() < 0.6 ? { projectId: `p${Math.floor(next() * 50)}` } : {}),
            ...(next() < 0.35 ? { startTime: date() } : {}),
            ...(next() < 0.35 ? { dueDate: date(next() < 0.3 ? DUE_SOON : 0) } : {}),
            ...(next() < 0.15 ? { reviewAt: date() } : {}),
            ...(next() < 0.08 ? { recurrence: { rule: pick(['daily', 'weekly', 'monthly'] as const), strategy: 'strict' } } : {}),
            ...(next() < 0.1 ? { isFocusedToday: true } : {}),
            ...(next() < 0.2 ? { priority: pick(['low', 'medium', 'high', 'urgent'] as const) } : {}),
            ...(status === 'done' ? { completedAt: AT } : {}),
        } as Task;
    });
    return { tasks, projects };
}

/** Everything the native contract reads from a model, with tasks and projects as their ids (the later-today split apart). */
const observe = (value: unknown): string => JSON.stringify(value, (_key, item) => {
    if (item instanceof Map) return [...item.entries()];
    if (item instanceof Set) return [...item];
    if (item && typeof item === 'object' && typeof item.id === 'string' && typeof item.createdAt === 'string') return `#${item.id}`;
    return item;
});

const t = (key: string) => key;

function sweep(input: { tasks: Task[]; projects: Project[]; settings: AppSettings; state: FocusControlState }, instants: number[]) {
    const build = (now: Date) => buildFocusControlsModel({
        state: input.state, tasks: input.tasks, projects: input.projects, areas: [], sections: [], settings: input.settings, now, t,
        formatDate: (value) => value,
    });
    let kept: { model: ReturnType<typeof buildFocusControlsModel>; seen: string; builtAt: number; validUntil: number } | null = null;
    let rebuilds = 0;
    for (const at of instants) {
        const now = new Date(at);
        if (!kept || !(at >= kept.builtAt && at < kept.validUntil)) {
            const model = build(now);
            kept = { model, seen: observe(model), builtAt: at, validUntil: getFocusModelValidUntil({ tasks: input.tasks, projects: input.projects, now }) ?? at };
            rebuilds += 1;
        }
        const fresh = build(now);
        if (kept.seen !== observe(fresh)
            || observe(splitTodayTasksByStartTime(kept.model.lists.schedule, now)) !== observe(splitTodayTasksByStartTime(fresh.lists.schedule, now))) {
            throw new Error(`The kept Focus model differs from a fresh one at ${now.toISOString()} (built ${new Date(kept.builtAt).toISOString()})`);
        }
    }
    return rebuilds;
}

const minutes = (from: number, to: number) => Array.from({ length: Math.floor((to - from) / MINUTE) }, (_, index) => from + index * MINUTE);


describe('the native Focus model kept until its next-change instant', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => { process.env.TZ = ZONE; });
    afterAll(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

    const settings: AppSettings = {
        savedFilters: [{
            id: 'soon', name: 'Soon', view: 'focus', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
            criteria: { dueDateRange: { preset: 'overdue_next_7_days' }, anyDateRange: { preset: 'this_week' } }, sortBy: 'due',
        }],
    } as AppSettings;
    const states: Array<[string, FocusControlState, AppSettings]> = [
        ['default', DEFAULT_FOCUS_CONTROL_STATE, {}],
        ['due sort, start dates off', { ...DEFAULT_FOCUS_CONTROL_STATE, sortBy: 'due' }, { gtd: { focusIncludeStartDates: false } } as AppSettings],
        ['a saved filter of date presets', { ...DEFAULT_FOCUS_CONTROL_STATE, savedFilterId: 'soon' }, settings],
    ];

    it(`equals a fresh build every minute across ${FULL ? 'two midnights' : 'a midnight'} and the spring-forward change`, () => {
        process.env.TZ = ZONE;
        const from = FULL ? new Date(2026, 2, 7, 12, 0).getTime() : new Date(2026, 2, 7, 22, 0).getTime();
        const to = FULL ? new Date(2026, 2, 9, 12, 0).getTime() : new Date(2026, 2, 8, 4, 0).getTime();
        const data = store(from, to, 1);
        const [, state, extra] = states[0];
        const rebuilds = sweep({ ...data, settings: extra, state }, minutes(from, to));
        // The cache is used: far fewer builds than minutes.
        expect(rebuilds).toBeLessThan(minutes(from, to).length / 2);
    }, 240_000);

    it('equals a fresh build each minute across a midnight no stored date lands on', () => {
        process.env.TZ = ZONE;
        const from = new Date(2026, 2, 6, 22, 0).getTime();
        const to = new Date(2026, 2, 7, 4, 0).getTime();
        sweep({ ...store(from, to, 4, true), settings: {}, state: DEFAULT_FOCUS_CONTROL_STATE }, minutes(from, to));
    }, 240_000);

    it.each(FULL ? states : [states[0], states[2]])('equals a fresh build each minute over the fall-back change and 1 ms around every threshold (%s)', (_name, state, extra) => {
        process.env.TZ = ZONE;
        const from = new Date(2026, 9, 31, 22, 0).getTime();
        const to = new Date(2026, 10, 1, 4, 0).getTime();
        const data = store(from, to, 2);
        sweep({ ...data, settings: extra, state }, minutes(from, to));
        // Every instant a predicate reads within the window, 1 ms before, at and after it.
        const edges = new Set<number>();
        // The suite takes every fourth instant; the full sweep all of them.
        let seen = 0;
        const add = (value: string | undefined, shift = 0) => {
            const at = (value ? new Date(value.length === 10 ? `${value}T00:00:00` : value).getTime() : NaN) - shift;
            if (!Number.isFinite(at) || at < from || at >= to) return;
            seen += 1;
            if (FULL || seen % 4 === 0) for (const edge of [at - 1, at, at + 1]) edges.add(edge);
        };
        const dueSoon = 30 * 24 * 60 * MINUTE;
        for (const task of data.tasks) { add(task.startTime); add(task.dueDate, dueSoon); add(task.reviewAt); }
        for (const project of data.projects) add(project.reviewAt);
        sweep({ ...data, settings: extra, state }, [...edges].sort((a, b) => a - b));
    }, 240_000);

    // The sweep proves today's predicates; this catches a new one. Every function the build reads the clock in (the `now` it is
    // given, Date.now(), a new Date() of now) must be in FOCUS_MODEL_CLOCK_READERS, whose boundaries getFocusModelValidUntil covers.
    it('reads the clock only in functions whose boundary getFocusModelValidUntil covers', () => {
        process.env.TZ = ZONE;
        const RealDate = Date;
        const readers = new Map<string, string>();
        const record = (what: string) => {
            const frames = (new Error().stack ?? '').split('\n').slice(2);
            const frame = frames.find((line) => line.includes('/packages/core/src/') && !line.includes('focus-model-clock.test.ts')) ?? '';
            const name = /at (?:[\w$.]+\.)?([\w$<>]+) \(/.exec(frame)?.[1] ?? frame.trim();
            readers.set(name, what);
        };
        // The build's `now`: every read of it is recorded with the core function that made it.
        class Now extends RealDate {}
        for (const method of ['getTime', 'valueOf', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
            'getMilliseconds', 'getTimezoneOffset', 'toISOString', 'toJSON'] as const) {
            Object.defineProperty(Now.prototype, method, { value(this: Date, ...args: unknown[]) {
                record(`now.${method}`);
                return (RealDate.prototype[method] as (...rest: unknown[]) => unknown).apply(this, args);
            } });
        }
        Object.defineProperty(Now.prototype, Symbol.toPrimitive, { value(this: Date, hint: string) {
            record('now (compared)');
            return (RealDate.prototype[Symbol.toPrimitive] as (hint: string) => unknown).call(this, hint);
        } });
        class Clock extends RealDate {
            constructor(...args: unknown[]) {
                if (args.length === 0) record('new Date()');
                super(...(args as []));
            }
            static now() { record('Date.now()'); return RealDate.now(); }
        }
        const from = new RealDate(2026, 2, 7, 22, 0).getTime();
        const data = store(from, from + 6 * 60 * MINUTE, 3);
        const stackLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 12;
        globalThis.Date = Clock as DateConstructor;
        try {
            for (const [, state, extra] of states) {
                const now = new Now(from + 90 * MINUTE);
                const model = buildFocusControlsModel({
                    state, tasks: data.tasks, projects: data.projects, areas: [], sections: [], settings: extra, now, t,
                    formatDate: (value) => value,
                });
                splitTodayTasksByStartTime(model.lists.schedule, now);
            }
        } finally {
            globalThis.Date = RealDate;
            Error.stackTraceLimit = stackLimit;
        }
        expect([...readers.keys()].filter((name) => !Object.hasOwn(FOCUS_MODEL_CLOCK_READERS, name))).toEqual([]);
        // The guard sees the readers: the build does read the clock.
        expect(readers.size).toBeGreaterThan(3);
    }, 120_000);
});

