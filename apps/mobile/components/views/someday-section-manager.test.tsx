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

const renderManager = (onChange = vi.fn()) => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <SomedaySectionManager
        definitions={[{ id: 'books', title: 'Books to read', order: 0 }]}
        onChange={onChange}
        t={t}
        themeColors={{} as never}
      />,
    );
  });
  return { onChange, tree };
};

describe('SomedaySectionManager', () => {
  it('deletes only the catalogue entry supplied to its settings callback', () => {
    const { onChange, tree } = renderManager();

    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Delete: Books to read' }).props.onPress();
    });

    expect(onChange).toHaveBeenCalledWith([]);
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

    expect(onChange).toHaveBeenCalledWith([{ id: 'books', title: 'Reading list', order: 0 }]);
  });

  it('creates a new ordered heading', () => {
    const { onChange, tree } = renderManager();
    const input = tree.root.findAllByType('TextInput' as never)
      .find((node) => node.props.value === '');
    expect(input).toBeDefined();
    act(() => {
      input?.props.onChangeText('Career ideas');
    });
    act(() => {
      tree.root.findAllByType('TextInput' as never)
        .find((node) => node.props.value === 'Career ideas')?.props.onSubmitEditing();
    });

    expect(onChange).toHaveBeenCalledWith([
      { id: 'books', title: 'Books to read', order: 0 },
      expect.objectContaining({ title: 'Career ideas', order: 1 }),
    ]);
  });
});
