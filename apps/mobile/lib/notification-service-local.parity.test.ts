


import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const FIXTURE_PATH = new URL('../../../packages/core/src/reminder-alarms-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_REMINDER_ALARMS === '1';
const ALARM_MAP_KEY = 'mindwtr:local:alarms:v1';

type Answer = { id: number | string } | { reject: string };
type Cycle = {
  now: string;
  platform?: 'android' | 'ios';
  trigger?: 'start' | 'exact';
  settings: Record<string, unknown>;
  tasks: Record<string, unknown>[];
  projects?: Record<string, unknown>[];

  answers?: Answer[];
};
type Scenario = { name: string; storedAlarms?: string; cycles: Cycle[] };

const harness = vi.hoisted(() => ({
  log: [] as unknown[][],
  storage: new Map<string, string>(),
  state: { settings: {} as Record<string, unknown>, tasks: [] as unknown[], projects: [] as unknown[] },
  platform: { OS: 'android', Version: 34 },
  answers: [] as ({ id: number | string } | { reject: string })[],
  nextId: 100,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => harness.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      harness.log.push(['setItem', key, value]);
      harness.storage.set(key, value);
    },
    removeItem: async (key: string) => {
      harness.log.push(['removeItem', key]);
      harness.storage.delete(key);
    },
  },
}));

vi.mock('react-native', () => ({
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
  NativeModules: {},
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted', NEVER_ASK_AGAIN: 'never_ask_again' },
    check: async () => true,
    request: async () => 'granted',
  },
  Platform: harness.platform,
}));

vi.mock('react-native-alarm-notification', () => ({
  default: {
    parseDate: (date: Date) => date.toISOString(),
    scheduleAlarm: async (details: Record<string, unknown>) => {
      harness.log.push(['scheduleAlarm', details]);
      const answer = harness.answers.shift() ?? { id: harness.nextId++ };
      if ('reject' in answer) throw new Error(answer.reject);
      return { id: answer.id };
    },
    sendNotification: (details: unknown) => harness.log.push(['sendNotification', details]),
    deleteAlarm: (id: number) => harness.log.push(['deleteAlarm', id]),
    deleteRepeatingAlarm: (id: number) => harness.log.push(['deleteRepeatingAlarm', id]),
    removeFiredNotification: (id: number) => harness.log.push(['removeFiredNotification', id]),
    removeAllFiredNotifications: () => harness.log.push(['removeAllFiredNotifications']),
    getScheduledAlarms: async () => {
      harness.log.push(['getScheduledAlarms']);
      return [];
    },
    requestPermissions: async () => ({ alert: true }),
  },
}));


vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    getSystemDefaultLanguage: () => 'en',
    useTaskStore: {
      getState: () => harness.state,
      subscribe: () => () => undefined,
    },
  };
});

vi.mock('./app-log', () => ({
  isLoggingEnabled: () => true,
  logInfo: async (message: string, context?: { extra?: unknown }) => {
    harness.log.push(['logInfo', message, context?.extra ?? null]);
  },
  logWarn: async (message: string, context?: { extra?: unknown }) => {
    harness.log.push(['logWarn', message, context?.extra ?? null]);
  },
}));

vi.mock('@/modules/notification-open-intents', () => ({
  ensureReminderNotificationChannel: async (...args: unknown[]) => {
    harness.log.push(['ensureReminderNotificationChannel', ...args]);
  },
  restorePersistentCaptureNotification: () => harness.log.push(['restorePersistentCaptureNotification']),
}));

import {
  __localNotificationTestUtils,
  rescheduleLocalAlarmsAsExact,
  startLocalMobileNotifications,
} from './notification-service-local';

const CREATED = '2026-09-01T00:00:00.000Z';
const task = (id: string, fields: Record<string, unknown> = {}) => ({
  id, title: `Task ${id}`, status: 'next', tags: [], contexts: [], createdAt: CREATED, updatedAt: CREATED, ...fields,
});
const project = (id: string, fields: Record<string, unknown> = {}) => ({
  id, title: `Project ${id}`, status: 'active', color: '#3b82f6', order: 0, tagIds: [], createdAt: CREATED, updatedAt: CREATED, ...fields,
});
const minutesAfter = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

const MONDAY = '2026-09-28T10:00:00.000Z';
const DIGESTS = {
  notificationsEnabled: false,
  dailyDigestMorningEnabled: true,
  dailyDigestMorningTime: '08:15',
  dailyDigestEveningEnabled: true,
  dailyDigestEveningTime: '19:45',
  weeklyReviewEnabled: true,
  weeklyReviewDay: 2,
  weeklyReviewTime: '18:30',
};
const EVERY_KIND = [
  task('t-due', { title: 'Pay rent', description: '**Bring** the [keys](https://example.com)', dueDate: '2026-09-28T11:00:00.000Z' }),
  task('t-start', { title: 'Start report', startTime: '2026-09-28T10:30:00.000Z', dueDate: '2026-09-29T09:00:00.000Z' }),
  task('t-repeat', { title: 'Call back', dueDate: '2026-09-28T10:20:00.000Z', repeatReminderMinutes: 30 }),
  task('t-date-only', { title: 'Date only', dueDate: '2026-09-29' }),
  task('t-date-only-start', { title: 'Date only start', startTime: '2026-09-30' }),
  task('t-review', { title: 'Review proposal', reviewAt: '2026-09-28T12:00:00.000Z' }),
  task('t-past', { title: 'Already due', dueDate: '2026-09-28T09:00:00.000Z' }),
  task('t-done', { title: 'Finished', status: 'done', dueDate: '2026-09-28T13:00:00.000Z' }),
  task('t-suppressed', { title: 'Quiet', suppressMindwtrReminders: true, dueDate: '2026-09-28T14:00:00.000Z' }),
  task('t-offset', { title: 'Offset due', dueDate: '2026-09-28T15:30:00+02:00' }),
];
const minuteTasks = (count: number, from: string) => Array.from({ length: count }, (_, index) => (
  task(`m-${String(index).padStart(3, '0')}`, { title: `Minute ${index}`, dueDate: minutesAfter(from, index + 1) })
)).reverse();

export const scenarios: Scenario[] = [
  {
    name: 'digests and the weekly review with task reminders off',
    cycles: [
      { now: MONDAY, settings: DIGESTS, tasks: [task('t-ignored', { dueDate: '2026-09-28T11:00:00.000Z' })] },
      { now: minutesAfter(MONDAY, 60), settings: DIGESTS, tasks: [] },
      { now: minutesAfter(MONDAY, 61), settings: { ...DIGESTS, dailyDigestMorningEnabled: false, weeklyReviewDay: 5 }, tasks: [] },
    ],
  },
  {
    name: 'task reminders of every kind, then a completed task and a moved review',
    cycles: [
      {
        now: MONDAY,
        settings: { dailyDigestMorningEnabled: true },
        tasks: EVERY_KIND,
        projects: [project('p-review', { reviewAt: '2026-09-28T16:00:00.000Z' }), project('p-archived', { status: 'archived', reviewAt: '2026-09-28T16:00:00.000Z' })],
      },
      {
        now: minutesAfter(MONDAY, 40),
        settings: { dailyDigestMorningEnabled: true, startDateNotificationsEnabled: false },
        tasks: EVERY_KIND.map((item) => (
          item.id === 't-due' ? { ...item, status: 'done' }
            : item.id === 't-review' ? { ...item, reviewAt: '2026-09-29T08:00:00.000Z' }
              : item
        )),
        projects: [project('p-review', { reviewAt: '2026-09-28T16:00:00.000Z' })],
      },
    ],
  },
  {
    name: 'the Android one-shot cap and its top-up',
    cycles: [
      { now: MONDAY, settings: {}, tasks: minuteTasks(205, MONDAY) },
      { now: minutesAfter(MONDAY, 3.1), settings: {}, tasks: minuteTasks(205, MONDAY) },
    ],
  },
  {
    name: 'the iOS one-shot cap',
    cycles: [{ now: MONDAY, platform: 'ios', settings: {}, tasks: minuteTasks(62, MONDAY) }],
  },
  {
    name: 'stored alarms: unreadable, legacy, stale and invalid ids',
    storedAlarms: JSON.stringify({
      'task:gone': { id: 7, signature: 'stale' },
      'task:t-legacy': { id: 8 },
      'task:t-fraction': { id: 9.7, signature: 'old' },
      unreadable: 'nope',
      'bad-id': { id: 'abc' },
      'null-entry': null,
    }),
    cycles: [
      {
        now: MONDAY,
        settings: {},
        tasks: [
          task('t-legacy', { dueDate: '2026-09-28T11:00:00.000Z' }),
          task('t-fraction', { dueDate: '2026-09-28T11:05:00.000Z' }),
          task('t-invalid-id', { dueDate: '2026-09-28T11:10:00.000Z' }),
        ],
        answers: [{ id: 21 }, { id: 22.9 }, { id: 'not-a-number' }],
      },
    ],
  },
  {
    name: 'a taken minute retries one minute later',
    cycles: [
      {
        now: MONDAY,
        settings: {},
        tasks: [task('t-busy', { dueDate: '2026-09-28T11:00:30.500Z' })],
        answers: [
          { reject: 'Duplicate alarm set at date 28-09-2026 11:00:30' },
          { reject: 'duplicate alarm set at date 28-09-2026 11:01:30' },
          { id: 31 },
        ],
      },
    ],
  },
  {
    name: 'a minute that stays taken skips that alarm',
    cycles: [
      {
        now: MONDAY,
        settings: {},
        tasks: [task('t-full', { dueDate: '2026-09-28T11:00:00.000Z' })],
        answers: Array.from({ length: 60 }, () => ({ reject: 'Duplicate alarm set at date' })),
      },
    ],
  },
  {
    name: 'a rejected alarm is skipped and the cycle finishes',
    cycles: [
      {
        now: MONDAY,
        settings: { dailyDigestEveningEnabled: true },
        tasks: [
          task('t-one', { dueDate: '2026-09-28T11:00:00.000Z' }),
          task('t-two', { dueDate: '2026-09-28T11:30:00.000Z' }),
          task('t-three', { dueDate: '2026-09-28T12:00:00.000Z' }),
        ],
        answers: [{ id: 41 }, { id: 42 }, { reject: 'exact alarm permission revoked' }, { id: 44 }],
      },
      {
        now: minutesAfter(MONDAY, 1),
        settings: { dailyDigestEveningEnabled: true },
        tasks: [
          task('t-one', { dueDate: '2026-09-28T11:00:00.000Z' }),
          task('t-two', { dueDate: '2026-09-28T11:30:00.000Z' }),
          task('t-three', { dueDate: '2026-09-28T12:00:00.000Z' }),
        ],
      },
    ],
  },
  {
    name: 'no reminder feature on cancels every alarm',
    cycles: [
      { now: MONDAY, settings: { weeklyReviewEnabled: true }, tasks: [task('t-one', { dueDate: '2026-09-28T11:00:00.000Z' })] },
      { now: minutesAfter(MONDAY, 5), settings: { notificationsEnabled: false }, tasks: [task('t-one', { dueDate: '2026-09-28T11:00:00.000Z' })] },
    ],
  },
  {
    name: 'rebuilding as exact cancels and re-creates every alarm',
    cycles: [
      { now: MONDAY, settings: { dailyDigestEveningEnabled: true }, tasks: [task('t-one', { dueDate: '2026-09-28T11:00:00.000Z' })] },
      { now: minutesAfter(MONDAY, 2), trigger: 'exact', settings: { dailyDigestEveningEnabled: true }, tasks: [task('t-one', { dueDate: '2026-09-28T11:00:00.000Z' })] },
    ],
  },
  {
    name: 'times across midnight and offsets with TZ pinned to UTC',
    cycles: [
      {
        now: '2026-09-27T23:50:00.000Z',
        settings: {
          dailyDigestMorningEnabled: true,
          dailyDigestMorningTime: '00:05',
          dailyDigestEveningEnabled: true,
          dailyDigestEveningTime: '23:45',
          weeklyReviewEnabled: true,
          weeklyReviewDay: 0,
          weeklyReviewTime: '23:55',
        },
        tasks: [
          task('t-kolkata', { dueDate: '2026-09-28T05:40:00+05:30' }),
          task('t-new-york', { startTime: '2026-09-27T20:00:00-04:00' }),
          task('t-local', { dueDate: '2026-09-28T00:01:00' }),
        ],
      },
    ],
  },
];

const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));

async function runScenario(scenario: Scenario) {
  __localNotificationTestUtils.resetForTests();
  vi.clearAllTimers();
  harness.storage.clear();
  if (scenario.storedAlarms !== undefined) harness.storage.set(ALARM_MAP_KEY, scenario.storedAlarms);
  harness.nextId = 100;
  const observations: unknown[] = [];
  for (const cycle of scenario.cycles) {
    vi.setSystemTime(new Date(cycle.now));
    harness.platform.OS = cycle.platform ?? 'android';
    harness.state = { settings: cycle.settings, tasks: cycle.tasks, projects: cycle.projects ?? [] };
    harness.answers = [...(cycle.answers ?? [])];
    harness.log.length = 0;
    let error: string | null = null;
    try {
      if (cycle.trigger === 'exact') await rescheduleLocalAlarmsAsExact();
      else await startLocalMobileNotifications();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    observations.push(normalize({
      calls: harness.log,
      alarms: Object.fromEntries(__localNotificationTestUtils.getAlarmMapSnapshot()),
      error,
    }));
  }
  return observations;
}

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const declared = process.env.MINDWTR_CAPTURE_REMINDER_ALARMS_COMMIT;
  if (declared !== head) throw new Error(`Recapture needs MINDWTR_CAPTURE_REMINDER_ALARMS_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  const allowed = new Set([
    'apps/mobile/lib/notification-service-local.parity.test.ts',
    'apps/mobile/tests/use-root-layout-notification-open-handler.parity.test.tsx',
    'packages/core/src/reminder-alarms-parity.fixtures.json',
    'packages/core/src/notification-open-parity.fixtures.json',
  ]);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '')).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_REMINDER_ALARMS=1 MINDWTR_CAPTURE_REMINDER_ALARMS_COMMIT=$(git rev-parse HEAD) TZ=UTC bunx vitest run lib/notification-service-local.parity.test.ts',
    capturedAt: head,
    sourceState: 'Every file under apps/ and packages/ was at HEAD except the reminder alarm and notification open parity harnesses and their fixtures.',
    rendering: 'lib/notification-service-local.ts run for real under fake timers (Date, setTimeout) with TZ=UTC. The store, the system language and the alarm library are replaced: parseDate is toISOString, scheduleAlarm answers from the cycle\'s `answers` and then with ids counting up from 100, getScheduledAlarms answers []. Stored language and translations are core\'s real English. Android starts with notification permission granted; iOS grants through requestPermissions. Each cycle is one startLocalMobileNotifications call (the first starts the service, later ones run a cycle while running) or, for trigger `exact`, one rescheduleLocalAlarmsAsExact call. `calls` records, in order, every alarm library call, AsyncStorage write, setTimeout delay and log line (message and extra).',
  };
}

describe('React Native reminder alarm parity fixture', () => {
  const originalTz = process.env.TZ;
  let timeoutSpy: ReturnType<typeof vi.spyOn> | null = null;
  beforeAll(() => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const fakeSetTimeout = globalThis.setTimeout;
    timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      harness.log.push(['setTimeout', delay ?? 0]);
      return fakeSetTimeout(callback, delay);
    }) as typeof setTimeout);
  });
  afterAll(() => {
    timeoutSpy?.mockRestore();
    __localNotificationTestUtils.resetForTests();
    vi.useRealTimers();
    harness.platform.OS = 'android';
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    const inputs = normalize({ timeZone: 'UTC', scenarios }) as Record<string, unknown>;
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs, observations: captured }, null, 1)}\n`);
    }
    const { observations, provenance: _provenance, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);
});
