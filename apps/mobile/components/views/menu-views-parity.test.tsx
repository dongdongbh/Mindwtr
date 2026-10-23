/**
 * React Native's More sheet, Waiting, Someday (with its sections), Reference and
 * Done, replayed against the frozen parity fixture that core's menu-views model
 * and the native host contract are tested against.
 *
 * The fixture's `provenance` names the commit it was captured at. To recapture,
 * commit or stash every other change first, then run
 *   MINDWTR_CAPTURE_MENU_VIEWS=1 MINDWTR_CAPTURE_MENU_VIEWS_COMMIT=$(git rev-parse HEAD) bunx vitest run components/views/menu-views-parity.test.tsx
 * The capture refuses to run unless that commit is HEAD and the checkout holds
 * nothing but HEAD's code, so the provenance always names the code that ran.
 * Each scenario renders the real
 * screen with the real core store, drives it through its own controls and
 * handlers, and records what a user sees and what the store is asked to write.
 */
import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Alert } from 'react-native';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  flushPendingSave,
  loadTranslations,
  resetForTests,
  SAVED_FILTER_NO_PROJECT_ID,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Area,
  type Project,
  type Task,
} from '@mindwtr/core';

import { WaitingView } from './waiting-view';
import { SomedayView } from './someday-view';
import { ManageSettingsScreen } from '../settings/manage-settings-screen';
import ReferenceScreen from '../../app/(drawer)/reference';
import DoneScreen from '../../app/(drawer)/done';
import TabLayout from '../../app/(drawer)/(tabs)/_layout';

const FIXTURE_PATH = new URL('../../../../packages/core/src/menu-views-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_MENU_VIEWS === '1';

const english = vi.hoisted(() => ({ strings: {} as Record<string, string> }));
const toastLog = vi.hoisted(() => ({ entries: [] as { tone: string | null; title: string | null; message: string | null; actionLabel: string | null; onAction?: () => void }[] }));
const routerLog = vi.hoisted(() => ({ pushes: [] as unknown[] }));
const asyncStore = vi.hoisted(() => ({ values: new Map<string, string>() }));
const navigationOptions = vi.hoisted(() => ({ headerRight: null as null | (() => unknown) }));
const alertLog = vi.hoisted(() => ({ entries: [] as { title: string; message?: string; buttons?: { text?: string; style?: string; onPress?: () => void }[] }[] }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStore.values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { asyncStore.values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { asyncStore.values.delete(key); }),
  },
}));
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => english.strings[key] ?? key, language: 'en' }),
}));
vi.mock('@/contexts/theme-context', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({
    showToast: (toast: { tone?: string; title?: string; message?: string; actionLabel?: string; onAction?: () => void }) => {
      toastLog.entries.push({
        tone: toast.tone ?? null,
        title: toast.title ?? null,
        message: toast.message ?? null,
        actionLabel: toast.actionLabel ?? null,
        onAction: toast.onAction,
      });
    },
    dismissToast: vi.fn(),
  }),
  useToastBottomOffset: vi.fn(),
  ToastViewport: () => null,
}));
vi.mock('expo-router', () => {
  const Tabs = ({ children, tabBar, ...props }: any) => React.createElement(
    'Tabs',
    props,
    tabBar({
      state: {
        index: 0,
        key: 'tabs',
        routes: [
          { key: 'focus-key', name: 'focus' },
          { key: 'inbox-key', name: 'inbox' },
          { key: 'capture-key', name: 'capture' },
          { key: 'projects-key', name: 'projects' },
          { key: 'calendar-key', name: 'calendar-tab' },
          { key: 'contexts-key', name: 'contexts-tab' },
          { key: 'review-key', name: 'review-tab' },
          { key: 'menu-key', name: 'menu' },
        ],
      },
      descriptors: Object.fromEntries(['focus', 'inbox', 'capture', 'projects', 'calendar', 'contexts', 'review', 'menu']
        .map((name) => [`${name}-key`, { options: { title: name } }])),
      navigation: { emit: vi.fn(() => ({ defaultPrevented: false })), dispatch: vi.fn() },
    }),
    children,
  );
  Tabs.Screen = function TabsScreen() {
    return null;
  };
  const router = { push: (route: unknown) => { routerLog.pushes.push(route); }, back: vi.fn(), replace: vi.fn() };
  return {
    Link: ({ children }: any) => React.createElement(React.Fragment, null, children),
    Redirect: (props: any) => React.createElement('Redirect', props),
    Tabs,
    router,
    useRouter: () => router,
    usePathname: () => '/history',
    useNavigation: () => ({
      setOptions: (options: { headerRight?: () => unknown }) => {
        if ('headerRight' in options) navigationOptions.headerRight = options.headerRight ?? null;
      },
    }),
  };
});
vi.mock('@react-navigation/native', () => ({
  NavigationContext: React.createContext(undefined),
  CommonActions: { navigate: vi.fn((route) => ({ type: 'NAVIGATE', payload: route })) },
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('../settings/settings.shell', () => ({
  SettingsTopBar: () => null,
  SubHeader: () => null,
}));
vi.mock('react-native-gesture-handler', () => ({
  Swipeable: (props: any) => React.createElement('Swipeable', props, props.children),
}));
vi.mock('react-native-draggable-flatlist', () => ({
  default: (props: any) => React.createElement('DraggableFlatList', props),
}));
vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => true }));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', icon: '#64748b', tint: '#3b82f6', onTint: '#fff',
    tabIconDefault: '#94a3b8', tabIconSelected: '#3b82f6', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('@/lib/performance-diagnostics', () => ({
  beginMobilePerformanceDiagnostic: vi.fn(() => null),
  finishMobilePerformanceDiagnostic: vi.fn(),
  logMobilePerformanceDiagnostic: vi.fn(),
  resolveMobilePerformanceRoute: vi.fn(() => 'list'),
}));
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('@/hooks/use-manual-pull-sync', () => ({
  useManualPullSync: () => ({ refreshing: false, onRefresh: vi.fn(), indicatorState: 'idle' }),
}));
vi.mock('@/hooks/use-android-activity-session', () => ({ useAndroidActivitySession: () => ({ clear: vi.fn() }) }));
vi.mock('@/hooks/use-mobile-sync-badge', () => ({
  useMobileSyncBadge: () => ({ syncBadgeAccessibilityLabel: undefined, syncBadgeColor: undefined }),
}));
vi.mock('@/components/adaptive-window-context', () => ({
  useAdaptiveWindow: () => ({
    activeFeature: null,
    foregroundFrame: { x: 0, y: 0, width: 390, height: 844 },
    height: 844,
    isExpanded: false,
    navigationActionFrame: { x: 0, y: 0, width: 390, height: 844 },
    navigationFrame: { x: 0, y: 0, width: 390, height: 844 },
    navigationPlacement: 'left',
    navigationWidth: 88,
  }),
}));
vi.mock('@/components/ui/icon-symbol', () => ({
  IconSymbol: (props: any) => React.createElement('IconSymbol', props),
}));
vi.mock('@/components/haptic-tab', () => ({ HapticTab: (props: any) => React.createElement('HapticTab', props, props.children) }));
vi.mock('@/components/mobile-area-switcher', () => ({ MobileAreaSwitcher: () => null }));
vi.mock('@/components/quick-capture-sheet', () => ({
  QuickCaptureSheet: () => null,
  subscribeQuickCaptureSubmissionFailure: vi.fn(() => () => undefined),
}));
vi.mock('@/lib/capture-profiler', () => ({ beginCaptureProfile: vi.fn(), endCaptureProfile: vi.fn() }));
vi.mock('@/contexts/quick-capture-context', () => ({
  QuickCaptureProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  useQuickCapture: () => ({ openQuickCapture: vi.fn() }),
}));
vi.mock('../task-edit-modal', () => ({ TaskEditModal: () => null }));
vi.mock('../swipeable-task-item', () => ({
  SwipeableTaskItem: () => null,
  readTaskRowRenderCount: () => 0,
}));
vi.mock('../task-list/TaskListHeader', () => ({
  TaskListHeader: (props: any) => React.createElement('TaskListHeader', props),
}));
vi.mock('../task-list/TaskListBulkOrganizeModal', () => ({ TaskListBulkOrganizeModal: () => null }));
vi.mock('../task-list/TaskListTagModal', () => ({ TaskListTagModal: () => null }));
vi.mock('../token-picker-modal', () => ({ TokenPickerModal: () => null }));
vi.mock('../PullSyncIndicator', () => ({ PullSyncIndicator: () => null }));
vi.mock('../task-filter-sheet', () => ({
  FilterChip: (props: any) => React.createElement('FilterChip', props),
  TaskFilterSheet: (props: any) => React.createElement('TaskFilterSheet', props, props.topContent ?? null),
}));
vi.mock('../someday-section-picker', () => ({
  SomedaySectionPicker: (props: any) => React.createElement('SomedaySectionPicker', props),
}));
vi.mock('../list-overflow-menu', () => ({
  ListOverflowMenu: (props: any) => React.createElement('ListOverflowMenu', props),
}));

// ---------------------------------------------------------------------------
// Inputs

export const TIME_ZONE = 'America/New_York';
export const NOW = '2026-09-23T14:00:00.000Z';
const at = (day: string) => `2026-09-${day}T12:00:00.000Z`;
const task = (id: string, title: string, status: Task['status'], day: string, extra: Partial<Task> = {}): Task => ({
  id, title, status, contexts: [], tags: [], createdAt: at(day), updatedAt: at(day), ...extra,
});
const project = (id: string, title: string, status: Project['status'], order: number, extra: Partial<Project> = {}): Project => ({
  id, title, status, color: '#94a3b8', order, tagIds: [], createdAt: at('01'), updatedAt: at('01'), ...extra,
});

const areas: Area[] = [
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: at('01'), updatedAt: at('01') },
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: at('01'), updatedAt: at('01') },
];
const projects: Project[] = [
  project('p-launch', 'Launch', 'active', 0, { color: '#2563eb', areaId: 'a-work' }),
  project('p-home', 'Home Repairs', 'active', 1, { areaId: 'a-home' }),
  project('p-old', 'Old stuff', 'archived', 2, { areaId: 'a-work' }),
  project('p-vendor', 'Vendor contract', 'waiting', 3, { color: '#f59e0b', areaId: 'a-work' }),
  project('p-tax', 'Tax paperwork', 'waiting', 4),
  project('p-spanish', 'Learn Spanish', 'someday', 5, { areaId: 'a-home' }),
  project('p-shed', 'Build shed', 'someday', 6),
  project('p-gone', 'Removed', 'active', 7, { deletedAt: at('02') }),
];
const tasks: Task[] = [
  task('i-a', 'Inbox thought', 'inbox', '20'),
  task('n-a', 'Draft launch post', 'next', '19', { projectId: 'p-launch' }),
  task('w-alice', 'Hear back from Alice', 'waiting', '10', { assignedTo: 'Alice', dueDate: '2026-09-25', projectId: 'p-launch' }),
  task('w-bob', 'Invoice from Bob', 'waiting', '12', { assignedTo: 'bob' }),
  task('w-alice2', 'Budget reply', 'waiting', '11', { assignedTo: 'alice', dueDate: '2026-09-24T15:00', areaId: 'a-home' }),
  task('w-desc', 'Package delivery', 'waiting', '20', { description: 'Waiting for: Carol', tags: ['#home'] }),
  task('w-plain', 'Landlord answer', 'waiting', '15'),
  task('w-old', 'Archived wait', 'waiting', '09', { projectId: 'p-old', assignedTo: 'Dan' }),
  task('w-parked', 'Parked wait', 'waiting', '09', { projectId: 'p-vendor', assignedTo: 'Erin' }),
  task('w-deleted', 'Deleted wait', 'waiting', '09', { deletedAt: at('21'), assignedTo: 'Frank' }),
  task('s-a', 'Learn piano', 'someday', '01', {
    viewSectionIds: { someday: 's-later' }, contexts: ['@home'], tags: ['#music'], priority: 'low',
  }),
  task('s-b', 'Write a novel', 'someday', '05', {
    projectId: 'p-home', viewSectionIds: { someday: 's-ideas' }, tags: ['music'], timeEstimate: '2hr', dueDate: '2026-12-01',
  }),
  task('s-c', 'Visit Japan', 'someday', '08', { areaId: 'a-work', viewSectionIds: { someday: 'gone-section' } }),
  task('s-d', 'Garden redesign', 'someday', '03', { projectId: 'p-launch', energyLevel: 'high', description: 'A big plan' }),
  task('s-deleted', 'Old someday', 'someday', '02', { deletedAt: at('21') }),
  task('r-a', 'Wifi password', 'reference', '02', { areaId: 'a-home', tags: ['#home', 'router'], contexts: ['@home'] }),
  task('r-b', 'Style guide', 'reference', '04', { projectId: 'p-launch', tags: ['#work'], description: 'Brand colors' }),
  task('r-c', 'Archived notes', 'reference', '06', { projectId: 'p-old', tags: ['#work'] }),
  task('r-d', 'Loose note', 'reference', '07', { contexts: ['@desk'] }),
  task('r-e', 'Gone reference', 'reference', '07', { projectId: 'p-gone' }),
  task('d-a', 'Filed taxes', 'done', '15', {
    completedAt: '2026-09-23T10:00:00.000Z', projectId: 'p-launch', contexts: ['@office'], priority: 'high',
  }),
  task('d-b', 'Fixed sink', 'done', '14', { completedAt: '2026-09-22T13:00:00.000Z', projectId: 'p-home', tags: ['#home'] }),
  task('d-c', 'Old chore', 'done', '13', { completedAt: '2026-08-01T12:00:00.000Z', areaId: 'a-work' }),
  task('d-d', 'Undated finish', 'done', '12'),
  task('d-f', 'Mailed forms', 'done', '16', { completedAt: '2026-09-19T12:00:00.000Z', tags: ['#work'], contexts: ['@office'] }),
  task('d-g', 'Undated recent finish', 'done', '21'),
  task('d-e', 'Archived done', 'done', '11', { completedAt: '2026-09-20T12:00:00.000Z', projectId: 'p-old' }),
];
const somedaySections = [
  { id: 's-later', title: 'Later', order: 0 },
  { id: 's-ideas', title: 'Ideas', order: 1 },
  { id: 's-empty', title: 'Travel', order: 2 },
];
const savedSearches = [
  { id: 'ss-calls', name: 'Calls', query: '@phone' },
  { id: 'ss-home', name: 'Home stuff', query: '#home' },
];
const settingsVariants: Record<string, AppSettings> = {
  base: {},
  sections: { gtd: { viewSections: { someday: somedaySections } }, features: { priorities: true, timeEstimates: true } },
  areaWork: { filters: { areaIds: ['a-work'] } },
  quickProjects: { appearance: { mobileQuickAccessView: 'projects' }, savedSearches },
  quickCalendar: { appearance: { mobileQuickAccessView: 'calendar' } },
  quickContexts: { appearance: { mobileQuickAccessView: 'contexts' }, savedSearches: savedSearches.slice(0, 1) },
  quickInvalid: { appearance: { mobileQuickAccessView: 'trash' as never } },
  features: { features: { priorities: true, timeEstimates: true }, taskSortBy: 'title' },
};

type Screen = 'more' | 'waiting' | 'someday' | 'someday-sections' | 'reference' | 'done';
export type MenuViewAction =
  | ['openMore']
  | ['press', string]
  | ['person', string]
  | ['clearPerson']
  | ['status', string, Task['status']]
  | ['delete', string]
  | ['activateProject', string]
  | ['sort', string]
  | ['group', string]
  | ['details']
  | ['filter', 'token' | 'project' | 'priority' | 'energy' | 'time' | 'search', string]
  | ['clearFilters']
  | ['clearChip', string]
  | ['select', string[]]
  | ['moveToSection', string[], string | null]
  | ['undo']
  | ['addTask', string, string]
  | ['newSection', string]
  | ['renameSection', string, string]
  | ['moveSection', string, -1 | 1]
  | ['deleteSection', string]
  | ['collapse', string]
  | ['includeArchived', boolean]
  /** Another device removes a Someday section; the screen has not re-rendered its dialog yet. */
  | ['removeSectionElsewhere', string];
export type MenuViewScenario = {
  name: string;
  screen: Screen;
  settings: string;
  /** Task and project ids left out of the store for this scenario. */
  omit?: string[];
  /** Device-local view state stored before the screen mounts. */
  storage?: Record<string, string>;
  actions: MenuViewAction[];
};

export const scenarios: MenuViewScenario[] = [
  { name: 'more: default quick access', screen: 'more', settings: 'base', actions: [['openMore'], ['press', 'waiting']] },
  { name: 'more: projects quick access with saved searches', screen: 'more', settings: 'quickProjects', actions: [['openMore'], ['press', 'ss-home']] },
  { name: 'more: calendar quick access', screen: 'more', settings: 'quickCalendar', actions: [['openMore']] },
  { name: 'more: contexts quick access with one saved search', screen: 'more', settings: 'quickContexts', actions: [['openMore']] },
  { name: 'more: an unknown quick access view falls back to Review', screen: 'more', settings: 'quickInvalid', actions: [['openMore']] },
  {
    name: 'waiting: people, stats, deferred projects and row actions',
    screen: 'waiting',
    settings: 'base',
    actions: [
      ['person', 'bob'],
      ['status', 'w-bob', 'done'],
      ['person', 'alice'],
      ['clearPerson'],
      ['person', 'Carol'],
      ['person', ''],
      ['delete', 'w-desc'],
      ['activateProject', 'p-vendor'],
    ],
  },
  {
    name: 'waiting: selected person disappears', screen: 'waiting', settings: 'base',
    actions: [['person', 'bob'], ['status', 'w-bob', 'done']],
  },
  { name: 'waiting: the Work area', screen: 'waiting', settings: 'areaWork', actions: [] },
  {
    name: 'waiting: empty',
    screen: 'waiting',
    settings: 'base',
    omit: ['w-alice', 'w-bob', 'w-alice2', 'w-desc', 'w-plain', 'p-vendor', 'p-tax'],
    actions: [],
  },
  {
    name: 'waiting: no tasks but deferred projects',
    screen: 'waiting',
    settings: 'base',
    omit: ['w-alice', 'w-bob', 'w-alice2', 'w-desc', 'w-plain'],
    actions: [['activateProject', 'p-tax']],
  },
  {
    name: 'someday: sections, moves, undo, add task and new section',
    screen: 'someday',
    settings: 'sections',
    actions: [
      ['moveToSection', ['s-d'], 's-empty'],
      ['undo'],
      ['select', ['s-a', 's-b']],
      ['moveToSection', [], null],
      ['moveToSection', ['s-c'], 's-later'],
      ['addTask', 'view-section:someday:s-empty', '  Book flights  '],
      ['addTask', 'view-section:someday:', 'Loose idea'],
      ['newSection', 'Hobbies'],
      ['newSection', ' later '],
      ['status', 's-a', 'next'],
      ['delete', 's-c'],
      ['activateProject', 'p-spanish'],
    ],
  },
  {
    name: 'someday: grouping, sort and details',
    screen: 'someday',
    settings: 'sections',
    actions: [
      ['group', 'project'],
      ['group', 'area'],
      ['group', 'none'],
      ['sort', 'title'],
      ['sort', 'due'],
      ['sort', 'timeEstimate'],
      ['details'],
      ['group', 'viewSection'],
    ],
  },
  {
    name: 'someday: filters',
    screen: 'someday',
    settings: 'sections',
    actions: [
      ['filter', 'token', '#music'],
      ['filter', 'token', '#music'],
      ['filter', 'token', '#music'],
      ['filter', 'project', 'p-home'],
      ['filter', 'project', SAVED_FILTER_NO_PROJECT_ID],
      ['clearChip', `project:${SAVED_FILTER_NO_PROJECT_ID}`],
      ['filter', 'priority', 'low'],
      ['filter', 'energy', 'high'],
      ['filter', 'time', '2hr'],
      ['filter', 'search', 'novel'],
      ['clearFilters'],
      ['filter', 'search', 'plan'],
    ],
  },
  {
    name: 'someday: a move to a section removed elsewhere fails',
    screen: 'someday',
    settings: 'sections',
    actions: [['removeSectionElsewhere', 's-empty'], ['moveToSection', ['s-a'], 's-empty'], ['moveToSection', ['s-a'], 's-ideas']],
  },
  { name: 'someday: no sections defined', screen: 'someday', settings: 'base', actions: [['sort', 'timeEstimate']] },
  {
    name: 'someday: empty',
    screen: 'someday',
    settings: 'base',
    omit: ['s-a', 's-b', 's-c', 's-d', 'p-spanish', 'p-shed'],
    actions: [],
  },
  {
    name: 'someday: empty sections still offer Add task',
    screen: 'someday',
    settings: 'sections',
    omit: ['s-a', 's-b', 's-c', 's-d', 'p-spanish', 'p-shed'],
    actions: [['group', 'project']],
  },
  {
    name: 'someday sections: rename and reorder',
    screen: 'someday-sections',
    settings: 'sections',
    actions: [
      ['renameSection', 's-ideas', '  Big ideas '],
      ['renameSection', 's-ideas', '   '],
      ['moveSection', 's-empty', -1],
      ['moveSection', 's-later', -1],
      ['moveSection', 's-later', 1],
      ['deleteSection', 's-later'],
    ],
  },
  {
    name: 'reference: grouping, archived projects, filters and sort',
    screen: 'reference',
    settings: 'base',
    actions: [
      ['collapse', 'a-home'],
      ['group', 'none'],
      ['group', 'context'],
      ['group', 'project'],
      ['group', 'tag'],
      ['includeArchived', true],
      ['filter', 'token', '#router'],
      ['filter', 'project', SAVED_FILTER_NO_PROJECT_ID],
      ['clearChip', 'reference:include-archived-projects'],
      ['filter', 'search', 'wifi pass'],
      ['clearFilters'],
      ['filter', 'search', 'nomatch'],
      ['clearFilters'],
      ['group', 'area'],
      ['collapse', 'a-home'],
      ['sort', 'title'],
      ['status', 'r-a', 'next'],
      ['delete', 'r-d'],
    ],
  },
  {
    name: 'reference: empty',
    screen: 'reference',
    settings: 'features',
    omit: ['r-a', 'r-b', 'r-c', 'r-d', 'r-e'],
    actions: [['includeArchived', true]],
  },
  {
    name: 'done: grouping, sort, filters and row actions',
    screen: 'done',
    settings: 'features',
    actions: [
      ['group', 'completedDate'],
      ['collapse', 'completedDate:yesterday'],
      ['sort', 'title'],
      ['sort', 'default'],
      ['group', 'project'],
      ['group', 'context'],
      ['filter', 'token', '@office'],
      ['filter', 'priority', 'high'],
      ['clearFilters'],
      ['filter', 'search', 'sink'],
      ['clearFilters'],
      ['group', 'none'],
      ['status', 'd-a', 'inbox'],
      ['delete', 'd-f'],
    ],
  },
  {
    name: 'done: stored view state',
    screen: 'done',
    settings: 'base',
    storage: { 'mindwtr:view:done:v1': JSON.stringify({ groupBy: 'completedDate', sortBy: 'title' }) },
    actions: [['group', 'tag']],
  },
  { name: 'done: empty', screen: 'done', settings: 'base', omit: ['d-a', 'd-b', 'd-c', 'd-d', 'd-e', 'd-f', 'd-g'], actions: [] },
];

// ---------------------------------------------------------------------------
// Harness

const t = (key: string) => english.strings[key] ?? key;
const writeLog: unknown[] = [];
const createdIds = new Map<string, string>();
/** Created ids are random, so they read as `<created:title>` wherever they appear. */
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|someday-[0-9a-z]+-[0-9a-z]+/g, (match) => (
  createdIds.get(match) ?? match
)));
const encodeArgs = (args: unknown[]) => normalize(args.map((arg) => (
  arg && typeof arg === 'object' && !Array.isArray(arg)
    ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value === undefined ? '<undefined>' : value]))
    : arg
)));

type RealActions = Pick<ReturnType<typeof useTaskStore.getState>,
  'updateTask' | 'deleteTask' | 'addTask' | 'updateProject' | 'updateSettings' | 'batchUpdateTasks' | 'batchMoveTasks' | 'batchDeleteTasks'>;
let realActions: RealActions | null = null;

async function seedStore(settings: AppSettings, omit: string[] = []) {
  resetForTests();
  const initial = useTaskStore.getState();
  realActions ??= {
    updateTask: initial.updateTask,
    deleteTask: initial.deleteTask,
    addTask: initial.addTask,
    updateProject: initial.updateProject,
    updateSettings: initial.updateSettings,
    batchUpdateTasks: initial.batchUpdateTasks,
    batchMoveTasks: initial.batchMoveTasks,
    batchDeleteTasks: initial.batchDeleteTasks,
  };
  const real = realActions;
  const data = JSON.parse(JSON.stringify({
    tasks: tasks.filter((entry) => !omit.includes(entry.id)),
    projects: projects.filter((entry) => !omit.includes(entry.id)),
    sections: [],
    areas,
    people: [],
    settings,
  }));
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  await flushPendingSave();
  useTaskStore.setState({
    ...real,
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    highlightTaskId: null,
  });
  await useTaskStore.getState().fetchData({ throwOnError: true });
  if (useTaskStore.getState()._allTasks.length !== data.tasks.length) throw new Error('Store seed did not load');
  const log = (name: string, args: unknown[]) => { writeLog.push([name, ...encodeArgs(args) as unknown[]]); };
  useTaskStore.setState({
    updateTask: async (id, updates) => { log('updateTask', [id, updates]); return real.updateTask(id, updates); },
    deleteTask: async (id) => { log('deleteTask', [id]); return real.deleteTask(id); },
    addTask: async (title, props, options) => {
      log('addTask', [title, props]);
      const result = await real.addTask(title, props, options);
      if (result.id) createdIds.set(result.id, `<created:${title}>`);
      return result;
    },
    updateProject: async (id, updates) => { log('updateProject', [id, updates]); return real.updateProject(id, updates); },
    updateSettings: async (updates) => {
      const someday = updates.gtd?.viewSections?.someday;
      someday?.forEach((section) => {
        if (/^someday-/.test(section.id) && !createdIds.has(section.id)) createdIds.set(section.id, `<created:${section.title}>`);
      });
      log('updateSettings', [updates]);
      return real.updateSettings(updates);
    },
    batchUpdateTasks: async (updates) => { log('batchUpdateTasks', [updates]); return real.batchUpdateTasks(updates); },
    batchMoveTasks: async (ids, status) => { log('batchMoveTasks', [ids, status]); return real.batchMoveTasks(ids, status); },
    batchDeleteTasks: async (ids) => { log('batchDeleteTasks', [ids]); return real.batchDeleteTasks(ids); },
  });
}

const textOf = (node: ReactTestInstance | null | undefined): string => {
  if (!node) return '';
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
};
const byName = (root: ReactTestInstance, name: string) => root.findAll((node) => (
  typeof node.type === 'function' && (node.type as { name?: string }).name === name
));
const hostOf = (root: ReactTestInstance, type: string) => root.findAll((node) => (node.type as unknown) === type);
const settle = async () => {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) await Promise.resolve();
  });
};
const renderElement = (element: unknown): ReactTestRenderer | null => {
  if (!element) return null;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(typeof element === 'function' ? React.createElement(element as React.FC) : element as React.ReactElement);
  });
  return renderer;
};
let lastToastAction: (() => void) | null = null;
/** Drains the toasts shown since the last observation; an Undo stays reachable for the next action. */
const toastEntries = () => toastLog.entries.splice(0).map(({ tone, title, message, actionLabel, onAction }) => {
  if (onAction) lastToastAction = onAction;
  return [tone, title, message, actionLabel];
});

// ------------------------------- More sheet --------------------------------

const observeMore = (root: ReactTestInstance) => {
  const tabs = byName(root, 'NativeTabBar')[0];
  const visibleTabs = tabs ? hostOf(tabs, 'TouchableOpacity').map((node) => node.props.accessibilityLabel) : [];
  const item = (node: ReactTestInstance) => {
    const { item: entry } = node.props as { item: Record<string, unknown> };
    return {
      id: entry.id, label: entry.label, text: textOf(hostOf(node, 'Text')[0]),
      icon: entry.icon, iconColor: entry.iconColor, route: entry.route ?? null,
    };
  };
  const compact = byName(root, 'MoreSheetCompactItem');
  const utilityCount = 4;
  const savedTitle = hostOf(root, 'Text').filter((node) => node.props.children === t('search.savedSearches'));
  return {
    tabs: visibleTabs,
    open: byName(root, 'MoreSheetTile').length > 0,
    utilities: compact.slice(0, utilityCount).map(item),
    savedTitle: savedTitle.length > 0 ? t('search.savedSearches') : null,
    saved: compact.slice(utilityCount).map(item),
    primary: byName(root, 'MoreSheetTile').map(item),
    pushes: normalize(routerLog.pushes.splice(0)),
  };
};

// --------------------------------- Waiting ---------------------------------

const observeWaiting = (root: ReactTestInstance) => {
  const list = byName(root, 'TaskListView')[0];
  const header = renderElement(list.props.ListHeaderComponent);
  const empty = renderElement(list.props.ListEmptyComponent);
  const chips = hostOf(root, 'ScrollView')[0];
  const observation = {
    stats: statsOf(root),
    filterLabel: textOf(hostOf(root, 'Text').find((node) => textOf(node) === t('process.delegateWhoLabel'))),
    people: hostOf(chips, 'TouchableOpacity').map((node) => ({
      label: textOf(node),
      active: (node.props.style as { backgroundColor?: string }[])[1]?.backgroundColor === '#3b82f6',
    })),
    clear: hostOf(root, 'TouchableOpacity').some((node) => textOf(node) === t('common.clear') && !hostOf(chips, 'TouchableOpacity').includes(node))
      ? t('common.clear') : null,
    rows: (list.props.tasks as Task[]).map((entry) => entry.id),
    groups: list.props.taskGroups ?? null,
    deferred: deferredOf(header),
    empty: empty ? textsOf(empty.root) : null,
    writes: normalize(writeLog.splice(0)),
    toasts: toastEntries(),
  };
  act(() => { header?.unmount(); empty?.unmount(); });
  return observation;
};

function statsOf(root: ReactTestInstance) {
  // The two stat blocks: value then label, in screen order.
  const statItems = hostOf(root, 'View').filter((node) => (node.props.style as { alignItems?: string })?.alignItems === 'center'
    && hostOf(node, 'Text').length === 2);
  return statItems.map((node) => hostOf(node, 'Text').map(textOf));
}

function textsOf(root: ReactTestInstance) {
  return hostOf(root, 'Text').map(textOf).filter(Boolean);
}

function deferredOf(renderer: ReactTestRenderer | null) {
  if (!renderer) return null;
  const root = renderer.root;
  const header = hostOf(root, 'TouchableOpacity')[0];
  if (!header) return null;
  return {
    header: textOf(header),
    headerLabel: header.props.accessibilityLabel,
    rows: hostOf(root, 'Swipeable').map((swipe) => {
      const texts = hostOf(swipe, 'Text').map(textOf);
      const icon = hostOf(swipe, 'Icon')[0];
      const action = renderElement(swipe.props.renderLeftActions());
      const actionText = action ? textsOf(action.root).join('') : null;
      act(() => { action?.unmount(); });
      return { action: actionText, title: texts[0], area: texts[1] ?? null, color: icon?.props.color ?? null };
    }),
  };
}

// --------------------------------- Someday ---------------------------------

const menuOf = (root: ReactTestInstance) => {
  const menu = byName(root, 'ListOverflowMenu')[0] ?? hostOf(root, 'ListOverflowMenu')[0];
  if (!menu) return null;
  const leaf = (action: Record<string, any>) => ({
    id: action.id ?? null,
    label: action.label,
    accessibilityLabel: action.accessibilityLabel ?? null,
    value: action.value ?? null,
    selected: action.selected ?? null,
    ...(action.submenu ? {
      submenu: { title: action.submenu.title, actions: action.submenu.actions.map(leaf) },
    } : {}),
  });
  return { actions: menu.props.actions.map(leaf), labels: [menu.props.backLabel, menu.props.closeLabel, menu.props.moreLabel] };
};

const filterSheetOf = (root: ReactTestInstance) => {
  const sheet = hostOf(root, 'TaskFilterSheet')[0];
  if (!sheet) return null;
  const { options, selections } = sheet.props;
  return {
    tokens: options.tokens,
    projects: options.projects ?? null,
    timeEstimates: options.timeEstimates,
    visibility: options.visibility,
    hasAdditional: sheet.props.hasAdditionalActiveFilters ?? false,
    chips: selections.chips.map((chip: { id: string; label: string; excluded?: boolean }) => [chip.id, chip.label, chip.excluded === true]),
    activeCount: selections.activeCount,
    archiveToggle: hostOf(sheet, 'Switch').map((node) => ({ label: node.props.accessibilityLabel, value: node.props.value }))[0] ?? null,
  };
};

const observeSomeday = (root: ReactTestInstance) => {
  const list = byName(root, 'TaskListView')[0];
  const header = renderElement(list.props.ListHeaderComponent);
  const empty = renderElement(list.props.ListEmptyComponent);
  const groups = list.props.taskGroups as { id: string; title: string; muted?: boolean; projects?: Project[]; tasks: Task[] }[] | undefined;
  const modals = hostOf(root, 'Modal').filter((node) => node.props.visible);
  const moveModal = modals.find((node) => hostOf(node, 'SomedaySectionPicker').length > 0);
  const addModal = modals.find((node) => hostOf(node, 'TextInput').length > 0);
  const filterChip = hostOf(root, 'FilterChip')[0];
  const observation = {
    stats: statsOf(root),
    filterChip: filterChip ? { label: filterChip.props.label, removeLabel: filterChip.props.removeLabel } : null,
    menu: menuOf(root),
    rows: groups
      ? groups.flatMap((group) => [
        ['heading', group.id, group.title, group.muted === true],
        // TaskListView draws a group's projects only through renderProject.
        ...(list.props.renderProject ? group.projects ?? [] : []).map((entry) => ['project', entry.id]),
        ...group.tasks.map((entry) => ['task', entry.id]),
      ])
      : (list.props.tasks as Task[]).map((entry) => ['task', entry.id]),
    tasks: (list.props.tasks as Task[]).map((entry) => entry.id),
    canAddToSection: typeof list.props.onAddTaskToSection === 'function',
    canMoveToSection: typeof list.props.onMoveTaskToSection === 'function',
    showDetails: list.props.showDetails,
    filterSheet: filterSheetOf(root),
    moveDialog: moveModal ? {
      title: textOf(hostOf(moveModal, 'Text')[0]),
      sections: hostOf(moveModal, 'SomedaySectionPicker')[0].props.sections,
      selectedId: hostOf(moveModal, 'SomedaySectionPicker')[0].props.selectedId ?? null,
      selectionMixed: hostOf(moveModal, 'SomedaySectionPicker')[0].props.selectionMixed,
    } : null,
    addDialog: addModal ? textsOf(addModal) : null,
    deferred: deferredOf(header),
    empty: empty ? textsOf(empty.root) : null,
    writes: normalize(writeLog.splice(0)),
    toasts: toastEntries(),
  };
  act(() => { header?.unmount(); empty?.unmount(); });
  return observation;
};

const selectionsOf = (root: ReactTestInstance) => hostOf(root, 'TaskFilterSheet')[0].props.selections;

async function runFilterAction(root: ReactTestInstance, action: MenuViewAction) {
  const selections = selectionsOf(root);
  if (action[0] === 'clearFilters') {
    await act(async () => { selections.clear(); });
    return;
  }
  if (action[0] === 'clearChip') {
    const chip = selections.chips.find((entry: { id: string }) => entry.id === action[1])
      ?? byName(root, 'TaskListHeader')[0]?.props.activeFilterChips.find((entry: { id: string }) => entry.id === action[1])
      ?? hostOf(root, 'TaskListHeader')[0]?.props.activeFilterChips.find((entry: { id: string }) => entry.id === action[1]);
    if (!chip) throw new Error(`No chip ${action[1]}`);
    await act(async () => { chip.onPress(); });
    return;
  }
  if (action[0] !== 'filter') return;
  const [, kind, value] = action;
  await act(async () => {
    if (kind === 'token') selections.toggleToken(value);
    if (kind === 'project') selections.toggleProject(value);
    if (kind === 'priority') selections.togglePriority(value);
    if (kind === 'energy') selections.toggleEnergyLevel(value);
    if (kind === 'time') selections.toggleTimeEstimate(value);
    if (kind === 'search') selections.setSearchQuery(value);
  });
}

async function runRowAction(action: MenuViewAction, rowActions: { status: (task: Task, status: Task['status']) => unknown; remove: (task: Task) => unknown }) {
  const state = useTaskStore.getState();
  if (action[0] === 'status') {
    const target = state._allTasks.find((entry) => entry.id === action[1])!;
    await act(async () => { await rowActions.status(target, action[2]); });
    return true;
  }
  if (action[0] === 'delete') {
    const target = state._allTasks.find((entry) => entry.id === action[1])!;
    await act(async () => { await rowActions.remove(target); });
    return true;
  }
  return false;
}

async function runDeferredAction(list: ReactTestInstance, projectId: string) {
  const title = projects.find((entry) => entry.id === projectId)!.title;
  const findSwipe = (root: ReactTestInstance) => hostOf(root, 'Swipeable').find((node) => hostOf(node, 'Text').map(textOf)[0] === title);
  // A parked project sits in the header block, or in its Someday section group (#1319).
  const header = renderElement(list.props.ListHeaderComponent)!;
  const grouped = (list.props.taskGroups as { projects?: Project[] }[] | undefined)
    ?.flatMap((group) => group.projects ?? []).find((entry) => entry.id === projectId);
  const row = !findSwipe(header.root) && grouped && list.props.renderProject
    ? renderElement(list.props.renderProject(grouped)) : null;
  const swipe = findSwipe(header.root) ?? (row ? findSwipe(row.root) : undefined);
  if (!swipe) throw new Error(`No deferred project ${projectId}`);
  await act(async () => { swipe.props.onSwipeableLeftOpen(); });
  act(() => { header.unmount(); row?.unmount(); });
}

// ------------------------------ Reference/Done ------------------------------

const observeTaskList = (root: ReactTestInstance) => {
  const flat = hostOf(root, 'FlatList')[0];
  const header = hostOf(root, 'TaskListHeader')[0];
  const navHeader = navigationOptions.headerRight ? renderElement((navigationOptions.headerRight as () => React.ReactElement)()) : null;
  const navProps = navHeader ? hostOf(navHeader.root, 'TaskListHeader')[0]?.props : null;
  const emptyElement = flat.props.ListEmptyComponent as React.ReactElement<Record<string, unknown>>;
  const observation = {
    items: (flat.props.data as Record<string, any>[]).map((item) => (item.type === 'section'
      ? ['section', item.id, item.title, item.count, item.muted === true, item.collapsible === true, item.collapsed === true]
      : ['task', item.task.id, item.groupId ?? null])),
    header: {
      count: header.props.count,
      chips: header.props.activeFilterChips.map((chip: { id: string; label: string; excluded?: boolean }) => [chip.id, chip.label, chip.excluded === true]),
      filterActiveCount: header.props.filterActiveCount,
      hasActiveFilters: header.props.hasActiveFilters,
      groupByLabel: header.props.groupByLabel ?? null,
      sortByLabel: header.props.sortByLabel,
      showHeader: header.props.showHeader,
      title: header.props.title,
      navigationOverflow: navProps ? { renderOverflowOnly: navProps.renderOverflowOnly, title: navProps.title, count: navProps.count } : null,
    },
    empty: { message: emptyElement.props.message, hint: emptyElement.props.hint ?? null, actionLabel: emptyElement.props.actionLabel ?? null },
    filterSheet: filterSheetOf(root),
    writes: normalize(writeLog.splice(0)),
    toasts: toastEntries(),
    stored: Object.fromEntries([...asyncStore.values.entries()].sort()),
  };
  act(() => { navHeader?.unmount(); });
  return observation;
};

async function openAndReadModal(root: ReactTestInstance, open: () => void, titleText: string) {
  await act(async () => { open(); });
  const modal = hostOf(root, 'Modal').find((node) => node.props.visible && textOf(hostOf(node, 'Text')[0]) === titleText);
  if (!modal) throw new Error(`No ${titleText} modal`);
  return modal;
}

async function taskListOptions(root: ReactTestInstance) {
  const header = hostOf(root, 'TaskListHeader')[0];
  const sortModal = await openAndReadModal(root, header.props.onOpenSort, t('sort.label'));
  const sort = {
    options: hostOf(sortModal, 'Pressable').filter((node) => node.props.testID).map((node) => [
      node.props.testID.replace('sort-option-', ''), textOf(node), Array.isArray(node.props.style) && Boolean(node.props.style[1]),
    ]),
  };
  await act(async () => { hostOf(sortModal, 'Pressable')[0].props.onPress(); });
  let group = null;
  if (header.props.onOpenGroup) {
    const groupModal = await openAndReadModal(root, hostOf(root, 'TaskListHeader')[0].props.onOpenGroup, t('list.groupBy'));
    group = hostOf(groupModal, 'Pressable').slice(1).map((node) => [textOf(node), Array.isArray(node.props.style) && Boolean(node.props.style[1])]);
    await act(async () => { hostOf(groupModal, 'Pressable')[0].props.onPress(); });
  }
  return { sort, group };
}

async function runTaskListAction(root: ReactTestInstance, action: MenuViewAction) {
  const header = () => hostOf(root, 'TaskListHeader')[0];
  if (action[0] === 'sort') {
    const modal = await openAndReadModal(root, header().props.onOpenSort, t('sort.label'));
    const option = hostOf(modal, 'Pressable').find((node) => node.props.testID === `sort-option-${action[1]}`);
    if (!option) throw new Error(`No sort option ${action[1]}`);
    await act(async () => { option.props.onPress(); });
    return;
  }
  if (action[0] === 'group') {
    const modal = await openAndReadModal(root, header().props.onOpenGroup, t('list.groupBy'));
    const labels: Record<string, string> = {
      none: t('list.groupByNone'), context: t('list.groupByContext'), area: t('list.groupByArea'),
      project: t('taskEdit.projectLabel'), tag: t('taskEdit.tagsLabel'), completedDate: t('list.groupByCompletedDate'),
    };
    const option = hostOf(modal, 'Pressable').slice(1).find((node) => textOf(node) === labels[action[1]]);
    if (!option) throw new Error(`No group option ${action[1]}`);
    await act(async () => { option.props.onPress(); });
    return;
  }
  if (action[0] === 'collapse') {
    const flat = hostOf(root, 'FlatList')[0];
    const item = (flat.props.data as Record<string, any>[]).find((entry) => entry.type === 'section' && entry.id === action[1]);
    if (!item) throw new Error(`No group ${action[1]}`);
    const rendered = renderElement(flat.props.renderItem({ item, index: 0 }))!;
    await act(async () => { hostOf(rendered.root, 'TouchableOpacity')[0].props.onPress(); });
    act(() => { rendered.unmount(); });
    return;
  }
  if (action[0] === 'includeArchived') {
    const toggle = hostOf(hostOf(root, 'TaskFilterSheet')[0], 'Switch')[0];
    await act(async () => { toggle.props.onValueChange(action[1]); });
    return;
  }
  if (action[0] === 'filter' || action[0] === 'clearFilters' || action[0] === 'clearChip') {
    await runFilterAction(root, action);
    return;
  }
  const flat = hostOf(root, 'FlatList')[0];
  const rowItem = (flat.props.data as Record<string, any>[]).find((entry) => entry.type === 'task' && entry.task.id === action[1]);
  if (!rowItem) {
    throw new Error(`No row ${action[1]} in ${JSON.stringify((flat.props.data as Record<string, any>[]).map((entry) => entry.type === 'task' ? entry.task.id : entry.id))}`);
  }
  const rowElement = (flat.props.renderItem({ item: rowItem, index: 0 })) as React.ReactElement<{ children: React.ReactElement<{ actions: { changeStatus: (task: Task, status: Task['status']) => unknown; remove: (task: Task) => unknown } }> }>;
  const rowActions = rowElement.props.children.props.actions;
  const handled = await runRowAction(action, { status: rowActions.changeStatus, remove: rowActions.remove });
  if (!handled) throw new Error(`Unknown action ${JSON.stringify(action)}`);
}

// --------------------------------- Runner ----------------------------------

async function runScenario(scenario: MenuViewScenario) {
  writeLog.splice(0);
  toastLog.entries.splice(0);
  alertLog.entries.splice(0);
  lastToastAction = null;
  routerLog.pushes.splice(0);
  asyncStore.values.clear();
  navigationOptions.headerRight = null;
  Object.entries(scenario.storage ?? {}).forEach(([key, value]) => asyncStore.values.set(key, value));
  await seedStore(settingsVariants[scenario.settings], scenario.omit);
  writeLog.splice(0);

  const element = scenario.screen === 'more' ? <TabLayout />
    : scenario.screen === 'waiting' ? <WaitingView />
      : scenario.screen === 'someday' ? <SomedayView />
        : scenario.screen === 'someday-sections' ? <ManageSettingsScreen />
          : scenario.screen === 'reference' ? <ReferenceScreen /> : <DoneScreen />;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(element); });
  await settle();
  const root = renderer.root;

  const observe = (): Record<string, unknown> => normalize(observeRaw()) as Record<string, unknown>;
  const observeRaw = (): Record<string, unknown> => {
    switch (scenario.screen) {
      case 'more': return observeMore(root);
      case 'waiting': return observeWaiting(root);
      case 'someday': return observeSomeday(root);
      case 'someday-sections': {
        const manager = byName(root, 'SomedaySectionManager')[0];
        const rows = manager ? hostOf(manager, 'View').filter((node) => hostOf(node, 'TouchableOpacity').length === 4) : [];
        return {
          rows: rows.map((row) => ({
            title: textOf(hostOf(row, 'Text')[0]),
            input: hostOf(row, 'TextInput')[0]?.props.value ?? null,
            buttons: hostOf(row, 'TouchableOpacity').map((button) => [button.props.accessibilityLabel, button.props.disabled === true]),
          })),
          alerts: alertLog.entries.map((entry) => [entry.title, entry.message ?? null, (entry.buttons ?? []).map((button) => [button.text ?? null, button.style ?? null])]),
          writes: writeLog.splice(0),
        };
      }
      default: return observeTaskList(root);
    }
  };

  const observations: Record<string, unknown>[] = [];
  if (scenario.screen === 'reference' || scenario.screen === 'done') {
    // Token options are only built while the filter sheet is open; keep it open.
    await act(async () => { hostOf(root, 'TaskListHeader')[0].props.onOpenFilters(); });
  }
  if (scenario.screen === 'someday-sections') {
    await act(async () => {
      byName(root, 'CollapsibleSection').find((node) => node.props.testID === 'manage-section-toggle-someday-sections')!.props.onToggle();
    });
  }
  const first = observe();
  if (scenario.screen === 'reference' || scenario.screen === 'done') {
    Object.assign(first, await taskListOptions(root));
  }
  observations.push(first);

  for (const action of scenario.actions) {
    try {
      if (scenario.screen === 'more') {
        if (action[0] === 'openMore') {
          const menu = hostOf(byName(root, 'NativeTabBar')[0], 'TouchableOpacity').find((node) => node.props.accessibilityLabel === 'menu');
          await act(async () => { menu!.props.onPress(); });
        } else if (action[0] === 'press') {
          const target = [...byName(root, 'MoreSheetTile'), ...byName(root, 'MoreSheetCompactItem')]
            .find((node) => node.props.item.id === action[1]);
          const pressable = hostOf(target!, 'Pressable')[0];
          await act(async () => { pressable.props.onPress(); });
        }
      } else if (scenario.screen === 'waiting' || scenario.screen === 'someday') {
        const list = byName(root, 'TaskListView')[0];
        if (await runRowAction(action, {
          status: list.props.onChangeTaskStatus,
          remove: list.props.onDeleteTask,
        })) {
          // handled
        } else if (action[0] === 'activateProject') {
          await runDeferredAction(list, action[1]);
        } else if (action[0] === 'person') {
          const chips = hostOf(root, 'ScrollView')[0];
          const chip = hostOf(chips, 'TouchableOpacity').find((node) => (action[1] ? textOf(node) === action[1] : textOf(node) === t('common.all')));
          if (!chip) throw new Error(`No person chip ${action[1]}`);
          await act(async () => { chip.props.onPress(); });
        } else if (action[0] === 'clearPerson') {
          const chips = hostOf(root, 'ScrollView')[0];
          const clear = hostOf(root, 'TouchableOpacity').find((node) => textOf(node) === t('common.clear') && !hostOf(chips, 'TouchableOpacity').includes(node));
          await act(async () => { clear!.props.onPress(); });
        } else if (action[0] === 'sort' || action[0] === 'group' || action[0] === 'details') {
          const raw = hostOf(root, 'ListOverflowMenu')[0].props.actions as Record<string, any>[];
          const target = action[0] === 'details'
            ? raw.find((entry) => entry.id === 'details')
            : raw.find((entry) => entry.id === action[0])!.submenu.actions.find((entry: { id: string }) => entry.id === `${action[0]}:${action[1]}`);
          if (!target) throw new Error(`No menu action ${JSON.stringify(action)}`);
          await act(async () => { target.onPress(); });
        } else if (action[0] === 'filter' || action[0] === 'clearFilters' || action[0] === 'clearChip') {
          await runFilterAction(root, action);
        } else if (action[0] === 'select') {
          for (const id of action[1]) {
            const current = byName(root, 'TaskListView')[0];
            await act(async () => {
              current.props.selection.toggleMultiSelect(id, { visibleTaskIds: (current.props.tasks as Task[]).map((entry) => entry.id) });
            });
          }
        } else if (action[0] === 'moveToSection') {
          const current = byName(root, 'TaskListView')[0];
          await act(async () => {
            if (action[1].length > 0) {
              current.props.onMoveTaskToSection(useTaskStore.getState()._allTasks.find((entry) => entry.id === action[1][0]));
            } else {
              current.props.onMoveSelectionToSection();
            }
          });
          observations.push({ opened: normalize(observeSomeday(root)) });
          const picker = hostOf(root, 'Modal').filter((node) => node.props.visible)
            .flatMap((node) => hostOf(node, 'SomedaySectionPicker'))[0];
          await act(async () => { await picker.props.onSelect(action[2] ?? undefined); });
        } else if (action[0] === 'undo') {
          const undo = lastToastAction as (() => void) | null;
          lastToastAction = null;
          await act(async () => { await undo!(); });
        } else if (action[0] === 'addTask') {
          const current = byName(root, 'TaskListView')[0];
          await act(async () => { current.props.onAddTaskToSection(action[1]); });
          observations.push({ opened: normalize(observeSomeday(root)) });
          const input = hostOf(root, 'Modal').filter((node) => node.props.visible).flatMap((node) => hostOf(node, 'TextInput'))[0];
          await act(async () => { input.props.onChangeText(action[2]); });
          const modal = hostOf(root, 'Modal').filter((node) => node.props.visible).find((node) => hostOf(node, 'TextInput').length > 0)!;
          const save = hostOf(modal, 'TouchableOpacity').at(-1)!;
          await act(async () => { await save.props.onPress(); });
        } else if (action[0] === 'removeSectionElsewhere') {
          const current = useTaskStore.getState().settings;
          await act(async () => {
            await realActions!.updateSettings({
              gtd: {
                ...(current.gtd ?? {}),
                viewSections: {
                  ...(current.gtd?.viewSections ?? {}),
                  someday: (current.gtd?.viewSections?.someday ?? []).filter((section) => section.id !== action[1]),
                },
              },
            });
          });
        } else if (action[0] === 'newSection') {
          const raw = hostOf(root, 'ListOverflowMenu')[0].props.actions as Record<string, any>[];
          await act(async () => { raw.at(-1)!.onPress(); });
          const picker = hostOf(root, 'SomedaySectionPicker').find((node) => node.props.createOnly)!;
          let created: string | null = null;
          await act(async () => { created = await picker.props.onCreate(action[1]); });
          await act(async () => { picker.props.onSelect(created); });
          observations.push({ created: normalize(created) as unknown });
        } else {
          throw new Error(`Unknown action ${JSON.stringify(action)}`);
        }
      } else if (scenario.screen === 'someday-sections') {
        const manager = byName(root, 'SomedaySectionManager')[0];
        const sections = (useTaskStore.getState().settings.gtd?.viewSections?.someday ?? []);
        const title = sections.find((section) => section.id === action[1])?.title ?? '';
        const buttons = hostOf(manager, 'TouchableOpacity');
        const pressLabel = async (label: string) => {
          const button = buttons.find((node) => node.props.accessibilityLabel === label);
          if (!button) throw new Error(`No button ${label}`);
          if (!button.props.disabled) await act(async () => { await button.props.onPress(); });
        };
        if (action[0] === 'renameSection') {
          await pressLabel(`${t('viewSections.rename')}: ${title}`);
          const input = hostOf(byName(root, 'SomedaySectionManager')[0], 'TextInput')[0];
          await act(async () => { input.props.onChangeText(action[2]); });
          await act(async () => { await hostOf(byName(root, 'SomedaySectionManager')[0], 'TextInput')[0].props.onSubmitEditing(); });
        } else if (action[0] === 'moveSection') {
          await pressLabel(`${action[2] < 0 ? t('projects.moveUp') : t('projects.moveDown')}: ${title}`);
        } else if (action[0] === 'deleteSection') {
          alertLog.entries.splice(0);
          await pressLabel(`${t('common.delete')}: ${title}`);
          observations.push(observe());
          const confirm = alertLog.entries.at(-1)?.buttons?.find((button) => button.style === 'destructive');
          if (!confirm?.onPress) throw new Error('No delete confirmation');
          alertLog.entries.splice(0);
          await act(async () => { await confirm.onPress!(); });
        }
      } else {
        await runTaskListAction(root, action);
      }
      await settle();
    } catch (error) {
      const trail = observations.slice(-4).map((entry) => JSON.stringify({ items: entry.items, header: entry.header, filterSheet: (entry.filterSheet as { chips?: unknown } | null)?.chips }));
      throw new Error(`${scenario.name}: ${JSON.stringify(action)} failed\n${String(error)}\n${trail.join('\n')}\n${(error as Error).stack ?? ''}`);
    }
    observations.push(observe());
  }
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}

/**
 * The commit a recapture runs at. It must be declared, equal HEAD, and the checkout
 * must hold no other change than this harness and its fixture.
 */
function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const declared = process.env.MINDWTR_CAPTURE_MENU_VIEWS_COMMIT;
  if (declared !== head) {
    throw new Error(`Recapture needs MINDWTR_CAPTURE_MENU_VIEWS_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  }
  const allowed = new Set(['apps/mobile/components/views/menu-views-parity.test.tsx', 'packages/core/src/menu-views-parity.fixtures.json']);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_MENU_VIEWS=1 MINDWTR_CAPTURE_MENU_VIEWS_COMMIT=$(git rev-parse HEAD) bunx vitest run components/views/menu-views-parity.test.tsx',
    capturedAt: head,
  };
}

describe('React Native list views parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    // Some screens rely on the app's automatic JSX runtime; the test transform may emit classic calls.
    (globalThis as { React?: typeof React }).React = React;
    Alert.alert = (title: string, message?: string, buttons?: { text?: string; style?: string; onPress?: () => void }[]) => {
      alertLog.entries.push({ title, message, buttons });
    };
    process.env.TZ = TIME_ZONE;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    english.strings = await loadTranslations('en');
  });
  afterAll(() => {
    vi.useRealTimers();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) {
      captured[scenario.name] = await runScenario(scenario);
    }
    const inputs = normalize({
      timeZone: TIME_ZONE, now: NOW, tasks, projects, areas, settings: settingsVariants, scenarios,
    }) as Record<string, unknown>;
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs, observations: captured }, null, 1)}\n`);
    }
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const { observations, provenance: _provenance, ...frozenInputs } = fixture;
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 180_000);
});
