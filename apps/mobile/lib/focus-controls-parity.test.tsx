


import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { Alert, SectionList, TextInput } from 'react-native';
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
  type SavedFilter,
  type Task,
} from '@mindwtr/core';

import FocusScreen from '../app/(drawer)/(tabs)/focus';
import { FilterChip, TaskFilterSheet } from '@/components/task-filter-sheet';
import { getFocusWidgetFilter, resetFocusWidgetFilter } from '@/lib/focus-widget-filter';

const FIXTURE_PATH = new URL('../../../packages/core/src/focus-controls-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_FOCUS_CONTROLS === '1';

const english = vi.hoisted(() => ({ strings: {} as Record<string, string> }));
const TINT = '#3b82f6';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn().mockResolvedValue(null), setItem: vi.fn().mockResolvedValue(undefined), removeItem: vi.fn() },
}));
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn().mockResolvedValue(undefined),
  selectionAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({}) }));
vi.mock('@/lib/hardware-back', () => ({ addHardwareBackPressListener: () => ({ remove: () => {} }) }));
vi.mock('@/lib/widget-service', () => ({ updateMobileWidgetFromStore: vi.fn() }));
vi.mock('@/lib/sync-service', () => ({
  getMobileSyncActivityState: vi.fn(() => ({ syncing: false })),
  getMobileSyncConfigurationStatus: vi.fn().mockResolvedValue({ backend: 'off', configured: false }),
  performMobileSync: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../contexts/language-context', () => {
  const t = (key: string) => english.strings[key] ?? key;
  return { useLanguage: () => ({ t, language: 'en' }) };
});
vi.mock('../contexts/theme-context', () => ({ useTheme: () => ({ isDark: false, themePreset: 'default' }) }));
vi.mock('../contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => true }));
vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));
vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', icon: '#64748b', tint: '#3b82f6', onTint: '#fff',
    tabIconDefault: '#94a3b8', tabIconSelected: '#3b82f6', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@react-native-community/datetimepicker', () => ({
  default: (props: any) => React.createElement('DateTimePicker', props),
}));
vi.mock('@/components/swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));
vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));
vi.mock('@/components/pomodoro-panel', () => ({
  PomodoroPanel: (props: any) => React.createElement('PomodoroPanel', props),
}));
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('react-native-draggable-flatlist', async () => {
  const ReactModule = await import('react');
  return {
    __esModule: true,
    ScaleDecorator: ({ children, ...props }: any) => ReactModule.createElement('ScaleDecorator', props, children),
    default: (props: any) => ReactModule.createElement(
      'DraggableFlatList',
      props,
      (props.data ?? []).map((item: any, index: number) => ReactModule.createElement(
        ReactModule.Fragment,
        { key: props.keyExtractor(item) },
        props.renderItem({ item, drag: () => {}, isActive: false, getIndex: () => index }),
      )),
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
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: at('01'), updatedAt: at('01') },
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: at('01'), updatedAt: at('01') },
];
const projects: Project[] = [
  { id: 'p-launch', title: 'Launch', status: 'active', color: '#2563eb', order: 0, tagIds: [], areaId: 'a-work', createdAt: at('01'), updatedAt: at('01') },
  { id: 'p-garden', title: 'Garden', status: 'active', color: '#16a34a', order: 1, tagIds: [], areaId: 'a-home', createdAt: at('01'), updatedAt: at('01') },
  { id: 'p-alpha', title: 'Alpha', status: 'active', color: '#94a3b8', order: 1, tagIds: [], createdAt: at('01'), updatedAt: at('01') },
  { id: 'p-idle', title: 'Idle', status: 'active', color: '#94a3b8', order: 2, tagIds: [], createdAt: at('01'), updatedAt: at('01') },
  { id: 'p-parked', title: 'Parked', status: 'someday', color: '#94a3b8', order: 3, tagIds: [], createdAt: at('01'), updatedAt: at('01') },
];
const allTasks: Task[] = [
  task('f1', 'Draft plan', '10', {
    isFocusedToday: true, focusOrder: 1, contexts: ['@office'], projectId: 'p-launch', priority: 'high', timeEstimate: '30min',
    dueDate: '2026-09-28T16:30',
  }),
  task('f2', 'Email Sam', '11', { isFocusedToday: true, focusOrder: 0, contexts: ['@phone'], tags: ['#work'], energyLevel: 'low', dueDate: '2026-09-29' }),
  task('f3', 'Water plants', '12', { isFocusedToday: true, focusOrder: 2, projectId: 'p-garden', location: 'Home', priority: 'low' }),
  task('n1', 'Buy seeds', '13', {
    projectId: 'p-garden', contexts: ['@errand'], tags: ['#garden'], energyLevel: 'high', priority: 'medium', timeEstimate: '15min',
  }),
  task('n2', 'Call bank', '14', { contexts: ['@phone', '@office'], priority: 'urgent', dueDate: '2026-09-25', assignedTo: 'Ana' }),
  task('n3', 'Read book', '05', { tags: ['#home'], location: 'Office' }),
  task('n4', 'Alpha task', '15', { projectId: 'p-alpha', timeEstimate: '1hr', assignedTo: 'ben' }),
  task('n5', 'Plan sprint', '16', { projectId: 'p-launch', contexts: ['@office'], energyLevel: 'medium', priority: 'high' }),
  task('s1', 'Pay rent', '17', { dueDate: '2026-09-23', contexts: ['@home'] }),
  task('s2', 'Standup', '18', { startTime: '2026-09-23T15:00', projectId: 'p-launch' }),
  task('r1', 'Check insurance', '19', { reviewAt: '2026-09-20', tags: ['#admin'] }),
  task('u1', 'Plan trip', '20', { startTime: '2026-09-26', contexts: ['@home'] }),
  task('w1', 'Hear back from Kim', '06', { status: 'waiting', contexts: ['@phone'] }),
  task('d1', 'Old chore', '04', { status: 'done', completedAt: at('04'), contexts: ['@done'] }),
  task('pk1', 'Parked step', '07', { projectId: 'p-parked', contexts: ['@parked'] }),
  task('fut', 'Far future', '08', { startTime: '2026-11-20', contexts: ['@later'] }),
];

const savedFilters: SavedFilter[] = [
  {
    id: 'sf-phone', name: 'Phone calls', icon: '📞', view: 'focus', criteria: { contexts: ['@phone'] },
    sortBy: 'due', groupBy: 'context', createdAt: at('01'), updatedAt: at('01'),
  },
  {
    id: 'sf-work', name: 'Work area', view: 'focus',
    criteria: { areas: ['a-work'], priority: ['urgent', 'high'], startDateRange: { from: '2026-09-01', to: '2026-09-30' } },
    sortBy: 'priority', sortOrder: 'desc', createdAt: at('02'), updatedAt: at('02'),
  },

  { id: 'sf-list', name: 'List only', view: 'list' as SavedFilter['view'], criteria: { tags: ['#work'] }, createdAt: at('03'), updatedAt: at('03') },
  {
    id: 'sf-gone', name: 'Gone', view: 'focus', criteria: { tags: ['#home'] }, createdAt: at('03'), updatedAt: at('05'), deletedAt: at('05'),
  },
  {
    id: 'sf-loc', name: 'At the office', view: 'focus', criteria: { locations: ['Office'], hasDescription: false },
    createdAt: at('04'), updatedAt: at('04'),
  },
];

const settingsVariants: Record<string, AppSettings> = {
  base: { features: {}, gtd: {}, savedFilters },
  prioritiesOff: { features: { priorities: false }, gtd: { focusGroupBy: 'priority' }, savedFilters },
  groupProject: { features: {}, gtd: { focusGroupBy: 'project' }, savedFilters: [] },
  timeEstimatesOff: { features: { timeEstimates: false }, gtd: {}, savedFilters: [] },
};

export type FocusControlsAction =
  | ['filter', string, ...unknown[]]
  | ['chip', string]
  | ['advancedChip', string]
  | ['headerClear']
  | ['sort', string]
  | ['group', string]
  | ['saved', string]
  | ['all']
  | ['deleteSaved', string]
  | ['openSave']
  | ['saveName', string]
  | ['saveConfirm']
  | ['reorderEnter']
  | ['reorderMove', string, -1 | 1]
  | ['reorderDrag', string[]]
  | ['reorderDone'];
type Scenario = { name: string; settings: string; taskIds?: string[]; actions: FocusControlsAction[] };

const scenarios: Scenario[] = [
  { name: 'default view', settings: 'base', actions: [] },
  {
    name: 'each filter kind and its chips',
    settings: 'base',
    actions: [
      ['filter', 'toggleToken', '@phone'],
      ['filter', 'toggleToken', '@office'],
      ['filter', 'setMatchMode', 'context', 'any'],
      ['filter', 'toggleToken', '#work'],
      ['filter', 'toggleToken', '#home'],
      ['filter', 'setMatchMode', 'tag', 'any'],
      ['filter', 'toggleToken', '@phone'],
      ['filter', 'toggleProject', '__no_project__'],
      ['filter', 'toggleProject', 'p-garden'],
      ['filter', 'togglePriority', 'high'],
      ['filter', 'toggleEnergyLevel', 'low'],
      ['filter', 'toggleTimeEstimate', '30min'],
      ['filter', 'setLocation', ' Office '],
      ['chip', 'priority:high'],
      ['chip', 'excluded-token:@phone'],
      ['chip', 'location'],
      ['chip', 'project:__no_project__'],
      ['headerClear'],
    ],
  },
  {
    name: 'a filter that matches nothing',
    settings: 'base',
    actions: [['filter', 'toggleToken', '#garden'], ['filter', 'togglePriority', 'urgent']],
  },
  {
    name: 'every sort and group',
    settings: 'base',
    actions: [
      ['sort', 'due'], ['sort', 'start'], ['sort', 'priority'], ['sort', 'created'], ['sort', 'created-desc'], ['sort', 'default'],
      ['group', 'context'], ['group', 'project'], ['group', 'area'], ['group', 'energy'], ['group', 'priority'],
      ['group', 'person'], ['group', 'tag'], ['group', 'none'],
    ],
  },
  { name: 'a stored project grouping', settings: 'groupProject', actions: [['sort', 'due'], ['sort', 'due']] },
  {
    name: 'priority rules with priorities off',
    settings: 'prioritiesOff',
    actions: [['saved', 'sf-work'], ['sort', 'due'], ['group', 'context'], ['saved', 'sf-phone'], ['all']],
  },
  { name: 'time estimates off', settings: 'timeEstimatesOff', actions: [['filter', 'toggleToken', '@office']] },
  {
    name: 'apply, toggle, switch and clear saved filters',
    settings: 'base',
    actions: [['saved', 'sf-phone'], ['saved', 'sf-work'], ['saved', 'sf-work'], ['saved', 'sf-loc'], ['all']],
  },
  {
    name: 'a picker change, sort or group unbinds a saved filter',
    settings: 'base',
    actions: [
      ['saved', 'sf-phone'], ['filter', 'toggleToken', '@office'],
      ['saved', 'sf-phone'], ['sort', 'due'],
      ['saved', 'sf-phone'], ['group', 'context'],
    ],
  },
  {
    name: 'save the current filter',
    settings: 'base',
    actions: [
      ['filter', 'toggleToken', '@phone'], ['filter', 'togglePriority', 'urgent'], ['filter', 'toggleToken', '#work'],
      ['filter', 'toggleToken', '#work'], ['sort', 'due'],
      ['openSave'], ['saveName', '  My calls  '], ['saveConfirm'],
      ['all'],
    ],
  },
  {
    name: 'save a sort-only perspective under its default name',
    settings: 'base',
    actions: [['sort', 'created-desc'], ['openSave'], ['saveConfirm']],
  },
  {
    name: 'update a saved filter by removing advanced criteria',
    settings: 'base',
    actions: [['saved', 'sf-work'], ['advancedChip', 'advanced:area:a-work'], ['advancedChip', 'advanced:startDateRange'], ['saved', 'sf-loc'], ['advancedChip', 'advanced:location:Office']],
  },
  {
    name: 'delete saved filters',
    settings: 'base',
    actions: [['saved', 'sf-phone'], ['deleteSaved', 'sf-phone'], ['deleteSaved', 'sf-loc']],
  },
  {
    name: 'reorder allowed, moved and refused',
    settings: 'base',
    actions: [
      ['reorderEnter'], ['reorderMove', 'f1', -1], ['reorderMove', 'f1', 1], ['reorderDrag', ['f3', 'f1', 'f2']], ['reorderDone'],
      ['filter', 'toggleToken', '@office'], ['headerClear'], ['sort', 'start'],
    ],
  },
  { name: 'nothing to do', settings: 'base', taskIds: ['d1', 'w1'], actions: [] },
];


const t = (key: string) => english.strings[key] ?? key;
const tf = (key: string, fallback: string) => {
  const value = t(key);
  return value && value !== key ? value : fallback;
};
const sortLabel = (value: string) => (value === 'priority' ? tf('filters.priority', 'Priority') : tf(`sort.${value}`, value));
const GROUP_LABEL_KEYS: Record<string, [string, string]> = {
  none: ['focus.group.none', 'None'], context: ['focus.group.context', 'Context'], project: ['focus.group.project', 'Project'],
  area: ['focus.group.area', 'Area'], energy: ['focus.group.energy', 'Energy'], priority: ['focus.group.priority', 'Priority'],
  person: ['people.title', 'People'], tag: ['tags.title', 'Tags'],
};
const groupLabel = (value: string) => tf(...GROUP_LABEL_KEYS[value]);
const KNOWN_IDS = new Set(savedFilters.map((filter) => filter.id));
const writeLog: unknown[] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)).replace(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g, (match, id) => (
  KNOWN_IDS.has(id) ? match : '"<new>"'
)));

let realActions: Pick<ReturnType<typeof useTaskStore.getState>, 'updateSettings' | 'reorderFocusedTasks'> | null = null;

async function seedStore(settings: AppSettings, tasks: Task[]) {
  await flushPendingSave();
  resetForTests();
  const initial = useTaskStore.getState();
  realActions ??= { updateSettings: initial.updateSettings, reorderFocusedTasks: initial.reorderFocusedTasks };
  const real = realActions;
  const data = JSON.parse(JSON.stringify({ tasks, projects, sections: [], areas, people: [], settings }));
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  useTaskStore.setState({
    ...real,
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
  });
  await useTaskStore.getState().fetchData({ throwOnError: true });
  if (useTaskStore.getState()._allTasks.length !== tasks.length) throw new Error('Store seed did not load');
  useTaskStore.setState({
    updateSettings: async (updates) => {
      writeLog.push(['updateSettings', normalize(updates)]);
      return real.updateSettings(updates);
    },
    reorderFocusedTasks: async (ids) => {
      writeLog.push(['reorderFocusedTasks', [...ids]]);
      return real.reorderFocusedTasks(ids);
    },
  });
}

const flush = async () => {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
};

const textOf = (node: ReactTestInstance | string | null | undefined): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  return node.children.map((child) => textOf(child as ReactTestInstance | string)).join('');
};
const elementText = (node: unknown): string => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elementText).join('');
  return elementText((node as { props?: { children?: unknown } }).props?.children);
};
const hosts = (root: ReactTestInstance, predicate: (node: ReactTestInstance) => boolean) => root.findAll((node) => (
  typeof node.type === 'string' && predicate(node)
));

type Harness = { renderer: ReactTestRenderer; alerts: { buttons: { text?: string; style?: string; onPress?: () => void }[] }[] };

const sheetProps = (h: Harness) => h.renderer.root.findByType(TaskFilterSheet).props;
const sectionList = (h: Harness) => h.renderer.root.findAllByType(SectionList)[0] ?? null;
const viewOptionRows = (h: Harness): ReactTestInstance[][] => {
  const content = h.renderer.root.find((node) => node.props.testID === 'focus-view-options-content' && typeof node.type === 'string');
  const rows: ReactTestInstance[][] = [];
  const parents: ReactTestInstance[] = [];
  content.findAllByType(FilterChip).forEach((chip) => {
    const index = parents.indexOf(chip.parent!);
    if (index >= 0) rows[index].push(chip);
    else {
      parents.push(chip.parent!);
      rows.push([chip]);
    }
  });
  return rows;
};
const headerScrolls = (h: Harness) => {
  const list = sectionList(h);
  if (!list) return { saved: null, active: null };
  const scrolls = hosts(list, (node) => String(node.type) === 'ScrollView' && node.props.horizontal === true);
  const active = scrolls.find((scroll) => scroll.findAllByType(FilterChip).length > 0) ?? null;
  const saved = scrolls.find((scroll) => scroll !== active) ?? null;
  return { saved, active };
};

const encodeItem = (item: any): string => {
  if (item.type === 'task') return `${item.task.id}${item.grouped ? '~' : ''}`;
  if (item.type === 'project') return `@${item.project.id}`;
  return `#${item.id}|${item.title}|${item.count}|${item.muted ? 1 : 0}|${item.dotColor ?? ''}`;
};

function observe(h: Harness) {
  const root = h.renderer.root;
  const list = sectionList(h);
  const sheet = sheetProps(h);
  const selections = sheet.selections;
  let sections: unknown = null;
  let empty: unknown = null;
  let header: unknown = null;
  if (list) {
    const listSections = list.props.sections as any[];
    sections = listSections.map((section) => ({
      type: section.type, title: section.title, total: section.totalCount, items: section.data.map(encodeItem),
    }));
    if (listSections.length === 0) {
      const emptyNode = list.props.ListEmptyComponent;
      empty = emptyNode ? { title: emptyNode.props.children[0].props.children, subtitle: emptyNode.props.children[1].props.children } : null;
    }
    const button = (label: string) => hosts(list, (node) => node.props.accessibilityLabel === label)[0];
    const iconColor = (node: ReactTestInstance) => node.findAll((inner) => typeof inner.props.color === 'string')[0]?.props.color;
    const filterButton = button(tf('filters.label', 'Filters'));
    header = {
      viewOptionsTinted: iconColor(button(tf('common.viewOptions', 'View options'))) === TINT,
      filterTinted: iconColor(filterButton) === TINT,
      filterBadge: textOf(filterButton) || null,
    };
  }
  const { saved, active } = headerScrolls(h);
  const savedRow = saved ? (() => {
    const buttons = hosts(saved, (node) => String(node.type) === 'TouchableOpacity');
    const allChip = buttons[0];
    const groups = hosts(saved, (node) => String(node.type) === 'View' && Boolean(node.props.style) && hosts(node, (inner) => String(inner.type) === 'TouchableOpacity').length === 2);
    return {
      all: { label: textOf(allChip), selected: allChip.props.accessibilityState.selected },
      chips: groups.map((group) => {
        const [chip, remove] = hosts(group, (inner) => String(inner.type) === 'TouchableOpacity');
        return { label: textOf(chip), selected: chip.props.accessibilityState.selected, deleteLabel: remove.props.accessibilityLabel };
      }),
    };
  })() : null;
  const activeRow = active ? {
    chips: active.findAllByType(FilterChip).map((chip) => ({ label: chip.props.label, variant: chip.props.variant ?? null })),
    clear: textOf(hosts(active, (node) => String(node.type) === 'TouchableOpacity' && typeof node.props.onPress === 'function').at(-1)!),
  } : null;
  const rows = viewOptionRows(h);
  const chipView = (chip: ReactTestInstance) => ({ label: chip.props.label, selected: chip.props.selected });
  const reorderRows = hosts(root, (node) => String(node.type) === 'TouchableOpacity' && String(node.props.testID ?? '').startsWith('focus-reorder-row-'));
  const reorderToggle = hosts(root, (node) => node.props.testID === 'focus-reorder-toggle')[0];
  const saveInput = sheet.overlay
    ? hosts(root, (node) => String(node.type) === 'TextInput' && node.props.placeholder === tf('savedFilters.namePlaceholder', 'Filter name'))[0]
    : null;
  const widget = getFocusWidgetFilter();

  const sheetRoot = root.findByType(TaskFilterSheet);
  const overviewRows = hosts(sheetRoot, (node) => String(node.type) === 'TouchableOpacity'
    && hosts(node, (inner) => String(inner.type) === 'Text').length === 2)
    .map((node) => hosts(node, (inner) => String(inner.type) === 'Text').map((inner) => textOf(inner)));
  const sheetClear = hosts(sheetRoot, (node) => String(node.type) === 'TouchableOpacity' && node.props.onPress === selections.clear).length > 0;
  return normalize({
    sections,
    empty,
    header,
    savedRow,
    activeRow,
    sheet: {
      options: sheet.options,
      rows: overviewRows,
      clear: sheetClear,
      save: sheet.headerActions ? elementText(sheet.headerActions) : null,
      advancedChips: sheet.additionalActiveChips.map((chip: any) => ({ id: chip.id, label: chip.label, variant: chip.variant })),
      selections: {
        tokens: selections.tokens,
        excludedTokens: selections.excludedTokens,
        projects: selections.projects,
        priorities: selections.priorities,
        energyLevels: selections.energyLevels,
        timeEstimates: selections.timeEstimates,
        locationQuery: selections.locationQuery,
        contextMatchMode: selections.contextMatchMode,
        tagMatchMode: selections.tagMatchMode,
        activeSavedFilterId: selections.activeSavedFilterId,
        criteria: selections.criteria,
        currentCriteria: selections.currentCriteria,
        activeCount: selections.activeCount,
        hasActive: selections.hasActive,
        hasCurrentCriteria: selections.hasCurrentCriteria,
        canSave: selections.canSave,
        showContextMatchMode: selections.showContextMatchMode,
        showTagMatchMode: selections.showTagMatchMode,
        chips: selections.chips.map((chip: any) => ({ id: chip.id, label: chip.label, excluded: chip.excluded ?? false })),
      },
    },
    view: { sort: rows[0].map(chipView), group: rows[1].map(chipView), details: chipView(rows[2][0]) },
    reorder: {
      toggle: reorderToggle ? textOf(reorderToggle) : null,
      rows: reorderRows.length === 0 ? null : reorderRows.map((row) => ({
        id: String(row.props.testID).slice('focus-reorder-row-'.length),
        texts: hosts(row, (node) => String(node.type) === 'Text').map((node) => textOf(node)),
        label: row.props.accessibilityLabel,
        hint: row.props.accessibilityHint,
        actions: row.props.accessibilityActions.map((action: { name: string; label: string }) => [action.name, action.label]),
      })),
    },
    saveName: saveInput ? saveInput.props.value : null,
    widget: { criteria: widget.criteria, sortBy: widget.sortBy, sortOrder: widget.sortOrder ?? null },
    focusOrder: Object.fromEntries(useTaskStore.getState().tasks
      .filter((entry) => entry.isFocusedToday)
      .map((entry) => [entry.id, entry.focusOrder ?? null])),
    writes: [...writeLog],
  });
}

const pressAlertButton = async (h: Harness, text: string) => {
  const alert = h.alerts.pop();
  const button = alert?.buttons.find((entry) => entry.text === text);
  if (!button?.onPress) throw new Error(`No alert button ${text}`);
  await act(async () => { button.onPress!(); });
  await flush();
};

async function perform(h: Harness, action: FocusControlsAction) {
  const root = h.renderer.root;
  switch (action[0]) {
    case 'filter': {
      const [, method, ...args] = action;
      act(() => { sheetProps(h).selections[method](...args); });
      break;
    }
    case 'chip': {
      const chip = sheetProps(h).selections.chips.find((entry: { id: string }) => entry.id === action[1]);
      act(() => { chip.onPress(); });
      break;
    }
    case 'advancedChip': {
      const chip = sheetProps(h).additionalActiveChips.find((entry: { id: string }) => entry.id === action[1]);
      act(() => { chip.onPress(); });
      await pressAlertButton(h, tf('common.delete', 'Delete'));
      break;
    }
    case 'headerClear': {
      const { active } = headerScrolls(h);
      const clear = hosts(active!, (node) => String(node.type) === 'TouchableOpacity' && textOf(node) === tf('filters.clear', 'Clear'))[0];
      act(() => { clear.props.onPress(); });
      break;
    }
    case 'sort':
    case 'group': {

      const label = action[0] === 'sort' ? sortLabel(action[1]) : groupLabel(action[1]);
      const row = viewOptionRows(h)[action[0] === 'sort' ? 0 : 1];
      const chip = row.find((entry) => entry.props.label === label);
      if (!chip) throw new Error(`No ${action[0]} chip ${action[1]}`);
      await act(async () => { chip.props.onPress(); });
      break;
    }
    case 'saved': {
      const { saved } = headerScrolls(h);
      const filter = savedFilters.find((entry) => entry.id === action[1]) ?? useTaskStore.getState().settings.savedFilters?.find((entry) => entry.id === action[1]);
      const label = `${filter?.icon ? `${filter.icon} ` : ''}${filter?.name}`;
      const chip = hosts(saved!, (node) => String(node.type) === 'TouchableOpacity' && Array.isArray(node.props.accessibilityActions) && textOf(node) === label)[0];
      act(() => { chip.props.onPress(); });
      break;
    }
    case 'all': {
      const { saved } = headerScrolls(h);
      act(() => { hosts(saved!, (node) => String(node.type) === 'TouchableOpacity')[0].props.onPress(); });
      break;
    }
    case 'deleteSaved': {
      const { saved } = headerScrolls(h);
      const filter = savedFilters.find((entry) => entry.id === action[1])!;
      const label = `${tf('common.delete', 'Delete')} ${tf('savedFilters.label', 'saved filter')} ${filter.name}`;
      const remove = hosts(saved!, (node) => String(node.type) === 'TouchableOpacity' && node.props.accessibilityLabel === label && !node.props.accessibilityActions)[0];
      act(() => { remove.props.onPress(); });
      await pressAlertButton(h, tf('common.delete', 'Delete'));
      break;
    }
    case 'openSave':
      act(() => { sheetProps(h).headerActions.props.onPress(); });
      break;
    case 'saveName': {
      const input = root.findAllByType(TextInput).find((node) => node.props.placeholder === tf('savedFilters.namePlaceholder', 'Filter name'))!;
      act(() => { input.props.onChangeText(action[1]); });
      break;
    }
    case 'saveConfirm': {
      const input = root.findAllByType(TextInput).find((node) => node.props.placeholder === tf('savedFilters.namePlaceholder', 'Filter name'))!;
      await act(async () => { input.props.onSubmitEditing(); });
      break;
    }
    case 'reorderEnter':
      act(() => { hosts(root, (node) => node.props.testID === 'focus-reorder-toggle')[0].props.onPress(); });
      break;
    case 'reorderMove': {
      const row = hosts(root, (node) => String(node.type) === 'TouchableOpacity' && node.props.testID === `focus-reorder-row-${action[1]}`)[0];
      await act(async () => { row.props.onAccessibilityAction({ nativeEvent: { actionName: action[2] < 0 ? 'moveUp' : 'moveDown' } }); });
      break;
    }
    case 'reorderDrag': {
      const list = root.find((node) => node.props.testID === 'focus-reorder-list' && typeof node.type === 'string');
      const byId = new Map((list.props.data as Task[]).map((entry) => [entry.id, entry]));
      await act(async () => { list.props.onDragEnd({ data: action[1].map((id) => byId.get(id)), from: 0, to: 0 }); });
      break;
    }
    case 'reorderDone':
      act(() => { hosts(root, (node) => node.props.testID === 'focus-reorder-done')[0].props.onPress(); });
      break;
  }
  await flush();
}

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  resetFocusWidgetFilter();
  const tasks = scenario.taskIds ? allTasks.filter((entry) => scenario.taskIds!.includes(entry.id)) : allTasks;
  await seedStore(settingsVariants[scenario.settings], tasks);
  const harness: Harness = { renderer: null as unknown as ReactTestRenderer, alerts: [] };
  const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    harness.alerts.push({ buttons: (buttons ?? []) as Harness['alerts'][number]['buttons'] });
  });
  await act(async () => { harness.renderer = create(<FocusScreen />); });
  await flush();
  const observations = [observe(harness)];
  for (const action of scenario.actions) {
    try {
      await perform(harness, action);
    } catch (error) {
      throw new Error(`${scenario.name}: ${JSON.stringify(action)} failed\n${String((error as Error)?.stack ?? error)}`);
    }
    observations.push(observe(harness));
  }
  await act(async () => { harness.renderer.unmount(); });
  alertSpy.mockRestore();
  await flushPendingSave();
  return observations;
}

describe('React Native Focus controls parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
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
      timeZone: TIME_ZONE, now: NOW, tasks: allTasks, projects, areas, settings: settingsVariants, scenarios,
    }) as Record<string, unknown>;
    if (CAPTURE) {
      let previous: { provenance?: unknown } = {};
      try {
        previous = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
      } catch {
        previous = {};
      }
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: previous.provenance ?? null, ...inputs, observations: captured }, null, 1)}\n`);
    }
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const { observations, provenance: _provenance, ...frozenInputs } = fixture;
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 180_000);
});
