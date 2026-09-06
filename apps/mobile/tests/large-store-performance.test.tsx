import React from 'react';
import { performance } from 'node:perf_hooks';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  flushPendingSave,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppData,
  type Area,
  type Project,
  type Section,
  type StorageAdapter,
  type Task,
  type TaskEnergyLevel,
  type TaskPriority,
  type TaskStatus,
  type TimeEstimate,
} from '@mindwtr/core';

import FocusScreen from '../app/(drawer)/(tabs)/focus';
import ArchivedScreen from '../app/(drawer)/archived';
import TrashScreen from '../app/(drawer)/trash';
import { ProjectDetailModal } from '../components/projects-screen/ProjectDetailModal';
import { ProjectRow } from '../components/projects-screen/ProjectRow';
import { buildProjectListRows } from '../components/projects-screen/project-list-model';
import { TaskEditModal } from '../components/task-edit-modal';
import { TaskList } from '../components/task-list';

const LARGE_TASK_COUNT = 5_000;
const PROJECT_COUNT = 40;
const SECTIONS_PER_PROJECT = 2;
const heavyEditorTabRenderCounts = vi.hoisted(() => ({
  form: 0,
  view: 0,
}));
const translate = vi.hoisted(() => {
  const labels: Record<string, string> = {
    'agenda.allClear': 'All clear',
    'agenda.noTasks': 'No tasks',
    'agenda.reviewDue': 'Review Due',
    'agenda.todaysFocus': "Today's Focus",
    'archived.empty': 'No archived tasks',
    'archived.emptyHint': 'Archived tasks appear here',
    'bulk.select': 'Select',
    'bulk.selected': 'selected',
    'common.all': 'All',
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.done': 'Done',
    'common.error': 'Error',
    'common.undo': 'Undo',
    'common.tasks': 'tasks',
    'energyLevel.high': 'High energy',
    'filters.label': 'Filters',
    'focus.nextActions': 'Next Actions',
    'focus.schedule': 'Today',
    'savedFilters.save': 'Save',
    'task.updateFailed': 'Could not update task.',
    'taskEdit.locationLabel': 'Location',
    'taskEdit.locationPlaceholder': 'e.g. Office',
    'trash.restoreToInbox': 'Restore to Inbox',
  };
  return (key: string) => labels[key] ?? key;
});

const PERFORMANCE_BUDGET_MS = {
  openEditor: 300,
  toggleProjectPicker: 80,
  saveWhileEditorMounted: 150,
  toggleCompleteWhileEditorMounted: 150,
  renderFocus: 350,
  renderProjectDetail: 500,
  renderTaskList: 350,
  renderArchived: 350,
  selectAllArchived: 150,
  renderTrash: 350,
  selectAllTrash: 150,
  renderProjects: 350,
} as const;

const CONTEXTS = ['@home', '@work', '@errands', '@calls', '@computer', '@deep-work'];
const TAGS = ['#admin', '#writing', '#health', '#finance', '#planning', '#follow-up'];
const LOCATIONS = ['Home office', 'Studio', 'Library', 'Downtown', 'Remote'];
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVELS: TaskEnergyLevel[] = ['low', 'medium', 'high'];
const TIME_ESTIMATES: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
const BASE_ISO = '2026-05-01T09:00:00.000Z';

type LargeStoreData = {
  areas: Area[];
  projects: Project[];
  sections: Section[];
  settings: AppData['settings'];
  targetTask: Task;
  tasks: Task[];
};

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const react = await import('react');

  const selectionMatches = (
    previous: unknown,
    next: unknown,
    equalityFn?: (left: unknown, right: unknown) => boolean,
  ) => (equalityFn ? equalityFn(previous, next) : Object.is(previous, next));

  const useTaskStore = Object.assign((
    selector?: (state: ReturnType<typeof actual.useTaskStore.getState>) => unknown,
    equalityFn?: (left: unknown, right: unknown) => boolean,
  ) => {
    const selectorRef = react.useRef(selector);
    const equalityRef = react.useRef(equalityFn);
    const selectedRef = react.useRef<unknown>(undefined);
    const [, forceRender] = react.useReducer((count: number) => count + 1, 0);

    selectorRef.current = selector;
    equalityRef.current = equalityFn;

    const selectSnapshot = () => {
      const state = actual.useTaskStore.getState();
      return selectorRef.current ? selectorRef.current(state) : state;
    };

    const currentSelection = selectSnapshot();
    if (
      selectedRef.current === undefined
      || !selectionMatches(selectedRef.current, currentSelection, equalityRef.current)
    ) {
      selectedRef.current = currentSelection;
    }

    react.useEffect(() => actual.useTaskStore.subscribe((state) => {
      const nextSelection = selectorRef.current ? selectorRef.current(state) : state;
      if (selectionMatches(selectedRef.current, nextSelection, equalityRef.current)) return;
      selectedRef.current = nextSelection;
      forceRender();
    }), []);

    return selectedRef.current;
  }, actual.useTaskStore);

  return {
    ...actual,
    useTaskStore,
  };
});

vi.mock('react-native-draggable-flatlist', async () => {
  const react = await import('react');
  return {
    __esModule: true,
    default: (props: any) => react.createElement('DraggableFlatList', props),
  };
});

// The shared React Native test shim renders every SectionList row. For this
// perf guard, keep the render path closer to native virtualization.
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  const react = await import('react');

  const SectionList = ({
    sections = [],
    renderItem,
    renderSectionHeader,
    keyExtractor,
    ListHeaderComponent,
    ListEmptyComponent,
    initialNumToRender = 10,
    children,
    ...props
  }: any) => {
    const renderedChildren: React.ReactNode[] = [];
    const headerNode = typeof ListHeaderComponent === 'function'
      ? react.createElement(ListHeaderComponent)
      : ListHeaderComponent;

    if (headerNode) {
      renderedChildren.push(react.createElement(react.Fragment, { key: 'list-header' }, headerNode));
    }

    let renderedItemCount = 0;
    let remainingItems = Number.isFinite(initialNumToRender) ? Math.max(0, initialNumToRender) : 10;

    sections.forEach((section: any, sectionIndex: number) => {
      const sectionHeaderNode = renderSectionHeader?.({ section });
      if (sectionHeaderNode) {
        renderedChildren.push(
          react.createElement(react.Fragment, { key: `section-header-${sectionIndex}` }, sectionHeaderNode)
        );
      }

      (section?.data ?? []).some((item: any, itemIndex: number) => {
        if (remainingItems <= 0) return true;
        renderedItemCount += 1;
        remainingItems -= 1;
        const key = keyExtractor?.(item, itemIndex) ?? `section-${sectionIndex}-item-${itemIndex}`;
        renderedChildren.push(
          react.createElement(
            react.Fragment,
            { key },
            renderItem?.({ item, index: itemIndex, section })
          )
        );
        return false;
      });
    });

    if (renderedItemCount === 0) {
      const emptyNode = typeof ListEmptyComponent === 'function'
        ? react.createElement(ListEmptyComponent)
        : ListEmptyComponent;
      if (emptyNode) {
        renderedChildren.push(react.createElement(react.Fragment, { key: 'list-empty' }, emptyNode));
      }
    }

    if (children) renderedChildren.push(children);

    return react.createElement('SectionList', props, renderedChildren);
  };

  const RefreshControl = (props: any) => (
    react.createElement('RefreshControl', props, props.children)
  );

  return {
    ...actual,
    RefreshControl,
    SectionList,
    useWindowDimensions: () => ({ height: 844, width: 390 }),
  };
});

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    language: 'en',
    t: translate,
  }),
}));

// ToastProvider hands out one stable showToast/dismissToast pair (useCallback with no deps,
// behind a memoized context value). Returning fresh spies per render would instead churn every
// handler that closes over them, which is exactly what the render-count assertions below watch
// for — the mock has to keep production's identity guarantee to measure anything real.
const toastControls = vi.hoisted(() => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
}));

vi.mock('@/contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => toastControls,
}));

vi.mock('@/lib/sync-service', () => ({
  getMobileSyncConfigurationStatus: vi.fn().mockResolvedValue({ backend: 'off', configured: false }),
  performMobileSync: vi.fn().mockResolvedValue({ success: true }),
}));

// resolveThemeTokens caches its result, so the real useThemeColors hands out the SAME
// object until the theme actually changes, and every memo boundary taking `tc` compares
// it by identity. Returning a fresh literal per call would switch those boundaries off
// and measure an app that re-renders more than the real one. Keep one hoisted object so
// the mock matches production's identity guarantee; do not inline it back.
const themeColors = vi.hoisted(() => ({
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
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => themeColors,
}));

vi.mock('../lib/ai-config', () => ({
  loadAIKey: vi.fn().mockResolvedValue(''),
  isAIKeyRequired: vi.fn().mockReturnValue(false),
  buildAIConfig: vi.fn().mockReturnValue({}),
  buildCopilotConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../components/task-edit/TaskEditViewTab', () => ({
  TaskEditViewTab: React.memo(function TaskEditViewTabMock(props: Record<string, unknown>) {
    heavyEditorTabRenderCounts.view += 1;
    return React.createElement('TaskEditViewTab', props);
  }),
}));

vi.mock('../components/task-edit/TaskEditFormTab', () => ({
  TaskEditFormTab: React.memo(function TaskEditFormTabMock(props: Record<string, unknown>) {
    heavyEditorTabRenderCounts.form += 1;
    return React.createElement('TaskEditFormTab', props);
  }),
}));

// Production wraps the row in React.memo(_, areRowPropsEqual) (#766), and that
// comparator is exactly React's default: same key count, every prop compared by
// Object.is. A bare function stub would switch the boundary off and measure an
// app that re-renders far more than the real one — the same trap the theme-mock
// note above describes. Keep the memo; do not unwrap it.
vi.mock('../components/swipeable-task-item', () => ({
  readTaskRowRenderCount: () => 0,
  SwipeableTaskItem: React.memo((props: Record<string, unknown>) => React.createElement('SwipeableTaskItem', props)),
}));

vi.mock('../components/pomodoro-panel', () => ({
  PomodoroPanel: (props: Record<string, unknown>) => React.createElement('PomodoroPanel', props),
}));

// This closed overlay is outside the list render path under measurement.
vi.mock('../components/task-list/TaskListTagModal', () => ({
  TaskListTagModal: () => null,
}));

vi.mock('lucide-react-native', () => {
  const Icon = (props: Record<string, unknown>) => React.createElement('Icon', props);
  return {
    Archive: Icon,
    AlertTriangle: Icon,
    ArrowDown: Icon,
    ArrowRight: Icon,
    ArrowUp: Icon,
    ArrowUpDown: Icon,
    BatteryCharging: Icon,
    BatteryFull: Icon,
    BatteryLow: Icon,
    BatteryMedium: Icon,
    Eye: Icon,
    Pencil: Icon,
    BookOpen: Icon,
    BookmarkPlus: Icon,
    CalendarDays: Icon,
    Check: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    CircleDot: Icon,
    CircleSlash: Icon,
    ClipboardCheck: Icon,
    Copy: Icon,
    Flag: Icon,
    Folder: Icon,
    GripVertical: Icon,
    Hourglass: Icon,
    Layers: Icon,
    List: Icon,
    ListTodo: Icon,
    MapPin: Icon,
    MoreHorizontal: Icon,
    Save: Icon,
    SlidersHorizontal: Icon,
    Star: Icon,
    Timer: Icon,
    Trash2: Icon,
    User: Icon,
    X: Icon,
  };
});

vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: {
    Warning: 'warning',
  },
  notificationAsync: vi.fn().mockResolvedValue(undefined),
  selectionAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({ areaById: new Map(), resolvedAreaFilter: { included: [], excluded: [] } }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: { children?: React.ReactNode }) =>
    React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => React.createElement('DateTimePicker', props),
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
  usePathname: () => '/projects-screen',
  router: {
    push: vi.fn(),
    navigate: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
  },
  useLocalSearchParams: () => ({}),
}));

vi.mock('react-native-draggable-flatlist', () => ({
  NestableDraggableFlatList: (props: any) => React.createElement('NestableDraggableFlatList', props, props.children),
  NestableScrollContainer: (props: any) => React.createElement('NestableScrollContainer', props, props.children),
  ScaleDecorator: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: (props: any) => React.createElement('GestureHandlerRootView', props, props.children),
  Swipeable: React.forwardRef(function SwipeableMock({ children, renderLeftActions, renderRightActions, ...props }: any, ref: any) {
    React.useImperativeHandle(ref, () => ({ close: () => undefined }));
    return React.createElement(
      'Swipeable',
      props,
      renderLeftActions ? renderLeftActions() : null,
      children,
      renderRightActions ? renderRightActions() : null,
    );
  }),
}));

const buildMap = <T extends { id: string }>(items: readonly T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item] as const));

const createArea = (index: number): Area => ({
  id: `area-${index}`,
  name: `Area ${index}`,
  color: '#2563EB',
  order: index,
  createdAt: BASE_ISO,
  updatedAt: BASE_ISO,
  rev: 1,
  revBy: 'perf-device',
});

const createProject = (index: number): Project => ({
  id: `project-${index}`,
  title: `Project ${index}`,
  status: 'active',
  color: '#2563EB',
  order: index,
  tagIds: [TAGS[index % TAGS.length]],
  areaId: `area-${index % 5}`,
  createdAt: BASE_ISO,
  updatedAt: BASE_ISO,
  isSequential: index % 9 === 0,
  sequentialScope: index % 18 === 0 ? 'section' : 'project',
  rev: 1,
  revBy: 'perf-device',
});

const createSection = (project: Project, index: number): Section => ({
  id: `section-${project.id}-${index}`,
  projectId: project.id,
  title: `Section ${project.id}-${index}`,
  order: index,
  createdAt: BASE_ISO,
  updatedAt: BASE_ISO,
  rev: 1,
  revBy: 'perf-device',
});

const getSyntheticTaskStatus = (index: number): TaskStatus => {
  if (index < 60) return 'next';
  if (index % 23 === 0) return 'reference';
  if (index % 11 === 0) return 'done';
  if (index % 7 === 0) return 'waiting';
  if (index % 5 === 0) return 'inbox';
  return 'next';
};

const createLargeStoreData = (count = LARGE_TASK_COUNT): LargeStoreData => {
  const areas = Array.from({ length: 5 }, (_, index) => createArea(index));
  const projects = Array.from({ length: PROJECT_COUNT }, (_, index) => createProject(index));
  const sections = projects.flatMap((project) =>
    Array.from({ length: SECTIONS_PER_PROJECT }, (_, index) => createSection(project, index))
  );
  const tasks: Task[] = Array.from({ length: count }, (_, index) => {
    const project = projects[index % projects.length];
    const section = sections[(index % projects.length) * SECTIONS_PER_PROJECT + (index % SECTIONS_PER_PROJECT)];
    const status = getSyntheticTaskStatus(index);
    const isDone = status === 'done';
    const isReference = status === 'reference';

    return {
      id: `task-${index}`,
      title: `Synthetic task ${index}`,
      status,
      projectId: project.id,
      sectionId: section.id,
      areaId: project.areaId,
      contexts: [
        CONTEXTS[index % CONTEXTS.length],
        `${CONTEXTS[(index + 2) % CONTEXTS.length]}/sub-${index % 4}`,
      ],
      tags: [
        TAGS[index % TAGS.length],
        `${TAGS[(index + 3) % TAGS.length]}/topic-${index % 5}`,
      ],
      priority: PRIORITIES[index % PRIORITIES.length],
      energyLevel: ENERGY_LEVELS[index % ENERGY_LEVELS.length],
      timeEstimate: TIME_ESTIMATES[index % TIME_ESTIMATES.length],
      location: LOCATIONS[index % LOCATIONS.length],
      startTime: index % 6 === 0 && !isReference ? '2026-05-01' : undefined,
      dueDate: index % 8 === 0 && !isReference ? '2026-05-02' : undefined,
      completedAt: isDone ? '2026-05-03T12:00:00.000Z' : undefined,
      description: `Synthetic description ${index}`,
      checklist: index % 13 === 0
        ? [
          { id: `check-${index}-1`, title: 'First step', isCompleted: index % 2 === 0 },
          { id: `check-${index}-2`, title: 'Second step', isCompleted: false },
        ]
        : undefined,
      isFocusedToday: index < 8,
      order: index,
      orderNum: index,
      pushCount: 0,
      taskMode: index % 19 === 0 ? 'list' : 'task',
      createdAt: BASE_ISO,
      updatedAt: `2026-05-${String((index % 27) + 1).padStart(2, '0')}T09:00:00.000Z`,
      rev: 1,
      revBy: 'perf-device',
    };
  });

  const settings: AppData['settings'] = {
    appearance: { showFutureStarts: false },
    ai: { enabled: false },
    deviceId: 'perf-device',
    features: {
      pomodoro: false,
      priorities: true,
      timeEstimates: true,
    },
    gtd: {
      focusTaskLimit: 10,
      taskEditor: {
        hidden: [],
        order: [],
      },
    },
    savedFilters: [],
  };

  return {
    areas,
    projects,
    sections,
    settings,
    targetTask: tasks[1234],
    tasks,
  };
};

type ProjectDetailModalProps = React.ComponentProps<typeof ProjectDetailModal>;

const createProjectNotes = (): ProjectDetailModalProps['notes'] => ({
  commitSelectedProjectNotes: vi.fn(),
  handleSelectedProjectNotesApplyAction: vi.fn(() => ({ value: '', selection: { start: 0, end: 0 } })),
  handleSelectedProjectNotesApplyAutocomplete: vi.fn(),
  handleSelectedProjectNotesChange: vi.fn(),
  handleSelectedProjectNotesSelectionChange: vi.fn(),
  handleSelectedProjectNotesUndo: vi.fn(),
  isSelectedProjectNotesFocused: false,
  notesExpanded: false,
  notesFullscreen: false,
  resetProjectNotesUi: vi.fn(),
  selectedProjectNotes: '',
  selectedProjectNotesDirection: 'ltr',
  selectedProjectNotesInputRef: { current: null },
  selectedProjectNotesSelection: { start: 0, end: 0 },
  selectedProjectNotesTextDirectionStyle: { writingDirection: 'ltr', textAlign: 'left' },
  selectedProjectNotesUndoDepth: 0,
  setIsSelectedProjectNotesFocused: vi.fn(),
  setNotesExpanded: vi.fn(),
  setNotesFullscreen: vi.fn(),
  setShowNotesPreview: vi.fn(),
  showNotesPreview: false,
});

const createProjectAttachments = (): ProjectDetailModalProps['attachments'] => ({
  addProjectFileAttachment: vi.fn(),
  confirmAddProjectLink: vi.fn(),
  downloadAttachment: vi.fn(),
  imagePreviewAttachment: null,
  linkInput: '',
  linkModalVisible: false,
  openAttachment: vi.fn(),
  removeProjectAttachment: vi.fn(),
  resetProjectAttachmentUi: vi.fn(),
  setImagePreviewAttachment: vi.fn(),
  setLinkInput: vi.fn(),
  setLinkModalVisible: vi.fn(),
});

const resetStore = () => {
  useTaskStore.setState({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
    isLoading: false,
    error: null,
    editLockCount: 0,
    lastDataChangeAt: 0,
    highlightTaskId: null,
    highlightTaskAt: null,
    _allTasks: [],
    _allProjects: [],
    _allSections: [],
    _allAreas: [],
    _tasksById: new Map(),
    _projectsById: new Map(),
    _sectionsById: new Map(),
    _areasById: new Map(),
  });
};

const loadLargeStore = (data: LargeStoreData) => {
  const mockStorage: StorageAdapter = {
    getData: vi.fn().mockResolvedValue({
      tasks: data.tasks,
      projects: data.projects,
      sections: data.sections,
      areas: data.areas,
      settings: data.settings,
    }),
    saveData: vi.fn().mockResolvedValue(undefined),
  };
  setStorageAdapter(mockStorage);
  useTaskStore.setState({
    tasks: data.tasks,
    projects: data.projects,
    sections: data.sections,
    areas: data.areas,
    settings: data.settings,
    isLoading: false,
    error: null,
    editLockCount: 0,
    lastDataChangeAt: 0,
    highlightTaskId: null,
    highlightTaskAt: null,
    _allTasks: data.tasks,
    _allProjects: data.projects,
    _allSections: data.sections,
    _allAreas: data.areas,
    _tasksById: buildMap(data.tasks),
    _projectsById: buildMap(data.projects),
    _sectionsById: buildMap(data.sections),
    _areasById: buildMap(data.areas),
  });
};

const measureSync = (operation: () => void): number => {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
};

const measureBestSync = (
  operation: () => void,
  cleanup: () => void,
  attempts = 3,
): number => {
  let bestMs = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    cleanup();
    bestMs = Math.min(bestMs, measureSync(operation));
  }
  return bestMs;
};

const measureAsync = async (operation: () => Promise<void>): Promise<number> => {
  const startedAt = performance.now();
  await operation();
  return performance.now() - startedAt;
};

const measureBestAsync = async (
  operation: (attempt: number) => Promise<void>,
  attempts = 3,
): Promise<number> => {
  let bestMs = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    bestMs = Math.min(bestMs, await measureAsync(() => operation(attempt)));
  }
  return bestMs;
};

const expectWithinBudget = (label: string, actualMs: number, budgetMs: number) => {
  expect(
    actualMs,
    `${label} took ${actualMs.toFixed(1)}ms with ${LARGE_TASK_COUNT} tasks; budget is ${budgetMs}ms`
  ).toBeLessThanOrEqual(budgetMs);
};

describe('large-store mobile interaction performance', () => {
  afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    resetStore();
    heavyEditorTabRenderCounts.form = 0;
    heavyEditorTabRenderCounts.view = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not rerender heavy editor tabs when dismissing the project picker', async () => {
    vi.useFakeTimers();
    const data = createLargeStoreData();
    loadLargeStore(data);
    heavyEditorTabRenderCounts.form = 0;
    heavyEditorTabRenderCounts.view = 0;

    let editorTree: ReactTestRenderer | null = null;
    await act(async () => {
      editorTree = renderer.create(
        <TaskEditModal
          visible
          task={data.targetTask}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    const initialFormRenders = heavyEditorTabRenderCounts.form;
    const initialViewRenders = heavyEditorTabRenderCounts.view;
    const formTab = editorTree!.root.findAll((node) => String(node.type) === 'TaskEditFormTab')[0];
    if (!formTab) throw new Error('TaskEditFormTab not found');
    const projectField = formTab.props.renderField('project') as React.ReactElement<Record<string, unknown>>;
    const setShowProjectPicker = projectField.props.setShowProjectPicker as (visible: boolean) => void;

    const togglePickerMs = measureSync(() => {
      act(() => {
        setShowProjectPicker(true);
      });
      const projectPickerModal = editorTree!.root.findAll(
        (node) => node.props.accessibilityViewIsModal === true && typeof node.props.onRequestClose === 'function'
      )[0];
      if (!projectPickerModal) throw new Error('Project picker modal not found');
      act(() => {
        projectPickerModal.props.onRequestClose();
      });
    });

    expect(heavyEditorTabRenderCounts.form).toBe(initialFormRenders);
    expect(heavyEditorTabRenderCounts.view).toBe(initialViewRenders);
    expectWithinBudget(
      'Toggle project picker',
      togglePickerMs,
      PERFORMANCE_BUDGET_MS.toggleProjectPicker
    );

    act(() => {
      editorTree?.unmount();
    });
  });

  it('keeps the shared TaskList render within the large-store budget', () => {
    const data = createLargeStoreData();
    loadLargeStore(data);

    let taskListTree: ReactTestRenderer | null = null;
    const renderTaskListMs = measureBestSync(
      () => {
        act(() => {
          taskListTree = renderer.create(<TaskList title="Next" statusFilter="next" />);
        });
      },
      () => {
        act(() => {
          taskListTree?.unmount();
          taskListTree = null;
        });
      },
    );

    expectWithinBudget(
      'Render TaskList',
      renderTaskListMs,
      PERFORMANCE_BUDGET_MS.renderTaskList,
    );
    expect(taskListTree).not.toBeNull();

    act(() => {
      taskListTree?.unmount();
    });
  });

  it('keeps ProjectDetailModal with 5,000 project tasks within budget', () => {
    const data = createLargeStoreData();
    const selectedProject = data.projects[0];
    const projectTasks = data.tasks.map((entry) => ({
      ...entry,
      areaId: selectedProject.areaId,
      projectId: selectedProject.id,
      sectionId: undefined,
    }));
    loadLargeStore({
      ...data,
      targetTask: projectTasks[1234],
      tasks: projectTasks,
    });

    const props: ProjectDetailModalProps = {
      areaName: 'Area 0',
      attachments: createProjectAttachments(),
      notes: createProjectNotes(),
      onClose: vi.fn(),
      onDeleteProject: vi.fn(),
      onDuplicateProject: vi.fn(),
      onOpenAreaPicker: vi.fn(),
      onOpenQuickAdd: vi.fn(),
      onOpenTagPicker: vi.fn(),
      onProjectChange: vi.fn(),
      onTaskSortByChange: vi.fn(),
      project: selectedProject,
      sections: [],
      taskSortBy: 'default',
      tasks: projectTasks,
    };
    let projectDetailTree: ReactTestRenderer | null = null;
    const renderProjectDetailMs = measureBestSync(
      () => {
        act(() => {
          projectDetailTree = renderer.create(<ProjectDetailModal {...props} />);
        });
      },
      () => {
        act(() => {
          projectDetailTree?.unmount();
          projectDetailTree = null;
        });
      },
    );

    expectWithinBudget(
      'Render ProjectDetailModal',
      renderProjectDetailMs,
      PERFORMANCE_BUDGET_MS.renderProjectDetail,
    );
    expect(projectDetailTree).not.toBeNull();

    act(() => {
      projectDetailTree?.unmount();
    });
  });

  it('keeps Archived select-all within the large-store budget', async () => {
    const data = createLargeStoreData();
    const archivedTasks = data.tasks.map((task) => ({
      ...task,
      status: 'archived' as const,
      completedAt: task.completedAt ?? '2026-05-03T12:00:00.000Z',
    }));
    loadLargeStore({
      ...data,
      tasks: archivedTasks,
      targetTask: archivedTasks[1234],
    });

    let archivedTree: ReactTestRenderer | null = null;
    const renderArchivedMs = measureSync(() => {
      act(() => {
        archivedTree = renderer.create(<ArchivedScreen />);
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expectWithinBudget('Render Archived', renderArchivedMs, PERFORMANCE_BUDGET_MS.renderArchived);
    const selectButton = archivedTree!.root.find(
      (node) => node.props.accessibilityLabel === 'Select',
    );
    act(() => {
      selectButton.props.onPress();
    });
    const selectAllButton = archivedTree!.root.find(
      (node) => node.props.accessibilityLabel === 'Select All',
    );
    const selectAllArchivedMs = measureSync(() => {
      act(() => {
        selectAllButton.props.onPress();
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expectWithinBudget(
      'Select all Archived tasks',
      selectAllArchivedMs,
      PERFORMANCE_BUDGET_MS.selectAllArchived,
    );
    expect(archivedTree!.root.findAll(
      (node) => node.props.accessibilityLabel === `${LARGE_TASK_COUNT} selected`,
    ).length).toBeGreaterThan(0);

    act(() => {
      archivedTree?.unmount();
    });
  }, 15_000);

  it('keeps Trash select-all within the large-store budget', async () => {
    const data = createLargeStoreData();
    const trashedTasks = data.tasks.map((task) => ({
      ...task,
      deletedAt: '2026-05-04T12:00:00.000Z',
    }));
    loadLargeStore({
      ...data,
      tasks: trashedTasks,
      targetTask: trashedTasks[1234],
    });

    let trashTree: ReactTestRenderer | null = null;
    const renderTrashMs = measureSync(() => {
      act(() => {
        trashTree = renderer.create(<TrashScreen />);
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expectWithinBudget('Render Trash', renderTrashMs, PERFORMANCE_BUDGET_MS.renderTrash);
    const selectButton = trashTree!.root.find(
      (node) => node.props.accessibilityLabel === 'Select',
    );
    act(() => {
      selectButton.props.onPress();
    });
    const selectAllButton = trashTree!.root.find(
      (node) => node.props.accessibilityLabel === 'Select All',
    );
    const selectAllTrashMs = measureSync(() => {
      act(() => {
        selectAllButton.props.onPress();
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expectWithinBudget(
      'Select all Trash tasks',
      selectAllTrashMs,
      PERFORMANCE_BUDGET_MS.selectAllTrash,
    );
    expect(trashTree!.root.findAll(
      (node) => node.props.accessibilityLabel === `${LARGE_TASK_COUNT} selected`,
    ).length).toBeGreaterThan(0);

    act(() => {
      trashTree?.unmount();
    });
  }, 15_000);

  it('keeps core mobile interactions under the large-store budget', async () => {
    const data = createLargeStoreData();
    loadLargeStore(data);

    let editorTree: ReactTestRenderer | null = null;
    const openEditorMs = measureBestSync(
      () => {
        act(() => {
          editorTree = renderer.create(
            <TaskEditModal
              visible
              task={data.targetTask}
              onClose={vi.fn()}
              onSave={vi.fn()}
            />
          );
        });
      },
      () => {
        act(() => {
          editorTree?.unmount();
          editorTree = null;
        });
      }
    );

    expectWithinBudget('Open editor', openEditorMs, PERFORMANCE_BUDGET_MS.openEditor);
    expect(editorTree).not.toBeNull();

    let saveResult: Awaited<ReturnType<ReturnType<typeof useTaskStore.getState>['updateTask']>> | null = null;
    const saveMs = await measureBestAsync(async (attempt) => {
      await act(async () => {
        saveResult = await useTaskStore.getState().updateTask(data.targetTask.id, {
          title: `Synthetic task 1234 updated ${attempt}`,
          description: `Updated from the large-store performance guard ${attempt}`,
        });
      });
    });

    expect(saveResult).toMatchObject({ success: true });
    expectWithinBudget(
      'Save task while editor is mounted',
      saveMs,
      PERFORMANCE_BUDGET_MS.saveWhileEditorMounted
    );

    let toggleResult: Awaited<ReturnType<ReturnType<typeof useTaskStore.getState>['updateTask']>> | null = null;
    const toggleCompleteMs = await measureBestAsync(async (attempt) => {
      await act(async () => {
        toggleResult = await useTaskStore.getState().updateTask(data.targetTask.id, {
          status: attempt % 2 === 0 ? 'done' : 'next',
        });
      });
    });

    expect(toggleResult).toMatchObject({ success: true });
    expectWithinBudget(
      'Toggle complete while editor is mounted',
      toggleCompleteMs,
      PERFORMANCE_BUDGET_MS.toggleCompleteWhileEditorMounted
    );

    await act(async () => {
      editorTree?.unmount();
    });
    await flushPendingSave();

    const focusData = createLargeStoreData();
    loadLargeStore(focusData);

    let focusTree: ReactTestRenderer | null = null;
    const renderFocusMs = measureBestSync(
      () => {
        act(() => {
          focusTree = renderer.create(<FocusScreen />);
        });
      },
      () => {
        act(() => {
          focusTree?.unmount();
          focusTree = null;
        });
      }
    );

    expectWithinBudget('Render Focus', renderFocusMs, PERFORMANCE_BUDGET_MS.renderFocus);
    expect(focusTree).not.toBeNull();

    await act(async () => {
      focusTree?.unmount();
    });

    const projectsData = createLargeStoreData();
    loadLargeStore(projectsData);
    const projectAreaById = buildMap(projectsData.areas);
    // Core's real computeTaskDerivedState output (#927) — the same summary the
    // screen reads via getDerivedState(), not a test-local reimplementation.
    const projectTaskSummaryById = useTaskStore.getState().getDerivedState().projectTaskSummaryById;
    const projectRows = buildProjectListRows({
      areaById: projectAreaById,
      collapsedAreas: {},
      groupedActiveProjects: [{
        areaId: 'area-0',
        projects: projectsData.projects,
      }],
      groupedArchivedProjects: [],
      groupedDeferredProjects: [],
      showArchivedProjects: false,
      showDeferredProjects: false,
      t: (key) => key,
    }).filter((row) => row.type === 'project');

    let projectRowsTree: ReactTestRenderer | null = null;
    const renderProjectsMs = measureBestSync(
      () => {
        act(() => {
          projectRowsTree = renderer.create(
            <>
              {projectRows.map((row) => (
                <ProjectRow
                  key={row.project.id}
                  project={row.project}
                  taskSummary={projectTaskSummaryById.get(row.project.id)}
                  tc={{
                    cardBg: '#111827',
                    secondaryText: '#94a3b8',
                    text: '#f8fafc',
                    tint: '#3b82f6',
                  }}
                  focusedCount={0}
                  statusPalette={{
                    active: { text: '#3b82f6', bg: '#3b82f622', border: '#3b82f6' },
                    waiting: { text: '#F59E0B', bg: '#F59E0B22', border: '#F59E0B' },
                    someday: { text: '#A855F7', bg: '#A855F722', border: '#A855F7' },
                    archived: { text: '#94a3b8', bg: '#1f2937', border: '#334155' },
                  }}
                  t={(key) => key}
                  onDeleteProject={vi.fn()}
                  onDuplicateProject={vi.fn()}
                  onOpenProject={vi.fn()}
                  onToggleProjectFocus={vi.fn()}
                />
              ))}
            </>
          );
        });
      },
      () => {
        act(() => {
          projectRowsTree?.unmount();
          projectRowsTree = null;
        });
      }
    );

    expectWithinBudget('Render Projects', renderProjectsMs, PERFORMANCE_BUDGET_MS.renderProjects);
    expect(projectRowsTree).not.toBeNull();

    await act(async () => {
      projectRowsTree?.unmount();
    });
  }, 15_000);
});
