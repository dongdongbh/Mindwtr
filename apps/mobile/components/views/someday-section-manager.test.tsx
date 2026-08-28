import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SomedaySectionManager } from './someday-section-manager';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
  TextInput: (props: any) => React.createElement('TextInput', props),
  TouchableOpacity: ({ children, ...props }: any) => React.createElement('TouchableOpacity', props, children),
  View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

const t = (key: string) => ({
  'common.delete': 'Delete',
  'common.rename': 'Rename',
  'common.save': 'Save',
}[key] ?? key);

const definitions = [
  { id: 'books', title: 'Books to read', order: 0 },
  { id: 'career', title: 'Career ideas', order: 1 },
];

const renderManager = (onChange = vi.fn(), onDelete = vi.fn()) => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <SomedaySectionManager
        definitions={definitions}
        onChange={onChange}
        onDelete={onDelete}
        t={t}
        themeColors={{} as never}
      />,
    );
  });
  return { onChange, onDelete, tree };
};

describe('SomedaySectionManager', () => {
  it('requests deletion without mutating the catalogue before confirmation', () => {
    const { onChange, onDelete, tree } = renderManager();

    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Delete: Books to read' }).props.onPress();
    });

    expect(onDelete).toHaveBeenCalledWith('books');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renames an id-stable catalogue entry', () => {
    const { onChange, tree } = renderManager();
    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Rename section: Books to read' }).props.onPress();
    });
    const input = tree.root.findAllByType('TextInput' as never)
      .find((node) => node.props.value === 'Books to read');
    expect(input).toBeDefined();
    act(() => {
      input?.props.onChangeText('Reading list');
    });
    act(() => {
      tree.root.findAllByType('TextInput' as never)
        .find((node) => node.props.value === 'Reading list')?.props.onSubmitEditing();
    });

    expect(onChange).toHaveBeenCalledWith([
      { id: 'books', title: 'Reading list', order: 0 },
      { id: 'career', title: 'Career ideas', order: 1 },
    ]);
  });

  it('reorders headings without changing their ids or titles', () => {
    const { onChange, tree } = renderManager();
    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Move down: Books to read' }).props.onPress();
    });

    expect(onChange).toHaveBeenCalledWith([
      { id: 'career', title: 'Career ideas', order: 0 },
      { id: 'books', title: 'Books to read', order: 1 },
    ]);
  });
});
