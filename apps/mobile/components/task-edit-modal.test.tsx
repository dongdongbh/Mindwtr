import React from 'react';
import { Alert } from 'react-native';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { TaskEditModal } from './task-edit-modal';
import { syncTaskEditPagerPosition } from './task-edit/task-edit-modal.utils';

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const storeState = {
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    settings: { features: {}, ai: {}, gtd: { taskEditor: { order: [], hidden: [] } } },
    duplicateTask: vi.fn(),
    resetTaskChecklist: vi.fn(),
    addProject: vi.fn(),
    addSection: vi.fn(),
    addArea: vi.fn(),
    deleteTask: vi.fn(),
  };
  const useTaskStore = Object.assign(() => storeState, {
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
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
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
  }),
}));

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
  TaskEditFormTab: (props: any) => React.createElement('TaskEditFormTab', props),
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
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
    vi.mocked(syncTaskEditPagerPosition).mockClear();
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

  it('can save from the discard confirmation', () => {
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

    act(() => {
      buttons[2]?.onPress?.();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Changed task' }));
    expect(onClose).toHaveBeenCalledTimes(1);
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
});
