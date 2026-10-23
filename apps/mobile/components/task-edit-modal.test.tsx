import React from 'react';
import { Alert, AppState, Modal, Platform, type AppStateStatus } from 'react-native';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { NavigationContext } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import * as attachmentSync from '../lib/attachment-sync';

import {
  archiveSectionForProjectArchive,
  isTaskFutureFocusCandidate,
  type Project,
  type Section,
  type Task,
} from '@mindwtr/core';

import { AdaptiveWindowContextProvider } from './adaptive-window-context';
import { resolveAdaptiveWindow } from '../lib/adaptive-window';

import { restoreRecoveredTaskEditInput, TaskEditModal } from './task-edit-modal';
import { TaskEditCustomRecurrenceModal } from './task-edit/TaskEditCustomRecurrenceModal';
import { MarkdownFormatToolbar } from './markdown-format-toolbar';
import { syncTaskEditPagerPosition } from './task-edit/task-edit-modal.utils';

vi.mock('@react-navigation/native', async () => {
  const { createContext } = await import('react');
  return { NavigationContext: createContext(undefined) };
});

const referenceClipboard = vi.hoisted(() => ({ write: vi.fn(), toast: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: referenceClipboard.write }));

const taskEditStore = vi.hoisted(() => ({ current: null as Record<string, any> | null }));
const taskOpenPreference = vi.hoisted(() => ({
  current: { hydrated: true, mode: 'automatic' as 'automatic' | 'preview' | 'edit' },
}));

vi.mock('@/lib/view-state/task-open-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/view-state/task-open-mode')>();
  return {
    ...actual,
    useTaskOpenMode: () => ({ ...taskOpenPreference.current, setMode: vi.fn() }),
  };
});

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const storeState = {
    tasks: [],
    projects: [{
      id: 'project-1',
      title: 'Project',
      status: 'active',
      color: '#3b82f6',
      order: 0,
      tagIds: [],
      areaId: 'area-1',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }] as Project[],
    sections: [],
    _allSections: [],
    _allTasks: [],
    _tasksById: new Map<string, Task>(),
    _allProjects: [] as Project[],
    areas: [],
    settings: { features: {}, ai: {}, gtd: { taskEditor: { order: [], hidden: [] } } },
    duplicateTask: vi.fn(),
    resetTaskChecklist: vi.fn(),
    addProject: vi.fn(),
    addSection: vi.fn(),
    addArea: vi.fn(),
    cancelTask: vi.fn(),
    deleteTask: vi.fn(),
    lockEditing: vi.fn(),
    unlockEditing: vi.fn(),
    getDerivedState: () => ({
      allContexts: [],
      allTags: [],
      contextTokenUsage: [],
      tagTokenUsage: [],
      activeTasksByStatus: new Map([['next', storeState.tasks]]),
      projectMap: new Map(storeState.projects.map((project) => [project.id, project])),
      focusedCount: storeState.tasks.filter((task: Task) => task.isFocusedToday && !actual.isTaskFutureFocusCandidate(task)).length,
      sequentialProjectIds: new Set<string>(),
      sequentialWithinSectionProjectIds: new Set<string>(),
    }),
  };
  storeState._allProjects = storeState.projects;
  taskEditStore.current = storeState;
  const useTaskStore = Object.assign((selector?: (state: typeof storeState) => unknown) => (
    selector ? selector(storeState) : storeState
  ), {
    getState: () => storeState,
  });
  return {
    ...actual,
    useTaskStore,
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('../contexts/toast-context', () => ({
  useToast: () => ({
    showToast: referenceClipboard.toast,
    dismissToast: vi.fn(),
  }),
  ToastViewport: () => null,
}));

vi.mock('../hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { medium: 10 } }),
}));

vi.mock('@/hooks/use-theme-colors', () => {
  // One object, like the real hook: resolveThemeTokens caches its result, so a
  // fresh literal per call would fake instability the app never sees (#766).
  const themeColors = {
    bg: '#000',
    cardBg: '#111',
    taskItemBg: '#111',
    inputBg: '#111',
    filterBg: '#222',
    border: '#333',
    text: '#fff',
    secondaryText: '#aaa',
    icon: '#aaa',
    tint: '#3b82f6',
    onTint: '#fff',
    tabIconDefault: '#aaa',
    tabIconSelected: '#3b82f6',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  };
  return { useThemeColors: () => themeColors };
});

vi.mock('../lib/ai-config', () => ({
  loadAIKey: vi.fn().mockResolvedValue(''),
  isAIKeyRequired: vi.fn().mockReturnValue(false),
  buildAIConfig: vi.fn().mockReturnValue({}),
  buildCopilotConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('./task-edit/TaskEditViewTab', () => ({
  TaskEditViewTab: (props: any) => React.createElement('TaskEditViewTab', props),
}));

vi.mock('./task-edit/TaskEditFormTab', () => ({
  // The Focus star sits in the form's Title row; render it so tests can press it.
  TaskEditFormTab: (props: any) => React.createElement('TaskEditFormTab', props, props.focusStar
    ? React.createElement('FocusStar', {
      testID: 'task-edit-focus-star',
      onPress: props.focusStar.onToggle,
      accessibilityLabel: props.focusStar.label,
      accessibilityState: { disabled: props.focusStar.disabled, selected: props.focusStar.focused },
    })
    : null),
}));

vi.mock('./completed-at-picker', () => ({
  CompletedAtPicker: (props: any) => React.createElement('CompletedAtPicker', props),
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: (props: any) => React.createElement('DateTimePicker', props, props.children),
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn().mockResolvedValue({ canceled: true, assets: [] }),
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn().mockResolvedValue(false),
  shareAsync: vi.fn(),
}));

vi.mock('expo-linking', () => ({
  openURL: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: {
    push: vi.fn(),
    navigate: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
  },
}));

vi.mock('react-native-draggable-flatlist', () => ({
  NestableDraggableFlatList: (props: any) => React.createElement('NestableDraggableFlatList', props, props.children),
  NestableScrollContainer: (props: any) => React.createElement('NestableScrollContainer', props, props.children),
  ScaleDecorator: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('./task-edit/task-edit-modal.utils', async () => {
  const actual = await vi.importActual<typeof import('./task-edit/task-edit-modal.utils')>('./task-edit/task-edit-modal.utils');
  return {
    ...actual,
    syncTaskEditPagerPosition: vi.fn(),
  };
});

describe('TaskEditModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    referenceClipboard.write.mockReset().mockResolvedValue(undefined);
    referenceClipboard.toast.mockClear();
    vi.mocked(syncTaskEditPagerPosition).mockClear();
    taskOpenPreference.current = { hydrated: true, mode: 'automatic' };
    if (taskEditStore.current) {
      taskEditStore.current.lockEditing.mockClear();
      taskEditStore.current.unlockEditing.mockClear();
      const project = (taskEditStore.current._allProjects[0]
        ?? taskEditStore.current.projects[0]) as Project;
      taskEditStore.current.projects = [{ ...project, status: 'active' }];
      taskEditStore.current._allProjects = taskEditStore.current.projects;
      taskEditStore.current.sections = [];
      taskEditStore.current._allSections = [];
      taskEditStore.current.tasks = [];
      taskEditStore.current._allTasks = [];
      taskEditStore.current._tasksById = new Map();
      taskEditStore.current.settings = { features: {}, ai: {}, gtd: { taskEditor: { order: [], hidden: [] } } };
      taskEditStore.current.getDerivedState = () => ({
        allContexts: [], allTags: [], contextTokenUsage: [], tagTokenUsage: [],
        activeTasksByStatus: new Map([['next', taskEditStore.current!.tasks]]),
        projectMap: new Map(taskEditStore.current!.projects.map((project: Project) => [project.id, project])),
        focusedCount: taskEditStore.current!.tasks.filter((task: Task) => task.isFocusedToday && !isTaskFutureFocusCandidate(task)).length,
        sequentialProjectIds: new Set<string>(), sequentialWithinSectionProjectIds: new Set<string>(),
      });
    }
  });

  describe('owner navigation', () => {
    const task: Task = {
      id: 'navigation-task', title: 'Original', description: 'Description', status: 'next', contexts: [], tags: [],
      createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z',
    };
    const openEditor = async (onSave = vi.fn(), readOnly = false) => {
      const listeners = new Set<() => void>();
      const navigation = {
        addListener: vi.fn((event: string, listener: () => void) => {
          if (event === 'blur') listeners.add(listener);
          return () => listeners.delete(listener);
        }),
      };
      const onClose = vi.fn();
      const Owner = () => {
        const [selected, setSelected] = React.useState<Task | null>(task);
        return <NavigationContext.Provider value={navigation as never}>
          <TaskEditModal visible={Boolean(selected)} task={selected} readOnly={readOnly}
            onClose={() => { onClose(); setSelected(null); }} onSave={onSave} />
        </NavigationContext.Provider>;
      };
      let tree!: renderer.ReactTestRenderer;
      await act(async () => { tree = renderer.create(React.createElement(Owner)); });
      return { tree, onClose, onSave, navigation, blur: () => listeners.forEach((listener) => listener()) };
    };

    it.each([false, true])('clears a clean selection on owner blur (readOnly=%s)', async (readOnly) => {
      const editor = await openEditor(vi.fn(), readOnly);
      expect(editor.onClose).not.toHaveBeenCalled();
      act(editor.blur);
      expect(editor.onClose).toHaveBeenCalledTimes(1);
      expect(editor.tree.toJSON()).toBeNull();
      act(editor.blur);
      expect(editor.onClose).toHaveBeenCalledTimes(1);
      expect(editor.onSave).not.toHaveBeenCalled();
      await act(async () => editor.tree.unmount());
    });

    it.each(['title', 'description', 'metadata', 'checklist', 'contexts', 'tags'] as const)(
      'keeps same-frame %s input through owner blur', async (field) => {
        const editor = await openEditor();
        const form = editor.tree.root.findByType('TaskEditFormTab' as any);
        act(() => {
          const props = form.props.renderField('description').props;
          if (field === 'title') form.props.onTitleDraftChange('Unsaved title');
          if (field === 'description') props.handleDescriptionChange('Unsaved description');
          if (field === 'metadata') props.setDraftField('priority', 'high');
          if (field === 'checklist') editor.tree.root.findByType('TaskEditViewTab' as any).props.pendingChecklistDraftRef.current = 'Unsaved item';
          if (field === 'contexts') props.updateContextInput('@unsaved');
          if (field === 'tags') props.updateTagInput('#unsaved');
          editor.blur();
        });
        expect(editor.onClose).not.toHaveBeenCalled();
        act(editor.blur);
        expect(editor.onClose).not.toHaveBeenCalled();
        expect(editor.onSave).not.toHaveBeenCalled();
        await act(async () => editor.tree.unmount());
      },
    );

    it('keeps an outstanding attachment picker, then closes after cancellation', async () => {
      let finish!: (result: DocumentPicker.DocumentPickerResult) => void;
      vi.mocked(DocumentPicker.getDocumentAsync).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const editor = await openEditor();
      let pending!: Promise<void>;
      act(() => {
        pending = editor.tree.root.findByType('TaskEditFormTab' as any).props.renderField('attachments').props.addFileAttachment();
        editor.blur();
      });
      expect(editor.onClose).not.toHaveBeenCalled();
      await act(async () => { finish({ canceled: true, assets: null }); await pending; });
      act(editor.blur);
      expect(editor.onClose).toHaveBeenCalledTimes(1);
      await act(async () => editor.tree.unmount());
    });

    it('keeps an attachment import until persisted bytes become a draft attachment', async () => {
      let finish!: (attachment: Awaited<ReturnType<typeof attachmentSync.persistAttachmentLocally>>) => void;
      const persist = vi.spyOn(attachmentSync, 'persistAttachmentLocally').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
        canceled: false, assets: [{ uri: 'file:///picked.txt', name: 'picked.txt', mimeType: 'text/plain', size: 8, lastModified: 0 }],
      });
      const editor = await openEditor();
      let pending!: Promise<void>;
      await act(async () => {
        pending = editor.tree.root.findByType('TaskEditFormTab' as any).props.renderField('attachments').props.addFileAttachment();
      });
      expect(persist).toHaveBeenCalledTimes(1);
      act(editor.blur);
      expect(editor.onClose).not.toHaveBeenCalled();
      await act(async () => { finish({ ...persist.mock.calls[0][0], uri: 'file:///document/attachments/picked.txt' }); await pending; });
      act(editor.blur);
      expect(editor.onClose).not.toHaveBeenCalled();
      expect(editor.tree.root.findByType('TaskEditFormTab' as any).props.renderField('attachments').props.visibleAttachments).toHaveLength(1);
      await act(async () => editor.tree.unmount());
    });

    it('keeps a nested link draft while its task is unchanged', async () => {
      const editor = await openEditor();
      act(() => editor.tree.root.findByType('TaskEditFormTab' as any).props.renderField('attachments').props.openAddLinkAttachment());
      act(() => editor.tree.root.find((node) => typeof node.props.setLinkInput === 'function').props.setLinkInput('https://example.org/draft'));
      act(editor.blur);
      expect(editor.onClose).not.toHaveBeenCalled();
      await act(async () => editor.tree.unmount());
    });

    it('keeps an in-flight Save even after its submitted draft is reverted', async () => {
      let finish!: (result: { success: boolean }) => void;
      const editor = await openEditor(vi.fn(() => new Promise((resolve) => { finish = resolve; })));
      act(() => editor.tree.root.findByType('TaskEditFormTab' as any).props.renderField('priority').props.setDraftField('priority', 'high', false));
      act(() => {
        editor.tree.root.find((node) => typeof node.props.onDone === 'function' && typeof node.props.onDelete === 'function').props.onDone();
      });
      act(() => editor.tree.root.findByType('TaskEditFormTab' as any).props.renderField('priority').props.setDraftField('priority', '', false));
      act(editor.blur);
      expect(editor.onClose).not.toHaveBeenCalled();
      await act(async () => finish({ success: false }));
      act(editor.blur);
      expect(editor.onClose).toHaveBeenCalledTimes(1);
      await act(async () => editor.tree.unmount());
    });

    it('preserves a clean editor through ordinary background/inactive changes', async () => {
      const appStateListeners: ((state: AppStateStatus) => void)[] = [];
      vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
        appStateListeners.push(listener);
        return { remove: vi.fn() };
      });
      const editor = await openEditor();
      for (const state of ['inactive', 'background', 'active'] as const) {
        act(() => appStateListeners.forEach((listener) => listener(state)));
      }
      expect(editor.onClose).not.toHaveBeenCalled();
      expect(editor.tree.root.findAllByType(Modal)[0].props.visible).toBe(true);
      await act(async () => editor.tree.unmount());
    });
  });

  it('keeps the native editor mounted until dismissal and updates its dismissal callback', async () => {
    const task: Task = {
      id: 'dismiss-task', title: 'Original', status: 'next', contexts: [], tags: [],
      createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
    };
    const onSave = vi.fn();
    const onClose = vi.fn();
    const firstDismiss = vi.fn();
    const nextDismiss = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    const editor = (visible: boolean, onDismiss: () => void) => (
      <TaskEditModal visible={visible} task={task} onSave={onSave} onClose={onClose} onDismiss={onDismiss} />
    );
    await act(async () => { tree = renderer.create(editor(true, firstDismiss)); });
    act(() => tree.root.findByType('TaskEditFormTab' as any).props.onTitleDraftChange('Unsaved'));
    await act(async () => tree.update(editor(false, firstDismiss)));
    expect(tree.root.findAllByType(Modal)[0].props.visible).toBe(false);
    expect(firstDismiss).not.toHaveBeenCalled();
    await act(async () => tree.update(editor(false, nextDismiss)));
    act(() => tree.root.findAllByType(Modal)[0].props.onDismiss());
    expect(nextDismiss).toHaveBeenCalledTimes(1);
    expect(firstDismiss).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(task.title).toBe('Original');
    await act(async () => tree.unmount());
  });

  it.each([false, true])('copies persisted task references without saving or closing (readOnly=%s)', async (readOnly) => {
    const task: Task = {
      id: 'saved /?&#', title: 'Original title', status: 'next', contexts: [], tags: [],
      createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
    };
    taskEditStore.current!._allTasks = [task];
    taskEditStore.current!.tasks = readOnly ? [] : [task];
    const onSave = vi.fn();
    const onClose = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<TaskEditModal visible task={task} readOnly={readOnly} onSave={onSave} onClose={onClose} />);
    });
    if (!readOnly) {
      act(() => tree.root.findByType('TaskEditFormTab' as any).props.onTitleDraftChange('Unsaved title'));
    }
    for (const [label, payload] of [
      ['Copy task link', 'mindwtr://open?task=saved%20%2F%3F%26%23'],
      ['Copy task ID', task.id],
    ]) {
      act(() => tree.root.findByProps({ accessibilityLabel: 'common.more' }).props.onPress());
      await act(async () => tree.root.findByProps({ accessibilityLabel: label }).props.onPress());
      expect(referenceClipboard.write).toHaveBeenLastCalledWith(payload);
    }
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(task.title).toBe('Original title');
    if (!readOnly) expect(tree.root.findByType('TaskEditFormTab' as any).props.titleDraft).toBe('Unsaved title');
    await act(async () => tree.unmount());
  });

  it.each(['unsaved', 'projected'])('hides task references for %s tasks', async (kind) => {
    const task: Task = {
      id: 'temporary-task', title: 'Task', status: 'next', contexts: [], tags: [],
      createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
      ...(kind === 'projected' ? { isProjectedRecurringTask: true, sourceTaskId: 'recurrence-source' } : {}),
    };
    // Even a projected instance accidentally present in the list cannot expose a reference.
    taskEditStore.current!._allTasks = kind === 'projected' ? [task] : [];
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<TaskEditModal visible task={task} onSave={vi.fn()} onClose={vi.fn()} />);
    });
    act(() => tree.root.findByProps({ accessibilityLabel: 'common.more' }).props.onPress());
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Copy task link' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Copy task ID' })).toHaveLength(0);
    expect(tree.root.findByProps({ accessibilityLabel: 'common.share' })).toBeTruthy();
    expect(referenceClipboard.write).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it.each(['android', 'ios'])('renders no task fallback for a closed empty editor on %s', async (platform) => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    let tree: renderer.ReactTestRenderer | undefined;
    try {
      await act(async () => {
        tree = renderer.create(<TaskEditModal visible={false} task={null} onClose={vi.fn()} onSave={vi.fn()} />);
      });
      expect(tree!.toJSON()).toBeNull();
      const task: Task = {
        id: 'editor-lifecycle-task', title: 'Editor lifecycle', status: 'next', contexts: [], tags: [],
        checklist: [{ id: 'step-1', title: 'First step', isCompleted: false }],
        createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
      };
      const onClose = vi.fn();
      const onSave = vi.fn();
      await act(async () => {
        tree!.update(<TaskEditModal visible task={task} onClose={onClose} onSave={onSave} />);
      });
      expect(tree!.root.findAllByType('TaskEditFormTab' as any)).toHaveLength(1);
      await act(async () => {
        tree!.update(<TaskEditModal visible={false} task={null} onClose={onClose} onSave={onSave} />);
      });
      expect(tree!.toJSON()).toBeNull();
      expect(onSave).not.toHaveBeenCalled();
    } finally {
      await act(async () => tree?.unmount());
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    }
  });

  it.each([
    { platform: 'android', tab: 'view', readOnly: false, width: 390, folded: false, edges: ['top', 'bottom'] },
    { platform: 'android', tab: 'task', readOnly: false, width: 390, folded: false, edges: ['top', 'bottom'] },
    { platform: 'android', tab: 'view', readOnly: true, width: 390, folded: false, edges: ['top', 'bottom'] },
    { platform: 'ios', tab: 'view', readOnly: false, width: 390, folded: false, edges: ['top'] },
    { platform: 'web', tab: 'view', readOnly: false, width: 390, folded: false, edges: ['top'] },
    { platform: 'android', tab: 'view', readOnly: false, width: 1000, folded: false, edges: [] },
    { platform: 'android', tab: 'view', readOnly: false, width: 390, folded: true, edges: [] },
  ] as const)('reserves system safe areas for $platform $tab (readOnly=$readOnly, width=$width, folded=$folded)', async ({
    platform, tab, readOnly, width, folded, edges,
  }) => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    const adaptiveWindow = resolveAdaptiveWindow({
      width, height: 844, platform: platform === 'android' ? 'android' : 'other',
      insets: { top: 24, bottom: 48 },
      nativeSnapshot: folded ? {
        width, height: 844,
        features: [{
          bounds: { left: 0, top: 410, right: width, bottom: 430 },
          orientation: 'horizontal', state: 'half-opened', isSeparating: true, occlusionType: 'full',
        }],
      } : null,
    });
    let tree: renderer.ReactTestRenderer | undefined;
    try {
      await act(async () => {
        tree = renderer.create(
          <AdaptiveWindowContextProvider value={adaptiveWindow}>
            <TaskEditModal
              visible defaultTab={tab} readOnly={readOnly}
              task={{
                id: 'safe-area-task', title: 'Long task', status: 'next', tags: [], contexts: [],
                description: 'Last preview field',
                createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
              }}
              onClose={vi.fn()} onSave={vi.fn()}
            />
          </AdaptiveWindowContextProvider>,
        );
      });
      const surface = tree!.root.find((node) => node.type === ('View' as any) && node.props.testID === 'task-edit-adaptive-surface');
      expect(surface.findByType('SafeAreaView' as any).props.edges).toEqual(edges);
      if (adaptiveWindow.isExpanded || adaptiveWindow.activeFeature) {
        expect(surface.props.style.at(-1).height).toBe(adaptiveWindow.foregroundFrame.height);
        expect(adaptiveWindow.foregroundFrame.y + adaptiveWindow.foregroundFrame.height).toBeLessThanOrEqual(844 - 48);
      }
    } finally {
      await act(async () => tree?.unmount());
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    }
  });

  it('holds the core edit lock while the modal is open and releases it on close', async () => {
    const task: Task = {
      id: 'archived-task', title: 'Archived task', status: 'archived', contexts: [], tags: [],
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<TaskEditModal visible task={task} onClose={onClose} onSave={onSave} />); });
    expect(taskEditStore.current!.lockEditing).toHaveBeenCalledTimes(1);
    expect(taskEditStore.current!.unlockEditing).not.toHaveBeenCalled();
    await act(async () => { tree.update(<TaskEditModal visible={false} task={task} onClose={onClose} onSave={onSave} />); });
    expect(taskEditStore.current!.unlockEditing).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
    expect(taskEditStore.current!.unlockEditing).toHaveBeenCalledTimes(1);
  });

  it('finds an archived context while editing without adding it to quick chips', async () => {
    const timestamp = '2026-09-27T00:00:00.000Z';
    const task = (id: string, status: Task['status'], contexts: string[], deletedAt?: string): Task => ({
      id, title: id, status, contexts, tags: [], createdAt: timestamp, updatedAt: timestamp, deletedAt,
    });
    const editing = task('editing', 'next', ['@arch']);
    const active = task('active', 'next', ['@active-only']);
    const done = task('done', 'done', ['@done-only']);
    const archived = task('archived', 'archived', ['@archived-only']);
    const bare = task('bare', 'archived', ['Seasonal Planning']);
    const deleted = task('deleted', 'next', ['@deleted-only'], timestamp);
    taskEditStore.current!.tasks = [editing, active, done];
    taskEditStore.current!._allTasks = [editing, active, done, archived, bare, deleted];
    taskEditStore.current!.settings = { ...taskEditStore.current!.settings, taxonomy: { contexts: [{ token: '@arch-saved', rev: 1, revBy: 'test', updatedAt: timestamp }] } };
    taskEditStore.current!.getDerivedState = () => ({
      allContexts: ['@active-only', '@arch', '@done-only'], allTags: [],
      contextTokenUsage: [{ token: '@active-only', count: 1, lastUsedAt: 0 }], tagTokenUsage: [],
      activeTasksByStatus: new Map([['next', taskEditStore.current!.tasks]]),
      projectMap: new Map(taskEditStore.current!.projects.map((project: Project) => [project.id, project])),
      focusedCount: 0, sequentialProjectIds: new Set<string>(), sequentialWithinSectionProjectIds: new Set<string>(),
    });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<TaskEditModal visible task={editing} onClose={vi.fn()} onSave={vi.fn()} />);
      await Promise.resolve();
    });
    const form = tree.root.findByType('TaskEditFormTab' as any);
    const contextField = form.props.renderField('contexts');
    expect(contextField.props.contextTokenSuggestions).toEqual(['@arch-saved', '@archived-only']);
    expect(contextField.props.frequentContextSuggestions).toEqual(['@active-only']);
  });

  it('does not focus an editor field without recovered Activity input state', () => {
    const titleInput = { focus: vi.fn(), setNativeProps: vi.fn() };
    const descriptionInput = { focus: vi.fn(), setNativeProps: vi.fn() };
    const schedule = vi.fn((callback: () => void) => {
      callback();
      return vi.fn();
    });

    restoreRecoveredTaskEditInput({
      acknowledge: vi.fn(),
      descriptionInputRef: { current: descriptionInput } as any,
      editTab: 'task',
      recoveredInput: null,
      schedule,
      titleInputRef: { current: titleInput } as any,
    });

    expect(schedule).not.toHaveBeenCalled();
    expect(titleInput.focus).not.toHaveBeenCalled();
    expect(descriptionInput.focus).not.toHaveBeenCalled();
  });

  it.each(['title', 'description'] as const)(
    'restores %s focus and selection after Activity recreation',
    (field) => {
      const titleInput = { focus: vi.fn(), setNativeProps: vi.fn() };
      const descriptionInput = { focus: vi.fn(), setNativeProps: vi.fn() };
      const acknowledge = vi.fn();

      restoreRecoveredTaskEditInput({
        acknowledge,
        descriptionInputRef: { current: descriptionInput } as any,
        editTab: 'task',
        recoveredInput: { field, selection: { start: 2, end: 5 } },
        schedule: (callback) => {
          callback();
          return vi.fn();
        },
        titleInputRef: { current: titleInput } as any,
      });

      const restoredInput = field === 'title' ? titleInput : descriptionInput;
      const untouchedInput = field === 'title' ? descriptionInput : titleInput;
      expect(restoredInput.focus).toHaveBeenCalledOnce();
      expect(restoredInput.setNativeProps).toHaveBeenCalledWith({ selection: { start: 2, end: 5 } });
      expect(untouchedInput.focus).not.toHaveBeenCalled();
      expect(acknowledge).toHaveBeenCalledOnce();
    },
  );

  it('retries when the native input exists before the replacement modal can accept focus', () => {
    let acceptsFocus = false;
    const focus = vi.fn(() => {
      acceptsFocus = focus.mock.calls.length >= 2;
    });
    const titleInput = {
      focus,
      isFocused: vi.fn(() => acceptsFocus),
      setNativeProps: vi.fn(),
    };
    const scheduled: (() => void)[] = [];
    const acknowledge = vi.fn();

    restoreRecoveredTaskEditInput({
      acknowledge,
      descriptionInputRef: { current: null },
      editTab: 'task',
      recoveredInput: { field: 'title', selection: { start: 2, end: 5 } },
      schedule: (callback) => {
        scheduled.push(callback);
        return vi.fn();
      },
      titleInputRef: { current: titleInput } as any,
    });

    scheduled.shift()?.();
    expect(focus).toHaveBeenCalledOnce();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    expect(focus).toHaveBeenCalledTimes(2);
    expect(titleInput.setNativeProps).toHaveBeenLastCalledWith({ selection: { start: 2, end: 5 } });
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it('renders without crashing', () => {
    expect(() => {
      act(() => {
        renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
        );
      });
    }).not.toThrow();
  });

  it('waits for the device-local opening preference before mounting a visible editor', () => {
    taskOpenPreference.current = { hydrated: false, mode: 'automatic' };
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1', title: 'Test task', status: 'next', tags: [], contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });
    expect(tree.toJSON()).toBeNull();

    taskOpenPreference.current = { hydrated: true, mode: 'preview' };
    act(() => {
      tree.update(
        <TaskEditModal
          visible
          task={{
            id: 't1', title: 'Test task', status: 'next', tags: [], contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });
    expect(tree.root.findAll((node) => node.props.accessibilityRole === 'tab').length).toBeGreaterThan(0);
  });

  it('applies the Edit preference to a normal opening while preserving explicit Edit intent', () => {
    const task = {
      id: 't1', title: 'Test task', status: 'next' as const, tags: [], contexts: [],
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    };
    taskOpenPreference.current = { hydrated: true, mode: 'edit' };
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <TaskEditModal visible task={task} defaultTab="view" onClose={vi.fn()} onSave={vi.fn()} />,
      );
    });
    expect(tree.root.findAll((node) => node.props.accessibilityRole === 'tab')[0]?.props.accessibilityState)
      .toEqual({ selected: true });

    taskOpenPreference.current = { hydrated: true, mode: 'preview' };
    act(() => {
      tree.update(
        <TaskEditModal visible task={task} defaultTab="task" onClose={vi.fn()} onSave={vi.fn()} />,
      );
    });
    expect(tree.root.findAll((node) => node.props.accessibilityRole === 'tab')[0]?.props.accessibilityState)
      .toEqual({ selected: true });
  });

  it.each(['done', 'reference'] as const)('does not offer cancellation for a %s task', (status) => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 'finished-task',
            title: 'Finished task',
            status,
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });

    expect(tree.root.findAllByProps({ accessibilityLabel: 'More options' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Cancel task' })).toHaveLength(0);
  });

  it('keeps an archived-project task open as a read-only inspection surface', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TaskEditModal
          visible
          readOnly
          task={{
            id: 'archived-task',
            title: 'Historical task',
            description: 'Full historical notes',
            status: 'done',
            projectId: 'project-1',
            checklist: [{ id: 'item-1', title: 'Kept detail', isCompleted: true }],
            attachments: [{
              id: 'attachment-1',
              kind: 'link',
              title: 'Reference',
              uri: 'https://example.com',
              createdAt: '2025-01-01T00:00:00.000Z',
              updatedAt: '2025-01-01T00:00:00.000Z',
            }],
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
      await Promise.resolve();
    });

    expect(tree.root.findAllByType('TaskEditFormTab' as any)).toHaveLength(0);
    expect(tree.root.findAll((node) => node.props.accessibilityRole === 'tab')).toHaveLength(0);
    const preview = tree.root.findByType('TaskEditViewTab' as any);
    expect(preview.props.readOnly).toBe(true);
    expect(tree.root.findAllByProps({ testID: 'task-edit-focus-star' })).toHaveLength(0);
    expect(preview.props.mergedTask).toEqual(expect.objectContaining({
      title: 'Historical task',
      description: 'Full historical notes',
      checklist: [expect.objectContaining({ title: 'Kept detail' })],
      attachments: [expect.objectContaining({ id: 'attachment-1' })],
    }));
    expect(tree.root.findByProps({ children: 'Archived project. Reactivate it to edit this task.' })).toBeTruthy();

    const close = tree.root.find((node) => (
      node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel === 'common.close'
    ));
    act(() => close.props.onPress());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('resolves an archived task section from the project-archive tombstone', async () => {
    const archivedProject = {
      ...(taskEditStore.current?.projects[0] as Project),
      status: 'archived' as const,
    };
    const section: Section = {
      id: 'section-history',
      projectId: archivedProject.id,
      title: 'Historical planning',
      description: 'Recorded decisions',
      order: 0,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const archivedSection = archiveSectionForProjectArchive(
      section,
      '2025-01-02T00:00:00.000Z',
      'mobile-device',
    );
    const task: Task = {
      id: 'archived-section-task',
      title: 'Historical task',
      status: 'done',
      projectId: archivedProject.id,
      sectionId: archivedSection.id,
      tags: [],
      contexts: [],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
    };
    taskEditStore.current!.projects = [];
    taskEditStore.current!._allProjects = [archivedProject];
    taskEditStore.current!.sections = [];
    taskEditStore.current!._allSections = [archivedSection];
    taskEditStore.current!._allTasks = [task];

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TaskEditModal visible readOnly task={task} onClose={vi.fn()} onSave={vi.fn()} />
      );
      await Promise.resolve();
    });

    const preview = tree.root.findByType('TaskEditViewTab' as any);
    expect(preview.props.sections).toEqual([archivedSection]);
    expect(preview.props.mergedTask.sectionId).toBe(archivedSection.id);
    expect(archivedSection.deletedAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('rejects a delayed save callback after an open editor becomes read-only', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const task: Task = {
      id: 'transition-task',
      title: 'Before archive',
      status: 'next',
      projectId: 'project-1',
      tags: [],
      contexts: [],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TaskEditModal visible task={task} onClose={onClose} onSave={onSave} />
      );
      await Promise.resolve();
    });

    const delayedSave = tree.root.find((node) => (
      node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel === 'common.save'
    )).props.onPress;

    await act(async () => {
      tree.update(
        <TaskEditModal visible readOnly task={task} onClose={onClose} onSave={onSave} />
      );
      await Promise.resolve();
    });
    act(() => delayedSave());

    expect(tree.root.findByType('TaskEditViewTab' as any).props.readOnly).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mounts a themed alert host inside its modal', () => {
    // Alerts raised from the editor (e.g. the layout help button) are invisible
    // on iOS without a host inside the presented modal (#940).
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      );
    });

    const hosts = tree.root
      .findAllByType(Modal)[0]
      .findAll((node) => (node.type as { name?: string })?.name === 'ThemedAlertHost', { deep: true });
    expect(hosts).toHaveLength(1);
  });

  it('announces the selected tab and hides the inactive pager page from accessibility', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    expect(tree.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'tablist')).toHaveLength(1);
    const tabs = tree.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'tab');
    expect(tabs.map((tab) => tab.props.accessibilityState)).toEqual([
      { selected: false },
      { selected: true },
    ]);
    expect(tree.root.findByType('TaskEditFormTab' as any).props.accessibilityHidden).toBe(true);
    expect(tree.root.findByProps({ testID: 'task-edit-preview-page' }).props).toMatchObject({
      accessibilityElementsHidden: false,
      importantForAccessibility: 'auto',
    });

    await act(async () => {
      tabs[0]?.props.onPress();
      await Promise.resolve();
    });

    const updatedTabs = tree.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'tab');
    expect(updatedTabs.map((tab) => tab.props.accessibilityState)).toEqual([
      { selected: true },
      { selected: false },
    ]);
    expect(tree.root.findByType('TaskEditFormTab' as any).props.accessibilityHidden).toBe(false);
    expect(tree.root.findByProps({ testID: 'task-edit-preview-page' }).props).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
  });

  it('saves status and completion time together after a long-press in the preview', async () => {
    const completedAt = '2026-07-14T18:30:00.000Z';
    const onSave = vi.fn();
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );
    });

    const viewTab = tree.root.find((node) => (
      node.props.mergedTask?.id === 't1' && typeof node.props.onBackdatedComplete === 'function'
    ));
    act(() => {
      viewTab.props.onBackdatedComplete();
    });

    const picker = tree.root.findByType('CompletedAtPicker' as any);
    expect(picker.props.initialValue).toBeUndefined();
    expect(picker.props.initialTimeSpentMinutes).toBeUndefined();
    act(() => {
      picker.props.onConfirm(completedAt);
    });

    const header = tree.root.find((node) => (
      typeof node.props.onDone === 'function' && typeof node.props.onDelete === 'function'
    ));
    await act(async () => {
      header.props.onDone();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      status: 'done',
      completedAt,
    }));
  });

  describe('pending preview checklist item', () => {
    const checklistTask = {
      id: 't1',
      title: 'Test task',
      status: 'next' as const,
      checklist: [{ id: 'item-1', title: 'First', isCompleted: false }],
      tags: [],
      contexts: [],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };

    const openWithDraft = (
      draft: string,
      onSave: (taskId: string, updates: Partial<Task>) => unknown,
      onClose = vi.fn(),
    ) => {
      let tree!: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(
          <TaskEditModal visible task={checklistTask} onClose={onClose} onSave={onSave} />
        );
      });
      const viewTab = tree.root.find((node) => (
        node.props.mergedTask?.id === 't1' && typeof node.props.applyChecklistUpdate === 'function'
      ));
      // The preview keeps the typed-but-not-submitted item here; the save path
      // reads it synchronously instead of waiting for the input to blur.
      act(() => {
        viewTab.props.pendingChecklistDraftRef.current = draft;
      });
      return tree;
    };

    const pressSave = async (tree: renderer.ReactTestRenderer) => {
      const header = tree.root.find((node) => (
        typeof node.props.onDone === 'function' && typeof node.props.onDelete === 'function'
      ));
      await act(async () => {
        header.props.onDone();
        await Promise.resolve();
      });
    };

    it('saves text typed into the preview add-item input without pressing return', async () => {
      const onSave = vi.fn();
      const tree = openWithDraft('Typed but not submitted', onSave);

      await pressSave(tree);

      expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
        checklist: [
          expect.objectContaining({ title: 'First' }),
          expect.objectContaining({ title: 'Typed but not submitted', isCompleted: false }),
        ],
      }));
    });

    it('adds nothing when the pending text is only whitespace', async () => {
      const onSave = vi.fn();
      const tree = openWithDraft('   ', onSave);

      await pressSave(tree);

      expect(onSave).not.toHaveBeenCalled();
    });

    it('does not duplicate an item that was already submitted with return', async () => {
      const onSave = vi.fn();
      const tree = openWithDraft('', onSave);
      const viewTab = tree.root.find((node) => (
        node.props.mergedTask?.id === 't1' && typeof node.props.applyChecklistUpdate === 'function'
      ));
      act(() => {
        viewTab.props.applyChecklistUpdate([
          ...checklistTask.checklist,
          { id: 'item-2', title: 'Submitted', isCompleted: false },
        ]);
      });

      await pressSave(tree);

      expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
        checklist: [
          expect.objectContaining({ title: 'First' }),
          expect.objectContaining({ title: 'Submitted' }),
        ],
      }));
    });

    it('counts pending text as an unsaved change and drops it on discard', () => {
      const onSave = vi.fn();
      const onClose = vi.fn();
      const tree = openWithDraft('Typed but not submitted', onSave, onClose);
      const modal = tree.root.findAll((node) => (
        node.props.visible === true && typeof node.props.onRequestClose === 'function'
      ))[0];
      const alertSpy = vi.spyOn(Alert, 'alert');

      act(() => {
        modal.props.onRequestClose();
      });

      expect(alertSpy).toHaveBeenCalledTimes(1);
      const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as { text?: string; onPress?: () => void }[];
      act(() => {
        buttons[1]?.onPress?.();
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  it('does not persist a backdated completion that is reverted before saving', async () => {
    const completedAt = '2026-07-14T18:30:00.000Z';
    const onSave = vi.fn();
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );
    });

    const viewTab = tree.root.find((node) => (
      node.props.mergedTask?.id === 't1' && typeof node.props.onBackdatedComplete === 'function'
    ));
    act(() => {
      viewTab.props.onBackdatedComplete();
    });

    const picker = tree.root.findByType('CompletedAtPicker' as any);
    act(() => {
      picker.props.onConfirm(completedAt);
    });

    act(() => {
      viewTab.props.onStatusUpdate('next');
    });

    const header = tree.root.find((node) => (
      typeof node.props.onDone === 'function' && typeof node.props.onDelete === 'function'
    ));
    await act(async () => {
      header.props.onDone();
      await Promise.resolve();
    });

    expect(onSave).not.toHaveBeenCalled();
  });

  it('passes the project field to the mobile form tab', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      );
    });

    const formTab = tree!.root.find((node) => Array.isArray(node.props.basicFields));

    expect(formTab.props.basicFields).toContain('project');
  });

  it('closes immediately when there are no pending changes', () => {
    const onClose = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={vi.fn()}
        />
      );
    });

    const modal = tree!.root.findAll((node) => node.props.visible === true && typeof node.props.onRequestClose === 'function')[0];
    expect(modal).toBeTruthy();

    const alertSpy = vi.spyOn(Alert, 'alert');
    act(() => {
      modal!.props.onRequestClose();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('prompts before closing when there are unsaved changes and can discard them', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.onTitleDraftChange === 'function')[0];
    act(() => {
      formTab.props.onTitleDraftChange('Changed task');
    });

    const modal = tree!.root.findAll((node) => node.props.visible === true && typeof node.props.onRequestClose === 'function')[0];
    const alertSpy = vi.spyOn(Alert, 'alert');

    act(() => {
      modal!.props.onRequestClose();
    });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as { text?: string; onPress?: () => void }[];
    expect(Array.isArray(buttons)).toBe(true);
    expect(buttons.map((button) => button.text)).toEqual([
      'common.cancel',
      'common.discard',
      'common.save',
    ]);

    act(() => {
      buttons[1]?.onPress?.();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps the Focus star in the draft until Save and drops it on discard', async () => {
    const task: Task = {
      id: 'focus-edit', title: 'Focus edit', status: 'next', tags: [], contexts: [],
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    };
    taskEditStore.current!.tasks = [task];
    taskEditStore.current!._allTasks = [task];
    taskEditStore.current!._tasksById = new Map([[task.id, task]]);
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<TaskEditModal visible task={task} onClose={onClose} onSave={onSave} />);
    });
    const star = () => tree.root.find((node) => node.props.testID === 'task-edit-focus-star');
    expect(star().props.accessibilityState).toMatchObject({ selected: false, disabled: false });
    act(() => star().props.onPress());
    expect(star().props.accessibilityState.selected).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    const alertSpy = vi.spyOn(Alert, 'alert');
    act(() => tree.root.find((node) => node.props.accessibilityLabel === 'common.close'
      && typeof node.props.onPress === 'function').props.onPress());
    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as { onPress?: () => void }[];
    act(() => buttons[1]?.onPress?.());
    expect(onSave).not.toHaveBeenCalled();
    act(() => tree.unmount());

    await act(async () => {
      tree = renderer.create(<TaskEditModal visible task={task} onClose={onClose} onSave={onSave} />);
    });
    expect(star().props.accessibilityState.selected).toBe(false);
    act(() => star().props.onPress());
    await act(async () => {
      tree.root.find((node) => node.props.accessibilityLabel === 'common.save'
        && typeof node.props.onPress === 'function').props.onPress();
    });
    expect(onSave).toHaveBeenCalledWith(task.id, expect.objectContaining({ isFocusedToday: true }));
  });

  it('removes recurrence, stars, and saves in one editor session', async () => {
    const task: Task = {
      id: 'focus-recurrence', title: 'Focus after recurrence', status: 'next',
      dueDate: '2099-01-01', reviewAt: '2099-01-02', recurrence: { rule: 'daily' },
      tags: [], contexts: [], createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    };
    taskEditStore.current!.tasks = [task];
    taskEditStore.current!._allTasks = [task];
    taskEditStore.current!._tasksById = new Map([[task.id, task]]);
    const onSave = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<TaskEditModal visible task={task} onClose={vi.fn()} onSave={onSave} />);
    });
    const star = () => tree.root.findByProps({ testID: 'task-edit-focus-star' });
    expect(star().props.accessibilityState.disabled).toBe(true);

    const form = tree.root.findByType('TaskEditFormTab' as any);
    act(() => form.props.renderField('recurrence').props.setDraftField('recurrence', ''));
    expect(star().props.accessibilityState).toMatchObject({ selected: false, disabled: false });
    act(() => star().props.onPress());
    await act(async () => {
      tree.root.find((node) => node.props.accessibilityLabel === 'common.save'
        && typeof node.props.onPress === 'function').props.onPress();
    });
    expect(onSave).toHaveBeenCalledWith(task.id,
      expect.objectContaining({ recurrence: undefined, isFocusedToday: true }));
  });

  it('refuses a draft Focus star when the last slot fills before Save', async () => {
    const task: Task = {
      id: 'focus-late', title: 'Focus later', status: 'next', tags: [], contexts: [],
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const other = { ...task, id: 'focus-other' };
    taskEditStore.current!.tasks = [task, other];
    taskEditStore.current!._allTasks = [task, other];
    taskEditStore.current!._tasksById = new Map([[task.id, task], [other.id, other]]);
    taskEditStore.current!.settings = { features: {}, ai: {}, gtd: { focusTaskLimit: 1 } };
    const onSave = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<TaskEditModal visible task={task} onClose={vi.fn()} onSave={onSave} />);
    });
    act(() => tree.root.findByProps({ testID: 'task-edit-focus-star' }).props.onPress());
    taskEditStore.current!.tasks = [task, { ...other, isFocusedToday: true }];
    await act(async () => {
      tree.root.find((node) => node.props.accessibilityLabel === 'common.save'
        && typeof node.props.onPress === 'function').props.onPress();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('disables Focus on Done and clears a saved star when the draft becomes Done', async () => {
    const task: Task = {
      id: 'focus-done', title: 'Finished', status: 'done', tags: [], contexts: [],
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    };
    taskEditStore.current!.tasks = [task];
    taskEditStore.current!._allTasks = [task];
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<TaskEditModal visible task={task} onClose={vi.fn()} onSave={vi.fn()} />);
    });
    expect(tree.root.findByProps({ testID: 'task-edit-focus-star' }).props.accessibilityState.disabled).toBe(true);
    act(() => tree.unmount());

    const starred = { ...task, status: 'next' as const, isFocusedToday: true };
    taskEditStore.current!.tasks = [starred];
    taskEditStore.current!._allTasks = [starred];
    taskEditStore.current!._tasksById = new Map([[starred.id, starred]]);
    const onSave = vi.fn();
    await act(async () => {
      tree = renderer.create(<TaskEditModal visible task={starred} onClose={vi.fn()} onSave={onSave} />);
    });
    const form = tree.root.findByType('TaskEditFormTab' as any);
    act(() => form.props.renderField('status').props.setDraftField('status', 'done'));
    expect(tree.root.findByProps({ testID: 'task-edit-focus-star' }).props.accessibilityState)
      .toMatchObject({ selected: false, disabled: true });
    await act(async () => {
      tree.root.find((node) => node.props.accessibilityLabel === 'common.save'
        && typeof node.props.onPress === 'function').props.onPress();
    });
    expect(onSave).toHaveBeenCalledWith(starred.id,
      expect.objectContaining({ status: 'done', isFocusedToday: false }));
  });

  it('sends an edited queued start date through Save and keeps the draft on refusal', async () => {
    const queued: Task = {
      id: 'queued-edit', title: 'Queued', status: 'next', startTime: '2099-01-01', isFocusedToday: true,
      tags: [], contexts: [], createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const current = { ...queued, id: 'current-edit', startTime: undefined };
    taskEditStore.current!.tasks = [queued, current];
    taskEditStore.current!._allTasks = [queued, current];
    taskEditStore.current!._tasksById = new Map([[queued.id, queued], [current.id, current]]);
    taskEditStore.current!.settings = { features: {}, ai: {}, gtd: { focusTaskLimit: 1 } };
    const onSave = vi.fn(() => ({ success: false, error: 'Focus limit of 1 reached' }));
    const onClose = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<TaskEditModal visible task={queued} onClose={onClose} onSave={onSave} />);
    });
    expect(tree.root.findByProps({ testID: 'task-edit-focus-star' }).props.accessibilityLabel)
      .toContain('Focus when available');
    const form = tree.root.findByType('TaskEditFormTab' as any);
    act(() => form.props.renderField('startTime').props.setDraftField('startTime', ''));
    await act(async () => {
      tree.root.find((node) => node.props.accessibilityLabel === 'common.save'
        && typeof node.props.onPress === 'function').props.onPress();
    });
    expect(onSave).toHaveBeenCalledWith(queued.id, expect.objectContaining({ startTime: undefined }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('can save from the discard confirmation', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.onTitleDraftChange === 'function')[0];
    act(() => {
      formTab.props.onTitleDraftChange('Changed task');
    });

    const modal = tree!.root.findAll((node) => node.props.visible === true && typeof node.props.onRequestClose === 'function')[0];
    const alertSpy = vi.spyOn(Alert, 'alert');

    act(() => {
      modal!.props.onRequestClose();
    });

    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as { text?: string; onPress?: () => void }[];

    await act(async () => {
      await buttons[2]?.onPress?.();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Changed task' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps quick-add-looking text literal when saving an existing task title', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.onTitleDraftChange === 'function')[0];
    const literalTitle = 'Email @home #note +Home /due:tomorrow';
    act(() => {
      formTab.props.onTitleDraftChange(literalTitle);
    });

    const header = tree!.root.find((node) =>
      typeof node.props.onDone === 'function'
      && typeof node.props.onDelete === 'function'
    );
    await act(async () => {
      await header.props.onDone();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      title: literalTitle,
    }));
    expect(onSave.mock.calls[0]?.[1]).not.toHaveProperty('contexts');
    expect(onSave.mock.calls[0]?.[1]).not.toHaveProperty('tags');
    expect(onSave.mock.calls[0]?.[1]).not.toHaveProperty('dueDate');
    expect(onSave.mock.calls[0]?.[1]).not.toHaveProperty('projectId');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves clearing a project and moving the task to an area in one edit', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'next',
            projectId: 'project-1',
            sectionId: 'section-1',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.find((node) => typeof node.props.renderField === 'function');
    const projectField = formTab.props.renderField('project');
    act(() => {
      projectField.props.setDraftField('projectId', '');
      projectField.props.setDraftField('sectionId', '');
      projectField.props.setDraftField('areaId', 'area-1');
    });

    const header = tree!.root.find((node) =>
      typeof node.props.onDone === 'function'
      && typeof node.props.onDelete === 'function'
    );
    await act(async () => {
      await header.props.onDone();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      projectId: undefined,
      sectionId: undefined,
      areaId: 'area-1',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks who or what is being waited on before setting status to waiting', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const viewTab = tree!.root.find((node) => typeof node.props.onStatusUpdate === 'function');
    await act(async () => {
      viewTab.props.onStatusUpdate('waiting');
    });

    const waitingInput = tree!.root.findByProps({ placeholder: 'Who is this waiting for?' });
    await act(async () => {
      waitingInput.props.onChangeText('Alex');
    });

    await act(async () => {
      waitingInput.props.onSubmitEditing();
    });

    const header = tree!.root.find((node) =>
      typeof node.props.onDone === 'function'
      && typeof node.props.onDelete === 'function'
    );
    await act(async () => {
      header.props.onDone();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      status: 'waiting',
      assignedTo: 'Alex',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears both project and inherited area when Destination is set to None', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'next',
            projectId: 'project-1',
            sectionId: 'section-1',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.find((node) => typeof node.props.renderField === 'function');
    const destinationFieldId = formTab.props.basicFields.find(
      (fieldId: string) => fieldId === 'project' || fieldId === 'area',
    );
    let destinationField!: renderer.ReactTestRenderer;
    act(() => {
      destinationField = renderer.create(formTab.props.renderField(destinationFieldId));
    });

    const destinationButton = destinationField!.root.find((node) => (
      typeof node.props.onPress === 'function'
      && node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel === 'task.destination: Project'
    ));
    act(() => {
      destinationButton.props.onPress();
    });
    const noneButton = tree!.root.find((node) => (
      typeof node.props.onPress === 'function'
      && node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel === 'common.none'
    ));
    act(() => {
      noneButton.props.onPress();
    });

    const header = tree!.root.find((node) =>
      typeof node.props.onDone === 'function'
      && typeof node.props.onDelete === 'function'
    );
    await act(async () => {
      await header.props.onDone();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      projectId: undefined,
      sectionId: undefined,
    }));
    const updates = onSave.mock.calls[0]?.[1] ?? {};
    expect(Object.prototype.hasOwnProperty.call(updates, 'areaId')).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears an explicit legacy area with the project when Destination is set to None', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'next',
            projectId: 'project-1',
            sectionId: 'section-1',
            areaId: 'area-2',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.find((node) => typeof node.props.renderField === 'function');
    const destinationFieldId = formTab.props.basicFields.find(
      (fieldId: string) => fieldId === 'project' || fieldId === 'area',
    );
    let destinationField!: renderer.ReactTestRenderer;
    act(() => {
      destinationField = renderer.create(formTab.props.renderField(destinationFieldId));
    });

    const destinationButton = destinationField!.root.find((node) => (
      typeof node.props.onPress === 'function'
      && node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel === 'task.destination: Project'
    ));
    act(() => {
      destinationButton.props.onPress();
    });
    const noneButton = tree!.root.find((node) => (
      typeof node.props.onPress === 'function'
      && node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel === 'common.none'
    ));
    act(() => {
      noneButton.props.onPress();
    });

    const header = tree!.root.find((node) =>
      typeof node.props.onDone === 'function'
      && typeof node.props.onDelete === 'function'
    );
    await act(async () => {
      await header.props.onDone();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      projectId: undefined,
      sectionId: undefined,
    }));
    const updates = onSave.mock.calls[0]?.[1] ?? {};
    expect(updates.areaId).toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not prompt after reopening a task that was just saved', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const initialTask = {
      id: 't1',
      title: 'Test task',
      status: 'inbox' as const,
      tags: [],
      contexts: [],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const savedTask = {
      ...initialTask,
      title: 'Changed task',
      updatedAt: '2025-01-02T00:00:00.000Z',
    };
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={initialTask}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.onTitleDraftChange === 'function')[0];
    act(() => {
      formTab.props.onTitleDraftChange('Changed task');
    });

    const firstModal = tree!.root.findAll((node) => node.props.visible === true && typeof node.props.onRequestClose === 'function')[0];
    const alertSpy = vi.spyOn(Alert, 'alert');

    act(() => {
      firstModal!.props.onRequestClose();
    });

    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as { text?: string; onPress?: () => void }[];
    await act(async () => {
      await buttons[2]?.onPress?.();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Changed task' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      tree!.update(
        <TaskEditModal
          visible={false}
          task={savedTask}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    act(() => {
      tree!.update(
        <TaskEditModal
          visible
          task={savedTask}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    alertSpy.mockClear();
    const reopenedModal = tree!.root.findAll((node) => node.props.visible === true && typeof node.props.onRequestClose === 'function')[0];
    act(() => {
      reopenedModal!.props.onRequestClose();
    });

    expect(alertSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('syncs the pager to the requested default tab on first open', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible={false}
          task={null}
          onClose={onClose}
          onSave={onSave}
          defaultTab="view"
        />
      );
    });

    vi.mocked(syncTaskEditPagerPosition).mockClear();

    act(() => {
      tree!.update(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
          defaultTab="view"
        />
      );
    });

    expect(vi.mocked(syncTaskEditPagerPosition)).toHaveBeenCalled();
    expect(
      vi.mocked(syncTaskEditPagerPosition).mock.calls.some(
        ([args]) => args?.mode === 'view'
      )
    ).toBe(true);
  });

  it('disables horizontal pager gestures while the description editor is focused', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            description: 'Long description',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const findPager = () => tree!.root.find((node) =>
      node.props.horizontal === true
      && node.props.pagingEnabled === true
      && typeof node.props.scrollEnabled === 'boolean'
    );
    const formTab = tree!.root.findAll((node) => typeof node.props.renderField === 'function')[0];

    // A nested form button must receive the first tap while its input owns the keyboard.
    expect(findPager().props.keyboardShouldPersistTaps).toBe('handled');
    expect(findPager().props.scrollEnabled).toBe(true);

    await act(async () => {
      const descriptionField = formTab.props.renderField('description');
      descriptionField.props.setIsDescriptionInputFocused(true);
    });

    expect(findPager().props.scrollEnabled).toBe(false);

    await act(async () => {
      const descriptionField = formTab.props.renderField('description');
      descriptionField.props.setIsDescriptionInputFocused(false);
    });

    expect(findPager().props.scrollEnabled).toBe(true);
  });

  it('enables native spell checking for the mobile description editor', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            description: 'Fix teh typo',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.renderField === 'function')[0];
    let descriptionTree: renderer.ReactTestRenderer;
    act(() => {
      descriptionTree = renderer.create(formTab.props.renderField('description'));
    });

    const descriptionInput = descriptionTree!.root.findByProps({
      accessibilityLabel: 'taskEdit.descriptionLabel',
    });

    expect(descriptionInput.props.spellCheck).toBe(true);
    expect(descriptionInput.props.autoCorrect).toBe(true);
    expect(descriptionInput.props.autoCapitalize).toBe('sentences');
    expect(descriptionInput.props.keyboardType).toBe('default');

    act(() => {
      descriptionTree!.unmount();
      tree!.unmount();
    });
  });

  it('keeps the mobile description Markdown toolbar attached to the keyboard', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            description: 'A note',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
          defaultTab="task"
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.renderField === 'function')[0];
    let descriptionTree: renderer.ReactTestRenderer;
    act(() => {
      descriptionTree = renderer.create(formTab.props.renderField('description'));
    });

    const descriptionInput = descriptionTree!.root.findByProps({
      accessibilityLabel: 'taskEdit.descriptionLabel',
    });

    act(() => {
      descriptionInput.props.onFocus({ nativeEvent: { target: 1 } });
    });

    const inlineToolbars = descriptionTree!.root.findAllByType(MarkdownFormatToolbar);
    const modalToolbars = tree!.root.findAllByType(MarkdownFormatToolbar);
    const visibleModalToolbars = modalToolbars.filter((toolbar) => toolbar.props.visible);

    expect(inlineToolbars).toHaveLength(0);
    expect(visibleModalToolbars).toHaveLength(1);
    expect(visibleModalToolbars[0].props.placement).toBeUndefined();

    act(() => {
      descriptionTree!.unmount();
      tree!.unmount();
    });
  });

  it('closes and delegates preview navigation actions', () => {
    const onClose = vi.fn();
    const onProjectNavigate = vi.fn();
    const onContextNavigate = vi.fn();
    const onTagNavigate = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            projectId: 'project-1',
            tags: ['#urgent'],
            contexts: ['@home'],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={vi.fn()}
          onProjectNavigate={onProjectNavigate}
          onContextNavigate={onContextNavigate}
          onTagNavigate={onTagNavigate}
        />
      );
    });

    const viewTab = tree!.root.find((node) =>
      typeof node.props.onProjectPress === 'function'
      && typeof node.props.onContextPress === 'function'
      && typeof node.props.onTagPress === 'function'
    );

    act(() => {
      viewTab.props.onProjectPress('project-1');
      viewTab.props.onContextPress('@home');
      viewTab.props.onTagPress('#urgent');
    });

    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onProjectNavigate).toHaveBeenCalledWith('project-1');
    expect(onContextNavigate).toHaveBeenCalledWith('@home');
    expect(onTagNavigate).toHaveBeenCalledWith('#urgent');
  });

  describe('custom monthly recurrence', () => {
    const monthlyTask = (recurrence: Task['recurrence']): Task => ({
      id: 't1',
      title: 'Pay rent',
      status: 'next',
      tags: [],
      contexts: [],
      dueDate: '2026-06-10',
      recurrence,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });

    const openEditor = async (recurrence: Task['recurrence']) => {
      let tree!: renderer.ReactTestRenderer;
      await act(async () => {
        tree = renderer.create(
          <TaskEditModal visible task={monthlyTask(recurrence)} onClose={vi.fn()} onSave={vi.fn()} />
        );
        await Promise.resolve();
      });
      // The form tab is mocked, so the field props (the editor's recurrence seam)
      // are read off the element renderField would have mounted.
      const fieldProps = () => tree.root
        .find((node) => Array.isArray(node.props.basicFields))
        .props.renderField('recurrence').props;
      act(() => {
        fieldProps().openCustomRecurrence();
      });
      return { tree, fieldProps };
    };

    const pressChip = (tree: renderer.ReactTestRenderer, label: string) => {
      const chip = tree.root
        .findByType(TaskEditCustomRecurrenceModal)
        .findAll((node) => typeof node.props.onPress === 'function'
          && node.findAll((child) => child.props.children === label, { deep: true }).length > 0)
        .pop();
      act(() => {
        chip!.props.onPress();
      });
    };

    it('emits BYMONTHDAY=-1 when the last-day choice is saved', async () => {
      const { tree, fieldProps } = await openEditor({ rule: 'monthly', strategy: 'strict' });

      pressChip(tree, 'recurrence.lastDay');
      expect(tree.root.findByType(TaskEditCustomRecurrenceModal).props.customMode).toBe('lastDay');

      pressChip(tree, 'common.save');

      expect(fieldProps().recurrenceRRuleValue).toBe('FREQ=MONTHLY;BYMONTHDAY=-1');
    });

    it('round-trips a multi-day month rule through the RRULE', async () => {
      const { tree, fieldProps } = await openEditor({
        rule: 'monthly',
        strategy: 'strict',
        byMonthDay: [1],
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
      });

      act(() => {
        tree.root.findByType(TaskEditCustomRecurrenceModal).props.toggleCustomMonthDay(16);
      });
      expect(tree.root.findByType(TaskEditCustomRecurrenceModal).props.customMonthDays).toEqual([1, 16]);

      pressChip(tree, 'common.save');
      expect(fieldProps().recurrenceRRuleValue).toBe('FREQ=MONTHLY;BYMONTHDAY=1,16');

      act(() => {
        fieldProps().openCustomRecurrence();
      });
      expect(tree.root.findByType(TaskEditCustomRecurrenceModal).props.customMode).toBe('date');
      expect(tree.root.findByType(TaskEditCustomRecurrenceModal).props.customMonthDays).toEqual([1, 16]);
    });

    it('round-trips a mixed last-day and numbered-day rule', async () => {
      const { tree, fieldProps } = await openEditor({
        rule: 'monthly',
        strategy: 'strict',
        byMonthDay: [-1, 15],
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1,15',
      });

      const modal = tree.root.findByType(TaskEditCustomRecurrenceModal);
      expect(modal.props.customMode).toBe('date');
      expect(modal.props.customMonthDays).toEqual([-1, 15]);

      pressChip(tree, 'common.save');

      expect(fieldProps().recurrenceRRuleValue).toBe('FREQ=MONTHLY;BYMONTHDAY=-1,15');
    });

    it('keeps the last selected month day when its chip is tapped again', async () => {
      const { tree } = await openEditor({
        rule: 'monthly',
        strategy: 'strict',
        byMonthDay: [16],
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=16',
      });

      act(() => {
        tree.root.findByType(TaskEditCustomRecurrenceModal).props.toggleCustomMonthDay(16);
      });
      expect(tree.root.findByType(TaskEditCustomRecurrenceModal).props.customMonthDays).toEqual([16]);
    });

    it('reopens a last-day rule with the choice still selected', async () => {
      const { tree, fieldProps } = await openEditor({
        rule: 'monthly',
        strategy: 'strict',
        byMonthDay: [-1],
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
      });

      expect(tree.root.findByType(TaskEditCustomRecurrenceModal).props.customMode).toBe('lastDay');

      pressChip(tree, 'common.save');

      expect(fieldProps().recurrenceRRuleValue).toBe('FREQ=MONTHLY;BYMONTHDAY=-1');
    });
  });
});
