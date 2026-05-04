import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DailyReviewScreen } from './daily-review-modal';
import { SwipeableTaskItem } from './swipeable-task-item';

const storeState: any = {
  tasks: [
    {
      id: 'task-1',
      title: 'Focus me',
      status: 'next',
      contexts: [],
      tags: [],
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
  ],
  settings: {},
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
};

vi.mock('@mindwtr/core', () => ({
  useTaskStore: () => storeState,
  isDueForReview: () => false,
  safeFormatDate: () => '2026-03-15',
  safeParseDate: () => null,
  safeParseDueDate: () => null,
  sortTasksBy: (tasks: unknown[]) => tasks,
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        'dailyReview.title': 'Daily Review',
        'dailyReview.todayStep': 'Today',
        'dailyReview.todayDesc': 'Review today.',
        'dailyReview.focusStep': "Today's Focus",
        'dailyReview.focusDesc': 'Optional focus.',
        'dailyReview.focusSelected': 'focused',
        'dailyReview.inboxStep': 'Inbox',
        'dailyReview.inboxDesc': 'Review inbox.',
        'dailyReview.waitingStep': 'Waiting',
        'dailyReview.waitingDesc': 'Review waiting.',
        'dailyReview.completeTitle': 'Done',
        'dailyReview.completeDesc': 'Done.',
        'review.step': 'Step',
        'review.of': 'of',
        'review.nextStepBtn': 'Next Step',
        'review.back': 'Back',
        'common.tasks': 'tasks',
        'calendar.events': 'Events',
        'calendar.noTasks': 'No tasks',
        'agenda.noTasks': 'No tasks',
        'agenda.focusHint': 'Pick focus tasks.',
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

vi.mock('./swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('./task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('./inbox-processing-modal', () => ({
  InboxProcessingModal: (props: any) => React.createElement('InboxProcessingModal', props),
}));

vi.mock('./ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('../lib/external-calendar', () => ({
  fetchExternalCalendarEvents: vi.fn().mockResolvedValue({ events: [] }),
}));

vi.mock('expo-router', () => ({
  router: {
    push: vi.fn(),
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: (props: any) => React.createElement('GestureHandlerRootView', props, props.children),
}));

describe('DailyReviewScreen', () => {
  beforeEach(() => {
    storeState.settings = {};
    vi.clearAllMocks();
  });

  it('shows the focus toggle on task rows during the focus step', async () => {
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(<DailyReviewScreen onClose={vi.fn()} />);
    });

    const pressNextStep = async () => {
      const nextStepLabel = tree.root.findByProps({ children: 'Next Step' });
      const nextStepButton = nextStepLabel.parent;
      if (!nextStepButton) {
        throw new Error('Next step button not found');
      }
      await act(async () => {
        nextStepButton.props.onPress();
      });
    };

    await pressNextStep();
    await pressNextStep();

    const taskRows = tree.root.findAllByType(SwipeableTaskItem);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].props.showFocusToggle).toBe(true);
    expect(taskRows[0].props.hideStatusBadge).toBe(true);
  });

  it('skips the focus step when daily review focus is disabled', async () => {
    storeState.settings = {
      gtd: {
        dailyReview: {
          includeFocusStep: false,
        },
      },
    };
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(<DailyReviewScreen onClose={vi.fn()} />);
    });

    const flattenText = (value: unknown): string => {
      if (typeof value === 'string' || typeof value === 'number') return String(value);
      if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
      return '';
    };
    const pressNextStep = async () => {
      const nextStepLabel = tree.root.findByProps({ children: 'Next Step' });
      const nextStepButton = nextStepLabel.parent;
      if (!nextStepButton) {
        throw new Error('Next step button not found');
      }
      await act(async () => {
        nextStepButton.props.onPress();
      });
    };

    await pressNextStep();
    await pressNextStep();

    const allText = tree.root.findAll((node) => Boolean(node.props?.children))
      .map((node) => flattenText(node.props.children))
      .join('\n');
    expect(allText).toContain('Waiting');
    expect(allText).not.toContain("Today's Focus");
  });
});
