import React from 'react';
import { Alert, Keyboard, Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuickCaptureSheet } from './quick-capture-sheet';

const selectedAreaIdForNewTasksMock = vi.hoisted(() => ({ current: undefined as string | null | undefined }));

const {
  addTask,
  addTasks,
  addProject,
  updateSettings,
  showToast,
  openTaskScreen,
  getUsedTaskTokens,
  getDerivedState,
  parseQuickAdd,
  splitQuickAddBulkLines,
  selectStore,
  documentPickerGetDocumentAsync,
  fileSystemReadAsStringAsync,
  createMobileRecoverySnapshot,
} = vi.hoisted(() => {
  const addTask = vi.fn();
  const addTasks = vi.fn();
  const addProject = vi.fn();
  const updateSettings = vi.fn();
  const showToast = vi.fn();
  const openTaskScreen = vi.fn();
  const getUsedTaskTokens = vi.fn<() => string[]>(() => []);
  const getDerivedState = vi.fn(() => ({ focusedCount: 0 }));
  const parseQuickAdd = vi.fn<(input: string) => any>((input: string) => ({
    title: input,
    props: {},
    invalidDateCommands: [],
  }));
  const splitQuickAddBulkLines = vi.fn((input: string) => input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean));
  const documentPickerGetDocumentAsync = vi.fn();
  const fileSystemReadAsStringAsync = vi.fn();
  const createMobileRecoverySnapshot = vi.fn();
  const storeState = {
    addTask,
    addTasks,
    addProject,
    updateSettings,
    areas: [],
    projects: [],
    settings: {},
    tasks: [],
    getDerivedState,
  };
  const selectStore = ((selector?: (state: typeof storeState) => unknown) => (
    selector ? selector(storeState) : storeState
  )) as any;
  selectStore.getState = () => storeState;
  return {
    addTask,
    addTasks,
    addProject,
    updateSettings,
    showToast,
    openTaskScreen,
    getUsedTaskTokens,
    getDerivedState,
    parseQuickAdd,
    splitQuickAddBulkLines,
    selectStore,
    documentPickerGetDocumentAsync,
    fileSystemReadAsStringAsync,
    createMobileRecoverySnapshot,
  };
});

vi.mock('@mindwtr/core', async () => {
  // The shared capture transaction is real; only its store actions are substituted.
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const sessionActual = await vi.importActual<typeof import('../../../packages/core/src/capture-session')>(
    '../../../packages/core/src/capture-session'
  );
  return {
  CaptureSessionCoordinator: sessionActual.CaptureSessionCoordinator,
  executeCaptureTransaction: actual.executeCaptureTransaction,
  prepareCaptureTask: actual.prepareCaptureTask,
  buildQuickAddParseOptions: actual.buildQuickAddParseOptions,
  buildQuickAddPreviewEntries: actual.buildQuickAddPreviewEntries,
  DEFAULT_PROJECT_COLOR: actual.DEFAULT_PROJECT_COLOR,
  getDefaultTaskAreaMode: (settings: any) => {
    const mode = settings?.gtd?.defaultAreaMode;
    if (mode === 'none' || mode === 'fixed' || mode === 'active') return mode;
    return settings?.gtd?.defaultAreaId ? 'fixed' : 'none';
  },
  getQuickAddProjectInitialProps: (props: any, fallbackAreaId?: string | null) => {
    const areaId = props?.areaId || fallbackAreaId || undefined;
    return areaId ? { areaId } : undefined;
  },
  getUsedTaskTokens,
  formatFocusTaskLimitText: (template: string, limit: number) => template.replace('{{count}}', String(limit)),
  canStarNewCapture: ({ focusedCount, focusTaskLimit }: { focusedCount: number; focusTaskLimit: number }) => focusedCount < focusTaskLimit,
  hasTimeComponent: (value?: string | null) => Boolean(value && /[T\s]\d{2}:\d{2}/.test(value)),
  isNaturalLanguageDatesEnabled: (settings?: { gtd?: { naturalLanguageDates?: boolean } } | null) =>
    settings?.gtd?.naturalLanguageDates !== false,
  isSelectableProjectForTaskAssignment: (project: any) => (
    !project.deletedAt && project.status !== 'archived' && project.status !== 'completed'
  ),
  parseQuickAdd,
  normalizeClockTimeInput: (value?: string | null) => String(value ?? '').trim(),
  normalizeFocusTaskLimit: (value: unknown) => (typeof value === 'number' ? value : 3),
  resolveDefaultNewTaskAreaId: (settings: any, areas: any[]) => {
    const mode = settings?.gtd?.defaultAreaMode ?? (settings?.gtd?.defaultAreaId ? 'fixed' : 'none');
    if (mode !== 'fixed') return undefined;
    const areaId = settings?.gtd?.defaultAreaId;
    return typeof areaId === 'string' && areas.some((area) => area.id === areaId && !area.deletedAt)
      ? areaId
      : undefined;
  },
  resolveFeatureFlags: actual.resolveFeatureFlags,
  splitQuickAddBulkLines,
  safeFormatDate: (value: Date | string, formatStr: string) => {
    const date = value instanceof Date ? value : new Date(value);
    if (formatStr === 'p') {
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
    if (formatStr !== 'yyyy-MM-dd') return '';
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  },
  safeParseDate: () => null,
  shallow: (left: unknown, right: unknown) => left === right,
  tFallback: (t: (key: string) => string, key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  },
  useTaskStore: selectStore,
};
});

const mockThemeTokens = vi.hoisted(() => ({
  value: { isMaterial: false, roles: null, shape: { large: 16 } } as {
    isMaterial: boolean;
    roles: Record<string, string> | null;
    shape: { large: number };
  },
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: documentPickerGetDocumentAsync,
}));

vi.mock('expo-file-system', () => ({
  readAsStringAsync: fileSystemReadAsStringAsync,
}));

vi.mock('../lib/recovery-snapshot', () => ({
  createMobileRecoverySnapshot,
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    useWindowDimensions: () => ({
      fontScale: 1,
      height: 800,
      scale: 1,
      width: 400,
    }),
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'common.notice': 'Notice',
      'agenda.addToFocus': "Add to today's focus",
      'agenda.maxFocusItems': 'Max {{count}} focus items',
      'agenda.removeFromFocus': 'Remove from focus',
      'quickAdd.invalidDateCommand': 'Invalid date',
      'taskEdit.contextsLabel': 'Contexts',
      'taskEdit.dueDateLabel': 'Due Date',
      'taskEdit.noAreaOption': 'No Area',
      'taskEdit.priorityLabel': 'Priority',
      'taskEdit.projectLabel': 'Project',
    }[key] ?? key),
  }),
}));

vi.mock('@/contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({ showToast }),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({ selectedAreaIdForNewTasks: selectedAreaIdForNewTasksMock.current }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    border: '#334155',
    cardBg: '#111827',
    filterBg: '#1f2937',
    inputBg: '#0f172a',
    onTint: '#ffffff',
    secondaryText: '#94a3b8',
    text: '#f8fafc',
    tint: '#3b82f6',
  }),
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => mockThemeTokens.value,
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openTaskScreen,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('./use-quick-capture-audio', () => ({
  useQuickCaptureAudio: () => ({
    recording: false,
    recordingBusy: false,
    recordingReady: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

vi.mock('./quick-capture-sheet/QuickCaptureSheetBody', () => ({
  QuickCaptureSheetBody: (props: Record<string, unknown>) => React.createElement('QuickCaptureSheetBody', props),
}));

vi.mock('./quick-capture-sheet/QuickCaptureSheetPickers', () => ({
  QuickCaptureSheetPickers: (props: Record<string, unknown>) => React.createElement('QuickCaptureSheetPickers', props),
}));

const withPlatform = async (os: typeof Platform.OS, run: () => Promise<void>) => {
  const originalPlatformOs = Platform.OS;
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: os,
  });
  try {
    await run();
  } finally {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: originalPlatformOs,
    });
  }
};

describe('QuickCaptureSheet save handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  beforeEach(() => {
    addTask.mockReset();
    addTasks.mockReset();
    addProject.mockReset();
    updateSettings.mockReset();
    showToast.mockReset();
    selectStore.getState().areas = [];
    selectStore.getState().projects = [];
    selectStore.getState().tasks = [];
    selectStore.getState().settings = {};
    selectedAreaIdForNewTasksMock.current = undefined;
    getDerivedState.mockClear();
    getDerivedState.mockReturnValue({ focusedCount: 0 });
    getUsedTaskTokens.mockClear();
    getUsedTaskTokens.mockReturnValue([]);
    documentPickerGetDocumentAsync.mockReset();
    fileSystemReadAsStringAsync.mockReset();
    createMobileRecoverySnapshot.mockReset();
    createMobileRecoverySnapshot.mockResolvedValue('data.snapshot.json');
    parseQuickAdd.mockReset();
    parseQuickAdd.mockImplementation((input: string) => ({
      title: input,
      props: {},
      invalidDateCommands: [],
    }));
    mockThemeTokens.value = { isMaterial: false, roles: null, shape: { large: 16 } };
  });

  it('uses primaryContainer for the save button under Material, below the high-emphasis capture FAB', async () => {
    mockThemeTokens.value = {
      isMaterial: true,
      roles: { primaryContainer: '#00458B', onPrimaryContainer: '#D7E2FF' },
      shape: { large: 16 },
    };

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet visible openRequestId={1} initialValue="" onClose={vi.fn()} />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    expect(body.props.saveButtonBackgroundColor).toBe('#00458B');
    expect(body.props.saveButtonTextColor).toBe('#D7E2FF');
  });

  it('keeps the save button on the primary tint under non-Material themes', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet visible openRequestId={1} initialValue="" onClose={vi.fn()} />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    expect(body.props.saveButtonBackgroundColor).toBe('#3b82f6');
    expect(body.props.saveButtonTextColor).toBe('#ffffff');
  });

  it('opens organize options collapsed for global capture', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue=""
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    expect(body.props.optionsExpanded).toBe(false);
    expect(getUsedTaskTokens).not.toHaveBeenCalled();
  });

  it('keeps the sheet lifted until the Android keyboard finishes hiding, then expands', async () => {
    vi.useFakeTimers();
    const keyboardDismiss = vi.spyOn(Keyboard, 'dismiss').mockImplementation(vi.fn());
    vi.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    const hideListeners: (() => void)[] = [];
    const showListeners: (() => void)[] = [];
    const removeListener = vi.fn();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, cb: () => void) => {
      if (event === 'keyboardDidHide') hideListeners.push(cb);
      if (event === 'keyboardDidShow') showListeners.push(cb);
      return { remove: removeListener };
    }) as unknown as typeof Keyboard.addListener);

    await withPlatform('android', async () => {
      let tree!: ReturnType<typeof create>;
      await act(async () => {
        tree = create(
          <QuickCaptureSheet
            visible
            openRequestId={1}
            initialValue=""
            onClose={vi.fn()}
          />
        );
        await Promise.resolve();
      });

      const getBody = () => {
        const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
        if (!body) throw new Error('QuickCaptureSheetBody not found');
        return body;
      };

      expect(getBody().props.optionsExpanded).toBe(false);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(true);

      const focus = vi.fn();
      const blur = vi.fn();
      getBody().props.inputRef.current = { blur, focus };

      // Ignore the baseline keyboard-inset listeners registered on mount; this
      // test only cares about the keyboardDidHide gate the More toggle adds.
      hideListeners.length = 0;
      showListeners.length = 0;

      await act(async () => {
        getBody().props.onToggleOptions();
        await Promise.resolve();
      });

      // The keyboard is dismissed, but the lift must stay on and the sheet must
      // stay collapsed until the keyboard is actually gone. Dropping the lift now
      // would slam the sheet behind the still-visible keyboard (the flicker).
      expect(keyboardDismiss).toHaveBeenCalledOnce();
      expect(blur).toHaveBeenCalledOnce();
      expect(hideListeners).toHaveLength(1);
      expect(getBody().props.optionsExpanded).toBe(false);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(true);

      // A premature timer must not expand the sheet on its own; only the keyboard
      // hide event (or the far safety-net) may.
      await act(async () => {
        vi.advanceTimersByTime(160);
        await Promise.resolve();
      });
      expect(getBody().props.optionsExpanded).toBe(false);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(true);

      // Keyboard finished hiding: now expand and drop the lift together.
      await act(async () => {
        hideListeners.forEach((cb) => cb());
        await Promise.resolve();
      });

      expect(focus).not.toHaveBeenCalled();
      expect(getBody().props.optionsExpanded).toBe(true);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(false);
      expect(removeListener).toHaveBeenCalled();
      expect(showListeners).toHaveLength(1);

      await act(async () => {
        showListeners.forEach((cb) => cb());
        await Promise.resolve();
      });

      expect(getBody().props.optionsExpanded).toBe(true);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(true);

      await act(async () => {
        getBody().props.onToggleOptions();
        await Promise.resolve();
      });

      expect(getBody().props.optionsExpanded).toBe(false);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(true);
    });
  });

  it('expands Android organize options immediately when the keyboard is already hidden', async () => {
    vi.useFakeTimers();
    vi.spyOn(Keyboard, 'dismiss').mockImplementation(vi.fn());
    vi.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    const addListener = vi.spyOn(Keyboard, 'addListener');

    await withPlatform('android', async () => {
      let tree!: ReturnType<typeof create>;
      await act(async () => {
        tree = create(
          <QuickCaptureSheet
            visible
            openRequestId={1}
            initialValue=""
            onClose={vi.fn()}
          />
        );
        await Promise.resolve();
      });

      const getBody = () => {
        const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
        if (!body) throw new Error('QuickCaptureSheetBody not found');
        return body;
      };

      getBody().props.inputRef.current = { blur: vi.fn(), focus: vi.fn() };

      // Drop the baseline keyboard-inset listeners registered on mount so we can
      // assert the More toggle adds only the refocus guard.
      addListener.mockClear();

      await act(async () => {
        getBody().props.onToggleOptions();
        await Promise.resolve();
      });

      expect(addListener).toHaveBeenCalledWith('keyboardDidShow', expect.any(Function));
      expect(getBody().props.optionsExpanded).toBe(true);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(false);
    });
  });

  it('loads context autocomplete only after the context picker opens', async () => {
    vi.useFakeTimers();
    getUsedTaskTokens.mockReturnValue(['@computer']);

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue=""
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    expect(getUsedTaskTokens).not.toHaveBeenCalled();

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    await act(async () => {
      body.props.onOpenContextPicker();
      await Promise.resolve();
    });

    expect(getUsedTaskTokens).not.toHaveBeenCalled();

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(getUsedTaskTokens).toHaveBeenCalledTimes(1);
    const pickers = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetPickers')[0];
    if (!pickers) throw new Error('QuickCaptureSheetPickers not found');
    expect(pickers.props.filteredContexts).toEqual(['@computer']);
    expect(pickers.props.contextOptionsLoading).toBe(false);
  });

  it('previews the draft with the exact parse configuration its save runs', async () => {
    addTask.mockResolvedValue({ success: true, id: 'task-1' });
    parseQuickAdd.mockImplementation((input: string) => ({
      title: input,
      props: { contexts: ['@errands'] },
      invalidDateCommands: [],
    }));

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet visible openRequestId={1} initialValue="" onClose={vi.fn()} />
      );
      await Promise.resolve();
    });

    const getBody = () => {
      const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
      if (!body) throw new Error('QuickCaptureSheetBody not found');
      return body;
    };

    await act(async () => {
      getBody().props.onValueChange('call mom @errands');
      await Promise.resolve();
    });

    // The strip is fed by the draft, live.
    expect(getBody().props.preview).toBeTruthy();
    expect(getBody().props.preview.props.entries).toEqual([
      expect.objectContaining({ kind: 'context', value: '@errands' }),
    ]);

    const parseCalls = parseQuickAdd.mock.calls as unknown as unknown[][];
    const previewCalls = parseCalls.length;
    const previewCall = parseCalls[previewCalls - 1];
    expect(previewCall[0]).toBe('call mom @errands');

    await act(async () => {
      getBody().props.handleSave();
      await Promise.resolve();
    });

    const saveCall = parseCalls[previewCalls];
    expect(saveCall).toBeDefined();
    expect(saveCall[0]).toBe(previewCall[0]);
    // Same options object, not a look-alike rebuilt at save time.
    expect(saveCall[4]).toBe(previewCall[4]);
    expect(addTask).toHaveBeenCalled();
  });

  it('knows a multi-word context created earlier in the same capture burst', async () => {
    // Real parsing: the point is which tokens the SECOND capture recognizes,
    // which depends on the known-token bag being rebuilt between captures.
    const core = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    parseQuickAdd.mockImplementation(core.parseQuickAdd as never);
    addTask.mockImplementation(async (title: string, props: Record<string, unknown>) => {
      selectStore.getState().tasks.push({ id: `task-${title}`, title, ...props } as never);
      return { success: true, id: `task-${title}` };
    });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet visible openRequestId={1} initialValue="" onClose={vi.fn()} />
      );
      await Promise.resolve();
    });

    const getBody = () => {
      const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
      if (!body) throw new Error('QuickCaptureSheetBody not found');
      return body;
    };

    await act(async () => {
      getBody().props.onToggleAddAnother(true);
      await Promise.resolve();
    });

    await act(async () => {
      getBody().props.onValueChange('plan review @"deep work"');
      await Promise.resolve();
    });
    await act(async () => {
      getBody().props.handleSave();
      await Promise.resolve();
    });
    expect(addTask).toHaveBeenLastCalledWith('plan review', expect.objectContaining({
      contexts: ['@deep work'],
    }));

    // Second capture of the burst: the sheet never closed, so only a refreshed
    // bag can tokenize the unquoted form.
    await act(async () => {
      getBody().props.onValueChange('write notes @deep work');
      await Promise.resolve();
    });
    await act(async () => {
      getBody().props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenLastCalledWith('write notes', expect.objectContaining({
      contexts: ['@deep work'],
    }));
  });

  it('keeps the strip away when the draft is a plain title', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet visible openRequestId={1} initialValue="call mom" onClose={vi.fn()} />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    expect(body.props.preview).toBeNull();
  });

  it('ignores duplicate save presses while the first save is in flight', async () => {
    let resolveAddTask: ((value: unknown) => void) | null = null;
    addTask.mockImplementation(() => new Promise((resolve) => {
      resolveAddTask = resolve;
    }));

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Double tap task"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    await act(async () => {
      body.props.handleSave();
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith('Double tap task', expect.objectContaining({ status: 'inbox' }));
    expect(tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0]?.props.saving).toBe(true);

    await act(async () => {
      resolveAddTask?.({ success: true, id: 'task-1' });
      await Promise.resolve();
    });
  });

  it('does not let a stale save close or clear a reopened capture session', async () => {
    let resolveAddTask: ((value: unknown) => void) | null = null;
    addTask.mockImplementation(() => new Promise((resolve) => {
      resolveAddTask = resolve;
    }));
    const onClose = vi.fn();

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="First capture"
          onClose={onClose}
        />
      );
      await Promise.resolve();
    });

    const firstBody = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!firstBody) throw new Error('QuickCaptureSheetBody not found');
    await act(async () => {
      firstBody.props.handleSave();
      await Promise.resolve();
    });

    await act(async () => {
      tree.update(
        <QuickCaptureSheet
          visible={false}
          openRequestId={1}
          initialValue="First capture"
          onClose={onClose}
        />
      );
      tree.update(
        <QuickCaptureSheet
          visible
          openRequestId={2}
          initialValue="Second capture"
          onClose={onClose}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      resolveAddTask?.({ success: true, id: 'task-1' });
      await Promise.resolve();
    });

    const reopenedBody = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!reopenedBody) throw new Error('QuickCaptureSheetBody not found');
    expect(onClose).not.toHaveBeenCalled();
    expect(reopenedBody.props.value).toBe('Second capture');
    expect(reopenedBody.props.saving).toBe(false);
  });

  it("stars a task for Today's Focus from the capture sheet", async () => {
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="File Q3 estimated tax payment"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    expect(body.props.focusNewTask).toBe(false);

    await act(async () => {
      body.props.onToggleFocusNewTask();
      await Promise.resolve();
    });

    const updatedBody = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!updatedBody) throw new Error('QuickCaptureSheetBody not found after toggle');
    expect(updatedBody.props.focusNewTask).toBe(true);

    await act(async () => {
      updatedBody.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('File Q3 estimated tax payment', expect.objectContaining({
      status: 'inbox',
      isFocusedToday: true,
    }));
  });

  // The confirm is rendered inside the capture sheet's own modal. It used to go
  // through Alert.alert, which on iOS stacked a second native presentation on
  // the sheet and never became visible — a .txt import looked like it silently
  // did nothing (#940). These tests pin the in-sheet confirm and that no Alert
  // is raised from the sheet at all.
  const findBulkConfirm = (tree: ReturnType<typeof create>) => (
    tree.root.findAll((node) => (node.type as { name?: string })?.name === 'BulkQuickAddConfirm')[0]
  );

  it('confirms multiline capture before creating one task per line', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(vi.fn());
    addTask.mockResolvedValue({ success: true, id: 'task-1' });
    parseQuickAdd.mockImplementation((input: string) => ({
      title: input.replace(/\s+\/next$/u, ''),
      props: input.endsWith('/next') ? { status: 'next' } : {},
      invalidDateCommands: [],
    }));

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue={'Email Bob\n\nCall Alice /next'}
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();

    const confirm = findBulkConfirm(tree);
    if (!confirm) throw new Error('Bulk confirm not rendered in the sheet');
    expect(confirm.props.title).toBe('Create 2 tasks?');
    expect(confirm.props.message).toContain('Email Bob');

    await act(async () => {
      confirm.props.onConfirm();
      await Promise.resolve();
    });

    expect(addTask).not.toHaveBeenCalled();
    expect(addTasks).toHaveBeenCalledTimes(1);
    expect(createMobileRecoverySnapshot).toHaveBeenCalledOnce();
    expect(createMobileRecoverySnapshot.mock.invocationCallOrder[0])
      .toBeLessThan(addTasks.mock.invocationCallOrder[0]);
    expect(addTasks).toHaveBeenCalledWith([
      { title: 'Email Bob', initialProps: expect.objectContaining({ status: 'inbox' }) },
      { title: 'Call Alice', initialProps: expect.objectContaining({ status: 'next' }) },
    ]);
  });

  it('dismisses bulk confirmation on modal request close without closing the sheet', async () => {
    const onClose = vi.fn();
    const draft = 'Email Bob\n\nCall Alice /next';

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue={draft}
          onClose={onClose}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    const pendingBody = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!pendingBody) throw new Error('QuickCaptureSheetBody not found');
    expect(findBulkConfirm(tree)).toBeTruthy();
    expect(pendingBody.props.contentAccessibilityHidden).toBe(true);

    await act(async () => {
      pendingBody.props.handleRequestClose();
      await Promise.resolve();
    });

    const restoredBody = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!restoredBody) throw new Error('QuickCaptureSheetBody not found');
    expect(findBulkConfirm(tree)).toBeUndefined();
    expect(restoredBody.props.contentAccessibilityHidden).toBe(false);
    expect(restoredBody.props.value).toBe(draft);
    expect(onClose).not.toHaveBeenCalled();
    expect(addTasks).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('imports a text file through the in-sheet bulk confirmation', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(vi.fn());
    addTask.mockResolvedValue({ success: true, id: 'task-1' });
    documentPickerGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ name: 'tasks.txt', uri: 'file://tasks.txt', mimeType: 'text/plain' }],
    });
    fileSystemReadAsStringAsync.mockResolvedValue('First imported task\nSecond imported task\n');

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue=""
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      await body.props.handleImportTextFile();
      await Promise.resolve();
    });

    expect(documentPickerGetDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({
      multiple: false,
      type: 'text/plain',
    }));
    expect(fileSystemReadAsStringAsync).toHaveBeenCalledWith('file://tasks.txt');

    const confirm = findBulkConfirm(tree);
    if (!confirm) throw new Error('Bulk confirm not rendered in the sheet');
    expect(confirm.props.title).toBe('Create 2 tasks?');
    expect(confirm.props.message).toContain('First imported task');

    await act(async () => {
      confirm.props.onConfirm();
      await Promise.resolve();
    });

    expect(addTask).not.toHaveBeenCalled();
    expect(addTasks).toHaveBeenCalledTimes(1);
    expect(addTasks).toHaveBeenCalledWith([
      { title: 'First imported task', initialProps: expect.objectContaining({ status: 'inbox' }) },
      { title: 'Second imported task', initialProps: expect.objectContaining({ status: 'inbox' }) },
    ]);
  });

  it('never raises a native Alert for an iOS import confirmation', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(vi.fn());
    documentPickerGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ name: 'tasks.txt', uri: 'file://tasks.txt', mimeType: 'text/plain' }],
    });
    fileSystemReadAsStringAsync.mockResolvedValue('First imported task\nSecond imported task\n');

    await withPlatform('ios', async () => {
      let tree!: ReturnType<typeof create>;
      await act(async () => {
        tree = create(
          <QuickCaptureSheet
            visible
            openRequestId={1}
            initialValue=""
            onClose={vi.fn()}
          />
        );
        await Promise.resolve();
      });

      const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
      if (!body) throw new Error('QuickCaptureSheetBody not found');

      await act(async () => {
        await body.props.handleImportTextFile();
        await Promise.resolve();
      });

      // No delay, no Alert: the confirm is already on screen inside the sheet.
      expect(alertSpy).not.toHaveBeenCalled();
      expect(findBulkConfirm(tree)?.props.title).toBe('Create 2 tasks?');
    });
  });

  it('creates nothing when the bulk confirmation is dismissed', async () => {
    documentPickerGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ name: 'tasks.txt', uri: 'file://tasks.txt', mimeType: 'text/plain' }],
    });
    fileSystemReadAsStringAsync.mockResolvedValue('First imported task\nSecond imported task\n');

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue=""
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      await body.props.handleImportTextFile();
      await Promise.resolve();
    });

    const confirm = findBulkConfirm(tree);
    if (!confirm) throw new Error('Bulk confirm not rendered in the sheet');

    await act(async () => {
      confirm.props.onCancel();
      await Promise.resolve();
    });

    expect(findBulkConfirm(tree)).toBeUndefined();
    expect(addTasks).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('opens the created task when save and edit is requested', async () => {
    addTask.mockResolvedValueOnce({ success: true, id: 'task-new' });
    const onClose = vi.fn();
    selectStore.getState().projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Draft launch brief"
          initialProps={{ projectId: 'project-1', status: 'next' }}
          onClose={onClose}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    await act(async () => {
      body.props.handleSaveAndEdit();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('Draft launch brief', expect.objectContaining({
      projectId: 'project-1',
      status: 'next',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openTaskScreen).toHaveBeenCalledWith('task-new', 'project-1', 'task');
  });

  it('uses the selected area filter for new captures in active area mode', async () => {
    selectedAreaIdForNewTasksMock.current = 'area-work';
    selectStore.getState().areas = [
      { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
      { id: 'area-work', name: 'Work', order: 1, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
    ];
    selectStore.getState().settings = { gtd: { defaultAreaMode: 'active', defaultAreaId: 'area-home' } };
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Area-filtered task"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('Area-filtered task', expect.objectContaining({
      areaId: 'area-work',
      status: 'inbox',
    }));
  });

  it('uses the fixed GTD default area before the selected area filter in fixed area mode', async () => {
    selectedAreaIdForNewTasksMock.current = 'area-work';
    selectStore.getState().areas = [
      { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
      { id: 'area-work', name: 'Work', order: 1, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
    ];
    selectStore.getState().settings = { gtd: { defaultAreaMode: 'fixed', defaultAreaId: 'area-home' } };
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Fixed-default task"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('Fixed-default task', expect.objectContaining({
      areaId: 'area-home',
      status: 'inbox',
    }));
  });

  it('does not apply the GTD default area while the no-area filter is active', async () => {
    selectedAreaIdForNewTasksMock.current = null;
    selectStore.getState().areas = [
      { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
    ];
    selectStore.getState().settings = { gtd: { defaultAreaMode: 'active', defaultAreaId: 'area-home' } };
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="No-area task"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    const savedProps = addTask.mock.calls[0]?.[1] as { areaId?: string } | undefined;
    expect(savedProps?.areaId).toBeUndefined();
  });

  it('saves picker due dates as date-only values', async () => {
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Plan the day"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const pickers = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetPickers')[0];
    if (!pickers) throw new Error('QuickCaptureSheetPickers not found');

    await act(async () => {
      pickers.props.onDueDateChange({ type: 'set' }, new Date(2026, 4, 10, 14, 37, 0, 0));
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith('Plan the day', expect.objectContaining({
      dueDate: '2026-05-10',
      status: 'inbox',
    }));
  });

  it('previews the picked due date instead of the one the text parsed to', async () => {
    parseQuickAdd.mockReturnValue({
      title: 'Ship the build',
      props: { dueDate: '2026-05-04' },
      invalidDateCommands: [],
    });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Ship the build /due:monday"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const dueChip = () => {
      const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
      const entries = (body?.props?.preview?.props?.entries ?? []) as { kind: string; value: string }[];
      return entries.find((entry) => entry.kind === 'due')?.value;
    };

    expect(dueChip()).toContain('2026');

    const pickers = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetPickers')[0];
    if (!pickers) throw new Error('QuickCaptureSheetPickers not found');
    await act(async () => {
      pickers.props.onDueDateChange({ type: 'set' }, new Date(2027, 2, 5, 9, 0, 0, 0));
      await Promise.resolve();
    });

    expect(dueChip()).toContain('2027');
  });

  it('saves picker due times only after the user explicitly selects one', async () => {
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Call the office"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const pickers = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetPickers')[0];
    if (!pickers) throw new Error('QuickCaptureSheetPickers not found');

    await act(async () => {
      pickers.props.onDueDateChange({ type: 'set' }, new Date(2026, 4, 10, 14, 37, 0, 0));
      await Promise.resolve();
    });

    const refreshedPickers = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetPickers')[0];
    if (!refreshedPickers) throw new Error('QuickCaptureSheetPickers not found');
    await act(async () => {
      refreshedPickers.props.onDueTimeChange({ type: 'set' }, new Date(2026, 4, 10, 16, 15, 0, 0));
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith('Call the office', expect.objectContaining({
      dueDate: new Date(2026, 4, 10, 16, 15, 0, 0).toISOString(),
      status: 'inbox',
    }));
  });

  it('creates parsed quick-add projects inside the parsed area', async () => {
    addProject.mockResolvedValue({ id: 'project-launch' });
    addTask.mockResolvedValue({ success: true, id: 'task-1' });
    parseQuickAdd.mockReturnValue({
      title: 'Plan campaign',
      props: { areaId: 'area-work' },
      projectTitle: 'Launch',
      invalidDateCommands: [],
    });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Plan campaign +Launch !Work"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addProject).toHaveBeenCalledWith('Launch', '#94a3b8', { areaId: 'area-work' });
    expect(addTask).toHaveBeenCalledWith('Plan campaign', expect.objectContaining({
      projectId: 'project-launch',
      areaId: undefined,
    }));
  });

  it('keeps project initial props when saving and adding another', async () => {
    selectStore.getState().projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];
    addTask.mockResolvedValue({ success: true, id: 'task-1' });
    const onClose = vi.fn();

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="First task"
          initialProps={{ projectId: 'project-1', status: 'next' }}
          onClose={onClose}
        />
      );
      await Promise.resolve();
    });

    const getBody = () => {
      const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
      if (!body) throw new Error('QuickCaptureSheetBody not found');
      return body;
    };

    await act(async () => {
      getBody().props.onToggleAddAnother(true);
      await Promise.resolve();
    });

    await act(async () => {
      getBody().props.handleSave();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('First task', expect.objectContaining({
      projectId: 'project-1',
      status: 'next',
    }));
    expect(getBody().props.value).toBe('');
    expect(getBody().props.projectLabel).toBe('Launch');
    expect(getBody().props.projectSelected).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      getBody().props.onValueChange('Second task');
      await Promise.resolve();
    });
    await act(async () => {
      getBody().props.handleSave();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenLastCalledWith('Second task', expect.objectContaining({
      projectId: 'project-1',
      status: 'next',
    }));
    expect(onClose).not.toHaveBeenCalled();
  });
  it('saves the More-panel note as the task description', async () => {
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Renew passport"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const getBody = () => {
      const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
      if (!body) throw new Error('QuickCaptureSheetBody not found');
      return body;
    };

    expect(getBody().props.noteValue).toBe('');

    await act(async () => {
      getBody().props.onNoteChange('  Bring the old one and two photos  ');
      await Promise.resolve();
    });

    await act(async () => {
      getBody().props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('Renew passport', expect.objectContaining({
      description: 'Bring the old one and two photos',
      status: 'inbox',
    }));
  });

  it('keeps a /note: token typed in the title after the note field text', async () => {
    addTask.mockResolvedValue({ success: true, id: 'task-1' });
    parseQuickAdd.mockReturnValue({
      title: 'Renew passport',
      props: { description: 'from the token' },
      invalidDateCommands: [],
    });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Renew passport /note: from the token"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const getBody = () => {
      const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
      if (!body) throw new Error('QuickCaptureSheetBody not found');
      return body;
    };

    await act(async () => {
      getBody().props.onNoteChange('typed in the field');
      await Promise.resolve();
    });

    await act(async () => {
      getBody().props.handleSave();
      await Promise.resolve();
    });

    // Same merge as the full capture screen: neither note is dropped, the typed
    // field leads.
    expect(addTask).toHaveBeenCalledWith('Renew passport', expect.objectContaining({
      description: 'typed in the field\nfrom the token',
    }));
  });
});
