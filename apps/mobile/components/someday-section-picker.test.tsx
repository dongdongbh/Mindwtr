import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Modal: ({ visible, children, ...props }: any) => visible ? React.createElement('Modal', props, children) : null,
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
  TextInput: (props: any) => React.createElement('TextInput', props),
  TouchableOpacity: ({ children, ...props }: any) => React.createElement('TouchableOpacity', props, children),
  View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

vi.mock('@/lib/use-android-keyboard-inset', () => ({ useAndroidKeyboardInset: () => 0 }));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn() }));

import { SomedaySectionPicker } from './someday-section-picker';

const tc = {
  bg: '#fff', border: '#ddd', cardBg: '#fff', danger: '#c00', filterBg: '#eee',
  onTint: '#fff', secondaryText: '#666', text: '#111', tint: '#06c',
} as any;
const t = (key: string) => key;

describe('SomedaySectionPicker', () => {
  it('includes sorted empty definitions, No section and New section', () => {
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(<SomedaySectionPicker
      sections={[
        { id: 'later', title: 'Later', order: 2 },
        { id: 'books', title: 'Books', order: 0 },
      ]}
      onCreate={vi.fn()}
      onSelect={vi.fn()}
      t={t}
      themeColors={tc}
    />); });
    const labels = tree!.root.findAllByType('TouchableOpacity' as never)
      .map((node) => node.props.accessibilityLabel);
    expect(labels).toEqual(['No section', 'Books', 'Later', '+ New section…']);
    act(() => tree!.unmount());
  });

  it('does not claim No section is selected for a mixed bulk selection', () => {
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(<SomedaySectionPicker
      sections={[{ id: 'books', title: 'Books', order: 0 }]}
      selectionMixed
      onCreate={vi.fn()}
      onSelect={vi.fn()}
      t={t}
      themeColors={tc}
    />); });
    const options = tree!.root.findAllByType('TouchableOpacity' as never)
      .filter((node) => node.props.accessibilityState);
    expect(options.every((node) => node.props.accessibilityState.selected === false)).toBe(true);
    act(() => tree!.unmount());
  });

  it('opens creation directly and keeps its title on a failed save for retry', async () => {
    const onCreate = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce('books');
    const onSelect = vi.fn();
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<SomedaySectionPicker
      createOnly
      sections={[]}
      onCreate={onCreate}
      onSelect={onSelect}
      t={t}
      themeColors={tc}
    />); });
    const input = tree!.root.findByType('TextInput' as never);
    await act(async () => { input.props.onChangeText('Books to read'); });
    const save = () => tree!.root.findAllByType('TouchableOpacity' as never)
      .find((node) => node.props.accessibilityLabel === 'common.save')!;
    await act(async () => { save().props.onPress(); });
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(tree!.root.findByType('TextInput' as never).props.value).toBe('Books to read');
    expect(tree!.root.findAllByProps({ accessibilityRole: 'alert' }).length).toBeGreaterThan(0);
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => { save().props.onPress(); });
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith('books'));
    act(() => tree!.unmount());
  });

  it('draws the new section Save button in the theme colors', () => {
    const flatten = (style: unknown): Record<string, unknown> => (
      Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : (style && typeof style === 'object' ? style as Record<string, unknown> : {})
    );
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(<SomedaySectionPicker
      createOnly
      sections={[]}
      onCreate={vi.fn()}
      onSelect={vi.fn()}
      t={t}
      themeColors={tc}
    />); });
    const save = tree!.root.findAllByType('TouchableOpacity' as never)
      .find((node) => node.props.accessibilityLabel === 'common.save')!;
    expect(flatten(save.props.style)).toMatchObject({ backgroundColor: tc.tint, borderColor: tc.tint });
    expect(flatten(save.findByType('Text' as never).props.style)).toMatchObject({ color: tc.onTint });
    act(() => tree!.unmount());
  });
});
