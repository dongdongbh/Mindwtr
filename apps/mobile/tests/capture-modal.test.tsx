import React from 'react';
import {
  AccessibilityInfo,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAIProvider } from '@mindwtr/core';

import CaptureScreen, { sanitizeCaptureReturnToParam } from '@/app/capture-modal';
import { logInfo } from '@/lib/app-log';

const { hardwareBack, navigationGuard, openTaskScreen, parseQuickAdd, returnToPreviousApp, routerMocks, routeParams, stashPendingCaptureTaskOpen, storeState } = vi.hoisted(() => {
  const parseQuickAdd = vi.fn<(value: string) => any>((value: string) => ({ title: value, props: {}, invalidDateCommands: [] }));
  const navigationGuard = {
    callback: null as null | ((options: { data: { action: { type: string } } }) => void),
    deferActions: false,
    dispatch: vi.fn(),
    preventRemove: false,
    queuedActions: [] as { type: string }[],
  };
  const attemptNavigationRemoval = (action: { type: string }) => {
    if (navigationGuard.preventRemove) {
      navigationGuard.callback?.({ data: { action } });
      return;
    }
    navigationGuard.dispatch(action);
  };
  const requestNavigationRemoval = (action: { type: string }) => {
    if (navigationGuard.deferActions) {
      navigationGuard.queuedActions.push(action);
      return;
    }
    attemptNavigationRemoval(action);
  };
  return {
    hardwareBack: {
      handler: null as (() => boolean) | null,
      remove: vi.fn(),
    },
    navigationGuard,
    openTaskScreen: vi.fn(() => requestNavigationRemoval({ type: 'REPLACE_WITH_TASK_EDITOR' })),
    returnToPreviousApp: vi.fn(),
    stashPendingCaptureTaskOpen: vi.fn(),
    parseQuickAdd,
    routerMocks: {
      back: vi.fn(() => requestNavigationRemoval({ type: 'GO_BACK' })),
      canGoBack: vi.fn(),
      replace: vi.fn(() => requestNavigationRemoval({ type: 'REPLACE' })),
    },
    routeParams: {
      current: { text: encodeURIComponent('Shared text') } as Record<string, string>,
    },
    storeState: {
      addProject: vi.fn(),
      addTask: vi.fn(),
      addTasks: vi.fn(),
      projects: [] as any[],
      tasks: [] as any[],
      settings: { ai: { enabled: false }, features: {} },
      areas: [] as any[],
    },
  };
});

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeParams.current,
  usePathname: () => '/projects-screen',
  useRouter: () => routerMocks,
}));

vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ dispatch: navigationGuard.dispatch }),
  usePreventRemove: (
    preventRemove: boolean,
    callback: (options: { data: { action: { type: string } } }) => void,
  ) => {
    navigationGuard.preventRemove = preventRemove;
    navigationGuard.callback = callback;
  },
}));

vi.mock('@mindwtr/core', async () => {
  // The shared capture transaction runs real; only its store actions are substituted.
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
  executeCaptureTransaction: actual.executeCaptureTransaction,
  prepareCaptureTask: actual.prepareCaptureTask,
  buildQuickAddParseOptions: actual.buildQuickAddParseOptions,
  buildQuickAddPreviewEntries: actual.buildQuickAddPreviewEntries,
  getPersonOptionNames: actual.getPersonOptionNames,
  createAIProvider: vi.fn(),
  DEFAULT_PROJECT_COLOR: '#94a3b8',
  getQuickAddProjectInitialProps: (props: any, fallbackAreaId?: string | null) => {
    const areaId = props?.areaId || fallbackAreaId || undefined;
    return areaId ? { areaId } : undefined;
  },
  getUsedTaskTokens: vi.fn(() => []),
  isSandboxMode: () => false,
  isNaturalLanguageDatesEnabled: (settings?: { gtd?: { naturalLanguageDates?: boolean } } | null) =>
    settings?.gtd?.naturalLanguageDates !== false,
  isSelectableProjectForTaskAssignment: vi.fn((project: any) => (
    !project.deletedAt && project.status !== 'archived' && project.status !== 'completed'
  )),
  parseQuickAdd,
  normalizeClockTimeInput: (value?: string | null) => String(value ?? '').trim(),
  resolveDefaultNewTaskAreaId: (settings: any, areas: any[]) => {
    const areaId = settings?.gtd?.defaultAreaId;
    return typeof areaId === 'string' && areas.some((area) => area.id === areaId && !area.deletedAt)
      ? areaId
      : undefined;
  },
  resolveFeatureFlags: actual.resolveFeatureFlags,
  shallow: (left: unknown, right: unknown) => Object.is(left, right),
  splitQuickAddBulkLines: (input: string) => input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
  tFallback: (t: (key: string) => string, key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  },
  useTaskStore: (selector?: (state: typeof storeState) => unknown) => (
    typeof selector === 'function' ? selector(storeState) : storeState
  ),
};
});

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        'nav.addTask': 'Add Task',
        'quickAdd.example': 'Quick add',
        'common.cancel': 'Cancel',
        'common.done': 'Done',
        'common.save': 'Save',
        'common.notice': 'Notice',
        'quickAdd.saveAndEdit': 'Save & edit',
        'quickAdd.invalidDateCommand': 'Invalid date command',
        'task.addFailed': 'Failed to add task',
        'copilot.suggested': 'Suggested',
        'copilot.applyHint': 'Tap to apply',
        'copilot.applied': 'Applied',
        'quickAdd.help': 'Help text',
        'taskEdit.descriptionLabel': 'Description',
        'taskEdit.descriptionPlaceholder': 'Add notes...',
      }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    inputBg: '#1f2937',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
  }),
}));

vi.mock('@/contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('@/lib/ai-config', () => ({
  buildCopilotConfig: vi.fn(),
  isAIKeyRequired: vi.fn(() => false),
  loadAIKey: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('@/lib/hardware-back', () => ({
  returnToPreviousApp,
  addHardwareBackPressListener: (handler: () => boolean) => {
    hardwareBack.handler = handler;
    return {
      remove: () => {
        hardwareBack.remove();
        if (hardwareBack.handler === handler) hardwareBack.handler = null;
      },
    };
  },
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openTaskScreen,
  stashPendingCaptureTaskOpen,
}));

vi.mock('@/lib/attachment-sync-utils', () => ({
  getAttachmentsDir: vi.fn(async () => 'file:///data/mindwtr/attachments/'),
}));

const findTouchableByText = (tree: ReturnType<typeof create>, label: string) => {
  const button = tree.root.findAll((node) => (
    node.type === TouchableOpacity
    && node.findAllByType(Text).some((child) => child.props.children === label)
  ))[0];
  if (!button) throw new Error(`TouchableOpacity not found for ${label}`);
  return button;
};

const findCaptureError = (tree: ReturnType<typeof create>) => tree.root.find(
  (node) => node.type === Text
    && node.props.children === 'Failed to add task'
);

const setPlatform = (os: typeof Platform.OS) => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
};

const announceForAccessibilitySpy = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');

const flushAccessibilityAnnouncement = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
};

const attemptNativeRouteRemoval = () => {
  const action = { type: 'GO_BACK' };
  if (navigationGuard.preventRemove) {
    navigationGuard.callback?.({ data: { action } });
    return;
  }
  navigationGuard.dispatch(action);
};

const attemptHardwareBack = () => {
  const handled = hardwareBack.handler?.() ?? false;
  if (!handled) attemptNativeRouteRemoval();
  return handled;
};

describe('CaptureScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('web');
    hardwareBack.handler = null;
    navigationGuard.callback = null;
    navigationGuard.deferActions = false;
    navigationGuard.preventRemove = false;
    navigationGuard.queuedActions = [];
    parseQuickAdd.mockImplementation((value: string) => ({ title: value, props: {}, invalidDateCommands: [] }));
    routerMocks.canGoBack.mockReturnValue(false);
    routeParams.current = { text: encodeURIComponent('Shared text') };
    storeState.addProject.mockResolvedValue(null);
    storeState.addTask.mockResolvedValue({ success: true, id: 'task-created' });
    storeState.addTasks.mockResolvedValue({ success: true });
    storeState.projects = [];
    storeState.areas = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlatform('web');
  });

  it('announces a settled single-save failure once on Android without a second live-region speech path', async () => {
    vi.useFakeTimers();
    setPlatform('android');
    storeState.addTask.mockResolvedValueOnce({ success: false, error: 'store unavailable' });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });

    expect(announceForAccessibilitySpy).not.toHaveBeenCalled();
    await flushAccessibilityAnnouncement();

    const error = findCaptureError(tree);
    expect(error.props.accessibilityLiveRegion).toBeUndefined();
    expect(error.props.accessibilityRole).toBeUndefined();
    expect(announceForAccessibilitySpy).toHaveBeenCalledOnce();
    expect(announceForAccessibilitySpy).toHaveBeenCalledWith('Failed to add task');
    expect(logInfo).toHaveBeenCalledWith(
      'Capture failure accessibility announcement requested',
      {
        scope: 'capture',
        extra: { releaseCheck: 'v1.3.0/capture-failure-announcement' },
      },
    );
    vi.useRealTimers();
  });

  it('announces each deliberate Android retry failure exactly once', async () => {
    vi.useFakeTimers();
    setPlatform('android');
    storeState.addTask.mockResolvedValue({ success: false, error: 'store unavailable' });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });
    await flushAccessibilityAnnouncement();
    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });
    await flushAccessibilityAnnouncement();

    expect(announceForAccessibilitySpy).toHaveBeenCalledTimes(2);
    expect(logInfo).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('announces Android failures from Save & edit and confirmed bulk capture', async () => {
    vi.useFakeTimers();
    setPlatform('android');
    storeState.addTask.mockResolvedValueOnce({ success: false, error: 'store unavailable' });

    let singleTree!: ReturnType<typeof create>;
    act(() => {
      singleTree = create(<CaptureScreen />);
    });
    await act(async () => {
      findTouchableByText(singleTree, 'Save & edit').props.onPress();
    });
    await flushAccessibilityAnnouncement();

    expect(announceForAccessibilitySpy).toHaveBeenCalledTimes(1);
    expect(openTaskScreen).not.toHaveBeenCalled();

    act(() => {
      singleTree.unmount();
    });
    routeParams.current = { initialValue: encodeURIComponent('Email Bob\nCall Alice') };
    storeState.addTasks.mockResolvedValueOnce({ success: false, error: 'store unavailable' });

    let bulkTree!: ReturnType<typeof create>;
    act(() => {
      bulkTree = create(<CaptureScreen />);
    });
    await act(async () => {
      findTouchableByText(bulkTree, 'Save').props.onPress();
    });
    await act(async () => {
      findTouchableByText(bulkTree, 'Create tasks').props.onPress();
    });
    await flushAccessibilityAnnouncement();

    expect(announceForAccessibilitySpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('cancels a pending Android failure announcement on a new submission and on unmount', async () => {
    vi.useFakeTimers();
    setPlatform('android');
    const retryWrite = deferred<{ success: true; id: string }>();
    storeState.addTask
      .mockResolvedValueOnce({ success: false, error: 'store unavailable' })
      .mockReturnValueOnce(retryWrite.promise);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });
    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
      await Promise.resolve();
    });
    await flushAccessibilityAnnouncement();

    expect(announceForAccessibilitySpy).not.toHaveBeenCalled();

    act(() => {
      tree.unmount();
    });
    await act(async () => {
      retryWrite.resolve({ success: true, id: 'task-created' });
      await retryWrite.promise;
    });
    await flushAccessibilityAnnouncement();

    expect(announceForAccessibilitySpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancels a scheduled Android failure announcement when the screen unmounts', async () => {
    vi.useFakeTimers();
    setPlatform('android');
    storeState.addTask.mockResolvedValueOnce({ success: false, error: 'store unavailable' });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });
    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });

    expect(findCaptureError(tree)).toBeTruthy();
    act(() => {
      tree.unmount();
    });
    await flushAccessibilityAnnouncement();

    expect(announceForAccessibilitySpy).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps the existing alert semantics and skips explicit speech outside Android', async () => {
    vi.useFakeTimers();
    setPlatform('ios');
    storeState.addTask.mockResolvedValueOnce({ success: false, error: 'store unavailable' });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });
    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });
    await flushAccessibilityAnnouncement();

    const error = findCaptureError(tree);
    expect(error.props.accessibilityLiveRegion).toBe('assertive');
    expect(error.props.accessibilityRole).toBe('alert');
    expect(announceForAccessibilitySpy).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not announce successful, invalid-date, or cancelled bulk submissions on Android', async () => {
    vi.useFakeTimers();
    setPlatform('android');

    let successTree!: ReturnType<typeof create>;
    act(() => {
      successTree = create(<CaptureScreen />);
    });
    await act(async () => {
      findTouchableByText(successTree, 'Save').props.onPress();
    });
    await flushAccessibilityAnnouncement();
    expect(announceForAccessibilitySpy).not.toHaveBeenCalled();
    act(() => successTree.unmount());

    vi.clearAllMocks();
    routeParams.current = { initialValue: encodeURIComponent('Call dentist /due:nope') };
    parseQuickAdd.mockReturnValue({
      title: 'Call dentist',
      props: {},
      invalidDateCommands: ['/due:nope'],
    });
    let invalidTree!: ReturnType<typeof create>;
    act(() => {
      invalidTree = create(<CaptureScreen />);
    });
    await act(async () => {
      findTouchableByText(invalidTree, 'Save').props.onPress();
    });
    await flushAccessibilityAnnouncement();
    expect(announceForAccessibilitySpy).not.toHaveBeenCalled();
    act(() => invalidTree.unmount());

    vi.clearAllMocks();
    routeParams.current = { initialValue: encodeURIComponent('Email Bob\nCall Alice') };
    let bulkTree!: ReturnType<typeof create>;
    act(() => {
      bulkTree = create(<CaptureScreen />);
    });
    await act(async () => {
      findTouchableByText(bulkTree, 'Save').props.onPress();
    });
    act(() => {
      hardwareBack.handler?.();
    });
    await flushAccessibilityAnnouncement();

    expect(announceForAccessibilitySpy).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reads the parsed draft back as chips under the input', () => {
    parseQuickAdd.mockImplementation((value: string) => ({
      title: value,
      props: { contexts: ['@errands'], dueDate: '2026-08-12' },
      invalidDateCommands: [],
    }));

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    const strip = tree.root.findByProps({ testID: 'quick-add-preview' });
    const chipText = strip.findAllByType(Text).map((node) => node.props.children);
    expect(chipText).toContain('@errands');
    // The resolved date the task will store, formatted for reading.
    expect(chipText.some((text) => typeof text === 'string' && /2026/.test(text))).toBe(true);
  });

  it('returns to inbox when cancelling without a back stack', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const cancelButton = tree.root.findAllByType(TouchableOpacity)[1];

    act(() => {
      cancelButton.props.onPress();
    });

    expect(routerMocks.back).not.toHaveBeenCalled();
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('returns to a requested internal route when cancelling', () => {
    routeParams.current = {
      text: encodeURIComponent('Shared text'),
      returnTo: encodeURIComponent('/projects-screen?projectId=project-1'),
    };

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const cancelButton = tree.root.findAllByType(TouchableOpacity)[1];

    act(() => {
      cancelButton.props.onPress();
    });

    expect(routerMocks.back).not.toHaveBeenCalled();
    expect(routerMocks.replace).toHaveBeenCalledWith('/projects-screen?projectId=project-1');
  });

  it('goes back when cancelling from a stacked navigation flow', () => {
    routerMocks.canGoBack.mockReturnValue(true);

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const cancelButton = tree.root.findAllByType(TouchableOpacity)[1];

    act(() => {
      cancelButton.props.onPress();
    });

    expect(routerMocks.back).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it('adds keyboard-aware layout and exposes a dismiss action while the keyboard is visible', () => {
    const listeners = new Map<string, ((event?: unknown) => void) | undefined>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
      listeners.set(eventName, listener);
      return {
        remove: () => {
          listeners.delete(eventName);
        },
      };
    }) as any);
    const dismissSpy = vi.spyOn(Keyboard, 'dismiss');

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    expect(tree.root.findByType(KeyboardAvoidingView)).toBeTruthy();
    expect(tree.root.findByType(ScrollView).props.keyboardShouldPersistTaps).toBe('handled');
    expect(tree.root.findByType(ScrollView).props.keyboardDismissMode).toBe('on-drag');

    act(() => {
      listeners.get('keyboardDidShow')?.();
    });

    const dismissButton = tree.root.find(
      (node) => node.type === TouchableOpacity && node.props.accessibilityLabel === 'Hide keyboard'
    );

    act(() => {
      dismissButton.props.onPress();
    });

    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts only one rapid Save submission', async () => {
    const write = deferred<{ success: true; id: string }>();
    storeState.addTask.mockReturnValue(write.promise);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');
    await act(async () => {
      saveButton.props.onPress();
      saveButton.props.onPress();
      await Promise.resolve();
    });

    expect(storeState.addTask).toHaveBeenCalledTimes(1);
    expect(findTouchableByText(tree, 'Save').props.disabled).toBe(true);
    expect(findTouchableByText(tree, 'Save & edit').props.disabled).toBe(true);
    expect(findTouchableByText(tree, 'Cancel').props.disabled).toBe(true);

    await act(async () => {
      write.resolve({ success: true, id: 'task-created' });
      await write.promise;
    });

    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('blocks hardware Back and native removal while a single capture is pending, then closes once on success', async () => {
    routerMocks.canGoBack.mockReturnValue(true);
    const write = deferred<{ success: true; id: string }>();
    storeState.addTask.mockReturnValue(write.promise);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
      await Promise.resolve();
    });

    expect(navigationGuard.preventRemove).toBe(true);
    let hardwareBackHandled = false;
    act(() => {
      hardwareBackHandled = attemptHardwareBack();
      attemptNativeRouteRemoval();
    });

    expect(hardwareBackHandled).toBe(true);
    expect(navigationGuard.dispatch).not.toHaveBeenCalled();
    expect(routerMocks.back).not.toHaveBeenCalled();

    await act(async () => {
      write.resolve({ success: true, id: 'task-created' });
      await write.promise;
    });

    expect(routerMocks.back).toHaveBeenCalledTimes(1);
    expect(navigationGuard.dispatch).toHaveBeenCalledTimes(1);
  });

  it('allows an intentional success removal delivered after submission settlement', async () => {
    routerMocks.canGoBack.mockReturnValue(true);
    navigationGuard.deferActions = true;
    const write = deferred<{ success: true; id: string }>();
    storeState.addTask.mockReturnValue(write.promise);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
      await Promise.resolve();
    });
    await act(async () => {
      write.resolve({ success: true, id: 'task-created' });
      await write.promise;
    });

    const successAction = navigationGuard.queuedActions[0]!;
    expect(successAction).toEqual({ type: 'GO_BACK' });
    expect(navigationGuard.dispatch).not.toHaveBeenCalled();

    act(() => {
      navigationGuard.callback?.({ data: { action: successAction } });
    });

    expect(navigationGuard.dispatch).toHaveBeenCalledTimes(1);
    expect(navigationGuard.dispatch).toHaveBeenCalledWith(successAction);
  });

  it('restores the retained draft, retry controls, and normal dismissal after a deferred write rejection', async () => {
    const write = deferred<{ success: true; id: string }>();
    storeState.addTask
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce({ success: true, id: 'task-created' });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
      await Promise.resolve();
    });

    act(() => {
      attemptNativeRouteRemoval();
    });
    expect(navigationGuard.dispatch).not.toHaveBeenCalled();

    await act(async () => {
      write.reject(new Error('store unavailable'));
      try {
        await write.promise;
      } catch {
        // CaptureScreen owns the rejection and renders retry feedback.
      }
    });

    expect(navigationGuard.preventRemove).toBe(false);
    expect(findCaptureError(tree).props.accessibilityLiveRegion).toBe('assertive');
    expect(tree.root.findByType(TextInput).props.value).toBe('Shared text');
    expect(findTouchableByText(tree, 'Save').props.disabled).toBe(false);

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledTimes(2);
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('does not run late Save & edit navigation after an accepted capture is unexpectedly unmounted', async () => {
    const write = deferred<{ success: true; id: string }>();
    storeState.addTask.mockReturnValue(write.promise);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save & edit').props.onPress();
      await Promise.resolve();
    });
    act(() => {
      tree.unmount();
    });

    await act(async () => {
      write.resolve({ success: true, id: 'task-created' });
      await write.promise;
    });

    expect(storeState.addTask).toHaveBeenCalledTimes(1);
    expect(openTaskScreen).not.toHaveBeenCalled();
    expect(routerMocks.back).not.toHaveBeenCalled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(navigationGuard.dispatch).not.toHaveBeenCalled();
  });

  it('accepts only the first of rapid Save and Save & edit submissions', async () => {
    const write = deferred<{ success: true; id: string }>();
    storeState.addTask.mockReturnValue(write.promise);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');
    const saveAndEditButton = findTouchableByText(tree, 'Save & edit');
    await act(async () => {
      saveButton.props.onPress();
      saveAndEditButton.props.onPress();
      await Promise.resolve();
    });

    expect(storeState.addTask).toHaveBeenCalledTimes(1);

    await act(async () => {
      write.resolve({ success: true, id: 'task-created' });
      await write.promise;
    });

    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
    expect(openTaskScreen).not.toHaveBeenCalled();
  });

  it('retains a single capture after a rejected result and allows a deliberate retry', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Call dentist'),
      initialProps: encodeURIComponent(JSON.stringify({
        description: 'Tomorrow morning',
        tags: ['#phone'],
      })),
    };
    storeState.addTask
      .mockResolvedValueOnce({ success: false, error: 'store unavailable' })
      .mockResolvedValueOnce({ success: true, id: 'task-created' });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });

    expect(findCaptureError(tree).props.accessibilityLiveRegion).toBe('assertive');
    expect(routerMocks.replace).not.toHaveBeenCalled();
    const retainedInputs = tree.root.findAllByType(TextInput);
    expect(retainedInputs[0].props.value).toBe('Call dentist');
    expect(retainedInputs[1].props.value).toBe('Tomorrow morning');
    expect(findTouchableByText(tree, 'Save').props.disabled).toBe(false);

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledTimes(2);
    expect(storeState.addTask).toHaveBeenNthCalledWith(2, 'Call dentist', {
      status: 'inbox',
      description: 'Tomorrow morning',
      tags: ['#phone'],
    });
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('retains a single capture after a write rejection and allows a deliberate retry', async () => {
    storeState.addTask
      .mockRejectedValueOnce(new Error('store unavailable'))
      .mockResolvedValueOnce({ success: true, id: 'task-created' });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });

    expect(findCaptureError(tree).props.accessibilityLiveRegion).toBe('assertive');
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(tree.root.findByType(TextInput).props.value).toBe('Shared text');

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledTimes(2);
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('saves App Action capture details from initial props after confirmation', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Call dentist'),
      initialProps: encodeURIComponent(JSON.stringify({
        description: 'Tomorrow morning',
        tags: ['#phone'],
      })),
    };

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Call dentist', {
      status: 'inbox',
      description: 'Tomorrow morning',
      tags: ['#phone'],
    });
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('creates the task with shared-file attachments and drops uris outside the managed dir', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('report'),
      initialProps: encodeURIComponent(JSON.stringify({
        attachments: [
          {
            id: 'att-1',
            kind: 'file',
            title: 'report.pdf',
            uri: 'file:///data/mindwtr/attachments/att-1.pdf',
            mimeType: 'application/pdf',
            size: 1024,
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:00.000Z',
            localStatus: 'available',
          },
          {
            id: 'att-2',
            kind: 'file',
            title: 'outside.bin',
            uri: 'file:///data/other-app/outside.bin',
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:00.000Z',
          },
        ],
      })),
    };

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    // The pending attachment is visible on the sheet before saving.
    expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'report.pdf')).toBe(true);

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledTimes(1);
    const [title, initialProps] = storeState.addTask.mock.calls[0];
    expect(title).toBe('report');
    expect(initialProps.attachments).toHaveLength(1);
    expect(initialProps.attachments[0]).toMatchObject({
      id: 'att-1',
      kind: 'file',
      title: 'report.pdf',
      uri: 'file:///data/mindwtr/attachments/att-1.pdf',
      mimeType: 'application/pdf',
      size: 1024,
    });
  });

  // This route is presented modally, so an Alert raised over it is a second
  // native presentation on the first. On iOS it never showed: saving a
  // multi-line paste did nothing and left the screen blocked (#941). The
  // confirmation is drawn on the screen itself now, and no Alert is raised.
  it('dismisses multiline confirmation with hardware Back before creating one task per line', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Email Bob\n\nCall Alice /next'),
    };
    parseQuickAdd.mockImplementation((value: string) => ({
      title: value.replace(/\s+\/next$/u, ''),
      props: value.endsWith('/next') ? { status: 'next' } : {},
      invalidDateCommands: [],
    }));
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(vi.fn());

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();

    const hiddenForm = tree.root.findByType(ScrollView);
    expect(hiddenForm.props.accessibilityElementsHidden).toBe(true);
    expect(hiddenForm.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(tree.root.find(
      (node) => node.props.accessibilityViewIsModal === true
        && node.props.importantForAccessibility === 'yes'
    )).toBeTruthy();

    const backHandler = hardwareBack.handler;
    expect(backHandler).not.toBeNull();
    let handled = false;
    act(() => {
      handled = backHandler?.() ?? false;
    });

    expect(handled).toBe(true);
    expect(routerMocks.back).not.toHaveBeenCalled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(storeState.addTasks).not.toHaveBeenCalled();
    expect(tree.root.findAll((node) => (
      node.type === TouchableOpacity
      && node.findAllByType(Text).some((child) => child.props.children === 'Create tasks')
    ))).toHaveLength(0);
    expect(tree.root.findByType(ScrollView).props.accessibilityElementsHidden).toBe(false);
    expect(tree.root.findByType(ScrollView).props.importantForAccessibility).toBe('auto');
    expect(tree.root.findByType(TextInput).props.value).toBe('Email Bob\n\nCall Alice /next');

    await act(async () => {
      await findTouchableByText(tree, 'Save').props.onPress();
    });

    // The confirmation is on screen, reachable as ordinary rendered content.
    const confirmButton = findTouchableByText(tree, 'Create tasks');
    await act(async () => {
      await confirmButton.props.onPress();
    });

    expect(storeState.addTask).not.toHaveBeenCalled();
    expect(storeState.addTasks).toHaveBeenCalledTimes(1);
    expect(storeState.addTasks).toHaveBeenCalledWith([
      { title: 'Email Bob', initialProps: expect.objectContaining({ status: 'inbox' }) },
      { title: 'Call Alice', initialProps: expect.objectContaining({ status: 'next' }) },
    ]);
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('accepts only one repeated bulk confirmation', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Email Bob\nCall Alice'),
    };
    const write = deferred<{ success: true }>();
    storeState.addTasks.mockReturnValue(write.promise);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });
    const confirmButton = findTouchableByText(tree, 'Create tasks');

    await act(async () => {
      confirmButton.props.onPress();
      confirmButton.props.onPress();
      await Promise.resolve();
    });

    expect(storeState.addTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      write.resolve({ success: true });
      await write.promise;
    });

    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('blocks hardware Back and native removal while a confirmed bulk capture is pending', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Email Bob\nCall Alice'),
    };
    const write = deferred<{ success: true }>();
    storeState.addTasks.mockReturnValue(write.promise);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });
    await act(async () => {
      findTouchableByText(tree, 'Create tasks').props.onPress();
      await Promise.resolve();
    });

    expect(navigationGuard.preventRemove).toBe(true);
    let hardwareBackHandled = false;
    act(() => {
      hardwareBackHandled = attemptHardwareBack();
      attemptNativeRouteRemoval();
    });

    expect(hardwareBackHandled).toBe(true);
    expect(navigationGuard.dispatch).not.toHaveBeenCalled();

    await act(async () => {
      write.resolve({ success: true });
      await write.promise;
    });

    expect(storeState.addTasks).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
    expect(navigationGuard.dispatch).toHaveBeenCalledTimes(1);
  });

  it('retains a bulk capture after a rejected result and allows a deliberate retry', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Email Bob\nCall Alice'),
    };
    storeState.addTasks
      .mockResolvedValueOnce({ success: false, error: 'store unavailable' })
      .mockResolvedValueOnce({ success: true });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });
    await act(async () => {
      findTouchableByText(tree, 'Create tasks').props.onPress();
    });

    expect(findCaptureError(tree).props.accessibilityLiveRegion).toBe('assertive');
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(tree.root.findByType(TextInput).props.value).toBe('Email Bob\nCall Alice');
    expect(findTouchableByText(tree, 'Save').props.disabled).toBe(false);

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });
    await act(async () => {
      findTouchableByText(tree, 'Create tasks').props.onPress();
    });

    expect(storeState.addTasks).toHaveBeenCalledTimes(2);
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('retains a bulk capture after a write rejection and allows a deliberate retry', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Email Bob\nCall Alice'),
    };
    storeState.addTasks
      .mockRejectedValueOnce(new Error('store unavailable'))
      .mockResolvedValueOnce({ success: true });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });
    await act(async () => {
      findTouchableByText(tree, 'Create tasks').props.onPress();
    });

    expect(findCaptureError(tree).props.accessibilityLiveRegion).toBe('assertive');
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(tree.root.findByType(TextInput).props.value).toBe('Email Bob\nCall Alice');

    await act(async () => {
      findTouchableByText(tree, 'Save').props.onPress();
    });
    await act(async () => {
      findTouchableByText(tree, 'Create tasks').props.onPress();
    });

    expect(storeState.addTasks).toHaveBeenCalledTimes(2);
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('preserves safe status and project initial props from capture links', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Project task'),
      initialProps: encodeURIComponent(JSON.stringify({
        projectId: 'project-1',
        status: 'next',
      })),
    };
    storeState.projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Project task', {
      status: 'next',
      projectId: 'project-1',
    });
  });

  it('sends the app behind the previous screen after a capture opened by a system entry point (#1169)', async () => {
    routeParams.current = { origin: 'system' };
    routerMocks.canGoBack.mockReturnValue(false);
    returnToPreviousApp.mockReturnValue(true);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });
    act(() => {
      tree.root.findByType(TextInput).props.onChangeText('Call the plumber');
    });
    await act(async () => {
      await findTouchableByText(tree, 'Save').props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Call the plumber', expect.objectContaining({ status: 'inbox' }));
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
    expect(returnToPreviousApp).toHaveBeenCalledTimes(1);
  });

  it('keeps the app in front after a save from inside the app', async () => {
    routeParams.current = {};
    routerMocks.canGoBack.mockReturnValue(true);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });
    act(() => {
      tree.root.findByType(TextInput).props.onChangeText('Call the plumber');
    });
    await act(async () => {
      await findTouchableByText(tree, 'Save').props.onPress();
    });

    expect(routerMocks.back).toHaveBeenCalled();
    expect(returnToPreviousApp).not.toHaveBeenCalled();
  });

  it('stays in the editor when save and edit is chosen from a system entry point', async () => {
    routeParams.current = { origin: 'system' };
    routerMocks.canGoBack.mockReturnValue(false);
    storeState.addTask.mockResolvedValueOnce({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureScreen />);
    });
    act(() => {
      tree.root.findByType(TextInput).props.onChangeText('Call the plumber');
    });
    await act(async () => {
      await findTouchableByText(tree, 'Save & edit').props.onPress();
    });

    expect(openTaskScreen).toHaveBeenCalledTimes(1);
    expect(returnToPreviousApp).not.toHaveBeenCalled();
  });

  it('returns to the requested project route after saving a project task', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Project task'),
      initialProps: encodeURIComponent(JSON.stringify({
        projectId: 'project-1',
        status: 'next',
      })),
      returnTo: encodeURIComponent('/projects-screen?projectId=project-1'),
    };
    storeState.projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Project task', {
      status: 'next',
      projectId: 'project-1',
    });
    expect(routerMocks.replace).toHaveBeenCalledWith('/projects-screen?projectId=project-1');
    expect(routerMocks.replace).not.toHaveBeenCalledWith('/inbox');
  });

  it('pops back to the project instead of stacking a duplicate screen per saved task (#938)', async () => {
    // The project add-task flow pushes capture on top of the project screen, so
    // replacing capture with returnTo left one extra screen on the stack per
    // save: leaving the project then took one back tap per task added.
    routerMocks.canGoBack.mockReturnValue(true);
    routeParams.current = {
      initialValue: encodeURIComponent('Project task'),
      initialProps: encodeURIComponent(JSON.stringify({
        projectId: 'project-1',
        status: 'next',
      })),
      returnTo: encodeURIComponent('/projects-screen?projectId=project-1'),
    };
    storeState.projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    await act(async () => {
      await findTouchableByText(tree, 'Save').props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Project task', {
      status: 'next',
      projectId: 'project-1',
    });
    expect(routerMocks.back).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it('sanitizes capture return routes to app-internal paths', () => {
    expect(sanitizeCaptureReturnToParam(encodeURIComponent('/projects-screen?projectId=project-1')))
      .toBe('/projects-screen?projectId=project-1');
    expect(sanitizeCaptureReturnToParam(encodeURIComponent('//example.com/path'))).toBeNull();
    expect(sanitizeCaptureReturnToParam(encodeURIComponent('https://example.com/path'))).toBeNull();
    expect(sanitizeCaptureReturnToParam('')).toBeNull();
  });

  it('ignores unsupported URL-controlled initial props', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Visible task'),
      initialProps: encodeURIComponent(JSON.stringify({
        description: 'Keep this',
        tags: ['phone'],
        status: 'archived',
        deletedAt: '2026-05-09T12:00:00.000Z',
        attachments: [{ id: 'attachment-1' }],
      })),
    };

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Visible task', {
      status: 'inbox',
      description: 'Keep this',
      tags: ['#phone'],
    });
  });

  it('resolves project names supplied by shortcut capture links', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Call dentist'),
      project: encodeURIComponent('Health'),
    };
    storeState.addProject.mockResolvedValue({ id: 'project-health', title: 'Health' });

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addProject).toHaveBeenCalledWith('Health', '#94a3b8', undefined);
    expect(storeState.addTask).toHaveBeenCalledWith('Call dentist', {
      status: 'inbox',
      projectId: 'project-health',
    });
  });

  it('creates parsed quick-add projects inside the parsed area', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Plan campaign +Launch !Work'),
    };
    parseQuickAdd.mockReturnValue({
      title: 'Plan campaign',
      props: { areaId: 'area-work' },
      projectTitle: 'Launch',
      invalidDateCommands: [],
    });
    storeState.addProject.mockResolvedValue({ id: 'project-launch', title: 'Launch' });

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addProject).toHaveBeenCalledWith('Launch', '#94a3b8', { areaId: 'area-work' });
    expect(storeState.addTask).toHaveBeenCalledWith('Plan campaign', {
      status: 'inbox',
      projectId: 'project-launch',
      areaId: undefined,
    });
  });

  it('opens the created task when save and edit is requested', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Project task'),
      initialProps: encodeURIComponent(JSON.stringify({
        projectId: 'project-1',
        status: 'next',
      })),
    };
    storeState.projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];
    storeState.addTask.mockResolvedValueOnce({ success: true, id: 'task-new' });

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveAndEditButton = findTouchableByText(tree, 'Save & edit');

    await act(async () => {
      await saveAndEditButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Project task', {
      status: 'next',
      projectId: 'project-1',
    });
    // replace, not push: the capture route must leave the stack when it hands
    // off to the editor, or backing out reopens it pre-filled (#1029).
    expect(openTaskScreen).toHaveBeenCalledWith('task-new', 'project-1', 'task', { replace: true });
    expect(routerMocks.replace).not.toHaveBeenCalledWith('/inbox');
  });

  it('stashes the editor open and pops when save and edit came from the project screen', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Project task'),
      initialProps: encodeURIComponent(JSON.stringify({
        projectId: 'project-1',
        status: 'next',
      })),
      returnTo: encodeURIComponent('/projects-screen?projectId=project-1'),
    };
    storeState.projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];
    storeState.addTask.mockResolvedValueOnce({ success: true, id: 'task-new' });
    routerMocks.canGoBack.mockReturnValue(true);

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveAndEditButton = findTouchableByText(tree, 'Save & edit');

    await act(async () => {
      await saveAndEditButton.props.onPress();
    });

    // The project screen is directly underneath: navigating to it would stack
    // a duplicate of it, so the editor request is stashed for its focus
    // effect and the capture closes exactly like a plain save (#1029).
    expect(stashPendingCaptureTaskOpen).toHaveBeenCalledWith({
      taskId: 'task-new',
      projectId: 'project-1',
      taskTab: 'task',
    });
    expect(openTaskScreen).not.toHaveBeenCalled();
    expect(routerMocks.back).toHaveBeenCalled();
  });

  describe('copilot suggestion chips (#1022)', () => {
    const findChip = (tree: ReturnType<typeof create>, label: string) => tree.root.findAll(
      (node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === label
    )[0];

    const mountWithSuggestion = async () => {
      vi.mocked(createAIProvider).mockReturnValue({
        predictMetadata: vi.fn().mockResolvedValue({ context: '@phone', timeEstimate: '15min', tags: ['#health'] }),
      } as never);

      let tree!: ReturnType<typeof create>;
      await act(async () => {
        tree = create(<CaptureScreen />);
      });
      // The debounced copilot request plus the promise it awaits.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      return tree;
    };

    beforeEach(() => {
      vi.useFakeTimers();
      storeState.settings = { ai: { enabled: true, provider: 'openai' }, features: {} } as never;
    });

    afterEach(() => {
      vi.useRealTimers();
      storeState.settings = { ai: { enabled: false }, features: {} } as never;
    });

    it('applies only the tapped part to the captured task', async () => {
      const tree = await mountWithSuggestion();

      await act(async () => {
        findChip(tree, '@phone').props.onPress();
      });

      await act(async () => {
        await findTouchableByText(tree, 'Save').props.onPress();
      });

      expect(storeState.addTask).toHaveBeenCalledWith('Shared text', {
        status: 'inbox',
        contexts: ['@phone'],
      });
    });

    it('applies the remaining parts through apply all', async () => {
      const tree = await mountWithSuggestion();

      await act(async () => {
        findChip(tree, '@phone').props.onPress();
      });
      await act(async () => {
        findChip(tree, 'copilot.applyAll').props.onPress();
      });

      await act(async () => {
        await findTouchableByText(tree, 'Save').props.onPress();
      });

      expect(storeState.addTask).toHaveBeenCalledWith('Shared text', {
        status: 'inbox',
        contexts: ['@phone'],
        tags: ['#health'],
        timeEstimate: '15min',
      });
    });
  });
});
