import React from 'react';
import { Animated, Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxProcessingModal } from './inbox-processing-modal';

const updateTask = vi.fn();
const deleteTask = vi.fn();
const restoreTask = vi.fn();
const undoTaskCompletion = vi.hoisted(() => vi.fn());
const addProject = vi.fn();
const addTask = vi.fn();
const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock,
}));

const hapticsMock = vi.hoisted(() => ({ notificationAsync: vi.fn().mockResolvedValue(undefined) }));

vi.mock('expo-haptics', () => ({
  __esModule: true,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
  notificationAsync: hapticsMock.notificationAsync,
}));

const reducedMotionMock = vi.hoisted(() => ({ value: false }));

vi.mock('@/hooks/use-reduced-motion', () => ({
  useReducedMotion: () => reducedMotionMock.value,
}));
const push = vi.fn();
const clarifyTask = vi.fn();
const showToast = vi.fn();
const dismissToast = vi.fn();
const translate = (key: string) => ({
  'taskEdit.dateOnly': 'Date only',
  'viewSections.add': 'New section…',
  'viewSections.nameHint': 'Section name',
}[key] ?? key);
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
const workArea = {
  id: 'area-work',
  name: 'Work',
  color: '#2563eb',
  order: 0,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const homeArea = {
  id: 'area-home',
  name: 'Home',
  color: '#16a34a',
  order: 1,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const workProject = {
  id: 'project-work',
  title: 'Work Project',
  color: '#2563eb',
  status: 'active',
  order: 0,
  tagIds: [],
  areaId: workArea.id,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const homeProject = {
  id: 'project-home',
  title: 'Home Project',
  color: '#16a34a',
  status: 'active',
  order: 1,
  tagIds: [],
  areaId: homeArea.id,
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
  restoreTask,
  addProject,
  addTask,
  updateSettings: vi.fn(async (_settings: any) => {}),
};
const originalPlatformOs = Platform.OS;

const setPlatform = (os: typeof Platform.OS) => {
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: os,
  });
};

const flattenStyle = (style: unknown): Record<string, any> => {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, any>>((acc, item) => Object.assign(acc, flattenStyle(item)), {});
  }
  return style && typeof style === 'object' ? (style as Record<string, any>) : {};
};

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  const formatDateOnly = (value: Date | string) => {
    const date = value instanceof Date ? value : new Date(value);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  };

  return {
    ...actual,
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
    formatTimeEstimateLabel: vi.fn((value: string) => {
        if (value.startsWith('custom:')) return `${value.slice('custom:'.length)}m`;
        return value.replace('min', 'm').replace('hr+', 'h+').replace('hr', 'h');
    }),
    filterProjectsBySelectedArea: vi.fn((projects: any[], selectedAreaId?: string) => projects.filter((project: any) => (
      !project.deletedAt
      && project.status !== 'archived'
      && project.status !== 'completed'
      && (!selectedAreaId || project.areaId === selectedAreaId)
    ))),
    QUICK_DATE_PRESETS: ['today', 'tomorrow', 'in_3_days', 'next_week', 'next_month', 'no_date'],
    getQuickDate: vi.fn((preset: string) => {
      const today = new Date(2025, 0, 1);
      switch (preset) {
        case 'today':
          return today;
        case 'tomorrow':
          return new Date(2025, 0, 2);
        case 'in_3_days':
          return new Date(2025, 0, 4);
        case 'next_week':
          return new Date(2025, 0, 6);
        case 'next_month':
          return new Date(2025, 1, 1);
        case 'no_date':
          return null;
        default:
          return null;
      }
    }),
    isQuickDatePresetSelected: vi.fn(() => false),
    isSelectableProjectForTaskAssignment: vi.fn((project: any) => (
      !project.deletedAt && project.status !== 'archived' && project.status !== 'completed'
    )),
    getPersonSuggestionNames: vi.fn((people: any[] | undefined, tasks: any[], value: string | undefined, limit: number) => {
      const query = (value ?? '').trim().toLowerCase();
      if (!query) return [];
      const names = new Map<string, { name: string; lastUsedAt: number }>();
      for (const person of people ?? []) {
        if (person.deletedAt || typeof person.name !== 'string') continue;
        const name = person.name.trim();
        if (!name) continue;
        names.set(name.toLowerCase(), {
          name,
          lastUsedAt: Date.parse(person.updatedAt || person.createdAt || '') || 0,
        });
      }
      for (const task of tasks) {
        if (task.deletedAt || typeof task.assignedTo !== 'string') continue;
        const name = task.assignedTo.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const current = names.get(key);
        const lastUsedAt = Date.parse(task.updatedAt || task.createdAt || '') || 0;
        names.set(key, {
          name: current?.name ?? name,
          lastUsedAt: Math.max(current?.lastUsedAt ?? 0, lastUsedAt),
        });
      }
      return Array.from(names.values())
        .filter((entry) => entry.name.toLowerCase().includes(query))
        .filter((entry) => entry.name.toLowerCase() !== query)
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt || left.name.localeCompare(right.name))
        .slice(0, limit)
        .map((entry) => entry.name);
    }),
    isTaskInActiveProject: vi.fn(() => true),
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
    // The real store is selector-based; the controller's shared visible-task
    // context subscribes field by field, so the mock has to honour selectors.
    useTaskStore: Object.assign(
      (selector?: (state: typeof storeState) => unknown) => (
        selector ? selector(storeState) : storeState
      ),
      { getState: () => storeState },
    ),
    undoTaskCompletion,
    loadAIKey: vi.fn(),
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: translate,
    language: 'en',
  }),
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('../contexts/toast-context', () => ({
  useToast: () => ({
    showToast,
    dismissToast,
  }),
  ToastViewport: () => null,
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
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
  logError: vi.fn(),
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
    mockSettings.filters = undefined;
    storeState.tasks = [{ ...baseInboxTask }];
    storeState.projects = [];
    storeState.areas = [];
    updateTask.mockReset();
    updateTask.mockResolvedValue({ success: true });
    deleteTask.mockReset();
    deleteTask.mockResolvedValue({ success: true });
    restoreTask.mockReset();
    restoreTask.mockResolvedValue({ success: true });
    undoTaskCompletion.mockReset();
    undoTaskCompletion.mockResolvedValue(undefined);
    hapticsMock.notificationAsync.mockClear();
    asyncStorageMock.getItem.mockReset();
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockReset();
    asyncStorageMock.setItem.mockResolvedValue(undefined);
    reducedMotionMock.value = false;
    addProject.mockClear();
    addTask.mockReset();
    addTask.mockResolvedValue({ success: true });
    push.mockClear();
    clarifyTask.mockClear();
    showToast.mockClear();
    dismissToast.mockClear();
    storeState.updateSettings.mockClear();
  });

  afterEach(() => {
    setPlatform(originalPlatformOs);
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

  const findTextInputsByAccessibilityLabel = (
    root: ReturnType<typeof create>['root'],
    accessibilityLabel: string,
  ) => root.findAll((node) => (
    typeof node.type === 'string'
    && node.props.accessibilityLabel === accessibilityLabel
    && typeof node.props.onChangeText === 'function'
  ));

  const findTextInputByAccessibilityLabel = (
    root: ReturnType<typeof create>['root'],
    accessibilityLabel: string,
  ) => {
    const inputs = findTextInputsByAccessibilityLabel(root, accessibilityLabel);
    if (inputs.length !== 1) {
      throw new Error(`Expected one text input named "${accessibilityLabel}", found ${inputs.length}`);
    }
    return inputs[0];
  };

  const flushAsyncActions = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const findPressableWithText = (root: ReturnType<typeof create>['root'], text: string) => {
    let node: any = findNodeWithText(root, text);
    while (node && typeof node.props?.onPress !== 'function') {
      node = node.parent;
    }
    if (!node) {
      throw new Error(`Pressable for "${text}" not found`);
    }
    return node;
  };

  const pressStep = (root: ReturnType<typeof create>['root'], text: string) => {
    act(() => {
      findPressableWithText(root, text).props.onPress();
    });
  };

  /** "Yes, actionable" then "takes longer than two minutes". */
  const chooseActionableLonger = (root: ReturnType<typeof create>['root']) => {
    pressStep(root, 'inbox.yes');
    pressStep(root, 'inbox.takesLonger');
  };

  /** Walk to the terminal Next-Action step: actionable → longer → I'll do it → single action. */
  const walkToFileStep = (root: ReturnType<typeof create>['root']) => {
    chooseActionableLonger(root);
    pressStep(root, 'inbox.illDoIt');
    if (findNodesWithText(root, 'process.moreThanOneStepNo').length > 0) {
      pressStep(root, 'process.moreThanOneStepNo');
    }
  };

  /** Walk to the terminal step with "make it a project" chosen instead. */
  const walkToProjectConversion = (root: ReturnType<typeof create>['root']) => {
    chooseActionableLonger(root);
    pressStep(root, 'inbox.illDoIt');
    pressStep(root, 'process.moreThanOneStepYes');
  };

  /** The note field rides an explicit affordance on the capture card. */
  const openAnchorEditor = (root: ReturnType<typeof create>['root']) => {
    const notesButton = root.findByProps({
      accessibilityLabel: 'taskEdit.descriptionLabel',
      accessibilityRole: 'button',
    });
    if (!notesButton.props.accessibilityState?.expanded) {
      act(() => {
        notesButton.props.onPress();
      });
    }
  };

  const expandMoreOptions = (root: ReturnType<typeof create>['root']) => {
    const moreOptions = findPressableWithText(root, 'More options');
    if (!moreOptions.props.accessibilityState?.expanded) {
      act(() => {
        moreOptions.props.onPress();
      });
    }
  };

  const revealDeferredOptions = (root: ReturnType<typeof create>['root']) => {
    walkToFileStep(root);
    expandMoreOptions(root);
  };

  it('asks one question per screen and only commits at the terminal step', () => {
    storeState.tasks = [{ ...baseInboxTask, contexts: [], tags: [] }];
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    // Step 1 is the only question on screen, and nothing can be filed yet.
    expect(findNodesWithText(root, 'inbox.isActionable').length).toBeGreaterThan(0);
    expect(findNodesWithText(root, 'inbox.twoMinRule')).toHaveLength(0);
    expect(findNodesWithText(root, 'inbox.whoShouldDoIt')).toHaveLength(0);
    expect(findNodesWithText(root, 'File it')).toHaveLength(0);

    pressStep(root, 'inbox.yes');

    expect(findNodesWithText(root, 'inbox.twoMinRule').length).toBeGreaterThan(0);
    expect(findNodesWithText(root, 'inbox.isActionable')).toHaveLength(0);
    expect(findNodesWithText(root, 'inbox.whoShouldDoIt')).toHaveLength(0);

    pressStep(root, 'inbox.takesLonger');

    expect(findNodesWithText(root, 'inbox.whoShouldDoIt').length).toBeGreaterThan(0);
    expect(findNodesWithText(root, 'inbox.twoMinRule')).toHaveLength(0);
    expect(findNodesWithText(root, 'File it')).toHaveLength(0);

    pressStep(root, 'inbox.illDoIt');

    expect(findNodesWithText(root, 'process.moreThanOneStep').length).toBeGreaterThan(0);
    expect(findNodesWithText(root, 'File it')).toHaveLength(0);

    pressStep(root, 'process.moreThanOneStepNo');

    // Terminal step: Project and Context, with everything else behind More options.
    expect(findNodesWithText(root, 'File it').length).toBeGreaterThan(0);
    expect(findPressableWithText(root, 'More options').props.accessibilityState).toEqual({ expanded: false });
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('keeps the item anchored above every step', () => {
    storeState.tasks = [{ ...baseInboxTask, title: 'Anchored capture', description: '# Heading\n**bold** note' }];
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
    });

    const root = tree!.root;
    const title = () => root.findByProps({
      placeholder: 'taskEdit.titleLabel',
      accessibilityLabel: 'taskEdit.titleLabel',
    }).props.value;

    expect(title()).toBe('Anchored capture');
    // The note preview is plain text, not the raw Markdown.
    expect(findNodesWithText(root, 'Heading\nbold note').length).toBeGreaterThan(0);

    chooseActionableLonger(root);

    expect(title()).toBe('Anchored capture');
  });

  it('edits the capture title in place and opens the note on an explicit tap', () => {
    storeState.tasks = [{ ...baseInboxTask }];
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
    });

    const root = tree!.root;
    const titleInput = root.findByProps({
      placeholder: 'taskEdit.titleLabel',
      accessibilityLabel: 'taskEdit.titleLabel',
    });

    act(() => {
      titleInput.props.onChangeText('Clarified while deciding');
    });

    expect(root.findByProps({
      placeholder: 'taskEdit.titleLabel',
      accessibilityLabel: 'taskEdit.titleLabel',
    }).props.value).toBe('Clarified while deciding');

    const notesButton = root.findByProps({
      accessibilityLabel: 'taskEdit.descriptionLabel',
      accessibilityRole: 'button',
    });
    expect(notesButton.props.accessibilityState).toEqual({ expanded: false });
    expect(root.findAllByProps({ placeholder: 'taskEdit.descriptionPlaceholder' })).toHaveLength(0);

    act(() => {
      notesButton.props.onPress();
    });

    expect(root.findAllByProps({ placeholder: 'taskEdit.descriptionPlaceholder' }).length).toBeGreaterThan(0);
  });

  it('keeps the title editable on every step of both modes', async () => {
    storeState.tasks = [{ ...baseInboxTask }];
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
    });
    await flushAsyncActions();

    const root = tree!.root;
    const titleInput = () => root.findByProps({
      placeholder: 'taskEdit.titleLabel',
      accessibilityLabel: 'taskEdit.titleLabel',
    });

    chooseActionableLonger(root);
    pressStep(root, 'inbox.illDoIt');
    pressStep(root, 'process.moreThanOneStepNo');

    act(() => {
      titleInput().props.onChangeText('Edited at the terminal step');
    });
    expect(titleInput().props.value).toBe('Edited at the terminal step');

    // ...and in quick mode.
    asyncStorageMock.getItem.mockResolvedValue('quick');
    storeState.tasks = [{ ...baseInboxTask }];
    let quickTree: ReturnType<typeof create>;
    act(() => {
      quickTree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
    });
    await flushAsyncActions();

    expect(quickTree!.root.findByProps({
      placeholder: 'taskEdit.titleLabel',
      accessibilityLabel: 'taskEdit.titleLabel',
    }).props.value).toBe('Inbox task');
  });

  it('steps back to the previous question and clears the answer it derived', () => {
    storeState.tasks = [{ ...baseInboxTask, contexts: [], tags: [] }];
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
    });

    const root = tree!.root;
    chooseActionableLonger(root);
    expect(findNodesWithText(root, 'inbox.whoShouldDoIt').length).toBeGreaterThan(0);

    pressStep(root, '‹ Back');

    expect(findNodesWithText(root, 'inbox.twoMinRule').length).toBeGreaterThan(0);
    expect(findNodesWithText(root, 'inbox.whoShouldDoIt')).toHaveLength(0);

    pressStep(root, '‹ Back');

    expect(findNodesWithText(root, 'inbox.isActionable').length).toBeGreaterThan(0);
    // The first step is the start of the flow, so it offers no way further back.
    expect(findNodesWithText(root, '‹ Back')).toHaveLength(0);
  });

  it('keeps optional scheduling available for delegated tasks without showing project metadata', () => {
    mockSettings.gtd.inboxProcessing = { scheduleEnabled: true };
    storeState.tasks = [{ ...baseInboxTask, contexts: [], tags: [] }];
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
    });

    const root = tree!.root;
    chooseActionableLonger(root);

    act(() => {
      findPressableWithText(root, 'inbox.delegate').props.onPress();
    });
    act(() => {
      findPressableWithText(root, 'More options').props.onPress();
    });

    expect(findNodesWithText(root, 'taskEdit.scheduling').length).toBeGreaterThan(0);
    expect(root.findAllByProps({ placeholder: 'projects.addPlaceholder' })).toHaveLength(0);
    expect(root.findAllByProps({ placeholder: 'inbox.addContextPlaceholder' })).toHaveLength(0);
  });

  it('keeps the processing form keyboard-aware on iOS', () => {
    setPlatform('ios');
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const keyboardAvoidingView = tree!.root.findByType(KeyboardAvoidingView);
    expect(keyboardAvoidingView.props.behavior).toBe('padding');
    expect(keyboardAvoidingView.props.keyboardVerticalOffset).toBe(48);

    const processingScroll = tree!.root.findByType(ScrollView);

    expect(processingScroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(processingScroll.props.keyboardDismissMode).toBe('interactive');
    expect(processingScroll.props.keyboardShouldPersistTaps).toBe('handled');
  });

  it('renders as a transparent self-backed window on Android (OnePlus letterbox fix)', () => {
    setPlatform('android');
    const onClose = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const modal = tree.root.findByType(Modal);
    // A non-transparent full-screen Modal window is letterboxed instead of
    // resized by some OEM Android 15 builds when the keyboard opens, leaving a
    // black band under the note input. Transparent + own opaque background
    // matches the app's other sheets and dodges that path entirely.
    expect(modal.props.transparent).toBe(true);
    expect(modal.props.statusBarTranslucent).toBe(true);
    expect(modal.props.navigationBarTranslucent).toBe(true);
    expect(modal.props.presentationStyle).toBeUndefined();
  });

  it('lifts the Android processing form by the measured keyboard inset instead of resizing', () => {
    setPlatform('android');
    const listeners = new Map<string, (event?: any) => void>();
    const addListener = vi.spyOn(Keyboard, 'addListener').mockImplementation((event: string, callback: any) => {
      listeners.set(event, callback);
      return { remove: vi.fn() } as any;
    });
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    expect(addListener).toHaveBeenCalledWith('keyboardDidShow', expect.any(Function));
    expect(addListener).toHaveBeenCalledWith('keyboardDidChangeFrame', expect.any(Function));
    expect(addListener).toHaveBeenCalledWith('keyboardDidHide', expect.any(Function));

    act(() => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 280 } });
    });

    const keyboardAvoidingView = tree!.root.findByType(KeyboardAvoidingView);
    expect(keyboardAvoidingView.props.behavior).toBeUndefined();
    expect(flattenStyle(keyboardAvoidingView.props.style).paddingBottom).toBe(280);

    act(() => {
      listeners.get('keyboardDidHide')?.();
    });

    expect(flattenStyle(tree!.root.findByType(KeyboardAvoidingView).props.style).paddingBottom).toBeUndefined();
  });

  it('replaces the header next action with skip and saves edits before advancing', async () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = {};
    storeState.projects = [];
    storeState.areas = [];
    updateTask.mockClear();
    deleteTask.mockClear();
    addProject.mockClear();
    addTask.mockClear();
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    openAnchorEditor(root);
    const titleInput = root.findByProps({ placeholder: 'taskEdit.titleLabel', accessibilityLabel: 'taskEdit.titleLabel' });
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
    await flushAsyncActions();
    expect(onClose).toHaveBeenCalled();
  });

  // #1088: mobile clarify never parsed the title at all, so even the date
  // commands desktop already understood were literal text here.
  it('applies quick-add tokens typed into the clarify title', async () => {
    storeState.tasks = [{ ...baseInboxTask, contexts: [], tags: [] }];
    storeState.projects = [workProject];
    storeState.areas = [workArea, homeArea];
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
    });

    const root = tree!.root;
    const titleInput = root.findByProps({ placeholder: 'taskEdit.titleLabel', accessibilityLabel: 'taskEdit.titleLabel' });
    act(() => {
      titleInput.props.onChangeText('Call Alice @phone #urgent !Home /due:2026-09-01');
    });

    walkToFileStep(root);
    pressStep(root, 'File it');
    await flushAsyncActions();

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        status: 'next',
        title: 'Call Alice',
        contexts: ['@phone'],
        tags: ['#urgent'],
        areaId: homeArea.id,
      })
    );
    expect(updateTask.mock.calls[0][1].dueDate).toContain('2026-09-01');
  });

  // #1089: incubating parks the item without deciding what it is, and brings it
  // back to this pass on a date. Someday + a review date, which Daily and
  // Weekly Review already read as "due to reconsider".
  it('incubates a capture as Someday with the return date', async () => {
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
    });

    const root = tree!.root;
    act(() => {
      findPressableWithText(root, 'Incubate').props.onPress();
    });

    act(() => {
      root.findByProps({ children: 'common.notSet' }).parent!.props.onPress();
    });
    act(() => {
      root.findByType('DateTimePicker' as any).props.onChange({ type: 'set' }, new Date(2026, 8, 10, 12, 0, 0));
    });

    pressStep(root, 'File it');
    await flushAsyncActions();

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        status: 'someday',
        reviewAt: '2026-09-10',
      })
    );
  });

  it('brings a due incubated item back into the pass and says where it came from', () => {
    storeState.tasks = [{
      ...baseInboxTask,
      id: 'incubated-1',
      title: "Mom's birthday",
      status: 'someday',
      reviewAt: '2026-01-01',
    }];
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
    });

    const root = tree!.root;
    expect(findNodesWithText(root, 'Back to clarify').length).toBeGreaterThan(0);
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

    revealDeferredOptions(root);

    expect(root.findAllByProps({ placeholder: 'inbox.addContextPlaceholder' })).toHaveLength(0);
  });

  it('preselects the task area and filters project choices by it', () => {
    storeState.tasks = [{ ...baseInboxTask, areaId: workArea.id }];
    storeState.areas = [workArea, homeArea];
    storeState.projects = [workProject, homeProject];
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    revealDeferredOptions(root);

    // The area assigned while the task sat in the inbox starts selected, so the
    // project picker opens filtered to it (and apply keeps the area).
    expect(findNodesWithText(root, 'taskEdit.areaLabel').length).toBeGreaterThan(0);
    expect(findNodesWithText(root, 'Work Project').length).toBeGreaterThan(0);
    expect(findNodesWithText(root, 'Home Project')).toHaveLength(0);

    act(() => {
      findPressableWithText(root, 'projects.noArea').props.onPress();
    });

    expect(findNodesWithText(root, 'Work Project').length).toBeGreaterThan(0);
    expect(findNodesWithText(root, 'Home Project').length).toBeGreaterThan(0);
  });

  it('searches projects outside the selected area while the browse list stays scoped (#987)', () => {
    storeState.tasks = [{ ...baseInboxTask, areaId: workArea.id }];
    storeState.areas = [workArea, homeArea];
    storeState.projects = [workProject, homeProject];
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
    });

    const root = tree!.root;

    revealDeferredOptions(root);

    expect(findNodesWithText(root, 'Home Project')).toHaveLength(0);

    const projectSearch = root.findByProps({ placeholder: 'projects.addPlaceholder' });

    act(() => {
      projectSearch.props.onChangeText('Home');
    });

    expect(findNodesWithText(root, 'Home Project').length).toBeGreaterThan(0);
    // An existing title anywhere suppresses the create offer, not just in-area ones.
    act(() => {
      root.findByProps({ placeholder: 'projects.addPlaceholder' }).props.onChangeText('Home Project');
    });
    expect(findNodesWithText(root, 'projects.create')).toHaveLength(0);

    act(() => {
      root.findByProps({ placeholder: 'projects.addPlaceholder' }).props.onChangeText('');
    });

    expect(findNodesWithText(root, 'Home Project')).toHaveLength(0);
    expect(findNodesWithText(root, 'Work Project').length).toBeGreaterThan(0);
  });

  it('respects the global area filter when building the processing queue', async () => {
    mockSettings.filters = { areaId: workArea.id };
    storeState.areas = [workArea, homeArea];
    storeState.projects = [workProject, homeProject];
    storeState.tasks = [
      {
        ...baseInboxTask,
        id: 'home-inbox',
        title: 'Home inbox',
        projectId: homeProject.id,
        contexts: [],
        tags: [],
      },
      {
        ...baseInboxTask,
        id: 'work-inbox',
        title: 'Work inbox',
        projectId: workProject.id,
        contexts: [],
        tags: [],
      },
    ];
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    openAnchorEditor(root);
    expect(root.findByProps({ placeholder: 'taskEdit.titleLabel', accessibilityLabel: 'taskEdit.titleLabel' }).props.value).toBe('Work inbox');

    const skipLabel = root.findByProps({ children: 'Skip' });
    const skipButton = skipLabel.parent;

    if (!skipButton) {
      throw new Error('Skip button not found');
    }

    act(() => {
      skipButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'work-inbox',
      expect.objectContaining({
        title: 'Work inbox',
      }),
    );
    await flushAsyncActions();
    expect(onClose).toHaveBeenCalled();
  });

  it('creates inbox processing projects in the selected area', async () => {
    storeState.areas = [workArea, homeArea];
    storeState.projects = [workProject, homeProject];
    addProject.mockResolvedValueOnce({
      id: 'project-created',
      title: 'Created Project',
      color: '#3b82f6',
      status: 'active',
      order: 2,
      tagIds: [],
      areaId: workArea.id,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    revealDeferredOptions(root);
    const projectInput = root.findByProps({ placeholder: 'projects.addPlaceholder' });

    act(() => {
      findPressableWithText(root, 'Work').props.onPress();
      projectInput.props.onChangeText('Created Project');
    });

    await act(async () => {
      findPressableWithText(root, 'projects.create').props.onPress();
    });

    expect(addProject).toHaveBeenCalledWith(
      'Created Project',
      '#3b82f6',
      { areaId: workArea.id },
    );
  });

  it('converts an inbox item into a project next action on mobile', async () => {
    storeState.areas = [workArea, homeArea];
    storeState.projects = [];
    addProject.mockResolvedValueOnce({
      id: 'project-created',
      title: 'Plan Launch',
      color: '#3b82f6',
      status: 'active',
      order: 0,
      tagIds: [],
      areaId: workArea.id,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    walkToProjectConversion(root);

    expect(findTextInputsByAccessibilityLabel(root, 'projects.projectName')).toHaveLength(1);
    expect(findTextInputsByAccessibilityLabel(root, 'taskEdit.titleLabel')).toHaveLength(0);

    pressStep(root, '‹ Back');
    expect(findTextInputsByAccessibilityLabel(root, 'projects.projectName')).toHaveLength(0);
    expect(findTextInputsByAccessibilityLabel(root, 'taskEdit.titleLabel')).toHaveLength(1);
    pressStep(root, 'process.moreThanOneStepYes');

    const projectTitleInput = findTextInputByAccessibilityLabel(root, 'projects.projectName');
    const nextActionInput = root.findByProps({ accessibilityLabel: 'process.nextAction' });

    act(() => {
      findPressableWithText(root, 'Work').props.onPress();
      projectTitleInput.props.onChangeText('Plan Launch');
      nextActionInput.props.onChangeText('Draft launch brief');
    });

    await act(async () => {
      findPressableWithText(root, 'process.createProject').props.onPress();
    });

    expect(addProject).toHaveBeenCalledWith(
      'Plan Launch',
      '#3b82f6',
      { areaId: workArea.id },
    );
    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        title: 'Draft launch brief',
        status: 'next',
        projectId: 'project-created',
        areaId: undefined,
        contexts: ['@home'],
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('chains a fresh action input from keyboard submit instead of converting (#827)', () => {
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    walkToProjectConversion(root);

    const findActionInputs = () => root.findAll((node) => (
      typeof node.type === 'string'
      && node.props.accessibilityLabel === 'process.nextAction'
      && typeof node.props.onChangeText === 'function'
    ));

    act(() => {
      findActionInputs()[0].props.onChangeText('Draft launch brief');
    });
    act(() => {
      findActionInputs()[0].props.onSubmitEditing();
    });
    expect(findActionInputs()).toHaveLength(2);
    expect(findActionInputs()[0].props.blurOnSubmit).toBe(false);

    act(() => {
      findActionInputs()[1].props.onChangeText('Book venue');
    });
    act(() => {
      findActionInputs()[1].props.onSubmitEditing();
    });
    expect(findActionInputs()).toHaveLength(3);

    // Submit on an empty trailing row must not add another.
    act(() => {
      findActionInputs()[2].props.onSubmitEditing();
    });
    expect(findActionInputs()).toHaveLength(3);

    expect(addProject).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('creates extra next actions in the new project when added at the split step (#827)', async () => {
    addProject.mockResolvedValueOnce({
      id: 'project-created',
      title: 'Plan Launch',
      color: '#3b82f6',
      status: 'active',
      order: 0,
      tagIds: [],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    walkToProjectConversion(root);
    act(() => {
      findTextInputByAccessibilityLabel(root, 'projects.projectName').props.onChangeText('Plan Launch');
    });
    act(() => {
      findPressableWithText(root, 'process.addAnotherAction').props.onPress();
    });
    act(() => {
      findPressableWithText(root, 'process.addAnotherAction').props.onPress();
    });

    const findActionInputs = () => root.findAll((node) => (
      typeof node.type === 'string'
      && node.props.accessibilityLabel === 'process.nextAction'
      && typeof node.props.onChangeText === 'function'
    ));
    expect(findActionInputs()).toHaveLength(3);
    act(() => {
      findActionInputs()[0].props.onChangeText('Draft launch brief');
    });
    act(() => {
      findActionInputs()[1].props.onChangeText('Book venue');
    });
    act(() => {
      findActionInputs()[2].props.onChangeText('   ');
    });

    await act(async () => {
      findPressableWithText(root, 'process.createProject').props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        title: 'Draft launch brief',
        status: 'next',
        projectId: 'project-created',
      })
    );
    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith('Book venue', {
      status: 'inbox',
      projectId: 'project-created',
    });
    expect(addTask.mock.invocationCallOrder[0]).toBeLessThan(updateTask.mock.invocationCallOrder[0]);
  });

  it('retries only uncommitted project actions before moving the original Inbox task', async () => {
    addProject.mockResolvedValue({
      id: 'project-created',
      title: 'Plan Launch',
      color: '#3b82f6',
      status: 'active',
      order: 0,
      tagIds: [],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    addTask
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'Offline' })
      .mockResolvedValueOnce({ success: true });
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    walkToProjectConversion(root);
    act(() => {
      findTextInputByAccessibilityLabel(root, 'projects.projectName').props.onChangeText('Plan Launch');
      findPressableWithText(root, 'process.addAnotherAction').props.onPress();
    });
    act(() => {
      findPressableWithText(root, 'process.addAnotherAction').props.onPress();
    });

    const findActionInputs = () => root.findAll((node) => (
      typeof node.type === 'string'
      && node.props.accessibilityLabel === 'process.nextAction'
      && typeof node.props.onChangeText === 'function'
    ));
    act(() => {
      findActionInputs()[0].props.onChangeText('Draft launch brief');
    });
    act(() => {
      findActionInputs()[1].props.onChangeText('Book venue');
    });
    act(() => {
      findActionInputs()[2].props.onChangeText('Send invitations');
    });

    await act(async () => {
      findPressableWithText(root, 'process.createProject').props.onPress();
      await Promise.resolve();
    });

    expect(addTask.mock.calls.map(([title]) => title)).toEqual(['Book venue', 'Send invitations']);
    expect(updateTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(findActionInputs().map((input) => input.props.value)).toEqual([
      'Draft launch brief',
      'Send invitations',
    ]);

    await act(async () => {
      findPressableWithText(root, 'process.createProject').props.onPress();
      await Promise.resolve();
    });

    expect(addTask.mock.calls.map(([title]) => title)).toEqual([
      'Book venue',
      'Send invitations',
      'Send invitations',
    ]);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith('inbox-1', expect.objectContaining({
      title: 'Draft launch brief',
      status: 'next',
      projectId: 'project-created',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
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
    revealDeferredOptions(root);
    const tokenInput = root.findByProps({ placeholder: '@home' });

    act(() => {
      tokenInput.props.onChangeText('off');
    });

    const contextSuggestion = findNodeWithText(root, '@office');
    expect(contextSuggestion).toBeTruthy();
    expect(typeof contextSuggestion.parent?.props.onPress).toBe('function');

    const updatedTokenInput = root.findByProps({ placeholder: '@home' });
    act(() => {
      updatedTokenInput.props.onChangeText('urg');
    });

    expect(findNodeWithText(root, '#urgent')).toBeTruthy();
  });

  it('suggests existing assignees in the assigned-to field', () => {
    mockSettings.gtd.taskEditor = { hidden: [] };
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
    revealDeferredOptions(root);
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

  it('opens on the first question with the item anchored and the editor closed', () => {
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    expect(findNodesWithText(root, 'inbox.isActionable').length).toBeGreaterThan(0);
    // The title is editable in place from the first step; the note is one tap away.
    expect(root.findByProps({ placeholder: 'taskEdit.titleLabel', accessibilityLabel: 'taskEdit.titleLabel' }).props.value)
      .toBe('Inbox task');
    expect(findNodesWithText(root, 'Original description').length).toBeGreaterThan(0);
    expect(root.findAllByProps({ placeholder: 'taskEdit.descriptionPlaceholder' })).toHaveLength(0);
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

    expect(root.findByProps({ placeholder: 'taskEdit.titleLabel', accessibilityLabel: 'taskEdit.titleLabel' }).props.value)
      .toBe('Inbox task');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves Later items to next with a date-only start date', async () => {
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const laterButton = findPressableWithText(root, 'Start later');

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

    const nextTaskLabel = findNodeWithText(root, 'File it');
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
    await flushAsyncActions();
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
    const laterButton = findPressableWithText(root, 'Start later');

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

    const nextTaskButton = findNodeWithText(root, 'File it').parent;

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
    const laterButton = findPressableWithText(root, 'Start later');

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

    const nextTaskButton = findNodeWithText(root, 'File it').parent;

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

  it('requires a start date before filing a Later item', async () => {
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const laterButton = findPressableWithText(root, 'Start later');

    if (!laterButton) {
      throw new Error('Later button not found');
    }

    act(() => {
      laterButton.props.onPress();
    });

    expect(findNodesWithText(root, 'No date')).toHaveLength(0);

    const nextTaskButton = findNodeWithText(root, 'File it').parent;

    if (!nextTaskButton) {
      throw new Error('Next task button not found');
    }

    act(() => {
      nextTaskButton.props.onPress();
    });

    await flushAsyncActions();
    expect(updateTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(showToast.mock.calls.some(([options]) => options?.tone === 'warning')).toBe(true);
  });

  it('keeps the current inbox item active when Later has no date', async () => {
    storeState.tasks = [
      { ...baseInboxTask },
      {
        ...baseInboxTask,
        id: 'inbox-2',
        title: 'Second inbox task',
        description: 'Second description',
        contexts: [],
        tags: [],
      },
    ];
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const laterButton = findPressableWithText(root, 'Start later');

    if (!laterButton) {
      throw new Error('Later button not found');
    }

    act(() => {
      laterButton.props.onPress();
    });

    const nextTaskButton = findNodeWithText(root, 'File it').parent;

    if (!nextTaskButton) {
      throw new Error('Next task button not found');
    }

    act(() => {
      nextTaskButton.props.onPress();
    });

    await flushAsyncActions();
    expect(updateTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(root.findByProps({ placeholder: 'taskEdit.titleLabel', accessibilityLabel: 'taskEdit.titleLabel' }).props.value)
      .toBe('Inbox task');
    expect(showToast.mock.calls.some(([options]) => options?.tone === 'warning')).toBe(true);
  });

  it('saves the selected priority when the priority field is shown', async () => {
    mockSettings.gtd.taskEditor = { hidden: [] };
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    revealDeferredOptions(root);
    const priorityLabel = root.findByProps({ children: 'priority.high' });
    const priorityButton = priorityLabel.parent;

    if (!priorityButton) {
      throw new Error('Priority button not found');
    }

    // The chip carries the canonical decorative flag beside its label.
    expect(priorityButton.findByProps({ testID: 'priority-flag-high' }).props.color).toBe('#f97316');
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
    await flushAsyncActions();
    expect(onClose).toHaveBeenCalled();
  });

  it('saves energy level and time estimate during inbox processing', async () => {
    mockSettings.gtd.taskEditor = { hidden: [] };
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    revealDeferredOptions(root);
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
    await flushAsyncActions();
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

    revealDeferredOptions(root);

    expect(root.findAllByProps({ children: 'taskEdit.energyLevel' })).toHaveLength(0);
    expect(root.findAllByProps({ children: 'taskEdit.timeEstimateLabel' })).toHaveLength(0);
    expect(root.findAllByProps({ children: 'energyLevel.high' })).toHaveLength(0);
    expect(root.findAllByProps({ children: '30m' })).toHaveLength(0);
  });

  it('moves delegated tasks to waiting with assignedTo and keeps the description clean', async () => {
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
    chooseActionableLonger(root);
    const delegateButton = findPressableWithText(root, 'inbox.delegate');

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

    const nextTaskLabel = findNodeWithText(root, 'File it');
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
    await flushAsyncActions();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the selected priority when delegating a task', async () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = {};
    mockSettings.gtd.taskEditor = { hidden: [] };
    storeState.projects = [];
    storeState.areas = [];
    updateTask.mockClear();
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    chooseActionableLonger(root);
    pressStep(root, 'inbox.delegate');
    expandMoreOptions(root);
    const priorityLabel = root.findByProps({ children: 'priority.high' });
    const priorityButton = priorityLabel.parent;

    if (!priorityButton) {
      throw new Error('Priority button not found');
    }

    act(() => {
      priorityButton.props.onPress();
    });

    const whoInput = root.findByProps({ placeholder: 'process.delegateWhoPlaceholder' });

    act(() => {
      whoInput.props.onChangeText('Alex');
    });

    const nextTaskLabel = findNodeWithText(root, 'File it');
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
    await flushAsyncActions();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the selected priority when delegating a task', async () => {
    mockSettings.features = undefined;
    mockSettings.gtd.inboxProcessing = {};
    mockSettings.gtd.taskEditor = { hidden: [] };
    storeState.projects = [];
    storeState.areas = [];
    updateTask.mockClear();
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    chooseActionableLonger(root);
    pressStep(root, 'inbox.delegate');
    expandMoreOptions(root);
    const priorityLabel = root.findByProps({ children: 'priority.urgent' });
    const priorityButton = priorityLabel.parent;

    if (!priorityButton) {
      throw new Error('Priority button not found');
    }

    act(() => {
      priorityButton.props.onPress();
    });

    const whoInput = root.findByProps({ placeholder: 'process.delegateWhoPlaceholder' });

    act(() => {
      whoInput.props.onChangeText('Alex');
    });

    const nextTaskLabel = findNodeWithText(root, 'File it');
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
    await flushAsyncActions();
    expect(onClose).toHaveBeenCalled();
  });

  it('allows delegation without an optional assignee name', async () => {
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
    chooseActionableLonger(root);
    const delegateButton = findPressableWithText(root, 'inbox.delegate');

    if (!delegateButton) {
      throw new Error('Delegate button not found');
    }

    act(() => {
      delegateButton.props.onPress();
    });

    const nextTaskLabel = findNodeWithText(root, 'File it');
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
        assignedTo: undefined,
      })
    );
    await flushAsyncActions();
    expect(onClose).toHaveBeenCalled();
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
    openAnchorEditor(root);
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

  describe('terminal decisions', () => {
    const openFlow = async () => {
      let tree: ReturnType<typeof create>;
      act(() => {
        tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
      });
      await flushAsyncActions();
      return tree!.root;
    };

    const pressAsync = async (root: ReturnType<typeof create>['root'], text: string) => {
      await act(async () => {
        findPressableWithText(root, text).props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    const undoToast = () => showToast.mock.calls
      .map(([options]) => options)
      .find((options) => options?.actionLabel === 'Undo');

    it.each([
      ['guided', null],
      ['quick', 'quick'],
    ] as const)('offers Area and Someday-project controls before filing in %s mode', async (_mode, storedMode) => {
      asyncStorageMock.getItem.mockResolvedValue(storedMode);
      storeState.areas = [workArea];
      storeState.projects = [{ ...workProject, status: 'someday' }];
      const root = await openFlow();

      await pressAsync(root, 'inbox.someday');

      expect(updateTask).not.toHaveBeenCalled();
      expect(findNodesWithText(root, 'taskEdit.areaLabel').length).toBeGreaterThan(0);
      expect(findNodesWithText(root, 'Work Project').length).toBeGreaterThan(0);
      await pressAsync(root, 'Work Project');
      await act(async () => {
        findPressableWithText(root, 'File it').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(updateTask.mock.calls[0][1]).toMatchObject({
        status: 'someday',
        projectId: workProject.id,
      });
      expect(undoToast()?.message).toBe('Inbox task moved to someday');
    });

    it.each([
      ['guided', null],
      ['quick', 'quick'],
    ] as const)('offers Area and Someday-project controls before incubating in %s mode', async (_mode, storedMode) => {
      asyncStorageMock.getItem.mockResolvedValue(storedMode);
      storeState.areas = [workArea];
      storeState.projects = [{ ...workProject, status: 'someday' }];
      const root = await openFlow();

      await pressAsync(root, 'Incubate');

      expect(updateTask).not.toHaveBeenCalled();
      expect(findNodesWithText(root, 'taskEdit.areaLabel').length).toBeGreaterThan(0);
      expect(findNodesWithText(root, 'Work Project').length).toBeGreaterThan(0);
      await pressAsync(root, 'Work Project');
      await act(async () => {
        root.findByProps({ children: 'common.notSet' }).parent!.props.onPress();
        await Promise.resolve();
      });
      await act(async () => {
        root.findByType('DateTimePicker' as any).props.onChange(
          { type: 'set' },
          new Date(2026, 8, 10, 12, 0, 0),
        );
        await Promise.resolve();
      });
      await pressAsync(root, 'File it');

      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(updateTask.mock.calls[0][1]).toMatchObject({
        status: 'someday',
        projectId: workProject.id,
      });
    });

    it.each([
      ['guided', null],
      ['quick', 'quick'],
    ] as const)('still offers Someday-section assignment when organization fields are hidden in %s mode', async (_mode, storedMode) => {
      asyncStorageMock.getItem.mockResolvedValue(storedMode);
      mockSettings.gtd.taskEditor = { hidden: ['area', 'project'] };
      const root = await openFlow();

      await pressAsync(root, 'inbox.someday');

      expect(updateTask).not.toHaveBeenCalled();
      expect(findNodesWithText(root, '+ New section…').length).toBeGreaterThan(0);
      await pressAsync(root, 'File it');
      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(updateTask.mock.calls[0][1]).toMatchObject({ status: 'someday' });
    });

    it('creates and assigns a Someday section without leaving Inbox Processing', async () => {
      const root = await openFlow();

      await pressAsync(root, 'inbox.someday');
      await pressAsync(root, '+ New section…');
      act(() => {
        root.findByProps({ accessibilityLabel: 'Section name' }).props.onChangeText('Career ideas');
      });
      await act(async () => {
        root.findByProps({ accessibilityLabel: 'common.save' }).props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(storeState.updateSettings).toHaveBeenCalledTimes(1);
      const created = storeState.updateSettings.mock.calls[0][0].gtd.viewSections.someday[0];
      expect(created).toMatchObject({ title: 'Career ideas', order: 0 });

      await pressAsync(root, 'File it');
      expect(updateTask.mock.calls[0][1]).toMatchObject({
        status: 'someday',
        viewSectionIds: { someday: created.id },
      });
    });

    it('files Reference straight from the first question', async () => {
      const root = await openFlow();

      await pressAsync(root, 'nav.reference');

      expect(updateTask.mock.calls[0][1]).toMatchObject({ status: 'reference' });
    });

    it('restores metadata cleared by Reference when the decision is undone', async () => {
      const recurrence = { rule: 'monthly', strategy: 'strict', byMonthDay: [15] };
      storeState.tasks = [{
        ...baseInboxTask,
        startTime: '2026-09-14',
        dueDate: '2026-09-15',
        reviewAt: '2026-09-16',
        recurrence,
        priority: 'high',
        timeEstimate: '30min',
      }];
      const root = await openFlow();

      await pressAsync(root, 'nav.reference');
      const toast = undoToast();
      await act(async () => {
        toast!.onAction();
        await Promise.resolve();
      });

      expect(updateTask).toHaveBeenLastCalledWith('inbox-1', expect.objectContaining({
        status: 'inbox',
        startTime: '2026-09-14',
        dueDate: '2026-09-15',
        reviewAt: '2026-09-16',
        recurrence,
        priority: 'high',
        timeEstimate: '30min',
      }));
    });

    it('trashes from the first question and offers to put it back', async () => {
      const root = await openFlow();

      await pressAsync(root, 'inbox.trash');

      expect(deleteTask).toHaveBeenCalledWith('inbox-1');
      const toast = undoToast();
      expect(toast?.message).toBe('Inbox task moved to Trash');

      await act(async () => {
        toast!.onAction();
        await Promise.resolve();
      });

      expect(restoreTask).toHaveBeenCalledWith('inbox-1');
    });

    it('completes a two-minute item from the second question', async () => {
      const root = await openFlow();

      pressStep(root, 'inbox.yes');
      await pressAsync(root, 'inbox.doneIt');

      expect(updateTask.mock.calls[0][1]).toMatchObject({ status: 'done' });
    });

    it('restores a filed item to the Inbox from its Undo toast', async () => {
      const root = await openFlow();

      pressStep(root, 'inbox.someday');
      await pressAsync(root, 'File it');
      const toast = undoToast();

      await act(async () => {
        toast!.onAction();
        await Promise.resolve();
      });

      expect(updateTask).toHaveBeenLastCalledWith('inbox-1', expect.objectContaining({ status: 'inbox' }));
    });

    it('binds each queued Undo toast to the decision that created it', async () => {
      asyncStorageMock.getItem.mockResolvedValue('quick');
      storeState.tasks = [
        { ...baseInboxTask, id: 'inbox-a', title: 'First capture' },
        { ...baseInboxTask, id: 'inbox-b', title: 'Second capture', createdAt: '2025-01-02T00:00:00.000Z' },
      ];
      const root = await openFlow();

      await pressAsync(root, 'inbox.someday');
      await pressAsync(root, 'File it');
      const firstUndo = showToast.mock.calls
        .map(([options]) => options)
        .find((options) => options?.actionLabel === 'Undo' && options.message.includes('First capture'));

      await pressAsync(root, 'inbox.someday');
      await pressAsync(root, 'File it');
      expect(showToast.mock.calls.some(([options]) => (
        options?.actionLabel === 'Undo' && options.message.includes('Second capture')
      ))).toBe(true);

      await act(async () => {
        firstUndo!.onAction();
        await Promise.resolve();
      });

      expect(updateTask).toHaveBeenLastCalledWith(
        'inbox-a',
        expect.objectContaining({ status: 'inbox' }),
      );
      expect(updateTask).not.toHaveBeenCalledWith(
        'inbox-b',
        expect.objectContaining({ status: 'inbox' }),
      );
    });

    it('uses recurrence-aware completion undo for a recurring two-minute item', async () => {
      const recurringTask = {
        ...baseInboxTask,
        isFocusedToday: true,
        recurrence: { rule: 'daily', strategy: 'strict' },
      };
      storeState.tasks = [recurringTask];
      const root = await openFlow();

      pressStep(root, 'inbox.yes');
      await pressAsync(root, 'inbox.doneIt');
      const toast = undoToast();
      await act(async () => {
        toast!.onAction();
        await Promise.resolve();
      });

      expect(undoTaskCompletion).toHaveBeenCalledWith(
        'inbox-1',
        'inbox',
        true,
        expect.objectContaining({
          restoreUpdates: expect.objectContaining({
            status: 'inbox',
            recurrence: recurringTask.recurrence,
          }),
        }),
      );
    });

    it('marks completing an item with the app\'s success haptic', async () => {
      const root = await openFlow();

      expect(hapticsMock.notificationAsync).not.toHaveBeenCalled();

      pressStep(root, 'inbox.someday');
      await pressAsync(root, 'File it');

      expect(hapticsMock.notificationAsync).toHaveBeenCalledTimes(1);
      expect(hapticsMock.notificationAsync).toHaveBeenCalledWith('success');
    });

    it('does not buzz or offer Undo when the write fails', async () => {
      updateTask.mockResolvedValue({ success: false, error: 'nope' });
      const root = await openFlow();

      pressStep(root, 'inbox.someday');
      await pressAsync(root, 'File it');

      expect(hapticsMock.notificationAsync).not.toHaveBeenCalled();
      expect(undoToast()).toBeUndefined();
      expect(showToast.mock.calls.some(([options]) => options?.tone === 'error')).toBe(true);
    });

    it('transitions each answered question forward within the motion budget', async () => {
      const timing = vi.spyOn(Animated, 'timing');
      try {
        const root = await openFlow();
        timing.mockClear();

        pressStep(root, 'inbox.yes');

        expect(timing).toHaveBeenCalled();
        for (const [, config] of timing.mock.calls) {
          expect((config as any).duration).toBeGreaterThanOrEqual(150);
          expect((config as any).duration).toBeLessThanOrEqual(250);
        }
      } finally {
        timing.mockRestore();
      }
    });

    it('lands each step flat instead of animating when reduce motion is on', async () => {
      reducedMotionMock.value = true;
      const timing = vi.spyOn(Animated, 'timing');
      try {
        const root = await openFlow();
        timing.mockClear();

        pressStep(root, 'inbox.yes');

        expect(findNodesWithText(root, 'inbox.twoMinRule').length).toBeGreaterThan(0);
        expect(timing).not.toHaveBeenCalled();
      } finally {
        timing.mockRestore();
      }
    });
  });
  describe('guided and quick modes', () => {
    const openFlow = async () => {
      let tree: ReturnType<typeof create>;
      act(() => {
        tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
      });
      await flushAsyncActions();
      return tree!.root;
    };

    const pressAsync = async (root: ReturnType<typeof create>['root'], text: string) => {
      await act(async () => {
        findPressableWithText(root, text).props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    // Carries a project and metadata so a comparison is sensitive to the fields
    // each mode passes along, not just to the status.
    const carriedTask = () => ({
      ...baseInboxTask,
      projectId: workProject.id,
      priority: 'high',
      energyLevel: 'low',
      assignedTo: 'Sam',
    });

    it('remembers the mode on this device only', async () => {
      const root = await openFlow();

      expect(asyncStorageMock.getItem).toHaveBeenCalledWith('mindwtr:view:inboxProcessingMode:v1');
      expect(findNodesWithText(root, 'inbox.isActionable').length).toBeGreaterThan(0);

      act(() => {
        root.findByProps({ accessibilityLabel: 'Quick', accessibilityRole: 'button' }).props.onPress();
      });

      expect(asyncStorageMock.setItem).toHaveBeenCalledWith('mindwtr:view:inboxProcessingMode:v1', 'quick');
      expect(findNodesWithText(root, 'inbox.isActionable')).toHaveLength(0);
      expect(findNodesWithText(root, 'inbox.illDoIt').length).toBeGreaterThan(0);
      // The synced GTD settings document is never touched by a layout choice.
      expect(storeState.updateSettings).not.toHaveBeenCalled();
      const guidedAction = root.findByProps({ accessibilityLabel: 'Guided', accessibilityRole: 'button' });
      expect(guidedAction).toBeTruthy();
      expect(guidedAction.props.accessibilityState).toBeUndefined();
    });

    it('walks the guided tree by default', async () => {
      const root = await openFlow();

      expect(findNodesWithText(root, 'inbox.isActionable').length).toBeGreaterThan(0);
      expect(findNodesWithText(root, 'inbox.delegate')).toHaveLength(0);
    });

    it('shows every destination on one screen in quick mode', async () => {
      asyncStorageMock.getItem.mockResolvedValue('quick');
      const root = await openFlow();

      expect(findNodesWithText(root, 'inbox.isActionable')).toHaveLength(0);
      for (const label of ['inbox.illDoIt', 'taskEdit.projectLabel', 'Start later', 'inbox.delegate', 'inbox.someday', 'nav.reference', 'inbox.trash']) {
        expect(findNodesWithText(root, label).length).toBeGreaterThan(0);
      }
    });

    it('files a next action identically in both modes', async () => {
      mockSettings.gtd.taskEditor = { hidden: [] };
      storeState.projects = [workProject];
      storeState.areas = [workArea];
      storeState.tasks = [carriedTask()];

      const guided = await openFlow();
      chooseActionableLonger(guided);
      await pressAsync(guided, 'inbox.illDoIt');
      await pressAsync(guided, 'process.moreThanOneStepNo');
      await pressAsync(guided, 'File it');

      expect(updateTask).toHaveBeenCalledTimes(1);
      const guidedCall = updateTask.mock.calls[0];
      expect(guidedCall[1]).toMatchObject({ status: 'next', projectId: workProject.id, priority: 'high' });

      updateTask.mockClear();
      asyncStorageMock.getItem.mockResolvedValue('quick');
      storeState.tasks = [carriedTask()];

      const quick = await openFlow();
      await pressAsync(quick, 'inbox.illDoIt');

      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(updateTask.mock.calls[0]).toEqual(guidedCall);
    });

    it('trashes identically in both modes', async () => {
      const guided = await openFlow();
      await pressAsync(guided, 'inbox.trash');

      expect(deleteTask).toHaveBeenCalledTimes(1);
      const guidedCall = deleteTask.mock.calls[0];

      deleteTask.mockClear();
      asyncStorageMock.getItem.mockResolvedValue('quick');
      storeState.tasks = [{ ...baseInboxTask }];

      const quick = await openFlow();
      await pressAsync(quick, 'inbox.trash');

      expect(deleteTask.mock.calls[0]).toEqual(guidedCall);
    });

    it('lands quick decisions on only that decision\'s follow-up', async () => {
      asyncStorageMock.getItem.mockResolvedValue('quick');
      const root = await openFlow();

      pressStep(root, 'inbox.delegate');

      // Straight to the waiting details — no two-minute or one-action question.
      expect(root.findByProps({ placeholder: 'process.delegateWhoPlaceholder' })).toBeTruthy();
      expect(findNodesWithText(root, 'inbox.twoMinRule')).toHaveLength(0);
      expect(findNodesWithText(root, 'process.moreThanOneStep')).toHaveLength(0);
      expect(updateTask).not.toHaveBeenCalled();

      pressStep(root, '‹ Back');

      expect(findNodesWithText(root, 'inbox.illDoIt').length).toBeGreaterThan(0);
    });

    it('files Waiting identically in both modes', async () => {
      const guided = await openFlow();
      chooseActionableLonger(guided);
      pressStep(guided, 'inbox.delegate');
      act(() => {
        guided.findByProps({ placeholder: 'process.delegateWhoPlaceholder' }).props.onChangeText('Alex');
      });
      await pressAsync(guided, 'File it');

      expect(updateTask).toHaveBeenCalledTimes(1);
      const guidedCall = updateTask.mock.calls[0];
      expect(guidedCall[1]).toMatchObject({ status: 'waiting', assignedTo: 'Alex' });

      updateTask.mockClear();
      asyncStorageMock.getItem.mockResolvedValue('quick');
      storeState.tasks = [{ ...baseInboxTask }];

      const quick = await openFlow();
      pressStep(quick, 'inbox.delegate');
      act(() => {
        quick.findByProps({ placeholder: 'process.delegateWhoPlaceholder' }).props.onChangeText('Alex');
      });
      await pressAsync(quick, 'File it');

      expect(updateTask.mock.calls[0]).toEqual(guidedCall);
    });

    it('skips the two-minute question when that shortcut is off', async () => {
      mockSettings.gtd.inboxProcessing = { twoMinuteEnabled: false };
      const root = await openFlow();

      pressStep(root, 'inbox.yes');

      expect(findNodesWithText(root, 'inbox.twoMinRule')).toHaveLength(0);
      expect(findNodesWithText(root, 'inbox.whoShouldDoIt').length).toBeGreaterThan(0);
    });

    it('starts with the two-minute question when the shared plan puts it first', async () => {
      mockSettings.gtd.inboxProcessing = { twoMinuteFirst: true };
      const root = await openFlow();

      expect(findNodesWithText(root, 'inbox.twoMinRule').length).toBeGreaterThan(0);
      expect(findNodesWithText(root, 'inbox.isActionable')).toHaveLength(0);

      pressStep(root, 'inbox.takesLonger');

      expect(findNodesWithText(root, 'inbox.isActionable').length).toBeGreaterThan(0);
      expect(findNodesWithText(root, 'inbox.twoMinRule')).toHaveLength(0);
    });

    it('drops the context step from the terminal step when it is off', async () => {
      mockSettings.gtd.inboxProcessing = { contextStepEnabled: false };
      const root = await openFlow();
      walkToFileStep(root);

      expect(root.findAllByProps({ placeholder: '@home' })).toHaveLength(0);
      expect(findNodesWithText(root, 'inbox.assignProjectQuestion').length).toBeGreaterThan(0);
    });

    it('keeps date fields out of More options until scheduling is enabled', async () => {
      const root = await openFlow();
      walkToFileStep(root);
      expandMoreOptions(root);

      expect(findNodesWithText(root, 'taskEdit.scheduling')).toHaveLength(0);
    });

    it('orders the terminal step by the project-first preference', async () => {
      mockSettings.gtd.inboxProcessing = { projectFirst: true };
      storeState.projects = [workProject];
      storeState.areas = [workArea];
      const projectFirstRoot = await openFlow();
      walkToFileStep(projectFirstRoot);

      const orderOf = (root: ReturnType<typeof create>['root']) => {
        const rendered = root.findAll((node) => (
          ((node.type as unknown) === 'Text' && node.props?.children === 'inbox.assignProjectQuestion')
          || ((node.type as unknown) === 'TextInput' && node.props?.placeholder === '@home')
        ));
        return rendered.map((node) => (node.props?.placeholder === '@home' ? 'context' : 'project'));
      };

      expect(orderOf(projectFirstRoot)).toEqual(['project', 'context']);

      mockSettings.gtd.inboxProcessing = {};
      storeState.tasks = [{ ...baseInboxTask }];
      const contextFirstRoot = await openFlow();
      walkToFileStep(contextFirstRoot);

      expect(orderOf(contextFirstRoot)).toEqual(['context', 'project']);
    });
  });
  // Capability parity: presentation changed, capability did not. Each of these
  // existed in the one-scroll form and must stay reachable in BOTH modes.
  describe('capability parity with the old flow', () => {
    const openMode = async (mode: 'guided' | 'quick') => {
      asyncStorageMock.getItem.mockResolvedValue(mode);
      let tree: ReturnType<typeof create>;
      act(() => {
        tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
      });
      await flushAsyncActions();
      return tree!.root;
    };

    const pressAsync = async (root: ReturnType<typeof create>['root'], text: string) => {
      await act(async () => {
        findPressableWithText(root, text).props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    it('can mark a two-minute item done in quick mode', async () => {
      const root = await openMode('quick');

      await pressAsync(root, 'inbox.doneIt');

      expect(updateTask.mock.calls[0][1]).toMatchObject({ status: 'done' });
    });

    it('hides the two-minute shortcut in quick mode when it is disabled', async () => {
      mockSettings.gtd.inboxProcessing = { twoMinuteEnabled: false };
      const root = await openMode('quick');

      expect(findNodesWithText(root, 'inbox.doneIt')).toHaveLength(0);
      expect(findNodesWithText(root, 'inbox.illDoIt').length).toBeGreaterThan(0);
    });

    it('can still split a capture into a project from quick mode', async () => {
      storeState.projects = [];
      addProject.mockResolvedValue({ id: 'new-project', title: 'Plan Launch' });
      const root = await openMode('quick');

      pressStep(root, 'taskEdit.projectLabel');
      // Quick reaches the one-action question, so conversion stays available.
      pressStep(root, 'process.moreThanOneStepYes');

      act(() => {
        findTextInputByAccessibilityLabel(root, 'projects.projectName').props.onChangeText('Plan Launch');
        root.findByProps({ accessibilityLabel: 'process.nextAction' }).props.onChangeText('Draft brief');
      });

      await pressAsync(root, 'process.createProject');

      expect(addProject).toHaveBeenCalled();
      expect(updateTask.mock.calls[0][1]).toMatchObject({ status: 'next', projectId: 'new-project' });
    });

    it('offers the delegate hand-off message and person suggestions in both modes', async () => {
      storeState.tasks = [
        { ...baseInboxTask },
        { ...baseInboxTask, id: 'other', status: 'next', assignedTo: 'Alexandra' },
      ];

      for (const mode of ['guided', 'quick'] as const) {
        storeState.tasks[0] = { ...baseInboxTask };
        const root = await openMode(mode);
        if (mode === 'guided') chooseActionableLonger(root);
        pressStep(root, 'inbox.delegate');

        expect(findNodesWithText(root, 'process.delegateSendRequest').length).toBeGreaterThan(0);
        expect(root.findByProps({ placeholder: 'process.delegateWhoPlaceholder' })).toBeTruthy();

        act(() => {
          root.findByProps({ placeholder: 'process.delegateWhoPlaceholder' }).props.onChangeText('Alex');
        });

        const suggestion = findNodeWithText(root, 'Alexandra');
        expect(typeof suggestion.parent?.props.onPress).toBe('function');
      }
    });

    it('keeps the note editor and AI clarify reachable in both modes', async () => {
      mockSettings.ai = { enabled: true, provider: 'openai' };

      for (const mode of ['guided', 'quick'] as const) {
        const root = await openMode(mode);

        expect(root.findByProps({
          placeholder: 'taskEdit.titleLabel',
          accessibilityLabel: 'taskEdit.titleLabel',
        })).toBeTruthy();
        expect(findNodesWithText(root, 'taskEdit.aiClarify').length).toBeGreaterThan(0);

        act(() => {
          root.findByProps({
            accessibilityLabel: 'taskEdit.descriptionLabel',
            accessibilityRole: 'button',
          }).props.onPress();
        });

        expect(root.findAllByProps({ placeholder: 'taskEdit.descriptionPlaceholder' }).length).toBeGreaterThan(0);
      }
    });

    it('keeps every organization and scheduling field behind More options in both modes', async () => {
      mockSettings.gtd.inboxProcessing = { scheduleEnabled: true };
      mockSettings.gtd.taskEditor = { hidden: [] };

      for (const mode of ['guided', 'quick'] as const) {
        storeState.tasks = [{ ...baseInboxTask }];
        const root = await openMode(mode);
        if (mode === 'guided') {
          walkToFileStep(root);
        } else {
          pressStep(root, 'taskEdit.projectLabel');
          pressStep(root, 'process.moreThanOneStepNo');
        }
        expandMoreOptions(root);

        for (const label of [
          'taskEdit.priorityLabel',
          'taskEdit.energyLevel',
          'taskEdit.timeEstimateLabel',
          'taskEdit.assignedTo',
          'taskEdit.startDateLabel',
          'taskEdit.dueDateLabel',
          'taskEdit.reviewDateLabel',
          'taskEdit.tagsLabel',
        ]) {
          expect(findNodesWithText(root, label).length).toBeGreaterThan(0);
        }
      }
    });

    it('keeps the area picker and project search in both modes', async () => {
      storeState.projects = [workProject];
      storeState.areas = [workArea];

      for (const mode of ['guided', 'quick'] as const) {
        storeState.tasks = [{ ...baseInboxTask }];
        const root = await openMode(mode);
        if (mode === 'guided') {
          walkToFileStep(root);
        } else {
          pressStep(root, 'taskEdit.projectLabel');
          pressStep(root, 'process.moreThanOneStepNo');
        }

        expect(root.findByProps({ placeholder: 'projects.addPlaceholder' })).toBeTruthy();
        expect(findNodesWithText(root, 'taskEdit.areaLabel').length).toBeGreaterThan(0);
        expect(findNodesWithText(root, 'projects.noArea').length).toBeGreaterThan(0);
        expect(findNodesWithText(root, 'Work Project').length).toBeGreaterThan(0);
      }
    });

    it('names Area and Project controls and exposes their selected state', async () => {
      storeState.projects = [workProject];
      storeState.areas = [workArea];
      storeState.tasks = [{ ...baseInboxTask }];
      const root = await openMode('guided');
      walkToFileStep(root);

      expect(root.findByProps({
        accessibilityRole: 'button',
        accessibilityLabel: 'taskEdit.areaLabel: projects.noArea',
      }).props.accessibilityState).toEqual({ selected: true });
      expect(root.findByProps({
        accessibilityRole: 'button',
        accessibilityLabel: 'taskEdit.areaLabel: Work',
      }).props.accessibilityState).toEqual({ selected: false });
      expect(root.findByProps({
        accessibilityLabel: 'projects.search',
      }).props.placeholder).toBe('projects.addPlaceholder');
      expect(root.findByProps({
        accessibilityRole: 'button',
        accessibilityLabel: 'taskEdit.projectLabel: inbox.noProject',
      }).props.accessibilityState).toEqual({ selected: true });
      expect(root.findByProps({
        accessibilityRole: 'button',
        accessibilityLabel: 'taskEdit.projectLabel: Work Project',
      }).props.accessibilityState).toEqual({ selected: false });

      act(() => {
        root.findByProps({
          accessibilityRole: 'button',
          accessibilityLabel: 'taskEdit.projectLabel: Work Project',
        }).props.onPress();
      });
      expect(root.findAllByProps({
        accessibilityRole: 'button',
        accessibilityLabel: 'taskEdit.projectLabel: Work Project',
      }).every((option) => option.props.accessibilityState?.selected === true)).toBe(true);

      storeState.tasks = [{ ...baseInboxTask }];
      const conversionRoot = await openMode('guided');
      walkToProjectConversion(conversionRoot);
      expect(conversionRoot.findByProps({
        accessibilityRole: 'button',
        accessibilityLabel: 'process.createProject',
      })).toBeTruthy();
    });

    it('keeps dated Later controls in both modes without an undated escape hatch', async () => {
      mockSettings.gtd.defaultScheduleTime = '09:00';

      for (const mode of ['guided', 'quick'] as const) {
        storeState.tasks = [{ ...baseInboxTask }];
        const root = await openMode(mode);
        pressStep(root, 'Start later');

        expect(findNodesWithText(root, 'No date')).toHaveLength(0);
        expect(findNodesWithText(root, 'common.notSet').length).toBeGreaterThan(0);
        expect(findNodesWithText(root, 'File it').length).toBeGreaterThan(0);
      }
    });
  });
  describe('progress and undo wording', () => {
    it('names the refined title in the Undo toast, not the raw capture', async () => {
      storeState.tasks = [{ ...baseInboxTask, title: 'Reply to Sam' }];
      let tree: ReturnType<typeof create>;
      act(() => {
        tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
      });
      await flushAsyncActions();
      const root = tree!.root;

      act(() => {
        root.findByProps({
          placeholder: 'taskEdit.titleLabel',
          accessibilityLabel: 'taskEdit.titleLabel',
        }).props.onChangeText('Reply to Sam about budget');
      });

      await act(async () => {
        findPressableWithText(root, 'inbox.someday').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        findPressableWithText(root, 'File it').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(updateTask.mock.calls[0][1]).toMatchObject({ title: 'Reply to Sam about budget' });
      const toast = showToast.mock.calls.map(([o]) => o).find((o) => o?.actionLabel === 'Undo');
      expect(toast?.message).toBe('Reply to Sam about budget moved to someday');
    });

    it('counts up against the session size instead of the shrinking queue', async () => {
      storeState.tasks = [
        { ...baseInboxTask, id: 'a', title: 'A' },
        { ...baseInboxTask, id: 'b', title: 'B' },
        { ...baseInboxTask, id: 'c', title: 'C' },
      ];
      let tree: ReturnType<typeof create>;
      act(() => {
        tree = create(<InboxProcessingModal visible onClose={vi.fn()} />);
      });
      await flushAsyncActions();
      const root = tree!.root;
      const progressText = () => root.findAll((node) => (
        typeof node.props?.children === 'string' && node.props.children.endsWith('common.tasks')
      ))[0].props.children;

      expect(progressText()).toBe('0/3 common.tasks');

      // Filing one item removes it from the Inbox, so the queue and the raw
      // total both shrink; the session counter must still move forward.
      storeState.tasks = storeState.tasks.filter((task) => task.id !== 'a');
      await act(async () => {
        findPressableWithText(root, 'inbox.someday').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(progressText()).toBe('1/3 common.tasks');    });
  });
});
