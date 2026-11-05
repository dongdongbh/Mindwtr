import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { SettingRow, SettingToggleRow } from './setting-row';
import { styles } from './settings.styles';

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    tint: '#3b82f6',
  }),
}));

const flattenStyle = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
};

const collectText = (node: renderer.ReactTestInstance): string[] =>
  node
    .findAllByType(Text)
    .map((t) => t.props.children)
    .filter((child): child is string => typeof child === 'string');

describe('SettingRow', () => {
  it('renders label and description, and passes children as the trailing control', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SettingRow label="Notifications" description="Enable reminders">
          <Text>control</Text>
        </SettingRow>,
      );
    });
    expect(collectText(tree.root)).toEqual(['Notifications', 'Enable reminders', 'control']);

    const json = tree.toJSON() as renderer.ReactTestRendererJSON;
    expect(flattenStyle((json.children![0] as renderer.ReactTestRendererJSON).props.style)).toMatchObject(
      flattenStyle(styles.settingInfo),
    );
  });

  it('omits the description text node when no description is given', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingRow label="Only label" />);
    });
    expect(collectText(tree.root)).toEqual(['Only label']);
  });

  it('renders a plain View by default and a TouchableOpacity when onPress is set', () => {
    let staticTree!: renderer.ReactTestRenderer;
    act(() => {
      staticTree = renderer.create(<SettingRow label="Static" />);
    });
    expect(staticTree.root.findAllByType(TouchableOpacity)).toHaveLength(0);
    expect(staticTree.root.findAllByType(View).length).toBeGreaterThan(0);

    const onPress = vi.fn();
    let pressableTree!: renderer.ReactTestRenderer;
    act(() => {
      pressableTree = renderer.create(<SettingRow label="Pressable" onPress={onPress} />);
    });
    const touchable = pressableTree.root.findByType(TouchableOpacity);
    act(() => {
      touchable.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('applies the top divider only when divider is set', () => {
    let withDivider!: renderer.ReactTestRenderer;
    let withoutDivider!: renderer.ReactTestRenderer;
    act(() => {
      withDivider = renderer.create(<SettingRow label="A" divider />);
    });
    act(() => {
      withoutDivider = renderer.create(<SettingRow label="B" />);
    });
    const dividerRow = withDivider.toJSON() as renderer.ReactTestRendererJSON;
    expect(flattenStyle(dividerRow.props.style)).toMatchObject({ borderTopWidth: 1 });
    const plainRow = withoutDivider.toJSON() as renderer.ReactTestRendererJSON;
    expect(flattenStyle(plainRow.props.style).borderTopWidth).toBeUndefined();
  });

  it('dims label and description when dimmed is set', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SettingRow label="Dimmed" description="secondary" dimmed />);
    });
    for (const text of tree.root.findAllByType(Text)) {
      expect(flattenStyle(text.props.style)).toMatchObject({ opacity: 0.5 });
    }
  });
});

describe('SettingToggleRow', () => {
  it('renders a Switch wired to value/onChange', () => {
    const onChange = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SettingToggleRow label="Toggle" description="desc" value onChange={onChange} />,
      );
    });
    const toggle = tree.root.findByType(Switch);
    expect(toggle.props.value).toBe(true);
    act(() => {
      toggle.props.onValueChange(false);
    });
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('defaults the track color and forwards an override', () => {
    let defaultTree!: renderer.ReactTestRenderer;
    act(() => {
      defaultTree = renderer.create(<SettingToggleRow label="A" value={false} onChange={() => {}} />);
    });
    expect(defaultTree.root.findByType(Switch).props.trackColor).toEqual({
      false: '#767577',
      true: '#3B82F6',
    });

    const custom = { false: 'rgb(1,1,1)', true: 'rgb(2,2,2)' };
    let overrideTree!: renderer.ReactTestRenderer;
    act(() => {
      overrideTree = renderer.create(
        <SettingToggleRow label="B" value={false} onChange={() => {}} trackColor={custom} />,
      );
    });
    expect(overrideTree.root.findByType(Switch).props.trackColor).toEqual(custom);
  });
});
