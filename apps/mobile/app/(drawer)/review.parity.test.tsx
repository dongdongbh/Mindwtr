/**
 * React Native's Review screen, replayed against the `review` part of the review
 * views parity fixture (packages/core/src/review-views-parity.fixtures.json).
 * MINDWTR_CAPTURE_REVIEW_VIEWS=1 rewrites that part.
 *
 * Each scenario renders the real screen with the real core store, expands,
 * swipes, selects and confirms, and records what a user sees and what the store
 * is asked to write. The rows, the task editor and the guided review are stand-ins
 * that record their props: they are other screens' components.
 */
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureDateFormatting, flushPendingSave, loadTranslations, resetForTests, type AppSettings } from '@mindwtr/core';

import {
  CAPTURE,
  DEVICE_LOCALE,
  NOW,
  TIME_ZONE,
  findPressable,
  flattenStyle,
  hostsOf,
  normalize,
  readFixturePart,
  scenarioTasks,
  seedStore,
  sharedInputs,
  textsIn,
  visibleNodes,
  writeFixturePart,
  writeLog,
  type Observation,
  type Scenario,
} from '../../components/review-modal.parity-support';
import ReviewScreen from './review';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  alerts: [] as { title: string; message: string; buttons: { text: string; style?: string; onPress?: () => unknown }[] }[],
  toasts: [] as { tone?: string; title?: string; message?: string; actionLabel?: string; onAction?: () => unknown }[],
  pushes: [] as string[],
  shares: [] as string[],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: (route: string) => { harness.pushes.push(route); } }) }));
vi.mock('@react-navigation/native', () => ({ NavigationContext: React.createContext(undefined), useFocusEffect: (effect: () => unknown) => React.useEffect(effect as () => void, [effect]) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: (toast: (typeof harness.toasts)[number]) => { harness.toasts.push(toast); }, dismissToast: vi.fn() }),
}));
vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => harness.strings[key] ?? key, language: 'en' }),
}));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/hooks/use-filled-button-colors', () => ({ useFilledButtonColors: () => ({ backgroundColor: '#3b82f6', textColor: '#fff' }) }));
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('../../lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('@/components/task-edit-modal', () => ({ TaskEditModal: (props: any) => React.createElement('TaskEditModal', props) }));
vi.mock('@/components/swipeable-task-item', () => ({ SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props) }));
vi.mock('@/components/task-list/TaskListBulkOrganizeModal', () => ({
  TaskListBulkOrganizeModal: (props: any) => React.createElement('TaskListBulkOrganizeModal', props),
}));
vi.mock('@/components/token-picker-modal', () => ({ TokenPickerModal: (props: any) => React.createElement('TokenPickerModal', props) }));
vi.mock('../../components/review-modal', () => ({ ReviewModal: (props: any) => React.createElement('ReviewModal', props) }));
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
    Share: { share: async ({ message }: { message: string }) => { harness.shares.push(message); return { action: 'sharedAction' }; } },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
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

const settingsVariants: Record<string, AppSettings> = {
  base: {},
  homeArea: { filters: { areaIds: ['a-home'] } },
  sortTitle: { taskSortBy: 'title' },
  unassignedColor: { appearance: { unassignedAreaColor: '#ff00aa' } },
};

export const scenarios: Scenario[] = [
  { name: 'overview: collapsed areas', settings: 'base', actions: [] },
  { name: 'overview: expansion cycle', settings: 'base', actions: [['expand'], ['expand'], ['expand']] },
  {
    name: 'overview: one area and one project at a time',
    settings: 'base',
    actions: [['area', 'Home'], ['project', 'Single actions'], ['project', 'Garden'], ['area', 'Work'], ['expand'], ['area', 'Home'], ['expand']],
  },
  { name: 'overview: the Home area filter', settings: 'homeArea', actions: [['expand'], ['expand']] },
  { name: 'overview: title sort', settings: 'sortTitle', actions: [['expand'], ['expand']] },
  { name: 'overview: unassigned area colour', settings: 'unassignedColor', actions: [['expand']] },
  { name: 'overview: empty', settings: 'base', taskIds: ['d-old', 'r-manual', 't-trashed'], actions: [['expand']] },
  {
    name: 'rows: status, delete and edit',
    settings: 'base',
    actions: [['expand'], ['expand'], ['row', 'n-launch', 'status', 'done'], ['row', 'i-thought', 'delete'], ['row', 'n-cv', 'edit']],
  },
  {
    name: 'bulk: move to a status, then cancel a selection',
    settings: 'base',
    actions: [
      ['expand'], ['expand'], ['longPress', 'n-launch'], ['select', 'n-demo'], ['press', 'Move to'], ['press', 'Waiting'],
      ['longPress', 'n-cv'], ['select', 'n-cv'], ['longPress', 'n-bike'], ['press', 'Cancel'],
    ],
  },
  {
    name: 'bulk: add and remove tags',
    settings: 'base',
    actions: [
      ['expand'], ['expand'], ['longPress', 'n-cv'], ['select', 'n-orphan'], ['press', 'Add tag'], ['type', '#urgent'], ['press', 'Save'],
      ['longPress', 'n-cv'], ['select', 'n-orphan'], ['press', 'Remove tag'], ['removeTags', ['#career', '#urgent']],
    ],
  },
  {
    name: 'bulk: delete, confirm and restore',
    settings: 'base',
    actions: [
      ['expand'], ['expand'], ['longPress', 'i-thought'], ['select', 'n-bike'], ['press', 'Delete'], ['alert', 'Cancel'],
      ['press', 'Delete'], ['alert', 'Delete'], ['toastAction'],
    ],
  },
  {
    name: 'bulk: organize and share',
    settings: 'base',
    actions: [
      ['expand'], ['expand'], ['longPress', 'n-cv'], ['select', 'n-bike'], ['press', 'Bulk organize'],
      ['organize', { areaId: 'a-home', tags: ['#errand'] }], ['longPress', 'n-rent'], ['select', 'n-pack'], ['press', 'Share'],
    ],
  },
  {
    name: 'start a review',
    settings: 'base',
    actions: [['press', 'Start Review'], ['press', 'Cancel'], ['press', 'Start Review'], ['press', 'Daily Review'], ['press', 'Start Review'], ['press', 'Weekly Review']],
  },
];

const roundColor = (node: ReactTestInstance) => {
  const style = flattenStyle(node.props.style);
  return typeof style.width === 'number' && style.width <= 8 && style.height === style.width ? style.backgroundColor ?? null : undefined;
};

function observe(root: ReactTestInstance, seen: { alerts: number; toasts: number; writes: number; pushes: number; shares: number }): Observation {
  const allTexts = textsIn(root);
  const scopeTexts = [
    harness.strings['review.scopeDue'], harness.strings['review.scopeAll'],
    harness.strings['review.overviewHelp'], harness.strings['nav.done'],
  ];
  expect(allTexts.slice(0, scopeTexts.length)).toEqual(scopeTexts);
  const headers = hostsOf(root, 'Pressable')
    .filter((node) => node.props.accessibilityState && 'expanded' in node.props.accessibilityState)
    .map((node) => [
      node.props.accessibilityLabel,
      node.props.accessibilityState.expanded,
      visibleNodes(node).filter((child) => String(child.type) === 'View').map(roundColor).filter((color) => color !== undefined),
      hostsOf(node, 'Text').map((text) => flattenStyle(text.props.style).color ?? null),
    ]);
  const expansion = hostsOf(root, 'TouchableOpacity').find((node) => node.props.accessibilityState && 'disabled' in node.props.accessibilityState);
  const editor = hostsOf(root, 'TaskEditModal')[0]?.props;
  const picker = hostsOf(root, 'TokenPickerModal')[0]?.props;
  const organize = hostsOf(root, 'TaskListBulkOrganizeModal')[0]?.props;
  const observation: Observation = {
    // Legacy parity excludes the asserted scope bar and due-only controls.
    texts: allTexts.slice(scopeTexts.length).filter((value) => value !== harness.strings['review.markReviewed'] && value !== harness.strings['review.advanceWeek']),
    headers,
    expansion: expansion ? [
      expansion.props.accessibilityLabel,
      expansion.props.disabled === true,
      visibleNodes(expansion).map((node) => String(node.type)).find((type) => type.startsWith('Icon:')) ?? null,
    ] : null,
    rows: hostsOf(root, 'SwipeableTaskItem').map((row) => [row.props.task.id, row.props.selectionMode === true, row.props.isMultiSelected === true]),
    disabled: hostsOf(root, 'TouchableOpacity').filter((node) => node.props.disabled !== undefined
      && !String(node.props.accessibilityLabel ?? '').startsWith(`${harness.strings['review.markReviewed']}: `)
      && !String(node.props.accessibilityLabel ?? '').startsWith(`${harness.strings['review.advanceWeek']}: `))
      .map((node) => [node.props.accessibilityLabel ?? textsIn(node).join(''), node.props.disabled === true]),
    editor: editor?.visible ? [editor.task?.id ?? null, editor.defaultTab] : null,
    removeTags: picker?.visible ? [picker.title, picker.tokens] : null,
    organize: organize?.visible ? [organize.selectedCount, organize.isApplying] : null,
    guidedReview: hostsOf(root, 'ReviewModal')[0]?.props.visible === true,
    writes: writeLog.slice(seen.writes),
    toasts: harness.toasts.slice(seen.toasts).map((toast) => [toast.tone ?? null, toast.title ?? null, toast.message ?? null, toast.actionLabel ?? null]),
    alerts: harness.alerts.slice(seen.alerts).map((alert) => [alert.title, alert.message, alert.buttons.map((button) => [button.text, button.style ?? null])]),
    pushes: harness.pushes.slice(seen.pushes),
    shares: harness.shares.slice(seen.shares),
  };
  seen.alerts = harness.alerts.length;
  seen.toasts = harness.toasts.length;
  seen.writes = writeLog.length;
  seen.pushes = harness.pushes.length;
  seen.shares = harness.shares.length;
  return normalize(observation) as Observation;
}

async function perform(root: ReactTestInstance, action: [string, ...unknown[]]) {
  const [kind, target, ...rest] = action;
  const run = async (what: string, fn: (() => unknown) | undefined) => {
    if (!fn) throw new Error(`Nothing to do for ${what}`);
    await act(async () => { await fn(); });
  };
  const row = (id: unknown) => hostsOf(root, 'SwipeableTaskItem').find((node) => node.props.task.id === id);
  switch (kind) {
    case 'expand': {
      const button = hostsOf(root, 'TouchableOpacity').find((node) => node.props.accessibilityState && 'disabled' in node.props.accessibilityState);
      return run('expand', button && !button.props.disabled ? button.props.onPress : () => undefined);
    }
    case 'area':
    case 'project': {
      const header = hostsOf(root, 'Pressable').find((node) => (
        node.props.accessibilityState && 'expanded' in node.props.accessibilityState
        && String(node.props.accessibilityLabel).startsWith(`${String(target)}, `)
      ));
      return run(`${kind} ${String(target)}`, header?.props.onPress);
    }
    case 'row': {
      const props = row(target)?.props;
      const [verb, status] = rest as [string, string?];
      if (verb === 'status') return run('status', () => props?.actions.changeStatus(props.task, status));
      if (verb === 'delete') return run('delete', () => props?.actions.remove(props.task));
      return run('edit', () => props?.actions.edit(props.task));
    }
    case 'longPress': {
      const props = row(target)?.props;
      return run('long press', () => props?.onLongPressAction(props.task));
    }
    case 'select': {
      const props = row(target)?.props;
      return run('select', () => props?.actions.toggleSelect(props.task));
    }
    case 'press':
      return run(`press ${String(target)}`, findPressable(root, String(target))?.props.onPress);
    case 'type':
      return run('type', () => hostsOf(root, 'TextInput')[0]?.props.onChangeText(target));
    case 'removeTags':
      return run('remove tags', () => hostsOf(root, 'TokenPickerModal')[0]?.props.onConfirm(target));
    case 'organize':
      return run('organize', () => hostsOf(root, 'TaskListBulkOrganizeModal')[0]?.props.onApply(target));
    case 'alert': {
      // A button without onPress only dismisses the dialog.
      const button = harness.alerts.at(-1)?.buttons.find((entry) => entry.text === target);
      return run('alert', button ? button.onPress ?? (() => undefined) : undefined);
    }
    case 'toastAction':
      return run('toast action', harness.toasts.at(-1)?.onAction);
    default:
      throw new Error(`Unknown action ${kind}`);
  }
}

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  harness.alerts.length = 0;
  harness.toasts.length = 0;
  harness.pushes.length = 0;
  harness.shares.length = 0;
  const settings = settingsVariants[scenario.settings];
  configureDateFormatting({ language: 'en', dateFormat: settings.dateFormat, timeFormat: settings.timeFormat, systemLocale: DEVICE_LOCALE });
  await seedStore(settings, scenarioTasks(scenario));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ReviewScreen />); });
  const allScope = findPressable(renderer.root, harness.strings['review.scopeAll']);
  if (!allScope?.props.onPress) throw new Error('Missing All open tasks scope');
  await act(async () => { await allScope.props.onPress(); });
  const seen = { alerts: 0, toasts: 0, writes: 0, pushes: 0, shares: 0 };
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

describe('React Native Review screen parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    process.env.TZ = TIME_ZONE;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    harness.strings = await loadTranslations('en');
  });
  afterAll(() => {
    vi.useRealTimers();
    configureDateFormatting();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    const inputs = sharedInputs(settingsVariants, scenarios);
    if (CAPTURE) writeFixturePart('review', inputs, captured);
    const { observations, ...frozenInputs } = readFixturePart('review');
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);
});
