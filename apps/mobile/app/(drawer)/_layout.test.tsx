import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import AppLayout from './_layout';

const stackState = vi.hoisted(() => ({ screenOptions: undefined as any }));

vi.mock('expo-router', () => {
  const Stack = ({ screenOptions }: any) => {
    stackState.screenOptions = screenOptions;
    return null;
  };
  Stack.Screen = function Screen() {
    return null;
  };
  return { Stack };
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

vi.mock('@react-navigation/elements', () => ({
  getHeaderTitle: (options: { title?: string }, name: string) => options.title ?? name,
}));

vi.mock('react-native', () => ({
  Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
  View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ border: '#334155', cardBg: '#111827', text: '#f8fafc' }),
}));

vi.mock('@/hooks/use-widget-launch', () => ({
  WidgetLaunchContext: React.createContext({ pending: null, complete: () => {} }),
}));

vi.mock('@/modules/android-widget', () => ({ getWidgetLaunchState: () => null }));

vi.mock('@/components/mobile-area-switcher', () => ({
  MobileAreaSwitcher: () => React.createElement('MobileAreaSwitcher'),
}));

function renderHeader(routeName: string, headerRight?: () => React.ReactNode) {
  act(() => {
    create(<AppLayout />);
  });
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(stackState.screenOptions.header({
      back: undefined,
      navigation: { canGoBack: () => false, goBack: vi.fn() },
      options: { title: routeName, headerRight },
      route: { name: routeName },
    }));
  });
  return tree;
}

describe('drawer stack header', () => {
  it('shows the area filter on a screen whose list follows it (#1448)', () => {
    const tree = renderHeader('someday');
    expect(tree.root.findAllByType('MobileAreaSwitcher' as any)).toHaveLength(1);
  });

  it('keeps a screen overflow action next to the area filter', () => {
    const tree = renderHeader('done', () => React.createElement('Overflow'));
    expect(tree.root.findAllByType('MobileAreaSwitcher' as any)).toHaveLength(1);
    expect(tree.root.findAllByType('Overflow' as any)).toHaveLength(1);
  });

  it('leaves the area filter off screens that ignore it', () => {
    for (const routeName of ['settings', 'widget-list/[id]']) {
      expect(renderHeader(routeName).root.findAllByType('MobileAreaSwitcher' as any)).toHaveLength(0);
    }
  });
});
