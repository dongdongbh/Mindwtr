


import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureDateFormatting, flushPendingSave, loadTranslations, resetForTests, type AppSettings } from '@mindwtr/core';

import {
  CAPTURE,
  DEVICE_LOCALE,
  NOW,
  TIME_ZONE,
  calendarEvents,
  findPressable,
  hostsOf,
  normalize,
  readFixturePart,
  scenarioProjects,
  scenarioTasks,
  seedStore,
  sharedInputs,
  textsIn,
  writeFixturePart,
  writeLog,
  type Observation,
  type Scenario,
} from './review-modal.parity-support';
import { DailyReviewScreen } from './daily-review-modal';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  storage: new Map<string, string>(),
  storageLog: [] as unknown[][],
  closes: 0,
  pushes: [] as string[],
  calendar: 'events' as 'events' | 'error' | 'none',
  events: [] as unknown[],
  fetches: [] as unknown[],
  mounted: null as null | ((mounted: boolean) => void),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => { harness.storageLog.push(['get', key]); return harness.storage.get(key) ?? null; },
    setItem: async (key: string, value: string) => { harness.storageLog.push(['set', key, value]); harness.storage.set(key, value); },
    removeItem: async (key: string) => { harness.storageLog.push(['remove', key]); harness.storage.delete(key); },
  },
}));
vi.mock('expo-router', () => ({ router: { push: (route: string) => { harness.pushes.push(route); } } }));
vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => harness.strings[key] ?? key, language: 'en' }),
}));
vi.mock('../contexts/theme-context', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('../contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/hooks/use-filled-button-colors', () => ({ useFilledButtonColors: () => ({ backgroundColor: '#3b82f6', textColor: '#fff' }) }));
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('../lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../lib/external-calendar', () => ({
  fetchExternalCalendarEvents: async (start: Date, end: Date) => {
    harness.fetches.push([start.toISOString(), end.toISOString()]);
    if (harness.calendar === 'error') throw new Error('Calendar feed unreachable');
    return { events: harness.calendar === 'events' ? harness.events : [] };
  },
}));
vi.mock('./swipeable-task-item', () => ({ SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props) }));
vi.mock('./task-edit-modal', () => ({ TaskEditModal: (props: any) => React.createElement('TaskEditModal', props) }));
vi.mock('./inbox-processing-modal', () => ({ InboxProcessingModal: (props: any) => React.createElement('InboxProcessingModal', props) }));
vi.mock('./ErrorBoundary', () => ({ ErrorBoundary: (props: any) => React.createElement(React.Fragment, null, props.children) }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: (props: any) => React.createElement('GestureHandlerRootView', props, props.children),
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
    FlatList: ({ data = [], renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ...props }: any) => React.createElement(
      'FlatList',
      props,
      ListHeaderComponent ?? null,
      data.length === 0 ? ListEmptyComponent ?? null : null,
      data.map((item: any, index: number) => (
        <React.Fragment key={keyExtractor?.(item, index) ?? index}>{renderItem?.({ item, index })}</React.Fragment>
      )),
    ),
  };
});

const settingsVariants: Record<string, AppSettings> = {
  base: {},
  noFocus: { gtd: { dailyReview: { includeFocusStep: false } } },
  focusLimit: { gtd: { focusTaskLimit: 2 } },
  sortTitle: { taskSortBy: 'title' },
  ymdDates: { dateFormat: 'ymd', timeFormat: '24h' },
};

const SESSION_KEY = 'mindwtr:dailyReview:currentStep';
const session = (step: string, startedAt: string) => JSON.stringify({ step, startedAt });

export const scenarios: Scenario[] = [
  { name: 'daily: every step, then finish', settings: 'base', actions: [['next'], ['next'], ['next'], ['next'], ['press', 'Finish']] },
  { name: 'daily: the calendar folds', settings: 'base', actions: [['press', 'Events'], ['press', 'Events']] },
  {
    name: 'daily: rows, the editor and follow-ups',
    settings: 'base',
    actions: [
      ['row', 'n-passport', 'status', 'done'], ['row', 'n-rent', 'edit'], ['editorSave', { title: 'Pay the rent' }], ['next'],
      ['row', 'i-thought', 'delete'], ['next'], ['followUp', 'w-vendor'], ['followUp', 'w-parcel'], ['followUp', 'w-alice'],
      ['next'], ['row', 'n-logo', 'status', 'waiting'],
    ],
  },
  { name: 'daily: pause and resume', settings: 'base', actions: [['next'], ['next'], ['close'], ['reopen'], ['back']] },
  { name: 'daily: a session from today resumes', settings: 'base', storage: { [SESSION_KEY]: session('focus', '2026-09-23T12:00:00.000Z') }, actions: [['back']] },
  { name: 'daily: a session from yesterday starts over', settings: 'base', storage: { [SESSION_KEY]: session('focus', '2026-09-22T20:00:00.000Z') }, actions: [] },
  { name: 'daily: an unreadable session starts over', settings: 'base', storage: { [SESSION_KEY]: '{"step":"nope"}' }, actions: [] },
  { name: 'daily: no focus step', settings: 'noFocus', actions: [['next'], ['next'], ['next']] },
  { name: 'daily: title sort', settings: 'sortTitle', actions: [['next'], ['next'], ['next']] },
  { name: 'daily: focus limit hint when nothing is a candidate', settings: 'focusLimit', taskIds: ['i-thought', 'w-alice', 's-japan'], calendar: 'none', storage: { [SESSION_KEY]: session('focus', '2026-09-23T12:00:00.000Z') }, actions: [] },
  { name: 'daily: an empty system', settings: 'base', taskIds: [], projectIds: [], calendar: 'none', actions: [['press', 'Finish']] },
  { name: 'daily: a calendar error', settings: 'base', taskIds: ['r-manual'], calendar: 'error', actions: [] },
  { name: 'daily: dates follow the app date format', settings: 'ymdDates', actions: [] },
];

function observe(root: ReactTestInstance, seen: { writes: number; storage: number; closes: number; pushes: number; fetches: number }): Observation {
  const editor = hostsOf(root, 'TaskEditModal')[0]?.props;
  const footer = hostsOf(root, 'View').find((node) => node.props.testID === 'daily-review-footer');
  const observation: Observation = {
    texts: textsIn(root),
    rows: hostsOf(root, 'SwipeableTaskItem').map((row) => [
      row.props.task.id,
      row.props.showFocusToggle === true,
      row.props.hideStatusBadge === true,
      row.props.footerContent
        ? [row.props.footerContent.props.disabled === true, row.props.footerContent.props.accessibilityLabel]
        : null,
    ]),
    footer: footer ? hostsOf(footer, 'TouchableOpacity').map((node) => [textsIn(node).join(''), node.props.disabled === true]) : null,
    calendarExpanded: hostsOf(root, 'TouchableOpacity').find((node) => node.props.accessibilityState && 'expanded' in node.props.accessibilityState)
      ?.props.accessibilityState.expanded ?? null,
    editor: editor?.visible ? [editor.task?.id ?? null, editor.defaultTab] : null,
    inboxProcessing: hostsOf(root, 'InboxProcessingModal')[0]?.props.visible === true,
    writes: writeLog.slice(seen.writes),
    storage: harness.storageLog.slice(seen.storage),
    closes: harness.closes - seen.closes,
    pushes: harness.pushes.slice(seen.pushes),
    fetches: harness.fetches.slice(seen.fetches),
  };
  seen.writes = writeLog.length;
  seen.storage = harness.storageLog.length;
  seen.closes = harness.closes;
  seen.pushes = harness.pushes.length;
  seen.fetches = harness.fetches.length;
  return normalize(observation) as Observation;
}

async function perform(root: ReactTestInstance, action: [string, ...unknown[]]) {
  const [kind, target, ...rest] = action;
  const run = async (what: string, fn: (() => unknown) | undefined) => {
    if (!fn) throw new Error(`Nothing to do for ${what}: ${JSON.stringify(textsIn(root))}`);
    await act(async () => { await fn(); });
  };
  const row = (id: unknown) => hostsOf(root, 'SwipeableTaskItem').find((node) => node.props.task.id === id)?.props;
  const footerButtons = () => {
    const footer = hostsOf(root, 'View').find((node) => node.props.testID === 'daily-review-footer');
    return footer ? hostsOf(footer, 'TouchableOpacity') : [];
  };
  switch (kind) {
    case 'next':
      return run('next', footerButtons().find((node) => textsIn(node).join('') === 'Next Step')?.props.onPress);
    case 'back':
      return run('back', footerButtons().find((node) => textsIn(node).join('') === 'Back')?.props.onPress);
    case 'close':
      return run('close', findPressable(root, 'Close')?.props.onPress);
    case 'reopen':
      return run('reopen', () => harness.mounted?.(true));
    case 'press':
      return run(`press ${String(target)}`, findPressable(root, String(target))?.props.onPress);
    case 'row': {
      const props = row(target);
      const [verb, status] = rest as [string, string?];
      if (verb === 'status') return run('status', () => props?.actions.changeStatus(props.task, status));
      if (verb === 'delete') return run('delete', () => props?.actions.remove(props.task));
      return run('edit', () => props?.actions.edit(props.task));
    }
    case 'followUp': {
      const footer = row(target)?.footerContent;
      return run('follow up', footer && !footer.props.disabled ? () => footer.props.onPress({ stopPropagation: () => undefined }) : () => undefined);
    }
    case 'editorSave': {
      const editor = hostsOf(root, 'TaskEditModal')[0]?.props;
      return run('editor save', () => editor?.onSave(editor.task.id, target));
    }
    default:
      throw new Error(`Unknown action ${kind}`);
  }
}


function Host() {
  const [mounted, setMounted] = React.useState(true);
  harness.mounted = setMounted;
  return mounted ? <DailyReviewScreen onClose={() => { harness.closes += 1; setMounted(false); }} /> : null;
}

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  harness.storage = new Map(Object.entries(scenario.storage ?? {}));
  harness.storageLog.length = 0;
  harness.closes = 0;
  harness.pushes.length = 0;
  harness.fetches.length = 0;
  harness.calendar = scenario.calendar ?? 'events';
  harness.events = calendarEvents;
  const settings = settingsVariants[scenario.settings];
  configureDateFormatting({ language: 'en', dateFormat: settings.dateFormat, timeFormat: settings.timeFormat, systemLocale: DEVICE_LOCALE });
  await seedStore(settings, scenarioTasks(scenario), scenarioProjects(scenario));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Host />); });
  await act(async () => { await flushPendingSave(); });
  const seen = { writes: 0, storage: 0, closes: 0, pushes: 0, fetches: 0 };
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

describe('React Native Daily Review parity fixture', () => {
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
    const inputs = sharedInputs(settingsVariants, scenarios);
    if (CAPTURE) writeFixturePart('dailyReview', inputs, captured);
    const { observations, ...frozenInputs } = readFixturePart('dailyReview');
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);
});
