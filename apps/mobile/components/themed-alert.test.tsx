import React from 'react';
import { Alert, Modal, Platform, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThemedAlertHost, ThemedAlertProvider } from './themed-alert';

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#020617',
    cardBg: '#0f172a',
    taskItemBg: '#111827',
    text: '#f8fafc',
    secondaryText: '#cbd5e1',
    icon: '#cbd5e1',
    border: '#334155',
    tint: '#2563eb',
    onTint: '#ffffff',
    tabIconDefault: '#64748b',
    tabIconSelected: '#2563eb',
    inputBg: '#111827',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
    filterBg: '#1e293b',
  }),
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => ({ 'common.ok': 'OK' }[key] ?? key) }),
}));

const originalPlatformOs = Platform.OS;

const setPlatform = (os: typeof Platform.OS) => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
};


const findOverlays = (root: ReturnType<typeof create>['root'] | null, title: string) => (
  root ? root.findAllByType(Pressable).filter((node) => node.props.accessibilityLabel === title) : []
);

describe('ThemedAlertProvider', () => {
  let tree: ReturnType<typeof create> | null = null;

  afterEach(() => {
    if (tree) {
      act(() => {
        tree?.unmount();
      });
      tree = null;
    }
    setPlatform(originalPlatformOs);
  });

  it('renders Alert.alert through the themed modal and runs the chosen action', () => {
    const onDelete = vi.fn();
    let rendered!: ReturnType<typeof create>;

    act(() => {
      rendered = create(
        <ThemedAlertProvider>
          <Text>Screen</Text>
        </ThemedAlertProvider>
      );
      tree = rendered;
    });

    act(() => {
      Alert.alert('Tes', 'Move this task to Trash?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ]);
    });

    expect(rendered.root.findByType(Modal).props.visible).toBe(true);
    expect(rendered.root.findAllByProps({ children: 'Tes' }).length).toBeGreaterThan(0);
    expect(rendered.root.findAllByProps({ children: 'Move this task to Trash?' }).length).toBeGreaterThan(0);

    const buttons = rendered.root.findAllByType(TouchableOpacity);
    expect(buttons).toHaveLength(2);

    act(() => {
      buttons[1].props.onPress();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(rendered.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('treats Android back as the only visible action for non-cancelable default alerts', () => {
    let rendered!: ReturnType<typeof create>;

    act(() => {
      rendered = create(
        <ThemedAlertProvider>
          <Text>Screen</Text>
        </ThemedAlertProvider>
      );
      tree = rendered;
    });

    act(() => {
      Alert.alert('Notice', 'Sync finished.', undefined, { cancelable: false });
    });

    const modal = rendered.root.findByType(Modal);
    expect(modal.props.visible).toBe(true);

    act(() => {
      modal.props.onRequestClose();
    });

    expect(rendered.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('renders through the host instead of a second native modal on iOS', () => {
    setPlatform('ios');
    const onOk = vi.fn();
    let rendered!: ReturnType<typeof create>;

    act(() => {
      rendered = create(
        <ThemedAlertProvider>
          <Text>Screen</Text>
          <ThemedAlertHost />
        </ThemedAlertProvider>
      );
      tree = rendered;
    });

    act(() => {
      Alert.alert('Editor layout', 'Drag a row to reorder it.', [{ text: 'OK', onPress: onOk }]);
    });

    expect(rendered.root.findAllByType(Modal)).toHaveLength(0);
    const overlays = findOverlays(rendered.root, 'Editor layout');
    expect(overlays).toHaveLength(1);
    expect(overlays[0].props.accessibilityViewIsModal).toBe(true);

    act(() => {
      rendered.root.findAllByType(TouchableOpacity)[0].props.onPress();
    });

    expect(onOk).toHaveBeenCalledTimes(1);
    expect(findOverlays(rendered.root, 'Editor layout')).toHaveLength(0);
  });

  it('falls back to the root modal on iOS when no host is mounted', () => {
    setPlatform('ios');
    let rendered!: ReturnType<typeof create>;

    act(() => {
      rendered = create(
        <ThemedAlertProvider>
          <Text>Screen</Text>
        </ThemedAlertProvider>
      );
      tree = rendered;
    });

    act(() => {
      Alert.alert('Notice', 'Sync finished.');
    });

    expect(rendered.root.findByType(Modal).props.visible).toBe(true);
    expect(findOverlays(rendered.root, 'Notice')).toHaveLength(1);
  });

  it('keeps the root modal path on Android even when a host is mounted', () => {
    setPlatform('android');
    let rendered!: ReturnType<typeof create>;

    act(() => {
      rendered = create(
        <ThemedAlertProvider>
          <Text>Screen</Text>
          <ThemedAlertHost />
        </ThemedAlertProvider>
      );
      tree = rendered;
    });

    act(() => {
      Alert.alert('Notice', 'Sync finished.');
    });

    const modal = rendered.root.findByType(Modal);
    expect(modal.props.visible).toBe(true);

    expect(findOverlays(rendered.root, 'Notice')).toHaveLength(1);
    expect(findOverlays(modal, 'Notice')).toHaveLength(1);
  });

  it('renders in the last registered host and hands back when it unmounts', () => {
    setPlatform('ios');
    const Harness = ({ innerVisible }: { innerVisible: boolean }) => (
      <ThemedAlertProvider>
        <View testID="outer-host">
          <ThemedAlertHost />
        </View>
        {innerVisible ? (
          <View testID="inner-host">
            <ThemedAlertHost />
          </View>
        ) : null}
      </ThemedAlertProvider>
    );
    let rendered!: ReturnType<typeof create>;

    act(() => {
      rendered = create(<Harness innerVisible />);
      tree = rendered;
    });

    act(() => {
      Alert.alert('Delete section?', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive' },
      ]);
    });

    const outer = () => rendered.root.findAllByProps({ testID: 'outer-host' })[0];
    const inner = () => rendered.root.findAllByProps({ testID: 'inner-host' })[0];
    expect(findOverlays(inner(), 'Delete section?')).toHaveLength(1);
    expect(findOverlays(outer(), 'Delete section?')).toHaveLength(0);

    act(() => {
      rendered.update(<Harness innerVisible={false} />);
    });

    expect(findOverlays(outer(), 'Delete section?')).toHaveLength(1);
  });

  it('presents a queued alert through the host after the first is answered', () => {
    setPlatform('ios');
    const onFirst = vi.fn();
    let rendered!: ReturnType<typeof create>;

    act(() => {
      rendered = create(
        <ThemedAlertProvider>
          <ThemedAlertHost />
        </ThemedAlertProvider>
      );
      tree = rendered;
    });

    act(() => {
      Alert.alert('First', undefined, [{ text: 'OK', onPress: onFirst }]);
      Alert.alert('Second', undefined, [{ text: 'OK' }]);
    });

    expect(findOverlays(rendered.root, 'First')).toHaveLength(1);
    expect(findOverlays(rendered.root, 'Second')).toHaveLength(0);

    act(() => {
      rendered.root.findAllByType(TouchableOpacity)[0].props.onPress();
    });

    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(findOverlays(rendered.root, 'Second')).toHaveLength(1);
    expect(rendered.root.findAllByType(Modal)).toHaveLength(0);
  });
});
