import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

const mocked = vi.hoisted(() => ({
  tasks: [] as Task[],
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  const storeState = () => ({
    tasks: mocked.tasks,
    _allTasks: mocked.tasks,
    projects: [],
    areas: [],
    sections: [],
    people: [],
    settings: { calendar: { viewMode: 'day', showCompleted: true }, weekStart: 'sunday' },
    addProject: vi.fn(async () => null),
    addTask: vi.fn(async () => ({ success: true, id: 'task-new' })),
    updateTask: vi.fn(async () => ({ success: true })),
    deleteTask: vi.fn(async () => ({ success: true })),
    updateSettings: vi.fn(async () => undefined),
  });
  return {
    ...actual,
    shallow: Object.is,
    useTaskStore: Object.assign(
      (selector?: (state: ReturnType<typeof storeState>) => unknown) => (
        selector ? selector(storeState()) : storeState()
      ),
      { getState: storeState },
    ),
  };
});

vi.mock('react-native-gesture-handler', () => {
  // Every builder method returns the chain, whichever ones the view uses.
  const gesture = () => new Proxy({}, { get: () => () => gesture() });
  return {
    Gesture: { Pan: gesture, Tap: gesture, Race: (...items: unknown[]) => items, Simultaneous: (...items: unknown[]) => items },
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
    ScrollView: (props: any) => React.createElement('GestureScrollView', props, props.children),
    Swipeable: (props: any) => React.createElement('Swipeable', props, props.children),
  };
});

vi.mock('react-native-reanimated', () => ({
  default: {
    View: (props: any) => React.createElement('AnimatedView', props, props.children),
    ScrollView: (props: any) => React.createElement('AnimatedScrollView', props, props.children),
    createAnimatedComponent: (component: unknown) => (props: any) => React.createElement(
      component as string,
      props,
      props.children,
    ),
  },
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedScrollHandler: () => () => {},
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: unknown) => ({ value }),
  withSequence: (value: unknown) => value,
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn(), setParams: vi.fn() },
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({ setOptions: vi.fn() }),
  usePathname: () => '/calendar',
}));

vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => undefined }));

vi.mock('@/lib/external-calendar', () => ({
  canOpenExternalCalendarEvent: () => false,
  fetchExternalCalendarEvents: vi.fn(async () => ({ calendars: [], events: [] })),
  openExternalCalendarEvent: vi.fn(async () => false),
}));

vi.mock('@/lib/app-log', () => ({ logError: vi.fn(async () => null), logInfo: vi.fn(async () => null) }));

vi.mock('@/contexts/theme-context', () => ({ useTheme: () => ({ isDark: false, themePreset: 'default' }) }));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({ areaById: new Map(), resolvedAreaFilter: { included: [], excluded: [] } }),
}));

vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: () => null,
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff', border: '#ddd', cardBg: '#fff', danger: '#d00', filterBg: '#f5f5f5',
    inputBg: '#fff', onTint: '#fff', secondaryText: '#666', success: '#080',
    taskItemBg: '#fff', text: '#111', tint: '#06c', warning: '#c70',
  }),
}));

vi.mock('@/contexts/toast-context', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@/contexts/language-context', () => ({ useLanguage: () => ({ language: 'en', t: (key: string) => key }) }));
vi.mock('@/hooks/use-visible-tasks', () => ({
  useVisibleTaskContext: () => ({
    areaById: new Map(),
    projectById: new Map(),
    resolvedAreaFilter: { included: [], excluded: [] },
    visibleTasks: mocked.tasks,
  }),
}));

// eslint-disable-next-line import/first
import { CalendarView } from './calendar-view';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'next',
  tags: [],
  contexts: [],
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  ...overrides,
});

const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const titleText = (tree: ReactTestRenderer, title: string) => tree.root.findAllByType(Text).find((node) => node.props.children === title);
const flatStyle = (style: unknown): Record<string, unknown> => (
  Array.isArray(style) ? Object.assign({}, ...style.map(flatStyle)) : (style && typeof style === 'object' ? style as Record<string, unknown> : {})
);

describe('CalendarView day all-day card (#1462)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.tasks = [];
  });

  it('draws a completed all-day item crossed out and muted', () => {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    mocked.tasks = [
      task('open-deadline', { dueDate: todayKey() }),
      task('finished', { status: 'done', completedAt: noon.toISOString() }),
    ];

    let tree!: ReactTestRenderer;
    act(() => { tree = create(<CalendarView />); });

    const finished = flatStyle(titleText(tree, 'finished')?.props.style);
    expect(finished).toMatchObject({ textDecorationLine: 'line-through', color: '#666' });
    const open = flatStyle(titleText(tree, 'open-deadline')?.props.style);
    expect(open).toMatchObject({ textDecorationLine: 'none', color: '#111' });
    act(() => tree.unmount());
  });

  it('shows four chips, then "+N more", which expands the card in place and folds back', () => {
    mocked.tasks = Array.from({ length: 6 }, (_, index) => task(`due-${index}`, { dueDate: todayKey() }));

    let tree!: ReactTestRenderer;
    act(() => { tree = create(<CalendarView />); });

    const shown = () => mocked.tasks.filter((entry) => titleText(tree, entry.title)).length;
    expect(shown()).toBe(4);
    const more = () => tree.root.findAll((node) => node.props.testID === 'calendar-all-day-more' && typeof node.props.onPress === 'function')[0];
    expect(titleText(tree, '+2 calendar.more')).toBeTruthy();

    act(() => { more().props.onPress(); });
    expect(shown()).toBe(6);
    expect(titleText(tree, 'common.less')).toBeTruthy();

    act(() => { more().props.onPress(); });
    expect(shown()).toBe(4);
    act(() => tree.unmount());
  });

  it('shows no "+N more" when every item fits', () => {
    mocked.tasks = Array.from({ length: 4 }, (_, index) => task(`due-${index}`, { dueDate: todayKey() }));

    let tree!: ReactTestRenderer;
    act(() => { tree = create(<CalendarView />); });

    expect(tree.root.findAllByProps({ testID: 'calendar-all-day-more' })).toHaveLength(0);
    act(() => tree.unmount());
  });
});
