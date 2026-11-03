import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import { planReminderAlarms, type ReminderAlarmEntry } from './mobile-reminder-alarms';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings, Project, Task } from './types';


const corpusFile = join(dirname(fileURLToPath(import.meta.url)), 'reminder-plan-corpus.json');
const ZONE = 'America/New_York';
const MINUTE = 60_000;

const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const localDateTime = (at: Date) => `${localDay(at)}T${pad(at.getHours())}:${pad(at.getMinutes())}:00`;


function store(count: number, from: number, to: number, seed: number, datedShare = 0.5): { tasks: Task[]; projects: Project[] } {
    const next = random(seed);
    const pick = <T,>(values: readonly T[]) => values[Math.floor(next() * values.length)];
    const instant = () => new Date(from - 2 * 24 * 60 * MINUTE + Math.floor(next() * (to - from + 4 * 24 * 60 * MINUTE) / MINUTE) * MINUTE);
    const date = () => {
        const at = instant();
        const kind = next();
        return kind < 0.3 ? localDay(at) : kind < 0.75 ? localDateTime(at) : at.toISOString();
    };
    const AT = '2026-01-01T00:00:00.000Z';
    const projects: Project[] = Array.from({ length: 30 }, (_, index) => ({
        id: `p${index}`, title: `Project ${index}`, status: pick(['active', 'active', 'someday', 'archived'] as const), color: '#94a3b8',
        createdAt: AT, updatedAt: AT, ...(next() < 0.4 ? { reviewAt: date() } : {}), ...(next() < 0.1 ? { deletedAt: AT } : {}),
    } as Project));
    const tasks: Task[] = Array.from({ length: count }, (_, index) => {
        const status = pick(['next', 'next', 'next', 'inbox', 'waiting', 'someday', 'done', 'reference'] as const);
        const shape = next();

        const kind = next();
        const dated = shape >= datedShare ? {} : kind < 0.3 ? { dueDate: date() } : kind < 0.5 ? { startTime: date() }
            : kind < 0.8 ? { dueDate: date(), startTime: date() } : { reviewAt: date() };
        return {
            id: `t${index}`, title: `Task ${index}`, status, tags: [], contexts: [], createdAt: AT, updatedAt: AT,
            ...dated,
            ...(shape < datedShare && next() < 0.1 ? { reviewAt: date() } : {}),
            ...(next() < 0.08 ? { recurrence: { rule: pick(['daily', 'weekly', 'monthly'] as const), strategy: pick(['strict', 'fluid'] as const) } } : {}),
            ...(next() < 0.1 ? { dueReminderLeadMinutes: pick([5, 15, 60, 1440]) } : {}),
            ...(next() < 0.05 ? { repeatReminderMinutes: pick([10, 30]) } : {}),
            ...(next() < 0.4 ? { projectId: `p${Math.floor(next() * 30)}` } : {}),
            ...(next() < 0.03 ? { deletedAt: AT } : {}),
            ...(status === 'done' ? { completedAt: AT } : {}),
        } as Task;
    });
    return { tasks, projects };
}

const SETTINGS: Array<[string, Partial<AppSettings>]> = [
    ['defaults', {}],
    ['digests', { dailyDigestMorningEnabled: true, dailyDigestEveningEnabled: true, weeklyReviewEnabled: true }],
    ['no start reminders', { startDateNotificationsEnabled: false }],
    ['no due reminders', { dueDateNotificationsEnabled: false }],
    ['no review notifications', { reviewAtNotificationsEnabled: false }],
    ['notifications off', { notificationsEnabled: false }],
];

const INSTANTS = (): Array<[string, Date]> => [
    ['before midnight', new Date(2026, 2, 6, 23, 59, 59, 999)],
    ['midnight', new Date(2026, 2, 7, 0, 0, 0, 0)],
    ['before spring-forward', new Date(2026, 2, 8, 1, 59, 30)],
    ['after spring-forward', new Date(2026, 2, 8, 3, 0, 30)],
    ['before fall-back', new Date('2026-11-01T05:59:30Z')],
    ['inside fall-back hour', new Date('2026-11-01T06:30:00Z')],
    ['after fall-back', new Date('2026-11-01T07:00:30Z')],
    ['afternoon', new Date(2026, 9, 28, 15, 7)],
];

const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => {
    if (item instanceof Map) return [...item.entries()];
    if (item instanceof Set) return [...item];
    return item;
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');


const heldFrom = (plan: ReturnType<typeof planReminderAlarms>): Map<string, ReminderAlarmEntry> => new Map(
    [...plan.recurring, ...plan.oneShot].map((request, index) => [request.key, { id: 1000 + index, signature: request.signature, fireAtMs: request.config.fireAt.getTime() }]));

describe('reminder plan corpus (frozen before the plan was trimmed)', () => {
    const originalTz = process.env.TZ;
    let translations: Record<string, string> = {};
    beforeAll(async () => {
        process.env.TZ = ZONE;
        translations = await loadTranslations('en');
    });
    afterAll(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });
    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
    });

    const frozen = (): Record<string, string> => (process.env.UPDATE_REMINDER_CORPUS === '1' ? {} : JSON.parse(readFileSync(corpusFile, 'utf8')));
    const results: Record<string, string> = {};
    afterAll(() => {
        if (process.env.UPDATE_REMINDER_CORPUS !== '1') return;
        const previous = (() => { try { return JSON.parse(readFileSync(corpusFile, 'utf8')) as Record<string, string>; } catch { return {}; } })();
        writeFileSync(corpusFile, `${JSON.stringify({ ...previous, ...results }, null, 1)}\n`);
    });
    const check = (name: string, output: unknown, saved: Record<string, string>) => {
        const text = serialize(output);
        results[name] = digest(text);
        if (process.env.UPDATE_REMINDER_CORPUS !== '1') expect(digest(text), name).toBe(saved[name]);
    };

    it('core planReminderAlarms: a 5,000-task store, every settings case, every instant, with and without held alarms', () => {
        process.env.TZ = ZONE;
        const saved = frozen();
        const data = store(5000, new Date(2026, 2, 6).getTime(), new Date(2026, 10, 2).getTime(), 7);
        let requests = 0;
        for (const [settingsName, settings] of SETTINGS) {
            for (const [instantName, now] of INSTANTS()) {
                const input = { settings: settings as AppSettings, tasks: data.tasks, projects: data.projects, translations, maxOneShotReminders: 200 };
                const earlier = planReminderAlarms({ ...input, now: new Date(now.getTime() - 60 * MINUTE), alarms: new Map(), permissionGranted: true });
                for (const [heldName, alarms] of [['none held', new Map()], ['held from an hour before', heldFrom(earlier)]] as const) {
                    const plan = planReminderAlarms({ ...input, now, alarms: new Map(alarms), permissionGranted: true });
                    requests += plan.oneShot.length + plan.recurring.length;
                    check(`core ${settingsName} ${instantName} ${heldName}`, plan, saved);
                }
                check(`core ${settingsName} ${instantName} revoked`, planReminderAlarms({ ...input, now, alarms: heldFrom(earlier), permissionGranted: false }), saved);
            }
        }

        expect(requests).toBeGreaterThan(1000);
    }, 120_000);


    it('core planReminderAlarms on 5,000-task stores with no, 20% and all tasks dated', () => {
        process.env.TZ = ZONE;
        const saved = frozen();
        let requests = 0;
        for (const [shapeName, share] of [['none dated', 0], ['20% dated', 0.2], ['all dated', 1]] as const) {
            const data = store(5000, new Date(2026, 2, 6).getTime(), new Date(2026, 10, 2).getTime(), 13, share);
            for (const [settingsName, settings] of SETTINGS.slice(0, 2)) {
                for (const [instantName, now] of INSTANTS().filter((_, index) => index % 2 === 0)) {
                    const input = { settings: settings as AppSettings, tasks: data.tasks, projects: data.projects, translations, maxOneShotReminders: 200 };
                    const earlier = planReminderAlarms({ ...input, now: new Date(now.getTime() - 60 * MINUTE), alarms: new Map(), permissionGranted: true });
                    const plan = planReminderAlarms({ ...input, now, alarms: heldFrom(earlier), permissionGranted: true });
                    requests += plan.oneShot.length;
                    check(`shape ${shapeName} ${settingsName} ${instantName}`, plan, saved);
                }
            }
        }
        expect(requests).toBeGreaterThan(1000);
    }, 120_000);

    it('the native contract plan: delivered and Snooze state judged, with and without a ledger', async () => {
        process.env.TZ = ZONE;
        const saved = frozen();
        let delivered = 0, snoozes = 0;
        for (const [settingsName, settings] of SETTINGS.slice(0, 3)) {
            for (const [instantName, now] of INSTANTS()) {

                const data = store(400, now.getTime() - 12 * 60 * MINUTE, now.getTime() + 12 * 60 * MINUTE, 11);
                await flushPendingSave();
                resetForTests();
                let stored = JSON.parse(JSON.stringify({ ...data, sections: [], areas: [], people: [], settings }));
                setStorageAdapter({ getData: async () => stored, saveData: async (next) => { stored = JSON.parse(JSON.stringify(next)); } });
                useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
                    error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
                await useTaskStore.getState().fetchData({ throwOnError: true });
                await flushPendingSave();
                const host = createNativeHostContract({ reminderPlatform: 'android' });
                await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' });
                await host.activate({ writeSafetyReady: true });
                vi.useFakeTimers({ toFake: ['Date'] });
                vi.setSystemTime(new Date(now.getTime() - 6 * 60 * MINUTE));
                const earlier = await host.planReminderAlarms({ storedAlarms: null, permissionGranted: true, storedState: null });
                if (!earlier.ok) throw new Error(earlier.error.message);

                const state: Record<string, unknown> = {};
                let id = 5000;
                const soonest = [...earlier.value.schedule].sort((a, b) => (a as { fireAtMs: number }).fireAtMs - (b as { fireAtMs: number }).fireAtMs);
                for (const item of soonest.slice(0, 60)) {
                    const alarm = item as { key: string; fireAtMs: number; details: Record<string, unknown> };
                    if (alarm.fireAtMs <= now.getTime() && id % 4 !== 3) { state[alarm.key] = { kind: 'delivered', id: id++, firedAtMs: alarm.fireAtMs }; delivered += 1; }
                    else if (id % 2 === 1) {
                        state[`snooze:${alarm.key}:${id}`] = { kind: 'snooze', id: id++, fireAtMs: alarm.fireAtMs + 10 * MINUTE, armed: id % 3 === 0,
                            details: { ...alarm.details, data: { ...(alarm.details.data as object), alarmKey: alarm.key } } };
                        snoozes += 1;
                    } else id += 1;
                }
                vi.setSystemTime(now);
                for (const [ledgerName, ledger] of [['no ledger', {}], ['ledger', { fired: [5000, 5001, 5003, 5005], shown: [5000, 5005] }]] as const) {
                    const plan = await host.planReminderAlarms({ storedAlarms: earlier.value.alarms, permissionGranted: true,
                        storedState: JSON.stringify(state), ...ledger });
                    check(`contract ${settingsName} ${instantName} ${ledgerName}`, plan, saved);
                }
                const rebuild = await host.planReminderAlarms({ storedAlarms: earlier.value.alarms, permissionGranted: true,
                    storedState: JSON.stringify(state), remake: 'all' });
                check(`contract ${settingsName} ${instantName} rebuild`, rebuild, saved);
                vi.useRealTimers();
            }
        }

        expect(delivered).toBeGreaterThan(20);
        expect(snoozes).toBeGreaterThan(20);
    }, 240_000);
});


describe('planReminderAlarms lookup maps', () => {
    it('builds no task or project map for a plan that holds no alarm, and both once an alarm is held', async () => {
        const translations = await loadTranslations('en');
        let mapped = 0;
        class Counted<T> extends Array<T> {
            override map<U>(callback: (value: T, index: number, array: T[]) => U): U[] { mapped += 1; return Array.from(this, callback); }
        }
        const AT = '2026-01-01T00:00:00.000Z';
        const tasks = Counted.from([{ id: 't1', title: 'Call', status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT, dueDate: '2026-10-29T10:00:00Z' }]) as unknown as Task[];
        const projects = Counted.from([{ id: 'p1', title: 'P', status: 'active', color: '#94a3b8', createdAt: AT, updatedAt: AT }]) as unknown as Project[];
        const input = { settings: {} as AppSettings, tasks, projects, now: new Date('2026-10-28T10:00:00Z'), translations, maxOneShotReminders: 200, permissionGranted: true };
        const plan = planReminderAlarms({ ...input, alarms: new Map() });
        expect(plan.schedule.length).toBeGreaterThan(0);
        expect(mapped).toBe(0);
        planReminderAlarms({ ...input, alarms: new Map([['task:gone', { id: 1, signature: 'x', fireAtMs: Date.parse('2026-10-28T09:00:00Z') }]]) });
        expect(mapped).toBe(1);
    });
});


describe('the undated skip in the reminder plan', () => {
    it('plans and counts nothing for a dateless task with every other reminder field set', async () => {
        const translations = await loadTranslations('en');
        const AT = '2026-01-01T00:00:00.000Z';
        const dateless = { id: 't', title: 'T', status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT,
            recurrence: { rule: 'daily', strategy: 'strict' }, dueReminderLeadMinutes: 60, repeatReminderMinutes: 10,
            relativeStartOffset: { value: 1, unit: 'days' }, reminderPolicy: 'send', isFocusedToday: true, priority: 'high' } as unknown as Task;
        const input = { settings: { dailyDigestMorningEnabled: false } as AppSettings, tasks: [dateless], projects: [], translations,
            maxOneShotReminders: 200, alarms: new Map(), permissionGranted: true, now: new Date('2026-10-28T10:00:00Z') };
        const plan = planReminderAlarms(input);
        expect(plan.oneShot).toEqual([]);
        expect(Object.entries(plan.diagnostics ?? {}).filter(([key, value]) => key.endsWith('Count') && value !== 0)).toEqual([]);
    });

    it('reads task dates only from dueDate, startTime and reviewAt', () => {
        const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schedule-utils.ts'), 'utf8');
        const read = new Set([...source.matchAll(/(?:parseExplicitReminderDate|hasTimeComponent|safeParseDate|safeParseDueDate)\(task\.(\w+)/g)].map((match) => match[1]));
        const candidates = new Set([...source.matchAll(/addCandidate\(\s*'\w+',\s*task\.(\w+)/g)].map((match) => match[1]));
        expect([...read, ...candidates].filter((field) => !['dueDate', 'startTime', 'reviewAt'].includes(field))).toEqual([]);
        expect(source).toContain('if (!task.dueDate && !task.startTime && !task.reviewAt) continue;');
    });
});
