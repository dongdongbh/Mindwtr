/**
 * React Native's Trash screen, replayed against the `trash` part of the list
 * views parity fixture that core's trash-view-model and the native host contract
 * are tested against. MINDWTR_CAPTURE_LIST_VIEWS=1 rewrites that part.
 *
 * Each scenario renders the real screen with the real core store, swipes, selects,
 * confirms and cancels, and records what a user sees and what the store is asked
 * to write. Dates render through the app's date formatter, configured per
 * scenario as the root layout does, with the device locale pinned to en-US.
 */
import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
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
  type Project,
  type Task,
} from '@mindwtr/core';

import TrashScreen from './trash';

const FIXTURE_PATH = new URL('../../../../packages/core/src/list-views-model-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_LIST_VIEWS === '1';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  alerts: [] as { title: string; message: string; buttons: { text: string; style?: string; onPress?: () => unknown }[] }[],
  toasts: [] as { tone?: string; title?: string; message?: string; actionLabel?: string }[],
  storage: new Map<string, string>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => harness.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { harness.storage.set(key, value); },
    removeItem: async (key: string) => { harness.storage.delete(key); },
  },
}));
vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => harness.strings[key] ?? key, language: 'en' }),
}));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: (toast: (typeof harness.toasts)[number]) => { harness.toasts.push(toast); }, dismissToast: vi.fn() }),
}));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('@/components/markdown-text', () => ({ MarkdownInlineText: (props: any) => React.createElement('MarkdownInlineText', props) }));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: (props: any) => React.createElement('GestureHandlerRootView', props, props.children),
  Swipeable: ({ children, renderLeftActions, renderRightActions }: any) => React.createElement(
    'Swipeable', null, renderLeftActions?.(), renderRightActions?.(), children,
  ),
}));
vi.mock('lucide-react-native', () => {
  const icons = new Map<string, unknown>();
  return new Proxy({ __esModule: true } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (!icons.has(prop)) icons.set(prop, (props: any) => React.createElement(`Icon:${prop}`, props));
      return icons.get(prop);
    },
    has: (target, prop) => prop in target || (typeof prop !== 'symbol' && prop !== 'then'),
  });
});
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Alert: {
      alert: (title: string, message: string, buttons: (typeof harness.alerts)[number]['buttons']) => {
        harness.alerts.push({ title, message, buttons });
      },
    },
    FlatList: ({ data = [], renderItem, keyExtractor, ListEmptyComponent, ...props }: any) => React.createElement(
      'FlatList',
      props,
      data.length > 0
        ? data.map((item: any, index: number) => (
          <React.Fragment key={keyExtractor?.(item, index) ?? index}>{renderItem?.({ item, index })}</React.Fragment>
        ))
        : ListEmptyComponent,
    ),
  };
});

export const TIME_ZONE = 'America/New_York';
export const NOW = '2026-09-23T14:00:00.000Z';
const at = (day: string, time = '12:00:00') => `2026-09-${day}T${time}.000Z`;
const task = (id: string, title: string, day: string, extra: Partial<Task> = {}): Task => ({
  id, title, status: 'next', contexts: [], tags: [], createdAt: at(day), updatedAt: at(day), ...extra,
});

const areas: Area[] = [
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: at('01'), updatedAt: at('01') },
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: at('01'), updatedAt: at('01') },
];
const projects: Project[] = [
  { id: 'tp-live', title: 'Live project', status: 'active', color: '#94a3b8', order: 0, tagIds: [], areaId: 'a-work', createdAt: at('01'), updatedAt: at('01') },
  { id: 'tp-gone', title: 'Old launch', status: 'active', color: '#2563eb', order: 1, tagIds: [], areaId: 'a-work', deletedAt: at('21'), createdAt: at('01'), updatedAt: at('21') },
  { id: 'tp-home', title: 'Garage', status: 'someday', color: '', order: 2, tagIds: [], areaId: 'a-home', deletedAt: at('18', '08:00:00'), createdAt: at('01'), updatedAt: at('18', '08:00:00') },
  { id: 'tp-purged', title: 'Purged project', status: 'active', color: '#94a3b8', order: 3, tagIds: [], deletedAt: at('10'), purgedAt: at('11'), createdAt: at('01'), updatedAt: at('11') },
];
const allTasks: Task[] = [
  task('tt-report', 'Draft report', '05', { deletedAt: at('22', '09:00:00'), updatedAt: at('22', '09:00:00'), description: '# Heading\nbody', contexts: ['@office'] }),
  task('tt-call', 'Call plumber', '06', { status: 'waiting', deletedAt: at('20'), updatedAt: at('20'), areaId: 'a-home' }),
  task('tt-proj', 'Launch checklist', '07', { deletedAt: at('21'), updatedAt: at('21'), projectId: 'tp-gone' }),
  task('tt-done', 'Finished and trashed', '07', { status: 'done', completedAt: at('15'), deletedAt: at('19'), updatedAt: at('19') }),
  task('tt-purged', 'Purged task', '08', { deletedAt: at('10'), purgedAt: at('11'), updatedAt: at('11') }),
  task('tt-live', 'Live task', '09', { projectId: 'tp-live' }),
];
const settingsVariants: Record<string, AppSettings> = {
  base: {},
  homeArea: { filters: { areaIds: ['a-home'] } },
  ymdDates: { dateFormat: 'ymd' },
};
const DEVICE_LOCALE = 'en-US';

type Action =
  | ['swipe', string, 'restore' | 'delete']
  | ['toggle', string]
  | ['press', string]
  | ['alert', string];
type Scenario = { name: string; settings: string; taskIds?: string[]; projectIds?: string[]; actions: Action[] };

export const scenarios: Scenario[] = [
  { name: 'timeline, summary and retention hint', settings: 'base', actions: [] },
  {
    name: 'restore rows',
    settings: 'base',
    actions: [['swipe', 'tt-call', 'restore'], ['swipe', 'tp-gone', 'restore'], ['swipe', 'tp-home', 'restore']],
  },
  {
    name: 'delete rows forever',
    settings: 'base',
    actions: [
      ['swipe', 'tt-report', 'delete'],
      ['alert', 'Cancel'],
      ['swipe', 'tt-report', 'delete'],
      ['alert', 'Delete Permanently'],
      ['swipe', 'tp-gone', 'delete'],
      ['alert', 'Delete Permanently'],
    ],
  },
  {
    name: 'bulk restore',
    settings: 'base',
    actions: [
      ['press', 'Select'],
      ['toggle', 'tt-report'],
      ['toggle', 'tp-gone'],
      ['toggle', 'tt-done'],
      ['toggle', 'tt-report'],
      ['press', 'Restore'],
    ],
  },
  {
    name: 'bulk delete forever',
    settings: 'base',
    actions: [
      ['press', 'Select'],
      ['press', 'Delete Permanently'],
      ['press', 'Select all'],
      ['press', 'Delete Permanently'],
      ['alert', 'Cancel'],
      ['press', 'Delete Permanently'],
      ['alert', 'Delete Permanently'],
    ],
  },
  {
    name: 'selection mode can be left',
    settings: 'base',
    actions: [['press', 'Select'], ['toggle', 'tt-call'], ['press', 'Done'], ['press', 'Select']],
  },
  {
    name: 'clear the whole trash',
    settings: 'base',
    actions: [['press', 'Clear Trash'], ['alert', 'Cancel'], ['press', 'Clear Trash'], ['alert', 'Clear Trash']],
  },
  {
    name: 'clear a trash the area filter narrows',
    settings: 'homeArea',
    actions: [['press', 'Clear Trash'], ['alert', 'Clear Trash']],
  },
  {
    name: 'only tasks in the trash',
    settings: 'base',
    projectIds: ['tp-live'],
    actions: [['press', 'Clear Trash'], ['alert', 'Clear Trash']],
  },
  { name: 'an empty trash', settings: 'base', taskIds: ['tt-live', 'tt-purged'], projectIds: ['tp-live', 'tp-purged'], actions: [] },
  { name: 'deleted dates follow the app date format', settings: 'ymdDates', actions: [] },
];

const writeLog: unknown[][] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));
const encodeArgs = (args: unknown[]) => normalize(args) as unknown[];

const RECORDED = ['restoreTask', 'restoreTasks', 'restoreProject', 'purgeTask', 'purgeTasks', 'purgeProject'] as const;
let realActions: Record<string, (...args: any[]) => Promise<unknown>> | null = null;

async function seedStore(settings: AppSettings, tasks: Task[], seededProjects: Project[]) {
  await flushPendingSave();
  resetForTests();
  const initial = useTaskStore.getState() as unknown as Record<string, (...args: any[]) => Promise<unknown>>;
  realActions ??= Object.fromEntries(RECORDED.map((name) => [name, initial[name]]));
  const real = realActions;
  const data = JSON.parse(JSON.stringify({ tasks, projects: seededProjects, sections: [], areas, people: [], settings }));
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  useTaskStore.setState({
    ...(real as object),
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    highlightTaskId: null,
  } as never);
  await useTaskStore.getState().fetchData({ throwOnError: true });
  await flushPendingSave();
  useTaskStore.setState(Object.fromEntries(RECORDED.map((name) => [name, async (...args: unknown[]) => {
    writeLog.push([name, ...encodeArgs(args)]);
    return real[name](...args);
  }])) as never);
}

const textOf = (node: ReactTestInstance): string[] => {
  const children = node.props?.children;
  const list = Array.isArray(children) ? children.flat(Infinity) : [children];
  return list.filter((child) => typeof child === 'string' || typeof child === 'number').map(String);
};
const textsIn = (node: ReactTestInstance): string[] => node.findAll((child) => String(child.type) === 'Text')
  .map((child) => textOf(child).join(''));
const hostsOf = (root: ReactTestInstance, type: string) => root.findAll((node) => String(node.type) === type);
const flatten = (style: unknown): Record<string, unknown> => (
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style && typeof style === 'object' ? style as Record<string, unknown> : {}
);
const titleOf = (id: string) => [...allTasks, ...projects].find((entry) => entry.id === id)!.title;

function describeRows(root: ReactTestInstance) {
  return hostsOf(root, 'Swipeable').map((row) => {
    const pressables = row.findAll((child) => String(child.type) === 'Pressable');
    const body = pressables[pressables.length - 1];
    const indicator = body.findAll((child) => String(child.type) === 'View').at(-1);
    return [
      textsIn(body),
      body.props.accessibilityLabel ?? null,
      body.props.accessibilityState ?? null,
      body.props.disabled === true,
      hostsOf(body, 'MarkdownInlineText')[0]?.props.markdown ?? null,
      flatten(indicator?.props.style).backgroundColor ?? null,
      pressables.length > 1 ? pressables.slice(0, -1).map((action) => textsIn(action).join('')) : null,
    ];
  });
}

function observe(root: ReactTestInstance, seen: { alerts: number; toasts: number; writes: number }) {
  const list = hostsOf(root, 'FlatList')[0];
  const rows = describeRows(root);
  const outside = root.findAll((node) => String(node.type) === 'Text' && !list.findAll((child) => child === node).length)
    .map((node) => textOf(node).join(''));
  const observation = {
    header: outside,
    buttons: hostsOf(root, 'Pressable').filter((node) => !list.findAll((child) => child === node).length)
      .map((node) => [node.props.accessibilityLabel ?? textsIn(node).join(''), node.props.disabled === true]),
    rows,
    empty: rows.length > 0 ? null : [list.findAll((node) => String(node.type).startsWith('Icon:')).map((node) => String(node.type))[0] ?? null, ...textsIn(list)],
    alerts: harness.alerts.slice(seen.alerts).map((alert) => [alert.title, alert.message, alert.buttons.map((button) => [button.text, button.style ?? null])]),
    toasts: harness.toasts.slice(seen.toasts).map((toast) => [toast.tone ?? null, toast.title ?? null, toast.message ?? null, toast.actionLabel ?? null]),
    writes: writeLog.slice(seen.writes),
    text: root.findAll((node) => String(node.type) === 'Text').map((node) => textOf(node).join('')),
  };
  seen.alerts = harness.alerts.length;
  seen.toasts = harness.toasts.length;
  seen.writes = writeLog.length;
  return observation;
}

async function perform(root: ReactTestInstance, action: Action) {
  const [kind] = action;
  const press = async (node: ReactTestInstance | undefined, what: string) => {
    if (!node) throw new Error(`Nothing to press for ${what}`);
    await act(async () => { await node.props.onPress(); });
  };
  const rowFor = (id: string) => hostsOf(root, 'Swipeable').find((row) => textsIn(row).includes(titleOf(id)));
  if (kind === 'swipe') {
    const row = rowFor(action[1]);
    const [restore, remove] = row ? row.findAll((child) => String(child.type) === 'Pressable') : [];
    await press(action[2] === 'restore' ? restore : remove, action[1]);
    return;
  }
  if (kind === 'toggle') {
    const row = rowFor(action[1]);
    await press(row?.findAll((child) => String(child.type) === 'Pressable').at(-1), action[1]);
    return;
  }
  if (kind === 'press') {
    const label = action[1] === 'Select all' ? `${harness.strings['bulk.select']} ${harness.strings['common.all']}` : action[1];
    const node = hostsOf(root, 'Pressable').find((entry) => (
      entry.props.accessibilityLabel === label || (!entry.props.accessibilityLabel && textsIn(entry).join('') === label)
    ));
    await press(node, label);
    return;
  }
  if (kind === 'alert') {
    const button = harness.alerts.at(-1)!.buttons.find((entry) => entry.text === action[1]);
    await act(async () => { await button?.onPress?.(); });
    return;
  }
  throw new Error(`Unknown action ${kind}`);
}

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  harness.alerts.length = 0;
  harness.toasts.length = 0;
  harness.storage.clear();
  const tasks = scenario.taskIds ? allTasks.filter((entry) => scenario.taskIds!.includes(entry.id)) : allTasks;
  const seededProjects = scenario.projectIds ? projects.filter((entry) => scenario.projectIds!.includes(entry.id)) : projects;
  const settings = settingsVariants[scenario.settings];
  // What the root layout applies before any screen renders.
  configureDateFormatting({
    language: settings.language || 'en',
    dateFormat: settings.dateFormat,
    calendarSystem: settings.calendarSystem,
    timeFormat: settings.timeFormat,
    systemLocale: DEVICE_LOCALE,
  });
  await seedStore(settings, tasks, seededProjects);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TrashScreen />); });
  const seen = { alerts: 0, toasts: 0, writes: 0 };
  const observations = [observe(renderer.root, seen)];
  for (const action of scenario.actions) {
    await perform(renderer.root, action);
    await act(async () => { await flushPendingSave(); });
    observations.push(observe(renderer.root, seen));
  }
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}

describe('React Native Trash parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    process.env.TZ = TIME_ZONE;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    harness.strings = await loadTranslations('en');
  });
  afterAll(() => {
    vi.useRealTimers();
    configureDateFormatting();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    const inputs = normalize({ timeZone: TIME_ZONE, now: NOW, tasks: allTasks, projects, areas, settings: settingsVariants, scenarios }) as Record<string, unknown>;
    if (CAPTURE) {
      let previous: Record<string, unknown> = {};
      try {
        previous = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
      } catch {
        previous = {};
      }
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ ...previous, trash: { ...inputs, observations: captured } }, null, 1)}\n`);
    }
    const { observations, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).trash;
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);

  it('draws the Restore swipe action with a vector icon, not an emoji', async () => {
    configureDateFormatting({ language: 'en', systemLocale: DEVICE_LOCALE });
    await seedStore(settingsVariants.base, allTasks, projects);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<TrashScreen />); });
    const restoreActions = hostsOf(renderer.root, 'Swipeable').map((row) => row.findAll((child) => String(child.type) === 'Pressable')[0]);

    expect(restoreActions.length).toBeGreaterThan(0);
    expect(textsIn(renderer.root).filter((text) => text.includes('↩'))).toEqual([]);
    expect(restoreActions.every((action) => hostsOf(action, 'Icon:RotateCcw').length === 1)).toBe(true);
    await act(async () => { renderer.unmount(); });
    await flushPendingSave();
  });
});
