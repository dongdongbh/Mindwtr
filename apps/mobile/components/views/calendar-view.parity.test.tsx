/**
 * React Native's Calendar screen, replayed against the calendar views parity
 * fixture (packages/core/src/calendar-views-parity.fixtures.json).
 * MINDWTR_CAPTURE_CALENDAR_VIEWS=1 rewrites it.
 *
 * Each scenario renders the real screen with the real core store, presses,
 * swipes, drags and types, and records what a user sees (the visible text in
 * screen order, the text inputs, a hash of every drawn color and position),
 * what the store is asked to write, the toasts, the alerts and the ranges the
 * screen asks the external calendar for. The task editor is a stand-in that
 * records its props: it is another screen's component.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  configureDateFormatting,
  flushPendingSave,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Area,
  type ExternalCalendarEvent,
  type ExternalCalendarSubscription,
  type Project,
  type Task,
} from '@mindwtr/core';

import { styles } from './calendar/calendar-view.styles';
import { CalendarView } from './calendar-view';

const FIXTURE_PATH = new URL('../../../../packages/core/src/calendar-views-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_CALENDAR_VIEWS === '1';
const TIME_ZONE = 'America/New_York';
/** Wednesday 2026-10-28, 10:00 in New York (EDT). The week of Sunday Nov 1 leaves daylight time. */
const NOW = '2026-10-28T14:00:00.000Z';
const DEVICE_LOCALE = 'en-US';
const CALENDAR_ERROR = 'Calendar feed unreachable';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  alerts: [] as { title: string; message?: string; buttons: { text: string; style?: string; onPress?: () => unknown }[] }[],
  toasts: [] as { tone?: string; title?: string; message?: string; durationMs?: number }[],
  fetches: [] as [string, string][],
  opened: [] as string[],
  feed: { calendars: [] as unknown[], events: [] as unknown[] },
  /** How each fetch answers, in order; the last one repeats. */
  fetchPlan: ['ready'] as ('ready' | 'loading' | 'error' | 'none')[],
  appStateListener: null as ((state: AppStateStatus) => void) | null,
}));

vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => undefined }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: async () => undefined }));
vi.mock('react-native-gesture-handler', () => {
  // A builder that keeps its callbacks, so the harness can play a gesture.
  const gesture = (kind: string) => {
    const handlers: Record<string, unknown> = { kind };
    const builder: any = new Proxy(handlers, {
      get: (target, prop) => {
        if (prop in target) return target[prop as string];
        return (callback: unknown) => {
          if (typeof callback === 'function') target[prop as string] = callback;
          return builder;
        };
      },
    });
    return builder;
  };
  return {
    Gesture: { Pan: () => gesture('pan'), Tap: () => gesture('tap'), Race: (...items: unknown[]) => ({ race: items }) },
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
    ScrollView: (props: any) => React.createElement('GestureScrollView', props, props.children),
  };
});
vi.mock('react-native-reanimated', () => ({
  default: {
    View: (props: any) => React.createElement('AnimatedView', props, props.children),
    createAnimatedComponent: (component: unknown) => (props: any) => React.createElement(String((component as any).displayName ?? 'AnimatedComponent'), props, props.children),
  },
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedScrollHandler: () => () => {},
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: unknown) => ({ value }),
  withSequence: (value: unknown) => value,
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));
vi.mock('@/lib/external-calendar', () => ({
  canOpenExternalCalendarEvent: (event: { nativeEventId?: string }) => Boolean(event.nativeEventId),
  fetchExternalCalendarEvents: (rangeStart: Date, rangeEnd: Date) => {
    harness.fetches.push([rangeStart.toISOString(), rangeEnd.toISOString()]);
    const answer = harness.fetchPlan.length > 1 ? harness.fetchPlan.shift()! : harness.fetchPlan[0];
    if (answer === 'loading') return new Promise(() => undefined);
    if (answer === 'error') return Promise.reject(new Error(CALENDAR_ERROR));
    if (answer === 'none') return Promise.resolve({ calendars: [], events: [] });
    return Promise.resolve(JSON.parse(JSON.stringify(harness.feed)));
  },
  openExternalCalendarEvent: async (event: { id: string }) => {
    harness.opened.push(event.id);
    return false;
  },
}));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(async () => null), logInfo: vi.fn(async () => null), logWarn: vi.fn(async () => null) }));
vi.mock('@/contexts/theme-context', () => ({ useTheme: () => ({ isDark: false, themePreset: 'default' }) }));
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: (toast: (typeof harness.toasts)[number]) => { harness.toasts.push(toast); }, dismissToast: vi.fn() }),
}));
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => harness.strings[key] ?? key }),
}));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#f1f5f9', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => true }));
vi.mock('@/lib/use-android-keyboard-inset', () => ({ useAndroidKeyboardInset: () => 0 }));
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('@/components/task-edit-modal', () => ({ TaskEditModal: (props: any) => React.createElement('TaskEditModal', props) }));
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Alert: {
      alert: (title: string, message: string | undefined, buttons: (typeof harness.alerts)[number]['buttons']) => {
        harness.alerts.push({ title, message, buttons: buttons ?? [] });
      },
    },
    FlatList: ({ data = [], renderItem, keyExtractor, ListEmptyComponent, ListFooterComponent, ...props }: any) => React.createElement(
      'FlatList',
      props,
      data.length > 0
        ? data.map((item: any, index: number) => (
          <React.Fragment key={keyExtractor?.(item, index) ?? index}>{renderItem?.({ item, index })}</React.Fragment>
        ))
        : ListEmptyComponent,
      ListFooterComponent ?? null,
    ),
  };
});

// ---------------------------------------------------------------------------
// The data set.

const at = (iso: string) => `${iso}.000Z`;
const CREATED = at('2026-10-01T12:00:00');
const task = (id: string, title: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id, title, status, contexts: [], tags: [], createdAt: CREATED, updatedAt: CREATED, ...extra,
});

const areas: Area[] = [
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: CREATED, updatedAt: CREATED },
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: CREATED, updatedAt: CREATED },
];

const project = (id: string, title: string, extra: Partial<Project> = {}): Project => ({
  id, title, status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: CREATED, updatedAt: CREATED, ...extra,
});
const projects: Project[] = [
  project('p-launch', 'Launch', { areaId: 'a-work' }),
  project('p-move', 'Move house', { areaId: 'a-home', isSequential: true, order: 1 }),
  project('p-parked', 'Parked plan', { status: 'someday', order: 2 }),
  project('p-shipped', 'Shipped', { status: 'archived', order: 3 }),
];

const tasks: Task[] = [
  // Wednesday Oct 28: timed blocks (two overlap), one past midnight, an all-day start, a deadline.
  task('t-standup', 'Standup prep', 'next', { startTime: at('2026-10-28T13:00:00'), timeEstimate: '30min', areaId: 'a-work' }),
  task('t-deep', 'Deep work', 'next', { startTime: at('2026-10-28T17:00:00'), timeEstimate: '2hr', projectId: 'p-launch' }),
  task('t-review', 'Review PR', 'next', { startTime: at('2026-10-28T17:30:00'), timeEstimate: '1hr', projectId: 'p-launch' }),
  task('t-deploy', 'Night deploy', 'next', { startTime: at('2026-10-29T03:30:00'), timeEstimate: '2hr' }),
  task('t-plan', 'Plan week', 'next', { startTime: '2026-10-28' }),
  task('t-rent', 'Pay rent', 'next', { dueDate: '2026-10-28', priority: 'high', areaId: 'a-home' }),
  task('t-trashed', 'Trashed thing', 'next', { dueDate: '2026-10-28', deletedAt: at('2026-10-20T12:00:00') }),
  task('t-parked', 'Parked step', 'next', { dueDate: '2026-10-28', projectId: 'p-parked' }),
  // Thursday Oct 29: a timed deadline, a task scheduled and due that day, other statuses.
  task('t-report', 'Submit report', 'next', { dueDate: at('2026-10-29T19:00:00'), projectId: 'p-launch' }),
  task('t-form', 'Dentist form', 'next', { startTime: at('2026-10-29T14:00:00'), dueDate: '2026-10-29' }),
  task('w-vendor', 'Hear back from vendor', 'waiting', { dueDate: '2026-10-29' }),
  task('s-trip', 'Trip ideas', 'someday', { dueDate: '2026-10-29' }),
  task('i-idea', 'Inbox idea', 'inbox', { startTime: '2026-10-29' }),
  task('t-sink', 'Fix sink', 'next', { dueDate: '2026-10-29', areaId: 'a-home' }),
  // Friday Oct 30: six items, so the month cell shows none and the counts.
  ...['Call bank', 'Renew visa', 'Order parts', 'Send invoice'].map((title, index) => (
    task(`t-busy-${index}`, title, 'next', { dueDate: '2026-10-30' })
  )),
  task('t-busy-timed', 'Gym', 'next', { startTime: at('2026-10-30T22:00:00'), timeEstimate: '1hr' }),
  // A weekly series that shows its future occurrences.
  task('t-water', 'Water plants', 'next', { dueDate: '2026-10-24', recurrence: 'weekly', showFutureRecurrence: true }),
  // Across the month, the daylight-saving change and the year.
  task('t-q3', 'Close Q3', 'next', { dueDate: '2026-09-30' }),
  task('t-sunday', 'Clocks back brunch', 'next', { startTime: at('2026-11-01T13:00:00'), timeEstimate: '1hr' }),
  task('t-run', 'Morning run', 'next', { startTime: at('2026-11-02T14:00:00'), timeEstimate: '1hr' }),
  task('t-flights', 'Book flights', 'next', { dueDate: '2026-11-02' }),
  task('t-nye', 'New Year prep', 'next', { dueDate: '2026-12-31' }),
  task('t-resolutions', 'Resolutions', 'next', { startTime: at('2027-01-01T15:00:00'), timeEstimate: '15min' }),
  // Unscheduled next actions for the planning list and the search.
  task('n-email', 'Answer email', 'next', { priority: 'low' }),
  task('n-plumber', 'Call plumber', 'next', { timeEstimate: '15min', areaId: 'a-home' }),
  task('n-chapter', 'Write chapter', 'next', { timeEstimate: '3hr', projectId: 'p-launch' }),
  task('n-pack', 'Pack boxes', 'next', { projectId: 'p-move', order: 0 }),
  task('n-van', 'Book van', 'next', { projectId: 'p-move', order: 1 }),
  task('n-focus', 'Focused thing', 'next', { isFocusedToday: true }),
  task('n-bills', 'Sort bills', 'next', { areaId: 'a-home' }),
  task('n-photos', 'Back up photos', 'next', {}),
  task('n-mentor', 'Email mentor', 'next', { areaId: 'a-work' }),
  // Finished work for the completed look-back.
  task('d-done', 'Filed taxes', 'done', { completedAt: at('2026-10-27T20:00:00'), updatedAt: at('2026-10-27T20:00:00'), dueDate: '2026-10-27' }),
  task('d-shipped', 'Shipped v1', 'archived', { projectId: 'p-shipped', completedAt: at('2026-10-26T15:00:00'), updatedAt: at('2026-10-26T15:00:00') }),
  task('d-home', 'Painted fence', 'done', { areaId: 'a-home', completedAt: at('2026-10-27T15:00:00'), updatedAt: at('2026-10-27T15:00:00') }),
  task('r-manual', 'Manual', 'reference', { dueDate: '2026-10-28' }),
  // A whole booked day, for "no free time".
  task('t-booked', 'Conference', 'next', { startTime: at('2026-10-28T14:00:00'), timeEstimate: 'custom:780' }),
];

const calendars: ExternalCalendarSubscription[] = [
  { id: 'ics-work', name: 'Work calendar', url: 'https://example.com/work.ics', enabled: true, feedColor: '#ff8800' },
  { id: 'system:personal', name: 'Personal', url: '', enabled: true, color: '#aa00ff' },
];

const calendarEvents: ExternalCalendarEvent[] = [
  { id: 'e-sync', sourceId: 'ics-work', title: 'Team sync', start: at('2026-10-28T13:15:00'), end: at('2026-10-28T14:00:00'), allDay: false, location: 'Room 4' },
  { id: 'e-lunch', sourceId: 'system:personal', nativeEventId: 'native-1', title: 'Lunch', start: at('2026-10-28T16:00:00'), end: at('2026-10-28T17:00:00'), allDay: false, description: 'With Sam' },
  { id: 'e-holiday', sourceId: 'ics-work', title: 'Office closed', start: at('2026-10-29T04:00:00'), end: at('2026-10-30T04:00:00'), allDay: true },
  { id: 'e-untitled', sourceId: 'ics-uncolored', title: '', start: at('2026-10-29T20:00:00'), end: at('2026-10-29T21:00:00'), allDay: false },
  { id: 'e-retreat', sourceId: 'system:personal', nativeEventId: 'native-2', title: 'Weekend retreat', start: at('2026-10-31T04:00:00'), end: at('2026-11-02T05:00:00'), allDay: true },
  { id: 'e-flight', sourceId: 'ics-work', title: 'Red-eye flight', start: at('2026-10-30T02:00:00'), end: at('2026-10-30T13:00:00'), allDay: false },
];

const settingsVariants: Record<string, AppSettings> = {
  month: { weekStart: 'sunday' },
  week: { weekStart: 'sunday', calendar: { viewMode: 'week' } },
  weekMonday: { weekStart: 'monday', calendar: { viewMode: 'week', weekVisibleDays: 7 } },
  day: { weekStart: 'sunday', calendar: { viewMode: 'day' } },
  schedule: { weekStart: 'sunday', calendar: { viewMode: 'schedule' } },
  completed: { weekStart: 'sunday', calendar: { showCompleted: true } },
  workArea: { weekStart: 'sunday', filters: { areaIds: ['a-work'] }, calendar: { showCompleted: true } },
  clock24: { weekStart: 'sunday', dateFormat: 'dmy', timeFormat: '24h', calendar: { viewMode: 'day' } },
  plain: { weekStart: 'sunday', features: { timeEstimates: false, priorities: false }, calendar: { viewMode: 'day' } },
};

type Scenario = {
  name: string;
  settings: string;
  /** Only these tasks (default: all but t-booked). */
  taskIds?: string[];
  /** How the external calendar answers each fetch, in order (default: always ready). */
  calendar?: ('ready' | 'loading' | 'error' | 'none')[];
  actions: [string, ...unknown[]][];
  extraTasks?: Task[];
  settingsOverride?: AppSettings;
};

const scenarios: Scenario[] = [
  {
    name: 'month: grid and navigation across the year',
    settings: 'month',
    actions: [['press', 'Next month'], ['press', 'Next month'], ['press', 'Next month'], ['press', 'Previous month'], ['press', 'Today']],
  },
  {
    name: 'month: a day and its details',
    settings: 'month',
    actions: [['day', '2026-10-28'], ['day', '2026-10-29'], ['day', '2026-10-30'], ['day', '2026-10-31'], ['closeDetails']],
  },
  { name: 'month: swipes', settings: 'month', actions: [['swipe', 'month', -120], ['swipe', 'month', 10], ['swipe', 'month', 90], ['swipe', 'month', 90]] },
  {
    name: 'month: task actions',
    settings: 'month',
    actions: [
      ['day', '2026-10-28'], ['press', 'Plan week'], ['alert', 'Remove from calendar'],
      ['press', 'Pay rent'], ['alert', 'Done'],
      ['press', 'Standup prep'], ['alert', 'Delete'],
      ['press', 'Deep work'], ['alert', 'Edit'], ['closeEditor'],
      ['press', 'Review PR'], ['alert', 'Cancel'],
      ['day', '2026-10-29'], ['doneButton', 'Dentist form'], ['doneButton', 'Hear back from vendor'],
    ],
  },
  {
    name: 'month: search and schedule from the details',
    settings: 'month',
    actions: [['day', '2026-10-29'], ['type', 'Search tasks to schedule...', 'CALL'], ['press', 'Call plumber'], ['press', 'Save']],
  },
  {
    name: 'month: add a task on a day',
    settings: 'month',
    actions: [
      ['day', '2026-10-29'], ['press', 'Add new task...'], ['press', 'Save'],
      ['type', 'Add new task...', 'Lunch /due:someday'], ['press', 'Save'],
      ['type', 'Add new task...', 'Lunch with Sam @phone +Launch /due:2026-10-30'],
      ['type', 'Start', '25:00'], ['press', 'Save'],
      ['type', 'Start', '2:30 PM'], ['type', 'End', '3:45 pm'], ['press', '15m'], ['press', 'Save'],
    ],
  },
  {
    name: 'month: add a task to a new project and an existing task',
    settings: 'month',
    actions: [
      ['day', '2026-10-31'], ['press', 'Add new task...'], ['type', 'Add new task...', 'Pick paint +Kitchen'], ['press', 'Save'],
      ['mode', 'Month'], ['day', '2026-10-31'], ['press', 'Add new task...'], ['press', 'Existing task'], ['press', 'Save'],
      ['type', 'Search tasks to schedule...', 'plan'], ['press', 'Plan week'], ['press', '1h'], ['press', 'Save'],
    ],
  },
  {
    name: 'month: external events',
    settings: 'month',
    actions: [
      ['day', '2026-10-28'], ['press', 'Lunch (Personal)'], ['alert', 'Open in calendar'],
      ['press', 'Team sync (Work calendar)'], ['alert', 'Create task'],
      ['day', '2026-10-29'], ['press', 'Office closed (Work calendar)'], ['alert', 'Create task'],
      ['day', '2026-10-29'], ['untitledEvent'], ['alert', 'Cancel'],
    ],
  },
  { name: 'month: completed look-back', settings: 'completed', actions: [['day', '2026-10-27'], ['day', '2026-10-26'], ['toggleCompleted']] },
  { name: 'month: the Work area filter', settings: 'workArea', actions: [['day', '2026-10-27'], ['day', '2026-10-28']] },
  { name: 'month: calendar loading', settings: 'month', calendar: ['ready', 'loading'], actions: [['day', '2026-10-31'], ['press', 'Next month'], ['day', '2026-11-01']] },
  { name: 'month: calendar error', settings: 'month', calendar: ['ready', 'error'], actions: [['day', '2026-10-28'], ['press', 'Next month'], ['day', '2026-11-01']] },
  { name: 'month: no calendars', settings: 'month', calendar: ['none'], actions: [['day', '2026-10-28'], ['day', '2026-10-24']] },
  {
    name: 'week: daylight saving week and navigation',
    settings: 'week',
    actions: [['press', 'Next week'], ['press', 'Next week'], ['press', 'Previous week'], ['press', 'Today']],
  },
  {
    name: 'week: density, column, header and item taps',
    settings: 'week',
    actions: [
      ['press', 'Show 7 visible days'], ['press', 'Show 2 visible days'],
      ['weekColumn', 4], ['press', 'Cancel'],
      ['press', 'Plan week'], ['alert', 'Cancel'],
      ['press', 'Lunch'], ['alert', 'Cancel'],
      ['press', 'Water plants · Projected · Oct 31'],
      ['weekHeader', 2],
    ],
  },
  { name: 'week: Monday start, seven days', settings: 'weekMonday', actions: [['press', 'Next week']] },
  {
    name: 'day: timeline, all-day items and navigation',
    settings: 'day',
    actions: [
      ['press', 'Next day'], ['swipe', 'day', -100], ['swipe', 'day', -100],
      ['press', 'Water plants · Projected · Oct 31'], ['alert', 'OK'],
      ['press', 'Previous day'], ['swipe', 'day', 100], ['press', 'Today'],
    ],
  },
  // #1462: the all-day card shows four chips and "+N more", which expands it in place.
  { name: 'day: all-day overflow expands and folds', settings: 'day', actions: [['press', 'Next day'], ['press', '+1 more'], ['press', 'Less']] },
  {
    name: 'day: across the year',
    settings: 'month',
    actions: [['press', 'Next month'], ['press', 'Next month'], ['day', '2026-12-31'], ['mode', 'Day'], ['press', 'Next day'], ['mode', 'Month']],
  },
  {
    name: 'day: timeline tap, drag and blocks',
    settings: 'day',
    actions: [
      ['timeline', 420], ['type', 'Add new task...', 'Early call'], ['press', 'Save'],
      ['drag', 'Standup prep', 140], ['drag', 'Standup prep', 300],
      ['tapBlock', 'Review PR'], ['alert', 'Done'],
      ['press', 'Pay rent'], ['alert', 'Cancel'],
    ],
  },
  {
    name: 'day: search and schedule',
    settings: 'day',
    actions: [['type', 'Search tasks to schedule...', 'chapter'], ['press', 'Write chapter'], ['press', 'New task'], ['type', 'Add new task...', 'Chapter draft'], ['press', 'Save']],
  },
  { name: 'day: day-first dates and a 24-hour clock', settings: 'clock24', actions: [['press', 'Next day'], ['mode', 'Week'], ['mode', 'Schedule']] },
  { name: 'day: time estimates off', settings: 'plain', actions: [['timeline', 700], ['press', '2h'], ['press', 'Cancel'], ['mode', 'Schedule']] },
  {
    name: 'schedule: sections, planning and scheduling',
    settings: 'schedule',
    actions: [['press', 'Close Q3'], ['press', 'Save'], ['mode', 'Schedule'], ['press', 'Today'], ['press', 'Water plants']],
  },
  { name: 'schedule: nothing scheduled', settings: 'schedule', taskIds: ['r-manual', 'd-done'], calendar: ['none'], actions: [['mode', 'Month']] },
  { name: 'schedule: only planning', settings: 'schedule', taskIds: ['n-email', 'n-plumber'], calendar: ['none'], actions: [] },
  { name: 'schedule: no free time', settings: 'schedule', taskIds: ['t-booked', 'n-email'], calendar: ['none'], actions: [['press', 'Answer email']] },
  {
    name: 'modes: every mode and the completed toggle',
    settings: 'month',
    actions: [['mode', 'Day'], ['mode', 'Week'], ['mode', 'Schedule'], ['mode', 'Month'], ['toggleCompleted'], ['toggleCompleted']],
  },
];

// ---------------------------------------------------------------------------
// Seeding the store and recording the writes.

const writeLog: unknown[][] = [];
const createdIds = new Map<string, string>();
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match) => createdIds.get(match) ?? match));

const RECORDED = ['updateTask', 'deleteTask', 'addTask', 'addProject', 'updateSettings'] as const;
let realActions: Record<string, (...args: any[]) => Promise<any>> | null = null;

const scenarioTasks = (scenario: Scenario) => (
  scenario.taskIds ? tasks.filter((entry) => scenario.taskIds!.includes(entry.id)) : tasks.filter((entry) => entry.id !== 't-booked')
);

async function seedStore(settings: AppSettings, seededTasks: Task[]) {
  await flushPendingSave();
  resetForTests();
  const initial = useTaskStore.getState() as unknown as Record<string, (...args: any[]) => Promise<any>>;
  realActions ??= Object.fromEntries(RECORDED.map((name) => [name, initial[name]]));
  const real = realActions;
  let data = JSON.parse(JSON.stringify({ tasks: seededTasks, projects, sections: [], areas, people: [], settings }));
  setStorageAdapter({
    getData: async () => data,
    saveData: async (next) => { data = JSON.parse(JSON.stringify(next)); },
  });
  useTaskStore.setState({
    ...(real as object),
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    highlightTaskId: null,
  } as never);
  await useTaskStore.getState().fetchData({ throwOnError: true });
  await flushPendingSave();
  useTaskStore.setState(Object.fromEntries(RECORDED.map((name) => [name, async (...args: unknown[]) => {
    writeLog.push([name, ...(normalize(args) as unknown[])]);
    const result = await real[name](...args);
    if (name === 'addTask' && result?.id) createdIds.set(result.id, `<created:${String(args[0])}>`);
    if (name === 'addProject' && result?.id) createdIds.set(result.id, `<created:${String(args[0])}>`);
    return result;
  }])) as never);
}

// ---------------------------------------------------------------------------
// Reading the rendered screen.

const deepText = (node: ReactTestInstance | string | number | null | undefined | boolean): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map((child) => deepText(child as ReactTestInstance | string)).join('');
};

/** Hidden modals render their children in the test shim; skip them, as a user would. */
function visibleNodes(root: ReactTestInstance): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Modal' && !node.props.visible) return;
    out.push(node);
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

/** The visible text, one entry per outermost Text, in screen order. */
function textsIn(root: ReactTestInstance): string[] {
  const out: string[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Modal' && !node.props.visible) return;
    if (String(node.type) === 'Text') {
      out.push(deepText(node));
      return;
    }
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

const hostsOf = (root: ReactTestInstance, type: string) => visibleNodes(root).filter((node) => node.type === type);
const flattenStyle = (style: unknown): Record<string, unknown> => (
  Array.isArray(style) ? Object.assign({}, ...style.map(flattenStyle)) : style && typeof style === 'object' ? style as Record<string, unknown> : {}
);
const firstStyle = (style: unknown): unknown => (Array.isArray(style) ? firstStyle(style[0]) : style);
const usesStyle = (style: unknown, target: unknown): boolean => (
  style === target || (Array.isArray(style) && style.some((entry) => usesStyle(entry, target)))
);
const hostsStyled = (root: ReactTestInstance, target: unknown) => (
  visibleNodes(root).filter((node) => typeof node.type === 'string' && usesStyle(node.props.style, target))
);
/** Where a box is drawn from: its top, moved by a margin or a vertical translate. */
const drawnTop = (style: unknown): number => {
  const flat = flattenStyle(style);
  const translateY = ((flat.transform ?? []) as { translateY?: number }[]).reduce((sum, step) => sum + (step.translateY ?? 0), 0);
  return Number(flat.top ?? 0) + Number(flat.marginTop ?? 0) + translateY;
};
/** Where a line centered in its box is drawn. */
const drawnCenter = (style: unknown): number => drawnTop(style) + Number(flattenStyle(style).height) / 2;
const edgePadding = (style: unknown, edge: 'Top' | 'Bottom'): number => {
  const flat = flattenStyle(style);
  return Number(flat[`padding${edge}`] ?? flat.paddingVertical ?? flat.padding ?? 0);
};

const STYLE_KEYS = [
  'backgroundColor', 'borderLeftColor', 'borderColor', 'borderStyle', 'opacity', 'color', 'textDecorationLine',
  'top', 'height', 'left', 'right', 'marginLeft', 'marginRight', 'width', 'paddingVertical', 'justifyContent',
];

/** Every drawn color, position and size, with the node it belongs to, hashed. */
function styleDigest(root: ReactTestInstance): string {
  const rows = visibleNodes(root)
    .filter((node) => typeof node.type === 'string' && node.props.style !== undefined)
    .map((node) => {
      const style = flattenStyle(node.props.style);
      const picked = Object.fromEntries(STYLE_KEYS.filter((key) => style[key] !== undefined).map((key) => [key, style[key]]));
      return [node.type, node.props.accessibilityLabel ?? null, node.props.disabled ?? null, node.props.numberOfLines ?? null, picked];
    });
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

function findPressable(root: ReactTestInstance, label: string): ReactTestInstance | undefined {
  const candidates = visibleNodes(root).filter((node) => typeof node.type === 'string' && typeof node.props?.onPress === 'function');
  return candidates.find((node) => node.props.accessibilityLabel === label)
    ?? candidates.find((node) => textsIn(node).join('') === label)
    ?? candidates.find((node) => textsIn(node)[0] === label);
}

type Observation = Record<string, unknown>;

function observe(root: ReactTestInstance, seen: { alerts: number; toasts: number; writes: number; fetches: number; opened: number }): Observation {
  const editor = hostsOf(root, 'TaskEditModal')[0]?.props;
  const observation: Observation = {
    texts: textsIn(root),
    inputs: hostsOf(root, 'TextInput').map((node) => [node.props.accessibilityLabel ?? node.props.placeholder ?? null, node.props.placeholder ?? null, node.props.value ?? null]),
    styles: styleDigest(root),
    editor: editor?.visible ? [editor.task?.id ?? null, editor.defaultTab] : null,
    writes: writeLog.slice(seen.writes),
    toasts: harness.toasts.slice(seen.toasts).map((toast) => [toast.tone ?? null, toast.title ?? null, toast.message ?? null, toast.durationMs ?? null]),
    alerts: harness.alerts.slice(seen.alerts).map((alert) => [alert.title, alert.message ?? null, alert.buttons.map((button) => [button.text, button.style ?? null])]),
    fetches: harness.fetches.slice(seen.fetches),
    opened: harness.opened.slice(seen.opened),
  };
  seen.alerts = harness.alerts.length;
  seen.toasts = harness.toasts.length;
  seen.writes = writeLog.length;
  seen.fetches = harness.fetches.length;
  seen.opened = harness.opened.length;
  return normalize(observation) as Observation;
}

const pressEvent = (extra: Record<string, unknown> = {}) => ({ stopPropagation: () => undefined, nativeEvent: extra });

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await flushPendingSave();
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
}

const dayLabel = (key: string) => {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(DEVICE_LOCALE, { weekday: 'long', month: 'long', day: 'numeric' });
};

async function perform(renderer: ReactTestRenderer, action: [string, ...unknown[]]) {
  const root = renderer.root;
  const [kind, target, ...rest] = action;
  const run = async (what: string, fn: (() => unknown) | undefined) => {
    if (!fn) throw new Error(`Nothing to do for ${what} in ${JSON.stringify(textsIn(root))}`);
    await act(async () => { await fn(); });
  };
  const detectorWith = (title: string) => hostsOf(root, 'GestureDetector').find((node) => textsIn(node)[0] === title);
  switch (kind) {
    case 'press':
    case 'mode': {
      const node = findPressable(root, String(target));
      // A disabled control does not answer a press.
      return run(`press ${String(target)}`, node && (() => (node.props.disabled ? undefined : node.props.onPress(pressEvent()))));
    }
    case 'day': {
      const label = dayLabel(String(target));
      const cell = visibleNodes(root).find((node) => String(node.type) === 'Pressable'
        && (node.props.accessibilityLabel === label || String(node.props.accessibilityLabel ?? '').startsWith(`${label}.`)));
      return run(`day ${String(target)}`, cell && (() => cell.props.onPress(pressEvent())));
    }
    case 'untitledEvent': {
      // An event without a title draws an empty title line above its time.
      const node = visibleNodes(root).find((entry) => String(entry.type) === 'Pressable' && typeof entry.props.onPress === 'function'
        && textsIn(entry)[0] === '' && textsIn(entry).length > 1);
      return run('untitled event', node && (() => node.props.onPress(pressEvent())));
    }
    case 'doneButton': {
      const row = visibleNodes(root).find((node) => typeof node.type === 'string' && textsIn(node)[0] === target
        && hostsOf(node, 'Pressable').some((child) => textsIn(child).join('') === harness.strings['status.done']));
      const button = row && hostsOf(row, 'Pressable').find((child) => textsIn(child).join('') === harness.strings['status.done']);
      return run(`done ${String(target)}`, button && (() => button.props.onPress(pressEvent())));
    }
    case 'swipe': {
      const area = visibleNodes(root).find((node) => String(node.type) === 'View' && typeof node.props.onResponderRelease === 'function');
      return run(`swipe ${String(target)}`, area && (() => area.props.onResponderRelease({}, { dx: Number(rest[0]), dy: 0, vx: 0 })));
    }
    case 'closeDetails': {
      const detector = hostsOf(root, 'GestureDetector').find((node) => visibleNodes(node).some((child) => child.props.accessibilityLabel === harness.strings['calendar.mobile.dayDetailsPanelHandle']));
      return run('close details', detector && (() => detector.props.gesture.onEnd({ velocityY: 1000 })));
    }
    case 'alert': {
      const button = harness.alerts.at(-1)?.buttons.find((entry) => entry.text === target);
      return run(`alert ${String(target)}`, button ? button.onPress ?? (() => undefined) : undefined);
    }
    case 'type': {
      // An open composer takes the typing; the screen behind it shares a placeholder.
      const modal = hostsOf(root, 'Modal').find((node) => node.props.visible);
      const matches = (node: ReactTestInstance) => node.props.accessibilityLabel === target || node.props.placeholder === target;
      const input = (modal ? hostsOf(modal, 'TextInput').find(matches) : undefined) ?? hostsOf(root, 'TextInput').find(matches);
      return run(`type ${String(target)}`, input && (() => input.props.onChangeText(rest[0])));
    }
    case 'timeline': {
      const tap = visibleNodes(root).find((node) => String(node.type) === 'Pressable' && node.props.style === styles.timelineTapTarget);
      return run('timeline', tap && (() => tap.props.onPress(pressEvent({ locationY: target }))));
    }
    case 'weekColumn':
    case 'weekHeader': {
      const style = kind === 'weekColumn' ? styles.weekDayColumn : styles.weekDayHeader;
      const nodes = visibleNodes(root).filter((node) => String(node.type) === 'Pressable' && firstStyle(node.props.style) === style);
      const node = nodes[Number(target)];
      return run(kind, node && (() => node.props.onPress(pressEvent())));
    }
    case 'drag': {
      const detector = detectorWith(String(target));
      const pan = detector?.props.gesture.race?.[0];
      return run(`drag ${String(target)}`, pan && (() => pan.onEnd({ translationY: rest[0] })));
    }
    case 'tapBlock': {
      const detector = detectorWith(String(target));
      const tap = detector?.props.gesture.race?.[1];
      return run(`tap ${String(target)}`, tap && (() => tap.onEnd()));
    }
    case 'toggleCompleted': {
      const node = findPressable(root, harness.strings['calendar.showCompletedHint']);
      return run('toggle completed', node && (() => node.props.onPress(pressEvent())));
    }
    case 'closeEditor': {
      const editor = hostsOf(root, 'TaskEditModal')[0];
      return run('close editor', editor?.props.onClose);
    }
    case 'appState':
      return run(`app state ${String(target)}`, harness.appStateListener ? () => harness.appStateListener!(target as AppStateStatus) : undefined);
    default:
      throw new Error(`Unknown action ${kind}`);
  }
}

async function runScenario(scenario: Scenario, inspect?: (root: ReactTestInstance) => void) {
  writeLog.length = 0;
  createdIds.clear();
  harness.alerts.length = 0;
  harness.toasts.length = 0;
  harness.fetches.length = 0;
  harness.opened.length = 0;
  harness.fetchPlan = [...(scenario.calendar ?? ['ready'])];
  const settings = scenario.settingsOverride ?? settingsVariants[scenario.settings];
  configureDateFormatting({
    language: 'en', dateFormat: settings.dateFormat, timeFormat: settings.timeFormat, calendarSystem: settings.calendarSystem, systemLocale: DEVICE_LOCALE,
  });
  await seedStore(settings, [...scenarioTasks(scenario), ...(scenario.extraTasks ?? [])]);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<CalendarView />); });
  await settle();
  const seen = { alerts: 0, toasts: 0, writes: 0, fetches: 0, opened: 0 };
  const observations = [observe(renderer.root, seen)];
  for (const action of scenario.actions) {
    await perform(renderer, action);
    await settle();
    observations.push(observe(renderer.root, seen));
  }
  inspect?.(renderer.root);
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}

const inputs = () => normalize({
  timeZone: TIME_ZONE, now: NOW, deviceLocale: DEVICE_LOCALE, calendarError: `Error: ${CALENDAR_ERROR}`,
  tasks, projects, areas, calendars, calendarEvents, settings: settingsVariants, scenarios,
}) as Record<string, unknown>;

describe('React Native Calendar screen parity fixture', () => {
  const originalTz = process.env.TZ;
  const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  beforeAll(async () => {
    process.env.TZ = TIME_ZONE;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    // The device locale the screen reads.
    Intl.DateTimeFormat.prototype.resolvedOptions = function resolved(this: Intl.DateTimeFormat) {
      return { ...resolvedOptions.call(this), locale: DEVICE_LOCALE };
    };
    harness.strings = await loadTranslations('en');
    harness.feed = { calendars, events: calendarEvents };
  });
  afterAll(() => {
    Intl.DateTimeFormat.prototype.resolvedOptions = resolvedOptions;
    vi.useRealTimers();
    configureDateFormatting();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('shows a first-load calendar error and clears prior-range events while loading', async () => {
    const failed = await runScenario({ name: 'first load failure', settings: 'month', calendar: ['error'], actions: [['day', '2026-10-28']] });
    expect((failed[1].texts as string[]).some((text) => text.includes(CALENDAR_ERROR))).toBe(true);
    const loading = await runScenario({ name: 'new range loading', settings: 'month', calendar: ['ready', 'loading'], actions: [['day', '2026-10-28'], ['press', 'Next month'], ['day', '2026-11-01']] });
    expect((loading.at(-1)!.texts as string[])).not.toContain('Team sync (Work calendar)');
  });

  it('keeps current-range events visible during a refresh', async () => {
    const listener = vi.spyOn(AppState, 'addEventListener').mockImplementation((_type, callback) => {
      harness.appStateListener = callback;
      return { remove: () => { harness.appStateListener = null; } };
    });
    try {
      const observed = await runScenario({ name: 'same range refresh', settings: 'month', calendar: ['ready', 'loading'], actions: [['day', '2026-10-31'], ['appState', 'background'], ['appState', 'active']] });
      expect((observed.at(-1)!.texts as string[])).toContain('Weekend retreat (Personal)');
    } finally {
      listener.mockRestore();
    }
  });

  it('opens a timeline tap at the wall-clock hour on the fall DST day', async () => {
    const observed = await runScenario({ name: 'DST tap', settings: 'month', actions: [['press', 'Next month'], ['day', '2026-11-01'], ['mode', 'Day'], ['timeline', 8 * 60 * 1.4]] });
    expect((observed.at(-1)!.inputs as string[][]).some(([label, , value]) => label === 'Start' && value === '8:00 AM')).toBe(true);
  });

  it('does not expose completed items as buttons', async () => {
    await runScenario({ name: 'completed accessibility', settings: 'completed', actions: [['mode', 'Week']] }, (root) => {
      const row = findPressable(root, 'Filed taxes');
      expect(row?.props.disabled).toBe(true);
      expect(row?.props.accessibilityRole).not.toBe('button');
    });
    await runScenario({ name: 'completed day accessibility', settings: 'completed', actions: [['mode', 'Day'], ['press', 'Previous day']] }, (root) => {
      const row = findPressable(root, 'Filed taxes');
      expect(row?.props.disabled).toBe(true);
      expect(row?.props.accessibilityRole).not.toBe('button');
    });
  });

  it('renders same-day timed deadlines separately and keeps midnight markers', async () => {
    const sameDay = task('timed-same', 'Timed same day', 'next', { startTime: at('2026-10-28T13:00:00'), dueDate: at('2026-10-28T19:00:00') });
    const midnight = task('timed-midnight', 'Midnight deadline', 'next', { dueDate: at('2026-10-28T04:00:00') });
    const nearby = task('timed-nearby', 'Nearby deadline', 'next', { dueDate: at('2026-10-28T19:05:00') });
    const end = task('timed-end', 'End of day', 'next', { dueDate: at('2026-10-29T03:59:00') });
    const extraTasks = [sameDay, midnight, nearby, end];
    for (const mode of ['day', 'week'] as const) {
      await runScenario({ name: 'timed markers', settings: mode, taskIds: [], extraTasks, actions: [] }, (root) => {
        const marker = root.findAll((node) => node.props.testID === 'calendar-deadline-timed-same')[0];
        expect(marker).toBeDefined();
        expect(deepText(marker)).toContain('3:00 PM · Due');
        expect(root.findAll((node) => String(node.type) === 'Text' && deepText(node) === 'Timed same day').length).toBeGreaterThanOrEqual(2);
        expect(root.findAll((node) => node.props.testID === 'calendar-deadline-timed-midnight').length).toBeGreaterThan(0);
        expect(root.findAll((node) => node.props.testID === 'calendar-deadline-timed-nearby').length).toBeGreaterThan(0);
        expect(root.findAll((node) => node.props.testID === 'calendar-deadline-timed-end').length).toBeGreaterThan(0);
        expect(writeLog).toEqual([]);
      });
    }
  });

  it('keeps timed projections read-only and excludes finished deadline markers', async () => {
    const recurring = task('timed-recurring', 'Recurring deadline', 'next', { dueDate: at('2026-10-21T19:00:00'), recurrence: 'weekly', showFutureRecurrence: true });
    const done = task('timed-done', 'Finished deadline', 'done', { dueDate: at('2026-10-28T19:00:00'), completedAt: NOW });
    const cancelled = task('timed-cancelled', 'Cancelled deadline', 'done', { dueDate: at('2026-10-28T19:00:00'), cancelledAt: NOW });
    await runScenario({ name: 'readonly timed recurrence', settings: 'day', taskIds: [], extraTasks: [recurring, done, cancelled], actions: [] }, (root) => {
      const projected = root.findAll((node) => String(node.props.testID ?? '').startsWith('calendar-deadline-timed-recurring'));
      expect(projected.length).toBeGreaterThan(0);
      expect(projected.every((node) => node.props.disabled)).toBe(true);
      expect(deepText(projected[0])).toContain('Projected');
      expect(root.findAll((node) => node.props.testID === 'calendar-deadline-timed-done')).toHaveLength(0);
      expect(root.findAll((node) => node.props.testID === 'calendar-deadline-timed-cancelled')).toHaveLength(0);
      expect(writeLog).toEqual([]);
    });
  });

  it('opens the task actions from a deadline marker without scheduling it', async () => {
    const due = task('marker-tap', 'Tap deadline', 'next', { dueDate: at('2026-10-28T19:00:00') });
    let press: ((event: { stopPropagation: () => void }) => void) | undefined;
    await runScenario({ name: 'tap marker', settings: 'day', taskIds: [], extraTasks: [due], actions: [] }, (root) => {
      press = root.findAll((node) => node.props.testID === 'calendar-deadline-marker-tap')[0]?.props.onPress;
      expect(press).toBeDefined();
      press!({ stopPropagation() {} });
      expect(harness.alerts.at(-1)?.title).toBe('Tap deadline');
      expect(writeLog).toEqual([]);
    });
  });

  it('shows a task due and scheduled on one day once in month details', async () => {
    const observations = await runScenario({ name: 'duplicate details', settings: 'month', actions: [['day', '2026-10-29']] });
    expect((observations[1].texts as string[]).filter((text) => text === 'Dentist form')).toHaveLength(1);
  });

  // PIXELS_PER_MINUTE is 1.4; NOW is 10:00 in New York.
  it('draws each Day hour line on its hour, with room for the first and last labels', async () => {
    await runScenario({ name: 'day hour lines', settings: 'day', actions: [] }, (root) => {
      const rows = hostsStyled(root, styles.hourLine);
      expect(rows).toHaveLength(25);
      rows.forEach((row, hour) => expect(drawnCenter(row.props.style)).toBeCloseTo(hour * 60 * 1.4));
      // A block at 9:00 starts on the 9 AM line.
      const standup = hostsStyled(root, styles.taskBlock).find((node) => textsIn(node)[0] === 'Standup prep')!;
      expect(drawnTop(standup.props.style)).toBeCloseTo(drawnCenter(rows[9].props.style));
      const card = hostsStyled(root, styles.timelineCard)[0];
      const gridHeight = Number(flattenStyle(hostsStyled(root, styles.timelineArea)[0].props.style).height);
      expect(drawnTop(rows[0].props.style)).toBeGreaterThanOrEqual(-edgePadding(card.props.style, 'Top'));
      const lastBottom = drawnTop(rows[24].props.style) + Number(flattenStyle(rows[24].props.style).height);
      expect(lastBottom).toBeLessThanOrEqual(gridHeight + edgePadding(card.props.style, 'Bottom'));
    });
  });

  it('draws the now line on the current minute in Day and Week', async () => {
    await runScenario({ name: 'day now line', settings: 'day', actions: [] }, (root) => {
      const [line] = hostsStyled(root, styles.nowLine);
      expect(drawnCenter(line.props.style)).toBeCloseTo(600 * 1.4);
    });
    await runScenario({ name: 'week now line', settings: 'week', actions: [] }, (root) => {
      const [line] = hostsStyled(root, styles.weekNowLine);
      expect(drawnCenter(line.props.style)).toBeCloseTo(600 * 1.4);
    });
  });

  it('shows the week timeline first hour label whole', async () => {
    await runScenario({ name: 'week first label', settings: 'week', actions: [] }, (root) => {
      const [first] = hostsStyled(root, styles.weekHourLabel);
      expect(textsIn(first)).toEqual(['12 AM']);
      const timeline = visibleNodes(root).find((node) => node.props.contentContainerStyle === styles.weekVerticalContent)!;
      expect(drawnTop(first.props.style)).toBeGreaterThanOrEqual(-edgePadding(timeline.props.contentContainerStyle, 'Top'));
    });
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    if (CAPTURE) {
      let previous: Record<string, unknown> = {};
      try {
        previous = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
      } catch {
        previous = {};
      }
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: previous.provenance ?? {}, ...inputs(), observations: captured }, null, 1)}\n`);
    }
    const { provenance: _provenance, observations, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozenInputs).toEqual(inputs());
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 300_000);
});
