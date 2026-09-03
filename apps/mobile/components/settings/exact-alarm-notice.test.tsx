import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRelevant, mockRefresh, mockOpen, appStateListeners } = vi.hoisted(() => ({
  mockRelevant: vi.fn(() => true),
  mockRefresh: vi.fn(async () => true),
  mockOpen: vi.fn(async () => undefined),
  appStateListeners: [] as ((state: string) => void)[],
}));

vi.mock('@/lib/exact-alarm-permission', () => ({
  isExactAlarmPermissionRelevant: mockRelevant,
  refreshExactAlarmPermission: mockRefresh,
  openExactAlarmSettings: mockOpen,
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
  }),
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    AppState: {
      currentState: 'active',
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appStateListeners.push(listener);
        return {
          remove: () => {
            const index = appStateListeners.indexOf(listener);
            if (index >= 0) appStateListeners.splice(index, 1);
          },
        };
      },
    },
  };
});

import { ExactAlarmNoticeRow, useExactAlarmPermission } from './exact-alarm-notice';

function Probe({ enabled }: { enabled: boolean }) {
  const { showNotice } = useExactAlarmPermission(enabled);
  return <Text>{showNotice ? 'notice' : 'no-notice'}</Text>;
}

const renderProbe = async (enabled: boolean) => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<Probe enabled={enabled} />);
  });
  return tree;
};

const noticeState = (tree: renderer.ReactTestRenderer) => tree.root.findByType(Text).props.children;

beforeEach(() => {
  appStateListeners.length = 0;
  mockRelevant.mockReturnValue(true);
  mockRefresh.mockClear();
  mockRefresh.mockResolvedValue(true);
  mockOpen.mockClear();
});

describe('useExactAlarmPermission', () => {
  it('shows the notice when the feature is on and exact alarms are denied', async () => {
    mockRefresh.mockResolvedValue(false);
    const tree = await renderProbe(true);
    expect(noticeState(tree)).toBe('notice');
  });

  it('hides the notice when exact alarms are allowed', async () => {
    const tree = await renderProbe(true);
    expect(noticeState(tree)).toBe('no-notice');
  });

  it('does not read the permission while the feature is off', async () => {
    mockRefresh.mockResolvedValue(false);
    const tree = await renderProbe(false);
    expect(noticeState(tree)).toBe('no-notice');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does not read the permission below Android 12', async () => {
    mockRelevant.mockReturnValue(false);
    mockRefresh.mockResolvedValue(false);
    const tree = await renderProbe(true);
    expect(noticeState(tree)).toBe('no-notice');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('re-reads the permission when the app returns to the foreground', async () => {
    mockRefresh.mockResolvedValue(false);
    const tree = await renderProbe(true);
    expect(noticeState(tree)).toBe('notice');
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    mockRefresh.mockResolvedValue(true);
    await act(async () => {
      appStateListeners.forEach((listener) => listener('active'));
    });

    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(noticeState(tree)).toBe('no-notice');
  });

  it('ignores background transitions', async () => {
    const tree = await renderProbe(true);
    await act(async () => {
      appStateListeners.forEach((listener) => listener('background'));
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(noticeState(tree)).toBe('no-notice');
  });

  it('detaches its listener on unmount', async () => {
    const tree = await renderProbe(true);
    expect(appStateListeners).toHaveLength(1);
    await act(async () => {
      tree.unmount();
    });
    expect(appStateListeners).toHaveLength(0);
  });
});

describe('ExactAlarmNoticeRow', () => {
  it('opens the system screen from its action button', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ExactAlarmNoticeRow label="Late" description="Why" actionLabel="Allow" />
      );
    });

    const button = tree.root.findByProps({ testID: 'exact-alarm-allow' });
    await act(async () => {
      button.props.onPress();
    });

    expect(mockOpen).toHaveBeenCalledTimes(1);
  });
});
