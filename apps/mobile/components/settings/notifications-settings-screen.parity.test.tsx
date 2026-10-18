/**
 * React Native's Settings › Notifications screen, replayed against the frozen parity
 * fixture (packages/core/src/notifications-settings-parity.fixtures.json) that core's
 * notifications settings model is tested against
 * (packages/core/src/notifications-settings-model.parity.test.ts).
 *
 * The fixture was captured from the screen as it was before core held its policy
 * (commit dba1097c7). To recapture, check that commit out in its own worktree, copy
 * this file in, and run there
 *   MINDWTR_CAPTURE_NOTIFICATIONS_SETTINGS=1 TZ=UTC bunx vitest run components/settings/notifications-settings-screen.parity.test.tsx
 * then copy the fixture back. The capture refuses to run while any file under
 * apps/mobile or packages/core differs from the named commit (this harness and the
 * fixture aside), so the provenance always names the code that ran.
 *
 * Each scenario renders the real screen with the real core store, drives it through
 * its own controls, and records what a user sees (each text with its color and
 * opacity; each switch and pressable row with its disabled flag; the time pickers;
 * the open day picker), what the store is asked to write, and what the screen asks
 * the device for (the notification permission, the persistent capture notification,
 * the exact-alarm settings). The device is stubbed: the platform, the permission
 * answer, the exact-alarm state and the system locale are the scenario's.
 */
import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import {
  flushPendingSave,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
} from '@mindwtr/core';

import { NotificationsSettingsScreen } from './notifications-settings-screen';

const FIXTURE_PATH = new URL('../../../../packages/core/src/notifications-settings-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_NOTIFICATIONS_SETTINGS === '1';
const FROZEN_AT = 'dba1097c7';
const NOW = '2026-10-05T12:00:00.000Z';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, Record<string, string>>,
  language: 'en',
  permissionGranted: true,
  persistentCapture: false,
  exactAlarm: { relevant: false, allowed: true },
  device: [] as unknown[][],
}));

const translate = (key: string) => harness.strings[harness.language]?.[key] || harness.strings.en?.[key] || key;

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('expo-router', () => {
  const router = { push: () => undefined, back: () => undefined, replace: () => undefined, canGoBack: () => true };
  return { useRouter: () => router, useLocalSearchParams: () => ({}), usePathname: () => '/settings' };
});
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: translate, language: harness.language, setLanguage: () => undefined, isReady: true }),
}));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@react-native-community/datetimepicker', () => ({
  default: (props: any) => React.createElement('DateTimePicker', props),
}));
vi.mock('@/lib/notification-service', () => ({
  requestNotificationPermission: async () => {
    harness.device.push(['requestNotificationPermission']);
    return { granted: harness.permissionGranted, canAskAgain: true };
  },
  startMobileNotifications: async () => {
    harness.device.push(['startMobileNotifications']);
  },
}));
vi.mock('@/lib/persistent-capture-notification', async () => {
  const { Platform: platform } = await import('react-native');
  return {
    isPersistentCaptureSupported: () => platform.OS === 'android',
    readPersistentCaptureEnabled: async () => harness.persistentCapture,
    applyPersistentCaptureNotification: (enabled: boolean, strings: unknown) => {
      harness.device.push(['applyPersistentCaptureNotification', enabled, strings]);
    },
    writePersistentCaptureEnabled: async (enabled: boolean) => {
      harness.device.push(['writePersistentCaptureEnabled', enabled]);
      harness.persistentCapture = enabled;
    },
  };
});
vi.mock('@/lib/exact-alarm-permission', () => ({
  isExactAlarmPermissionRelevant: () => harness.exactAlarm.relevant,
  refreshExactAlarmPermission: async () => harness.exactAlarm.allowed,
  openExactAlarmSettings: async () => {
    harness.device.push(['openExactAlarmSettings']);
  },
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

// ---------------------------------------------------------------------------
// Scenario data.

const SETTINGS: Record<string, AppSettings> = {
  // A fresh profile: the store's first-run migration turns task reminders off.
  base: {},
  masterOn: { notificationsEnabled: true },
  allOff: { notificationsEnabled: false },
  masterOff: {
    notificationsEnabled: false, startDateNotificationsEnabled: true, dueDateNotificationsEnabled: false,
    weeklyReviewEnabled: true, dailyDigestMorningEnabled: true,
  },
  stored: {
    notificationsEnabled: true, startDateNotificationsEnabled: false, dueDateNotificationsEnabled: true,
    weeklyReviewEnabled: true, weeklyReviewDay: 3, weeklyReviewTime: '19:15',
    dailyDigestMorningEnabled: true, dailyDigestMorningTime: '06:30',
    dailyDigestEveningEnabled: true, dailyDigestEveningTime: '21:45',
  },
  oddValues: { weeklyReviewEnabled: true, weeklyReviewDay: 9, weeklyReviewTime: '7:5', dailyDigestMorningEnabled: true, dailyDigestMorningTime: 'x' },
  germanDates: { dateFormat: 'dmy', weeklyReviewEnabled: true, weeklyReviewDay: 2 },
  weeklyOn: { weeklyReviewEnabled: true },
};

type Device = {
  platform?: 'android' | 'ios';
  language?: string;
  systemLocale?: string;
  permissionGranted?: boolean;
  persistentCapture?: boolean;
  exactAlarm?: { relevant: boolean; allowed: boolean };
};
/**
 * Actions: ['switch', index] flips a switch (a disabled one cannot be flipped);
 * ['press', label] presses a row or button outside the open picker;
 * ['modalPress', label] one inside it; ['dismiss'] closes the open picker;
 * ['pick', 'HH:MM'] picks a time on Android's open time picker and
 * ['pickDismiss'] dismisses it; ['draft', 'HH:MM'] turns iOS's spinner.
 * A label is the control's text (or the first of its texts); 'k:<key>' is that
 * key's translation.
 */
type Scenario = { name: string; settings: string; device: Device; actions: [string, ...unknown[]][] };

const scenarios: Scenario[] = [
  {
    name: 'reminders on: every switch off and on',
    settings: 'masterOn', device: {},
    actions: [
      ['switch', 0], ['switch', 1], ['switch', 2], ['switch', 0],
      ['switch', 1], ['switch', 1], ['switch', 2], ['switch', 2],
      ['switch', 3], ['switch', 3],
      ['press', 'k:settings.weeklyReviewDay'],
      ['switch', 4],
      ['press', 'k:settings.weeklyReviewDay'], ['modalPress', 'Friday'],
      ['press', 'k:settings.weeklyReviewDay'], ['dismiss'],
      ['press', 'k:settings.weeklyReviewTime'], ['pick', '07:45'],
      ['press', 'k:settings.dailyDigestMorningTime'],
      ['switch', 5],
      ['press', 'k:settings.dailyDigestMorningTime'], ['pickDismiss'],
      ['press', 'k:settings.dailyDigestMorningTime'], ['pick', '06:05'],
      ['switch', 6],
      ['press', 'k:settings.dailyDigestEveningTime'], ['pick', '21:30'],
      ['switch', 4], ['switch', 5], ['switch', 6],
    ],
  },
  {
    name: 'permission denied: nothing turns on',
    settings: 'allOff', device: { permissionGranted: false },
    actions: [['switch', 0], ['switch', 1], ['switch', 3], ['switch', 4], ['switch', 5], ['switch', 6]],
  },
  {
    name: 'master switch off: only start and due reminders dim',
    settings: 'masterOff', device: { exactAlarm: { relevant: true, allowed: true } },
    actions: [
      ['switch', 1], ['switch', 2],
      ['press', 'k:settings.weeklyReviewDay'], ['dismiss'],
      ['press', 'k:settings.dailyDigestMorningTime'], ['pickDismiss'],
    ],
  },
  {
    name: 'exact alarms denied: the notice follows any notification feature',
    settings: 'masterOn', device: { exactAlarm: { relevant: true, allowed: false } },
    actions: [['press', 'k:settings.exactAlarmsAllow'], ['switch', 0], ['switch', 4], ['switch', 4], ['switch', 5]],
  },
  {
    name: 'exact alarms denied, nothing on',
    settings: 'allOff', device: { exactAlarm: { relevant: true, allowed: false } },
    actions: [['switch', 6]],
  },
  { name: 'a fresh profile', settings: 'base', device: {}, actions: [['switch', 0]] },
  { name: 'exact alarms not asked on this Android', settings: 'masterOn', device: { exactAlarm: { relevant: false, allowed: false } }, actions: [] },
  {
    name: 'stored values, persistent capture on',
    settings: 'stored', device: { persistentCapture: true },
    actions: [['switch', 3], ['press', 'k:settings.weeklyReviewDay'], ['modalPress', 'Sunday'], ['press', 'k:settings.dailyDigestEveningTime'], ['pick', '22:00']],
  },
  {
    name: 'odd stored values',
    settings: 'oddValues', device: {},
    actions: [['press', 'k:settings.weeklyReviewDay'], ['dismiss'], ['press', 'k:settings.weeklyReviewTime'], ['pick', '08:00']],
  },
  {
    name: 'in German with day-month-year dates',
    settings: 'germanDates', device: { language: 'de' },
    actions: [['press', 'k:settings.weeklyReviewDay'], ['modalPress', 'Sonntag']],
  },
  { name: 'in German, dates follow the system locale', settings: 'weeklyOn', device: { language: 'de', systemLocale: 'en-US' }, actions: [] },
  { name: 'in English on a German phone', settings: 'weeklyOn', device: { systemLocale: 'de-DE' }, actions: [] },
  {
    name: 'iOS: no capture switch, spinner time pickers',
    settings: 'stored', device: { platform: 'ios' },
    actions: [
      ['switch', 0],
      ['press', 'k:settings.weeklyReviewTime'], ['draft', '10:20'], ['modalPress', 'k:common.done'],
      ['press', 'k:settings.dailyDigestMorningTime'], ['draft', '05:00'], ['modalPress', 'k:common.cancel'],
      ['press', 'k:settings.dailyDigestEveningTime'], ['modalPress', 'k:common.done'],
    ],
  },
];

// ---------------------------------------------------------------------------
// The store: real data, recorded writes.

const writeLog: unknown[][] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));

let realUpdateSettings: ((...args: any[]) => Promise<any>) | null = null;

async function seedStore(scenario: Scenario) {
  await flushPendingSave();
  resetForTests();
  realUpdateSettings ??= useTaskStore.getState().updateSettings;
  const real = realUpdateSettings;
  const data = JSON.parse(JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: SETTINGS[scenario.settings] }));
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  useTaskStore.setState({
    updateSettings: real,
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
  } as never);
  await useTaskStore.getState().fetchData({ throwOnError: true });
  await flushPendingSave();
  useTaskStore.setState({
    updateSettings: async (...args: unknown[]) => {
      writeLog.push(['updateSettings', ...(normalize(args) as unknown[])]);
      return real(...args);
    },
  } as never);
}

const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
let systemLocale = 'en-US';

function setDevice(device: Device) {
  (Platform as { OS: string }).OS = device.platform ?? 'android';
  harness.language = device.language ?? 'en';
  systemLocale = device.systemLocale ?? 'en-US';
  harness.permissionGranted = device.permissionGranted ?? true;
  harness.persistentCapture = device.persistentCapture ?? false;
  harness.exactAlarm = device.exactAlarm ?? { relevant: false, allowed: true };
  harness.device.length = 0;
  writeLog.length = 0;
}

// ---------------------------------------------------------------------------
// Reading the rendered screen. Hidden modals render their children in the test
// shim; they are skipped, as a user would.

const deepText = (node: ReactTestInstance | string | number | null | undefined | boolean): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map((child) => deepText(child as ReactTestInstance | string)).join('');
};

/** Host nodes in screen order; `modals: false` skips every modal, `true` skips only hidden ones. */
function hosts(root: ReactTestInstance, type: string, modals = false): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  const walk = (node: ReactTestInstance) => {
    // This frozen fixture predates the default selector; dedicated tests cover that control.
    if (node.props.testID === 'task-reminder-default') return;
    if (String(node.type) === 'Modal' && (!modals || !node.props.visible)) return;
    if (String(node.type) === type) out.push(node);
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten))
  : style && typeof style === 'object' ? style as Record<string, unknown> : {});

/** Each outermost Text: its words, color and opacity (a dimmed row draws at 0.5). */
function textsIn(root: ReactTestInstance, modals = false): unknown[] {
  return hosts(root, 'Text', modals).filter((node) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (String(parent.type) === 'Text') return false;
    return true;
  }).map((node) => {
    const style = flatten(node.props.style);
    return [deepText(node), style.color ?? null, style.opacity ?? 1];
  });
}

const words = (node: ReactTestInstance) => hosts(node, 'Text', true).map((text) => deepText(text)).join('|');
const controlLabel = (node: ReactTestInstance) => node.props.accessibilityLabel ?? words(node);
const hhmm = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const visibleModal = (root: ReactTestInstance) => root.findAll((node) => String(node.type) === 'Modal' && node.props.visible === true)[0] ?? null;

function readControls(root: ReactTestInstance, modals: boolean) {
  return {
    switches: hosts(root, 'Switch', modals).map((node) => [node.props.accessibilityLabel, node.props.value, node.props.disabled === true]),
    rows: hosts(root, 'TouchableOpacity', modals).map((node) => [
      controlLabel(node), node.props.disabled === true,
      node.findAll((child) => String(child.type) === 'Icon:Check').length > 0,
    ]),
    pickers: hosts(root, 'DateTimePicker', modals).map((node) => [node.props.mode, node.props.display, hhmm(node.props.value)]),
  };
}

function observe(root: ReactTestInstance, seen: { writes: number; device: number }) {
  const modal = visibleModal(root);
  const out = normalize({
    texts: textsIn(root),
    ...readControls(root, false),
    modal: modal ? { texts: textsIn(modal, true), ...readControls(modal, true) } : null,
    writes: writeLog.slice(seen.writes),
    device: harness.device.slice(seen.device),
  });
  seen.writes = writeLog.length;
  seen.device = harness.device.length;
  return out;
}

// ---------------------------------------------------------------------------
// Driving the screen.

async function run(what: string, fn: (() => unknown) | undefined) {
  if (!fn) throw new Error(`Nothing to do for ${what}`);
  await act(async () => { await fn(); });
}

const labelText = (label: string) => (label.startsWith('k:') ? translate(label.slice(2)) : label);
const atTime = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
};

async function perform(renderer: ReactTestRenderer, action: [string, ...unknown[]]) {
  const root = renderer.root;
  const [kind, target] = action;
  const modal = () => visibleModal(root)!;
  switch (kind) {
    case 'switch': {
      const control = hosts(root, 'Switch')[target as number];
      if (control.props.disabled) return undefined;
      return run(kind, () => control.props.onValueChange(!control.props.value));
    }
    case 'press':
    case 'modalPress': {
      const scope = kind === 'press' ? hosts(root, 'TouchableOpacity') : hosts(modal(), 'TouchableOpacity', true);
      const label = labelText(target as string);
      const control = scope.find((node) => controlLabel(node) === label || words(node).split('|')[0] === label);
      if (control?.props.disabled) return undefined;
      return run(`${kind} ${label}`, control?.props.onPress);
    }
    case 'dismiss':
      return run('dismiss', modal().props.onRequestClose);
    case 'pick':
      return run('pick', () => hosts(root, 'DateTimePicker')[0].props.onChange({ type: 'set' }, atTime(target as string)));
    case 'pickDismiss':
      return run('pickDismiss', () => hosts(root, 'DateTimePicker')[0].props.onChange({ type: 'dismissed' }, undefined));
    case 'draft':
      return run('draft', () => hosts(modal(), 'DateTimePicker', true)[0].props.onChange({ type: 'set' }, atTime(target as string)));
    default:
      throw new Error(`Unknown action ${String(kind)}`);
  }
}

const settle = async () => {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    await flushPendingSave();
  });
};

async function runScenario(scenario: Scenario) {
  await seedStore(scenario);
  setDevice(scenario.device);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<NotificationsSettingsScreen />);
  });
  await settle();
  const seen = { writes: 0, device: 0 };
  const observations = [observe(renderer.root, seen)];
  for (const action of scenario.actions) {
    await perform(renderer, action);
    await settle();
    observations.push(observe(renderer.root, seen));
  }
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}

const inputs = () => normalize({ now: NOW, timeZone: 'UTC', settings: SETTINGS, scenarios }) as Record<string, unknown>;

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const commit = git('rev-parse', FROZEN_AT).trim();
  const top = git('rev-parse', '--show-toplevel').trim();
  const own = ['apps/mobile/components/settings/notifications-settings-screen.parity.test.tsx', 'packages/core/src/notifications-settings-parity.fixtures.json'];
  const changed = [
    ...git('-C', top, 'diff', '--name-only', commit, '--', 'apps/mobile', 'packages/core').split('\n'),
    ...git('-C', top, 'ls-files', '--others', '--exclude-standard', '--', 'apps/mobile', 'packages/core').split('\n'),
  ].filter((path) => path && !own.includes(path));
  if (changed.length > 0) throw new Error(`Capture needs apps/mobile and packages/core at ${FROZEN_AT}; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_NOTIFICATIONS_SETTINGS=1 TZ=UTC bunx vitest run components/settings/notifications-settings-screen.parity.test.tsx',
    capturedAt: commit,
    sourceState: `Every file under apps/mobile and packages/core was at ${FROZEN_AT} except this harness: React Native's screen still held its own policy, and core had no notifications settings model.`,
    device: 'The device is stubbed: Platform.OS, the notification permission answer, the exact-alarm state, the persistent capture switch and the system locale are the scenario\'s device; Android unless it says iOS.',
  };
}

describe('React Native Settings › Notifications parity fixture', () => {
  const originalTz = process.env.TZ;
  const originalOs = Platform.OS;
  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...resolvedOptions.call(this), locale: systemLocale };
    });
    harness.strings = { en: await loadTranslations('en'), de: await loadTranslations('de') };
  });
  afterAll(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetForTests();
    (Platform as { OS: string }).OS = originalOs;
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    if (process.env.MINDWTR_DUMP_NOTIFICATIONS_SETTINGS) writeFileSync(process.env.MINDWTR_DUMP_NOTIFICATIONS_SETTINGS, JSON.stringify(captured));
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs(), observations: captured }, null, 1)}\n`);
    }
    const { observations, provenance: _provenance, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozenInputs).toEqual(inputs());
    for (const name of Object.keys(captured)) {
      expect({ [name]: captured[name] }).toEqual({ [name]: observations[name] });
    }
    expect(Object.keys(observations)).toEqual(Object.keys(captured));
  }, 180_000);
});
