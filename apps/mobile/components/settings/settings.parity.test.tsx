/**
 * React Native's Settings menu, General and Manage screens, replayed against the
 * frozen parity fixture (packages/core/src/settings-screens-parity.fixtures.json)
 * that core's settings models and the native host contract are tested against.
 *
 * To recapture, keep every file under apps/ at HEAD except this one, then run
 *   MINDWTR_CAPTURE_SETTINGS_SCREENS=1 TZ=UTC bunx vitest run components/settings/settings.parity.test.tsx
 * The capture refuses to run while any other file under apps/ differs from HEAD,
 * so the provenance always names the React Native code that ran. After a
 * recorded React Native fix, MINDWTR_DUMP_SETTINGS_SCREENS=<file> writes this
 * run's observations, to replace only the ones the fix changes (see provenance.recaptured).
 *
 * Each scenario renders the real screen with the real core store, drives it
 * through its own controls, and records what a user sees, what the store is
 * asked to write, and what the screen stores on the device. The device is
 * stubbed: its locale is the scenario's `systemLocale`, and its short date
 * (toLocaleDateString, for the System date format label) is core's System
 * short date for that locale, since the native host has no Intl.
 */
import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Alert } from 'react-native';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDateFormatter,
  flushPendingSave,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Area,
  type Person,
  type Project,
  type Task,
} from '@mindwtr/core';

import SettingsPage from '../../app/(drawer)/settings';
import { GeneralSettingsScreen } from './general-settings-screen';
import { ManageSettingsScreen } from './manage-settings-screen';

const FIXTURE_PATH = new URL('../../../../packages/core/src/settings-screens-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_SETTINGS_SCREENS === '1';
const NOW = '2026-09-24T14:00:00.000Z';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, Record<string, string>>,
  language: 'en',
  themeMode: 'system',
  systemLocale: 'en-US',
  params: {} as Record<string, string>,
  storage: new Map<string, string>(),
  sync: { configured: false, activity: 'idle' as 'idle' | 'syncing' },
  appSearch: { supported: false, enabled: false },
  authOutcomes: [] as string[],
  device: [] as unknown[][],
  alerts: [] as { title: string; message?: string; buttons?: { text?: string; style?: string; onPress?: () => void }[] }[],
  navigations: [] as unknown[],
  links: [] as string[],
}));

const translate = (key: string) => harness.strings[harness.language]?.[key] || harness.strings.en?.[key] || key;

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    Linking: {
      openURL: async (url: string) => {
        harness.links.push(url);
        if (url.includes('/fail')) throw new Error('cannot open');
      },
    },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('expo-router', () => {
  const router = {
    push: (target: unknown) => { harness.navigations.push(target); },
    back: () => undefined,
    replace: () => undefined,
    canGoBack: () => true,
  };
  return {
    useRouter: () => router,
    useLocalSearchParams: () => harness.params,
    usePathname: () => '/settings',
  };
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
  useLanguage: () => ({
    t: translate,
    language: harness.language,
    setLanguage: (language: string) => {
      harness.device.push(['setLanguage', language]);
      harness.language = language;
    },
    isReady: true,
  }),
}));
vi.mock('@/contexts/theme-context', () => ({
  useTheme: () => ({
    themeMode: harness.themeMode,
    setThemeMode: (mode: string) => {
      harness.device.push(['setThemeMode', mode]);
      harness.themeMode = mode;
    },
    themeStyle: 'default',
    themePreset: 'default',
    colorScheme: 'light',
    isDark: false,
    isReady: true,
  }),
}));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/lib/sync-service', () => ({
  getMobileSyncActivityState: () => harness.sync.activity,
  getMobileSyncConfigurationStatus: async () => ({ configured: harness.sync.configured }),
  subscribeMobileSyncActivityState: () => () => undefined,
}));
vi.mock('@/lib/app-search-preference', () => ({
  isAppSearchSupported: () => harness.appSearch.supported,
  readAppSearchIndexingEnabled: async () => harness.appSearch.enabled,
  writeAppSearchIndexingEnabled: async (enabled: boolean) => { harness.device.push(['writeAppSearchIndexingEnabled', enabled]); },
}));
vi.mock('@/lib/app-search-service', () => ({
  enableAppSearchIndexing: async () => { harness.device.push(['enableAppSearchIndexing']); },
  wipeAppSearchIndex: async () => { harness.device.push(['wipeAppSearchIndex']); },
}));
vi.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0 },
  getEnrolledLevelAsync: async () => 0,
  authenticateAsync: async () => ({ success: false, error: 'not_available' }),
}));
vi.mock('@/lib/mobile-app-lock', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mobile-app-lock')>('@/lib/mobile-app-lock');
  return {
    ...actual,
    authenticateWithDeviceLock: async (options: unknown) => {
      harness.device.push(['authenticate', options]);
      const outcome = harness.authOutcomes.shift();
      if (outcome === 'throw') throw new Error('biometrics crashed');
      return outcome === 'success' ? { success: true } : { success: false, reason: outcome };
    },
  };
});
// The other settings screens are not part of this fixture.
vi.mock('@/components/settings/about-settings-screen', () => ({ AboutSettingsScreen: () => null }));
vi.mock('@/components/settings/ai-settings-screen', () => ({ AISettingsScreen: () => null }));
vi.mock('@/components/settings/calendar-settings-screen', () => ({ CalendarSettingsScreen: () => null }));
vi.mock('@/components/settings/sync-settings-screen', () => ({ DataSettingsScreen: () => null, SyncSettingsScreen: () => null }));
vi.mock('@/components/settings/gtd-settings-screen', () => ({ GtdSettingsScreen: () => null }));
vi.mock('@/components/settings/notifications-settings-screen', () => ({ NotificationsSettingsScreen: () => null }));
vi.mock('@/components/settings/sandbox-settings-screen', () => ({ SandboxSettingsScreen: () => null }));
// Each lucide icon is its own component, so the menu's icons can be told apart.
vi.mock('lucide-react-native', () => {
  const icons = new Map<string, unknown>();
  return new Proxy({ __esModule: true } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (!icons.has(prop)) {
        icons.set(prop, Object.assign((props: any) => React.createElement(`Icon:${prop}`, props), { iconName: prop }));
      }
      return icons.get(prop);
    },
    has: (target, prop) => prop in target || (typeof prop !== 'symbol' && prop !== 'then'),
  });
});

// ---------------------------------------------------------------------------
// Scenario data.

const at = (day: string) => `2026-${day}T12:00:00.000Z`;
const task = (id: string, title: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id, title, status, contexts: [], tags: [], createdAt: at('09-01'), updatedAt: at('09-01'), ...extra,
});
const area = (id: string, name: string, order: number, extra: Partial<Area> = {}): Area => ({
  id, name, order, createdAt: at('09-01'), updatedAt: at('09-01'), ...extra,
});
// Every project stores the placeholder colour.
const project = (id: string, title: string, extra: Partial<Project> = {}): Project => ({
  id, title, status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: at('09-01'), updatedAt: at('09-01'), ...extra,
});
const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
  id, name, createdAt: at('09-01'), updatedAt: at('09-01'), ...extra,
});

type DataSet = { tasks: Task[]; projects: Project[]; areas: Area[]; people: Person[] };

const DATA: Record<string, DataSet> = {
  none: { tasks: [], projects: [], areas: [], people: [] },
  manage: {
    areas: [
      area('a-work', 'Work', 1, { color: '#3b82f6' }),
      area('a-home', 'Home', 0),
      area('a-gone', 'Gone', 2, { color: '#ef4444', deletedAt: at('09-10'), updatedAt: at('09-10') }),
      area('a-errands', 'Errands', 3, { color: '#10b981' }),
    ],
    projects: [
      project('p-site', 'Site', { areaId: 'a-work', tagIds: ['#web'] }),
      project('p-yard', 'Yard', { areaId: 'a-home', tagIds: ['#Garden'] }),
    ],
    people: [
      person('pe-alex', 'Alex', { note: 'QA lead', referenceLink: 'obsidian://people/alex' }),
      person('pe-bea', 'bea', { referenceLink: 'https://bea.example/fail' }),
      person('pe-cy', 'Cy', { referenceLink: 'javascript:alert(1)' }),
      person('pe-dee', 'Dee'),
      person('pe-gone', 'Gone Person', { deletedAt: at('09-10'), updatedAt: at('09-10') }),
    ],
    tasks: [
      task('t-site', 'Fix site', 'next', { projectId: 'p-site', contexts: ['@office', '@Alex'], tags: ['#web'], assignedTo: 'Alex' }),
      task('t-call', 'Call supplier', 'waiting', { contexts: ['@phone'], tags: ['#urgent'], assignedTo: 'bea' }),
      task('t-plant', 'Plant roses', 'next', { areaId: 'a-home', contexts: ['@home', '@office'], tags: ['#garden'] }),
      task('t-errand', 'Buy stamps', 'next', { areaId: 'a-errands', contexts: ['@town'] }),
      task('t-old', 'Old report', 'done', { contexts: ['@office'], tags: ['#web'], assignedTo: 'Dee', completedAt: at('09-05') }),
      task('t-trashed', 'Trashed', 'next', { contexts: ['@trash'], tags: ['#trash'], assignedTo: 'Alex', deletedAt: at('09-12'), updatedAt: at('09-12') }),
    ],
  },
};

const SETTINGS: Record<string, AppSettings> = {
  base: {},
  stored: {
    theme: 'nord',
    weekStart: 'monday',
    dateFormat: 'ymd',
    timeFormat: '24h',
    appearance: { density: 'compact', showTaskAge: true, mobileQuickAccessView: 'calendar' },
    security: { mobileAppLockEnabled: true },
  },
  mystery: { theme: 'mystery' as AppSettings['theme'] },
  synced: { lastSyncStatus: 'success', lastSyncAt: at('09-24') },
  syncError: { lastSyncStatus: 'error', lastSyncAt: at('09-24') },
  manage: {
    appearance: { density: 'compact', unassignedAreaColor: '#8b5cf6' },
    gtd: {
      viewSections: {
        someday: [
          { id: 's-trips', title: 'Trips', order: 1 },
          { id: 's-books', title: 'Books', order: 0 },
          { id: 's-ideas', title: 'Ideas', order: 2 },
        ],
      },
    },
  },
};

const ALL_OPEN = '{"areas":true,"people":true,"somedaySections":true,"contexts":true,"tags":true}';

/** What a scenario's device holds; the defaults are an English en-US phone. */
type Device = {
  language?: string;
  systemLocale?: string;
  themeMode?: string;
  storage?: Record<string, string>;
  sync?: { configured: boolean; activity: 'idle' | 'syncing' };
  appSearch?: { supported: boolean; enabled: boolean };
  authOutcomes?: string[];
  params?: Record<string, string>;
};
type Scenario = {
  name: string;
  data: string;
  settings: string;
  device: Device;
  /** Menu only: the sync badge the device's sync status resolves to (what a native host sends). */
  syncBadge?: 'hidden' | 'syncing' | 'healthy' | 'attention';
  actions: [string, ...unknown[]][];
};

const menuScenarios: Scenario[] = [
  { name: 'menu: every row, then open two', data: 'none', settings: 'base', device: {}, syncBadge: 'hidden', actions: [['tap', 'general'], ['tap', 'about']] },
  {
    name: 'menu: healthy sync and an update',
    data: 'none', settings: 'synced', syncBadge: 'healthy',
    device: { sync: { configured: true, activity: 'idle' }, storage: { 'mindwtr-update-available': 'true' } },
    actions: [],
  },
  { name: 'menu: syncing', data: 'none', settings: 'synced', syncBadge: 'syncing', device: { sync: { configured: true, activity: 'syncing' } }, actions: [] },
  { name: 'menu: sync needs attention', data: 'none', settings: 'syncError', syncBadge: 'attention', device: { sync: { configured: true, activity: 'idle' } }, actions: [] },
  {
    name: 'menu: search',
    data: 'none', settings: 'base', device: {}, syncBadge: 'hidden',
    actions: [['search', 'theme'], ['search', 'WEEK'], ['search', 'dropbox'], ['search', ' lang '], ['search', 'zzz'], ['search', '   '], ['search', 'ai']],
  },
  { name: 'menu: search in German', data: 'none', settings: 'base', device: { language: 'de', systemLocale: 'de-DE' }, syncBadge: 'hidden', actions: [['search', 'sprache'], ['search', 'xyz']] },
  { name: 'menu: the Advanced screen', data: 'none', settings: 'base', device: { params: { settingsScreen: 'advanced' } }, syncBadge: 'hidden', actions: [['tap', 'ai'], ['tap', 'calendar']] },
];

const generalScenarios: Scenario[] = [
  { name: 'general: defaults', data: 'none', settings: 'base', device: {}, actions: [['regional'], ['regional']] },
  {
    name: 'general: theme picker',
    data: 'none', settings: 'base', device: {},
    // The last pick is the choice already stored: nothing is written again.
    actions: [['open', 'theme'], ['pick', 9], ['open', 'theme'], ['pick', 4], ['open', 'theme'], ['dismiss'], ['open', 'theme'], ['pick', 4]],
  },
  { name: 'general: stored values', data: 'none', settings: 'stored', device: { themeMode: 'nord', systemLocale: 'en-GB' }, actions: [['regional'], ['open', 'quickAccess']] },
  { name: 'general: a theme stored on the device only', data: 'none', settings: 'base', device: { themeMode: 'dark' }, actions: [['open', 'theme']] },
  { name: 'general: an unknown synced theme', data: 'none', settings: 'mystery', device: { themeMode: 'mystery' }, actions: [['open', 'theme']] },
  {
    name: 'general: task age and quick access',
    data: 'none', settings: 'stored', device: { themeMode: 'nord' },
    actions: [['toggle', 'showTaskAge'], ['toggle', 'showTaskAge'], ['open', 'quickAccess'], ['pick', 3], ['open', 'quickAccess'], ['pick', 1]],
  },
  {
    name: 'general: app lock',
    data: 'none', settings: 'base', device: { authOutcomes: ['success', 'cancelled', 'unavailable', 'throw'] },
    actions: [['toggle', 'appLock'], ['toggle', 'appLock'], ['toggle', 'appLock'], ['toggle', 'appLock'], ['toggle', 'appLock']],
  },
  {
    name: 'general: app lock relock delay',
    data: 'none', settings: 'stored', device: { themeMode: 'nord' },
    // The last pick is the choice already stored: nothing is written again.
    actions: [['open', 'appLockRelock'], ['pick', 2], ['open', 'appLockRelock'], ['pick', 2], ['open', 'appLockRelock'], ['dismiss']],
  },
  {
    name: 'general: Android system search',
    data: 'none', settings: 'base', device: { appSearch: { supported: true, enabled: false } },
    actions: [['toggle', 'appSearch'], ['toggle', 'appSearch']],
  },
  { name: 'general: language', data: 'none', settings: 'base', device: {}, actions: [['open', 'language'], ['pick', 9], ['open', 'language'], ['dismiss']] },
  {
    name: 'general: regional formats',
    data: 'none', settings: 'base', device: {},
    actions: [
      ['regional'], ['open', 'weekStart'], ['pick', 2], ['open', 'dateFormat'], ['pick', 1], ['open', 'timeFormat'], ['pick', 2],
      ['open', 'weekStart'], ['pick', 0], ['open', 'dateFormat'], ['pick', 3], ['open', 'timeFormat'], ['pick', 1],
    ],
  },
  {
    name: 'general: Persian device locale',
    data: 'none', settings: 'base', device: { systemLocale: 'fa-IR' },
    actions: [['regional'], ['open', 'calendarSystem'], ['pick', 1], ['open', 'dateFormat'], ['dismiss'], ['open', 'calendarSystem'], ['pick', 0]],
  },
  { name: 'general: in German', data: 'none', settings: 'stored', device: { language: 'de', systemLocale: 'de-DE', themeMode: 'nord' }, actions: [['regional'], ['open', 'dateFormat']] },
  { name: 'general: a Saturday-first locale', data: 'none', settings: 'base', device: { systemLocale: 'ar-EG' }, actions: [['regional'], ['open', 'weekStart']] },
];

const manageScenarios: Scenario[] = [
  { name: 'manage: closed sections', data: 'manage', settings: 'manage', device: {}, actions: [] },
  { name: 'manage: stored open sections', data: 'manage', settings: 'manage', device: { storage: { 'mindwtr:settings:manage:openSections': ALL_OPEN } }, actions: [] },
  { name: 'manage: unreadable stored sections', data: 'manage', settings: 'manage', device: { storage: { 'mindwtr:settings:manage:openSections': 'not json' } }, actions: [['toggle', 'tags']] },
  { name: 'manage: toggling sections', data: 'manage', settings: 'manage', device: {}, actions: [['toggle', 'areas'], ['toggle', 'people'], ['toggle', 'areas']] },
  {
    name: 'manage: unassigned color and new areas',
    data: 'manage', settings: 'manage', device: { storage: { 'mindwtr:settings:manage:openSections': ALL_OPEN } },
    actions: [
      ['editUnassigned'], ['color', '#f97316'], ['save'],
      ['addArea'], ['save'], ['type', '  Garden  '], ['color', '#14b8a6'], ['save'],
      ['addArea'], ['type', 'x'], ['cancel'],
      ['addArea'], ['type', 'home'], ['save'],
    ],
  },
  {
    name: 'manage: editing areas',
    data: 'manage', settings: 'manage', device: { storage: { 'mindwtr:settings:manage:openSections': ALL_OPEN } },
    actions: [
      ['editArea', 'Work'], ['type', 'Office'], ['color', '#ef4444'], ['save'],
      ['editArea', 'Home'], ['save'],
      ['editArea', 'Home'], ['color', '#64748b'], ['save'],
      ['editArea', 'Errands'], ['type', ' office '], ['save'],
    ],
  },
  {
    name: 'manage: deleting an area',
    data: 'manage', settings: 'manage', device: { storage: { 'mindwtr:settings:manage:openSections': ALL_OPEN } },
    actions: [['deleteArea', 'Work'], ['alert', 'Cancel'], ['deleteArea', 'Work'], ['alert', 'Delete']],
  },
  {
    name: 'manage: people rows and links',
    data: 'manage', settings: 'manage', device: { storage: { 'mindwtr:settings:manage:openSections': '{"people":true}' } },
    actions: [['personCount', 'pe-alex'], ['personLink', 'pe-alex'], ['personLink', 'pe-bea']],
  },
  {
    name: 'manage: editing people',
    data: 'manage', settings: 'manage', device: { storage: { 'mindwtr:settings:manage:openSections': '{"people":true}' } },
    actions: [
      ['editPerson', 'pe-alex'], ['typeNote', '  QA lead '], ['typeLink', ''], ['type', 'Alexis'], ['save'],
      ['editPerson', 'pe-dee'], ['type', 'BEA'], ['save'],
      ['addPerson'], ['type', ' Eve  '], ['typeNote', 'Designer'], ['typeLink', ' https://eve.example '], ['save'],
      ['addPerson'], ['type', 'cy'], ['save'],
      ['editPerson', 'pe-cy'], ['typeNote', 'Contractor'], ['save'],
    ],
  },
  {
    name: 'manage: deleting a person',
    data: 'manage', settings: 'manage', device: { storage: { 'mindwtr:settings:manage:openSections': '{"people":true}' } },
    actions: [['deletePerson', 'pe-cy'], ['alert', 'Delete']],
  },
  {
    name: 'manage: contexts and tags',
    data: 'manage', settings: 'manage', device: { storage: { 'mindwtr:settings:manage:openSections': '{"contexts":true,"tags":true}' } },
    actions: [
      ['renameValue', '@phone'], ['type', '@office'], ['save'],
      ['renameValue', '@home'], ['save'],
      ['renameValue', '#urgent'], ['type', 'Later'], ['save'],
      ['renameValue', '@town'], ['type', ''], ['save'], ['cancel'],
      ['deleteValue', '@office'], ['alert', 'Delete'],
      ['deleteValue', '#web'], ['alert', 'Delete'],
    ],
  },
  {
    name: 'manage: someday sections',
    data: 'manage', settings: 'manage', device: { storage: { 'mindwtr:settings:manage:openSections': '{"somedaySections":true}' } },
    actions: [
      ['somedayMove', 'Books', 'down'], ['somedayRename', 'Ideas'], ['somedayType', '  Someday ideas '], ['somedaySave'],
      ['somedayDelete', 'Trips'], ['alert', 'Delete'],
    ],
  },
  { name: 'manage: empty lists', data: 'none', settings: 'base', device: { storage: { 'mindwtr:settings:manage:openSections': ALL_OPEN } }, actions: [] },
  {
    name: 'manage: in German',
    data: 'manage', settings: 'manage', device: { language: 'de', systemLocale: 'de-DE', storage: { 'mindwtr:settings:manage:openSections': ALL_OPEN } },
    actions: [['deleteArea', 'Work'], ['alert', 'Abbrechen'], ['editPerson', 'pe-alex'], ['cancel'], ['editUnassigned']],
  },
];

// ---------------------------------------------------------------------------
// The store: real data, recorded writes.

const writeLog: unknown[][] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));

const RECORDED = [
  'updateSettings', 'addArea', 'updateArea', 'deleteArea', 'addPerson', 'updatePerson', 'renamePerson', 'deletePerson',
  'renameContext', 'deleteContext', 'renameTag', 'deleteTag',
] as const;
let realActions: Record<string, (...args: any[]) => Promise<any>> | null = null;

async function seedStore(scenario: Scenario) {
  await flushPendingSave();
  resetForTests();
  const initial = useTaskStore.getState() as unknown as Record<string, (...args: any[]) => Promise<any>>;
  realActions ??= Object.fromEntries(RECORDED.map((name) => [name, initial[name]]));
  const real = realActions;
  const data = JSON.parse(JSON.stringify({ ...DATA[scenario.data], sections: [], settings: SETTINGS[scenario.settings] }));
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  useTaskStore.setState({
    ...(real as object),
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
  } as never);
  await useTaskStore.getState().fetchData({ throwOnError: true });
  await flushPendingSave();
  useTaskStore.setState(Object.fromEntries(RECORDED.map((name) => [name, async (...args: unknown[]) => {
    writeLog.push([name, ...(normalize(args) as unknown[])]);
    return real[name](...args);
  }])) as never);
}

function setDevice(device: Device) {
  harness.language = device.language ?? 'en';
  harness.systemLocale = device.systemLocale ?? 'en-US';
  harness.themeMode = device.themeMode ?? 'system';
  harness.params = device.params ?? {};
  harness.storage = new Map(Object.entries(device.storage ?? {}));
  harness.sync = device.sync ?? { configured: false, activity: 'idle' };
  harness.appSearch = device.appSearch ?? { supported: false, enabled: false };
  harness.authOutcomes = [...(device.authOutcomes ?? [])];
  harness.device.length = 0;
  harness.alerts.length = 0;
  harness.navigations.length = 0;
  harness.links.length = 0;
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
    if (String(node.type) === 'Modal' && (!modals || !node.props.visible)) return;
    if (String(node.type) === type) out.push(node);
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

/** The visible text outside modals, one entry per outermost Text, in screen order. */
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

const visibleModal = (root: ReactTestInstance) => root.findAll((node) => String(node.type) === 'Modal' && node.props.visible === true)[0] ?? null;
const pressables = (root: ReactTestInstance, modals = false) => [...hosts(root, 'TouchableOpacity', modals), ...hosts(root, 'Pressable', modals)]
  .sort((left, right) => order(root, left) - order(root, right));
function order(root: ReactTestInstance, target: ReactTestInstance): number {
  let index = 0;
  let found = -1;
  const walk = (node: ReactTestInstance) => {
    if (found >= 0) return;
    if (node === target) { found = index; return; }
    index += 1;
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return found;
}
const byTestId = (root: ReactTestInstance, testID: string) => root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID)[0];
const iconName = (node: ReactTestInstance, skip?: string) => node.findAll((child) => String(child.type) === 'Icon' && child.props.name !== skip)[0]?.props.name ?? null;

function drain(seen: { writes: number; device: number; alerts: number; navigations: number; links: number }) {
  const out = {
    writes: writeLog.slice(seen.writes),
    device: normalize(harness.device.slice(seen.device)),
    alerts: harness.alerts.slice(seen.alerts).map((alert) => [
      alert.title, alert.message ?? null, (alert.buttons ?? []).map((button) => [button.text ?? null, button.style ?? null]),
    ]),
    navigations: normalize(harness.navigations.slice(seen.navigations)),
    links: harness.links.slice(seen.links),
  };
  seen.writes = writeLog.length;
  seen.device = harness.device.length;
  seen.alerts = harness.alerts.length;
  seen.navigations = harness.navigations.length;
  seen.links = harness.links.length;
  return out;
}

type Seen = Parameters<typeof drain>[0];

function observeMenu(root: ReactTestInstance, seen: Seen) {
  const items = root.findAll((node) => typeof node.type === 'function' && (node.type as { name?: string }).name === 'MenuItem');
  const groups: unknown[][] = [[]];
  for (const item of items) {
    const button = hosts(item, 'TouchableOpacity')[0];
    groups[groups.length - 1].push([
      item.props.title,
      item.props.description ?? null,
      (item.props.icon as { iconName?: string } | undefined)?.iconName ?? null,
      item.props.showIndicator === true,
      item.props.indicatorColor ?? null,
      button.props.accessibilityLabel,
    ]);
    if (item.props.isLast) groups.push([]);
  }
  const search = hosts(root, 'TextInput')[0];
  const { writes: _writes, ...rest } = drain(seen);
  return normalize({
    texts: textsIn(root),
    search: search ? [search.props.placeholder, search.props.value] : null,
    groups: groups.filter((group) => group.length > 0),
    ...rest,
  });
}

function observeGeneral(root: ReactTestInstance, seen: Seen) {
  const modal = visibleModal(root);
  let picker: unknown = null;
  if (modal) {
    const list = hosts(modal, 'ScrollView', true)[0];
    const groups: unknown[][] = [[]];
    for (const child of list.children) {
      if (typeof child === 'string') continue;
      // The divider before the styled themes is a plain View.
      if ((child.type as { displayName?: string }).displayName === 'View') {
        groups.push([]);
        continue;
      }
      groups[groups.length - 1].push([
        textsIn(child, true).join(''),
        child.findAll((node) => String(node.type) === 'Icon' && node.props.name === 'checkmark').length > 0,
        iconName(child, 'checkmark'),
      ]);
    }
    picker = { title: textsIn(modal, true)[0], groups };
  }
  const toggle = byTestId(root, 'regional-formats-toggle');
  return normalize({
    texts: textsIn(root),
    switches: hosts(root, 'Switch').map((node) => [node.props.value, node.props.disabled === true]),
    expanded: toggle.props.accessibilityState?.expanded === true,
    picker,
    ...drain(seen),
  });
}

function observeManage(root: ReactTestInstance, seen: Seen) {
  const modal = visibleModal(root);
  let editor: unknown = null;
  if (modal) {
    const save = byTestId(modal, 'manage-editor-save');
    editor = {
      title: textsIn(modal, true)[0],
      inputs: hosts(modal, 'TextInput', true).map((input) => [input.props.testID ?? null, input.props.placeholder, input.props.value]),
      colors: pressables(modal, true)
        .filter((node) => String(node.props.accessibilityLabel ?? '').includes(': #'))
        .map((node) => [String(node.props.accessibilityLabel).split(': ').pop(), node.findAll((child) => String(child.type) === 'Icon' && child.props.name === 'checkmark').length > 0]),
      buttons: [textsIn(modal, true).slice(-2), save.props.disabled === true],
    };
  }
  return normalize({
    texts: textsIn(root),
    labels: pressables(root)
      .filter((node) => node.props.accessibilityLabel)
      .map((node) => [node.props.accessibilityLabel, node.props.disabled === true]),
    fields: hosts(root, 'TextInput').map((input) => [input.props.accessibilityLabel ?? null, input.props.value]),
    editor,
    ...drain(seen),
  });
}

// ---------------------------------------------------------------------------
// Driving the screens.

const MENU_TITLE_KEYS: Record<string, string> = {
  general: 'settings.general', gtd: 'settings.gtd', manage: 'settings.manage', notifications: 'settings.notifications',
  sync: 'settings.sync', data: 'settings.data', advanced: 'settings.advanced', about: 'settings.about', ai: 'settings.ai', calendar: 'settings.calendar',
};
const GENERAL_ROW_KEYS: Record<string, string> = {
  theme: 'settings.theme', quickAccess: 'settings.mobile.quickAccessView', appLockRelock: 'settings.mobile.appLockRelock', language: 'settings.language',
  weekStart: 'settings.weekStart', dateFormat: 'settings.dateFormat', calendarSystem: 'settings.calendarSystem', timeFormat: 'settings.timeFormat',
};
const GENERAL_SWITCHES: Record<string, number> = { showTaskAge: 0, appLock: 1, appSearch: 2 };

async function run(what: string, fn: (() => unknown) | undefined) {
  if (!fn) throw new Error(`Nothing to do for ${what}`);
  await act(async () => { await fn(); });
}

/** The row (a View) holding a Text with exactly this text, and its buttons. */
function rowButtons(root: ReactTestInstance, text: string): ReactTestInstance[] {
  const label = hosts(root, 'Text').find((node) => deepText(node) === text);
  let row = label?.parent ?? null;
  while (row && String(row.type) !== 'View') row = row.parent;
  if (!row) throw new Error(`No row ${text}`);
  return hosts(row, 'TouchableOpacity');
}

async function perform(renderer: ReactTestRenderer, action: [string, ...unknown[]]) {
  const root = renderer.root;
  const [kind, target, extra] = action;
  const modal = () => visibleModal(root);
  const labelled = (label: string) => pressables(root).find((node) => node.props.accessibilityLabel === label);
  switch (kind) {
    // Menu
    case 'search':
      return run('search', () => hosts(root, 'TextInput')[0].props.onChangeText(target));
    case 'tap': {
      const title = translate(MENU_TITLE_KEYS[target as string]);
      const item = root.findAll((node) => typeof node.type === 'function' && (node.type as { name?: string }).name === 'MenuItem' && node.props.title === title)[0];
      return run('tap', item?.props.onPress);
    }
    // General
    case 'regional':
      return run('regional formats', byTestId(root, 'regional-formats-toggle').props.onPress);
    case 'open': {
      const label = translate(GENERAL_ROW_KEYS[target as string]);
      return run(`open ${String(target)}`, hosts(root, 'TouchableOpacity').find((node) => textsIn(node)[0] === label)?.props.onPress);
    }
    case 'pick': {
      const options = hosts(hosts(modal()!, 'ScrollView', true)[0], 'TouchableOpacity', true);
      return run('pick', options[target as number]?.props.onPress);
    }
    case 'dismiss':
      return run('dismiss', hosts(modal()!, 'Pressable', true)[0]?.props.onPress);
    case 'toggle': {
      if (typeof target === 'string' && target in GENERAL_SWITCHES) {
        const control = hosts(root, 'Switch')[GENERAL_SWITCHES[target]];
        return run('switch', () => control.props.onValueChange(!control.props.value));
      }
      const id = target === 'somedaySections' ? 'someday-sections' : target;
      return run('section', byTestId(root, `manage-section-toggle-${String(id)}`)?.props.onPress);
    }
    // Manage
    case 'editUnassigned':
      return run('unassigned', hosts(byTestId(root, 'manage-unassigned-area-color'), 'TouchableOpacity')[0]?.props.onPress);
    case 'editArea':
    case 'renameValue':
      return run(kind, rowButtons(root, target as string)[0]?.props.onPress);
    case 'deleteArea':
    case 'deleteValue':
      return run(kind, rowButtons(root, target as string).at(-1)?.props.onPress);
    case 'addArea':
      return run('add area', byTestId(root, 'manage-area-add')?.props.onPress);
    case 'addPerson':
      return run('add person', byTestId(root, 'manage-person-add')?.props.onPress);
    case 'editPerson':
      return run('edit person', byTestId(root, `manage-person-edit-${String(target)}`)?.props.onPress);
    case 'personCount':
      return run('person count', byTestId(root, `manage-person-review-${String(target)}`)?.props.onPress);
    case 'deletePerson':
    case 'personLink': {
      const label = kind === 'deletePerson' ? translate('common.delete') : 'Open reference link';
      const row = byTestId(root, `manage-person-row-${String(target)}`);
      return run(kind, pressables(row).find((node) => node.props.accessibilityLabel === label)?.props.onPress);
    }
    case 'type': {
      const input = hosts(modal()!, 'TextInput', true).find((node) => node.props.testID !== 'manage-person-note-input' && node.props.testID !== 'manage-person-reference-input');
      return run('type', () => input!.props.onChangeText(target));
    }
    case 'typeNote':
    case 'typeLink': {
      const input = byTestId(modal()!, kind === 'typeNote' ? 'manage-person-note-input' : 'manage-person-reference-input');
      return run(kind, () => input.props.onChangeText(target));
    }
    case 'color':
      return run('color', pressables(modal()!, true).find((node) => String(node.props.accessibilityLabel).endsWith(`: ${String(target)}`))?.props.onPress);
    case 'save': {
      const save = byTestId(modal()!, 'manage-editor-save');
      // A disabled Save cannot be pressed.
      if (save.props.disabled) return undefined;
      return run('save', save.props.onPress);
    }
    case 'cancel':
      return run('cancel', hosts(modal()!, 'TouchableOpacity', true).find((node) => textsIn(node, true)[0] === translate('common.cancel'))?.props.onPress);
    case 'alert': {
      const alert = harness.alerts.at(-1);
      const button = alert?.buttons?.find((entry) => entry.text === target);
      if (!button) throw new Error(`No alert button ${String(target)}`);
      return run('alert', () => button.onPress?.());
    }
    case 'somedayMove':
      return run('move', labelled(`${translate(extra === 'up' ? 'projects.moveUp' : 'projects.moveDown')}: ${String(target)}`)?.props.onPress);
    case 'somedayRename':
      return run('rename', labelled(`${translate('viewSections.rename')}: ${String(target)}`)?.props.onPress);
    case 'somedayType':
      return run('type', () => hosts(root, 'TextInput')[0].props.onChangeText(target));
    case 'somedaySave':
      return run('save', labelled(translate('common.save'))?.props.onPress);
    case 'somedayDelete':
      return run('delete', labelled(`${translate('common.delete')}: ${String(target)}`)?.props.onPress);
    default:
      throw new Error(`Unknown action ${String(kind)}`);
  }
}

const settle = async () => {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await flushPendingSave();
  });
};

async function runScenario(scenario: Scenario, screen: 'menu' | 'general' | 'manage') {
  await seedStore(scenario);
  setDevice(scenario.device);
  const observe = screen === 'menu' ? observeMenu : screen === 'general' ? observeGeneral : observeManage;
  const element = screen === 'menu' ? <SettingsPage /> : screen === 'general' ? <GeneralSettingsScreen /> : <ManageSettingsScreen />;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(element); });
  await settle();
  const seen: Seen = { writes: 0, device: 0, alerts: 0, navigations: 0, links: 0 };
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

const inputs = () => normalize({
  now: NOW,
  timeZone: 'UTC',
  data: DATA,
  settings: SETTINGS,
  menu: menuScenarios,
  general: generalScenarios,
  manage: manageScenarios,
}) as Record<string, unknown>;

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const harnessPath = 'apps/mobile/components/settings/settings.parity.test.tsx';
  const changed = git('status', '--porcelain', '--untracked-files=all', '--', '../../../../apps').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => path !== harnessPath);
  if (changed.length > 0) throw new Error(`Capture needs HEAD's apps/ code; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_SETTINGS_SCREENS=1 TZ=UTC bunx vitest run components/settings/settings.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ was at HEAD except this harness. packages/core held the new settings models and contract block, which no React Native code imported yet.',
    device: 'The device is stubbed: navigator.language and Intl.DateTimeFormat().resolvedOptions().locale are the scenario systemLocale, and Date.prototype.toLocaleDateString is core\'s System short date (createDateFormatter with dateFormat system) for that locale and the stored settings.',
  };
}

describe('React Native settings screens parity fixture', () => {
  const originalTz = process.env.TZ;
  const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    Alert.alert = (title: string, message?: string, buttons?: { text?: string; style?: string; onPress?: () => void }[]) => {
      harness.alerts.push({ title, message, buttons });
    };
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    vi.stubGlobal('navigator', {
      get language() { return harness.systemLocale; },
      get languages() { return [harness.systemLocale]; },
    });
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function resolvedOptions(this: Intl.DateTimeFormat) {
      return { ...originalResolvedOptions.call(this), locale: harness.systemLocale };
    });
    vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function toLocaleDateString(this: Date) {
      const settings = useTaskStore.getState().settings;
      return createDateFormatter({
        language: settings.language || harness.language,
        dateFormat: 'system',
        calendarSystem: settings.calendarSystem,
        timeFormat: settings.timeFormat,
        systemLocale: harness.systemLocale,
      })(this, 'P');
    });
    harness.strings = { en: await loadTranslations('en'), de: await loadTranslations('de') };
  });
  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of menuScenarios) captured[scenario.name] = await runScenario(scenario, 'menu');
    for (const scenario of generalScenarios) captured[scenario.name] = await runScenario(scenario, 'general');
    for (const scenario of manageScenarios) captured[scenario.name] = await runScenario(scenario, 'manage');
    // Writes this run's observations to a file, to replace only the ones a fix changes.
    if (process.env.MINDWTR_DUMP_SETTINGS_SCREENS) writeFileSync(process.env.MINDWTR_DUMP_SETTINGS_SCREENS, JSON.stringify(captured));
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
