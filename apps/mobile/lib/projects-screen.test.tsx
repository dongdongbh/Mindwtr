import React from 'react';
import { FlatList, Platform, Text } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveSectionForProjectArchive,
  type Area,
  type AppSettings,
  type Project,
  type Section,
  type Task,
} from '@mindwtr/core';

import ProjectsScreen from '../app/(drawer)/projects-screen';
import { SHEET_DISMISS_SETTLE_MS } from './capture-route-presence';

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const detailModal = vi.hoisted(() => ({ props: null as Record<string, any> | null }));
const tagPicker = vi.hoisted(() => ({ props: null as Record<string, any> | null }));
const taskEditModal = vi.hoisted(() => ({ props: null as Record<string, any> | null }));
const focusEffect = vi.hoisted(() => ({ callback: null as null | (() => void | (() => void)) }));
const consumePendingCaptureTaskOpenMock = vi.hoisted(() => vi.fn());
const openQuickCaptureMock = vi.hoisted(() => vi.fn());
const filteringHarness = vi.hoisted(() => ({ useRealHook: false }));

const flattenStyle = (value: unknown): Record<string, unknown> => Object.assign(
  {},
  ...(Array.isArray(value) ? value : [value]).filter(Boolean),
);

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const now = '2026-06-15T00:00:00.000Z';
const testArea: Area = {
  id: 'no-area',
  name: 'No Area',
  order: 0,
  createdAt: now,
  updatedAt: now,
};
const testProject: Project = {
  id: 'project-1',
  title: 'Visible Project',
  status: 'active',
  color: '#3b82f6',
  order: 0,
  tagIds: [],
  createdAt: now,
  updatedAt: now,
};
const testNextActionTask: Task = {
  id: 'task-next',
  title: 'Do the thing',
  status: 'next',
  projectId: testProject.id,
  tags: [],
  contexts: [],
  createdAt: now,
  updatedAt: now,
};

const storeState: {
  projects: Project[];
  tasks: Task[];
  sections: any[];
  settings: AppSettings;
  [key: string]: any;
} = {
  projects: [testProject],
  _allProjects: [testProject],
  tasks: [],
  _allTasks: [],
  sections: [],
  _allSections: [],
  settings: {},
  addProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  restoreProject: vi.fn(),
  duplicateProject: vi.fn(),
  addSection: vi.fn(),
  updateSection: vi.fn(),
  deleteSection: vi.fn(),
  reorderSections: vi.fn(),
  toggleProjectFocus: vi.fn(),
  addArea: vi.fn(),
  updateArea: vi.fn(),
  deleteArea: vi.fn(),
  reorderAreas: vi.fn(),
  updateTask: vi.fn(),
  setHighlightTask: vi.fn(),
  getDerivedState: () => ({
    focusedProjectCount: 0,
    // Mirrors core's real computeTaskDerivedState output shape (#927) so the
    // screen's live selector-driven wiring to ProjectRow is exercised.
    projectTaskSummaryById: new Map([
      [testProject.id, { activeTaskCount: 1, nextAction: testNextActionTask }],
    ]),
    tasksByProjectId: new Map(),
  }),
};

beforeEach(() => {
  filteringHarness.useRealHook = false;
  routeParams.current = {};
  detailModal.props = null;
  taskEditModal.props = null;
  focusEffect.callback = null;
  consumePendingCaptureTaskOpenMock.mockReset();
  openQuickCaptureMock.mockReset();
  consumePendingCaptureTaskOpenMock.mockReturnValue(null);
  storeState.projects = [testProject];
  storeState._allProjects = [testProject];
  storeState.tasks = [];
  storeState._allTasks = [];
  storeState.sections = [];
  storeState._allSections = [];
  storeState.updateTask.mockReset();
  asyncStorageMock.getItem.mockReset();
  asyncStorageMock.getItem.mockResolvedValue(null);
  asyncStorageMock.setItem.mockReset();
  asyncStorageMock.setItem.mockResolvedValue(undefined);
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock,
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  const useTaskStore = Object.assign((selector?: (state: typeof storeState) => unknown) => (
    typeof selector === 'function' ? selector(storeState) : storeState
  ), {
    getState: () => storeState,
  });
  return {
    ...actual,
    useTaskStore,
    shallow: (value: unknown) => value,
  };
});

vi.mock('expo-router', async () => {
  const react = await import('react');
  return {
    useLocalSearchParams: () => routeParams.current,
    usePathname: () => '/projects-screen',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    // Captured so a test can fire it to stand in for the screen regaining
    // focus; also run on mount the way a focused screen would.
    useFocusEffect: (callback: () => void | (() => void)) => {
      focusEffect.callback = callback;
      react.useEffect(callback, [callback]);
    },
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => ({
      'projects.activeSection': 'Active Projects',
      'projects.deferredSection': 'Someday / Waiting',
      'projects.noArea': 'No Area',
      'projects.addPlaceholder': 'Add new project...',
      'projects.allTags': 'All tags',
      'projects.emptyTag': 'Empty tag',
      'projects.noTags': 'No tags',
      'projects.tagFilter': 'Tag filter',
      'projects.show': 'Show',
      'projects.empty': 'No projects yet',
      'status.archived': 'Archived',
      'common.back': 'Back',
      'common.close': 'Close',
      'common.loading': 'Loading...',
      'common.notice': 'Notice',
      'filters.hide': 'Hide',
      'filters.show': 'Show',
      'filters.title': 'Filters',
      'taskEdit.moreOptions': 'More options',
    }[key] ?? key),
  }),
}));

vi.mock('../contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../contexts/quick-capture-context', () => ({
  useQuickCapture: () => ({ openQuickCapture: openQuickCaptureMock }),
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#111827',
    text: '#f9fafb',
    secondaryText: '#9ca3af',
    tint: '#60a5fa',
    onTint: '#ffffff',
    border: '#374151',
    filterBg: '#1f2937',
    cardBg: '#111827',
    icon: '#9ca3af',
  }),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({
    areaById: new Map<string, Area>(),
    resolvedAreaFilter: { included: [], excluded: [] },
    sortedAreas: [],
  }),
}));

vi.mock('@/hooks/use-project-filtering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-project-filtering')>();
  return { useProjectFiltering: (params: Parameters<typeof actual.useProjectFiltering>[0]) => (
    filteringHarness.useRealHook ? actual.useProjectFiltering(params) : ({
    areaUsage: new Map(),
    focusedCount: 0,
    groupedActiveProjects: [
      {
        areaId: testArea.id,
        projects: [testProject],
      },
    ],
    groupedDeferredProjects: [],
    groupedArchivedProjects: [],
    projectTagOptions: [],
    tagFilterOptions: { list: ['work'], hasNoTags: false },
    })
  ) };
});

vi.mock('@/components/projects-screen/use-project-notes-editor', () => ({
  useProjectNotesEditor: () => ({
    notesExpanded: false,
    setNotesExpanded: vi.fn(),
    showNotesPreview: false,
    setShowNotesPreview: vi.fn(),
    notesFullscreen: false,
    setNotesFullscreen: vi.fn(),
    selectedProjectNotes: '',
    selectedProjectNotesDirection: 'ltr',
    selectedProjectNotesTextDirectionStyle: {},
    selectedProjectNotesInputRef: { current: null },
    selectedProjectNotesUndoDepth: 0,
    isSelectedProjectNotesFocused: false,
    setIsSelectedProjectNotesFocused: vi.fn(),
    selectedProjectNotesSelection: { start: 0, end: 0 },
    commitSelectedProjectNotes: vi.fn(),
    handleSelectedProjectNotesApplyAction: vi.fn(),
    handleSelectedProjectNotesApplyAutocomplete: vi.fn(),
    handleSelectedProjectNotesChange: vi.fn(),
    handleSelectedProjectNotesSelectionChange: vi.fn(),
    handleSelectedProjectNotesUndo: vi.fn(),
    resetProjectNotesUi: vi.fn(),
  }),
}));

vi.mock('@/components/projects-screen/use-project-attachments', () => ({
  useProjectAttachments: () => ({
    linkModalVisible: false,
    setLinkModalVisible: vi.fn(),
    imagePreviewAttachment: null,
    setImagePreviewAttachment: vi.fn(),
    linkInput: '',
    setLinkInput: vi.fn(),
    openAttachment: vi.fn(),
    downloadAttachment: vi.fn(),
    addProjectFileAttachment: vi.fn(),
    confirmAddProjectLink: vi.fn(),
    removeProjectAttachment: vi.fn(),
    resetProjectAttachmentUi: vi.fn(),
  }),
}));

vi.mock('@/components/projects-screen/ProjectAreaModals', () => ({ ProjectAreaModals: () => null }));
vi.mock('@/components/projects-screen/ProjectDetailModal', () => ({
  ProjectDetailModal: (props: Record<string, any>) => {
    detailModal.props = props;
    return null;
  },
}));
vi.mock('@/components/projects-screen/ProjectOverlayModals', () => ({
  ProjectImagePreviewModal: () => null,
  ProjectLinkModal: () => null,
  ProjectTagPickerModal: (props: Record<string, any>) => {
    tagPicker.props = props;
    return null;
  },
}));
vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: (props: Record<string, any>) => {
    taskEditModal.props = props;
    return null;
  },
}));
vi.mock('@/components/list-layout', () => ({
  ListSectionHeader: ({ title }: { title: string }) => <Text>{title}</Text>,
  defaultListContentStyle: {},
}));
vi.mock('@/components/projects-screen/ProjectRow', () => ({
  ProjectRow: ({ project, taskSummary }: { project: Project; taskSummary?: { activeTaskCount: number; nextAction?: Task } }) => (
    <Text testID="project-row">{project.title}:{taskSummary?.activeTaskCount ?? 0}:{taskSummary?.nextAction?.title ?? ''}</Text>
  ),
}));
vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
  consumePendingCaptureTaskOpen: consumePendingCaptureTaskOpenMock,
}));
vi.mock('../lib/app-log', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

describe('ProjectsScreen project tag picker', () => {
  // The picker's + adds the typed tag; a tag already on the project stays (it toggled before, so + removed it).
  // Removing a tag is the tag chip's toggle.
  it('adds the typed tag with + and never removes one the project already has', async () => {
    const tagged = { ...testProject, tagIds: ['#work'] };
    storeState.projects = [tagged];
    storeState._allProjects = [tagged];
    routeParams.current = { projectId: tagged.id };
    await act(async () => {
      create(<ProjectsScreen />);
      await Promise.resolve();
    });
    storeState.updateProject.mockClear();
    await act(async () => { tagPicker.props?.onChangeTagDraft?.('work'); await Promise.resolve(); });
    await act(async () => { tagPicker.props?.onAddTag?.(); await Promise.resolve(); });
    for (const [, patch] of storeState.updateProject.mock.calls) expect(patch.tagIds).toContain('#work');
    await act(async () => { tagPicker.props?.onChangeTagDraft?.('home'); await Promise.resolve(); });
    await act(async () => { tagPicker.props?.onAddTag?.(); await Promise.resolve(); });
    expect(storeState.updateProject).toHaveBeenLastCalledWith(tagged.id, { tagIds: ['#work', '#home'] });
  });
});

describe('ProjectsScreen project edits on close', () => {
  // Leaving the sheet writes only what the user changed since it opened: an area another device set meanwhile stays.
  it('keeps an area another device set while the sheet was open', async () => {
    const actualCore = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    const remote = { ...testProject, areaId: 'area-remote', updatedAt: '2026-02-01T00:00:00.000Z' };
    actualCore.resetForTests();
    actualCore.setStorageAdapter({
      getData: async () => ({ tasks: [], projects: [remote], sections: [], areas: [{ ...testArea, id: 'area-remote' }], people: [], settings: {} }),
      saveData: async () => undefined,
    });
    await actualCore.useTaskStore.getState().fetchData({ silent: true });
    routeParams.current = { projectId: testProject.id };
    storeState.updateProject.mockClear();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ProjectsScreen />);
      await Promise.resolve();
    });
    // The sync lands while the sheet still shows the project as opened.
    storeState.projects = [remote];
    storeState._allProjects = [remote];
    await act(async () => { tree.update(<ProjectsScreen />); await Promise.resolve(); });
    await act(async () => { detailModal.props?.onProjectChange?.({ ...detailModal.props?.project, title: 'Renamed' }); });
    await act(async () => { detailModal.props?.onOpenQuickAdd?.(testProject); await Promise.resolve(); });
    for (const [, patch] of storeState.updateProject.mock.calls) expect(patch).not.toHaveProperty('areaId');
    await vi.waitFor(() => expect(actualCore.useTaskStore.getState()._projectsById.get(testProject.id)?.title).toBe('Renamed'));
    expect(actualCore.useTaskStore.getState()._projectsById.get(testProject.id)?.areaId).toBe('area-remote');
    await act(async () => { tree.unmount(); });
    actualCore.resetForTests();
  });

  it('keeps a rename another device made when the opened title had outer spaces and the user did not rename', async () => {
    const actualCore = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    const padded = { ...testProject, title: '  Padded title  ' };
    const remote = { ...padded, title: 'Remote name', updatedAt: '2026-02-01T00:00:00.000Z' };
    actualCore.resetForTests();
    actualCore.setStorageAdapter({ getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }), saveData: async () => undefined });
    // The store holds the other device's rename; the sheet opens on the copy from before it.
    actualCore.useTaskStore.setState({ _allProjects: [remote], _allAreas: [testArea] });
    storeState.projects = [padded];
    storeState._allProjects = [padded];
    routeParams.current = { projectId: testProject.id };
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ProjectsScreen />);
      await Promise.resolve();
    });
    storeState.projects = [remote];
    storeState._allProjects = [remote];
    await act(async () => { tree.update(<ProjectsScreen />); await Promise.resolve(); });
    await act(async () => { detailModal.props?.onOpenQuickAdd?.(testProject); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(actualCore.useTaskStore.getState()._projectsById.get(testProject.id)?.title).toBe('Remote name');
    await act(async () => { tree.unmount(); });
    storeState.projects = [testProject];
    storeState._allProjects = [testProject];
    actualCore.resetForTests();
  });
});

describe('ProjectsScreen project quick add', () => {
  // The detail sheet is a native modal driven by selectedProject. Leaving it set
  // while quick add pushes a route desyncs state from the native sheet, and
  // re-tapping the project then sets identical state — no transition, so the
  // sheet never comes back and the row reads as dead (#938).
  it('closes the open project on the way to quick add and restores it on focus', async () => {
    routeParams.current = { projectId: testProject.id, openToken: 'token-1' };

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ProjectsScreen />);
      await Promise.resolve();
    });

    expect(detailModal.props?.project?.id).toBe(testProject.id);

    await act(async () => {
      detailModal.props?.onOpenQuickAdd?.(testProject);
      await Promise.resolve();
    });

    expect(detailModal.props?.project).toBeNull();

    // Returning to the screen re-runs the focus callback, which re-opens it and
    // gives the native modal a real false -> true transition.
    await act(async () => {
      focusEffect.callback?.();
      await Promise.resolve();
    });

    expect(detailModal.props?.project?.id).toBe(testProject.id);

    await act(async () => {
      tree.unmount();
    });
  });
});

describe('ProjectsScreen project quick add ordering', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Platform.OS = originalOS;
  });

  const openProjectAndQuickAdd = async () => {
    routeParams.current = { projectId: testProject.id, openToken: 'token-1' };
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ProjectsScreen />);
      await Promise.resolve();
    });
    await act(async () => {
      detailModal.props?.onOpenQuickAdd?.(testProject);
      await Promise.resolve();
    });
    return tree;
  };

  // Presenting the capture route while UIKit is still dismissing the project
  // sheet races two presentations on one presenter; a lost race left an
  // invisible modal host over the Projects list that swallowed every touch.
  it('on iOS opens capture only after the project sheet reports dismissal', async () => {
    Platform.OS = 'ios';
    const tree = await openProjectAndQuickAdd();

    expect(detailModal.props?.project).toBeNull();
    expect(openQuickCaptureMock).not.toHaveBeenCalled();

    await act(async () => {
      detailModal.props?.onDismiss?.();
      await Promise.resolve();
    });

    expect(openQuickCaptureMock).toHaveBeenCalledTimes(1);
    expect(openQuickCaptureMock).toHaveBeenCalledWith(expect.objectContaining({
      initialProps: { projectId: testProject.id, status: 'next' },
      returnTo: expect.any(String),
    }));

    // A later dismissal (closing the reopened sheet by hand) must not open
    // capture again.
    await act(async () => {
      detailModal.props?.onDismiss?.();
      await Promise.resolve();
    });
    expect(openQuickCaptureMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
  });

  // Save & edit opens the editor and the project, two sibling sheets. iOS
  // refuses the second presentation and left its invisible host over the list,
  // so on iOS the project reopens only after the editor is dismissed.
  it('on iOS opens the Save & edit editor first and reopens the project after it closes', async () => {
    Platform.OS = 'ios';
    vi.useFakeTimers();
    try {
      storeState.tasks = [testNextActionTask];
      storeState._allTasks = [testNextActionTask];
      const tree = await openProjectAndQuickAdd();
      consumePendingCaptureTaskOpenMock.mockReturnValueOnce({ taskId: testNextActionTask.id, taskTab: 'task' });

      await act(async () => {
        focusEffect.callback?.();
        await Promise.resolve();
      });

      expect(taskEditModal.props?.visible).toBe(true);
      expect(detailModal.props?.project).toBeNull();

      await act(async () => {
        taskEditModal.props?.onClose?.();
        await Promise.resolve();
      });
      expect(detailModal.props?.project).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(SHEET_DISMISS_SETTLE_MS);
        await Promise.resolve();
      });
      expect(detailModal.props?.project?.id).toBe(testProject.id);

      await act(async () => {
        tree.unmount();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('on Android opens capture at once (Modal.onDismiss is iOS-only)', async () => {
    Platform.OS = 'android';
    const tree = await openProjectAndQuickAdd();

    expect(openQuickCaptureMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
  });
});

describe('ProjectsScreen list controls', () => {
  it('forwards saved unused tags to the project picker without adding unused tag filters', async () => {
    filteringHarness.useRealHook = true;
    const previousSettings = storeState.settings;
    storeState.settings = { taxonomy: { tags: [{ token: '#unused', rev: 1, revBy: 'test', updatedAt: now }] } };
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<ProjectsScreen />); await Promise.resolve(); });
    expect(tagPicker.props?.projectTagOptions).toContain('#unused');
    act(() => tree.root.findByProps({ testID: 'projects-tag-filter-toggle' }).props.onPress());
    expect(tree.root.findAllByProps({ accessibilityLabel: '#unused' })).toHaveLength(0);
    await act(async () => { tree.unmount(); });
    storeState.settings = previousSettings;
  });

  it('labels the empty raw tag and filters it separately from untagged projects', async () => {
    filteringHarness.useRealHook = true;
    storeState.projects = [
      { ...testProject, id: 'empty-tag', title: 'Empty tag project', tagIds: [''] },
      { ...testProject, id: 'untagged', title: 'Untagged project', tagIds: [] },
    ];
    storeState._allProjects = storeState.projects;

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ProjectsScreen />);
      await Promise.resolve();
    });
    act(() => tree.root.findByProps({ testID: 'projects-tag-filter-toggle' }).props.onPress());
    const emptyTagChip = tree.root.findByProps({ accessibilityLabel: 'Empty tag' });
    expect(emptyTagChip.props.accessibilityRole).toBe('button');
    expect(emptyTagChip.findByType(Text).props.children).toBe('Empty tag');
    act(() => emptyTagChip.props.onPress());
    expect(tree.root.findByProps({ testID: 'projects-tag-filter-toggle' }).props.accessibilityLabel)
      .toBe('Tag filter: Empty tag, Hide');

    const visibleProjects = () => tree.root.findByType(FlatList).props.data
      .filter((row: { type: string }) => row.type === 'project')
      .map((row: { project: Project }) => row.project.id);
    expect(visibleProjects()).toEqual(['empty-tag']);
    act(() => tree.root.findByProps({ accessibilityLabel: 'No tags' }).props.onPress());
    expect(visibleProjects()).toEqual(['untagged']);
  });

  it('toggles tag filters from the project heading while preserving and clearing the selection', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ProjectsScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tree.root.findAllByProps({ testID: 'projects-list-overflow-button' })).toHaveLength(0);
    let toggle = tree.root.findByProps({ testID: 'projects-tag-filter-toggle' });
    expect(toggle.props.accessibilityLabel).toBe('Tag filter, Show');
    expect(toggle.props.accessibilityState).toEqual({ expanded: false, selected: false });
    expect(flattenStyle(toggle.props.style)).toEqual(expect.objectContaining({ minHeight: 44 }));
    expect(flattenStyle(tree.root.findByProps({ testID: 'projects-tag-filter-section' }).props.style))
      .toEqual(expect.objectContaining({ marginTop: 0 }));
    expect(flattenStyle(tree.root.findByProps({ testID: 'projects-list-controls' }).props.style))
      .toEqual(expect.objectContaining({ paddingBottom: 0 }));
    const list = tree.root.findByType(FlatList);
    expect(flattenStyle(list.props.contentContainerStyle)).toEqual(expect.objectContaining({ paddingTop: 0 }));
    const sectionRow = list.props.data.find((item: { type: string }) => item.type === 'section-label');
    const sectionHeader = list.props.renderItem({ item: sectionRow, index: 0 });
    expect(flattenStyle(sectionHeader.props.style)).toEqual(expect.objectContaining({ paddingTop: 8 }));
    expect(tree.root.findAllByProps({ accessibilityLabel: 'work' })).toHaveLength(0);

    act(() => toggle.props.onPress());
    expect(flattenStyle(tree.root.findByProps({ accessibilityLabel: 'work' }).parent?.props.style))
      .toEqual(expect.objectContaining({ paddingBottom: 8 }));
    act(() => tree.root.findByProps({ accessibilityLabel: 'work' }).props.onPress());

    toggle = tree.root.findByProps({ testID: 'projects-tag-filter-toggle' });
    expect(toggle.props.accessibilityLabel).toBe('Tag filter: work, Hide');
    expect(toggle.props.accessibilityState).toEqual({ expanded: true, selected: true });

    act(() => toggle.props.onPress());
    toggle = tree.root.findByProps({ testID: 'projects-tag-filter-toggle' });
    expect(toggle.props.accessibilityLabel).toBe('Tag filter: work, Show');
    expect(toggle.props.accessibilityState).toEqual({ expanded: false, selected: true });
    expect(tree.root.findAllByProps({ accessibilityLabel: 'work' })).toHaveLength(0);

    act(() => toggle.props.onPress());
    expect(tree.root.findByProps({ accessibilityLabel: 'work' }).props.accessibilityState).toEqual({ selected: true });
    act(() => tree.root.findByProps({ accessibilityLabel: 'All tags' }).props.onPress());

    toggle = tree.root.findByProps({ testID: 'projects-tag-filter-toggle' });
    expect(toggle.props.accessibilityLabel).toBe('Tag filter, Hide');
    expect(toggle.props.accessibilityState).toEqual({ expanded: true, selected: false });
    expect(tree.root.findByProps({ accessibilityLabel: 'Add new project...' })).toBeTruthy();
  });

  it('shows a custom area icon without a duplicate color dot and keeps a color-dot fallback', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ProjectsScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const list = tree.root.findByType(FlatList);
    const renderAreaHeader = (item: Record<string, unknown>) => list.props.renderItem({ item, index: 1 });
    let iconHeaderTree!: ReturnType<typeof create>;
    act(() => {
      iconHeaderTree = create(renderAreaHeader({
        type: 'area-header',
        key: 'active-area-research',
        title: 'Research',
        areaId: 'research',
        collapsed: false,
        sectionKind: 'active',
        color: '#22c55e',
        icon: '🧪',
      }));
    });

    const iconHeader = iconHeaderTree.root.findByProps({ testID: 'project-area-header-active-research' });
    expect(iconHeader.props.accessibilityRole).toBe('button');
    expect(iconHeader.props.accessibilityState).toEqual({ expanded: true });
    expect(iconHeaderTree.root.findByProps({ testID: 'project-area-icon-research' }).props.children).toBe('🧪');
    expect(iconHeaderTree.root.findAllByProps({ testID: 'project-area-dot-research' })).toHaveLength(0);

    await act(async () => {
      iconHeader.props.onPress();
      await Promise.resolve();
    });
    expect(asyncStorageMock.setItem).toHaveBeenCalled();

    let fallbackHeaderTree!: ReturnType<typeof create>;
    act(() => {
      fallbackHeaderTree = create(renderAreaHeader({
        type: 'area-header',
        key: 'active-area-home',
        title: 'Home',
        areaId: 'home',
        collapsed: true,
        sectionKind: 'active',
        color: '#3b82f6',
      }));
    });

    expect(fallbackHeaderTree.root.findByProps({ testID: 'project-area-header-active-home' }).props.accessibilityState)
      .toEqual({ expanded: false });
    expect(fallbackHeaderTree.root.findAllByProps({ testID: 'project-area-icon-home' })).toHaveLength(0);
    expect(fallbackHeaderTree.root.findByProps({ testID: 'project-area-dot-home' })).toBeTruthy();
  });
});

describe('ProjectsScreen archived task inspection', () => {
  const archivedTask: Task = {
    id: 'task-archived-project',
    title: 'Historical task',
    description: 'Long notes remain inspectable',
    status: 'done',
    projectId: testProject.id,
    checklist: [{ id: 'check-1', title: 'Completed detail', isCompleted: true }],
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
  };

  it('passes project-archive section tombstones to the archived detail view', async () => {
    const archivedProject = { ...testProject, status: 'archived' as const };
    const section: Section = {
      id: 'section-history',
      projectId: archivedProject.id,
      title: 'Historical planning',
      description: 'Recorded decisions',
      order: 0,
      createdAt: now,
      updatedAt: now,
    };
    const archivedSection = archiveSectionForProjectArchive(
      section,
      '2026-06-16T00:00:00.000Z',
      'mobile-device',
    );
    routeParams.current = { projectId: archivedProject.id };
    storeState.projects = [archivedProject];
    storeState._allProjects = [archivedProject];
    storeState.sections = [];
    storeState._allSections = [archivedSection];
    storeState._allTasks = [{ ...archivedTask, sectionId: archivedSection.id }];

    await act(async () => {
      create(<ProjectsScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(detailModal.props?.sections).toEqual([archivedSection]);
    expect(detailModal.props?.tasks).toEqual([
      expect.objectContaining({ id: archivedTask.id, sectionId: archivedSection.id }),
    ]);
    expect(archivedSection.deletedAt).toBe('2026-06-16T00:00:00.000Z');
  });

  it('opens a direct archived task route read-only and rejects every save at the live boundary', async () => {
    const archivedProject = { ...testProject, status: 'archived' as const };
    routeParams.current = {
      projectId: archivedProject.id,
      taskId: archivedTask.id,
      openToken: 'archived-route',
      taskTab: 'task',
    };
    storeState.projects = [archivedProject];
    storeState._allProjects = [archivedProject];
    storeState.tasks = [];
    storeState._allTasks = [archivedTask];

    await act(async () => {
      create(<ProjectsScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(taskEditModal.props).toEqual(expect.objectContaining({
      visible: true,
      task: archivedTask,
      readOnly: true,
    }));
    act(() => {
      taskEditModal.props?.onSave(archivedTask.id, {
        title: 'No title write',
        dueDate: '2026-07-01',
        status: 'next',
        description: 'No notes write',
        attachments: [],
      });
    });
    expect(storeState.updateTask).not.toHaveBeenCalled();
  });

  it('keeps an open task inspector visible and flips it read-only when sync archives the project', async () => {
    routeParams.current = {
      projectId: testProject.id,
      taskId: archivedTask.id,
      openToken: 'live-transition',
      taskTab: 'task',
    };
    storeState.tasks = [archivedTask];
    storeState._allTasks = [archivedTask];
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ProjectsScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(taskEditModal.props).toEqual(expect.objectContaining({ visible: true, readOnly: false }));

    const archivedProject = { ...testProject, status: 'archived' as const };
    storeState.projects = [archivedProject];
    storeState._allProjects = [archivedProject];
    await act(async () => {
      tree.update(<ProjectsScreen />);
      await Promise.resolve();
    });

    expect(taskEditModal.props).toEqual(expect.objectContaining({ visible: true, readOnly: true }));
    act(() => taskEditModal.props?.onSave(archivedTask.id, { title: 'No stale save' }));
    expect(storeState.updateTask).not.toHaveBeenCalled();
  });

  it('opens a capture-return task from an archived project for read-only inspection', async () => {
    const archivedProject = { ...testProject, status: 'archived' as const };
    routeParams.current = { projectId: archivedProject.id };
    storeState.projects = [archivedProject];
    storeState._allProjects = [archivedProject];
    storeState.tasks = [];
    storeState._allTasks = [archivedTask];
    consumePendingCaptureTaskOpenMock.mockReturnValueOnce({
      taskId: archivedTask.id,
      taskTab: 'view',
    });

    await act(async () => {
      create(<ProjectsScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(taskEditModal.props).toEqual(expect.objectContaining({
      visible: true,
      task: archivedTask,
      readOnly: true,
    }));
  });
});

describe('ProjectsScreen view state hydration', () => {
  it('does not render project rows before persisted collapsed areas are loaded', async () => {
    const deferred = createDeferred<string | null>();
    asyncStorageMock.getItem.mockReturnValue(deferred.promise);

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<ProjectsScreen />);
    });

    const firstList = tree.root.findByType(FlatList);
    expect(firstList.props.data.some((row: { type: string }) => row.type === 'project')).toBe(false);
    expect(firstList.props.ListEmptyComponent.props.children.props.children).toBe('Loading...');

    await act(async () => {
      deferred.resolve(JSON.stringify({
        collapsedAreas: { 'no-area': true },
        showArchivedProjects: false,
        showDeferredProjects: false,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(asyncStorageMock.getItem).toHaveBeenCalledWith('mindwtr:view:projects:v1');
    const hydratedList = tree.root.findByType(FlatList);
    expect(hydratedList.props.data.some((row: { type: string }) => row.type === 'project')).toBe(false);
  });

  it('passes the store\'s live projectTaskSummaryById through to each project row', async () => {
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(<ProjectsScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const list = tree.root.findByType(FlatList);
    const projectRow = list.props.data.find((row: { type: string }) => row.type === 'project');
    expect(projectRow).toBeTruthy();

    // renderItem returns the <ProjectRow /> element without needing FlatList's
    // native windowing/layout, which react-test-renderer can't provide here.
    const rendered = list.props.renderItem({ item: projectRow, index: 0 });
    expect(rendered.props.taskSummary).toEqual({ activeTaskCount: 1, nextAction: testNextActionTask });
  });
});
