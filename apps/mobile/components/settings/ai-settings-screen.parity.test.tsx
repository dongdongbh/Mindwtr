


import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Alert, Platform } from 'react-native';
import {
  flushPendingSave,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
} from '@mindwtr/core';

import { AISettingsScreen } from './ai-settings-screen';

const FIXTURE_PATH = new URL('../../../../packages/core/src/ai-settings-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_AI_SETTINGS === '1';
const TINT = '#3b82f6';
const DANGER = '#ef4444';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, Record<string, string>>,
  language: 'en',
  foss: false,
  storage: new Map<string, string>(),
  secrets: new Map<string, string>(),
  queues: {} as Record<string, unknown[]>,
  device: [] as unknown[][],
  calls: [] as unknown[][],
  toasts: [] as unknown[][],
  alerts: [] as unknown[][],
  openAlert: null as null | { buttons: { text?: string; onPress?: () => void }[]; onDismiss?: () => void },
}));

const translate = (key: string) => harness.strings[harness.language]?.[key] || harness.strings.en?.[key] || key;


const answer = async (name: string): Promise<any> => {
  const queue = harness.queues[name];
  const entry = queue && queue.length > 0 ? queue.shift() : { error: 'offline' };
  if (entry && typeof entry === 'object' && 'error' in entry) throw new Error(String((entry as { error: string }).error));
  return (entry as { value: unknown }).value;
};

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    fetchProviderModelsCached: async (provider: string, options: { apiKey: string; baseUrl: string; kind: string }) => {
      harness.calls.push(['fetchModels', provider, { apiKey: options.apiKey, baseUrl: options.baseUrl, kind: options.kind }]);
      return answer('models');
    },
  };
});
vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return { version: '1.3.2', extra: { isFossBuild: harness.foss } };
    },
    appOwnership: null,
  },
}));
vi.mock('expo-secure-store', () => ({
  isAvailableAsync: async () => true,
  getItemAsync: async (key: string) => harness.secrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string, options?: { keychainAccessible?: string }) => {
    harness.device.push(['setSecret', key, value, options?.keychainAccessible ?? null]);
    harness.secrets.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    harness.device.push(['deleteSecret', key]);
    harness.secrets.delete(key);
  },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
}));
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
vi.mock('@/lib/whisper-model-store', () => ({
  locateSync: () => null,
  locate: async (modelId: string) => ({ exists: false, uri: `file:///whisper/${modelId}.bin`, size: 0 }),
  getPreferredModelUri: (modelId: string) => `file:///whisper/${modelId}.bin`,
  download: async (modelId: string) => {
    harness.calls.push(['whisperDownload', modelId]);
    throw new Error('not in this fixture');
  },
  remove: async (modelId: string) => {
    harness.calls.push(['whisperRemove', modelId]);
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('expo-router', () => {
  const router = { push: () => undefined, back: () => undefined, replace: () => undefined, canGoBack: () => true };
  return { useRouter: () => router, useLocalSearchParams: () => ({}), usePathname: () => '/settings' };
});
vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) => React.createElement('Icon', props),
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
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({
    showToast: (toast: { title?: string; message: string; tone?: string; durationMs?: number }) => {
      harness.toasts.push([toast.title ?? null, toast.message, toast.tone ?? null, toast.durationMs ?? null]);
    },
    dismissToast: () => undefined,
  }),
}));
vi.mock('@/lib/app-log', () => ({
  logInfo: async () => undefined,
  logWarn: async (message: string) => { harness.calls.push(['logWarn', message]); },
  logError: async () => undefined,
}));


const SETTINGS: Record<string, AppSettings> = {
  base: {},
  enabled: { ai: { enabled: true, provider: 'openai' } },
  gemini: { ai: { enabled: true, provider: 'gemini', model: 'gemini-3.5-flash', thinkingBudget: 256 } },
  anthropic: { ai: { enabled: false, provider: 'anthropic', thinkingBudget: 0 } },
  custom: {
    ai: {
      enabled: true,
      provider: 'openai',
      model: 'qwen3:8b',
      copilotModel: 'qwen3:1.7b',
      baseUrl: 'http://10.0.0.5:11434/v1',
      reasoningEffort: 'high',
      openAIExtraBodyParams: { thinking: { type: 'disabled' } },
      requestTimeoutSeconds: 120,
    },
  },
  speech: {
    ai: {
      speechToText: {
        enabled: true, provider: 'openai', model: 'whisper-1', baseUrl: 'http://stt.local/v1',
        language: 'de', mode: 'transcribe_only', fieldStrategy: 'title_only',
      },
    },
  },
  whisper: { ai: { speechToText: { enabled: true, provider: 'whisper', model: 'whisper-base', offlineModelPath: 'file:///old/whisper-base.bin' } } },
  fossWrong: { ai: { enabled: true, provider: 'gemini', model: 'gemini-3.5-flash', speechToText: { provider: 'openai', model: 'gpt-transcribe' } } },
};

const CONSENT_KEY = 'mindwtr-ai-provider-consent-v1';
const KEY = { openai: 'mindwtr-ai-key_openai', gemini: 'mindwtr-ai-key_gemini', anthropic: 'mindwtr-ai-key_anthropic' };

type Device = {
  language?: string;
  foss?: boolean;
  storage?: Record<string, string>;
  secrets?: Record<string, string>;
  queues?: Record<string, unknown[]>;
};


type Scenario = { name: string; settings: string; device: Device; actions: [string, ...unknown[]][] };

const scenarios: Scenario[] = [
  {
    name: 'assistant: defaults, folded rows and the timeout picker',
    settings: 'base', device: {},
    actions: [
      ['press', 'k:settings.ai'],
      ['press', 'k:settings.aiExtraBodyParams'],
      ['press', 'k:settings.aiAdvanced'],
      ['press', 'k:settings.aiRequestTimeout'],
      ['press', '120 seconds'],
      ['press', 'k:settings.aiRequestTimeout'],
      ['backdrop'],
      ['press', 'k:settings.aiExtraBodyParams'],
      ['press', 'k:settings.ai'],
    ],
  },
  {
    name: 'assistant: turning it on asks for consent once',
    settings: 'base', device: {},
    actions: [
      ['press', 'k:settings.ai'],
      ['switch', 0], ['alert', 'k:common.cancel'],
      ['switch', 0], ['alert', null],
      ['switch', 0], ['alert', 'k:settings.aiConsentAgree'],
      ['switch', 0],
      ['switch', 0],
    ],
  },
  {
    name: 'assistant: a provider change while on asks for that provider',
    settings: 'enabled', device: { storage: { [CONSENT_KEY]: JSON.stringify({ openai: true, gemini: 'yes' }) } },
    actions: [
      ['press', 'k:settings.ai'],
      ['press', 'k:settings.aiProviderGemini'], ['alert', 'k:settings.aiConsentAgree'],
      ['press', 'k:settings.aiProviderAnthropic'], ['alert', 'k:common.cancel'],
      ['press', 'k:settings.aiProviderOpenAI'],
      ['press', 'k:settings.aiProviderGemini'],
      ['switch', 0],
      ['press', 'k:settings.aiProviderAnthropic'],
    ],
  },
  {
    name: 'assistant: an unreadable consent record asks again',
    settings: 'base', device: { storage: { [CONSENT_KEY]: 'not json' } },
    actions: [['press', 'k:settings.ai'], ['switch', 0], ['alert', 'k:settings.aiConsentAgree']],
  },
  {
    name: 'assistant: models, pickers and the OpenAI panel',

    settings: 'base', device: { storage: { [CONSENT_KEY]: JSON.stringify({ openai: true }) } },
    actions: [
      ['press', 'k:settings.ai'],
      ['type', 0, 'gpt-custom'],
      ['press', 'k:settings.aiMobile.suggestions'],
      ['press', 'gpt-5.6'],
      ['type', 1, 'fast-one'],
      ['press', 'k:settings.aiMobile.suggestions', 1],
      ['backdrop'],
      ['press', 'k:settings.aiEffortHigh'],
      ['type', 2, 'http://localhost:1234/v1'],
      ['type', 3, 'sk-typed-1'],
      ['type', 3, ''],
    ],
  },
  {

    name: 'assistant: a key and an endpoint saved while it is off list no models before consent',
    settings: 'base', device: {},
    actions: [
      ['press', 'k:settings.ai'],
      ['type', 2, 'http://localhost:1234/v1'],
      ['type', 3, 'sk-typed-2'],
    ],
  },
  {
    name: 'assistant: extra request parameters',
    settings: 'custom', device: {},
    actions: [
      ['press', 'k:settings.ai'],
      ['press', 'k:settings.aiExtraBodyParams'],
      ['type', 3, '[1, 2]'],
      ['press', 'k:settings.aiExtraBodyParamsSave'],
      ['type', 3, '{ "temperature": 0.2 }'],
      ['press', 'k:settings.aiExtraBodyParamsSave'],
      ['type', 3, '   '],
      ['press', 'k:settings.aiExtraBodyParamsSave'],
    ],
  },
  {
    name: 'assistant: Gemini thinking budget',
    settings: 'gemini', device: { secrets: { [KEY.gemini]: 'gem-key-123' }, queues: { models: [{ value: ['gemini-live-1', 'gemini-3.5-flash'] }] } },
    actions: [
      ['press', 'k:settings.ai'],
      ['press', 'k:settings.aiThinkingOff'],
      ['press', 'k:settings.aiThinkingHigh'],
      ['press', 'k:settings.aiMobile.suggestions'],
    ],
  },
  {
    name: 'assistant: Anthropic thinking',
    settings: 'anthropic', device: {},
    actions: [
      ['press', 'k:settings.ai'],
      ['switch', 1],
      ['press', 'k:settings.aiThinkingHigh'],
      ['switch', 1],
    ],
  },
  {
    name: 'assistant: live model lists and a failed list',
    settings: 'custom',
    device: { secrets: { [KEY.openai]: 'sk-live-000' }, queues: { models: [{ value: ['qwen3:8b', 'llama3.3'] }, { error: 'HTTP 500' }] } },
    actions: [
      ['press', 'k:settings.ai'],
      ['press', 'k:settings.aiMobile.suggestions'],
      ['backdrop'],
      ['type', 2, 'http://10.0.0.6:11434/v1'],
      ['press', 'k:settings.aiMobile.suggestions'],
      ['backdrop'],
      ['press', 'k:settings.aiAdvanced'],
    ],
  },
  {
    name: 'assistant: a legacy plain key moves into the secure store',
    settings: 'enabled', device: { storage: { 'mindwtr-ai-key:openai': 'sk-legacy-9' } },
    actions: [['press', 'k:settings.ai']],
  },
  {
    name: 'speech: cloud providers',
    settings: 'speech', device: {
      storage: { [CONSENT_KEY]: JSON.stringify({ openai: true, gemini: true }) },
      secrets: { [KEY.openai]: 'sk-speech' }, queues: { models: [{ value: ['whisper-1', 'gpt-4o-transcribe'] }] },
    },
    actions: [
      ['press', 'k:settings.speechTitle'],
      ['press', 'k:settings.aiMobile.suggestions'],
      ['press', 'gpt-4o-transcribe'],
      ['type', 2, 'http://stt.local:9000/v1'],
      ['type', 3, ' english '],
      ['type', 3, '   '],
      ['press', 'k:settings.speechModeSmart'],
      ['press', 'k:settings.speechFieldDescription'],
      ['press', 'k:settings.aiProviderGemini'],
      ['type', 0, 'gem-speech'],
      ['press', 'gemini-3.6-flash'],
      ['press', 'gemini-3.5-flash-lite'],
      ['switch', 0],
    ],
  },
  {
    name: 'speech: on-device Whisper',
    settings: 'whisper', device: {},
    actions: [
      ['press', 'k:settings.speechTitle'],
      ['press', 'whisper-base'],
      ['press', 'whisper-tiny.en'],
      ['press', 'k:settings.aiProviderOpenAI'],
      ['press', 'k:settings.speechProviderOffline'],
    ],
  },
  {
    name: 'foss: the local provider and Whisper only',
    settings: 'fossWrong', device: { foss: true, queues: { models: [{ value: ['qwen3:8b'] }] } },
    actions: [
      ['press', 'k:settings.ai'],
      ['switch', 0], ['switch', 0], ['alert', 'k:settings.aiConsentAgree'],
      ['type', 2, 'http://10.0.0.5:11434/v1'],
      ['press', 'k:settings.aiMobile.suggestions'],
      ['backdrop'],
      ['press', 'k:settings.speechTitle'],
    ],
  },
  {
    name: 'assistant: in German',
    settings: 'custom', device: { language: 'de' },
    actions: [['press', 'k:settings.ai'], ['press', 'k:settings.aiAdvanced'], ['press', 'k:settings.speechTitle']],
  },
];


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

function setDevice(device: Device) {
  harness.language = device.language ?? 'en';
  harness.foss = device.foss ?? false;
  (Platform as { OS: string }).OS = 'android';
  harness.storage = new Map(Object.entries(device.storage ?? {}));
  harness.secrets = new Map(Object.entries(device.secrets ?? {}));
  harness.queues = JSON.parse(JSON.stringify(device.queues ?? {}));
  harness.device.length = 0;
  harness.calls.length = 0;
  harness.toasts.length = 0;
  harness.alerts.length = 0;
  harness.openAlert = null;
  writeLog.length = 0;
}


const deepText = (node: ReactTestInstance | string | number | null | undefined | boolean): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map((child) => deepText(child as ReactTestInstance | string)).join('');
};


function hosts(root: ReactTestInstance, type: string): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Modal' && node.props.visible === false) return;
    if (String(node.type) === type) out.push(node);
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten))
  : style && typeof style === 'object' ? style as Record<string, unknown> : {});

const colorOf = (node: ReactTestInstance) => String(flatten(node.props.style).color ?? '').toLowerCase();


function textsIn(root: ReactTestInstance): unknown[] {
  const out: unknown[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Modal' && node.props.visible === false) return;
    if (String(node.type) === 'Text') {
      const text = deepText(node);
      out.push(colorOf(node) === DANGER ? ['danger', text] : text);
      return;
    }
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

const controlTexts = (node: ReactTestInstance) => hosts(node, 'Text').map((text) => deepText(text));
const controlLabel = (node: ReactTestInstance) => node.props.accessibilityLabel ?? controlTexts(node).join('|');

function readScreen(root: ReactTestInstance) {
  return {
    texts: textsIn(root),

    controls: hosts(root, 'TouchableOpacity').map((node) => {
      const first = hosts(node, 'Text')[0];
      return [controlLabel(node), first ? colorOf(first) === TINT : false];
    }),
    switches: hosts(root, 'Switch').map((node) => node.props.value),

    inputs: hosts(root, 'TextInput').map((node) => {
      const secure = node.props.secureTextEntry === true;
      const shown = String(node.props.value ?? '');
      return [node.props.placeholder ?? null, secure ? '•'.repeat(shown.length) : shown, secure];
    }),
  };
}

function drain(seen: { writes: number; device: number; toasts: number; calls: number; alerts: number }) {
  const out = {
    writes: writeLog.slice(seen.writes),
    device: normalize(harness.device.slice(seen.device)),
    toasts: normalize(harness.toasts.slice(seen.toasts)),
    calls: normalize(harness.calls.slice(seen.calls)),
    alerts: normalize(harness.alerts.slice(seen.alerts)),
  };
  seen.writes = writeLog.length;
  seen.device = harness.device.length;
  seen.toasts = harness.toasts.length;
  seen.calls = harness.calls.length;
  seen.alerts = harness.alerts.length;
  return out;
}

type Seen = Parameters<typeof drain>[0];

const observe = (root: ReactTestInstance, seen: Seen) => normalize({ ...readScreen(root), ...drain(seen) });


async function run(what: string, fn: (() => unknown) | undefined) {
  if (!fn) throw new Error(`Nothing to do for ${what}`);
  await act(async () => { await fn(); });
}

const labelText = (label: string) => (label.startsWith('k:') ? translate(label.slice(2)) : label);
const matches = (node: ReactTestInstance, label: string) => {
  const text = controlLabel(node);
  return text === label || text.split('|')[0] === label;
};

async function perform(renderer: ReactTestRenderer, action: [string, ...unknown[]]) {
  const root = renderer.root;
  const [kind, target, extra] = action;
  switch (kind) {
    case 'press': {
      const label = labelText(target as string);
      const control = hosts(root, 'TouchableOpacity').filter((node) => matches(node, label))[(extra as number | undefined) ?? 0];
      if (!control) throw new Error(`No control ${label}`);
      return run(`press ${label}`, control.props.onPress);
    }
    case 'switch': {
      const control = hosts(root, 'Switch')[target as number];
      return run('switch', () => control.props.onValueChange(!control.props.value));
    }
    case 'type':
      return run('type', () => hosts(root, 'TextInput')[target as number].props.onChangeText(extra));
    case 'alert': {
      const open = harness.openAlert;
      if (!open) throw new Error('No alert open');
      harness.openAlert = null;
      if (target === null) return run('dismiss alert', () => open.onDismiss?.());
      const button = open.buttons.find((entry) => entry.text === labelText(target as string));
      return run(`alert ${String(target)}`, () => button?.onPress?.());
    }
    case 'backdrop': {
      const modal = hosts(root, 'Modal')[0];
      return run('backdrop', modal ? hosts(modal, 'Pressable')[0]?.props.onPress : undefined);
    }
    default:
      throw new Error(`Unknown action ${String(kind)}`);
  }
}


const settle = async () => {
  for (let pass = 0; pass < 2; pass += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await flushPendingSave();
    });
  }
};

async function runScenario(scenario: Scenario) {
  await seedStore(scenario);
  setDevice(scenario.device);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AISettingsScreen />);
  });
  await settle();
  const seen: Seen = { writes: 0, device: 0, toasts: 0, calls: 0, alerts: 0 };
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

const inputs = () => normalize({ settings: SETTINGS, scenarios }) as Record<string, unknown>;

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const harnessPath = 'apps/mobile/components/settings/ai-settings-screen.parity.test.tsx';
  const changed = git('status', '--porcelain', '--untracked-files=all', '--', '../../../../apps').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => path !== harnessPath && !path.startsWith('apps/mobile/components/ai-actions.parity'));
  if (changed.length > 0) throw new Error(`Capture needs HEAD's apps/ code; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_AI_SETTINGS=1 TZ=UTC bunx vitest run components/settings/ai-settings-screen.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ was at HEAD except the parity harnesses. No React Native code imported core\'s AI settings model yet.',
    device: 'The device is stubbed: Android, not Expo Go; AsyncStorage and the secure store are the scenario\'s maps (the secure store is available); the model lists answer from the scenario\'s queue and fail when none is queued; the Whisper model store finds no downloaded model and names each model file:///whisper/<id>.bin.',
  };
}

describe('React Native Settings › AI parity fixture', () => {
  const originalOs = Platform.OS;
  const originalAlert = Alert.alert;
  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    Alert.alert = ((title: string, message?: string, buttons?: { text?: string; onPress?: () => void }[], options?: { onDismiss?: () => void }) => {
      harness.alerts.push([title, message ?? null, (buttons ?? []).map((button) => button.text ?? null)]);
      harness.openAlert = { buttons: buttons ?? [], onDismiss: options?.onDismiss };
    }) as typeof Alert.alert;
    harness.strings = { en: await loadTranslations('en'), de: await loadTranslations('de') };
  });
  afterAll(() => {
    (Platform as { OS: string }).OS = originalOs;
    Alert.alert = originalAlert;
    vi.useRealTimers();
    resetForTests();
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    if (process.env.MINDWTR_DUMP_AI_SETTINGS) writeFileSync(process.env.MINDWTR_DUMP_AI_SETTINGS, JSON.stringify(captured));
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs(), observations: captured }, null, 1)}\n`);
    }
    const { observations, provenance: _provenance, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozenInputs).toEqual(inputs());
    for (const name of Object.keys(captured)) {
      expect({ [name]: captured[name] }).toEqual({ [name]: observations[name] });
    }
    expect(Object.keys(observations)).toEqual(Object.keys(captured));
  }, 300_000);


  it('stores the FOSS corrections without writing the cloud provider back', async () => {
    await runScenario({ name: 'foss corrections', settings: 'fossWrong', device: { foss: true }, actions: [] });
    expect(writeLog.map(([, update]) => (update as { ai: { provider: string } }).ai.provider)).toEqual(['openai', 'openai']);
    expect(useTaskStore.getState().settings.ai).toMatchObject({
      provider: 'openai', model: 'llama3.2', copilotModel: 'llama3.2', speechToText: { provider: 'whisper', model: 'whisper-tiny' },
    });
  });
});
