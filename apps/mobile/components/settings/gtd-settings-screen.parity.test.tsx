/**
 * React Native's Settings › GTD screens (the hub and its six sub-screens),
 * replayed against the frozen parity fixture
 * (packages/core/src/gtd-settings-parity.fixtures.json) that core's GTD
 * settings model and the native host contract are tested against.
 *
 * To recapture, keep every file under apps/ at HEAD except this one, then run
 *   MINDWTR_CAPTURE_GTD_SETTINGS=1 TZ=UTC bunx vitest run components/settings/gtd-settings-screen.parity.test.tsx
 * The capture refuses to run while any other file under apps/ differs from HEAD,
 * so the provenance always names the React Native code that ran. After a
 * recorded React Native fix, MINDWTR_DUMP_GTD_SETTINGS=<file> writes this run's
 * observations, to replace only the ones the fix changes (see provenance.recaptured).
 *
 * Each scenario renders the real screen with the real core store, drives it
 * through its own controls, and records what a user sees, what the store is
 * asked to write, what the screen stores on the device, its toasts and where
 * it navigates. The device is stubbed: the exact-alarm permission is the
 * scenario's, and the Android capture intent panel (a native module) is a marker.
 */
import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  flushPendingSave,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Area,
} from '@mindwtr/core';

import { __resetTaskOpenModeStoreForTests } from '@/lib/view-state/task-open-mode';
import { GtdSettingsScreen } from './gtd-settings-screen';

const FIXTURE_PATH = new URL('../../../../packages/core/src/gtd-settings-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_GTD_SETTINGS === '1';
const NOW = '2026-09-24T14:00:00.000Z';
const TINT = '#3b82f6';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, Record<string, string>>,
  language: 'en',
  storage: new Map<string, string>(),
  exactAlarm: { relevant: false, allowed: true },
  device: [] as unknown[][],
  toasts: [] as unknown[],
  navigations: [] as unknown[],
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
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => harness.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      harness.device.push(['setItem', key, value]);
      harness.storage.set(key, value);
    },
    removeItem: async (key: string) => {
      harness.device.push(['removeItem', key]);
      harness.storage.delete(key);
    },
  },
}));
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
vi.mock('@/hooks/use-filled-button-colors', () => ({
  useFilledButtonColors: () => ({ backgroundColor: '#3b82f6', textColor: undefined }),
}));
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({
    showToast: (toast: { message: string; tone?: string; durationMs?: number }) => {
      harness.toasts.push([toast.message, toast.tone ?? null, toast.durationMs ?? null]);
    },
    dismissToast: () => undefined,
  }),
}));
vi.mock('@/lib/exact-alarm-permission', () => ({
  isExactAlarmPermissionRelevant: () => harness.exactAlarm.relevant,
  refreshExactAlarmPermission: async () => harness.exactAlarm.allowed,
  openExactAlarmSettings: async () => undefined,
}));
// A native module; the native host draws its own. Only where it sits is recorded.
vi.mock('./android-capture-intent-section', () => ({
  AndroidCaptureIntentSection: () => React.createElement('AndroidCaptureIntentSection'),
}));
// Native account cards have separate behavior tests; this frozen fixture covers the GTD model.
vi.mock('./gmail-capture-section', () => ({
  GmailCaptureSection: () => React.createElement('GmailCaptureSection'),
}));
// Each lucide icon is its own element, so the archive screen's Check can be seen.
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

const at = (day: string) => `2026-${day}T12:00:00.000Z`;
const area = (id: string, name: string, order: number, extra: Partial<Area> = {}): Area => ({
  id, name, order, createdAt: at('09-01'), updatedAt: at('09-01'), ...extra,
});

const AREAS: Area[] = [
  area('a-work', 'Work', 1, { color: '#3b82f6' }),
  area('a-home', 'Home', 0),
  area('a-gone', 'Gone', 2, { deletedAt: at('09-10'), updatedAt: at('09-10') }),
  area('a-errands', 'Errands', 3, { color: '#10b981' }),
];

const SETTINGS: Record<string, AppSettings> = {
  base: {},
  stored: {
    quickAddAutoClean: true,
    markdownEditorAssist: false,
    features: { pomodoro: true, priorities: false },
    gtd: {
      defaultScheduleTime: '9:30',
      focusTaskLimit: 5,
      defaultProjectFlowMode: 'sequential',
      autoArchiveDays: 14,
      defaultCaptureMethod: 'audio',
      saveAudioAttachments: false,
      naturalLanguageDates: false,
      defaultAreaMode: 'fixed',
      defaultAreaId: 'a-work',
      inboxProcessing: { twoMinuteEnabled: false, projectFirst: true, contextStepEnabled: false, scheduleEnabled: true },
      weeklyReview: { includeContextStep: false },
      dailyReview: { includeFocusStep: false },
      pomodoro: { customDurations: { focusMinutes: 50, breakMinutes: 10 }, linkTask: true, autoStartBreaks: true, completionAlert: false },
    },
  },
  pomodoroOn: { features: { pomodoro: true } },
  activeArea: { gtd: { defaultAreaMode: 'active' } },
  // An id with no mode reads as a fixed area; this one is deleted.
  goneArea: { gtd: { defaultAreaId: 'a-gone' } },
  oddArchive: { gtd: { autoArchiveDays: 10.6 } },
  customEditor: {
    features: { timeEstimates: false },
    gtd: {
      taskEditor: {
        order: ['dueDate', 'status', 'tags', 'retiredField', 'project', 'contexts'] as never,
        hidden: ['description', 'priority', 'timeEstimate'],
        // status is not sectionable: the screen ignores it.
        sections: { tags: 'details', dueDate: 'scheduling', status: 'details' },
        sectionOpen: { scheduling: true, details: true },
      },
    },
  },
};

const OPEN_MODE_KEY = 'mindwtr:view:taskOpenMode:v1';

type Screen = 'gtd' | 'gtd-archive' | 'gtd-capture' | 'gtd-inbox' | 'gtd-pomodoro' | 'gtd-review' | 'gtd-task-editor';
type Device = {
  language?: string;
  storage?: Record<string, string>;
  exactAlarm?: { relevant: boolean; allowed: boolean };
};
/**
 * Actions: ['press', label] a control outside the modal; ['modalPress', label]
 * one inside it; ['switch', index] / ['modalSwitch', index] flips a switch;
 * ['type', index, text] and ['blur', index] edit a text field; ['dismiss']
 * closes the modal; ['eye', field] and ['field', field] press a task editor
 * row's visibility badge or its body. A label is the control's text (or its
 * accessibility label, or the first of its texts); 'k:<key>' is that key's
 * translation.
 */
type Scenario = { name: string; screen: Screen; settings: string; device: Device; actions: [string, ...unknown[]][] };

const scenarios: Scenario[] = [
  {
    name: 'hub: defaults',
    screen: 'gtd', settings: 'base', device: {},
    actions: [
      ['switch', 0], ['press', 'k:settings.pomodoroSettings'],
      ['press', '1'], ['press', '1'],
      ['press', 'k:settings.projectFlowSequential'], ['press', 'k:settings.projectFlowSequential'],
      ['type', 0, ' 9:30 '], ['blur', 0], ['blur', 0],
      ['type', 0, '25:00'], ['blur', 0],
      ['type', 0, ''], ['blur', 0],
      ['press', 'k:settings.autoArchive'], ['press', 'k:settings.taskEditorLayout'], ['press', 'k:settings.captureSettings'],
      ['press', 'k:settings.reviewSettings'], ['press', 'k:settings.inboxProcessing'],
      ['switch', 0],
    ],
  },
  {
    name: 'hub: stored values',
    screen: 'gtd', settings: 'stored', device: {},
    actions: [['press', '3'], ['press', 'k:settings.projectFlowParallel']],
  },
  { name: 'hub: in German', screen: 'gtd', settings: 'base', device: { language: 'de' }, actions: [] },
  { name: 'pomodoro: off', screen: 'gtd-pomodoro', settings: 'base', device: {}, actions: [['press', 'k:settings.featurePomodoro']] },
  {
    name: 'pomodoro: on',
    screen: 'gtd-pomodoro', settings: 'pomodoroOn', device: {},
    actions: [
      ['type', 0, '50'], ['blur', 0],
      ['type', 1, 'x'], ['blur', 1],
      ['type', 0, '500'], ['blur', 0],
      ['type', 1, '0'], ['blur', 1],
      ['switch', 0], ['switch', 1], ['switch', 2], ['switch', 1], ['switch', 3],
    ],
  },
  { name: 'pomodoro: stored values', screen: 'gtd-pomodoro', settings: 'stored', device: {}, actions: [['blur', 0]] },
  {
    name: 'pomodoro: exact alarms denied',
    screen: 'gtd-pomodoro', settings: 'pomodoroOn', device: { exactAlarm: { relevant: true, allowed: false } },
    actions: [['switch', 3], ['switch', 3]],
  },
  {
    name: 'capture: defaults',
    screen: 'gtd-capture', settings: 'base', device: {},
    actions: [
      ['press', 'k:settings.defaultArea'], ['modalPress', 'Work'],
      ['press', 'k:settings.defaultArea'], ['modalPress', 'k:settings.defaultAreaActive'],
      ['press', 'k:settings.defaultArea'], ['modalPress', 'k:settings.defaultAreaActive'],
      ['press', 'k:settings.defaultArea'], ['modalPress', 'k:settings.defaultAreaNone'],
      ['press', 'k:settings.defaultArea'], ['dismiss'],
      ['press', 'k:settings.captureDefaultAudio'], ['switch', 0], ['press', 'k:settings.captureDefaultAudio'],
      ['press', 'k:settings.captureDefaultText'],
      ['switch', 0], ['switch', 1], ['switch', 2],
    ],
  },
  { name: 'capture: stored values', screen: 'gtd-capture', settings: 'stored', device: {}, actions: [['press', 'k:settings.defaultArea'], ['modalPress', 'Errands']] },
  { name: 'capture: a deleted default area', screen: 'gtd-capture', settings: 'goneArea', device: {}, actions: [['press', 'k:settings.defaultArea']] },
  { name: 'capture: the active area', screen: 'gtd-capture', settings: 'activeArea', device: {}, actions: [] },
  { name: 'capture: in German', screen: 'gtd-capture', settings: 'stored', device: { language: 'de' }, actions: [['press', 'k:settings.defaultArea']] },
  { name: 'review: defaults', screen: 'gtd-review', settings: 'base', device: {}, actions: [['switch', 0], ['switch', 1], ['switch', 1]] },
  { name: 'review: stored values', screen: 'gtd-review', settings: 'stored', device: {}, actions: [['switch', 0]] },
  { name: 'inbox: defaults', screen: 'gtd-inbox', settings: 'base', device: {}, actions: [['switch', 0], ['switch', 1], ['switch', 2], ['switch', 3]] },
  { name: 'inbox: stored values', screen: 'gtd-inbox', settings: 'stored', device: {}, actions: [['switch', 1]] },
  {
    name: 'archive: defaults',
    screen: 'gtd-archive', settings: 'base', device: {},
    actions: [['press', '30 days'], ['press', '30 days'], ['press', 'k:settings.autoArchiveNever']],
  },
  { name: 'archive: stored values', screen: 'gtd-archive', settings: 'stored', device: {}, actions: [] },
  { name: 'archive: a value no option has', screen: 'gtd-archive', settings: 'oddArchive', device: {}, actions: [['press', '7 days']] },
  {
    name: 'task editor: defaults',
    screen: 'gtd-task-editor', settings: 'base', device: {},
    actions: [
      ['press', 'k:settings.gtdMobile.taskOpenPreview'],
      ['press', 'k:settings.gtdMobile.simple'], ['press', 'k:settings.gtdMobile.simple'],
      ['press', 'k:settings.gtdMobile.full'], ['press', 'k:settings.gtdMobile.standard'],
      ['press', 'k:taskEdit.scheduling'],
      ['field', 'dueDate'], ['modalPress', 'k:projects.moveDown'], ['modalPress', 'k:projects.moveUp'],
      ['modalPress', 'k:taskEdit.scheduling'], ['modalSwitch', 0], ['modalPress', 'k:common.done'],
      ['press', 'k:taskEdit.organization'], ['eye', 'priority'], ['eye', 'tags'],
      ['switch', 1],
      ['press', 'k:settings.resetToDefault'], ['press', 'k:settings.resetToDefault'],
    ],
  },
  {
    name: 'task editor: a custom layout',
    screen: 'gtd-task-editor', settings: 'customEditor', device: { storage: { [OPEN_MODE_KEY]: 'edit' } },
    actions: [
      ['field', 'tags'], ['modalPress', 'k:taskEdit.organization'], ['modalPress', 'k:common.done'],
      ['press', 'k:taskEdit.organization'], ['eye', 'timeEstimate'],
      ['switch', 0],
      ['press', 'k:settings.gtdMobile.standard'],
    ],
  },
  { name: 'task editor: in German', screen: 'gtd-task-editor', settings: 'base', device: { language: 'de' }, actions: [['field', 'status']] },
  { name: 'task editor: an unreadable open mode', screen: 'gtd-task-editor', settings: 'base', device: { storage: { [OPEN_MODE_KEY]: 'sideways' } }, actions: [] },
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
  const data = JSON.parse(JSON.stringify({ tasks: [], projects: [], sections: [], areas: AREAS, people: [], settings: SETTINGS[scenario.settings] }));
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

function setDevice(device: Device) {
  harness.language = device.language ?? 'en';
  harness.storage = new Map(Object.entries(device.storage ?? {}));
  harness.exactAlarm = device.exactAlarm ?? { relevant: false, allowed: true };
  harness.device.length = 0;
  harness.toasts.length = 0;
  harness.navigations.length = 0;
  writeLog.length = 0;
  __resetTaskOpenModeStoreForTests();
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
    if (String(node.type) === 'Modal' && (!modals || !node.props.visible)) return;
    if (String(node.type) === type) out.push(node);
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

/** The visible text, one entry per outermost Text, in screen order. */
function textsIn(root: ReactTestInstance, modals = false): string[] {
  const out: string[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Modal' && (!modals || !node.props.visible)) return;
    if (String(node.type) === 'Text') {
      out.push(deepText(node));
      return;
    }
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten))
  : style && typeof style === 'object' ? style as Record<string, unknown> : {});

const visibleModal = (root: ReactTestInstance) => root.findAll((node) => String(node.type) === 'Modal' && node.props.visible === true)[0] ?? null;

const controlLabel = (node: ReactTestInstance) => node.props.accessibilityLabel ?? textsIn(node, true).join('|');

/**
 * Whether a control shows as chosen: its accessibility state when it has one,
 * else a check mark, else a tinted first text.
 */
function controlSelected(node: ReactTestInstance): boolean {
  const state = node.props.accessibilityState?.selected;
  if (typeof state === 'boolean') return state;
  if (node.findAll((child) => String(child.type) === 'Icon:Check' || (String(child.type) === 'Icon' && child.props.name === 'checkmark')).length > 0) return true;
  const text = hosts(node, 'Text', true)[0];
  return text ? flatten(text.props.style).color === TINT : false;
}

function readControls(root: ReactTestInstance, modals: boolean) {
  return {
    controls: hosts(root, 'TouchableOpacity', modals).map((node) => [controlLabel(node), controlSelected(node), node.props.disabled === true]),
    switches: hosts(root, 'Switch', modals).map((node) => [node.props.accessibilityLabel, node.props.value, node.props.disabled === true]),
  };
}

function drain(seen: { writes: number; device: number; toasts: number; navigations: number }) {
  const out = {
    writes: writeLog.slice(seen.writes),
    device: normalize(harness.device.slice(seen.device)),
    toasts: normalize(harness.toasts.slice(seen.toasts)),
    navigations: normalize(harness.navigations.slice(seen.navigations)),
  };
  seen.writes = writeLog.length;
  seen.device = harness.device.length;
  seen.toasts = harness.toasts.length;
  seen.navigations = harness.navigations.length;
  return out;
}

type Seen = Parameters<typeof drain>[0];

function observe(root: ReactTestInstance, seen: Seen) {
  const modal = visibleModal(root);
  return normalize({
    texts: textsIn(root),
    ...readControls(root, false),
    inputs: hosts(root, 'TextInput').map((node) => [node.props.accessibilityLabel ?? null, node.props.placeholder ?? null, node.props.value]),
    automationCapture: hosts(root, 'AndroidCaptureIntentSection').length > 0,
    modal: modal ? { texts: textsIn(modal, true), ...readControls(modal, true) } : null,
    ...drain(seen),
  });
}

// ---------------------------------------------------------------------------
// Driving the screen.

async function run(what: string, fn: (() => unknown) | undefined) {
  if (!fn) throw new Error(`Nothing to do for ${what}`);
  await act(async () => { await fn(); });
}

const labelText = (label: string) => (label.startsWith('k:') ? translate(label.slice(2)) : label);
const matches = (node: ReactTestInstance, label: string) => {
  const text = controlLabel(node);
  return text === label || text.split('|')[0] === label || text.startsWith(`${label}: `);
};
const byTestId = (root: ReactTestInstance, testID: string) => root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID)[0];

async function perform(renderer: ReactTestRenderer, action: [string, ...unknown[]]) {
  const root = renderer.root;
  const [kind, target, extra] = action;
  const modal = () => visibleModal(root)!;
  switch (kind) {
    case 'press':
    case 'modalPress': {
      const scope = kind === 'press' ? hosts(root, 'TouchableOpacity') : hosts(modal(), 'TouchableOpacity', true);
      const label = labelText(target as string);
      const control = scope.find((node) => matches(node, label));
      // A disabled control cannot be pressed.
      if (control?.props.disabled) return undefined;
      return run(`${kind} ${label}`, control?.props.onPress);
    }
    case 'switch':
    case 'modalSwitch': {
      const control = (kind === 'switch' ? hosts(root, 'Switch') : hosts(modal(), 'Switch', true))[target as number];
      return run(kind, () => control.props.onValueChange(!control.props.value));
    }
    case 'type':
      return run('type', () => hosts(root, 'TextInput')[target as number].props.onChangeText(extra));
    case 'blur':
      return run('blur', () => hosts(root, 'TextInput')[target as number].props.onBlur());
    case 'dismiss':
      return run('dismiss', modal().props.onRequestClose);
    case 'eye':
      return run('eye', byTestId(root, `task-editor-visibility-${String(target)}`)?.props.onPress);
    case 'field':
      return run('field', byTestId(root, `task-editor-row-${String(target)}`)?.props.onPress);
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
    renderer = create(<GtdSettingsScreen screen={scenario.screen} onNavigate={(next) => { harness.navigations.push(next); }} />);
  });
  await settle();
  const seen: Seen = { writes: 0, device: 0, toasts: 0, navigations: 0 };
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

const inputs = () => normalize({ now: NOW, timeZone: 'UTC', areas: AREAS, settings: SETTINGS, scenarios }) as Record<string, unknown>;

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const harnessPath = 'apps/mobile/components/settings/gtd-settings-screen.parity.test.tsx';
  const changed = git('status', '--porcelain', '--untracked-files=all', '--', '../../../../apps').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => path !== harnessPath);
  if (changed.length > 0) throw new Error(`Capture needs HEAD's apps/ code; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_GTD_SETTINGS=1 TZ=UTC bunx vitest run components/settings/gtd-settings-screen.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ was at HEAD except this harness. No React Native code imported core\'s GTD settings model yet.',
    device: 'The device is stubbed: the exact-alarm permission is the scenario\'s exactAlarm, AsyncStorage is the scenario\'s storage, and the Android capture intent panel (a native module) is recorded only as present.',
  };
}

describe('React Native GTD settings screens parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    harness.strings = { en: await loadTranslations('en'), de: await loadTranslations('de') };
  });
  afterAll(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    // Writes this run's observations to a file, to replace only the ones a fix changes.
    if (process.env.MINDWTR_DUMP_GTD_SETTINGS) writeFileSync(process.env.MINDWTR_DUMP_GTD_SETTINGS, JSON.stringify(captured));
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
