/**
 * React Native's saved search screen, replayed against the frozen parity fixture
 * (packages/core/src/saved-search-parity.fixtures.json) that core's
 * saved-search-view-model and the native host contract are tested against.
 *
 * The fixture's `provenance` names the commit it was captured at. To recapture,
 * commit every other change first, then run
 *   MINDWTR_CAPTURE_SAVED_SEARCH=1 MINDWTR_CAPTURE_SAVED_SEARCH_COMMIT=$(git rev-parse HEAD) TZ=UTC bunx vitest run 'app/(drawer)/saved-search/saved-search.parity.test.tsx'
 * The capture refuses to run unless that commit is HEAD and the checkout holds
 * nothing but HEAD's code and these parity harnesses. Each scenario renders the
 * real screen with the real core store, uses its header, empty state, rows and
 * editor, and records what a user sees, where it navigates and what the store is
 * asked to write. The rows and the editor are stand-ins that record their props:
 * they are other screens' components.
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
  type Project,
  type Task,
} from '@mindwtr/core';

import SavedSearchScreen from './[id]';

const FIXTURE_PATH = new URL('../../../../../packages/core/src/saved-search-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_SAVED_SEARCH === '1';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  id: '' as string,
  canGoBack: false,
  navigation: [] as unknown[][],
  alerts: [] as { title: string; message: string; buttons: { text: string; style?: string; onPress?: () => unknown }[] }[],
}));

vi.mock('expo-router', () => ({
  router: {
    back: () => { harness.navigation.push(['back']); },
    canGoBack: () => harness.canGoBack,
    replace: (route: string) => { harness.navigation.push(['replace', route]); },
    push: (route: string) => { harness.navigation.push(['push', route]); },
  },
  useLocalSearchParams: () => ({ id: harness.id }),
}));
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => harness.strings[key] ?? key, language: 'en' }),
}));
vi.mock('@/contexts/theme-context', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('@/components/task-edit-modal', () => ({ TaskEditModal: (props: any) => React.createElement('TaskEditModal', props) }));
vi.mock('@/components/swipeable-task-item', () => ({ SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props) }));
vi.mock('lucide-react-native', () => ({
    ArrowUpDown: (props: any) => React.createElement('Icon:ArrowUpDown', props),
    Trash2: (props: any) => React.createElement('Icon:Trash2', props),
}));
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Alert: {
      alert: (title: string, message: string, buttons: (typeof harness.alerts)[number]['buttons']) => {
        harness.alerts.push({ title, message, buttons });
      },
    },
    RefreshControl: (props: any) => React.createElement('RefreshControl', props),
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

export const NOW = '2026-09-27T14:00:00.000Z';
const at = (day: string, time = '12:00:00') => `2026-09-${day}T${time}.000Z`;
const task = (id: string, title: string, day: string, extra: Partial<Task> = {}): Task => ({
  id, title, status: 'next', contexts: [], tags: [], createdAt: at(day), updatedAt: at(day), ...extra,
});

const areas: Area[] = [
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: at('01'), updatedAt: at('01') },
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: at('01'), updatedAt: at('01') },
];
const projects: Project[] = [
  { id: 'p-launch', title: 'Launch', status: 'active', color: '#94a3b8', order: 0, tagIds: [], areaId: 'a-work', createdAt: at('01'), updatedAt: at('01') },
  { id: 'p-garden', title: 'Garden', status: 'active', color: '#94a3b8', order: 1, tagIds: [], areaId: 'a-home', createdAt: at('01'), updatedAt: at('01') },
];
const tasks: Task[] = [
  task('t-milk', 'Buy milk', '10', { contexts: ['@errand'], areaId: 'a-home', dueDate: '2026-09-27' }),
  task('t-bank', 'Deposit check', '12', { contexts: ['@errand'], projectId: 'p-launch', priority: 'high' }),
  task('t-seeds', 'Buy seeds', '11', { contexts: ['@errand'], projectId: 'p-garden', status: 'someday' }),
  task('t-print', 'Print flyers', '09', { contexts: ['@errand', '@office'], status: 'inbox' }),
  task('t-done', 'Return library books', '08', { contexts: ['@errand'], status: 'done', completedAt: at('20') }),
  task('t-archived', 'Old errand', '05', { contexts: ['@errand'], status: 'archived', completedAt: at('06') }),
  task('t-deleted', 'Deleted errand', '05', { contexts: ['@errand'], deletedAt: at('06') }),
  task('t-report', 'Write report', '13', { projectId: 'p-launch', tags: ['#milk-run'] }),
  task('t-call', 'Call plumber', '14', { contexts: ['@phone'], areaId: 'a-home', status: 'waiting' }),
];
const savedSearches = [
  { id: 'ss-errands', name: 'Errands', query: '@errand' },
  { id: 'ss-milk', name: 'Milk run', query: 'milk' },
  { id: 'ss-next-work', name: 'Next at Launch', query: 'status:next project:Launch' },
  { id: 'ss-none', name: 'Nothing', query: 'zzz-nothing' },
  { id: 'ss-blank', name: 'Blank', query: '' },
];
const settingsVariants: Record<string, AppSettings> = {
  base: { savedSearches },
  titleSort: { savedSearches, taskSortBy: 'title' },
  homeArea: { savedSearches, filters: { areaIds: ['a-home'] } },
  noSaved: {},
};

type Action =
  | ['delete']
  | ['alert', string]
  | ['emptyAction', string]
  | ['row', string, 'edit' | 'remove']
  | ['row', string, 'status', Task['status']]
  | ['editorSave', string, Record<string, unknown>]
  | ['editorClose'];
type Scenario = { name: string; settings: string; id: string; canGoBack?: boolean; actions: Action[] };

export const scenarios: Scenario[] = [
  { name: 'results for a saved search', settings: 'base', id: 'ss-errands', actions: [] },
  { name: 'sorted by title', settings: 'titleSort', id: 'ss-errands', actions: [] },
  { name: 'the Home area only', settings: 'homeArea', id: 'ss-errands', actions: [] },
  { name: 'a text query', settings: 'base', id: 'ss-milk', actions: [] },
  { name: 'a status and project query', settings: 'base', id: 'ss-next-work', actions: [] },
  { name: 'a query with no results', settings: 'base', id: 'ss-none', actions: [] },
  { name: 'a blank query', settings: 'base', id: 'ss-blank', actions: [] },
  {
    name: 'an unknown saved search',
    settings: 'base',
    id: 'ss-gone',
    actions: [['emptyAction', 'Inbox'], ['emptyAction', 'Back']],
  },
  { name: 'an unknown saved search that can go back', settings: 'base', id: 'ss-gone', canGoBack: true, actions: [['emptyAction', 'Back']] },
  { name: 'no saved searches at all', settings: 'noSaved', id: 'ss-errands', actions: [] },
  {
    name: 'delete: cancel, then delete',
    settings: 'base',
    id: 'ss-milk',
    actions: [['delete'], ['alert', 'Cancel'], ['delete'], ['alert', 'Delete']],
  },
  { name: 'delete and go back', settings: 'base', id: 'ss-none', canGoBack: true, actions: [['delete'], ['alert', 'Delete']] },
  {
    name: 'row actions and the editor',
    settings: 'base',
    id: 'ss-errands',
    actions: [
      ['row', 't-bank', 'edit'],
      ['editorSave', 't-bank', { title: 'Deposit the check' }],
      ['row', 't-milk', 'edit'],
      ['editorClose'],
      ['row', 't-print', 'edit'],
      ['editorClose'],
      ['row', 't-milk', 'status', 'done'],
      ['row', 't-seeds', 'remove'],
    ],
  },
];

const writeLog: unknown[][] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));
const RECORDED = ['updateTask', 'deleteTask', 'updateSettings'] as const;
let realActions: Record<string, (...args: any[]) => Promise<unknown>> | null = null;

async function seedStore(settings: AppSettings) {
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
  useTaskStore.setState(Object.fromEntries(RECORDED.map((name) => [name, async (...args: unknown[]) => {
    writeLog.push([name, ...(normalize(args) as unknown[])]);
    return real[name](...args);
  }])) as never);
}

const textOf = (node: ReactTestInstance): string => {
  const children = node.props?.children;
  const list = Array.isArray(children) ? children.flat(Infinity) : [children];
  return list.filter((child) => typeof child === 'string' || typeof child === 'number').map(String).join('');
};
const hostsOf = (root: ReactTestInstance, type: string) => root.findAll((node) => String(node.type) === type);
const inside = (container: ReactTestInstance, node: ReactTestInstance) => container.findAll((child) => child === node).length > 0;
// The Sort control and its picker (#1453) came after the frozen capture; saved-search-screen.test.tsx covers them.
const isSortControl = (node: ReactTestInstance) => hostsOf(node, 'Icon:ArrowUpDown').length > 0;
const sortPickers = (root: ReactTestInstance) => hostsOf(root, 'Modal')
  .filter((modal) => modal.findAll((node) => node.props?.testID === 'sort-option-inherit').length > 0);

function observe(root: ReactTestInstance, seen: { writes: number; alerts: number; navigation: number }) {
  const list = hostsOf(root, 'FlatList')[0];
  const rows = hostsOf(list, 'SwipeableTaskItem');
  const editor = hostsOf(root, 'TaskEditModal')[0];
  const buttons = hostsOf(root, 'TouchableOpacity').filter((node) => !isSortControl(node));
  const pickers = sortPickers(root);
  const observation = {
    header: hostsOf(root, 'Text').filter((node) => !inside(list, node) && !pickers.some((picker) => inside(picker, node))).map(textOf),
    deleteButton: buttons.filter((node) => !inside(list, node)).map((node) => [node.props.accessibilityLabel ?? null, hostsOf(node, 'Icon:Trash2').length]),
    rows: rows.map((node) => node.props.task.id),
    rowProps: rows.length > 0 ? {
      sameActions: rows.every((node) => node.props.actions === rows[0].props.actions),
      handlers: [typeof rows[0].props.onProjectPress, typeof rows[0].props.onContextPress, typeof rows[0].props.onTagPress],
    } : null,
    empty: rows.length > 0 ? null : {
      texts: hostsOf(list, 'Text').map(textOf),
      actions: hostsOf(list, 'TouchableOpacity').map((node) => hostsOf(node, 'Text').map(textOf).join('')),
    },
    editor: editor ? [editor.props.visible === true, editor.props.task?.id ?? null, editor.props.defaultTab ?? null] : null,
    alerts: harness.alerts.slice(seen.alerts).map((alert) => [alert.title, alert.message, alert.buttons.map((button) => [button.text, button.style ?? null])]),
    navigation: harness.navigation.slice(seen.navigation),
    writes: writeLog.slice(seen.writes),
  };
  seen.writes = writeLog.length;
  seen.alerts = harness.alerts.length;
  seen.navigation = harness.navigation.length;
  return observation;
}

async function perform(root: ReactTestInstance, action: Action) {
  const [kind] = action;
  const list = hostsOf(root, 'FlatList')[0];
  if (kind === 'delete') {
    const button = hostsOf(root, 'TouchableOpacity').find((node) => !inside(list, node) && !isSortControl(node));
    if (!button) throw new Error('No delete button');
    await act(async () => { await button.props.onPress(); });
    return;
  }
  if (kind === 'alert') {
    const button = harness.alerts.at(-1)!.buttons.find((entry) => entry.text === action[1]);
    await act(async () => { await button?.onPress?.(); });
    return;
  }
  if (kind === 'emptyAction') {
    const button = hostsOf(list, 'TouchableOpacity').find((node) => hostsOf(node, 'Text').map(textOf).join('') === action[1]);
    if (!button) throw new Error(`No empty-state action ${action[1]}`);
    await act(async () => { await button.props.onPress(); });
    return;
  }
  if (kind === 'row') {
    const row = hostsOf(list, 'SwipeableTaskItem').find((node) => node.props.task.id === action[1]);
    if (!row) throw new Error(`No row ${action[1]}`);
    const { actions } = row.props;
    await act(async () => {
      if (action[2] === 'edit') await actions.edit(row.props.task);
      else if (action[2] === 'remove') await actions.remove(row.props.task);
      else await actions.changeStatus(row.props.task, action[3]);
    });
    return;
  }
  const editor = hostsOf(root, 'TaskEditModal')[0];
  if (kind === 'editorSave') {
    await act(async () => { await editor.props.onSave(action[1], action[2]); });
    return;
  }
  if (kind === 'editorClose') {
    await act(async () => { editor.props.onClose(); });
    return;
  }
  throw new Error(`Unknown action ${kind}`);
}

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  harness.alerts.length = 0;
  harness.navigation.length = 0;
  harness.id = scenario.id;
  harness.canGoBack = scenario.canGoBack === true;
  await seedStore(settingsVariants[scenario.settings]);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<SavedSearchScreen />); });
  await act(async () => { await flushPendingSave(); });
  const seen = { writes: 0, alerts: 0, navigation: 0 };
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

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const declared = process.env.MINDWTR_CAPTURE_SAVED_SEARCH_COMMIT;
  if (declared !== head) throw new Error(`Recapture needs MINDWTR_CAPTURE_SAVED_SEARCH_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  const allowed = new Set([
    'apps/mobile/components/mind-sweep-modal-content.parity.test.tsx',
    'apps/mobile/app/(drawer)/saved-search/saved-search.parity.test.tsx',
    'packages/core/src/mind-sweep-parity.fixtures.json',
    'packages/core/src/saved-search-parity.fixtures.json',
  ]);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '')).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_SAVED_SEARCH=1 MINDWTR_CAPTURE_SAVED_SEARCH_COMMIT=$(git rev-parse HEAD) TZ=UTC bunx vitest run \'app/(drawer)/saved-search/saved-search.parity.test.tsx\'',
    capturedAt: head,
    sourceState: 'Every file under apps/ and packages/ was at HEAD except the Mind Sweep and saved search parity harnesses and their fixtures.',
    rendering: 'react-test-renderer over the apps/mobile react-native shim (host elements by name). The rows (SwipeableTaskItem) and the editor (TaskEditModal) are stand-ins that record their props; a row action calls the screen\'s row actions directly. The area filter is the real useMobileAreaFilter over the real store. Strings are English.',
  };
}

describe('React Native saved search parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    harness.strings = await loadTranslations('en');
  }, 30_000);
  afterAll(() => {
    vi.useRealTimers();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    const inputs = normalize({ timeZone: 'UTC', now: NOW, tasks, projects, areas, settings: settingsVariants, scenarios }) as Record<string, unknown>;
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs, observations: captured }, null, 1)}\n`);
    }
    const { observations, provenance: _provenance, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);
});
