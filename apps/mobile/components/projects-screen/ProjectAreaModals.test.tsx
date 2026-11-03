import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Area, Project } from '@mindwtr/core';

import { ProjectAreaModals } from './ProjectAreaModals';

const live = vi.hoisted(() => ({ areas: [] as Area[], projects: [] as Project[] }));
const diagnostics = vi.hoisted(() => ({ logInfo: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/app-log', () => ({ logInfo: diagnostics.logInfo }));
vi.mock('@mindwtr/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@mindwtr/core')>(),
  useTaskStore: { getState: () => ({ areas: live.areas, projects: live.projects, _allProjects: live.projects }) },
  flushPendingSave: diagnostics.flush,
}));
vi.mock('../../lib/use-android-keyboard-inset', () => ({ useAndroidKeyboardInset: () => 0 }));

const now = '2026-09-22T00:00:00.000Z';
const areas: Area[] = ['a', 'b', 'c'].map((id, order) => ({
  id, name: id, order, createdAt: now, updatedAt: now,
}));

beforeEach(() => {
  live.areas = areas;
  live.projects = [];
  vi.clearAllMocks();
  diagnostics.flush.mockResolvedValue(undefined);
});

const renderManager = (reorderAreas = vi.fn(), addArea = vi.fn(), newAreaName = 'New area', onSetNewAreaName = vi.fn(), overrides: Partial<React.ComponentProps<typeof ProjectAreaModals>> = {}) => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ProjectAreaModals
      addArea={addArea}
      areaListMaxHeight={200}
      areaManagerListMaxHeight={200}
      areaUsage={new Map()}
      colors={['#3b82f6']}
      expandedAreaColorId={null}
      newAreaColor="#3b82f6"
      newAreaName={newAreaName}
      onCloseAreaManager={vi.fn()}
      onDeleteArea={vi.fn()}
      onSetExpandedAreaColorId={vi.fn()}
      onSetNewAreaColor={vi.fn()}
      onSetNewAreaName={onSetNewAreaName}
      onSetSelectedProject={vi.fn()}
      onSetShowAreaManager={vi.fn()}
      onSetShowAreaPicker={vi.fn()}
      onShowToast={vi.fn()}
      overlayModalPresentation="overFullScreen"
      pickerCardMaxHeight={400}
      reorderAreas={reorderAreas}
      selectedProject={null}
      showAreaManager
      showAreaPicker={false}
      sortedAreas={areas}
      sortAreasByColor={vi.fn()}
      sortAreasByName={vi.fn()}
      t={(key) => key}
      tc={{ border: '#aaa', cardBg: '#fff', inputBg: '#fff', secondaryText: '#777', text: '#000', tint: '#00f' }}
      updateArea={vi.fn()}
      updateProject={vi.fn()}
      {...overrides}
    />);
  });
  return tree;
};

it('moves an area using displayed order even when the raw live array has a different order', async () => {
  const reorderAreas = vi.fn();
  const tree = renderManager(reorderAreas);
  live.areas = [areas[2], areas[0], areas[1]];
  expect(tree.root.findByProps({ accessibilityLabel: 'projects.moveUp: a' }).props.disabled).toBe(true);
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'projects.moveUp: c' }).props.onPress());
  expect(reorderAreas).toHaveBeenCalledWith(['a', 'c', 'b']);
});

it('allows area creation from the Projects list without an open project', async () => {
  const addArea = vi.fn();
  const tree = renderManager(vi.fn(), addArea);
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'common.save' }).props.onPress());
  expect(addArea).toHaveBeenCalledWith('New area', { color: '#3b82f6' });
});

it('refuses a new area named like an existing one: Save is off, the line says why, the typed name stays', () => {
  const addArea = vi.fn();
  const onSetNewAreaName = vi.fn();
  const tree = renderManager(vi.fn(), addArea, ' B ', onSetNewAreaName);
  const save = tree.root.findByProps({ accessibilityLabel: 'common.save' });
  expect(save.props.disabled).toBe(true);
  expect(tree.root.findAll((node) => (node.type as unknown) === 'Text' && node.props.children === 'An area with this name already exists.')).toHaveLength(1);
  act(() => save.props.onPress());
  expect(addArea).not.toHaveBeenCalled();
  expect(onSetNewAreaName).not.toHaveBeenCalled();
});


it('opens the selected area editor, validates blank/duplicate names, and saves only its name', async () => {
  const updateArea = vi.fn().mockResolvedValue({ success: true });
  const tree = renderManager(vi.fn(), vi.fn(), '', vi.fn(), { managerAreaId: 'b', updateArea });
  expect(tree.root.findByProps({ accessibilityLabel: 'projects.renameArea' }).props.value).toBe('b');
  expect(tree.root.findAllByProps({ accessibilityLabel: 'projects.renameArea: a' })).toHaveLength(0);
  const input = tree.root.findByProps({ accessibilityLabel: 'projects.renameArea' });
  for (const name of [' ', ' A ']) {
    act(() => input.props.onChangeText(name));
    const save = tree.root.findByProps({ testID: 'area-rename-save' });
    expect(save.props.disabled).toBe(true);
    await act(async () => save.props.onPress());
    expect(updateArea).not.toHaveBeenCalled();
  }
  act(() => input.props.onChangeText(' Personal '));
  await act(async () => tree.root.findByProps({ testID: 'area-rename-save' }).props.onPress());
  expect(updateArea).toHaveBeenCalledWith('b', { name: 'Personal' });
  expect(diagnostics.flush).toHaveBeenCalled();
  expect(diagnostics.logInfo).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    force: true, extra: { releaseCheck: 'v1.3.8/projects-management-shortcuts', outcome: 'renamed' },
  }));
});

it.each(['deleted', 'duplicate', 'rejected', 'save-failed'])('keeps rename open and never logs success when %s', async (failure) => {
  const updateArea = vi.fn().mockResolvedValue(failure === 'rejected' ? { success: false } : { success: true });
  const onShowToast = vi.fn();
  const tree = renderManager(vi.fn(), vi.fn(), '', vi.fn(), { managerAreaId: 'b', updateArea, onShowToast });
  act(() => tree.root.findByProps({ accessibilityLabel: 'projects.renameArea' }).props.onChangeText('Personal'));
  if (failure === 'deleted') live.areas = areas.filter((area) => area.id !== 'b');
  if (failure === 'duplicate') live.areas = [...areas, { ...areas[0], id: 'new', name: 'Personal' }];
  if (failure === 'save-failed') diagnostics.flush.mockRejectedValueOnce(new Error('disk full'));
  await act(async () => tree.root.findByProps({ testID: 'area-rename-save' }).props.onPress());
  expect(tree.root.findByProps({ accessibilityLabel: 'projects.renameArea' }).props.value).toBe('Personal');
  expect(onShowToast).toHaveBeenCalled();
  expect(diagnostics.logInfo).not.toHaveBeenCalled();
  if (failure === 'deleted' || failure === 'duplicate') expect(updateArea).not.toHaveBeenCalled();
});

it('moves the selected top area down using the existing reorder action and latest list', async () => {
  const reorderAreas = vi.fn();
  const tree = renderManager(reorderAreas, vi.fn(), '', vi.fn(), { managerAreaId: 'a' });
  live.areas = [{ ...areas[1], order: 2 }, { ...areas[0], order: 0 }, { ...areas[2], order: 1 }];
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'projects.moveDown: a' }).props.onPress());
  expect(reorderAreas).toHaveBeenCalledWith(['c', 'a', 'b']);
});

it('does not delete an area that gained a live project while the manager was open', async () => {
  const onDeleteArea = vi.fn();
  const onShowToast = vi.fn();
  const tree = renderManager(vi.fn(), vi.fn(), '', vi.fn(), { managerAreaId: 'b', onDeleteArea, onShowToast });
  live.projects = [{ id: 'p', areaId: 'b', status: 'active' } as Project];
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'common.delete: b' }).props.onPress());
  expect(onDeleteArea).not.toHaveBeenCalled();
  expect(onShowToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' }));
});

const pickerProject: Project = { id: 'p', title: 'Project', status: 'active', color: '#3b82f6', order: 0, tagIds: [], createdAt: now, updatedAt: now };
const pickArea = (tree: ReturnType<typeof create>) => tree.root.findByProps({ testID: 'project-area-picker-b' });

it.each(['archived', 'deleted', 'destination-deleted'])('rejects a direct move after its %s target changes', async (failure) => {
  live.projects = [pickerProject];
  const updateProject = vi.fn();
  const tree = renderManager(vi.fn(), vi.fn(), '', vi.fn(), { selectedProject: pickerProject, showAreaManager: false, showAreaPicker: true, updateProject });
  if (failure === 'archived') live.projects = [{ ...pickerProject, status: 'archived' }];
  if (failure === 'deleted') live.projects = [];
  if (failure === 'destination-deleted') live.areas = areas.filter((area) => area.id !== 'b');
  await act(async () => pickArea(tree).props.onPress());
  expect(updateProject).not.toHaveBeenCalled();
  expect(diagnostics.logInfo).not.toHaveBeenCalled();
});

it('acknowledges a direct move only after the write and persistence, with duplicate submits blocked', async () => {
  live.projects = [pickerProject];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const updateProject = vi.fn().mockReturnValue(pending);
  const onSetSelectedProject = vi.fn();
  const onSetShowAreaPicker = vi.fn();
  const tree = renderManager(vi.fn(), vi.fn(), '', vi.fn(), { selectedProject: pickerProject, showAreaManager: false, showAreaPicker: true, updateProject, onSetSelectedProject, onSetShowAreaPicker });
  act(() => { pickArea(tree).props.onPress(); pickArea(tree).props.onPress(); });
  expect(updateProject).toHaveBeenCalledTimes(1);
  expect(updateProject).toHaveBeenCalledWith('p', { areaId: 'b' });
  expect(onSetSelectedProject).not.toHaveBeenCalled();
  expect(onSetShowAreaPicker).not.toHaveBeenCalled();
  expect(diagnostics.logInfo).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(onSetSelectedProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p', areaId: 'b' }));
  expect(onSetShowAreaPicker).toHaveBeenCalledWith(false);
  expect(diagnostics.logInfo).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ extra: { releaseCheck: 'v1.3.8/projects-management-shortcuts', outcome: 'moved' } }));
});


it.each([
  { direction: 'moveUp', expected: ['c', 'a', 'b'] },
  { direction: 'moveDown', expected: ['a', 'b', 'c'] },
])('moves the visible middle area $direction after stored order changes without raw-array changes', async ({ direction, expected }) => {
  const reorderAreas = vi.fn();
  const [a, b, c] = [areas[0], { ...areas[1], order: 2 }, { ...areas[2], order: 1 }];
  live.areas = [a, b, c];
  const tree = renderManager(reorderAreas, vi.fn(), '', vi.fn(), { managerAreaId: 'c', sortedAreas: [a, c, b] });
  const move = tree.root.findByProps({ accessibilityLabel: `projects.${direction}: c` });
  expect(move.props.disabled).toBe(false);
  await act(async () => move.props.onPress());
  expect(reorderAreas).toHaveBeenCalledWith(expected);
});
