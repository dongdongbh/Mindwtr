


import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  flushPendingSave,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  SAVED_FILTER_NO_PROJECT_ID,
  useTaskStore,
  type AppSettings,
  type Area,
  type Project,
  type Task,
} from '@mindwtr/core';

import { BoardView } from './board-view';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  toasts: [] as { tone?: string; title?: string; message?: string }[],
  navigations: [] as unknown[][],
}));

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: (toast: (typeof harness.toasts)[number]) => { harness.toasts.push(toast); }, dismissToast: vi.fn() }),
}));
vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => harness.strings[key] ?? key, language: 'en' }),
}));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
  openTaskScreen: (...args: unknown[]) => { harness.navigations.push(args); },
}));
vi.mock('@/lib/use-android-keyboard-inset', () => ({ useKeyboardInset: () => 0 }));
vi.mock('../task-edit-modal', () => ({ TaskEditModal: (props: any) => React.createElement('TaskEditModal', props) }));
vi.mock('../task-filter-sheet', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    TaskFilterSheet: (props: any) => React.createElement('TaskFilterSheet', props, props.visible ? props.topContent : null),
  };
});
vi.mock('react-native-gesture-handler', () => {
  const gesture = (kind: string) => () => {
    const handlers: Record<string, (...args: any[]) => unknown> = {};
    const chain: Record<string, unknown> = { kind, handlers };
    ['activateAfterLongPress', 'activeOffsetY', 'failOffsetX'].forEach((method) => { chain[method] = () => chain; });
    ['onStart', 'onUpdate', 'onEnd'].forEach((method) => {
      chain[method] = (handler: (...args: any[]) => unknown) => { handlers[method] = handler; return chain; };
    });
    return chain;
  };
  return {
    Gesture: { Pan: gesture('pan'), Tap: gesture('tap'), Race: (...items: unknown[]) => items },
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),

    Swipeable: (props: any) => React.createElement('Swipeable', props, props.renderLeftActions?.(), props.children, props.renderRightActions?.()),
  };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: (props: any) => React.createElement('AnimatedView', props, props.children) },
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: unknown) => ({ value }),
  withSpring: (value: unknown) => value,
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

const FIXTURE_PATH = new URL('../../../../packages/core/src/board-views-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_BOARD_VIEWS === '1';
const TIME_ZONE = 'America/New_York';

const NOW = '2026-09-24T14:00:00.000Z';

const at = (day: string, time = '12:00:00') => `2026-${day}T${time}.000Z`;
const task = (id: string, title: string, status: Task['status'], day: string, extra: Partial<Task> = {}): Task => ({
  id, title, status, contexts: [], tags: [], createdAt: at(day), updatedAt: at(day), ...extra,
});

const project = (id: string, title: string, extra: Partial<Project> = {}): Project => ({
  id, title, status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: at('09-01'), updatedAt: at('09-01'), ...extra,
});

const areas: Area[] = [
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: at('09-01'), updatedAt: at('09-01') },
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: at('09-01'), updatedAt: at('09-01') },
  { id: 'a-plain', name: 'Plain', order: 2, createdAt: at('09-01'), updatedAt: at('09-01') },
];

const projects: Project[] = [
  project('p-launch', 'Launch', { areaId: 'a-work' }),
  project('p-garden', 'Garden', { areaId: 'a-home' }),
  project('p-plain', 'Plain project', { areaId: 'a-plain' }),
  project('p-loose', 'Loose project'),
  project('p-parked', 'Parked plan', { areaId: 'a-home', status: 'someday' }),
  project('p-gone', 'Gone project', { deletedAt: at('09-10'), updatedAt: at('09-10') }),
];

const tasks: Task[] = [
  task('i-idea', 'Inbox idea', 'inbox', '09-22', { contexts: ['@home'] }),
  task('i-plumber', 'Call plumber', 'inbox', '09-23', { areaId: 'a-home', tags: ['#house'], dueDate: '2026-09-24' }),
  task('n-draft', 'Draft launch post', 'next', '09-20', { projectId: 'p-launch', contexts: ['@computer'], timeEstimate: '30min', boardOrder: 2048 }),
  task('n-demo', 'Record demo', 'next', '09-21', { projectId: 'p-launch', contexts: ['@computer'], timeEstimate: '1hr', boardOrder: 1024 }),
  task('n-rent', 'Pay rent', 'next', '09-15', { contexts: ['@computer', '@home'], dueDate: '2026-09-20', timeEstimate: '4hr+' }),
  task('n-bulbs', 'Buy bulbs', 'next', '09-16', { projectId: 'p-garden', tags: ['#garden'], timeEstimate: 'custom:45', dueDate: '2026-09-24' }),
  task('n-tags', 'Many tags', 'next', '09-17', {
    projectId: 'p-plain', tags: ['#a', '#b', '#c', '#d', '#e', '#f', '#g'], contexts: ['@c1', '@c2', '@c3', '@c4', '@c5', '@c6', '@c7'],
  }),
  task('n-loose', 'Loose step', 'next', '09-18', { projectId: 'p-loose', dueDate: '2026-10-15' }),
  task('n-locked', 'Locked copy', 'next', '09-19'),
  task('n-parked', 'Parked step', 'next', '09-19', { projectId: 'p-parked' }),
  task('n-gone', 'Orphan of gone', 'next', '09-19', { projectId: 'p-gone' }),
  task('w-vendor', 'Hear back from vendor', 'waiting', '09-10', { projectId: 'p-launch', boardOrder: 0 }),
  task('w-alice', 'Invoice from Alice', 'waiting', '09-12', { dueDate: '2026-09-26', tags: ['#money'] }),
  task('d-shipped', 'Shipped v1', 'done', '09-05', { projectId: 'p-launch', completedAt: at('09-21') }),
  task('d-old', 'Old win', 'done', '09-01', { completedAt: at('09-02') }),
  task('r-manual', 'Manual', 'reference', '09-01'),
  task('x-archived', 'Archived thing', 'archived', '09-01', { completedAt: at('09-03') }),
  task('t-trashed', 'Trashed idea', 'next', '09-01', { deletedAt: at('09-15'), updatedAt: at('09-15') }),
];

const settingsVariants: Record<string, AppSettings> = {
  base: {},
  homeArea: { filters: { areaIds: ['a-home'] } },
  noEstimates: { features: { timeEstimates: false } },
};

type Scenario = { name: string; settings: string; taskIds?: string[]; actions: [string, ...unknown[]][] };

export const scenarios: Scenario[] = [
  { name: 'columns: every status', settings: 'base', actions: [] },
  { name: 'columns: the Home area filter', settings: 'homeArea', actions: [] },
  { name: 'columns: time estimates off', settings: 'noEstimates', actions: [] },
  { name: 'columns: all empty', settings: 'base', taskIds: ['r-manual', 'x-archived', 't-trashed'], actions: [] },
  { name: 'filters: title search', settings: 'base', actions: [['search', 'LAUNCH '], ['search', 'zzz'], ['clearSearch']] },
  {
    name: 'filters: contexts and tags, any then all',
    settings: 'base',
    actions: [
      ['openFilters'], ['toggleToken', '@computer'], ['toggleToken', '@home'], ['matchMode', 'context', 'all'],
      ['toggleToken', '#garden'], ['toggleToken', '@computer'], ['chip', 'excluded-token:@computer'], ['closeFilters'],
    ],
  },
  {
    name: 'filters: projects and no project',
    settings: 'base',
    actions: [
      ['openFilters'], ['toggleProject', SAVED_FILTER_NO_PROJECT_ID], ['toggleProject', 'p-garden'],
      ['chip', `project:${SAVED_FILTER_NO_PROJECT_ID}`], ['closeFilters'],
    ],
  },
  {
    name: 'filters: due presets',
    settings: 'base',
    actions: [
      ['openFilters'], ['dueToggle'], ['duePreset', 'today'], ['dueToggle'], ['duePreset', 'overdue'], ['dueToggle'], ['duePreset', 'overdue'],
      ['dueToggle'], ['duePreset', 'this_week'], ['additionalChip', 'board-due-date'], ['dueToggle'], ['duePreset', 'this_month'],
      ['dueToggle'], ['duePreset', 'no_date'], ['dueToggle'], ['dueToggle'], ['closeFilters'],
    ],
  },
  {
    name: 'filters: Clear resets search, criteria and due date',
    settings: 'base',
    actions: [
      ['search', 'o'], ['openFilters'], ['toggleToken', '@computer'], ['dueToggle'], ['duePreset', 'overdue'],
      ['additionalChip', 'board-search'], ['closeFilters'], ['search', 'rent'], ['clearAll'],
    ],
  },
  { name: 'filters: nothing matches', settings: 'base', actions: [['search', 'no such card']] },
  { name: 'drag: into another column', settings: 'base', actions: [['drag', 'n-rent', 'waiting'], ['drag', 'i-idea', 'done']] },
  { name: 'drag: onto an empty column', settings: 'base', actions: [['drag', 'w-alice', 'someday'], ['drag', 'i-plumber', 'someday']] },
  {
    name: 'drag: reorder within a column',
    settings: 'base',
    actions: [
      ['drag', 'n-loose', 'next', null], ['drag', 'n-loose', 'next', 'n-rent'], ['drag', 'n-demo', 'next', 'n-gone'],
      ['drag', 'n-bulbs', 'next', 'n-rent'], ['drag', 'w-vendor', 'waiting', null],
    ],
  },
  { name: 'drag: reorder under a search', settings: 'base', actions: [['search', 'o'], ['drag', 'n-gone', 'next', null], ['clearSearch']] },

  { name: 'drag: to the end, past a card the Board hides', settings: 'base', actions: [['drag', 'i-plumber', 'next', 'n-gone']] },
  { name: 'cards: tap opens the editor', settings: 'base', actions: [['tap', 'n-draft'], ['closeEditor'], ['tap', 'w-alice']] },
  { name: 'cards: swipe to delete', settings: 'base', actions: [['swipe', 'n-bulbs', 'right']] },
  { name: 'cards: swipe to duplicate', settings: 'base', actions: [['swipe', 'n-demo', 'left']] },
  { name: 'cards: a refused duplicate', settings: 'base', actions: [['swipe', 'n-locked', 'left']] },
];


const writeLog: unknown[][] = [];
const createdIds = new Map<string, string>();
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match) => createdIds.get(match) ?? match));

const RECORDED = ['updateTask', 'deleteTask', 'duplicateTask', 'reorderBoardTasks'] as const;

const REFUSED_COPY = 'n-locked';
let realActions: Record<string, (...args: any[]) => Promise<any>> | null = null;

async function seedStore(settings: AppSettings, seededTasks: Task[]) {
  await flushPendingSave();
  resetForTests();
  const initial = useTaskStore.getState() as unknown as Record<string, (...args: any[]) => Promise<any>>;
  realActions ??= Object.fromEntries(RECORDED.map((name) => [name, initial[name]]));
  const real = realActions;
  const data = JSON.parse(JSON.stringify({ tasks: seededTasks, projects, sections: [], areas, people: [], settings }));
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
    if (name === 'duplicateTask' && args[0] === REFUSED_COPY) return { success: false, error: 'Copy refused' };
    const result = await real[name](...args);
    if (name === 'duplicateTask' && result?.id) createdIds.set(result.id, `<copy:${String(args[0])}>`);
    return result;
  }])) as never);
}


const deepText = (node: ReactTestInstance | string | number | null | undefined | boolean): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map((child) => deepText(child as ReactTestInstance | string)).join('');
};


function visibleNodes(root: ReactTestInstance): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Modal' && !node.props.visible) return;
    out.push(node);
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}


function textsIn(root: ReactTestInstance): string[] {
  const out: string[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Modal' && !node.props.visible) return;
    if (String(node.type) === 'Text') {
      out.push(deepText(node));
      return;
    }
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

const hostsOf = (root: ReactTestInstance, type: string) => visibleNodes(root).filter((node) => String(node.type) === type);
const componentsOf = (root: ReactTestInstance, name: string) => root.findAll((node) => (
  typeof node.type === 'function' && (node.type as { name?: string }).name === name
));
const flattenStyle = (style: unknown): Record<string, unknown> => (
  Array.isArray(style) ? Object.assign({}, ...style.map(flattenStyle)) : style && typeof style === 'object' ? style as Record<string, unknown> : {}
);
const columnRoots = (root: ReactTestInstance) => hostsOf(root, 'View').filter((node) => (
  typeof node.props.onLayout === 'function' && flattenStyle(node.props.style).borderTopWidth === 4
));
const cardOf = (root: ReactTestInstance, id: string) => componentsOf(root, 'DraggableTask').find((node) => node.props.task.id === id);
const pressableWithText = (root: ReactTestInstance, text: string) => hostsOf(root, 'Pressable').find((node) => (
  node.props.accessibilityLabel === undefined && textsIn(node).join('') === text
));

function observe(root: ReactTestInstance, seen: { writes: number; toasts: number; navigations: number }) {
  const state = useTaskStore.getState();
  const controls = hostsOf(root, 'View').find((node) => node.props.testID === 'board-filter-controls')!;
  const search = hostsOf(controls, 'TextInput')[0];
  const toggle = hostsOf(controls, 'Pressable').find((node) => node.props.accessibilityState && 'expanded' in node.props.accessibilityState)!;
  const toggleStyle = flattenStyle(toggle.props.style);
  const sheet = hostsOf(root, 'TaskFilterSheet')[0]?.props;
  const editor = hostsOf(root, 'TaskEditModal')[0]?.props;
  const observation = {
    texts: textsIn(root),
    bar: {
      search: search.props.value,
      searchBorder: flattenStyle(search.props.style).borderColor,
      clearSearch: hostsOf(controls, 'Pressable').some((node) => node.props.accessibilityLabel === harness.strings['filters.clear']),
      toggle: [toggleStyle.backgroundColor, toggleStyle.borderColor, toggle.props.accessibilityState.expanded],
    },
    columns: columnRoots(root).map((column) => {
      const style = flattenStyle(column.props.style);
      const badge = hostsOf(column, 'View').find((node) => flattenStyle(node.props.style).borderRadius === 10 && flattenStyle(node.props.style).paddingVertical === 2);
      return {
        color: style.borderTopColor,
        badge: flattenStyle(badge?.props.style).borderColor ?? null,
        cards: componentsOf(column, 'DraggableTask').map((card) => {
          const stored = state._tasksById.get(card.props.task.id);
          let projectBadge = hostsOf(card, 'Icon:Folder')[0]?.parent ?? null;
          while (projectBadge && String(projectBadge.type) !== 'View') projectBadge = projectBadge.parent;
          return [card.props.task.id, stored?.status ?? null, stored?.boardOrder ?? null, projectBadge ? flattenStyle(projectBadge.props.style).borderColor : null];
        }),
      };
    }),
    sheet: sheet?.visible ? {
      tokens: sheet.options.tokens,
      projects: sheet.options.projects,
      visibility: sheet.options.visibility,
      chips: sheet.selections.chips.map((chip: { id: string; label: string; excluded?: boolean }) => [chip.id, chip.label, chip.excluded === true]),
      contextMatchMode: sheet.selections.contextMatchMode,
      tagMatchMode: sheet.selections.tagMatchMode,
      additional: sheet.hasAdditionalActiveFilters ? sheet.additionalActiveChips.map((chip: { id: string; label: string }) => [chip.id, chip.label]) : [],
      due: hostsOf(root, 'Pressable').filter((node) => node.props.accessibilityState && 'expanded' in node.props.accessibilityState && node !== toggle)
        .map((node) => [node.props.accessibilityLabel, node.props.accessibilityState.expanded]),
      presets: componentsOf(root, 'FilterChip').map((chip) => [chip.props.label, chip.props.selected === true]),
    } : null,
    editor: editor?.visible ? [editor.task?.id ?? null, editor.defaultTab] : null,
    writes: writeLog.slice(seen.writes),
    toasts: harness.toasts.slice(seen.toasts).map((toast) => [toast.tone ?? null, toast.title ?? null, toast.message ?? null]),
    navigations: harness.navigations.slice(seen.navigations),
  };
  seen.writes = writeLog.length;
  seen.toasts = harness.toasts.length;
  seen.navigations = harness.navigations.length;
  return normalize(observation);
}


const HEADER = 45;
const CARD_TOP = 10;
const CARD_STEP = 68;
const CARD_HEIGHT = 60;
type Layout = { columns: { y: number; height: number; ids: string[] }[] };

function measure(root: ReactTestInstance): Layout {
  const layout: Layout = { columns: [] };
  let y = 16;
  for (const column of columnRoots(root)) {
    const ids = componentsOf(column, 'DraggableTask').map((card) => card.props.task.id as string);
    const height = Math.max(100, HEADER + CARD_TOP + ids.length * CARD_STEP + 10);
    column.props.onLayout({ nativeEvent: { layout: { x: 0, y, width: 360, height } } });
    const content = hostsOf(column, 'View').find((node) => node !== column && typeof node.props.onLayout === 'function')!;
    content.props.onLayout({ nativeEvent: { layout: { x: 0, y: HEADER, width: 360, height: height - HEADER } } });
    hostsOf(column, 'AnimatedView').forEach((card, index) => {
      card.props.onLayout({ nativeEvent: { layout: { x: 0, y: CARD_TOP + index * CARD_STEP, width: 340, height: CARD_HEIGHT } } });
    });
    layout.columns.push({ y, height, ids });
    y += height + 16;
  }
  return layout;
}

const COLUMN_ORDER = ['inbox', 'next', 'waiting', 'someday', 'done'];


function dragDistance(layout: Layout, id: string, status: string, afterId: string | null | undefined): number {
  const from = layout.columns.findIndex((column) => column.ids.includes(id));
  const top = (columnIndex: number, cardId: string) => (
    layout.columns[columnIndex].y + HEADER + CARD_TOP + layout.columns[columnIndex].ids.indexOf(cardId) * CARD_STEP
  );
  const startCenter = top(from, id) + CARD_HEIGHT / 2;
  const to = COLUMN_ORDER.indexOf(status);
  if (to !== from) return (layout.columns[to].y + layout.columns[to].height / 2) - startCenter;
  const others = layout.columns[from].ids.filter((entry) => entry !== id);
  const center = afterId === null
    ? top(from, others[0]) + 10
    : top(from, afterId as string) + CARD_HEIGHT / 2 + 1;
  return center - startCenter;
}

async function perform(renderer: ReactTestRenderer, action: [string, ...unknown[]]) {
  const root = renderer.root;
  const [kind, target, ...rest] = action;
  const run = async (what: string, fn: (() => unknown) | undefined) => {
    if (!fn) throw new Error(`Nothing to do for ${what}`);
    await act(async () => { await fn(); });
  };
  const controls = () => hostsOf(root, 'View').find((node) => node.props.testID === 'board-filter-controls')!;
  const sheet = () => hostsOf(root, 'TaskFilterSheet')[0]?.props;
  switch (kind) {
    case 'search':
      return run('search', () => hostsOf(controls(), 'TextInput')[0].props.onChangeText(target));
    case 'clearSearch':
      return run('clear search', hostsOf(controls(), 'Pressable').find((node) => node.props.accessibilityLabel === harness.strings['filters.clear'])?.props.onPress);
    case 'clearAll':
      return run('clear all', pressableWithText(controls(), harness.strings['filters.clear'])?.props.onPress);
    case 'openFilters':
      return run('open filters', hostsOf(controls(), 'Pressable').find((node) => node.props.accessibilityState && 'expanded' in node.props.accessibilityState)?.props.onPress);
    case 'closeFilters':
      return run('close filters', sheet()?.onClose);
    case 'toggleToken':
      return run('toggle token', () => sheet()?.selections.toggleToken(target));
    case 'toggleProject':
      return run('toggle project', () => sheet()?.selections.toggleProject(target));
    case 'matchMode':
      return run('match mode', () => sheet()?.selections.setMatchMode(target, rest[0]));
    case 'chip':
      return run('chip', sheet()?.selections.chips.find((chip: { id: string }) => chip.id === target)?.onPress);
    case 'additionalChip':
      return run('additional chip', sheet()?.additionalActiveChips.find((chip: { id: string }) => chip.id === target)?.onPress);
    case 'dueToggle':
      return run('due toggle', hostsOf(root, 'Pressable').find((node) => (
        node.props.accessibilityState && 'expanded' in node.props.accessibilityState
        && String(node.props.accessibilityLabel).startsWith(`${harness.strings['search.due.label']}:`)
      ))?.props.onPress);
    case 'duePreset':
      return run('due preset', componentsOf(root, 'FilterChip').find((chip) => chip.props.label === harness.strings[`filters.datePreset.${String(target)}`])?.props.onPress);
    case 'drag': {
      const layout = measure(root);
      const translationY = dragDistance(layout, target as string, rest[0] as string, rest[1] as string | null | undefined);
      const [pan] = hostsOf(cardOf(root, target as string)!, 'GestureDetector')[0].props.gesture;
      await run('drag start', () => pan.handlers.onStart());
      const [freshPan] = hostsOf(cardOf(root, target as string)!, 'GestureDetector')[0].props.gesture;
      return run('drop', () => freshPan.handlers.onEnd({ translationY, absoluteY: 400 }));
    }
    case 'tap': {
      const [, tap] = hostsOf(cardOf(root, target as string)!, 'GestureDetector')[0].props.gesture;
      return run('tap', () => tap.handlers.onEnd());
    }
    case 'swipe': {

      const swipeable = hostsOf(cardOf(root, target as string)!, 'Swipeable')[0].props;
      return run('swipe', () => {
        if (rest[0] === 'left') swipeable.onSwipeableLeftOpen?.();
        else swipeable.onSwipeableRightOpen?.();
        swipeable.onSwipeableOpen?.(rest[0], { close: vi.fn() });
      });
    }
    case 'closeEditor':
      return run('close editor', hostsOf(root, 'TaskEditModal')[0]?.props.onClose);
    default:
      throw new Error(`Unknown action ${String(kind)}`);
  }
}

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  harness.toasts.length = 0;
  harness.navigations.length = 0;
  const seeded = scenario.taskIds ? tasks.filter((entry) => scenario.taskIds!.includes(entry.id)) : tasks;
  await seedStore(settingsVariants[scenario.settings], seeded);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<BoardView />); });
  const seen = { writes: 0, toasts: 0, navigations: 0 };
  const observations = [observe(renderer.root, seen)];
  for (const action of scenario.actions) {
    await perform(renderer, action);
    await act(async () => { await flushPendingSave(); });
    observations.push(observe(renderer.root, seen));
  }
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}

const inputs = () => normalize({ timeZone: TIME_ZONE, now: NOW, tasks, projects, areas, settings: settingsVariants, scenarios }) as Record<string, unknown>;

describe('React Native Board screen parity fixture', () => {
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
    if (CAPTURE) {
      let previous: Record<string, unknown> = {};
      try { previous = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')); } catch { previous = {}; }
      const oldBoard = previous.board as { observations: Record<string, unknown> };
      const recapturedCases = scenarios.map((scenario) => scenario.name)
        .filter((name) => JSON.stringify(captured[name]) !== JSON.stringify(oldBoard.observations[name]));
      const observations = { ...oldBoard.observations };
      for (const name of recapturedCases) observations[name] = captured[name];
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({
        ...previous,
        board: { ...inputs(), observations },
      }, null, 1)}\n`);
      expect(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).provenance).toEqual(previous.provenance);
    }
    const { observations, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).board;
    expect(frozenInputs).toEqual(inputs());
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);
});
