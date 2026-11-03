import React from 'react';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Area, AppSettings, Project, Task } from '@mindwtr/core';

import ProjectsScreen from '../app/(drawer)/projects-screen';

const routeParams = vi.hoisted(() => ({ current: {} as { projectId?: string } }));

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));


const modalCapture = vi.hoisted(() => ({
  projectTaskSortBy: undefined as string | undefined,
  onProjectTaskSortByChange: undefined as ((next: string) => void) | undefined,
  overlayVisible: false,
  areaManagerVisible: false,
}));

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

const storeState: {
  projects: Project[];
  tasks: Task[];
  sections: any[];
  settings: AppSettings;
  [key: string]: any;
} = {
  projects: [testProject],
  tasks: [],
  sections: [],
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
    projectTaskSummaryById: new Map(),
    tasksByProjectId: new Map(),
  }),
};

beforeEach(() => {
  routeParams.current = { projectId: testProject.id };
  asyncStorageMock.getItem.mockReset();
  asyncStorageMock.getItem.mockResolvedValue(null);
  asyncStorageMock.setItem.mockReset();
  asyncStorageMock.setItem.mockResolvedValue(undefined);
  storeState.projects = [testProject];
  storeState.updateProject = vi.fn();
  modalCapture.projectTaskSortBy = undefined;
  modalCapture.onProjectTaskSortByChange = undefined;
  modalCapture.overlayVisible = false;
  modalCapture.areaManagerVisible = false;
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
    useFocusEffect: (callback: () => void | (() => void)) => react.useEffect(callback, [callback]),
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
    t: (key: string) => key,
  }),
}));

vi.mock('../contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../contexts/quick-capture-context', () => ({
  useQuickCapture: () => ({ openQuickCapture: vi.fn() }),
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

vi.mock('@/hooks/use-project-filtering', () => ({
  useProjectFiltering: () => ({
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
    tagFilterOptions: { list: [], hasNoTags: false },
  }),
}));

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

vi.mock('@/components/projects-screen/ProjectAreaModals', () => ({
  ProjectAreaModals: (props: { showAreaManager: boolean }) => {
    modalCapture.areaManagerVisible = props.showAreaManager;
    return null;
  },
}));
vi.mock('@/components/projects-screen/ProjectDetailModal', () => ({
  ProjectDetailModal: (props: {
    taskSortBy?: string;
    onTaskSortByChange?: (next: string) => void;
    project?: unknown;
  }) => {
    modalCapture.projectTaskSortBy = props.taskSortBy;
    modalCapture.onProjectTaskSortByChange = props.onTaskSortByChange;
    modalCapture.overlayVisible = Boolean(props.project);
    return null;
  },
}));
vi.mock('@/components/projects-screen/ProjectOverlayModals', () => ({
  ProjectImagePreviewModal: () => null,
  ProjectLinkModal: () => null,
  ProjectTagPickerModal: () => null,
}));
vi.mock('@/components/task-edit-modal', () => ({ TaskEditModal: () => null }));
vi.mock('@/components/list-layout', () => ({
  ListSectionHeader: ({ title }: { title: string }) => <Text>{title}</Text>,
  defaultListContentStyle: {},
}));
vi.mock('@/components/projects-screen/ProjectRow', () => ({
  ProjectRow: ({ project }: { project: Project }) => <Text testID="project-row">{project.title}</Text>,
}));
vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
  consumePendingCaptureTaskOpen: vi.fn(() => null),
}));
vi.mock('../lib/app-log', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const renderScreen = async () => {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<ProjectsScreen />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree;
};

describe('ProjectsScreen per-project sort persistence', () => {
  it('opens area management directly from the Projects list', async () => {
    routeParams.current = {};
    const tree = await renderScreen();
    expect(modalCapture.overlayVisible).toBe(false);
    expect(modalCapture.areaManagerVisible).toBe(false);
    act(() => tree.root.findByProps({ accessibilityLabel: 'projects.manageAreas' }).props.onPress());
    expect(modalCapture.areaManagerVisible).toBe(true);
  });

  it('initializes the sort to default when the project has no persisted sort', async () => {
    await renderScreen();

    expect(modalCapture.overlayVisible).toBe(true);
    expect(modalCapture.projectTaskSortBy).toBe('default');
  });

  it('initializes the sort from the project\'s persisted taskSortBy', async () => {
    storeState.projects = [{ ...testProject, taskSortBy: 'due' }];

    await renderScreen();

    expect(modalCapture.projectTaskSortBy).toBe('due');
  });

  it('persists a sort change to the open project via updateProject', async () => {
    await renderScreen();

    act(() => {
      modalCapture.onProjectTaskSortByChange?.('title');
    });

    expect(storeState.updateProject).toHaveBeenCalledWith('project-1', { taskSortBy: 'title' });
    expect(modalCapture.projectTaskSortBy).toBe('title');
  });
});
