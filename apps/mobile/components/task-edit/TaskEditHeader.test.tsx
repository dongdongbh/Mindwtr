import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskEditHeader } from './TaskEditHeader';

const clipboard = vi.hoisted(() => ({ write: vi.fn(), toast: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard.write }));
vi.mock('../../contexts/toast-context', () => ({ useToast: () => ({ showToast: clipboard.toast }) }));

vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => ({
    'common.close': 'Close',
    'common.save': 'Save',
    'common.more': 'More',
    'task.createProjectFromTask': 'Create project',
    'task.cancel': 'Cancel task',
    'reference.convertToAction': 'Convert to action',
  }[key] ?? key) }),
}));

vi.mock('../../hooks/use-reduced-motion', () => ({
  useReducedMotion: () => false,
}));

vi.mock('../../hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    cardBg: '#fff',
    border: '#ddd',
    tint: '#00f',
    text: '#111',
    danger: '#f00',
  }),
}));

vi.mock('../../hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { medium: 10 } }),
}));

describe('TaskEditHeader', () => {
  beforeEach(() => { vi.clearAllMocks(); clipboard.write.mockResolvedValue(undefined); });
  it.each([
    ['Copy task link', 'mindwtr://open?task=task%20%2F%3F%26%23'],
    ['Copy task ID', 'task /?&#'],
  ])('copies %s and dismisses only More', async (label, expected) => {
    const onDone = vi.fn();
    const onClose = vi.fn();
    const onShare = vi.fn();
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<TaskEditHeader taskId="task /?&#" {...{
        onDone, onClose, onShare, onDuplicate, onDelete,
      }} />);
    });
    expect(tree.root.findAllByProps({ accessibilityLabel: label })).toHaveLength(0);
    act(() => tree.root.findByProps({ accessibilityLabel: 'More' }).props.onPress());
    await act(async () => tree.root.findByProps({ accessibilityLabel: label }).props.onPress());
    expect(clipboard.write).toHaveBeenCalledExactlyOnceWith(expected);
    expect(clipboard.toast).toHaveBeenCalledExactlyOnceWith({ message: 'Task copied to clipboard', tone: 'success' });
    expect(tree.root.findAllByProps({ accessibilityLabel: label })).toHaveLength(0);
    for (const callback of [onDone, onClose, onShare, onDuplicate, onDelete]) {
      expect(callback).not.toHaveBeenCalled();
    }
    act(() => tree.root.findByProps({ accessibilityLabel: 'More' }).props.onPress());
    act(() => tree.root.findByProps({ accessibilityLabel: 'common.share' }).props.onPress());
    expect(onShare).toHaveBeenCalledOnce();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('reports clipboard failure without success or editor callbacks', async () => {
    clipboard.write.mockRejectedValueOnce(new Error('Unavailable'));
    const onDone = vi.fn();
    const onClose = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<TaskEditHeader taskId="saved-task" onDone={onDone} onClose={onClose}
        onShare={vi.fn()} onDuplicate={vi.fn()} onDelete={vi.fn()} />);
    });
    act(() => tree.root.findByProps({ accessibilityLabel: 'More' }).props.onPress());
    await act(async () => tree.root.findByProps({ accessibilityLabel: 'Copy task link' }).props.onPress());
    expect(clipboard.toast).toHaveBeenCalledExactlyOnceWith({ message: 'Could not copy task', tone: 'error' });
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('offers only copy actions when existing task details are read-only', async () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<TaskEditHeader readOnly taskId="saved-task"
        onDone={vi.fn()} onClose={vi.fn()} onShare={vi.fn()} onDuplicate={vi.fn()}
        onDelete={vi.fn()} onPromoteToProject={vi.fn()} onCancelTask={vi.fn()}
        cancelTaskLabel="Cancel task" onSkipOccurrence={vi.fn()} showConvertToAction
        onConvertToAction={vi.fn()} showConvertToSection onConvertToSection={vi.fn()} />);
    });
    act(() => tree.root.findByProps({ accessibilityLabel: 'More' }).props.onPress());
    for (const label of ['common.share', 'taskEdit.duplicateTask', 'common.delete', 'Create project',
      'Cancel task', 'Skip this occurrence', 'Convert to action', 'task.convertToSection']) {
      expect(tree.root.findAllByProps({ accessibilityLabel: label })).toHaveLength(0);
    }
    expect(tree.root.findByProps({ accessibilityLabel: 'Copy task link' })).toBeTruthy();
    await act(async () => tree.root.findByProps({ accessibilityLabel: 'Copy task ID' }).props.onPress());
    expect(clipboard.write).toHaveBeenCalledExactlyOnceWith('saved-task');
    act(() => tree.unmount());
  });

  it.each([false, true])('hides references without a saved task ID (readOnly=%s)', (readOnly) => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<TaskEditHeader readOnly={readOnly} onDone={vi.fn()} onClose={vi.fn()}
        onShare={vi.fn()} onDuplicate={vi.fn()} onDelete={vi.fn()} />);
    });
    if (!readOnly) act(() => tree.root.findByProps({ accessibilityLabel: 'More' }).props.onPress());
    else expect(tree.root.findAllByProps({ accessibilityLabel: 'More' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Copy task link' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Copy task ID' })).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('keeps the Save text and routes the X icon to onClose', () => {
    const onDone = vi.fn();
    const onClose = vi.fn();
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditHeader
          onDone={onDone}
          onClose={onClose}
          onShare={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
    });

    const saveButton = tree.root.findByProps({ accessibilityLabel: 'Save' });
    const closeButton = tree.root.findByProps({ accessibilityLabel: 'Close' });

    // Save keeps its word: a first-time user must be able to tell which
    // control commits the draft. Close is the X icon on the left.
    expect(saveButton.findAllByType(Text).map((node) => node.props.children)).toEqual(['Save']);
    expect(closeButton.findAllByType(Text)).toHaveLength(0);
    act(() => saveButton.props.onPress());
    act(() => closeButton.props.onPress());

    expect(onDone).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('exposes task cancellation from the existing More menu', () => {
    const onCancelTask = vi.fn();
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditHeader
          onDone={vi.fn()}
          onClose={vi.fn()}
          onShare={vi.fn()}
          onDuplicate={vi.fn()}
          onCancelTask={onCancelTask}
          cancelTaskLabel="Cancel task"
          onDelete={vi.fn()}
        />,
      );
    });

    act(() => tree.root.findByProps({ accessibilityLabel: 'More' }).props.onPress());
    const cancelButton = tree.root.findByProps({ accessibilityLabel: 'Cancel task' });
    act(() => cancelButton.props.onPress());

    expect(onCancelTask).toHaveBeenCalledOnce();
  });

  it('offers a Reference-to-action conversion in the existing More menu', () => {
    const onConvertToAction = vi.fn();
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditHeader
          onDone={vi.fn()}
          onClose={vi.fn()}
          onShare={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
          onConvertToAction={onConvertToAction}
          showConvertToAction
        />,
      );
    });

    act(() => tree.root.findByProps({ accessibilityLabel: 'More' }).props.onPress());
    const convertButton = tree.root.findByProps({ accessibilityLabel: 'Convert to action' });
    act(() => convertButton.props.onPress());

    expect(onConvertToAction).toHaveBeenCalledOnce();
  });
});
