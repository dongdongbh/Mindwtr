import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxProcessingModal } from './inbox-processing-modal';

const updateTask = vi.fn();
const deleteTask = vi.fn();
const addProject = vi.fn();
const push = vi.fn();
const clarifyTask = vi.fn();
const mockSettings = { gtd: { inboxProcessing: {} }, ai: {} } as any;
const baseInboxTask = {
  id: 'inbox-1',
  title: 'Inbox task',
  description: 'Original description',
  status: 'inbox',
  contexts: ['@home'],
  tags: ['#old'],
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const storeState = {
  tasks: [{ ...baseInboxTask }] as any[],
  projects: [] as any[],
  areas: [] as any[],
  settings: mockSettings,
  updateTask,
  deleteTask,
  addProject,
};

vi.mock('@mindwtr/core', () => {
  const formatDateOnly = (value: Date | string) => {
    const date = value instanceof Date ? value : new Date(value);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  };

  return {
    addBreadcrumb: vi.fn(),
    DEFAULT_PROJECT_COLOR: '#3b82f6',
    collectTaskTokenUsage: vi.fn((tasks: any[], selector: (task: any) => string[] | undefined, options?: { prefix?: string }) => {
      const usage = new Map<string, { token: string; count: number; lastUsedAt: number }>();
      for (const task of tasks) {
        for (const token of selector(task) ?? []) {
          if (options?.prefix && !token.startsWith(options.prefix)) continue;
          const current = usage.get(token);
          const lastUsedAt = Date.parse(task.updatedAt || task.createdAt || '') || 0;
          if (current) {
            current.count += 1;
            current.lastUsedAt = Math.max(current.lastUsedAt, lastUsedAt);
          } else {
            usage.set(token, { token, count: 1, lastUsedAt });
          }
        }
      }
      return Array.from(usage.values());
    }),
    createAIProvider: vi.fn(() => ({
      clarifyTask,
    })),
    hasTimeComponent: vi.fn((value?: string | null) => Boolean(value && /[T\s]\d{2}:\d{2}/.test(value))),
    normalizeClockTimeInput: vi.fn((value?: string | null) => {
      const trimmed = String(value ?? '').trim();
      if (!trimmed) return '';
      const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }),
    resolveAutoTextDirection: vi.fn(() => 'ltr'),
    safeFormatDate: vi.fn((value: Date | string, formatStr: string) => {
      if (formatStr === 'yyyy-MM-dd') return formatDateOnly(value);
      return 'Jan 1, 2025';
    }),
    safeParseDate: vi.fn((value?: string) => (value ? new Date(value) : null)),
    tFallback: vi.fn((t: (key: string) => string, key: string, fallback: string) => {
      const translated = t(key);
      return translated && translated !== key ? translated : fallback;
    }),
    useTaskStore: () => storeState,
    loadAIKey: vi.fn(),
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('../contexts/toast-context', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff',
    cardBg: '#f8fafc',
    taskItemBg: '#fff',
    inputBg: '#fff',
    filterBg: '#f1f5f9',
    border: '#cbd5e1',
    text: '#0f172a',
    secondaryText: '#64748b',
    icon: '#64748b',
    tint: '#3b82f6',
    onTint: '#fff',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#3b82f6',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  }),
}));

vi.mock('../lib/ai-config', () => ({
  loadAIKey: vi.fn().mockResolvedValue(''),
  isAIKeyRequired: vi.fn().mockReturnValue(false),
  buildAIConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../lib/app-log', () => ({
  logWarn: vi.fn(),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: (props: any) => React.createElement('DateTimePicker', props, props.children),
}));

describe('InboxProcessingModal', () => {
  beforeEach(() => {
    mockSettings.features = undefined;
    mockSettings.gtd = { inboxProcessing: {}, taskEditor: undefined };
    mockSettings.ai = {};
    storeState.tasks = [{ ...baseInboxTask }];
    storeState.projects = [];
    storeState.areas = [];
    updateTask.mockClear();
    deleteTask.mockClear();
    addProject.mockClear();
    push.mockClear();
    clarifyTask.mockClear();
  });

  const findNodeWithText = (root: ReturnType<typeof create>['root'], text: string) => {
    return root.find((node) => {
      const children = node.props?.children;
      if (children === text) return true;
      if (Array.isArray(children)) {
        return children.some((child) => child === text);
      }
      return false;
    });
  };

  const findNodesWithText = (root: ReturnType<typeof create>['root'], text: string) => {
    return root.findAll((node) => {
      const children = node.props?.children;
      if (children === text) return true;
      if (Array.isArray(children)) {
        return children.some((child) => child === text);
      }
      return false;
    });
  };

  it('replaces the header next action with skip and saves edits before advancing', () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = {};
    storeState.projects = [];
    storeState.areas = [];
    updateTask.mockClear();
    deleteTask.mockClear();
    addProject.mockClear();
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const titleInput = root.findByProps({ placeholder: 'taskEdit.titleLabel' });
    const descriptionInput = root.findByProps({ placeholder: 'taskEdit.descriptionPlaceholder' });

    act(() => {
      titleInput.props.onChangeText('Renamed inbox task');
      descriptionInput.props.onChangeText('Updated description');
    });

    const skipLabel = root.findByProps({ children: 'Skip' });
    const skipButton = skipLabel.parent;

    if (!skipButton) {
      throw new Error('Skip button not found');
    }

    act(() => {
      skipButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        title: 'Renamed inbox task',
        description: 'Updated description',
        projectId: undefined,
        contexts: ['@home'],
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('hides the two-minute section when that shortcut is disabled', () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = { twoMinuteEnabled: false };
    storeState.projects = [];
    storeState.areas = [];
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    expect(root.findAllByProps({ children: '✅ inbox.doneIt' })).toHaveLength(0);
  });

  it('hides the contexts and tags section when disabled', () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = { contextStepEnabled: false };
    storeState.projects = [];
    storeState.areas = [];
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    expect(root.findAllByProps({ placeholder: 'inbox.addContextPlaceholder' })).toHaveLength(0);
  });

  it('suggests existing contexts and tags while typing without a prefix', () => {
    mockSettings.gtd.taskEditor = { hidden: [] };
    storeState.tasks = [
      { ...baseInboxTask },
      {
        id: 'metadata-task',
        title: 'Metadata task',
        status: 'next',
        contexts: ['@office'],
        tags: ['#urgent'],
        createdAt: '2025-01-02T00:00:00.000Z',
        updatedAt: '2025-01-02T00:00:00.000Z',
      },
    ];
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const tokenInput = root.findByProps({ placeholder: 'inbox.addContextPlaceholder' });

    act(() => {
      tokenInput.props.onChangeText('off');
    });

    const contextSuggestion = findNodeWithText(root, '@office');
    expect(contextSuggestion).toBeTruthy();
    expect(typeof contextSuggestion.parent?.props.onPress).toBe('function');

    const updatedTokenInput = root.findByProps({ placeholder: 'inbox.addContextPlaceholder' });
    act(() => {
      updatedTokenInput.props.onChangeText('urg');
    });

    expect(findNodeWithText(root, '#urgent')).toBeTruthy();
  });

  it('suggests existing assignees in the assigned-to field', () => {
    storeState.tasks = [
      { ...baseInboxTask },
      {
        id: 'waiting-1',
        title: 'Waiting task',
        status: 'waiting',
        assignedTo: 'Alexandra',
        contexts: [],
        tags: [],
        createdAt: '2025-01-02T00:00:00.000Z',
        updatedAt: '2025-01-02T00:00:00.000Z',
      },
    ];
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const assignedToInput = root.findByProps({ placeholder: 'taskEdit.assignedToPlaceholder' });

    act(() => {
      assignedToInput.props.onChangeText('alex');
    });

    const suggestion = findNodeWithText(root, 'Alexandra');
    expect(suggestion).toBeTruthy();

    act(() => {
      suggestion.parent?.props.onPress();
    });

    expect(root.findByProps({ placeholder: 'taskEdit.assignedToPlaceholder' }).props.value).toBe('Alexandra');
  });

  it('still shows reference during inbox processing when the old setting is disabled', () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = { referenceEnabled: false };
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    expect(findNodeWithText(root, 'nav.reference')).toBeTruthy();
  });

  it('starts mobile inbox processing at the refine form without duplicating the task preview', () => {
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    expect(root.findByProps({ children: 'inbox.refineTitle' })).toBeTruthy();
    expect(findNodesWithText(root, 'Inbox task')).toHaveLength(0);
    expect(findNodesWithText(root, 'Original description')).toHaveLength(0);
  });

  it('includes future-start inbox tasks in processing', () => {
    storeState.tasks = [{
      ...baseInboxTask,
      startTime: '2999-01-01',
    }];
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    expect(root.findByProps({ children: 'inbox.refineTitle' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves Later items to next with a date-only start date', () => {
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const laterLabel = findNodeWithText(root, 'Later');
    const laterButton = laterLabel.parent;

    if (!laterButton) {
      throw new Error('Later button not found');
    }

    act(() => {
      laterButton.props.onPress();
    });

    const startValueLabel = root.findByProps({ children: 'common.notSet' });
    const startButton = startValueLabel.parent;

    if (!startButton) {
      throw new Error('Start date button not found');
    }

    act(() => {
      startButton.props.onPress();
    });

    const datePicker = root.findByType('DateTimePicker' as any);

    act(() => {
      datePicker.props.onChange({ type: 'set' }, new Date(2026, 2, 23, 12, 0, 0));
    });

    const nextTaskLabel = findNodeWithText(root, 'Next task →');
    const nextTaskButton = nextTaskLabel.parent;

    if (!nextTaskButton) {
      throw new Error('Next task button not found');
    }

    act(() => {
      nextTaskButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        status: 'next',
        startTime: '2026-03-23',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('moves Later items with the configured default schedule time', () => {
    mockSettings.gtd.defaultScheduleTime = '09:00';
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const laterButton = findNodeWithText(root, 'Later').parent;

    if (!laterButton) {
      throw new Error('Later button not found');
    }

    act(() => {
      laterButton.props.onPress();
    });

    const startButton = root.findByProps({ children: 'common.notSet' }).parent;

    if (!startButton) {
      throw new Error('Start date button not found');
    }

    act(() => {
      startButton.props.onPress();
    });

    const datePicker = root.findByType('DateTimePicker' as any);

    act(() => {
      datePicker.props.onChange({ type: 'set' }, new Date(2026, 2, 23, 12, 0, 0));
    });

    const nextTaskButton = findNodeWithText(root, 'Next task →').parent;

    if (!nextTaskButton) {
      throw new Error('Next task button not found');
    }

    act(() => {
      nextTaskButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        status: 'next',
        startTime: '2026-03-23T09:00',
      })
    );
  });

  it('allows Later items to stay date-only when a default schedule time is configured', () => {
    mockSettings.gtd.defaultScheduleTime = '09:00';
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const laterButton = findNodeWithText(root, 'Later').parent;

    if (!laterButton) {
      throw new Error('Later button not found');
    }

    act(() => {
      laterButton.props.onPress();
    });

    const startButton = root.findByProps({ children: 'common.notSet' }).parent;

    if (!startButton) {
      throw new Error('Start date button not found');
    }

    act(() => {
      startButton.props.onPress();
    });

    const datePicker = root.findByType('DateTimePicker' as any);

    act(() => {
      datePicker.props.onChange({ type: 'set' }, new Date(2026, 2, 23, 12, 0, 0));
    });

    const dateOnlyLabel = findNodeWithText(root, 'Date only');
    const dateOnlyButton = dateOnlyLabel.parent;

    if (!dateOnlyButton) {
      throw new Error('Date only button not found');
    }

    act(() => {
      dateOnlyButton.props.onPress();
    });

    const nextTaskButton = findNodeWithText(root, 'Next task →').parent;

    if (!nextTaskButton) {
      throw new Error('Next task button not found');
    }

    act(() => {
      nextTaskButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        status: 'next',
        startTime: '2026-03-23',
      })
    );
  });

  it('saves the selected priority by default when priorities are not explicitly disabled', () => {
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const priorityLabel = root.findByProps({ children: 'priority.high' });
    const priorityButton = priorityLabel.parent;

    if (!priorityButton) {
      throw new Error('Priority button not found');
    }

    act(() => {
      priorityButton.props.onPress();
    });

    const skipLabel = root.findByProps({ children: 'Skip' });
    const skipButton = skipLabel.parent;

    if (!skipButton) {
      throw new Error('Skip button not found');
    }

    act(() => {
      skipButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        projectId: undefined,
        contexts: ['@home'],
        priority: 'high',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('saves energy level and time estimate during inbox processing', () => {
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const energyLabel = root.findByProps({ children: 'energyLevel.high' });
    const energyButton = energyLabel.parent;
    const estimateLabel = root.findByProps({ children: '30m' });
    const estimateButton = estimateLabel.parent;
    const skipLabel = root.findByProps({ children: 'Skip' });
    const skipButton = skipLabel.parent;

    if (!energyButton || !estimateButton || !skipButton) {
      throw new Error('Expected inbox processing controls were not found');
    }

    act(() => {
      energyButton.props.onPress();
      estimateButton.props.onPress();
    });

    act(() => {
      skipButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        energyLevel: 'high',
        timeEstimate: '30min',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('hides organization fields when the task editor layout disables them', () => {
    mockSettings.gtd = {
      inboxProcessing: {},
      taskEditor: {
        hidden: ['energyLevel', 'timeEstimate'],
      },
    };
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    expect(root.findAllByProps({ children: 'taskEdit.energyLevel' })).toHaveLength(0);
    expect(root.findAllByProps({ children: 'taskEdit.timeEstimateLabel' })).toHaveLength(0);
    expect(root.findAllByProps({ children: 'energyLevel.high' })).toHaveLength(0);
    expect(root.findAllByProps({ children: '30m' })).toHaveLength(0);
  });

  it('moves delegated tasks to waiting with assignedTo and keeps the description clean', () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = {};
    storeState.projects = [];
    storeState.areas = [];
    updateTask.mockClear();
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const delegateLabel = findNodeWithText(root, 'inbox.delegate');
    const delegateButton = delegateLabel.parent;

    if (!delegateButton) {
      throw new Error('Delegate button not found');
    }

    act(() => {
      delegateButton.props.onPress();
    });

    const whoInput = root.findByProps({ placeholder: 'process.delegateWhoPlaceholder' });

    act(() => {
      whoInput.props.onChangeText('Alex');
    });

    const nextTaskLabel = findNodeWithText(root, 'Next task →');
    const nextTaskButton = nextTaskLabel.parent;

    if (!nextTaskButton) {
      throw new Error('Next task button not found');
    }

    act(() => {
      nextTaskButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        status: 'waiting',
        assignedTo: 'Alex',
        description: 'Original description',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the selected priority when delegating a task', () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = {};
    storeState.projects = [];
    storeState.areas = [];
    updateTask.mockClear();
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const priorityLabel = root.findByProps({ children: 'priority.high' });
    const priorityButton = priorityLabel.parent;

    if (!priorityButton) {
      throw new Error('Priority button not found');
    }

    act(() => {
      priorityButton.props.onPress();
    });

    const delegateLabel = findNodeWithText(root, 'inbox.delegate');
    const delegateButton = delegateLabel.parent;

    if (!delegateButton) {
      throw new Error('Delegate button not found');
    }

    act(() => {
      delegateButton.props.onPress();
    });

    const whoInput = root.findByProps({ placeholder: 'process.delegateWhoPlaceholder' });

    act(() => {
      whoInput.props.onChangeText('Alex');
    });

    const nextTaskLabel = findNodeWithText(root, 'Next task →');
    const nextTaskButton = nextTaskLabel.parent;

    if (!nextTaskButton) {
      throw new Error('Next task button not found');
    }

    act(() => {
      nextTaskButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        status: 'waiting',
        assignedTo: 'Alex',
        priority: 'high',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the selected priority when delegating a task', () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = {};
    storeState.projects = [];
    storeState.areas = [];
    updateTask.mockClear();
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const priorityLabel = root.findByProps({ children: 'priority.urgent' });
    const priorityButton = priorityLabel.parent;

    if (!priorityButton) {
      throw new Error('Priority button not found');
    }

    act(() => {
      priorityButton.props.onPress();
    });

    const delegateLabel = findNodeWithText(root, 'inbox.delegate');
    const delegateButton = delegateLabel.parent;

    if (!delegateButton) {
      throw new Error('Delegate button not found');
    }

    act(() => {
      delegateButton.props.onPress();
    });

    const whoInput = root.findByProps({ placeholder: 'process.delegateWhoPlaceholder' });

    act(() => {
      whoInput.props.onChangeText('Alex');
    });

    const nextTaskLabel = findNodeWithText(root, 'Next task →');
    const nextTaskButton = nextTaskLabel.parent;

    if (!nextTaskButton) {
      throw new Error('Next task button not found');
    }

    act(() => {
      nextTaskButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        status: 'waiting',
        assignedTo: 'Alex',
        priority: 'urgent',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('does not allow delegation without an assignee name', () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = {};
    storeState.projects = [];
    storeState.areas = [];
    updateTask.mockClear();
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const delegateLabel = findNodeWithText(root, 'inbox.delegate');
    const delegateButton = delegateLabel.parent;

    if (!delegateButton) {
      throw new Error('Delegate button not found');
    }

    act(() => {
      delegateButton.props.onPress();
    });

    const nextTaskLabel = findNodeWithText(root, 'Next task →');
    const nextTaskButton = nextTaskLabel.parent;

    if (!nextTaskButton) {
      throw new Error('Next task button not found');
    }

    expect(nextTaskButton.props.disabled).toBe(true);

    act(() => {
      nextTaskButton.props.onPress();
    });

    expect(updateTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a working state while AI clarify is running', async () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = {};
    mockSettings.ai = { enabled: true, provider: 'openai' };
    storeState.projects = [];
    storeState.areas = [];
    clarifyTask.mockReset();
    clarifyTask.mockImplementation(() => new Promise(() => {}));
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const aiClarifyLabel = root.findByProps({ children: 'taskEdit.aiClarify' });
    const aiClarifyButton = aiClarifyLabel.parent;

    if (!aiClarifyButton) {
      throw new Error('AI clarify button not found');
    }

    await act(async () => {
      aiClarifyButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(root.findByProps({ children: 'Working...' })).toBeTruthy();
  });
});
