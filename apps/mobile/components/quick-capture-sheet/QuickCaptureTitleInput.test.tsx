import React, { createRef } from 'react';
import { TextInput } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickCaptureTitleInput } from './QuickCaptureTitleInput';

afterEach(() => vi.unstubAllGlobals());

describe('capture title suggestions', () => {
  it('uses the actual caret to select a project ID and retains surrounding text', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
    const onChangeText = vi.fn();
    const onSelectProject = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<QuickCaptureTitleInput inputRef={createRef<TextInput>()}
        value="Before +東京 after" accessibilityLabel="Title" onChangeText={onChangeText} onSelectProject={onSelectProject}
        projects={[{ id: 'live', title: '東京 launch', status: 'active', order: 0, color: '#123456', tagIds: [], createdAt: '', updatedAt: '' }]}
        contexts={[]} tags={[]} tc={{ cardBg: '#fff', border: '#ccc', text: '#000' }} />);
    });
    const input = tree.root.findByType(TextInput);
    act(() => { input.props.onFocus({}); input.props.onSelectionChange({ nativeEvent: { selection: { start: 10, end: 10 } } }); });
    const option = tree.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityLabel === '東京 launch')[0];
    expect(option).toBeTruthy();
    act(() => option.props.onPress());
    expect(onSelectProject).toHaveBeenCalledExactlyOnceWith('live');
    expect(onChangeText).toHaveBeenCalledExactlyOnceWith('Before after');
  });
});
