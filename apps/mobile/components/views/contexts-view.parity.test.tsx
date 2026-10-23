/**
 * React Native's Contexts screen, replayed against the frozen parity fixture that
 * core's contexts-view-model and the native host contract are tested against.
 *
 * MINDWTR_CAPTURE_LIST_VIEWS=1 rewrites the fixture's `contexts` part; its
 * `provenance` names the commit the observations were captured at. Each scenario renders the real screen
 * with the real core store, presses its chips, rows and bulk buttons, and records
 * what a user sees and what the store is asked to write.
 */
import React from 'react';
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
  type Project,
  type Task,
} from '@mindwtr/core';

import { ContextsView } from './contexts-view';

const FIXTURE_PATH = new URL('../../../../packages/core/src/list-views-model-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_LIST_VIEWS === '1';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  route: {} as { token?: string | string[] },
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
vi.mock('expo-router', () => ({ useLocalSearchParams: () => harness.route }));
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
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../task-edit-modal', () => ({ TaskEditModal: (props: any) => React.createElement('TaskEditModal', props) }));
vi.mock('../token-picker-modal', () => ({ TokenPickerModal: (props: any) => React.createElement('TokenPickerModal', props) }));
vi.mock('../swipeable-task-item', () => ({ SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props) }));
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
const at = (day: string) => `2026-09-${day}T12:00:00.000Z`;
const task = (id: string, title: string, day: string, extra: Partial<Task> = {}): Task => ({
  id, title, status: 'next', contexts: [], tags: [], createdAt: at(day), updatedAt: at(day), ...extra,
});

const areas: Area[] = [
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: at('01'), updatedAt: at('01') },
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: at('01'), updatedAt: at('01') },
];
const projects: Project[] = [
  { id: 'p-launch', title: 'Launch', status: 'active', color: '#94a3b8', order: 0, tagIds: [], areaId: 'a-work', createdAt: at('01'), updatedAt: at('01') },
  { id: 'p-parked', title: 'Parked', status: 'someday', color: '#94a3b8', order: 1, tagIds: [], createdAt: at('01'), updatedAt: at('01') },
];
const allTasks: Task[] = [
  task('c-call', 'Call Alice', '10', { contexts: ['@phone'], dueDate: '2026-09-25' }),
  task('c-email', 'Email Bob', '11', { contexts: ['@computer'], tags: ['#work'], projectId: 'p-launch' }),
  task('c-sink', 'Fix sink', '12', { status: 'waiting', tags: ['#home'], areaId: 'a-home' }),
  task('c-plan', 'Plan trip', '13', { status: 'inbox' }),
  task('c-deep', 'Deep work block', '14', { contexts: ['@computer/deep'], tags: ['#work', '#focus'], priority: 'high' }),
  task('c-idea', 'Garden idea', '15', { status: 'someday', contexts: ['@phone'], areaId: 'a-home' }),
  task('c-ref', 'Router manual', '16', { status: 'reference', tags: ['#home'] }),
  task('c-done', 'Paid bills', '17', { status: 'done', contexts: ['@phone'], completedAt: at('18') }),
  task('c-archived', 'Old call', '17', { status: 'archived', contexts: ['@phone'], completedAt: at('18') }),
  task('c-parked', 'Parked task', '17', { contexts: ['@computer'], projectId: 'p-parked' }),
  task('c-trashed', 'Trashed task', '17', { contexts: ['@phone'], deletedAt: at('19') }),
];
const settingsVariants: Record<string, AppSettings> = {
  base: {},
  sorted: { taskSortBy: 'title' },
  homeArea: { filters: { areaIds: ['a-home'] } },
};

type Action =
  | ['search', string]
  | ['chip', string]
  | ['chipTap', string]
  | ['matchMode', 'all' | 'any']
  | ['row', string, 'edit' | 'remove' | 'toggleSelect']
  | ['row', string, 'changeStatus', string]
  | ['rowToken', string]
  | ['editorNavigate', 'context' | 'tag', string]
  | ['bulk', string, number?]
  | ['picker', 'confirm', string[]]
  | ['picker', 'close']
  | ['alert', string]
  | ['toastAction'];
type Scenario = { name: string; settings: string; taskIds?: string[]; route?: { token?: string | string[] }; actions: Action[] };

export const scenarios: Scenario[] = [
  {
    name: 'chips, counts and chip search',
    settings: 'base',
    actions: [['search', 'COM'], ['search', '  work '], ['search', 'zzz'], ['search', '']],
  },
  {
    name: 'token toggles, match mode and No context',
    settings: 'base',
    actions: [
      ['chip', '@phone'],
      ['chip', '#work'],
      ['matchMode', 'any'],
      ['matchMode', 'all'],
      ['matchMode', 'any'],
      ['chip', '#work'],
      ['chip', '@phone'],
      ['chip', '@computer'],
      ['chip', '#home'],
      ['chip', 'No context'],
      ['chip', '@phone'],
      ['chip', 'No context'],
      ['chip', 'No context'],
      ['chip', '#focus'],
      ['chip', 'All Contexts'],
    ],
  },
  {
    name: 'a tap switches to one token, long-press combines',
    settings: 'base',
    actions: [
      ['chipTap', '@phone'],
      ['chipTap', '#work'],
      ['chip', '@phone'],
      ['matchMode', 'any'],
      ['chipTap', '@phone'],
      ['chipTap', '@phone'],
      ['chipTap', 'No context'],
      ['chipTap', '@computer/deep'],
      ['chip', '@computer/deep'],
      ['chipTap', 'No context'],
      ['chip', '#home'],
      ['chipTap', 'All Contexts'],
    ],
  },
  {
    name: 'a deep link selects its tokens',
    settings: 'base',
    route: { token: ['@phone', '#work', '@phone'] },
    actions: [['matchMode', 'any']],
  },
  {
    name: 'a deep link to No context',
    settings: 'base',
    route: { token: ['#work', '__no_context__'] },
    actions: [],
  },
  {
    name: 'a blank deep link selects nothing',
    settings: 'base',
    route: { token: '   ' },
    actions: [],
  },
  {
    name: 'row actions, token taps and editor navigation',
    settings: 'base',
    actions: [
      ['chip', '@phone'],
      ['chip', '#work'],
      ['matchMode', 'any'],
      ['rowToken', '@computer'],
      ['row', 'c-email', 'edit'],
      ['editorNavigate', 'tag', '#home'],
      ['editorNavigate', 'context', '@phone'],
      ['row', 'c-call', 'changeStatus', 'done'],
      ['chip', 'All Contexts'],
      ['row', 'c-plan', 'remove'],
    ],
  },
  {
    name: 'bulk move, tokens, delete and undo',
    settings: 'base',
    actions: [
      ['row', 'c-call', 'toggleSelect'],
      ['row', 'c-sink', 'toggleSelect'],
      ['bulk', 'Add tag'],
      ['picker', 'close'],
      ['bulk', 'Add tag'],
      ['picker', 'confirm', ['#errand']],
      ['row', 'c-call', 'toggleSelect'],
      ['row', 'c-email', 'toggleSelect'],
      ['bulk', 'Remove tag'],
      ['picker', 'confirm', ['#work']],
      ['row', 'c-deep', 'toggleSelect'],
      ['row', 'c-plan', 'toggleSelect'],
      ['bulk', 'Add context'],
      ['picker', 'confirm', ['@desk']],
      ['row', 'c-deep', 'toggleSelect'],
      ['bulk', 'Remove context'],
      ['picker', 'confirm', ['@computer/deep']],
      ['row', 'c-sink', 'toggleSelect'],
      ['row', 'c-plan', 'toggleSelect'],
      ['bulk', 'Someday'],
      ['row', 'c-email', 'toggleSelect'],
      ['row', 'c-deep', 'toggleSelect'],
      ['bulk', 'Delete'],
      ['alert', 'Cancel'],
      ['bulk', 'Delete'],
      ['alert', 'Delete'],
      ['toastAction'],
      ['row', 'c-call', 'toggleSelect'],
      ['bulk', 'Done', 0],
    ],
  },
  {
    name: 'a selected row that leaves the list leaves the selection',
    settings: 'base',
    actions: [
      ['row', 'c-call', 'toggleSelect'],
      ['row', 'c-email', 'toggleSelect'],
      ['chip', '@phone'],
      ['chip', '@phone'],
      ['bulk', 'Done', 1],
    ],
  },
  {
    name: 'no tokens at all',
    settings: 'base',
    taskIds: ['c-plan', 'c-done'],
    actions: [['chip', 'No context'], ['chip', 'No context']],
  },
  {
    name: 'nothing matches the selection',
    settings: 'base',
    taskIds: ['c-call', 'c-email'],
    actions: [['chip', 'No context'], ['chip', 'All Contexts']],
  },
  {
    name: 'an empty store',
    settings: 'base',
    taskIds: [],
    actions: [],
  },
  {
    name: 'the saved title sort',
    settings: 'sorted',
    actions: [],
  },
  {
    name: 'the Home area only',
    settings: 'homeArea',
    actions: [['chip', '#home']],
  },
];

type Write = unknown[];
const writeLog: Write[] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));
const encodeArgs = (args: unknown[]) => normalize(args.map((arg) => (
  arg && typeof arg === 'object' && !Array.isArray(arg)
    ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value === undefined ? '<undefined>' : value]))
    : arg
))) as unknown[];

const RECORDED = ['updateTask', 'deleteTask', 'restoreTask', 'batchMoveTasks', 'batchDeleteTasks', 'batchUpdateTasks'] as const;
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
const hostsOf = (root: ReactTestInstance, type: string) => root.findAll((node) => String(node.type) === type);
// A bulk button's name: its text, or the accessibility label of an icon-only button (the X exit).
const buttonName = (node: ReactTestInstance): string | undefined => textsIn(node)[0] ?? node.props.accessibilityLabel;

function observe(root: ReactTestInstance, seen: { alerts: number; toasts: number; writes: number }) {
  const chipRow = hostsOf(root, 'ScrollView').find((node) => node.props.horizontal && node.props.style !== undefined);
  const chips = chipRow
    ? hostsOf(chipRow, 'Pressable').map((node) => [node.props.accessibilityLabel, node.props.accessibilityState?.selected === true, textsIn(node)])
    : [];
  const radioGroup = root.findAll((node) => String(node.type) === 'View' && node.props.accessibilityRole === 'radiogroup')[0];
  const matchMode = radioGroup
    ? [textsIn(radioGroup)[0], hostsOf(radioGroup, 'Pressable').map((node) => [textsIn(node)[0], node.props.accessibilityState?.selected === true])]
    : null;
  const rows = hostsOf(root, 'SwipeableTaskItem').map((node) => [node.props.task.id, node.props.isMultiSelected === true]);
  const selectionMode = hostsOf(root, 'SwipeableTaskItem')[0]?.props.selectionMode ?? null;
  const flatList = hostsOf(root, 'FlatList')[0];
  const emptyIcon = flatList.findAll((node) => String(node.type).startsWith('Icon:'))[0];
  const empty = rows.length === 0 && emptyIcon ? [String(emptyIcon.type), ...textsIn(flatList)] : null;
  // The search row's Sort button (#1415) is not part of the bulk bar.
  const bulkButtons = hostsOf(root, 'TouchableOpacity')
    .filter((node) => !node.findAll((child) => String(child.type) === 'Icon:ArrowUpDown').length);
  const bulk = bulkButtons.length > 0
    ? bulkButtons.map((node) => [buttonName(node), node.props.disabled === true])
    : null;
  const pickerNode = hostsOf(root, 'TokenPickerModal')[0];
  const picker = pickerNode?.props.visible
    ? {
      title: pickerNode.props.title,
      description: pickerNode.props.description,
      tokens: pickerNode.props.tokens,
      placeholder: pickerNode.props.placeholder,
      allowCustomValue: pickerNode.props.allowCustomValue,
      multiSelect: pickerNode.props.multiSelect,
    }
    : null;
  const editorNode = hostsOf(root, 'TaskEditModal')[0];
  const observation = {
    search: hostsOf(root, 'TextInput')[0]?.props.value ?? null,
    chips,
    matchMode,
    rows,
    selectionMode,
    empty,
    bulk,
    picker,
    editor: editorNode?.props.visible ? editorNode.props.task?.id ?? null : null,
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
  if (kind === 'search') {
    await act(async () => { hostsOf(root, 'TextInput')[0].props.onChangeText(action[1]); });
    return;
  }
  if (kind === 'chip' || kind === 'chipTap') {
    const chip = root.findAll((node) => String(node.type) === 'Pressable' && (
      node.props.accessibilityLabel === action[1] || String(node.props.accessibilityLabel).startsWith(`${action[1]} (`)
    ))[0];
    if (!chip) throw new Error(`No chip ${action[1]}`);
    // 'chip' is the additive press, RN's long-press (the host's `additive`); 'chipTap' the tap (`next`) (#1427).
    await act(async () => { ((kind === 'chip' && chip.props.onLongPress) || chip.props.onPress)(); });
    return;
  }
  if (kind === 'matchMode') {
    const radios = root.findAll((node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'radio');
    await act(async () => { radios[action[1] === 'all' ? 0 : 1].props.onPress(); });
    return;
  }
  if (kind === 'row') {
    const row = hostsOf(root, 'SwipeableTaskItem').find((node) => node.props.task.id === action[1]);
    if (!row) throw new Error(`No row ${action[1]}`);
    const { actions, task: rowTask } = row.props;
    await act(async () => {
      if (action[2] === 'edit') actions.edit(rowTask);
      if (action[2] === 'remove') await actions.remove(rowTask);
      if (action[2] === 'toggleSelect') actions.toggleSelect(rowTask);
      if (action[2] === 'changeStatus') await actions.changeStatus(rowTask, action[3]);
    });
    return;
  }
  if (kind === 'rowToken') {
    const row = hostsOf(root, 'SwipeableTaskItem')[0];
    await act(async () => { (action[1].startsWith('#') ? row.props.onTagPress : row.props.onContextPress)(action[1]); });
    return;
  }
  if (kind === 'editorNavigate') {
    const editor = hostsOf(root, 'TaskEditModal')[0];
    await act(async () => { (action[1] === 'tag' ? editor.props.onTagNavigate : editor.props.onContextNavigate)(action[2]); });
    return;
  }
  if (kind === 'bulk') {
    const button = hostsOf(root, 'TouchableOpacity').filter((node) => buttonName(node) === action[1])[action[2] ?? 0];
    if (!button) throw new Error(`No bulk button ${action[1]}`);
    await act(async () => { await button.props.onPress(); });
    return;
  }
  if (kind === 'picker') {
    const picker = hostsOf(root, 'TokenPickerModal')[0];
    await act(async () => {
      if (action[1] === 'close') picker.props.onClose();
      else picker.props.onConfirm(action[2]);
    });
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

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  harness.alerts.length = 0;
  harness.toasts.length = 0;
  harness.storage.clear();
  harness.route = scenario.route ?? {};
  const tasks = scenario.taskIds ? allTasks.filter((entry) => scenario.taskIds!.includes(entry.id)) : allTasks;
  await seedStore(settingsVariants[scenario.settings], tasks);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ContextsView />); });
  const seen = { alerts: 0, toasts: 0, writes: 0 };
  const observations = [observe(renderer.root, seen)];
  for (const action of scenario.actions) {
    await perform(renderer.root, action);
    // Store writes settle through promises the press does not await.
    await act(async () => { await flushPendingSave(); });
    observations.push(observe(renderer.root, seen));
  }
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}

describe('React Native Contexts parity fixture', () => {
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
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ ...previous, contexts: { ...inputs, observations: captured } }, null, 1)}\n`);
    }
    const { observations, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).contexts;
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);
});
