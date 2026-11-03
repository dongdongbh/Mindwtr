import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import renderer from 'react-test-renderer';
import { ThemedText } from './themed-text';
import { M3Typography } from '../constants/material3/m3-typography';


const tokenState = vi.hoisted(() => ({ isMaterial: false }));

vi.mock('@/hooks/use-theme-color', () => ({ useThemeColor: () => '#ff0000' }));
vi.mock('@/hooks/use-theme-tokens', async () => {
  const typo = await vi.importActual<typeof import('../constants/material3/m3-typography')>(
    '../constants/material3/m3-typography',
  );
  return { useThemeTokens: () => ({ isMaterial: tokenState.isMaterial, type: typo.M3Typography }) };
});

const flattenStyle = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
};

const styleForText = (tree: renderer.ReactTestRenderer, text: string) => {
  const matches = tree.root.findAll((node) => node.props?.children === text && node.props?.style);
  return flattenStyle(matches[matches.length - 1]?.props.style);
};

describe('ThemedText', () => {
  it('renders with themed color and the legacy type style', () => {
    tokenState.isMaterial = false;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ThemedText type="title">Hello</ThemedText>);
    });
    const flat = styleForText(tree, 'Hello');
    expect(flat.color).toBe('#ff0000');
    expect(flat.fontSize).toBe(32);
  });

  it('applies the M3 type style when Material and the m3 prop is set', () => {
    tokenState.isMaterial = true;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ThemedText m3="titleLarge">Hi</ThemedText>);
    });
    expect(styleForText(tree, 'Hi')).toMatchObject(M3Typography.titleLarge);
  });

  it('ignores the m3 prop under non-Material themes', () => {
    tokenState.isMaterial = false;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ThemedText m3="titleLarge" type="title">Hi</ThemedText>);
    });

    expect(styleForText(tree, 'Hi').fontSize).toBe(32);
  });
});
