/**
 * React Native's selection mode on the task lists (the bulk bar, the add-tag
 * dialog, the remove-tag picker, delete with Undo, Range and Bulk Organize) on
 * the Inbox, Waiting, Someday, Reference, Done and project lists, replayed
 * against the frozen parity fixture that core's task-list-bulk-actions and the
 * native host contract are tested against.
 *
 * The fixture's `provenance` names the commit it was captured at. To recapture,
 * commit or stash every other change first, then run
 *   MINDWTR_CAPTURE_BULK_ACTIONS=1 MINDWTR_CAPTURE_BULK_ACTIONS_COMMIT=$(git rev-parse HEAD) bunx vitest run components/task-list/bulk-actions-parity.test.tsx
 * The capture refuses to run unless that commit is HEAD and the checkout holds
 * nothing but HEAD's code, so the provenance always names the code that ran.
 * Each scenario renders the real screen with the real core store, drives it
 * through its own rows, bar, dialogs and pickers, and records what a user sees
 * and what the store is asked to write.
 */
import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Alert } from 'react-native';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  flushPendingSave,
  sortProjectsForPicker,
  getQuickDateLabel,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Area,
  type Project,
  type ProjectSequenceTaskCue,
  type Task,
  type TaskSortBy,
} from '@mindwtr/core';

import InboxScreen from '../../app/(drawer)/(tabs)/inbox';
import ReferenceScreen from '../../app/(drawer)/reference';
import DoneScreen from '../../app/(drawer)/done';
import { WaitingView } from '../views/waiting-view';
import { SomedayView } from '../views/someday-view';
import { ProjectTaskList } from '../projects-screen/ProjectTaskList';
import { TaskListBulkBar, type TaskListBulkBarProps } from './TaskListBulkBar';
import { styles as taskListStyles } from './task-list.styles';

const FIXTURE_PATH = new URL('../../../../packages/core/src/task-list-bulk-actions-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_BULK_ACTIONS === '1';

const english = vi.hoisted(() => {
  const state = { strings: {} as Record<string, string>, t: (key: string) => key };
  // Stable, as the app's language context is: a new `t` per render would re-run every memo keyed on it.
  state.t = (key: string) => state.strings[key] ?? key;
  return state;
});
const toastLog = vi.hoisted(() => ({ entries: [] as { tone: string | null; title: string | null; message: string | null; actionLabel: string | null; onAction?: () => void }[] }));
const asyncStore = vi.hoisted(() => ({ values: new Map<string, string>() }));
const alertLog = vi.hoisted(() => ({ entries: [] as { title: string; message?: string; buttons?: { text?: string; style?: string; onPress?: () => void | Promise<void> }[] }[] }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStore.values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { asyncStore.values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { asyncStore.values.delete(key); }),
  },
}));
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: english.t, language: 'en' }),
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
  const router = { push: vi.fn(), back: vi.fn(), replace: vi.fn() };
  return {
    Redirect: (props: any) => React.createElement('Redirect', props),
    router,
    useRouter: () => router,
    usePathname: () => '/history',
    useNavigation: () => ({ setOptions: vi.fn() }),
  };
});
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-gesture-handler', () => ({
  Swipeable: (props: any) => React.createElement('Swipeable', props, props.children),
}));
vi.mock('react-native-draggable-flatlist', () => ({
  default: (props: any) => React.createElement('DraggableFlatList', props),
}));
vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: (props: any) => React.createElement('DateTimePicker', props),
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
vi.mock('@/hooks/use-startup-screen-ready', () => ({ useStartupScreenReady: () => vi.fn() }));
vi.mock('@/lib/onboarding-hints', () => ({ dismissMobileHint: vi.fn() }));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../../lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
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
vi.mock('@/contexts/quick-capture-context', () => ({
  QuickCaptureProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  useQuickCapture: () => ({ openQuickCapture: vi.fn() }),
}));
vi.mock('../inbox-processing-modal', () => ({ InboxProcessingModal: () => null }));
vi.mock('../task-edit-modal', () => ({ TaskEditModal: () => null }));
vi.mock('../swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
  readTaskRowRenderCount: () => 0,
}));
vi.mock('../token-picker-modal', () => ({
  TokenPickerModal: (props: any) => React.createElement('TokenPickerModal', props),
}));
vi.mock('../task-edit/TaskEditProjectPicker', () => ({
  TaskEditProjectPicker: (props: any) => React.createElement('TaskEditProjectPicker', props),
}));
vi.mock('../task-edit/TaskEditAreaPicker', () => ({
  TaskEditAreaPicker: (props: any) => React.createElement('TaskEditAreaPicker', props),
}));
vi.mock('../someday-section-picker', () => ({
  SomedaySectionPicker: (props: any) => React.createElement('SomedaySectionPicker', props),
}));
vi.mock('../PullSyncIndicator', () => ({ PullSyncIndicator: () => null }));
vi.mock('../task-filter-sheet', () => ({
  FilterChip: (props: any) => React.createElement('FilterChip', props),
  TaskFilterSheet: (props: any) => React.createElement('TaskFilterSheet', props, props.topContent ?? null),
}));
vi.mock('../list-overflow-menu', () => ({
  ListOverflowMenu: (props: any) => React.createElement('ListOverflowMenu', props),
}));

// ---------------------------------------------------------------------------
// Inputs

export const TIME_ZONE = 'America/New_York';
export const NOW = '2026-09-26T14:00:00.000Z';
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
  { id: 'a-gone', name: 'Old area', color: '#94a3b8', order: 2, createdAt: at('01'), updatedAt: at('02'), deletedAt: at('02') },
];
const projects: Project[] = [
  project('p-launch', 'Launch', 'active', 0, { color: '#2563eb', areaId: 'a-work' }),
  project('p-home', 'Home Repairs', 'active', 1, { areaId: 'a-home' }),
  project('p-apple', 'apple orchard', 'active', 2),
  project('p-spanish', 'Learn Spanish', 'someday', 3, { areaId: 'a-home' }),
  project('p-old', 'Old stuff', 'archived', 4, { areaId: 'a-work' }),
  project('p-gone', 'Removed', 'active', 5, { deletedAt: at('02') }),
];
const tasks: Task[] = [
  task('i-call', 'Call dentist', 'inbox', '20', { contexts: ['@phone'], tags: ['#health'] }),
  task('i-milk', 'Buy milk', 'inbox', '21', { tags: ['#errand', '#health'] }),
  task('i-archived', 'Archived capture', 'inbox', '19', { projectId: 'p-old' }),
  task('i-party', 'Plan launch party', 'inbox', '18', { projectId: 'p-launch' }),
  task('i-read', 'Read article', 'inbox', '22', { areaId: 'a-home', dueDate: '2026-10-05' }),
  task('i-deleted', 'Deleted capture', 'inbox', '16', { deletedAt: at('23') }),
  task('w-alice', 'Hear back from Alice', 'waiting', '10', { assignedTo: 'Alice', tags: ['#work'] }),
  task('w-bob', 'Invoice from Bob', 'waiting', '12', { assignedTo: 'Bob' }),
  task('w-landlord', 'Landlord answer', 'waiting', '15'),
  task('s-piano', 'Learn piano', 'someday', '01', { tags: ['#music'], viewSectionIds: { someday: 's-later' } }),
  task('s-novel', 'Write a novel', 'someday', '05'),
  task('r-wifi', 'Wifi password', 'reference', '03', { tags: ['#home'] }),
  task('r-manual', 'Oven manual', 'reference', '04', { tags: ['#home', '#kitchen'], areaId: 'a-home' }),
  task('d-taxes', 'Filed taxes', 'done', '15', { completedAt: '2026-09-23T10:00:00.000Z' }),
  task('d-rent', 'Paid rent', 'done', '14', { completedAt: '2026-09-22T10:00:00.000Z', tags: ['#money'] }),
  task('r-old', 'Old launch brief', 'reference', '02', { projectId: 'p-old', tags: ['#home'] }),
  task('n-post', 'Draft launch post', 'next', '19', { projectId: 'p-launch', contexts: ['@desk'] }),
  task('n-copy', 'Review copy', 'next', '19', { projectId: 'p-launch', tags: ['#work'] }),
];
const settings: AppSettings = {
  gtd: { viewSections: { someday: [{ id: 's-later', title: 'Later', order: 0 }] } },
};

export type BulkList = 'inbox' | 'waiting' | 'someday' | 'reference' | 'done' | 'project';
type DateField = 'start' | 'due' | 'review';
export type BulkScenarioAction =
  | ['select', string]
  | ['range']
  | ['move', Task['status']]
  | ['addTag', 'open' | 'save' | 'cancel']
  | ['addTag', 'type', string]
  | ['removeTag', 'open' | 'close']
  | ['removeTag', 'confirm', string[]]
  | ['delete', 'confirm' | 'cancel']
  | ['undo']
  | ['exit']
  | ['includeArchivedProjects']
  | ['moveToSection', 'open' | 'close']
  | ['organize', 'open' | 'apply' | 'close' | 'projectPicker' | 'areaPicker']
  | ['organize', 'status' | 'project' | 'area' | 'person' | 'contexts' | 'tags', string]
  | ['organize', 'quickDate', DateField, 'today' | 'tomorrow']
  | ['organize', 'typeDate', DateField, string]
  | ['organize', 'openPicker', DateField]
  | ['organize', 'pickDate', DateField, string];
export type BulkScenario = { name: string; list: BulkList; actions: BulkScenarioAction[] };

export const scenarios: BulkScenario[] = [
  {
    name: 'inbox: select two rows, then move them to Next',
    list: 'inbox',
    actions: [['select', 'i-call'], ['select', 'i-milk'], ['move', 'next']],
  },
  {
    name: 'inbox: Range selects back to the anchor, then every row moves to Someday',
    list: 'inbox',
    actions: [['select', 'i-call'], ['range'], ['select', 'i-read'], ['select', 'i-milk'], ['move', 'someday']],
  },
  {
    name: 'inbox: add a tag; a tag every selected row has writes nothing; exit',
    list: 'inbox',
    actions: [
      ['select', 'i-call'], ['select', 'i-milk'],
      ['addTag', 'open'], ['addTag', 'type', 'urgent'], ['addTag', 'save'],
      ['select', 'i-call'],
      ['addTag', 'open'], ['addTag', 'type', '#health'], ['addTag', 'save'],
      ['addTag', 'open'], ['addTag', 'type', 'later'], ['addTag', 'cancel'],
      ['exit'],
    ],
  },
  {
    name: 'inbox: Remove tag offers only the tags the selection carries',
    list: 'inbox',
    actions: [['select', 'i-read'], ['select', 'i-milk'], ['select', 'i-call'], ['removeTag', 'open'], ['removeTag', 'confirm', ['#health']]],
  },
  {
    name: 'inbox: delete asks first, then Undo restores',
    list: 'inbox',
    actions: [['select', 'i-milk'], ['select', 'i-party'], ['delete', 'cancel'], ['delete', 'confirm'], ['undo']],
  },
  {
    name: 'inbox: Bulk organize to Waiting with a person, a project, dates, contexts and tags',
    list: 'inbox',
    actions: [
      ['select', 'i-call'], ['select', 'i-read'],
      ['organize', 'open'],
      ['organize', 'status', 'waiting'],
      ['organize', 'apply'],
      ['organize', 'person', 'Alice'],
      ['organize', 'projectPicker'],
      ['organize', 'project', 'p-launch'],
      ['organize', 'quickDate', 'start', 'tomorrow'],
      ['organize', 'typeDate', 'due', '2026-10-20'],
      ['organize', 'openPicker', 'review'],
      ['organize', 'pickDate', 'review', '2026-10-15'],
      ['organize', 'contexts', '@desk, office'],
      ['organize', 'tags', 'q4 #plan'],
      ['organize', 'apply'],
    ],
  },
  {
    name: 'inbox: Bulk organize an area and No project; Keep resets the choices',
    list: 'inbox',
    actions: [
      ['select', 'i-party'], ['select', 'i-milk'],
      ['organize', 'open'],
      ['organize', 'projectPicker'], ['organize', 'project', 'p-apple'],
      ['organize', 'projectPicker'], ['organize', 'project', 'keep'],
      ['organize', 'areaPicker'], ['organize', 'area', 'a-work'],
      ['organize', 'areaPicker'], ['organize', 'area', 'keep'],
      ['organize', 'projectPicker'], ['organize', 'project', 'none'],
      ['organize', 'areaPicker'], ['organize', 'area', 'a-home'],
      ['organize', 'status', 'next'], ['organize', 'status', 'keep'],
      ['organize', 'quickDate', 'due', 'today'], ['organize', 'quickDate', 'due', 'today'],
      ['organize', 'apply'],
    ],
  },
  {
    name: 'inbox: Bulk organize with nothing chosen writes nothing',
    list: 'inbox',
    actions: [['select', 'i-call'], ['organize', 'open'], ['organize', 'apply'], ['organize', 'open'], ['organize', 'close']],
  },
  {
    name: 'reference: the bar, Remove tag, move to Next, then delete and Undo',
    list: 'reference',
    actions: [
      ['select', 'r-manual'], ['select', 'r-wifi'], ['removeTag', 'open'], ['removeTag', 'confirm', ['#home']],
      ['select', 'r-wifi'], ['move', 'next'],
      ['select', 'r-manual'], ['delete', 'confirm'], ['undo'],
    ],
  },
  {
    name: 'reference: with archived projects shown, a read-only row is not selectable and Range skips it',
    list: 'reference',
    actions: [['includeArchivedProjects'], ['select', 'r-old'], ['select', 'r-wifi'], ['range'], ['select', 'r-manual'], ['addTag', 'open'], ['addTag', 'type', 'kept'], ['addTag', 'save']],
  },
  {
    name: 'done: the bar offers Archived; move to Archived, remove and add a tag, then delete and Undo',
    list: 'done',
    actions: [
      ['select', 'd-taxes'], ['move', 'archived'],
      ['select', 'd-rent'], ['removeTag', 'open'], ['removeTag', 'confirm', ['#money']],
      ['select', 'd-rent'], ['addTag', 'open'], ['addTag', 'type', 'paid'], ['addTag', 'save'],
      ['select', 'd-rent'], ['delete', 'confirm'], ['undo'],
    ],
  },
  {
    name: 'waiting: no Remove tag; add a tag, then Range and move to Next',
    list: 'waiting',
    actions: [
      ['select', 'w-alice'], ['select', 'w-bob'], ['addTag', 'open'], ['addTag', 'type', '#followup'], ['addTag', 'save'],
      ['select', 'w-landlord'], ['range'], ['select', 'w-bob'], ['move', 'next'],
    ],
  },
  {
    name: 'waiting: delete and Undo',
    list: 'waiting',
    actions: [['select', 'w-landlord'], ['delete', 'confirm'], ['undo']],
  },
  {
    name: 'someday: Move to section, add a tag, delete and Undo, then Range and move to Next',
    list: 'someday',
    actions: [
      ['select', 's-piano'], ['select', 's-novel'], ['moveToSection', 'open'], ['moveToSection', 'close'],
      ['addTag', 'open'], ['addTag', 'type', 'ideas'], ['addTag', 'save'],
      ['select', 's-novel'], ['delete', 'confirm'], ['undo'],
      ['select', 's-novel'], ['range'], ['select', 's-piano'], ['move', 'next'],
    ],
  },
  {
    name: 'project: every status, Bulk organize and Remove tag; organize, tags, move, delete and Undo',
    list: 'project',
    actions: [
      ['select', 'n-post'], ['select', 'n-copy'],
      ['organize', 'open'], ['organize', 'status', 'someday'], ['organize', 'tags', '#later'], ['organize', 'apply'],
      ['select', 'n-copy'], ['removeTag', 'open'], ['removeTag', 'confirm', ['#work']],
      ['select', 'i-party'], ['addTag', 'open'], ['addTag', 'type', 'launch'], ['addTag', 'save'],
      ['select', 'i-party'], ['move', 'next'],
      ['select', 'n-post'], ['delete', 'confirm'], ['undo'],
    ],
  },
];

// ---------------------------------------------------------------------------
// Harness

const t = (key: string) => english.strings[key] ?? key;
const writeLog: unknown[] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));

type StoreState = ReturnType<typeof useTaskStore.getState>;
type RealActions = Pick<StoreState, 'batchMoveTasks' | 'batchDeleteTasks' | 'batchUpdateTasks' | 'restoreTask' | 'updateTask' | 'deleteTask'>;
let realActions: RealActions | null = null;

async function seedStore() {
  resetForTests();
  const initial = useTaskStore.getState();
  realActions ??= {
    batchMoveTasks: initial.batchMoveTasks,
    batchDeleteTasks: initial.batchDeleteTasks,
    batchUpdateTasks: initial.batchUpdateTasks,
    restoreTask: initial.restoreTask,
    updateTask: initial.updateTask,
    deleteTask: initial.deleteTask,
  };
  const real = realActions;
  const data = JSON.parse(JSON.stringify({ tasks, projects, sections: [], areas, people: [], settings }));
  await flushPendingSave();
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  useTaskStore.setState({
    ...real,
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    highlightTaskId: null,
  });
  await useTaskStore.getState().fetchData({ throwOnError: true });
  if (useTaskStore.getState()._allTasks.length !== data.tasks.length) throw new Error('Store seed did not load');
  const log = (name: string, args: unknown[]) => { writeLog.push([name, ...(normalize(args) as unknown[])]); };
  useTaskStore.setState({
    batchMoveTasks: async (ids, status) => { log('batchMoveTasks', [ids, status]); return real.batchMoveTasks(ids, status); },
    batchDeleteTasks: async (ids) => { log('batchDeleteTasks', [ids]); return real.batchDeleteTasks(ids); },
    batchUpdateTasks: async (updates) => { log('batchUpdateTasks', [updates]); return real.batchUpdateTasks(updates); },
    restoreTask: async (id) => { log('restoreTask', [id]); return real.restoreTask(id); },
    updateTask: async (id, updates) => { log('updateTask', [id, updates]); return real.updateTask(id, updates); },
    deleteTask: async (id) => { log('deleteTask', [id]); return real.deleteTask(id); },
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
const hasStyle = (node: ReactTestInstance, style: unknown) => {
  const value = node.props.style;
  return Array.isArray(value) ? value.includes(style) : value === style;
};
const settle = async () => {
  await act(async () => {
    for (let round = 0; round < 8; round += 1) await Promise.resolve();
  });
};
const localDay = (date: Date) => [
  String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'),
].join('-');

/** A task row element's props, however many wrappers the list puts around SwipeableTaskItem. */
const findRowProps = (node: unknown): Record<string, any> | null => {
  if (!node || typeof node !== 'object') return null;
  const element = node as { props?: Record<string, any> };
  if (element.props?.task && element.props?.actions) return element.props;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findRowProps(child);
    if (found) return found;
  }
  return null;
};
const taskRows = (root: ReactTestInstance) => {
  const flat = hostOf(root, 'FlatList')[0];
  if (!flat) throw new Error('No list');
  return (flat.props.data as Record<string, any>[])
    .filter((item) => item.type === 'task' || item.kind === 'task')
    .map((item) => findRowProps(flat.props.renderItem({ item, index: 0 })))
    .filter((props): props is Record<string, any> => props !== null);
};

let lastToastAction: (() => void) | null = null;
const toastEntries = () => toastLog.entries.splice(0).map(({ tone, title, message, actionLabel, onAction }) => {
  if (onAction) lastToastAction = onAction;
  return [tone, title, message, actionLabel];
});

let taskSnapshot = new Map<string, string>();
/** Every task the store changed since the last observation: [id, { field: [before, after] }]. */
const changedTasks = () => {
  const next = new Map(useTaskStore.getState()._allTasks.map((entry) => [entry.id, JSON.stringify(normalize(entry))]));
  const changed: unknown[] = [];
  for (const [id, json] of next) {
    const before = taskSnapshot.get(id);
    if (before === json) continue;
    const previous = before ? JSON.parse(before) as Record<string, unknown> : {};
    const current = JSON.parse(json) as Record<string, unknown>;
    // A key the store set to undefined reads as absent.
    const value = (entry: Record<string, unknown>, field: string) => JSON.stringify(entry[field] ?? '<undefined>');
    const fields = Array.from(new Set([...Object.keys(previous), ...Object.keys(current)]))
      .filter((field) => field !== 'revBy' && value(previous, field) !== value(current, field))
      .sort();
    changed.push([id, Object.fromEntries(fields.map((field) => [field, [previous[field] ?? '<undefined>', current[field] ?? '<undefined>']]))]);
  }
  taskSnapshot = next;
  return changed;
};

const barOf = (root: ReactTestInstance) => byName(root, 'TaskListBulkBar')[0] ?? null;
const observeBar = (root: ReactTestInstance) => {
  const bar = barOf(root);
  if (!bar) return null;
  return {
    count: textOf(hostOf(bar, 'Text')[0]),
    // Frozen bulk-action controls shared with native. Reorder exits this mode;
    // its new project-only shortcut is exercised separately below.
    buttons: hostOf(bar, 'TouchableOpacity').filter((node) => node.props.testID !== 'task-list-reorder-shortcut')
      .map((node) => [node.props.accessibilityLabel ?? null, textOf(node), node.props.disabled === true]),
  };
};

const tagModalOf = (root: ReactTestInstance) => {
  const modal = byName(root, 'TaskListTagModal')[0];
  const host = modal ? hostOf(modal, 'Modal')[0] : null;
  return host?.props.visible ? host : null;
};
const observeTagModal = (root: ReactTestInstance) => {
  const modal = tagModalOf(root);
  if (!modal) return null;
  const input = hostOf(modal, 'TextInput')[0];
  const [cancel, save] = hostOf(modal, 'TouchableOpacity');
  return {
    title: textOf(hostOf(modal, 'Text')[0]),
    placeholder: input.props.placeholder,
    value: input.props.value,
    cancel: textOf(cancel),
    save: [textOf(save), save.props.disabled === true],
  };
};

const removePickerOf = (root: ReactTestInstance) => hostOf(root, 'TokenPickerModal').find((node) => node.props.visible) ?? null;
const observeRemovePicker = (root: ReactTestInstance) => {
  const picker = removePickerOf(root);
  if (!picker) return null;
  const { title, description, tokens, placeholder, multiSelect } = picker.props;
  return { title, description, tokens, placeholder, multiSelect: multiSelect === true };
};

const organizeOf = (root: ReactTestInstance) => {
  const modal = byName(root, 'TaskListBulkOrganizeModal')[0];
  const host = modal ? hostOf(modal, 'Modal')[0] : null;
  return host?.props.visible ? { modal, host } : null;
};
const chipOf = (node: ReactTestInstance) => [
  node.props.accessibilityLabel ?? null, textOf(node), node.props.accessibilityState?.selected === true, node.props.disabled === true,
];
const observeOrganize = (root: ReactTestInstance) => {
  const found = organizeOf(root);
  if (!found) return null;
  const { modal, host } = found;
  const card = hostOf(host, 'Pressable').find((node) => hasStyle(node, taskListStyles.bulkOrganizeCard))!;
  const header = hostOf(card, 'View').find((node) => hasStyle(node, taskListStyles.bulkOrganizeHeader))!;
  const [title, subtitle] = hostOf(header, 'Text').map(textOf);
  const close = hostOf(header, 'TouchableOpacity')[0];
  const statusRow = hostOf(card, 'ScrollView').find((node) => node.props.horizontal)!;
  const pickerRow = (testID: string) => {
    const row = hostOf(card, 'TouchableOpacity').find((node) => node.props.testID === testID)!;
    return [row.props.accessibilityLabel, textOf(row), row.props.disabled === true];
  };
  const inputByLabel = (label: string) => {
    const input = hostOf(card, 'TextInput').find((node) => node.props.accessibilityLabel === label);
    return input ? [input.props.value, input.props.placeholder ?? null] : null;
  };
  const labels = hostOf(card, 'Text').filter((node) => hasStyle(node, taskListStyles.bulkOrganizeLabel)).map(textOf);
  const dates = byName(card, 'TaskListBulkDateField').map((field) => {
    const input = hostOf(field, 'TextInput')[0];
    const calendar = hostOf(field, 'TouchableOpacity').find((node) => node.props.accessibilityState?.expanded !== undefined)!;
    const picker = hostOf(field, 'DateTimePicker')[0];
    return {
      label: field.props.label,
      input: [input.props.accessibilityLabel, input.props.value, input.props.placeholder, input.props.editable !== false],
      calendar: [calendar.props.accessibilityLabel, calendar.props.accessibilityState.expanded === true, calendar.props.disabled === true],
      chips: hostOf(field, 'Pressable').map(chipOf),
      picker: picker ? localDay(picker.props.value as Date) : null,
    };
  });
  const footer = hostOf(card, 'View').find((node) => hasStyle(node, taskListStyles.bulkOrganizeFooter))!;
  const [cancel, apply] = hostOf(footer, 'TouchableOpacity');
  const errors = hostOf(card, 'Text').filter((node) => hasStyle(node, taskListStyles.bulkOrganizeValidation)).map(textOf);
  const projectPicker = hostOf(modal, 'TaskEditProjectPicker')[0].props;
  const areaPicker = hostOf(modal, 'TaskEditAreaPicker')[0].props;
  const leading = (options: { label: string; selected?: boolean }[]) => options.map((option) => [option.label, option.selected === true]);
  return {
    title,
    subtitle,
    close: [close.props.accessibilityLabel, close.props.disabled === true],
    labels,
    status: hostOf(statusRow, 'TouchableOpacity').map(chipOf),
    project: pickerRow('bulk-organize-project-picker-row'),
    area: pickerRow('bulk-organize-area-picker-row'),
    waitingFor: inputByLabel(t('process.delegateWhoLabel')),
    contexts: inputByLabel(t('taskEdit.contextsLabel')),
    tags: inputByLabel(t('taskEdit.tagsLabel')),
    dates,
    errors,
    cancel: [textOf(cancel), cancel.props.disabled === true],
    apply: [textOf(apply), apply.props.disabled === true],
    projectPicker: projectPicker.visible ? {
      projects: sortProjectsForPicker(projectPicker.projects as Project[], useTaskStore.getState().areas).map((entry) => entry.id),
      allProjects: (projectPicker.allProjects as Project[]).map((entry) => entry.id),
      leading: leading(projectPicker.leadingOptions),
      selectedProjectId: projectPicker.selectedProjectId ?? '<undefined>',
      allowCreate: projectPicker.allowCreate === true,
    } : null,
    areaPicker: areaPicker.visible ? {
      areas: (areaPicker.areas as Area[]).map((entry) => entry.id),
      leading: leading(areaPicker.leadingOptions),
      selectedAreaId: areaPicker.selectedAreaId ?? '<undefined>',
      allowCreate: areaPicker.allowCreate === true,
    } : null,
  };
};

/** Someday's Move to section dialog while it is open. */
const sectionMoveModalOf = (root: ReactTestInstance) => hostOf(root, 'Modal').find((modal) => (
  modal.props.visible && hostOf(modal, 'SomedaySectionPicker').some((picker) => !picker.props.createOnly)
)) ?? null;

const observe = (root: ReactTestInstance) => {
  const rows = taskRows(root);
  const sectionModal = sectionMoveModalOf(root);
  const sectionPicker = sectionModal ? hostOf(sectionModal, 'SomedaySectionPicker')[0] : null;
  return normalize({
    // The task rows shown, in list order: [id, opens read-only].
    rows: rows.map((row) => [row.task.id, row.interactionDisabled === true]),
    // Rows shown as selected, in list order.
    selected: rows.filter((row) => row.isMultiSelected === true).map((row) => row.task.id),
    selectionMode: rows.some((row) => row.selectionMode === true),
    bar: observeBar(root),
    tagModal: observeTagModal(root),
    removePicker: observeRemovePicker(root),
    organize: observeOrganize(root),
    sectionPicker: sectionPicker ? { selectedId: sectionPicker.props.selectedId ?? null, selectionMixed: sectionPicker.props.selectionMixed === true } : null,
    alerts: alertLog.entries.splice(0).map((entry) => [entry.title, entry.message ?? null, (entry.buttons ?? []).map((button) => [button.text ?? null, button.style ?? null])]),
    toasts: toastEntries(),
    writes: writeLog.splice(0),
    changed: changedTasks(),
  }) as Record<string, unknown>;
};

const DATE_FIELD_LABEL_KEYS: Record<DateField, string> = {
  start: 'taskEdit.startDateLabel', due: 'taskEdit.dueDateLabel', review: 'taskEdit.reviewDateLabel',
};

async function press(node: ReactTestInstance | undefined, what: string) {
  if (!node) throw new Error(`No ${what}`);
  if (node.props.disabled) throw new Error(`${what} is disabled`);
  await act(async () => { await node.props.onPress?.(); });
}

async function runOrganizeAction(root: ReactTestInstance, action: Extract<BulkScenarioAction, ['organize', ...unknown[]]>) {
  if (action[1] === 'open') {
    const bar = barOf(root)!;
    await press(hostOf(bar, 'TouchableOpacity').find((node) => node.props.accessibilityLabel === t('bulk.organize')), 'Bulk organize');
    return;
  }
  const found = organizeOf(root);
  if (!found) throw new Error('Bulk organize is closed');
  const { modal, host } = found;
  const card = hostOf(host, 'Pressable').find((node) => hasStyle(node, taskListStyles.bulkOrganizeCard))!;
  const dateField = (field: DateField) => byName(card, 'TaskListBulkDateField').find((node) => (
    node.props.label === t(DATE_FIELD_LABEL_KEYS[field]) || (field === 'review' && node.props.label === t('process.followUpLabel'))
  ))!;
  const input = (label: string) => hostOf(card, 'TextInput').find((node) => node.props.accessibilityLabel === label)!;
  switch (action[1]) {
    case 'apply': {
      const footer = hostOf(card, 'View').find((node) => hasStyle(node, taskListStyles.bulkOrganizeFooter))!;
      await press(hostOf(footer, 'TouchableOpacity')[1], 'Apply');
      return;
    }
    case 'close': {
      const footer = hostOf(card, 'View').find((node) => hasStyle(node, taskListStyles.bulkOrganizeFooter))!;
      await press(hostOf(footer, 'TouchableOpacity')[0], 'Cancel');
      return;
    }
    case 'projectPicker':
      await press(hostOf(card, 'TouchableOpacity').find((node) => node.props.testID === 'bulk-organize-project-picker-row'), 'project row');
      return;
    case 'areaPicker':
      await press(hostOf(card, 'TouchableOpacity').find((node) => node.props.testID === 'bulk-organize-area-picker-row'), 'area row');
      return;
    case 'status': {
      const label = action[2] === 'keep' ? t('bulk.keepStatus') : t(`status.${action[2]}`);
      const statusRow = hostOf(card, 'ScrollView').find((node) => node.props.horizontal)!;
      await press(hostOf(statusRow, 'TouchableOpacity').find((node) => textOf(node) === label), `status ${label}`);
      return;
    }
    case 'project':
    case 'area': {
      const kind = action[1];
      const picker = hostOf(modal, kind === 'project' ? 'TaskEditProjectPicker' : 'TaskEditAreaPicker')[0].props;
      if (!picker.visible) throw new Error(`The ${kind} picker is closed`);
      // As the picker does: the choice, then it closes.
      await act(async () => {
        if (action[2] === 'keep') picker.leadingOptions[0].onPress();
        else if (kind === 'project') picker.onSelectProject(action[2] === 'none' ? undefined : action[2]);
        else picker.onSelectArea(action[2] === 'none' ? undefined : action[2]);
        picker.onClose();
      });
      return;
    }
    case 'person':
      await act(async () => { input(t('process.delegateWhoLabel')).props.onChangeText(action[2]); });
      return;
    case 'contexts':
      await act(async () => { input(t('taskEdit.contextsLabel')).props.onChangeText(action[2]); });
      return;
    case 'tags':
      await act(async () => { input(t('taskEdit.tagsLabel')).props.onChangeText(action[2]); });
      return;
    case 'quickDate': {
      const field = dateField(action[2] as DateField);
      const label = getQuickDateLabel(action[3] as 'today' | 'tomorrow', t);
      const chip = hostOf(field, 'Pressable').find((node) => node.props.accessibilityLabel === `${field.props.label}: ${label}`);
      await press(chip, `${field.props.label} ${label}`);
      return;
    }
    case 'typeDate': {
      const field = dateField(action[2] as DateField);
      const fieldInput = hostOf(field, 'TextInput')[0];
      await act(async () => {
        fieldInput.props.onFocus();
      });
      await act(async () => { hostOf(field, 'TextInput')[0].props.onChangeText(action[3]); });
      await act(async () => { hostOf(field, 'TextInput')[0].props.onBlur(); });
      return;
    }
    case 'openPicker': {
      const field = dateField(action[2] as DateField);
      await press(hostOf(field, 'TouchableOpacity').find((node) => node.props.accessibilityState?.expanded !== undefined), 'calendar');
      return;
    }
    case 'pickDate': {
      const field = dateField(action[2] as DateField);
      const picker = hostOf(field, 'DateTimePicker')[0];
      if (!picker) throw new Error('The date picker is closed');
      const [year, month, day] = String(action[3]).split('-').map(Number);
      await act(async () => { picker.props.onChange({ type: 'set' }, new Date(year, month - 1, day)); });
      return;
    }
    default:
      throw new Error(`Unknown organize action ${JSON.stringify(action)}`);
  }
}

async function runAction(root: ReactTestInstance, action: BulkScenarioAction) {
  switch (action[0]) {
    case 'select': {
      const row = taskRows(root).find((entry) => entry.task.id === action[1]);
      if (!row) throw new Error(`No row ${action[1]}`);
      await act(async () => { row.actions.toggleSelect?.(row.task); });
      return;
    }
    case 'range':
      await press(hostOf(barOf(root)!, 'TouchableOpacity').find((node) => node.props.testID === 'task-list-range-select-toggle'), 'Range');
      return;
    case 'move': {
      const label = `${t('bulk.moveTo')} ${t(`status.${action[1]}`)}`;
      await press(hostOf(barOf(root)!, 'TouchableOpacity').find((node) => node.props.accessibilityLabel === label), label);
      return;
    }
    case 'exit':
      await press(hostOf(barOf(root)!, 'TouchableOpacity')[0], 'exit');
      return;
    case 'addTag': {
      if (action[1] === 'open') {
        await press(hostOf(barOf(root)!, 'TouchableOpacity').find((node) => node.props.accessibilityLabel === t('bulk.addTag')), 'Add tag');
        return;
      }
      const modal = tagModalOf(root);
      if (!modal) throw new Error('The tag dialog is closed');
      if (action[1] === 'type') {
        await act(async () => { hostOf(modal, 'TextInput')[0].props.onChangeText(action[2]); });
        return;
      }
      const [cancel, save] = hostOf(modal, 'TouchableOpacity');
      await press(action[1] === 'save' ? save : cancel, action[1]);
      return;
    }
    case 'removeTag': {
      if (action[1] === 'open') {
        await press(hostOf(barOf(root)!, 'TouchableOpacity').find((node) => node.props.accessibilityLabel === t('bulk.removeTag')), 'Remove tag');
        return;
      }
      const picker = removePickerOf(root);
      if (!picker) throw new Error('The remove-tag picker is closed');
      await act(async () => {
        if (action[1] === 'confirm') picker.props.onConfirm(action[2]);
        else picker.props.onClose();
      });
      return;
    }
    case 'delete': {
      await press(hostOf(barOf(root)!, 'TouchableOpacity').find((node) => node.props.accessibilityLabel === t('common.delete')), 'Delete');
      const buttons = alertLog.entries.at(-1)?.buttons ?? [];
      const button = buttons.find((entry) => (action[1] === 'confirm' ? entry.style === 'destructive' : entry.style === 'cancel'));
      if (!button) throw new Error('No delete confirmation');
      await act(async () => { await button.onPress?.(); });
      return;
    }
    case 'undo': {
      const undo = lastToastAction;
      if (!undo) throw new Error('No Undo');
      lastToastAction = null;
      await act(async () => { undo(); });
      return;
    }
    case 'moveToSection': {
      if (action[1] === 'open') {
        await press(hostOf(barOf(root)!, 'TouchableOpacity').find((node) => node.props.accessibilityLabel === t('viewSections.moveToSection')), 'Move to section');
        return;
      }
      const modal = sectionMoveModalOf(root);
      if (!modal) throw new Error('The section picker is closed');
      await press(hostOf(modal, 'TouchableOpacity').find((node) => node.props.accessibilityLabel === t('common.cancel')), 'Cancel');
      return;
    }
    case 'organize':
      await runOrganizeAction(root, action);
      return;
    case 'includeArchivedProjects': {
      // Reference's filter sheet switch, as its top content renders it.
      const toggle = hostOf(root, 'Switch')[0];
      if (!toggle) throw new Error('No archived projects switch');
      await act(async () => { toggle.props.onValueChange(true); });
      return;
    }
  }
}

const NO_CUES: Record<ProjectSequenceTaskCue, string> = { available: 'Available next action', later: 'Later' };
const noCue = () => undefined;
const ignore = () => undefined;

/** The project workspace's list as ProjectDetailModal mounts it, with the bulk bar it pins above its toolbar. */
function ProjectHarness({ sortBy = 'default' }: { sortBy?: TaskSortBy } = {}) {
  const [barProps, setBarProps] = React.useState<TaskListBulkBarProps | null>(null);
  const [reorderMode, setReorderMode] = React.useState(false);
  const launch = useTaskStore((state) => state._allProjects.find((entry) => entry.id === 'p-launch')!);
  const allTasks = useTaskStore((state) => state._allTasks);
  const projectTasks = React.useMemo(() => allTasks.filter((entry) => entry.projectId === 'p-launch' && !entry.deletedAt), [allTasks]);
  const listRef = React.useRef(null);
  return (
    <>
      {barProps ? <TaskListBulkBar {...barProps} /> : null}
      <ProjectTaskList
        project={launch}
        tasks={projectTasks}
        showCompletedTasks={false}
        sortBy={sortBy}
        getTaskSequenceCue={noCue}
        sequenceCueLabels={NO_CUES}
        reorderMode={reorderMode}
        onReorderModeChange={setReorderMode}
        listHeaderComponent={null}
        listRef={listRef}
        onListScroll={ignore}
        contentPaddingBottom={12}
        onBulkBarPropsChange={setBarProps}
        filterOpenSignal={0}
        onFilterStateChange={ignore}
      />
    </>
  );
}

const SCREENS: Record<BulkList, () => React.ReactElement> = {
  inbox: () => <InboxScreen />,
  waiting: () => <WaitingView />,
  someday: () => <SomedayView />,
  reference: () => <ReferenceScreen />,
  done: () => <DoneScreen />,
  project: () => <ProjectHarness />,
};

async function runScenario(scenario: BulkScenario) {
  writeLog.splice(0);
  toastLog.entries.splice(0);
  alertLog.entries.splice(0);
  lastToastAction = null;
  asyncStore.values.clear();
  await seedStore();
  writeLog.splice(0);
  taskSnapshot = new Map(useTaskStore.getState()._allTasks.map((entry) => [entry.id, JSON.stringify(normalize(entry))]));

  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(SCREENS[scenario.list]()); });
  await settle();
  const root = renderer.root;
  const observations: Record<string, unknown>[] = [observe(root)];
  for (const action of scenario.actions) {
    try {
      await runAction(root, action);
      await settle();
      await act(async () => { await flushPendingSave(); });
      await settle();
    } catch (error) {
      throw new Error(`${scenario.name}: ${JSON.stringify(action)} failed after ${JSON.stringify(observations.at(-1))}\n${String(error)}\n${(error as Error).stack ?? ''}`);
    }
    observations.push(observe(root));
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
  const declared = process.env.MINDWTR_CAPTURE_BULK_ACTIONS_COMMIT;
  if (declared !== head) {
    throw new Error(`Recapture needs MINDWTR_CAPTURE_BULK_ACTIONS_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  }
  const allowed = new Set([
    'apps/mobile/components/task-list/bulk-actions-parity.test.tsx',
    'packages/core/src/task-list-bulk-actions-parity.fixtures.json',
  ]);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_BULK_ACTIONS=1 MINDWTR_CAPTURE_BULK_ACTIONS_COMMIT=$(git rev-parse HEAD) bunx vitest run components/task-list/bulk-actions-parity.test.tsx',
    capturedAt: head,
    capturedAtNote: 'Recorded the React Native picker display order from HEAD; only the test harness and fixture changed during capture.',
  };
}

describe('React Native task list selection mode parity fixture', () => {
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
  }, 30_000);
  afterAll(() => {
    vi.useRealTimers();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('leaves project selection for the existing reorder mode and returns with the selection cleared', async () => {
    await seedStore();
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ProjectHarness />); });
    const row = taskRows(renderer.root)[0];
    await act(async () => { row.actions.toggleSelect(row.task); });
    expect(taskRows(renderer.root).some((entry) => entry.isMultiSelected)).toBe(true);
    const before = useTaskStore.getState()._allTasks;

    await press(hostOf(barOf(renderer.root)!, 'TouchableOpacity')
      .find((node) => node.props.testID === 'task-list-reorder-shortcut'), 'Reorder');

    expect(barOf(renderer.root)).toBeNull();
    expect(hostOf(renderer.root, 'DraggableFlatList')).toHaveLength(1);
    await press(hostOf(renderer.root, 'TouchableOpacity')
      .find((node) => node.props.testID === 'project-task-reorder-toggle'), 'Done reordering');
    expect(taskRows(renderer.root).every((entry) => !entry.selectionMode && !entry.isMultiSelected)).toBe(true);
    expect(barOf(renderer.root)).toBeNull();
    expect(useTaskStore.getState()._allTasks).toBe(before);
    await act(async () => { renderer.unmount(); });
  });

  it('keeps the shortcut out of custom-sorted projects and unrelated lists', async () => {
    for (const screen of [<ProjectHarness sortBy="title" />, <InboxScreen />]) {
      await seedStore();
      let renderer!: ReactTestRenderer;
      await act(async () => { renderer = create(screen); });
      const row = taskRows(renderer.root)[0];
      await act(async () => { row.actions.toggleSelect(row.task); });
      expect(barOf(renderer.root)).not.toBeNull();
      expect(hostOf(barOf(renderer.root)!, 'TouchableOpacity')
        .some((node) => node.props.testID === 'task-list-reorder-shortcut')).toBe(false);
      await act(async () => { renderer.unmount(); });
    }
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) {
      captured[scenario.name] = await runScenario(scenario);
    }
    const inputs = normalize({ timeZone: TIME_ZONE, now: NOW, tasks, projects, areas, settings, scenarios }) as Record<string, unknown>;
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs, observations: captured }, null, 1)}\n`);
    }
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const { observations, provenance: _provenance, ...frozenInputs } = fixture;
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 240_000);
});
