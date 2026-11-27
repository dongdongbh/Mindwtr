import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Animated, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { TaskEditTabs } from './TaskEditTabs';

vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('../../hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    border: '#ddd',
    cardBg: '#fff',
    filterBg: '#eee',
    onTint: '#fff',
    text: '#111',
    tint: '#00f',
  }),
}));

const EDITOR_WIDTH = 393;
const TRACK_WIDTH = EDITOR_WIDTH - 32;
const HALF_TRACK = (TRACK_WIDTH - 2) / 2;

type Interpolation = { inputRange: number[]; outputRange: number[] };
const scrollX = { interpolate: (config: Interpolation) => config } as unknown as Animated.Value;
const flatten = (style: unknown): Record<string, unknown> => (
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : (style ?? {}) as Record<string, unknown>
);
const isIndicator = (node: renderer.ReactTestInstance) => node.props.pointerEvents === 'none' && node.props.style !== undefined;

function renderTabs() {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <TaskEditTabs editTab="task" onTabPress={vi.fn()} scrollX={scrollX} containerWidth={EDITOR_WIDTH} />,
    );
  });
  return tree;
}

describe('TaskEditTabs', () => {
  it('covers exactly one half of the track inside its border in both tabs', () => {
    const tree = renderTabs();
    const track = tree.root.find((node) => node.type === View && node.props.accessibilityRole === 'tablist');
    act(() => {
      track.props.onLayout({ nativeEvent: { layout: { x: 16, y: 10, width: TRACK_WIDTH, height: 42 } } });
    });
    const style = flatten(tree.root.find(isIndicator).props.style) as { width: number; transform: { translateX: Interpolation }[] };
    expect(style.width).toBe(HALF_TRACK);
    expect(style.transform[0].translateX).toEqual({ inputRange: [0, EDITOR_WIDTH], outputRange: [0, HALF_TRACK], extrapolate: 'clamp' });
  });

  it('hides the indicator until the track has been measured', () => {
    expect(renderTabs().root.findAll(isIndicator)).toHaveLength(0);
  });
});
