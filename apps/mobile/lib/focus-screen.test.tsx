import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import FocusScreen from '../app/(drawer)/(tabs)/focus';
import { SwipeableTaskItem } from '@/components/swipeable-task-item';

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  status: 'next',
  tags: [],
  contexts: [],
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  ...overrides,
});

const storeState: {
  tasks: Task[];
  projects: unknown[];
  settings: { features: Record<string, unknown> };
  updateTask: ReturnType<typeof vi.fn>;
  deleteTask: ReturnType<typeof vi.fn>;
  highlightTaskId: string | null;
  setHighlightTask: ReturnType<typeof vi.fn>;
} = {
  tasks: [
    makeTask('focus-task', { isFocusedToday: true, dueDate: '2000-01-01' }),
    makeTask('next-task'),
  ],
  projects: [],
  settings: { features: {} },
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  highlightTaskId: null,
  setHighlightTask: vi.fn(),
};

beforeEach(() => {
  storeState.tasks = [
    makeTask('focus-task', { isFocusedToday: true, dueDate: '2000-01-01' }),
    makeTask('next-task'),
  ];
  storeState.highlightTaskId = null;
});

vi.mock('@mindwtr/core', () => {
  const useTaskStore = Object.assign(() => storeState, {
    getState: () => storeState,
  });

  return {
    useTaskStore,
    safeParseDate: (value?: string) => (value ? new Date(value) : null),
    safeParseDueDate: (value?: string) => (value ? new Date(value) : null),
  };
});

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        'agenda.todaysFocus': "Today's Focus",
        'focus.schedule': 'Today',
        'focus.nextActions': 'Next Actions',
        'agenda.allClear': 'All clear',
        'agenda.noTasks': 'No tasks',
      }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    taskItemBg: '#111827',
    inputBg: '#111827',
    filterBg: '#1f2937',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    icon: '#94a3b8',
    tint: '#3b82f6',
    onTint: '#ffffff',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#3b82f6',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  }),
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

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({ areaById: new Map(), resolvedAreaFilter: null }),
}));

vi.mock('@/lib/area-filter', () => ({
  projectMatchesAreaFilter: () => true,
  taskMatchesAreaFilter: () => true,
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

describe('FocusScreen', () => {
  it('renders starred tasks in a dedicated Today\'s Focus section', () => {
    storeState.tasks = [
      makeTask('plain-next', { title: 'Plain next' }),
      makeTask('focused-next', { title: 'Focused next', isFocusedToday: true }),
      makeTask('another-next', { title: 'Another next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['focused-next', 'plain-next', 'another-next']);

    expect(() =>
      tree.root.find((node) =>
        node.props.accessibilityLabel === "Today's Focus" && typeof node.props.onPress === 'function'
      )
    ).not.toThrow();
  });

  it('keeps Today\'s Focus visible when collapsing Next Actions', () => {
    storeState.tasks = [
      makeTask('focused-next', { title: 'Focused next', isFocusedToday: true }),
      makeTask('plain-next', { title: 'Plain next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const nextSectionButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Next Actions' && typeof node.props.onPress === 'function'
    );

    act(() => {
      nextSectionButton.props.onPress();
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['focused-next']);
  });

  it('does not render a Today\'s Focus section when no task is starred', () => {
    storeState.tasks = [
      makeTask('plain-next', { title: 'Plain next' }),
      makeTask('another-next', { title: 'Another next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(() =>
      tree.root.find((node) =>
        node.props.accessibilityLabel === "Today's Focus" && typeof node.props.onPress === 'function'
      )
    ).toThrow();
  });

  it('collapses the Next Actions section without showing the empty state', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(tree.root.findAllByType(SwipeableTaskItem)).toHaveLength(2);

    const nextSectionButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Next Actions' && typeof node.props.onPress === 'function'
    );

    expect(nextSectionButton.props.accessibilityState).toEqual({ expanded: true });

    act(() => {
      nextSectionButton.props.onPress();
    });

    expect(nextSectionButton.props.accessibilityState).toEqual({ expanded: false });
    expect(tree.root.findAllByType(SwipeableTaskItem)).toHaveLength(1);
    expect(() => tree.root.findByProps({ children: 'All clear' })).toThrow();
  });
});
