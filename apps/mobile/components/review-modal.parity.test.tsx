


import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureDateFormatting, flushPendingSave, getStorageAdapter, loadTranslations, resetForTests, setSaveRetrySleepForTests, setStorageAdapter, useTaskStore, type AppSettings } from '@mindwtr/core';

import {
  CAPTURE,
  DEVICE_LOCALE,
  NOW,
  TIME_ZONE,
  calendarEvents,
  findPressable,
  flattenStyle,
  hostsOf,
  normalize,
  readFixturePart,
  projects,
  tasks,
  scenarioProjects,
  scenarioTasks,
  seedStore,
  sharedInputs,
  textsIn,
  visibleNodes,
  writeFixturePart,
  writeLog,
  type Observation,
  type Scenario,
} from './review-modal.parity-support';
import { ReviewModal } from './review-modal';
import { styles } from './review-modal.styles';
import { logInfo } from '../lib/app-log';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  storage: new Map<string, string>(),
  storageLog: [] as unknown[][],
  captures: [] as unknown[],
  closes: 0,
  calendar: 'events' as 'events' | 'error' | 'none',
  events: [] as unknown[],
  aiSuggestions: [] as unknown[],
  aiRequests: [] as unknown[],
  setVisible: null as null | ((visible: boolean) => void),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => { harness.storageLog.push(['get', key]); return harness.storage.get(key) ?? null; },
    setItem: async (key: string, value: string) => { harness.storageLog.push(['set', key, value]); harness.storage.set(key, value); },
    removeItem: async (key: string) => { harness.storageLog.push(['remove', key]); harness.storage.delete(key); },
  },
}));
vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    createAIProvider: () => ({
      analyzeReview: async (input: unknown) => { harness.aiRequests.push(input); return { suggestions: harness.aiSuggestions }; },
    }),
  };
});
vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => harness.strings[key] ?? key, language: 'en' }),
}));
vi.mock('../contexts/theme-context', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('../contexts/quick-capture-context', () => ({
  useQuickCapture: () => ({ openQuickCapture: (options: unknown) => { harness.captures.push(options); } }),
}));
vi.mock('../contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/hooks/use-theme-tokens', () => ({ useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }) }));
vi.mock('@/hooks/use-filled-button-colors', () => ({ useFilledButtonColors: () => ({ backgroundColor: '#3b82f6', textColor: '#fff' }) }));
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('../lib/ai-config', () => ({
  buildAIConfig: () => ({}),
  isAIKeyRequired: () => false,
  loadAIKey: async () => 'key',
}));
vi.mock('../lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../lib/external-calendar', () => ({
  fetchExternalCalendarEvents: async () => {
    if (harness.calendar === 'error') throw new Error('Calendar feed unreachable');
    return { events: harness.calendar === 'events' ? harness.events : [] };
  },
}));
vi.mock('../lib/store-review-prompt', () => ({ maybeRequestStoreReviewAfterPositiveMoment: async () => false }));
vi.mock('./swipeable-task-item', () => ({ SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props) }));
vi.mock('./task-edit-modal', () => ({ TaskEditModal: (props: any) => React.createElement('TaskEditModal', props) }));
vi.mock('./inbox-processing-modal', () => ({ InboxProcessingModal: (props: any) => React.createElement('InboxProcessingModal', props) }));
vi.mock('./mind-sweep-modal-content', () => ({ MindSweepModalContent: (props: any) => React.createElement('MindSweepModalContent', props) }));
vi.mock('./share-card-modal', () => ({ ShareCardModal: (props: any) => React.createElement('ShareCardModal', props) }));
vi.mock('./ErrorBoundary', () => ({ ErrorBoundary: (props: any) => React.createElement(React.Fragment, null, props.children) }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
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
  const part = (component: any) => (!component ? null : React.isValidElement(component) ? component : React.createElement(component));
  return {
    ...actual,
    FlatList: ({ data = [], renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...props }: any) => React.createElement(
      'FlatList',
      props,
      part(ListHeaderComponent),
      data.length === 0 ? part(ListEmptyComponent) : null,
      data.map((item: any, index: number) => (
        <React.Fragment key={keyExtractor?.(item, index) ?? index}>{renderItem?.({ item, index })}</React.Fragment>
      )),
      part(ListFooterComponent),
    ),
  };
});

const settingsVariants: Record<string, AppSettings> = {
  base: {},
  noContexts: { gtd: { weeklyReview: { includeContextStep: false } } },
  mondayWeek: { weekStart: 'monday' },
  tracked: { features: { pomodoro: true }, gtd: { pomodoro: { linkTask: true } } },
  noEstimates: { features: { timeEstimates: false } },
  ai: { ai: { enabled: true, provider: 'openai' } },
  ymdDates: { dateFormat: 'ymd', timeFormat: '24h' },
};

const SESSION_KEY = 'mindwtr:weeklyReview:currentStep';
const session = (step: string, startedAt: string) => JSON.stringify({ step, startedAt });
const THROUGH = Array.from({ length: 7 }, () => ['next'] as [string]);

export const scenarios: Scenario[] = [
  { name: 'weekly: every step, then finish', settings: 'base', actions: [...THROUGH, ['press', 'Finish']] },
  {
    name: 'weekly: expand and collapse lists',
    settings: 'base',
    actions: [
      ['next'], ['next'], ['press', '+1 More'], ['press', 'Less'], ['next'], ['press', 'Not due yet (1)'], ['press', 'Not due yet (1)'],
      ['next'], ['press', '+1 More'], ['press', 'Less'], ['next'], ['project', 'Launch'], ['project', 'Vendor contract'], ['project', 'Vendor contract'],
      ['next'], ['press', 'Not due yet (1)'],
    ],
  },
  {
    name: 'weekly: rows, the editor and the calendar quick add',
    settings: 'base',
    actions: [
      ['row', 'i-thought', 'status', 'next'], ['row', 'i-dentist', 'edit'], ['closeEditor'], ['row', 'i-dentist', 'delete'],
      ['next'], ['press', 'Add Task'], ['next'], ['next'], ['contextTask', 'Fix bike'],
    ],
  },
  {
    name: 'weekly: add tasks to projects',
    settings: 'base',
    storage: { [SESSION_KEY]: session('projects', '2026-09-21T13:00:00.000Z') },
    actions: [
      ['projectAddTask', 'Launch'], ['type', 'Call printer @phone'], ['press', 'Add'],
      ['projectAddTask', 'Garden'], ['type', 'Buy bulbs'], ['press', 'Save & edit'],
      ['closeEditor'], ['projectAddTask', 'Garden'], ['type', '   '], ['press', 'Cancel'],
      ['projectAddTask', 'Garden'], ['type', 'Water lawn'], ['submit'],
    ],
  },
  { name: 'weekly: pause and resume', settings: 'base', actions: [['next'], ['next'], ['close'], ['reopen'], ['back']] },
  {
    name: 'weekly: a session from this week resumes',
    settings: 'base',
    storage: { [SESSION_KEY]: session('projects', '2026-09-21T13:00:00.000Z') },
    actions: [['next'], ['back'], ['back']],
  },
  { name: 'weekly: a session from last week starts over', settings: 'base', storage: { [SESSION_KEY]: session('projects', '2026-09-18T13:00:00.000Z') }, actions: [] },
  { name: 'weekly: an unreadable session starts over', settings: 'base', storage: { [SESSION_KEY]: 'not json' }, actions: [] },
  {
    name: 'weekly: a stored step without work shows the first step with work',
    settings: 'base',
    taskIds: ['w-alice', 's-piano', 'd-invoice'],
    calendar: 'none',
    storage: { [SESSION_KEY]: session('inbox', '2026-09-22T13:00:00.000Z') },
    actions: [['next'], ['back']],
  },
  { name: 'weekly: no contexts step', settings: 'noContexts', actions: [['next'], ['next'], ['next'], ['next']] },
  {
    name: 'weekly: Monday week start',
    settings: 'mondayWeek',
    storage: { [SESSION_KEY]: session('someday', '2026-09-20T13:00:00.000Z') },
    actions: [...THROUGH],
  },
  { name: 'weekly: tracked time in the look-back', settings: 'tracked', storage: { [SESSION_KEY]: session('completed', '2026-09-22T13:00:00.000Z') }, actions: [] },
  { name: 'weekly: estimates off hide the look-back totals', settings: 'noEstimates', storage: { [SESSION_KEY]: session('completed', '2026-09-22T13:00:00.000Z') }, actions: [] },
  { name: 'weekly: an empty system', settings: 'base', taskIds: [], projectIds: [], calendar: 'none', actions: [['press', 'Finish']] },
  { name: 'weekly: a calendar error', settings: 'base', taskIds: ['r-manual'], calendar: 'error', actions: [['next']] },
  { name: 'weekly: dates follow the app date format', settings: 'ymdDates', actions: [['next'], ['next']] },
  {
    name: 'weekly: AI suggestions',
    settings: 'ai',
    actions: [['next'], ['press', 'Run analysis'], ['suggestion', 'Fix bike'], ['suggestion', 'Fix bike'], ['suggestion', 'Hear back from vendor'], ['press', 'Apply selected (1)']],
  },
];

const AI_SUGGESTIONS = [
  { id: 'n-bike', action: 'someday', reason: 'Untouched for weeks' },
  { id: 'w-vendor', action: 'archive', reason: 'Vendor went quiet' },
  { id: 'project:p-stale', action: 'archive', reason: 'Old project' },
  { id: 'n-launch', action: 'keep', reason: 'Not stale' },
  { id: 'unknown', action: 'someday', reason: 'Not a stale item' },
];

const hasStyle = (node: ReactTestInstance, style: object) => {
  const value = node.props?.style;
  return value === style || (Array.isArray(value) && value.includes(style));
};
const within = (root: ReactTestInstance, style: object) => visibleNodes(root).filter((node) => typeof node.type === 'string' && hasStyle(node, style));


const baselineTexts = (node: ReactTestInstance): string[] => {
  if (String(node.props.testID ?? '').startsWith('review-complete-project-')) return [];
  if (String(node.type) === 'Modal' && !node.props.visible) return [];
  if (String(node.type) === 'Text') return textsIn(node);
  return node.children.flatMap((child) => typeof child === 'string' ? [] : baselineTexts(child));
};

function observe(root: ReactTestInstance, seen: { writes: number; storage: number; captures: number; closes: number; ai: number }): Observation {
  const tint = '#3b82f6';
  const rail = within(root, styles.stepRailItem).map((item) => {
    const style = flattenStyle(item.props.style);
    return [
      textsIn(item).at(-1),
      style.borderColor === tint ? 'current' : style.backgroundColor === '#10b9811A' ? 'complete' : 'pending',
    ];
  });
  const editor = hostsOf(root, 'TaskEditModal')[0]?.props;
  const back = hostsOf(root, 'TouchableOpacity').find((node) => hasStyle(node, styles.backButton));
  const observation: Observation = {
    texts: baselineTexts(root),
    rail,
    progress: within(root, styles.progressBar).map((node) => flattenStyle(node.props.style).width)[0] ?? null,
    rows: hostsOf(root, 'SwipeableTaskItem').map((row) => row.props.task.id),
    backDisabled: back ? back.props.disabled === true : null,
    projects: within(root, styles.projectItem).map((item) => [
      flattenStyle(within(item, styles.projectDot)[0]?.props.style).backgroundColor ?? null,
      flattenStyle(within(item, styles.statusBadge)[0]?.props.style).backgroundColor ?? null,
      flattenStyle(within(item, styles.statusText)[0]?.props.style).color ?? null,
    ]),
    suggestions: within(root, styles.aiCheckbox).map((box) => flattenStyle(box.props.style).backgroundColor === tint),
    editor: editor?.visible ? [editor.task?.id ?? null, editor.defaultTab] : null,
    sheets: ['InboxProcessingModal', 'ShareCardModal'].filter((type) => hostsOf(root, type)[0]?.props.visible)
      .concat(hostsOf(root, 'MindSweepModalContent').length ? ['MindSweep'] : []),
    writes: writeLog.slice(seen.writes),
    storage: harness.storageLog.slice(seen.storage),
    captures: harness.captures.slice(seen.captures),
    closes: harness.closes - seen.closes,
    aiRequests: harness.aiRequests.slice(seen.ai),
  };
  seen.writes = writeLog.length;
  seen.storage = harness.storageLog.length;
  seen.captures = harness.captures.length;
  seen.closes = harness.closes;
  seen.ai = harness.aiRequests.length;
  return normalize(observation) as Observation;
}

async function perform(root: ReactTestInstance, action: [string, ...unknown[]]) {
  const [kind, target, ...rest] = action;
  const run = async (what: string, fn: (() => unknown) | undefined) => {
    if (!fn) throw new Error(`Nothing to do for ${what}: ${JSON.stringify(textsIn(root))}`);
    await act(async () => { await fn(); });
  };
  const row = (id: unknown) => hostsOf(root, 'SwipeableTaskItem').find((node) => node.props.task.id === id)?.props;
  const projectItem = (title: unknown) => within(root, styles.projectItem).find((item) => textsIn(item)[0] === title);
  switch (kind) {
    case 'next':
      return run('next', findPressable(root, 'Next')?.props.onPress);
    case 'back':
      return run('back', findPressable(root, 'Back')?.props.onPress);
    case 'close':
      return run('close', findPressable(root, 'Close')?.props.onPress);
    case 'reopen':
      return run('reopen', () => harness.setVisible?.(true));
    case 'press':
      return run(`press ${String(target)}`, findPressable(root, String(target))?.props.onPress);
    case 'project':
      return run(`project ${String(target)}`, projectItem(target)?.props.onPress);
    case 'projectAddTask': {
      const button = projectItem(target) && within(projectItem(target)!, styles.reviewProjectAddTaskButton)[0];
      return run('project add task', button ? () => button.props.onPress({ stopPropagation: () => undefined }) : undefined);
    }
    case 'type':
      return run('type', () => hostsOf(root, 'TextInput')[0]?.props.onChangeText(target));
    case 'submit':
      return run('submit', () => hostsOf(root, 'TextInput')[0]?.props.onSubmitEditing());
    case 'row': {
      const props = row(target);
      const [verb, status] = rest as [string, string?];
      if (verb === 'status') return run('status', () => props?.actions.changeStatus(props.task, status));
      if (verb === 'delete') return run('delete', () => props?.actions.remove(props.task));
      return run('edit', () => props?.actions.edit(props.task));
    }
    case 'closeEditor':
      return run('close editor', hostsOf(root, 'TaskEditModal')[0]?.props.onClose);
    case 'contextTask':
      return run('context task', within(root, styles.contextTaskRow).find((node) => textsIn(node)[0] === target)?.props.onPress);
    case 'suggestion':
      return run('suggestion', within(root, styles.aiItemRow).find((node) => textsIn(node)[0] === target)?.props.onPress);
    default:
      throw new Error(`Unknown action ${kind}`);
  }
}

function Host() {
  const [visible, setVisible] = React.useState(true);
  harness.setVisible = setVisible;
  return <ReviewModal visible={visible} onClose={() => { harness.closes += 1; setVisible(false); }} />;
}

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  harness.storage = new Map(Object.entries(scenario.storage ?? {}));
  harness.storageLog.length = 0;
  harness.captures.length = 0;
  harness.closes = 0;
  harness.calendar = scenario.calendar ?? 'events';
  harness.events = calendarEvents;
  harness.aiSuggestions = AI_SUGGESTIONS;
  harness.aiRequests.length = 0;
  const settings = settingsVariants[scenario.settings];
  configureDateFormatting({ language: 'en', dateFormat: settings.dateFormat, timeFormat: settings.timeFormat, systemLocale: DEVICE_LOCALE });
  await seedStore(settings, scenarioTasks(scenario), scenarioProjects(scenario));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Host />); });
  await act(async () => { await flushPendingSave(); });
  const seen = { writes: 0, storage: 0, captures: 0, closes: 0, ai: 0 };
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

describe('React Native Weekly Review parity fixture', () => {
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

  it('completes a project through the real store after confirmation and keeps the Projects step', async () => {
    harness.storage = new Map([[SESSION_KEY, session('projects', NOW)]]);
    harness.calendar = 'none';
    const project = projects.find((entry) => entry.id === 'p-launch')!;
    const children = tasks.filter((task) => task.projectId === project.id);
    await seedStore(settingsVariants.base, children, [project]);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Host />); });
    await perform(renderer.root, ['project', 'Launch']);
    await act(async () => renderer.root.findByProps({ testID: 'review-complete-project-p-launch' }).props.onPress());
    expect(useTaskStore.getState()._allProjects[0].status).toBe('active');
    expect(textsIn(renderer.root)).toContain(harness.strings['projects.completeConfirm']);
    await act(async () => renderer.root.findByProps({ testID: 'review-confirm-complete-project' }).props.onPress());
    await act(async () => { await flushPendingSave(); });
    const state = useTaskStore.getState();
    expect(state._allProjects[0].status).toBe('archived');
    expect(state._allProjects[0].archivedAt).toBe(NOW);
    expect(state._allTasks.map((task) => [task.id, task.title])).toEqual(children.map((task) => [task.id, task.title]));
    expect(state._allTasks.find((task) => task.id === 'n-launch')).toMatchObject({ status: 'done', archivedAt: NOW });
    expect(textsIn(renderer.root)).toContain(harness.strings['review.projectsStep']);
    expect(textsIn(renderer.root)).toContain(harness.strings['review.noActiveTasks']);
    expect(renderer.root.findAllByProps({ testID: 'review-confirm-complete-project' })).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  it.each(['saved', 'rejected'] as const)('waits for the real adapter to settle as %s before reporting completion', async (outcome) => {
    harness.storage = new Map([[SESSION_KEY, session('projects', NOW)]]);
    harness.calendar = 'none';
    const project = projects.find((entry) => entry.id === 'p-launch')!;
    await seedStore(settingsVariants.base, tasks.filter((task) => task.projectId === project.id), [project]);
    const storage = getStorageAdapter();
    let settleSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { settleSave = resolve; });
    const saveData = vi.fn(async () => {
      await saveGate;
      if (outcome === 'rejected') throw new Error('Disk full');
    });
    setStorageAdapter({ ...storage, saveData });
    setSaveRetrySleepForTests(async () => undefined);
    vi.mocked(logInfo).mockClear();
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<Host />); });
      await perform(renderer.root, ['project', 'Launch']);
      await act(async () => renderer.root.findByProps({ testID: 'review-complete-project-p-launch' }).props.onPress());
      const confirm = renderer.root.findByProps({ testID: 'review-confirm-complete-project' });
      await act(async () => { confirm.props.onPress(); });
      expect(useTaskStore.getState()._allProjects[0].status).toBe('archived');
      expect(saveData).toHaveBeenCalledOnce();
      expect(logInfo).not.toHaveBeenCalled();
      expect(renderer.root.findByProps({ testID: 'review-confirm-complete-project' }).props.disabled).toBe(true);
      await act(async () => { confirm.props.onPress(); });
      expect(saveData).toHaveBeenCalledOnce();
      await act(async () => { settleSave(); });
      if (outcome === 'saved') {
        expect(logInfo).toHaveBeenCalledExactlyOnceWith('Weekly review project completed', {
          scope: 'review', force: true,
          extra: { releaseCheck: 'v1.3.8/weekly-review-complete-project', outcome: 'completed' },
        });
        expect(useTaskStore.getState().persistenceFailure).toBeNull();
      } else {
        expect(logInfo).not.toHaveBeenCalled();
        expect(renderer.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe(harness.strings['projects.archiveFailed']);
        expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
        expect(useTaskStore.getState()._allProjects[0].status).toBe('archived');
      }
      expect(renderer.root.findAllByProps({ testID: 'review-confirm-complete-project' })).toHaveLength(0);
    } finally {
      settleSave();
      setStorageAdapter(storage);
      await act(async () => {
        await useTaskStore.getState().retryPersistence();
        renderer?.unmount();
      });
      setSaveRetrySleepForTests(null);
    }
  });

  it('keeps an applied AI suggestion titled with the task name', async () => {
    const scenario = scenarios.find(({ name }) => name === 'weekly: AI suggestions')!;
    const observations = await runScenario(scenario);
    const titles = observations.at(-1)?.texts as string[];
    expect(titles).toContain('Fix bike');
    expect(titles).not.toContain('n-bike');
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    const inputs = { ...sharedInputs(settingsVariants, scenarios), aiSuggestions: AI_SUGGESTIONS };
    if (CAPTURE) writeFixturePart('weeklyReview', inputs, captured);
    const { observations, ...frozenInputs } = readFixturePart('weeklyReview');
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);
});
