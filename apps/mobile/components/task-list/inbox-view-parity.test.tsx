


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
  type Project,
  type Task,
} from '@mindwtr/core';

import InboxScreen from '../../app/(drawer)/(tabs)/inbox';

const FIXTURE_PATH = new URL('../../../../packages/core/src/inbox-view-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_INBOX_VIEW === '1';

const english = vi.hoisted(() => ({ strings: {} as Record<string, string> }));
const asyncStore = vi.hoisted(() => ({ values: new Map<string, string>() }));
const captureLog = vi.hoisted(() => ({ calls: [] as unknown[] }));

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
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
  useToastBottomOffset: vi.fn(),
  ToastViewport: () => null,
}));
vi.mock('expo-router', () => {
  const router = { push: vi.fn(), back: vi.fn(), replace: vi.fn() };
  return {
    router,
    useRouter: () => router,
    usePathname: () => '/inbox',
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
vi.mock('@/lib/performance-diagnostics', () => ({
  beginMobilePerformanceDiagnostic: vi.fn(() => null),
  finishMobilePerformanceDiagnostic: vi.fn(),
  logMobilePerformanceDiagnostic: vi.fn(),
  resolveMobilePerformanceRoute: vi.fn(() => 'inbox'),
}));
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('@/hooks/use-manual-pull-sync', () => ({
  useManualPullSync: () => ({ refreshing: false, onRefresh: vi.fn(), indicatorState: 'idle' }),
}));
vi.mock('@/hooks/use-android-activity-session', () => ({ useAndroidActivitySession: () => ({ clear: vi.fn() }) }));
vi.mock('@/contexts/quick-capture-context', () => ({
  useQuickCapture: () => ({ openQuickCapture: (options: unknown) => { captureLog.calls.push(options); } }),
}));
vi.mock('../inbox-processing-modal', () => ({ InboxProcessingModal: () => null }));
vi.mock('../task-edit-modal', () => ({ TaskEditModal: () => null }));
vi.mock('../swipeable-task-item', () => ({
  SwipeableTaskItem: () => null,
  readTaskRowRenderCount: () => 0,
}));
vi.mock('./TaskListBulkOrganizeModal', () => ({ TaskListBulkOrganizeModal: () => null }));
vi.mock('./TaskListTagModal', () => ({ TaskListTagModal: () => null }));
vi.mock('../token-picker-modal', () => ({ TokenPickerModal: () => null }));
vi.mock('../PullSyncIndicator', () => ({ PullSyncIndicator: () => null }));
vi.mock('../task-filter-sheet', () => ({
  FilterChip: (props: any) => React.createElement('FilterChip', props),
  TaskFilterSheet: (props: any) => React.createElement('TaskFilterSheet', props, props.topContent ?? null),
}));
vi.mock('../list-overflow-menu', () => ({
  ListOverflowMenu: (props: any) => React.createElement('ListOverflowMenu', props),
}));


export const TIME_ZONE = 'America/New_York';
export const NOW = '2026-09-24T14:00:00.000Z';
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
  project('p-spanish', 'Learn Spanish', 'someday', 3, { areaId: 'a-home' }),
  project('p-garden', 'Garden', 'someday', 4, { isFocused: true }),
  project('p-gone', 'Removed', 'active', 5, { deletedAt: at('02') }),
];
const INBOX_IDS = ['i-dentist', 'i-milk', 'i-party', 'i-gutter', 'i-article', 'i-seeds', 'i-orphan', 'i-removed'];
const tasks: Task[] = [
  task('i-dentist', 'Call dentist', 'inbox', '20', { contexts: ['@phone'], tags: ['#health'], priority: 'high' }),
  task('i-milk', 'Buy milk', 'inbox', '21', { contexts: ['@errands'], dueDate: '2026-09-25' }),
  task('i-party', 'Plan launch party', 'inbox', '18', {
    projectId: 'p-launch', tags: ['#work'], energyLevel: 'low', startTime: '2026-09-30',
  }),
  task('i-gutter', 'Fix gutter', 'inbox', '19', {
    projectId: 'p-home', contexts: ['@home', '@phone'], timeEstimate: '30min', description: 'Before winter',
    checklist: [{ id: 'c1', title: 'Ladder', isCompleted: true }, { id: 'c2', title: 'Gloves', isCompleted: false }],
  }),
  task('i-article', 'Read article', 'inbox', '22', { areaId: 'a-home', tags: ['#reading'], location: 'Library' }),
  task('i-seeds', 'Order seeds', 'inbox', '17', { projectId: 'p-garden', dueDate: '2026-10-01T09:00' }),
  task('i-orphan', 'Loose capture', 'inbox', '16', { projectId: 'p-missing' }),
  task('i-archived', 'Archived capture', 'inbox', '15', { projectId: 'p-old' }),
  task('i-parked', 'Parked capture', 'inbox', '15', { projectId: 'p-spanish' }),
  task('i-removed', 'Removed project capture', 'inbox', '15', { projectId: 'p-gone' }),
  task('i-deleted', 'Deleted capture', 'inbox', '15', { deletedAt: at('21') }),
  task('n-a', 'Draft launch post', 'next', '19', { projectId: 'p-launch', contexts: ['@phone'] }),
  task('d-a', 'Filed taxes', 'done', '15', { completedAt: '2026-09-23T10:00:00.000Z' }),
];

const extraTasks: Task[] = Array.from({ length: 100 }, (_, index) => {
  const n = String(index + 1).padStart(3, '0');
  return task(`x-${n}`, `Capture ${n}`, 'inbox', String(1 + (index % 28)).padStart(2, '0'));
});
const settingsVariants: Record<string, AppSettings> = {
  base: {},
  features: { features: { priorities: true, timeEstimates: true } },
  audio: { gtd: { defaultCaptureMethod: 'audio' } },
  staleTimeEstimate: { taskSortBy: 'timeEstimate' },
  areaWork: { filters: { areaIds: ['a-work'] } },
};

export type InboxViewAction =
  | ['sort', string]
  | ['group', string]
  | ['collapse', string]
  | ['filter', 'token' | 'priority' | 'energy' | 'search' | 'location', string]
  | ['matchMode', 'context' | 'tag', 'all' | 'any']
  | ['clearChip', string]
  | ['clearFilters']
  | ['emptyAction'];
export type InboxViewScenario = {
  name: string;
  settings: string;

  omit?: string[];

  extra?: number;
  actions: InboxViewAction[];
};

export const scenarios: InboxViewScenario[] = [
  {
    name: 'inbox: toolbar, grouping and sort',
    settings: 'base',
    actions: [
      ['group', 'context'],
      ['collapse', 'context:@phone'],
      ['group', 'area'],
      ['collapse', 'general'],
      ['group', 'context'],
      ['collapse', 'context:@phone'],
      ['group', 'project'],
      ['group', 'tag'],
      ['group', 'none'],
      ['sort', 'title'],
      ['sort', 'due'],
      ['sort', 'default'],
    ],
  },
  {
    name: 'inbox: filters, chips and the filtered empty state',
    settings: 'features',
    actions: [
      ['filter', 'token', '@phone'],
      ['filter', 'token', '@home'],
      ['matchMode', 'context', 'any'],
      ['filter', 'token', '@phone'],
      ['filter', 'token', '#work'],
      ['clearChip', 'excluded-token:@phone'],
      ['filter', 'priority', 'high'],
      ['filter', 'energy', 'low'],
      ['clearFilters'],
      ['filter', 'location', 'Library'],
      ['filter', 'search', 'launch'],
      ['clearChip', 'search'],
      ['filter', 'search', 'nomatch'],
      ['emptyAction'],
      ['sort', 'timeEstimate'],
    ],
  },
  {
    name: 'inbox: a stored time-estimate sort (the feature is on by default)',
    settings: 'staleTimeEstimate',
    actions: [['sort', 'title']],
  },
  { name: 'inbox: the Work area still lists every inbox task', settings: 'areaWork', actions: [['group', 'area']] },
  { name: 'inbox: empty with text capture', settings: 'base', omit: INBOX_IDS, actions: [['emptyAction']] },
  { name: 'inbox: empty with voice capture', settings: 'audio', omit: INBOX_IDS, actions: [['emptyAction']] },
  { name: 'inbox: one task', settings: 'base', omit: INBOX_IDS.filter((id) => id !== 'i-dentist'), actions: [] },
  { name: 'inbox: 99 tasks', settings: 'base', omit: INBOX_IDS, extra: 99, actions: [] },
  { name: 'inbox: 100 tasks', settings: 'base', omit: INBOX_IDS, extra: 100, actions: [['filter', 'search', 'Capture 00']] },
];


const t = (key: string) => english.strings[key] ?? key;
const writeLog: unknown[] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));

type RealActions = Pick<ReturnType<typeof useTaskStore.getState>, 'updateTask' | 'updateSettings'>;
let realActions: RealActions | null = null;

async function seedStore(scenario: InboxViewScenario) {
  resetForTests();
  const initial = useTaskStore.getState();
  realActions ??= { updateTask: initial.updateTask, updateSettings: initial.updateSettings };
  const real = realActions;
  const omit = scenario.omit ?? [];
  const data = JSON.parse(JSON.stringify({
    tasks: [...tasks.filter((entry) => !omit.includes(entry.id)), ...extraTasks.slice(0, scenario.extra ?? 0)],
    projects,
    sections: [],
    areas,
    people: [],
    settings: settingsVariants[scenario.settings],
  }));
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
  useTaskStore.setState({
    updateTask: async (id, updates) => { writeLog.push(['updateTask', id, normalize(updates)]); return real.updateTask(id, updates); },
    updateSettings: async (updates) => { writeLog.push(['updateSettings', normalize(updates)]); return real.updateSettings(updates); },
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
    renderer = create(element as React.ReactElement);
  });
  return renderer;
};

const buttonOf = (node: ReactTestInstance) => [
  node.props.accessibilityLabel ?? null,
  textOf(node),
  node.props.accessibilityState?.selected ?? null,
];

const rowOf = (flat: ReactTestInstance, item: unknown) => (
  flat.props.renderItem({ item, index: 0 }) as React.ReactElement<{ children: React.ReactElement<Record<string, unknown>> }>
).props.children.props;

const observe = (root: ReactTestInstance) => {
  const header = byName(root, 'TaskListHeader')[0];
  const headerButtons = hostOf(header, 'TouchableOpacity');
  const flat = hostOf(root, 'FlatList')[0];
  const scope = renderElement(flat.props.ListHeaderComponent);
  const emptyElement = flat.props.ListEmptyComponent as React.ReactElement<Record<string, unknown>>;
  const sheet = hostOf(root, 'TaskFilterSheet')[0];
  const { options, selections } = sheet.props;
  const observation = {

    items: (flat.props.data as Record<string, any>[]).map((item) => (item.type === 'section'
      ? ['section', item.id, item.title, item.count, item.muted === true, item.collapsible === true, item.collapsed === true]
      : ['task', item.task.id, item.groupId ?? null, rowOf(flat, item).interactionDisabled === true])),
    header: {
      count: header.props.count,
      title: header.props.title,
      showHeader: header.props.showHeader,
      directControls: header.props.directControls === true,
      sortByLabel: header.props.sortByLabel,
      groupByLabel: header.props.groupByLabel ?? null,
      filterActiveCount: header.props.filterActiveCount,
      hasActiveFilters: header.props.hasActiveFilters,
      chips: header.props.activeFilterChips.map((chip: { id: string; label: string; excluded?: boolean }) => [chip.id, chip.label, chip.excluded === true]),

      buttons: headerButtons.map(buttonOf),
    },

    primary: hostOf(root, 'TouchableOpacity').filter((node) => !headerButtons.includes(node)).map(buttonOf),
    scope: scope ? hostOf(scope.root, 'Text').map(textOf).filter(Boolean) : [],
    empty: { message: emptyElement.props.message, hint: emptyElement.props.hint ?? null, actionLabel: emptyElement.props.actionLabel ?? null },
    filterSheet: {
      tokens: options.tokens,
      projects: options.projects ?? null,
      timeEstimates: options.timeEstimates,
      visibility: options.visibility,
      chips: selections.chips.map((chip: { id: string; label: string; excluded?: boolean }) => [chip.id, chip.label, chip.excluded === true]),
      activeCount: selections.activeCount,
      contextMatchMode: selections.contextMatchMode,
      tagMatchMode: selections.tagMatchMode,
      showContextMatchMode: selections.showContextMatchMode,
      showTagMatchMode: selections.showTagMatchMode,
    },
    capture: normalize(captureLog.calls.splice(0)),
    writes: normalize(writeLog.splice(0)),
    stored: Object.fromEntries([...asyncStore.values.entries()].sort()),
  };
  act(() => { scope?.unmount(); });
  return observation;
};

async function openAndReadModal(root: ReactTestInstance, open: () => void, titleText: string) {
  await act(async () => { open(); });
  const modal = hostOf(root, 'Modal').find((node) => node.props.visible && textOf(hostOf(node, 'Text')[0]) === titleText);
  if (!modal) throw new Error(`No ${titleText} modal`);
  return modal;
}


async function listOptions(root: ReactTestInstance) {
  const header = () => byName(root, 'TaskListHeader')[0];
  const sortModal = await openAndReadModal(root, header().props.onOpenSort, t('sort.label'));
  const sort = hostOf(sortModal, 'Pressable').filter((node) => node.props.testID).map((node) => [
    node.props.testID.replace('sort-option-', ''), textOf(node), Array.isArray(node.props.style) && Boolean(node.props.style[1]),
  ]);
  await act(async () => { hostOf(sortModal, 'Pressable')[0].props.onPress(); });
  const groupModal = await openAndReadModal(root, header().props.onOpenGroup, t('list.groupBy'));
  const group = hostOf(groupModal, 'Pressable').slice(1).map((node) => [textOf(node), Array.isArray(node.props.style) && Boolean(node.props.style[1])]);
  await act(async () => { hostOf(groupModal, 'Pressable')[0].props.onPress(); });
  return { sort, group };
}

const GROUP_LABEL_KEYS: Record<string, string> = {
  none: 'list.groupByNone', context: 'list.groupByContext', area: 'list.groupByArea', project: 'taskEdit.projectLabel', tag: 'taskEdit.tagsLabel',
};

async function runAction(root: ReactTestInstance, action: InboxViewAction) {
  const header = () => byName(root, 'TaskListHeader')[0];
  const selections = () => hostOf(root, 'TaskFilterSheet')[0].props.selections;
  const flat = () => hostOf(root, 'FlatList')[0];
  switch (action[0]) {
    case 'sort': {
      const modal = await openAndReadModal(root, header().props.onOpenSort, t('sort.label'));
      const option = hostOf(modal, 'Pressable').find((node) => node.props.testID === `sort-option-${action[1]}`);
      if (!option) throw new Error(`No sort option ${action[1]}`);
      await act(async () => { option.props.onPress(); });
      return;
    }
    case 'group': {
      const modal = await openAndReadModal(root, header().props.onOpenGroup, t('list.groupBy'));
      const option = hostOf(modal, 'Pressable').slice(1).find((node) => textOf(node) === t(GROUP_LABEL_KEYS[action[1]]));
      if (!option) throw new Error(`No group option ${action[1]}`);
      await act(async () => { option.props.onPress(); });
      return;
    }
    case 'collapse': {
      const item = (flat().props.data as Record<string, any>[]).find((entry) => entry.type === 'section' && entry.id === action[1]);
      if (!item) throw new Error(`No group ${action[1]}`);
      const rendered = renderElement(flat().props.renderItem({ item, index: 0 }))!;
      await act(async () => { hostOf(rendered.root, 'TouchableOpacity')[0].props.onPress(); });
      act(() => { rendered.unmount(); });
      return;
    }
    case 'filter': {
      const [, kind, value] = action;
      await act(async () => {
        if (kind === 'token') selections().toggleToken(value);
        if (kind === 'priority') selections().togglePriority(value);
        if (kind === 'energy') selections().toggleEnergyLevel(value);
        if (kind === 'search') selections().setSearchQuery(value);
        if (kind === 'location') selections().setLocation(value);
      });
      return;
    }
    case 'matchMode':
      await act(async () => { selections().setMatchMode(action[1], action[2]); });
      return;
    case 'clearChip': {

      const chip = header().props.activeFilterChips.find((entry: { id: string }) => entry.id === action[1]);
      if (!chip) throw new Error(`No chip ${action[1]}`);
      await act(async () => { chip.onPress(); });
      return;
    }
    case 'clearFilters': {
      const clear = hostOf(header(), 'TouchableOpacity').at(-1)!;
      await act(async () => { clear.props.onPress(); });
      return;
    }
    case 'emptyAction': {
      const empty = flat().props.ListEmptyComponent as React.ReactElement<{ onAction?: () => void }>;
      await act(async () => { empty.props.onAction?.(); });
      return;
    }
  }
}

async function runScenario(scenario: InboxViewScenario) {
  writeLog.splice(0);
  captureLog.calls.splice(0);
  asyncStore.values.clear();
  await seedStore(scenario);
  writeLog.splice(0);

  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<InboxScreen />); });
  await settle();
  const root = renderer.root;
  const snapshot = () => normalize(observe(root)) as Record<string, unknown>;


  await act(async () => { byName(root, 'TaskListHeader')[0].props.onOpenFilters(); });
  const observations: Record<string, unknown>[] = [];
  const first = snapshot();
  Object.assign(first, normalize(await listOptions(root)));
  observations.push(first);
  for (const action of scenario.actions) {
    try {
      await runAction(root, action);
      await settle();
    } catch (error) {
      throw new Error(`${scenario.name}: ${JSON.stringify(action)} failed\n${String(error)}\n${(error as Error).stack ?? ''}`);
    }
    observations.push(snapshot());
  }
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}


function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const declared = process.env.MINDWTR_CAPTURE_INBOX_VIEW_COMMIT;
  if (declared !== head) {
    throw new Error(`Recapture needs MINDWTR_CAPTURE_INBOX_VIEW_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  }
  const allowed = new Set(['apps/mobile/components/task-list/inbox-view-parity.test.tsx', 'packages/core/src/inbox-view-parity.fixtures.json']);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_INBOX_VIEW=1 MINDWTR_CAPTURE_INBOX_VIEW_COMMIT=$(git rev-parse HEAD) bunx vitest run components/task-list/inbox-view-parity.test.tsx',
    capturedAt: head,
    capturedAtNote: 'Captured from HEAD\'s React Native code before any Inbox change: the harness and this fixture were the only changes in the checkout.',
  };
}

describe('React Native Inbox parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {

    (globalThis as { React?: typeof React }).React = React;
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
      timeZone: TIME_ZONE, now: NOW, tasks, extraTasks, projects, areas, settings: settingsVariants, scenarios,
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
