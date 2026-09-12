import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform, Text, TouchableOpacity } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdaptiveWindowProvider, useAdaptiveWindow } from './use-adaptive-window';

const nativeState = vi.hoisted(() => ({
  current: null as import('@/modules/android-window-layout').AndroidWindowLayoutSnapshot | null,
  listener: null as ((snapshot: import('@/modules/android-window-layout').AndroidWindowLayoutSnapshot) => void) | null,
}));
const logInfo = vi.hoisted(() => vi.fn());

vi.mock('@/modules/android-window-layout', () => ({
  getAndroidWindowLayout: () => nativeState.current,
  subscribeAndroidWindowLayout: (listener: typeof nativeState.listener) => {
    nativeState.listener = listener;
    return () => {
      nativeState.listener = null;
    };
  },
}));

vi.mock('@/lib/app-log', () => ({ logInfo }));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function StatefulProbe() {
  const adaptiveWindow = useAdaptiveWindow();
  const [draftVersion, setDraftVersion] = React.useState(0);
  return (
    <TouchableOpacity
      testID="probe"
      accessibilityLabel={`${adaptiveWindow.mode}:${draftVersion}`}
      onPress={() => setDraftVersion((current) => current + 1)}
    >
      <Text>{adaptiveWindow.mode}</Text>
    </TouchableOpacity>
  );
}

describe('AdaptiveWindowProvider', () => {
  let tree: ReactTestRenderer | null = null;

  beforeEach(() => {
    tree?.unmount();
    tree = null;
    nativeState.current = null;
    nativeState.listener = null;
    logInfo.mockReset();
    Platform.OS = 'android';
  });

  it('preserves child state while live dimensions move between compact and expanded', () => {
    act(() => {
      tree = create(
        <AdaptiveWindowProvider>
          <StatefulProbe />
        </AdaptiveWindowProvider>,
      );
    });

    const root = tree!.root.findByProps({ testID: 'adaptive-window-root' });
    const probe = tree!.root.findByProps({ testID: 'probe' });
    expect(probe.props.accessibilityLabel).toBe('compact:0');

    act(() => probe.props.onPress());
    expect(tree!.root.findByProps({ testID: 'probe' }).props.accessibilityLabel).toBe('compact:1');

    act(() => {
      root.props.onLayout({ nativeEvent: { layout: { width: 900, height: 674 } } });
      nativeState.listener?.({ width: 900, height: 674, features: [] });
    });

    expect(tree!.root.findByProps({ testID: 'probe' }).props.accessibilityLabel).toBe('expanded:1');
  });

  it('logs native-backed adaptation once per layout and posture signature', () => {
    act(() => {
      tree = create(
        <AdaptiveWindowProvider>
          <StatefulProbe />
        </AdaptiveWindowProvider>,
      );
    });
    const root = tree!.root.findByProps({ testID: 'adaptive-window-root' });
    act(() => root.props.onLayout({ nativeEvent: { layout: { width: 900, height: 674 } } }));

    const flatSnapshot = { width: 900, height: 674, features: [] };
    act(() => nativeState.listener?.(flatSnapshot));
    act(() => nativeState.listener?.({ ...flatSnapshot }));

    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith('Android adaptive window updated', {
      scope: 'adaptive-window',
      extra: {
        releaseCheck: 'v1.3.0/android-adaptive-window',
        count: 0,
        reason: 'expanded-flat',
      },
    });
  });
});
