import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { TaskEditHeader } from './TaskEditHeader';

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
