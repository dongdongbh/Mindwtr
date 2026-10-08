import React from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureDateFormatting, type Area, type Project } from '@mindwtr/core';
import { resetForTests, setStorageAdapter, useTaskStore } from '../../../../packages/core/src/store';

import { TaskListBulkOrganizeModal } from './TaskListBulkOrganizeModal';
import { TaskEditProjectPicker } from '../task-edit/TaskEditProjectPicker';

// The lightweight Vitest React Native shim only implements StyleSheet.create.
// Supply the real API shape locally so touch-target assertions flatten arrays
// the same way React Native does without widening the global test shim.
if (typeof StyleSheet.flatten !== 'function') {
  const flattenStyle = (style: unknown): Record<string, unknown> => {
    if (!Array.isArray(style)) return (style ?? {}) as Record<string, unknown>;
    return style.reduce<Record<string, unknown>>(
      (flattened, item) => ({ ...flattened, ...flattenStyle(item) }),
      {},
    );
  };
  Object.assign(StyleSheet, {
    flatten: flattenStyle,
  });
}

vi.mock('@react-native-community/datetimepicker', () => ({
  default: (props: Record<string, unknown>) => React.createElement('DateTimePicker', props),
}));

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
    Calendar: Icon,
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

const localizedT = (key: string) => ({
  'process.delegateWhoLabel': 'En attente de',
  'process.followUpLabel': 'Relance',
  'status.waiting': 'En attente',
  'taskEdit.contextsLabel': 'Contextes',
  'taskEdit.dueDateLabel': 'Échéance',
  'taskEdit.reviewDateLabel': 'Révision',
  'taskEdit.startDateLabel': 'Début',
  'taskEdit.tagsLabel': 'Étiquettes',
}[key] ?? t(key));

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
  configureDateFormatting({ language: 'en', dateFormat: 'mdy', systemLocale: 'en-US' });
  createBulkOrganizeProjectMock.mockReset();
  createBulkOrganizeAreaMock.mockReset();
  ensureDestinationSavedMock.mockReset().mockResolvedValue(undefined);
});

const originalOS = Platform.OS;
afterEach(() => {
  Platform.OS = originalOS;
  vi.useRealTimers();
});

describe('TaskListBulkOrganizeModal', () => {
  it('stages Today/Tomorrow as local date-only values and leaves untouched dates unchanged', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 30, 23, 30));
    const onApply = vi.fn();
    const tree = renderModal({ onApply });
    act(() => { tree.root.findByProps({ accessibilityLabel: 'Start: Today' }).props.onPress(); });
    act(() => { tree.root.findByProps({ accessibilityLabel: 'Due: Tomorrow' }).props.onPress(); });
    expect(onApply).not.toHaveBeenCalled();
    act(() => { buttonWithText(tree, 'Apply to selected').props.onPress(); });
    expect(onApply).toHaveBeenCalledWith({ contexts: [], tags: [], startTime: '2026-09-30', dueDate: '2026-10-01' });
    act(() => { tree.root.findByProps({ accessibilityLabel: 'Due: Tomorrow' }).props.onPress(); });
    act(() => { buttonWithText(tree, 'Apply to selected').props.onPress(); });
    expect(onApply.mock.lastCall?.[0]).not.toHaveProperty('dueDate');
  });

  it.each(['android', 'ios'] as const)('selects and dismisses the native date picker on %s without applying tasks', (os) => {
    Platform.OS = os;
    const onApply = vi.fn();
    const tree = renderModal({ onApply });
    act(() => { tree.root.findByProps({ accessibilityLabel: 'Due: Calendar' }).props.onPress(); });
    let picker = tree.root.findByType('DateTimePicker' as any);
    expect(picker.props.mode).toBe('date');
    expect(picker.props.display).toBe(os === 'ios' ? 'inline' : 'default');
    act(() => { picker.props.onChange({ type: 'set' }, new Date(2026, 9, 5, 23, 30)); });
    expect(onApply).not.toHaveBeenCalled();
    const dueInput = tree.root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Due');
    expect(dueInput?.props.value).toBe('10/05/2026');
    if (os === 'ios') {
      act(() => { tree.root.findByProps({ accessibilityLabel: 'Due: Done' }).props.onPress(); });
    }
    expect(tree.root.findAllByType('DateTimePicker' as any)).toHaveLength(0);
    act(() => { tree.root.findByProps({ accessibilityLabel: 'Due: Calendar' }).props.onPress(); });
    picker = tree.root.findByType('DateTimePicker' as any);
    act(() => { picker.props.onChange({ type: 'dismissed' }); });
    expect(dueInput?.props.value).toBe('10/05/2026');
    act(() => { buttonWithText(tree, 'Apply to selected').props.onPress(); });
    expect(onApply).toHaveBeenCalledWith({ contexts: [], tags: [], dueDate: '2026-10-05' });
  });

  it('disables date entry and shortcuts while applying', () => {
    const tree = renderModal({ isApplying: true });
    expect(tree.root.findByProps({ accessibilityLabel: 'Due: Calendar' }).props.disabled).toBe(true);
    expect(tree.root.findByProps({ accessibilityLabel: 'Due: Today' }).props.disabled).toBe(true);
    expect(tree.root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Due')?.props.editable).toBe(false);
  });

  it('keeps bulk date shortcuts and calendar controls at least 44 points tall', () => {
    const tree = renderModal();
    const calendar = tree.root.findByProps({ accessibilityLabel: 'Due: Calendar' });
    const today = tree.root.findByProps({ accessibilityLabel: 'Due: Today' });

    expect(StyleSheet.flatten(calendar.props.style).minHeight).toBeGreaterThanOrEqual(44);
    expect(StyleSheet.flatten(today.props.style).minHeight).toBeGreaterThanOrEqual(44);
  });

  it('names the three date inputs distinctly, including after a date is filled', () => {
    const tree = renderModal();
    const dateInputs = () => tree.root.findAllByType(TextInput)
      .filter((node) => node.props.placeholder === 'YYYY-MM-DD');

    expect(dateInputs().map((node) => node.props.accessibilityLabel)).toEqual(['Start', 'Due', 'Review']);
    act(() => { dateInputs()[0].props.onFocus(); });
    act(() => { dateInputs()[0].props.onChangeText('2026-09-15'); });
    expect(dateInputs()[0].props).toMatchObject({ value: '2026-09-15', accessibilityLabel: 'Start' });
    act(() => { dateInputs()[0].props.onBlur(); });
    expect(dateInputs()[0].props.value).toBe('09/15/2026');
  });

  it('displays the configured day-first format while keeping an ISO date for Apply', () => {
    configureDateFormatting({ language: 'en', dateFormat: 'dmy', systemLocale: 'en-GB' });
    const onApply = vi.fn();
    const tree = renderModal({ onApply });
    act(() => { tree.root.findByProps({ accessibilityLabel: 'Due: Calendar' }).props.onPress(); });
    act(() => { tree.root.findByType('DateTimePicker' as any).props.onChange({ type: 'set' }, new Date(2026, 9, 5)); });
    const dueInput = () => tree.root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Due');
    expect(dueInput()?.props.value).toBe('05/10/2026');
    act(() => { dueInput()?.props.onFocus(); });
    expect(dueInput()?.props.value).toBe('2026-10-05');
    act(() => { dueInput()?.props.onBlur(); });
    act(() => { buttonWithText(tree, 'Apply to selected').props.onPress(); });
    expect(onApply.mock.lastCall?.[0].dueDate).toBe('2026-10-05');
  });

  it('uses localized Follow-up and form captions as input names when Waiting is selected', () => {
    const tree = renderModal({ t: localizedT });
    const dateNames = () => tree.root.findAllByType(TextInput)
      .filter((node) => node.props.placeholder === 'YYYY-MM-DD')
      .map((node) => node.props.accessibilityLabel);

    expect(dateNames()).toEqual(['Début', 'Échéance', 'Révision']);
    act(() => { buttonWithText(tree, 'En attente').props.onPress(); });
    expect(dateNames()).toEqual(['Début', 'Échéance', 'Relance']);
    const captionedInputs = () => tree.root.findAllByType(TextInput)
      .filter((node) => ['Person or team', '@computer, @office', '#project, #admin'].includes(node.props.placeholder));
    expect(captionedInputs().map((node) => node.props.accessibilityLabel))
      .toEqual(['En attente de', 'Contextes', 'Étiquettes']);
    act(() => { captionedInputs()[0].props.onChangeText('Camille'); });
    expect(captionedInputs()[0].props).toMatchObject({ value: 'Camille', accessibilityLabel: 'En attente de' });
  });

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
