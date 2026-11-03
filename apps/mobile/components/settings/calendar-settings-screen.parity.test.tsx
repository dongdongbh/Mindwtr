


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

import { stopCalendarPushSync } from '@/lib/calendar-push-sync';
import { CalendarSettingsScreen } from './calendar-settings-screen';

const FIXTURE_PATH = new URL('../../../../packages/core/src/calendar-settings-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_CALENDAR_SETTINGS === '1';
const NOW = '2026-09-24T14:00:00.000Z';

type DeviceCalendar = {
  id: string;
  title?: string;
  name?: string;
  color?: string;
  ownerAccount?: string;
  accessLevel?: string;
  allowsModifications?: boolean;
  source?: { id?: string; name?: string; type?: string; isLocalAccount?: boolean };
};

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, Record<string, string>>,
  language: 'en',
  storage: new Map<string, string>(),
  permission: 'granted' as string,
  requestAnswer: 'granted' as string,
  calendars: [] as DeviceCalendar[],
  events: {} as Record<string, unknown[]>,
  failEvents: false,
  feeds: {} as Record<string, string | { error: string }>,
  picks: [] as unknown[],
  nextCalendar: 0,
  nextId: 0,
  calendarWrites: [] as unknown[][],
  prompts: [] as unknown[],
  toasts: [] as unknown[][],
  alert: null as null | { title: string; message: string; buttons: { text: string; style?: string; onPress?: () => void }[] },
}));

const translate = (key: string) => harness.strings[harness.language]?.[key] || harness.strings.en?.[key] || key;

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();

  actual.Platform.OS = 'android';
  return {
    ...actual,
    Alert: {
      alert: (title: string, message: string, buttons: { text: string; style?: string; onPress?: () => void }[]) => {
        harness.alert = { title, message, buttons };
      },
    },
  };
});
vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    generateUUID: () => {
      harness.nextId += 1;
      return `00000000-0000-4000-8000-${String(harness.nextId).padStart(12, '0')}`;
    },
  };
});
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
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => harness.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { harness.storage.set(key, value); },
    removeItem: async (key: string) => { harness.storage.delete(key); },
  },
}));
vi.mock('expo-calendar', () => {
  const find = (id: string) => harness.calendars.findIndex((calendar) => calendar.id === id);
  return {
    EntityTypes: { EVENT: 'event' },
    SourceType: { LOCAL: 'local', CALDAV: 'caldav' },
    CalendarAccessLevel: {
      CONTRIBUTOR: 'contributor', EDITOR: 'editor', FREEBUSY: 'freebusy', OVERRIDE: 'override', OWNER: 'owner',
      READ: 'read', RESPOND: 'respond', ROOT: 'root', NONE: 'none',
    },
    getCalendarPermissionsAsync: async () => ({ status: harness.permission }),
    requestCalendarPermissionsAsync: async () => {
      harness.prompts.push('calendar');
      harness.permission = harness.requestAnswer;
      return { status: harness.requestAnswer };
    },
    getCalendarsAsync: async () => harness.calendars.map((calendar) => ({ ...calendar })),
    getSourcesAsync: async () => [],
    getEventsAsync: async (ids: string[]) => {
      if (harness.failEvents) throw new Error('Calendar provider unavailable');
      return ids.flatMap((id) => harness.events[id] ?? []);
    },
    createCalendarAsync: async (details: Record<string, unknown>) => {
      harness.nextCalendar += 1;
      const id = `created-${harness.nextCalendar}`;

      harness.calendarWrites.push(['createCalendar', { ...details, ...(typeof details.name === 'string' ? { name: details.name.replace(/[0-9a-f-]{36}$/, '<marker>') } : {}) }]);
      harness.calendars.push({ ...(details as DeviceCalendar), id, allowsModifications: true });
      return id;
    },
    updateCalendarAsync: async (id: string, details: Record<string, unknown>) => {
      harness.calendarWrites.push(['updateCalendar', id, details]);
      return id;
    },
    deleteCalendarAsync: async (id: string) => {
      harness.calendarWrites.push(['deleteCalendar', id]);
      const index = find(id);
      if (index >= 0) harness.calendars.splice(index, 1);
    },
    createEventAsync: async (calendarId: string, details: Record<string, unknown>) => {
      harness.calendarWrites.push(['createEvent', calendarId, details.title]);
      return 'event-1';
    },
    updateEventAsync: async (id: string) => { harness.calendarWrites.push(['updateEvent', id]); },
    deleteEventAsync: async (id: string) => { harness.calendarWrites.push(['deleteEvent', id]); },
    editEventInCalendarAsync: async () => undefined,
    openEventInCalendarAsync: async () => undefined,
  };
});
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => {
    const pick = harness.picks.shift() ?? null;
    return pick ? { canceled: false, assets: [pick] } : { canceled: true, assets: [] };
  },
}));
vi.mock('@/lib/file-system', () => {
  const read = async (uri: string) => {
    const feed = harness.feeds[uri];
    if (feed === undefined || typeof feed !== 'string') throw new Error(`Unreadable ${uri}`);
    return feed;
  };
  return { readAsStringAsync: read, StorageAccessFramework: { readAsStringAsync: read } };
});
vi.mock('@/lib/storage-adapter', () => ({
  ensureCalendarSyncStorageReady: async () => undefined,
  getCalendarSyncEntry: async () => null,
  upsertCalendarSyncEntry: async () => undefined,
  deleteCalendarSyncEntry: async () => undefined,
  getAllCalendarSyncEntries: async () => [],
}));
vi.mock('@/lib/app-log', () => ({
  logInfo: async () => undefined,
  logWarn: async () => undefined,
  logError: async () => undefined,
}));
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: translate, language: harness.language, setLanguage: () => undefined, isReady: true }),
}));
vi.mock('@/contexts/theme-context', () => ({
  useTheme: () => ({ themePreset: 'default', themeMode: 'light', isDark: false }),
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

vi.mock('@/contexts/toast-context', () => {
  const toast = {
    showToast: (entry: { title?: string; message: string; tone?: string; durationMs?: number }) => {
      harness.toasts.push([entry.title ?? null, entry.message, entry.tone ?? null, entry.durationMs ?? null]);
    },
    dismissToast: () => undefined,
  };
  return { useToast: () => toast };
});


const at = (day: string) => `2026-${day}T12:00:00.000Z`;
const area = (id: string, name: string, order: number, extra: Partial<Area> = {}): Area => ({
  id, name, order, createdAt: at('09-01'), updatedAt: at('09-01'), ...extra,
});

const AREAS: Area[] = [
  area('a-work', 'Work', 0, { color: '#3b82f6' }),
  area('a-home', 'Home', 1),
  area('a-gone', 'Gone', 2, { deletedAt: at('09-10'), updatedAt: at('09-10') }),
];

const google = { name: 'alex@gmail.com', type: 'com.google', isLocalAccount: false };
const CALENDARS: Record<string, DeviceCalendar> = {
  primary: { id: 'g-primary', title: 'alex@gmail.com', color: '#039BE5', ownerAccount: 'alex@gmail.com', accessLevel: 'owner', allowsModifications: true, source: google },
  holidays: { id: 'g-holidays', title: 'Holidays', color: '#0B8043', ownerAccount: 'alex@gmail.com', accessLevel: 'read', allowsModifications: false, source: google },
  phone: { id: 'local-phone', title: 'Phone', color: '#F4511E', ownerAccount: 'local account', accessLevel: 'owner', allowsModifications: true, source: { name: 'local account', type: 'LOCAL', isLocalAccount: true } },
  managed: { id: 'g-mindwtr', title: 'Mindwtr', name: 'mindwtr', color: '#3B82F6', ownerAccount: 'alex@gmail.com', accessLevel: 'owner', allowsModifications: true, source: google },
  managedLocal: { id: 'l-mindwtr', title: 'Mindwtr', name: 'mindwtr', color: '#3B82F6', ownerAccount: 'local account', accessLevel: 'owner', allowsModifications: true, source: { name: 'local account', type: 'LOCAL', isLocalAccount: true } },
};

const EVENTS: Record<string, unknown[]> = {
  'g-primary': [
    { id: 'e-standup', calendarId: 'g-primary', title: 'Stand-up', startDate: '2026-09-10T09:00:00.000Z', endDate: '2026-09-10T09:15:00.000Z', allDay: false },
    { id: 'e-offsite', calendarId: 'g-primary', title: 'Offsite', startDate: '2026-09-21T00:00:00.000Z', endDate: '2026-09-23T00:00:00.000Z', allDay: true },
  ],
  'local-phone': [
    { id: 'e-dentist', calendarId: 'local-phone', title: 'Dentist', startDate: '2026-09-15T14:00:00.000Z', endDate: '2026-09-15T15:00:00.000Z', allDay: false },
  ],
};

const TEAM_URL = 'https://alex:s3cret@calendar.example.com/team/basic.ics';
const LOCAL_URI = 'content://com.android.providers.downloads.documents/document/42';
const ics = (events: [string, string, string][]) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
  ...events.flatMap(([uid, start, summary]) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${start}`, `DTEND:${start.replace(/T(\d\d)/, (_m, hour) => `T${String(Number(hour) + 1).padStart(2, '0')}`)}`, `SUMMARY:${summary}`, 'END:VEVENT']),
  'END:VCALENDAR',
].join('\r\n');
const FEEDS: Record<string, string | { error: string }> = {
  [TEAM_URL]: ics([['t1', '20260903T100000Z', 'Planning'], ['t2', '20260917T100000Z', 'Review'], ['t3', '20261105T100000Z', 'Later']]),
  [LOCAL_URI]: ics([['l1', '20260911T080000Z', 'Local one']]),
};

const feed = (id: string, name: string, url: string, extra: Record<string, unknown> = {}) => ({ id, name, url, enabled: true, ...extra });
const FEED_A = feed('feed-a', 'Team', TEAM_URL);
const FEED_B = feed('feed-b', 'Holidays feed', 'https://example.org/holidays.ics', { enabled: false, color: '#059669', areaIds: ['a-home'] });

const SETTINGS: Record<string, AppSettings> = {
  base: {},
  synced: { externalCalendars: [FEED_A, FEED_B] } as AppSettings,
  syncedEmpty: { externalCalendars: [] } as AppSettings,
};

const KEYS = {
  feeds: 'mindwtr-external-calendars',
  system: 'mindwtr-system-calendar-settings',
  pushEnabled: 'mindwtr:calendar-push-sync:enabled',
  pushCalendar: 'mindwtr:calendar-push-sync:calendar-id',
  pushTarget: 'mindwtr:calendar-push-sync:target-calendar-id',
  pushColor: 'mindwtr:calendar-push-sync:color',
};

type Device = {
  language?: string;
  storage?: Record<string, string>;
  permission?: 'granted' | 'denied' | 'undetermined';
  requestAnswer?: 'granted' | 'denied';
  calendars?: string[];
  failEvents?: boolean;
  picks?: ({ name: string; uri: string } | null)[];
};


type Scenario = { name: string; settings: string; device: Device; actions: [string, ...unknown[]][] };

const systemSettings = (value: Record<string, unknown>) => JSON.stringify(value);

const scenarios: Scenario[] = [
  {
    name: 'defaults: nothing stored',
    settings: 'base', device: { permission: 'undetermined', calendars: ['primary', 'holidays', 'phone'] },
    actions: [
      ['press', 'k:settings.calendarMobile.pushTasksToCalendar'],
      ['press', 'k:settings.deviceCalendars'],
      ['press', 'k:settings.calendarMobile.pushTasksToCalendar'],
    ],
  },
  {
    name: 'push: turn on, choose targets, refresh',
    settings: 'base', device: { permission: 'undetermined', requestAnswer: 'granted', calendars: ['primary', 'holidays', 'phone'] },
    actions: [
      ['switch', 0],
      ['press', 'alex@gmail.com. k:settings.calendarMobile.sharedAccountCalendar · alex@gmail.com'],
      ['press', 'alex@gmail.com. k:settings.calendarMobile.sharedAccountCalendar · alex@gmail.com'],
      ['press', 'Phone. k:settings.calendarMobile.sharedLocalCalendar · local account'],
      ['press', 'k:settings.calendarMobile.refreshCalendars'],
      ['press', 'k:settings.calendarMobile.deleteMindwtrCalendar'],
      ['alert', 'k:common.delete'],
    ],
  },
  {
    name: 'push: access denied',
    settings: 'base', device: { permission: 'undetermined', requestAnswer: 'denied', calendars: ['primary'] },
    actions: [['switch', 0], ['press', 'k:settings.calendarMobile.pushTasksToCalendar']],
  },
  {
    name: 'push: stored on, access revoked since',
    settings: 'base', device: { permission: 'denied', calendars: ['primary'], storage: { [KEYS.pushEnabled]: '1', [KEYS.pushTarget]: 'g-primary' } },
    actions: [['press', 'k:settings.calendarMobile.pushTasksToCalendar']],
  },
  {
    name: 'push: the managed calendar, a new color, then off',
    settings: 'base',
    device: { calendars: ['primary', 'managed', 'phone'], storage: { [KEYS.pushEnabled]: '1', [KEYS.pushCalendar]: 'g-mindwtr', [KEYS.pushColor]: '#7c3aed' } },
    actions: [
      ['press', 'k:settings.calendarMobile.pushTasksToCalendar'],
      ['press', 'Mindwtr calendar color #059669'],
      ['press', 'Mindwtr calendar color #059669'],
      ['switch', 0],
      ['press', 'k:settings.calendarMobile.pushTasksToCalendar'],
    ],
  },
  {
    name: 'push: a local dedicated calendar and an odd stored color',
    settings: 'base',
    device: { calendars: ['primary', 'managedLocal'], storage: { [KEYS.pushEnabled]: '1', [KEYS.pushColor]: 'teal' } },
    actions: [['press', 'k:settings.calendarMobile.pushTasksToCalendar']],
  },
  {
    name: 'push: delete the Mindwtr calendar',
    settings: 'base',
    device: { calendars: ['primary', 'managed'], storage: { [KEYS.pushEnabled]: '1', [KEYS.pushCalendar]: 'g-mindwtr', [KEYS.pushTarget]: 'g-mindwtr' } },
    actions: [
      ['press', 'k:settings.calendarMobile.pushTasksToCalendar'],
      ['press', 'k:settings.calendarMobile.deleteMindwtrCalendar'],
      ['alert', 'k:common.cancel'],
      ['press', 'k:settings.calendarMobile.deleteMindwtrCalendar'],
      ['alert', 'k:common.delete'],
      ['press', 'k:settings.calendarMobile.pushTasksToCalendar'],
    ],
  },
  {
    name: 'device calendars: turn on, grant, choose calendars and areas',
    settings: 'base', device: { permission: 'undetermined', requestAnswer: 'granted', calendars: ['primary', 'holidays', 'managed', 'phone'] },
    actions: [
      ['switch', 1],
      ['switch', 3],
      ['switch', 2],
      ['switch', 3],
      ['press', 'k:settings.calendarShowInAreas', 1],
      ['press', 'Work'],
      ['press', 'Home'],
      ['press', 'Work'],
      ['press', 'k:settings.calendarShowInAreas', 1],
      ['switch', 1],
    ],
  },
  {
    name: 'device calendars: access denied',
    settings: 'base', device: { permission: 'denied', requestAnswer: 'denied', calendars: ['primary'], storage: { [KEYS.system]: systemSettings({ enabled: true, selectAll: true, selectedCalendarIds: [] }) } },
    actions: [['press', 'k:settings.deviceCalendars'], ['press', 'k:settings.grantCalendarAccess'], ['switch', 1], ['switch', 1]],
  },
  {
    name: 'device calendars: a stored selection loses a missing calendar',
    settings: 'base',
    device: {
      calendars: ['primary', 'holidays', 'phone'],
      storage: { [KEYS.system]: systemSettings({ enabled: true, selectAll: false, selectedCalendarIds: ['g-holidays', 'gone-calendar'], areaIdsByCalendar: { 'g-holidays': ['a-work', 'a-gone'] } }) },
    },
    actions: [['press', 'k:settings.deviceCalendars'], ['switch', 2], ['switch', 3]],
  },
  {
    name: 'device calendars: none on the device',
    settings: 'base', device: { calendars: ['managed'], storage: { [KEYS.system]: systemSettings({ enabled: true }) } },
    actions: [['press', 'k:settings.deviceCalendars']],
  },
  {
    name: 'feeds: add, test, toggle, color, areas, remove',
    settings: 'base', device: { calendars: ['primary'] },
    actions: [
      ['type', 1, '   '],
      ['press', 'k:settings.externalCalendarAdd'],
      ['type', 0, '  Team  '],
      ['type', 1, ` ${TEAM_URL} `],
      ['press', 'k:settings.externalCalendarAdd'],
      ['press', 'k:settings.calendarMobile.test'],
      ['type', 1, 'https://example.org/second.ics'],
      ['press', 'k:settings.externalCalendarAdd'],
      ['switch', 2],
      ['press', 'Team #DB2777'],
      ['press', 'Team k:taskEdit.textDirection.auto'],
      ['press', 'k:settings.calendarShowInAreas', 0],
      ['press', 'Home'],
      ['press', 'k:settings.calendarShowInAreas', 1],
      ['press', 'k:settings.externalCalendarRemove', 0],
    ],
  },
  {
    name: 'feeds: a local file, a cancelled pick, a failed test',
    settings: 'base',
    device: {
      calendars: ['primary'], failEvents: true, picks: [{ name: 'Team plan.ICS', uri: LOCAL_URI }, null],
      storage: { [KEYS.system]: systemSettings({ enabled: true, selectAll: true, selectedCalendarIds: [] }) },
    },
    actions: [
      ['press', 'k:settings.calendarMobile.chooseLocalIcsFile'],
      ['press', 'k:settings.calendarMobile.chooseLocalIcsFile'],
      ['press', 'k:settings.calendarMobile.test'],
    ],
  },
  {
    name: 'feeds: the synced list wins over the device copy',
    settings: 'synced', device: { calendars: [], storage: { [KEYS.feeds]: JSON.stringify([feed('feed-old', 'Old', 'https://old.example/cal.ics')]) } },
    actions: [['switch', 3], ['press', 'Holidays feed #059669']],
  },
  {
    name: 'feeds: an empty synced list clears the device copy',
    settings: 'syncedEmpty', device: { calendars: [], storage: { [KEYS.feeds]: JSON.stringify([feed('feed-old', 'Old', 'https://old.example/cal.ics')]) } },
    actions: [],
  },
  {
    name: 'feeds: stored on the device only',
    settings: 'base', device: { calendars: [], storage: { [KEYS.feeds]: JSON.stringify([feed('feed-old', ' Old ', ' https://old.example/cal.ics ', { color: 'not-a-color' })]) } },
    actions: [['press', 'k:settings.calendarMobile.test']],
  },
  {
    name: 'in Chinese: push on and a test',
    settings: 'synced',
    device: { language: 'zh', calendars: ['primary', 'phone'], storage: { [KEYS.system]: systemSettings({ enabled: true }) } },
    actions: [['switch', 0], ['press', 'k:settings.calendarMobile.test'], ['press', 'k:settings.deviceCalendars']],
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
  harness.permission = device.permission ?? 'granted';
  harness.requestAnswer = device.requestAnswer ?? 'granted';
  harness.calendars = (device.calendars ?? []).map((key) => ({ ...CALENDARS[key], source: CALENDARS[key].source ? { ...CALENDARS[key].source } : undefined }));
  harness.events = EVENTS;
  harness.failEvents = device.failEvents === true;
  harness.feeds = FEEDS;
  harness.picks = [...(device.picks ?? [])];
  harness.nextCalendar = 0;
  harness.nextId = 0;
  harness.calendarWrites.length = 0;
  harness.prompts.length = 0;
  harness.toasts.length = 0;
  harness.alert = null;
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
    if (String(node.type) === type) out.push(node);
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}


function textsIn(root: ReactTestInstance): string[] {
  const out: string[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Text') {
      out.push(deepText(node));
      return;
    }
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

const controlLabel = (node: ReactTestInstance) => node.props.accessibilityLabel ?? textsIn(node).join('|');


function controlSelected(node: ReactTestInstance): boolean | null {
  const state = node.props.accessibilityState;
  if (typeof state?.selected === 'boolean') return state.selected;
  if (typeof state?.checked === 'boolean') return state.checked;
  return node.findAll((child) => String(child.type) === 'Icon' && child.props.name === 'checkmark').length > 0 ? true : null;
}

function snapshotStorage() {
  return Object.fromEntries(Object.values(KEYS).filter((key) => harness.storage.has(key)).map((key) => [key, harness.storage.get(key)]));
}

type Seen = { writes: number; calendarWrites: number; prompts: number; toasts: number };

function drain(seen: Seen) {
  const out = {
    writes: writeLog.slice(seen.writes),
    calendarWrites: normalize(harness.calendarWrites.slice(seen.calendarWrites)),
    prompts: harness.prompts.length - seen.prompts,
    toasts: normalize(harness.toasts.slice(seen.toasts)),
  };
  seen.writes = writeLog.length;
  seen.calendarWrites = harness.calendarWrites.length;
  seen.prompts = harness.prompts.length;
  seen.toasts = harness.toasts.length;
  return out;
}

function observe(root: ReactTestInstance, seen: Seen) {
  return normalize({
    texts: textsIn(root),
    controls: hosts(root, 'TouchableOpacity').map((node) => [controlLabel(node), controlSelected(node), node.props.disabled === true]),
    switches: hosts(root, 'Switch').map((node) => node.props.value),
    inputs: hosts(root, 'TextInput').map((node) => [node.props.placeholder ?? null, node.props.value]),
    busy: hosts(root, 'ActivityIndicator').length,
    alert: harness.alert ? [harness.alert.title, harness.alert.message, harness.alert.buttons.map((button) => [button.text, button.style ?? null])] : null,
    storage: snapshotStorage(),
    ...drain(seen),
  });
}


async function run(what: string, fn: (() => unknown) | undefined) {
  if (!fn) throw new Error(`Nothing to do for ${what}`);
  await act(async () => { await fn(); });
}

const labelText = (label: string) => label.replace(/k:([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g, (_match, key: string) => translate(key));
const matches = (node: ReactTestInstance, label: string) => {
  const text = controlLabel(node);
  return text === label || text.split('|')[0] === label || text.startsWith(`${label}: `);
};

async function perform(renderer: ReactTestRenderer, action: [string, ...unknown[]]) {
  const root = renderer.root;
  const [kind, target, extra] = action;
  switch (kind) {
    case 'press': {
      const label = labelText(target as string);
      const control = hosts(root, 'TouchableOpacity').filter((node) => matches(node, label))[typeof extra === 'number' ? extra : 0];
      if (control?.props.disabled) return undefined;
      return run(`press ${label}`, control?.props.onPress);
    }
    case 'switch': {
      const control = hosts(root, 'Switch')[target as number];
      return run('switch', () => control.props.onValueChange(!control.props.value));
    }
    case 'type':
      return run('type', () => hosts(root, 'TextInput')[target as number].props.onChangeText(extra));
    case 'alert': {
      const label = labelText(target as string);
      const button = harness.alert?.buttons.find((entry) => entry.text === label);
      harness.alert = null;
      return run(`alert ${label}`, button?.onPress ?? (() => undefined));
    }
    default:
      throw new Error(`Unknown action ${String(kind)}`);
  }
}

const settle = async () => {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPendingSave();
  });
};

async function runScenario(scenario: Scenario) {
  await seedStore(scenario);
  setDevice(scenario.device);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<CalendarSettingsScreen />);
  });
  await settle();
  const seen: Seen = { writes: 0, calendarWrites: 0, prompts: 0, toasts: 0 };
  const observations = [observe(renderer.root, seen)];
  for (const action of scenario.actions) {
    await perform(renderer, action);
    await settle();
    observations.push(observe(renderer.root, seen));
  }
  await act(async () => { renderer.unmount(); });
  stopCalendarPushSync();
  await flushPendingSave();
  return observations;
}

const inputs = () => normalize({
  now: NOW, timeZone: 'UTC', platform: 'android', areas: AREAS, settings: SETTINGS, calendars: CALENDARS, events: EVENTS, feeds: FEEDS, keys: KEYS, scenarios,
}) as Record<string, unknown>;

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const harnessPath = 'apps/mobile/components/settings/calendar-settings-screen.parity.test.tsx';
  const changed = git('status', '--porcelain', '--untracked-files=all', '--', '../../../../apps').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => path !== harnessPath);
  if (changed.length > 0) throw new Error(`Capture needs HEAD's apps/ code; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_CALENDAR_SETTINGS=1 TZ=UTC bunx vitest run components/settings/calendar-settings-screen.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ was at HEAD except this harness. No React Native code imported core\'s calendar feeds, push or settings modules yet.',
    device: 'The device is stubbed (Android): expo-calendar answers from the scenario\'s calendars and events and records its writes, AsyncStorage is the scenario\'s storage (its calendar keys are snapshotted after each step), fetch and local files answer the fixture\'s feeds, the document picker answers the scenario\'s picks, and new feed ids come from a counter.',
  };
}

describe('React Native Calendar settings screen parity fixture', () => {
  const originalTz = process.env.TZ;
  const originalFetch = globalThis.fetch;
  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    globalThis.fetch = (async (url: string) => {
      const entry = harness.feeds[String(url)];
      if (entry === undefined) return { ok: false, status: 404, text: async () => '' };
      if (typeof entry !== 'string') throw new Error(entry.error);
      return { ok: true, status: 200, text: async () => entry };
    }) as typeof fetch;
    harness.strings = { en: await loadTranslations('en'), zh: await loadTranslations('zh') };
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);

    if (process.env.MINDWTR_DUMP_CALENDAR_SETTINGS) writeFileSync(process.env.MINDWTR_DUMP_CALENDAR_SETTINGS, JSON.stringify(captured));
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

  it('announces the Area choice state without reading the check glyphs (#1305)', async () => {
    const scenario = scenarios.find((entry) => entry.name === 'device calendars: turn on, grant, choose calendars and areas')!;
    await seedStore(scenario);
    setDevice(scenario.device);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CalendarSettingsScreen />);
    });
    await settle();

    for (const action of scenario.actions.slice(0, 5)) {
      await perform(renderer, action);
      await settle();
    }
    const showInAreas = labelText('k:settings.calendarShowInAreas');
    const toggles = hosts(renderer.root, 'TouchableOpacity').filter((node) => matches(node, showInAreas));
    expect(toggles.map((node) => node.props.accessibilityState?.expanded)).toEqual([false, true, false]);
    const options = hosts(renderer.root, 'TouchableOpacity').filter((node) => node.props.accessibilityRole === 'checkbox');
    expect(options.map((node) => [node.props.accessibilityLabel, node.props.accessibilityState?.checked]))
      .toEqual([['Work', false], ['Home', false]]);
    await act(async () => { renderer.unmount(); });
    stopCalendarPushSync();
    await flushPendingSave();
  }, 60_000);
});
