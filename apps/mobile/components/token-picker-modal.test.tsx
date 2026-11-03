import React from 'react';
import { Keyboard, Platform, Pressable } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TokenPickerModal } from './token-picker-modal';

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('../hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#000',
    cardBg: '#111',
    inputBg: '#222',
    border: '#333',
    text: '#fff',
    secondaryText: '#aaa',
    tint: '#4af',
    onTint: '#000',
    filterBg: '#444',
  }),
}));

const originalPlatformOs = Platform.OS;

const setPlatform = (os: typeof Platform.OS) => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
};

const flattenStyle = (style: unknown): Record<string, any> => {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, any>>((acc, item) => Object.assign(acc, flattenStyle(item)), {});
  }
  return style && typeof style === 'object' ? (style as Record<string, any>) : {};
};

afterEach(() => {
  setPlatform(originalPlatformOs);
  vi.restoreAllMocks();
});

describe('TokenPickerModal', () => {
  it('lifts the centered card above the Android keyboard by the measured inset', () => {
    setPlatform('android');
    const listeners = new Map<string, (event?: any) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation((event: string, cb: any) => {
      listeners.set(event, cb);
      return { remove: vi.fn() } as any;
    });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <TokenPickerModal
          visible
          title="Pick"
          tokens={['@home', '@work']}
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });


    const overlay = tree.root.findAllByType(Pressable)[0];
    expect(flattenStyle(overlay.props.style).paddingBottom).toBeUndefined();

    act(() => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 300 } });
    });
    expect(flattenStyle(tree.root.findAllByType(Pressable)[0].props.style).paddingBottom).toBe(300);

    act(() => {
      listeners.get('keyboardDidHide')?.();
    });
    expect(flattenStyle(tree.root.findAllByType(Pressable)[0].props.style).paddingBottom).toBeUndefined();
  });

  it('reports the chosen chip as selected in single-select mode', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <TokenPickerModal visible title="Add tag" tokens={['#home', '#work']} onConfirm={vi.fn()} onClose={vi.fn()} />,
      );
    });
    const chip = (token: string) => tree.root.findAll((node) => (
      typeof node.type === 'string' && node.props.accessibilityRole === 'button' && node.findAllByProps({ children: token }).length > 0
    ))[0];
    expect(chip('#home').props.accessibilityState).toEqual({ selected: false });
    expect(chip('#work').props.accessibilityState).toEqual({ selected: false });


    act(() => {
      chip('#home').props.onPress();
    });

    expect(chip('#home').props.accessibilityState).toEqual({ selected: true });
  });
});
