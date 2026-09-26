/**
 * React Native's Archive screen, replayed against the `archive` part of the list
 * views parity fixture that core's archive-view-model and the native host contract
 * are tested against. MINDWTR_CAPTURE_LIST_VIEWS=1 rewrites that part.
 *
 * Each scenario renders the real screen with the real core store, uses its menus,
 * search, filter sheet, rows and bulk bar, and records what a user sees and what
 * the store is asked to write.
 */
import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_TASK_GROUP_OPTIONS,
  buildTaskGroupSections as buildCoreTaskGroupSections,
  flushPendingSave,
  getTaskGroupByLabel as getCoreTaskGroupByLabel,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Area,
  type Project,
  type Task,
} from '@mindwtr/core';

import ArchivedScreen from './archived';
import { buildTaskGroupSections, getTaskGroupByLabel } from '@/lib/task-group-sections';
import { ARCHIVED_LIST_GROUP_OPTIONS } from '@/lib/view-state/archived-list-view-state';

const FIXTURE_PATH = new URL('../../../../packages/core/src/list-views-model-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_LIST_VIEWS === '1';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  alerts: [] as { title: string; message: string; buttons: { text: string; style?: string; onPress?: () => unknown }[] }[],
  toasts: [] as { tone?: string; title?: string; message?: string; actionLabel?: string; onAction?: () => void }[],
  storage: new Map<string, string>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => harness.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { harness.storage.set(key, value); },
    removeItem: async (key: string) => { harness.storage.delete(key); },
  },
}));
vi.mock('expo-router', () => ({
  Redirect: (props: Record<string, unknown>) => React.createElement('Redirect', props),
  usePathname: () => '/history',
}));
vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => harness.strings[key] ?? key, language: 'en' }),
}));
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
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('@/components/task-edit-modal', () => ({ TaskEditModal: (props: any) => React.createElement('TaskEditModal', props) }));
vi.mock('@/components/task-filter-sheet', () => ({ TaskFilterSheet: (props: any) => React.createElement('TaskFilterSheet', props) }));
vi.mock('@/components/list-overflow-menu', () => ({ ListOverflowMenu: (props: any) => React.createElement('ListOverflowMenu', props) }));
vi.mock('@/components/completed-at-picker', () => ({ CompletedAtPicker: (props: any) => React.createElement('CompletedAtPicker', props) }));
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
  id, title, status: 'archived', contexts: [], tags: [], createdAt: at(day), updatedAt: at(day), ...extra,
});

const areas: Area[] = [
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: at('01'), updatedAt: at('01') },
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: at('01'), updatedAt: at('01') },
];
const projects: Project[] = [
  { id: 'p-launch', title: 'Launch', status: 'active', color: '#94a3b8', order: 0, tagIds: [], areaId: 'a-work', createdAt: at('01'), updatedAt: at('01') },
  { id: 'p-report', title: 'Board report', status: 'archived', color: '#2563eb', order: 1, tagIds: [], areaId: 'a-work', createdAt: at('01'), updatedAt: at('20', '15:00:00') },
  { id: 'p-trip', title: 'Summer trip', status: 'archived', color: '#94a3b8', order: 2, tagIds: [], areaId: 'a-home', cancelledAt: at('19', '16:00:00'), createdAt: at('01'), updatedAt: at('21') },
  { id: 'p-old', title: 'Old garden', status: 'archived', color: '', order: 3, tagIds: [], createdAt: at('01'), updatedAt: '2026-08-30T12:00:00.000Z' },
  { id: 'p-gone', title: 'Deleted project', status: 'archived', color: '#94a3b8', order: 4, tagIds: [], deletedAt: at('22'), createdAt: at('01'), updatedAt: at('22') },
];
const allTasks: Task[] = [
  task('ar-report', 'Quarterly report', '05', {
    completedAt: at('22', '15:30:00'), contexts: ['@office'], tags: ['#work'], projectId: 'p-launch',
    priority: 'high', timeEstimate: '30min', description: '**Final** numbers\nsecond line',
  }),
  task('ar-call', 'Call venue', '06', { cancelledAt: at('21', '13:00:00'), contexts: ['@phone'], areaId: 'a-home' }),
  task('ar-milk', 'Buy milk', '07', {
    completedAt: at('10'), contexts: ['@errand'], tags: ['#home', '#errand'], areaId: 'a-home', energyLevel: 'low', location: 'Market',
  }),
  task('ar-nodate', 'Old note', '08', { updatedAt: '2026-08-15T12:00:00.000Z' }),
  task('ar-alpha', 'Alpha review', '09', { completedAt: at('23', '09:00:00'), projectId: 'p-report', timeEstimate: '2hr' }),
  task('ar-gone', 'Deleted archived', '09', { completedAt: at('20'), deletedAt: at('21') }),
  task('n-next', 'Next thing', '10', { status: 'next', contexts: ['@office'] }),
  task('d-done', 'Done thing', '10', { status: 'done', completedAt: at('22') }),
];
const settingsVariants: Record<string, AppSettings> = {
  base: {},
  noFeatures: { features: { timeEstimates: false, priorities: false } },
  homeArea: { filters: { areaIds: ['a-home'] } },
};

type Action =
  | ['segment', 'tasks' | 'projects']
  | ['menu', 'sort' | 'group', string]
  | ['menu', 'filters']
  | ['header', string]
  | ['search', string]
  | ['filter', 'toggleToken' | 'togglePriority' | 'toggleEnergyLevel' | 'toggleTimeEstimate' | 'setLocation', string]
  | ['filter', 'clear' | 'close']
  | ['press', string]
  | ['swipe', string, 'restore' | 'delete']
  | ['row', string, 'open' | 'toggle' | 'completedAt']
  | ['pickCompletedAt', string]
  | ['editorSave', string, Record<string, unknown>]
  | ['alert', string]
  | ['toastAction'];
type Scenario = { name: string; settings: string; taskIds?: string[]; stored?: Record<string, unknown>; actions: Action[] };

export const scenarios: Scenario[] = [
  { name: 'rows, labels, summary and menus', settings: 'base', actions: [] },
  {
    name: 'sort options',
    settings: 'base',
    actions: [['menu', 'sort', 'title'], ['menu', 'sort', 'completed'], ['menu', 'sort', 'timeEstimate'], ['menu', 'sort', 'default']],
  },
  {
    name: 'a stored sort for a feature that is off',
    settings: 'noFeatures',
    stored: { groupBy: 'none', sortBy: 'timeEstimate' },
    actions: [['menu', 'filters']],
  },
  {
    name: 'grouping, folding and select all',
    settings: 'base',
    stored: { groupBy: 'completedDate' },
    actions: [
      ['header', 'completedDate:today'],
      ['press', 'Select'],
      ['press', 'Select all'],
      ['header', 'completedDate:today'],
      ['menu', 'group', 'context'],
      ['menu', 'group', 'area'],
      ['header', 'general'],
      ['menu', 'group', 'project'],
      ['menu', 'group', 'tag'],
      ['menu', 'group', 'none'],
    ],
  },
  {
    name: 'search, filters and clearing',
    settings: 'base',
    actions: [
      ['search', 'MILK'],
      ['search', 'zzz'],
      ['press', 'Clear'],
      ['menu', 'filters'],
      ['filter', 'toggleToken', '@office'],
      ['filter', 'toggleToken', '@office'],
      ['filter', 'togglePriority', 'high'],
      ['filter', 'toggleEnergyLevel', 'low'],
      ['filter', 'clear'],
      ['filter', 'toggleTimeEstimate', '2hr'],
      ['filter', 'setLocation', 'market'],
      ['filter', 'close'],
      ['search', 'id:ar-alpha'],
      ['filter', 'clear'],
    ],
  },
  {
    name: 'row actions',
    settings: 'base',
    actions: [
      ['swipe', 'ar-report', 'restore'],
      ['swipe', 'ar-milk', 'delete'],
      ['alert', 'Cancel'],
      ['swipe', 'ar-milk', 'delete'],
      ['alert', 'Delete'],
      ['row', 'ar-alpha', 'completedAt'],
      ['pickCompletedAt', '2026-09-20T10:00:00.000Z'],
      ['row', 'ar-call', 'open'],
      ['editorSave', 'ar-call', { title: 'Call the venue' }],
    ],
  },
  {
    name: 'bulk restore, delete and undo',
    settings: 'base',
    actions: [
      ['press', 'Select'],
      ['row', 'ar-report', 'toggle'],
      ['row', 'ar-milk', 'toggle'],
      ['row', 'ar-report', 'toggle'],
      ['row', 'ar-alpha', 'toggle'],
      ['press', 'Restore to Inbox'],
      ['press', 'Select'],
      ['press', 'Select all'],
      ['press', 'Delete'],
      ['alert', 'Delete'],
      ['toastAction'],
      ['press', 'Select'],
      ['press', 'Done'],
    ],
  },
  {
    name: 'projects segment',
    settings: 'base',
    actions: [
      ['segment', 'projects'],
      ['swipe', 'p-report', 'restore'],
      ['swipe', 'p-trip', 'delete'],
      ['alert', 'Cancel'],
      ['swipe', 'p-trip', 'delete'],
      ['alert', 'Delete'],
      ['swipe', 'p-old', 'restore'],
      ['segment', 'tasks'],
    ],
  },
  {
    name: 'selection mode ends when the segment changes',
    settings: 'base',
    actions: [['press', 'Select'], ['row', 'ar-milk', 'toggle'], ['segment', 'projects'], ['segment', 'tasks']],
  },
  { name: 'the Home area only', settings: 'homeArea', actions: [['segment', 'projects']] },
  { name: 'an empty archive', settings: 'base', taskIds: ['n-next'], actions: [['segment', 'projects']] },
];

const writeLog: unknown[][] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));
const encodeArgs = (args: unknown[]) => normalize(args.map((arg) => (
  arg && typeof arg === 'object' && !Array.isArray(arg)
    ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value === undefined ? '<undefined>' : value]))
    : arg
))) as unknown[];

const RECORDED = ['updateTask', 'deleteTask', 'restoreTask', 'batchMoveTasks', 'batchDeleteTasks', 'batchUpdateTasks', 'updateProject', 'deleteProject'] as const;
let realActions: Record<string, (...args: any[]) => Promise<unknown>> | null = null;

async function seedStore(settings: AppSettings, tasks: Task[]) {
  await flushPendingSave();
  resetForTests();
  const initial = useTaskStore.getState() as unknown as Record<string, (...args: any[]) => Promise<unknown>>;
  realActions ??= Object.fromEntries(RECORDED.map((name) => [name, initial[name]]));
  const real = realActions;
  const data = JSON.parse(JSON.stringify({ tasks, projects, sections: [], areas, people: [], settings }));
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  useTaskStore.setState({
    ...(real as object),
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    highlightTaskId: null,
  } as never);
  await useTaskStore.getState().fetchData({ throwOnError: true });
  await flushPendingSave();
  // Only the screen's own calls: batchMoveTasks calls batchUpdateTasks inside the store.
  let moving = 0;
  useTaskStore.setState(Object.fromEntries(RECORDED.map((name) => [name, async (...args: unknown[]) => {
    if (!(name === 'batchUpdateTasks' && moving > 0)) writeLog.push([name, ...encodeArgs(args)]);
    if (name !== 'batchMoveTasks') return real[name](...args);
    moving += 1;
    try {
      return await real[name](...args);
    } finally {
      moving -= 1;
    }
  }])) as never);
}

const textOf = (node: ReactTestInstance): string[] => {
  const children = node.props?.children;
  const list = Array.isArray(children) ? children.flat(Infinity) : [children];
  return list.filter((child) => typeof child === 'string' || typeof child === 'number').map(String);
};
const textsIn = (node: ReactTestInstance): string[] => node.findAll((child) => String(child.type) === 'Text')
  .map((child) => textOf(child).join(''));
const flatten = (style: unknown): Record<string, unknown> => (
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style && typeof style === 'object' ? style as Record<string, unknown> : {}
);
const hostsOf = (root: ReactTestInstance, type: string) => root.findAll((node) => String(node.type) === type);
const pressableByLabel = (root: ReactTestInstance, label: string) => root.findAll((node) => (
  String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
));

function describeMenu(actions: any[]) {
  return actions.map((action) => [
    action.id,
    action.label,
    action.accessibilityLabel ?? null,
    action.value ?? null,
    action.selected === true,
    action.submenu ? [action.submenu.title, action.submenu.actions.map((entry: any) => [entry.id, entry.label, entry.accessibilityLabel ?? null, entry.selected === true])] : null,
  ]);
}

function describeItems(root: ReactTestInstance) {
  const list = hostsOf(root, 'FlatList')[0];
  const items: unknown[] = [];
  list.findAll((node) => (
    String(node.type) === 'Pressable'
    && (String(node.props.testID ?? '').startsWith('archived-group-header-')
      || String(node.props.accessibilityLabel ?? '').startsWith('Open archived')
      || String(node.props.accessibilityLabel ?? '').startsWith(`${harness.strings['bulk.select']} `))
  )).forEach((node) => {
    if (String(node.props.testID ?? '').startsWith('archived-group-header-')) {
      items.push(['section', node.props.testID.slice('archived-group-header-'.length), textsIn(node), node.props.disabled === true, node.props.accessibilityState?.expanded ?? null]);
      return;
    }
    const title = node.findAll((child) => String(child.type) === 'Text')[0];
    const struck = flatten(title.props.style).textDecorationLine === 'line-through';
    const markdown = hostsOf(node, 'MarkdownInlineText')[0]?.props.markdown ?? null;
    const indicator = node.findAll((child) => String(child.type) === 'View').at(-1);
    const dateButton = node.findAll((child) => String(child.type) === 'Pressable' && child !== node)[0];
    items.push([
      node.props.accessibilityLabel,
      node.props.accessibilityState ?? null,
      textsIn(node),
      struck,
      markdown,
      flatten(indicator?.props.style).backgroundColor ?? null,
      dateButton ? [dateButton.props.accessibilityLabel, dateButton.props.disabled === true] : null,
    ]);
  });
  return items;
}

function observe(root: ReactTestInstance, seen: { alerts: number; toasts: number; writes: number }) {
  const segments = hostsOf(root, 'Pressable')
    .filter((node) => node.props.accessibilityRole === 'button' && node.props.accessibilityState && Object.keys(node.props.accessibilityState).length === 1
      && [harness.strings['archived.tasksSegment'], harness.strings['projects.title']].includes(node.props.accessibilityLabel))
    .map((node) => [node.props.accessibilityLabel, node.props.accessibilityState.selected === true]);
  const input = hostsOf(root, 'TextInput')[0];
  const menu = hostsOf(root, 'ListOverflowMenu')[0];
  const filtersButton = root.findAll((node) => node.props.testID === 'archived-active-filters-button')[0];
  const list = hostsOf(root, 'FlatList')[0];
  const listHasRows = describeItems(root).length > 0;
  const sheet = hostsOf(root, 'TaskFilterSheet')[0];
  const editor = hostsOf(root, 'TaskEditModal')[0];
  const picker = hostsOf(root, 'CompletedAtPicker')[0];
  const outside = root.findAll((node) => String(node.type) === 'Text' && !list.findAll((child) => child === node).length)
    .map((node) => textOf(node).join(''));
  const observation = {
    segments,
    search: input ? [input.props.value, input.props.placeholder] : null,
    filtersButton: filtersButton ? filtersButton.props.accessibilityLabel : null,
    menu: menu ? describeMenu(menu.props.actions) : null,
    header: outside,
    bulkButtons: hostsOf(root, 'Pressable').filter((node) => node.props.disabled !== undefined && !list.findAll((child) => child === node).length)
      .map((node) => [node.props.accessibilityLabel, node.props.disabled === true]),
    items: describeItems(root),
    empty: listHasRows ? null : [list.findAll((node) => String(node.type).startsWith('Icon:')).map((node) => String(node.type))[0] ?? null, ...textsIn(list)],
    filterSheet: sheet ? {
      visible: sheet.props.visible,
      tokens: sheet.props.options.tokens,
      visibility: sheet.props.options.visibility,
      activeCount: sheet.props.selections.activeCount,
      chips: sheet.props.selections.chips.map((chip: any) => [chip.id, chip.label, chip.excluded === true]),
    } : null,
    editor: editor?.props.visible ? editor.props.task?.id ?? null : null,
    completedAtPicker: picker ? picker.props.initialValue : null,
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
    await act(async () => { await node.props.onPress({ stopPropagation: () => undefined }); });
  };
  if (kind === 'segment') {
    const label = action[1] === 'tasks' ? harness.strings['archived.tasksSegment'] : harness.strings['projects.title'];
    await press(pressableByLabel(root, label)[0], label);
    return;
  }
  if (kind === 'menu') {
    const menu = hostsOf(root, 'ListOverflowMenu')[0];
    if (action[1] === 'filters') {
      await act(async () => { menu.props.actions.find((entry: any) => entry.id === 'filters').onPress(); });
      return;
    }
    const submenu = menu.props.actions.find((entry: any) => entry.id === action[1]).submenu;
    const option = submenu.actions.find((entry: any) => entry.id === `${action[1]}:${action[2]}`);
    if (!option) throw new Error(`No ${action[1]} option ${action[2]}`);
    await act(async () => { option.onPress(); });
    return;
  }
  if (kind === 'header') {
    await press(root.findAll((node) => node.props.testID === `archived-group-header-${action[1]}` && String(node.type) === 'Pressable')[0], action[1]);
    return;
  }
  if (kind === 'search') {
    await act(async () => { hostsOf(root, 'TextInput')[0].props.onChangeText(action[1]); });
    return;
  }
  if (kind === 'filter') {
    const selections = hostsOf(root, 'TaskFilterSheet')[0].props;
    await act(async () => {
      if (action[1] === 'clear') selections.selections.clear();
      else if (action[1] === 'close') selections.onClose();
      else selections.selections[action[1]](action[2]);
    });
    return;
  }
  if (kind === 'press') {
    const label = action[1] === 'Select all'
      ? `${harness.strings['bulk.select']} ${harness.strings['common.all']}`
      : action[1];
    await press(pressableByLabel(root, label)[0], label);
    return;
  }
  if (kind === 'swipe') {
    const rows = root.findAll((node) => String(node.type) === 'Swipeable');
    const row = rows.find((node) => node.findAll((child) => (
      String(child.type) === 'Pressable' && String(child.props.accessibilityLabel ?? '').endsWith(`: ${titleOf(action[1])}`)
    )).length > 0);
    if (!row) throw new Error(`No row ${action[1]}`);
    const [restore, remove] = row.findAll((child) => String(child.type) === 'Pressable');
    await press(action[2] === 'restore' ? restore : remove, action[1]);
    return;
  }
  if (kind === 'row') {
    const title = titleOf(action[1]);
    const node = root.findAll((child) => String(child.type) === 'Pressable'
      && (child.props.accessibilityLabel === `Open archived task details: ${title}`
        || child.props.accessibilityLabel === `${harness.strings['bulk.select']} ${title}`))[0];
    if (action[2] === 'completedAt') {
      await press(node.findAll((child) => String(child.type) === 'Pressable' && child !== node)[0], 'completion date');
      return;
    }
    await press(node, action[1]);
    return;
  }
  if (kind === 'pickCompletedAt') {
    const picker = hostsOf(root, 'CompletedAtPicker')[0];
    await act(async () => { picker.props.onConfirm(action[1]); });
    return;
  }
  if (kind === 'editorSave') {
    const editor = hostsOf(root, 'TaskEditModal')[0];
    await act(async () => { await editor.props.onSave(action[1], action[2]); });
    return;
  }
  if (kind === 'alert') {
    const button = harness.alerts.at(-1)!.buttons.find((entry) => entry.text === action[1]);
    await act(async () => { await button?.onPress?.(); });
    return;
  }
  if (kind === 'toastAction') {
    await act(async () => { harness.toasts.at(-1)!.onAction!(); });
    return;
  }
  throw new Error(`Unknown action ${kind}`);
}

const titleOf = (id: string) => [...allTasks, ...projects].find((entry) => entry.id === id)!.title;

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  harness.alerts.length = 0;
  harness.toasts.length = 0;
  harness.storage.clear();
  if (scenario.stored) harness.storage.set('mindwtr:view:archived:v1', JSON.stringify(scenario.stored));
  const tasks = scenario.taskIds ? allTasks.filter((entry) => scenario.taskIds!.includes(entry.id)) : allTasks;
  await seedStore(settingsVariants[scenario.settings], tasks);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ArchivedScreen />); });
  await act(async () => { await flushPendingSave(); });
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

describe('React Native Archive parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    process.env.TZ = TIME_ZONE;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    harness.strings = await loadTranslations('en');
  });
  afterAll(() => {
    vi.useRealTimers();
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
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ ...previous, archive: { ...inputs, observations: captured } }, null, 1)}\n`);
    }
    const { observations, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).archive;
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);

  it('draws Restore with a vector icon and speaks row labels in the app language', async () => {
    const english = harness.strings;
    harness.strings = {
      ...english,
      'archived.openTaskDetails': 'Archivierte Aufgabe öffnen: {{title}}',
      'archived.openProject': 'Archiviertes Projekt öffnen: {{title}}',
    };
    try {
      await seedStore(settingsVariants.base, allTasks);
      let renderer!: ReactTestRenderer;
      await act(async () => { renderer = create(<ArchivedScreen />); });
      const root = renderer.root;
      const restoreActions = () => hostsOf(root, 'Swipeable').map((row) => row.findAll((child) => String(child.type) === 'Pressable')[0]);
      const labels = () => hostsOf(root, 'Pressable').map((node) => String(node.props.accessibilityLabel ?? ''));

      expect(textsIn(root).filter((text) => text.includes('↩'))).toEqual([]);
      expect(restoreActions().every((action) => hostsOf(action, 'Icon:RotateCcw').length === 1)).toBe(true);
      expect(labels()).toContain('Archivierte Aufgabe öffnen: Quarterly report');

      await perform(root, ['segment', 'projects']);
      expect(restoreActions().length).toBeGreaterThan(0);
      expect(restoreActions().every((action) => hostsOf(action, 'Icon:RotateCcw').length === 1)).toBe(true);
      expect(labels()).toContain('Archiviertes Projekt öffnen: Board report');
      await act(async () => { renderer.unmount(); });
    } finally {
      harness.strings = english;
      await flushPendingSave();
    }
  });

  it('shows the error toast when reactivating an archived project fails', async () => {
    harness.toasts.length = 0;
    await seedStore(settingsVariants.base, allTasks);
    useTaskStore.setState({ updateProject: async () => ({ success: false, error: 'disk full' }) } as never);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ArchivedScreen />); });

    await perform(renderer.root, ['segment', 'projects']);
    await perform(renderer.root, ['swipe', 'p-report', 'restore']);

    await vi.waitFor(() => expect(harness.toasts.at(-1)).toMatchObject({ tone: 'error', message: 'disk full' }));
    await act(async () => { renderer.unmount(); });
    await flushPendingSave();
  });

  it.each([
    ['task', 'deleteTask', 'ar-milk', 'tasks'],
    ['project', 'deleteProject', 'p-trip', 'projects'],
  ] as const)('shows the error toast when deleting an archived %s fails', async (_kind, action, id, segment) => {
    harness.alerts.length = 0;
    harness.toasts.length = 0;
    await seedStore(settingsVariants.base, allTasks);
    useTaskStore.setState({ [action]: async () => ({ success: false, error: 'disk full' }) } as never);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ArchivedScreen />); });

    if (segment === 'projects') await perform(renderer.root, ['segment', 'projects']);
    await perform(renderer.root, ['swipe', id, 'delete']);
    await perform(renderer.root, ['alert', 'Delete']);

    await vi.waitFor(() => expect(harness.toasts.at(-1)).toMatchObject({ tone: 'error', message: 'disk full' }));
    await act(async () => { renderer.unmount(); });
    await flushPendingSave();
  });

  // One home: Archive, TaskList and Someday all group through core; the mobile
  // module only re-exports it.
  it('groups through core: the mobile grouping module re-exports it', () => {
    expect([...ARCHIVE_TASK_GROUP_OPTIONS]).toEqual([...ARCHIVED_LIST_GROUP_OPTIONS]);
    expect(buildTaskGroupSections).toBe(buildCoreTaskGroupSections);
    expect(getTaskGroupByLabel).toBe(getCoreTaskGroupByLabel);
  });
});
