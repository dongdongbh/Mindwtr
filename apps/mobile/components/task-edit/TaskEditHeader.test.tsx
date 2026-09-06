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

describe('TaskEditHeader', () => {
  it('uses labelled icon buttons for Save and Close', () => {
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

    expect(saveButton.findAllByType(Text)).toHaveLength(0);
    act(() => saveButton.props.onPress());
    act(() => closeButton.props.onPress());

    expect(onDone).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
