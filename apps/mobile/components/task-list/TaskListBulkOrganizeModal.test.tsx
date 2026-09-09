import React from 'react';
import { Pressable, Text, TextInput, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Area, Project } from '@mindwtr/core';
import { resetForTests, setStorageAdapter, useTaskStore } from '../../../../packages/core/src/store';

import { TaskListBulkOrganizeModal } from './TaskListBulkOrganizeModal';
import { TaskEditProjectPicker } from '../task-edit/TaskEditProjectPicker';

const createBulkOrganizeProjectMock = vi.hoisted(() => vi.fn());
const createBulkOrganizeAreaMock = vi.hoisted(() => vi.fn());
const ensureDestinationSavedMock = vi.hoisted(() => vi.fn());

vi.mock('@mindwtr/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@mindwtr/core')>(),
  createBulkOrganizeProject: createBulkOrganizeProjectMock,
  createBulkOrganizeArea: createBulkOrganizeAreaMock,
  ensureBulkOrganizeDestinationSaved: ensureDestinationSavedMock,
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ tint: '#3b82f6', onTint: '#ffffff' }),
}));
vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

vi.mock('lucide-react-native', () => {
  const Icon = (props: any) => React.createElement('Icon', props, props.children);
  return {
    __esModule: true,
    Check: Icon,
    ChevronRight: Icon,
    ClipboardCheck: Icon,
    X: Icon,
  };
});

const themeColors = {
  border: '#334155',
  cardBg: '#111827',
  danger: '#ef4444',
  filterBg: '#1f2937',
  inputBg: '#0f172a',
  onTint: '#ffffff',
  secondaryText: '#94a3b8',
  text: '#f8fafc',
  tint: '#3b82f6',
};

const t = (key: string) => ({
  'areas.create': 'Create area',
  'bulk.applyToSelected': 'Apply to selected',
  'bulk.keepArea': 'Keep area',
  'bulk.keepProject': 'Keep project',
  'bulk.organize': 'Bulk organize',
  'bulk.organizeHintShort': 'Titles and descriptions stay unchanged.',
  'bulk.organizeStatus': 'Status',
  'bulk.selected': 'selected',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.noMatches': 'No matches',
  'common.search': 'Search',
  'process.delegateWhoLabel': 'Waiting for',
  'process.delegateWhoPlaceholder': 'Person or team',
  'process.followUpLabel': 'Follow-up',
  'projects.areaLabel': 'Area',
  'projects.create': 'Create project',
  'status.done': 'Done',
  'status.next': 'Next',
  'status.reference': 'Reference',
  'status.someday': 'Someday',
  'status.waiting': 'Waiting',
  'taskEdit.contextsLabel': 'Contexts',
  'taskEdit.dueDateLabel': 'Due',
  'taskEdit.noAreaOption': 'No area',
  'taskEdit.noProjectOption': 'No project',
  'taskEdit.projectLabel': 'Project',
  'taskEdit.reviewDateLabel': 'Review',
  'taskEdit.startDateLabel': 'Start',
  'taskEdit.tagsLabel': 'Tags',
}[key] ?? key);

const makeProject = (id: string, title: string, order: number): Project => ({
  id,
  title,
  status: 'active',
  color: '#3b82f6',
  order,
  tagIds: [],
  createdAt: '2026-06-16T00:00:00.000Z',
  updatedAt: '2026-06-16T00:00:00.000Z',
});

const makeArea = (id: string, name: string, order: number): Area => ({
  id,
  name,
  order,
  createdAt: '2026-06-16T00:00:00.000Z',
  updatedAt: '2026-06-16T00:00:00.000Z',
});

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const renderModal = (
  overrides: Partial<React.ComponentProps<typeof TaskListBulkOrganizeModal>> = {},
) => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <TaskListBulkOrganizeModal
        areas={[
          makeArea('area-home', 'Home', 0),
          makeArea('area-work', 'Work', 1),
        ]}
        isApplying={false}
        onApply={vi.fn()}
        onClose={vi.fn()}
        projects={[
          makeProject('project-launch', 'Launch', 0),
          makeProject('project-trip', 'Japan Trip October', 1),
        ]}
        selectedCount={2}
        t={t}
        themeColors={themeColors}
        visible
        {...overrides}
      />
    );
  });
  return tree;
};

const directButtonText = (node: any) => React.Children.toArray(node.props.children)
  .filter((child): child is React.ReactElement<{ children?: React.ReactNode }> => (
    React.isValidElement(child) && child.type === Text
  ))
  .map((child) => child.props.children)
  .join('');

const buttonWithText = (tree: ReturnType<typeof create>, text: string) => tree.root.find((node) => (
  (node.type === TouchableOpacity || node.type === Pressable)
  && directButtonText(node) === text
));

beforeEach(() => {
  createBulkOrganizeProjectMock.mockReset();
  createBulkOrganizeAreaMock.mockReset();
  ensureDestinationSavedMock.mockReset().mockResolvedValue(undefined);
});

describe('TaskListBulkOrganizeModal', () => {
  it.each(['project', 'area'] as const)('retries storage before selecting a %s left visible by failed creation', async (kind) => {
    const core = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    resetForTests();
    vi.useFakeTimers();
    const saveData = vi.fn().mockRejectedValue(new Error('disk unavailable'));
    setStorageAdapter({
      getData: async () => ({ tasks: [], projects: [], areas: [], sections: [], settings: {} }),
      saveData,
    });
    useTaskStore.setState({
      tasks: [], projects: [], areas: [], sections: [], settings: {},
      _allTasks: [], _allProjects: [], _allAreas: [], _allSections: [],
      _tasksById: new Map(), _projectsById: new Map(), _areasById: new Map(), _sectionsById: new Map(),
      persistenceFailure: null, isLoading: false, error: null,
    });
    createBulkOrganizeProjectMock.mockImplementation(core.createBulkOrganizeProject);
    createBulkOrganizeAreaMock.mockImplementation(core.createBulkOrganizeArea);
    ensureDestinationSavedMock.mockImplementation(core.ensureBulkOrganizeDestinationSaved);
    const onApply = vi.fn();
    const onClose = vi.fn();
    const LiveModal = () => (
      <TaskListBulkOrganizeModal
        projects={useTaskStore((state) => state.projects)}
        areas={useTaskStore((state) => state.areas)}
        isApplying={false} visible selectedCount={2} onApply={onApply} onClose={onClose}
        t={t} themeColors={themeColors}
      />
    );
    let tree!: ReturnType<typeof create>;
    try {
      act(() => { tree = create(<LiveModal />); });
      const openPicker = () => tree.root.findByProps({ testID: `bulk-organize-${kind}-picker-row` }).props.onPress();
      const search = () => tree.root.findAllByType(TextInput).find((node) => (
        node.props.accessibilityLabel === (kind === 'project' ? 'Project' : 'taskEdit.areaLabel')
      ))!;
      act(() => {
        tree.root.findAllByType(TextInput).find((node) => node.props.placeholder === '#project, #admin')!.props.onChangeText('#retained');
        openPicker();
      });
      act(() => { search().props.onChangeText('Draft'); });
      await act(async () => {
        void tree.root.findByProps({ accessibilityLabel: `Create ${kind}: Draft` }).props.onPress();
        await vi.runAllTimersAsync();
      });
      expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
      expect(kind === 'project' ? useTaskStore.getState().projects : useTaskStore.getState().areas).toHaveLength(1);
      // Exact-match keyboard submission now sees the failed entity in live props.
      await act(async () => {
        void search().props.onSubmitEditing();
        buttonWithText(tree, 'Apply to selected').props.onPress();
        await vi.runAllTimersAsync();
      });
      expect(onApply).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(tree.root.findByProps({ testID: `bulk-organize-${kind}-picker-row` }).props.accessibilityLabel)
        .toBe(`${kind === 'project' ? 'Project: Keep project' : 'Area: Keep area'}`);
      expect(tree.root.findAllByProps({ accessibilityRole: 'alert' }).length).toBeGreaterThan(0);
      // Closing/reopening the picker must not bypass the same save barrier.
      saveData.mockResolvedValue(undefined);
      act(() => { openPicker(); });
      await act(async () => { buttonWithText(tree, 'Draft').props.onPress(); });
      expect(useTaskStore.getState().persistenceFailure).toBeNull();
      act(() => { buttonWithText(tree, 'Apply to selected').props.onPress(); });
      const entity = kind === 'project' ? useTaskStore.getState().projects[0] : useTaskStore.getState().areas[0];
      expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ [`${kind}Id`]: entity.id, tags: ['#retained'] }));
      expect(useTaskStore.getState().tasks).toEqual([]);
    } finally {
      if (tree) act(() => { tree.unmount(); });
      resetForTests();
      vi.useRealTimers();
    }
  });

  it('uses collapsed selector rows for project and area so unbounded options are not clipped inline', () => {
    const tree = renderModal();

    expect(tree.root.findByProps({ testID: 'bulk-organize-project-picker-row' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'bulk-organize-area-picker-row' })).toBeTruthy();
    expect(tree.root.findAll((node) => (
      node.type === TouchableOpacity
      && node.findAllByType(Text).some((textNode) => textNode.props.children === 'Japan Trip October')
    ))).toHaveLength(0);
  });

  it('keeps project unchanged by default and applies a selected project from the picker', async () => {
    const onApply = vi.fn();
    const tree = renderModal({ onApply });

    act(() => {
      tree.root.findByProps({ testID: 'bulk-organize-project-picker-row' }).props.onPress();
    });
    await act(async () => {
      buttonWithText(tree, 'Japan Trip October').props.onPress();
    });
    act(() => {
      buttonWithText(tree, 'Apply to selected').props.onPress();
    });

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-trip',
    }));
    // Status defaults to "Keep status": untouched statuses must not be rewritten.
    expect(onApply.mock.calls[0][0]).not.toHaveProperty('status');
  });

  it('includes status only after explicitly picking one', () => {
    const onApply = vi.fn();
    const tree = renderModal({ onApply });

    act(() => {
      buttonWithText(tree, 'Someday').props.onPress();
    });
    act(() => {
      buttonWithText(tree, 'Apply to selected').props.onPress();
    });

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ status: 'someday' }));
  });

  it('preserves the keep sentinel as the first picker option', () => {
    const tree = renderModal();

    act(() => {
      tree.root.findByProps({ testID: 'bulk-organize-area-picker-row' }).props.onPress();
    });

    const areaOptions = tree.root.findAll((node) => (
      (node.type === TouchableOpacity || node.type === Pressable)
      && node.props.accessibilityRole === 'button'
      && node.findAllByType(Text).length > 0
    ));
    const labels = areaOptions
      .map(directButtonText)
      .filter(Boolean);

    expect(labels).toContain('Keep area');
    expect(labels.indexOf('Keep area')).toBeLessThan(labels.indexOf('No area'));
  });

  it('does not emit duplicate-key warnings when project or area names repeat', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderModal({
      areas: [
        makeArea('area-work-1', 'Work', 0),
        makeArea('area-work-2', 'Work', 1),
      ],
      projects: [
        makeProject('project-work-1', 'Work', 0),
        makeProject('project-work-2', 'Work', 1),
      ],
    });

    const duplicateKeyWarnings = consoleError.mock.calls.filter(([message]) => (
      String(message).includes('Encountered two children with the same key')
    ));
    consoleError.mockRestore();

    expect(duplicateKeyWarnings).toHaveLength(0);
  });

  it('creates a project in the explicitly chosen area without applying task changes', async () => {
    const createdProject = {
      ...makeProject('project-new', 'New Project', 2),
      areaId: 'area-work',
    };
    createBulkOrganizeProjectMock.mockResolvedValue(createdProject);
    const onApply = vi.fn();
    const onClose = vi.fn();
    const tree = renderModal({ onApply, onClose });

    act(() => {
      tree.root.findByProps({ testID: 'bulk-organize-area-picker-row' }).props.onPress();
    });
    await act(async () => {
      buttonWithText(tree, 'Work').props.onPress();
    });
    act(() => {
      tree.root.findAllByType(TextInput)
        .find((node) => node.props.placeholder === '@computer, @office')
        ?.props.onChangeText('@desk');
      tree.root.findByProps({ testID: 'bulk-organize-project-picker-row' }).props.onPress();
    });
    const projectSearch = tree.root.findAllByType(TextInput)
      .find((node) => node.props.accessibilityLabel === 'Project');
    act(() => {
      projectSearch?.props.onChangeText('New Project');
    });
    await act(async () => {
      await tree.root.findByProps({ accessibilityLabel: 'Create project: New Project' }).props.onPress();
    });

    expect(createBulkOrganizeProjectMock).toHaveBeenCalledWith('New Project', 'area-work');
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      buttonWithText(tree, 'Apply to selected').props.onPress();
    });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-new',
      contexts: ['@desk'],
    }));
    expect(onApply.mock.calls[0][0]).not.toHaveProperty('areaId');
  });

  it('blocks Apply and dismissal while destination creation is pending', async () => {
    const pending = deferred<Project | null>();
    createBulkOrganizeProjectMock.mockReturnValue(pending.promise);
    const onApply = vi.fn();
    const onClose = vi.fn();
    const tree = renderModal({ onApply, onClose });

    act(() => {
      tree.root.findByProps({ testID: 'bulk-organize-project-picker-row' }).props.onPress();
    });
    const projectSearch = tree.root.findAllByType(TextInput)
      .find((node) => node.props.accessibilityLabel === 'Project');
    act(() => {
      projectSearch?.props.onChangeText('Pending Project');
    });
    act(() => {
      void tree.root.findByProps({ accessibilityLabel: 'Create project: Pending Project' }).props.onPress();
    });

    const applyButton = buttonWithText(tree, 'Apply to selected');
    expect(applyButton.props.disabled).toBe(true);
    act(() => {
      applyButton.props.onPress();
      tree.root.findByProps({ accessibilityLabel: 'Close' }).props.onPress();
    });
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(makeProject('project-pending', 'Pending Project', 2));
      await pending.promise;
    });
    act(() => {
      buttonWithText(tree, 'Apply to selected').props.onPress();
    });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-pending' }));
  });

  it('creates and selects an area without applying until requested', async () => {
    createBulkOrganizeAreaMock.mockResolvedValue(makeArea('area-errands', 'Errands', 2));
    const onApply = vi.fn();
    const tree = renderModal({ onApply });

    act(() => {
      tree.root.findByProps({ testID: 'bulk-organize-area-picker-row' }).props.onPress();
    });
    const areaSearch = tree.root.findAllByType(TextInput)
      .find((node) => node.props.accessibilityLabel === 'taskEdit.areaLabel');
    act(() => {
      areaSearch?.props.onChangeText('Errands');
    });
    await act(async () => {
      await tree.root.findByProps({ accessibilityLabel: 'Create area: Errands' }).props.onPress();
    });

    expect(createBulkOrganizeAreaMock).toHaveBeenCalledWith('Errands');
    expect(onApply).not.toHaveBeenCalled();
    act(() => {
      buttonWithText(tree, 'Apply to selected').props.onPress();
    });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ areaId: 'area-errands' }));
  });

  it('ignores a stale create result after the bulk editor closes and reopens', async () => {
    const pending = deferred<Project | null>();
    createBulkOrganizeProjectMock.mockReturnValue(pending.promise);
    const onApply = vi.fn();
    const onClose = vi.fn();
    const baseProps = {
      areas: [makeArea('area-work', 'Work', 0)],
      isApplying: false,
      onApply,
      onClose,
      projects: [makeProject('project-launch', 'Launch', 0)],
      selectedCount: 2,
      t,
      themeColors,
    };
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TaskListBulkOrganizeModal {...baseProps} visible />);
    });
    act(() => {
      tree.root.findByProps({ testID: 'bulk-organize-project-picker-row' }).props.onPress();
    });
    const projectSearch = tree.root.findAllByType(TextInput)
      .find((node) => node.props.accessibilityLabel === 'Project');
    act(() => {
      projectSearch?.props.onChangeText('Stale Project');
    });
    act(() => {
      void tree.root.findByProps({ accessibilityLabel: 'Create project: Stale Project' }).props.onPress();
    });
    act(() => {
      tree.update(<TaskListBulkOrganizeModal {...baseProps} visible={false} />);
    });
    act(() => {
      tree.update(<TaskListBulkOrganizeModal {...baseProps} visible />);
    });

    await act(async () => {
      pending.resolve(makeProject('project-stale', 'Stale Project', 1));
      await pending.promise;
    });
    act(() => {
      buttonWithText(tree, 'Apply to selected').props.onPress();
    });

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).not.toHaveProperty('projectId');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not create from a pre-opened picker after bulk Apply starts', async () => {
    createBulkOrganizeProjectMock.mockResolvedValue(makeProject('project-blocked', 'Blocked', 1));
    const props = {
      areas: [makeArea('area-work', 'Work', 0)],
      onApply: vi.fn(),
      onClose: vi.fn(),
      projects: [makeProject('project-launch', 'Launch', 0)],
      selectedCount: 2,
      t,
      themeColors,
      visible: true,
    };
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TaskListBulkOrganizeModal {...props} isApplying={false} />);
    });
    act(() => {
      tree.root.findByProps({ testID: 'bulk-organize-project-picker-row' }).props.onPress();
    });
    expect(tree.root.findByType(TaskEditProjectPicker).props.allowCreate).not.toBe(false);

    act(() => {
      tree.update(<TaskListBulkOrganizeModal {...props} isApplying />);
    });
    const picker = tree.root.findByType(TaskEditProjectPicker);
    await act(async () => {
      expect(await picker.props.onCreateProject('Blocked')).toBeNull();
    });

    expect(picker.props.allowCreate).toBe(false);
    expect(createBulkOrganizeProjectMock).not.toHaveBeenCalled();
  });
});
