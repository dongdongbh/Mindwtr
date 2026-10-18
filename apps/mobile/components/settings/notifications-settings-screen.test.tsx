import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, View } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationSettings } from '@mindwtr/core';
import { isIosAppBadgeSupported, readIosAppBadgeEnabled, setIosAppBadgeEnabled } from '@/lib/ios-app-badge';
import { requestNotificationPermission } from '@/lib/notification-service';

import { NotificationsSettingsScreen } from './notifications-settings-screen';

const { exactAlarmPermission, storeState } = vi.hoisted(() => ({
  exactAlarmPermission: vi.fn(() => ({ showNotice: false })),
  storeState: {
    settings: { notificationsEnabled: false } as NotificationSettings,
    updateSettings: vi.fn(async () => undefined),
  },
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    useTaskStore: () => storeState,
  };
});

vi.mock('@react-native-community/datetimepicker', () => ({
  default: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: Record<string, unknown> & { children?: React.ReactNode }) => (
    <View {...props}>{props.children}</View>
  ),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff',
    cardBg: '#fff',
    border: '#ddd',
    text: '#111',
    secondaryText: '#666',
    tint: '#06f',
  }),
}));

vi.mock('@/lib/notification-service', () => ({
  requestNotificationPermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  startMobileNotifications: vi.fn(async () => undefined),
}));

vi.mock('@/lib/persistent-capture-notification', () => ({
  applyPersistentCaptureNotification: vi.fn(),
  isPersistentCaptureSupported: vi.fn(() => false),
  readPersistentCaptureEnabled: vi.fn(async () => false),
  writePersistentCaptureEnabled: vi.fn(async () => undefined),
}));

vi.mock('@/lib/ios-app-badge', () => ({
  isIosAppBadgeSupported: vi.fn(() => false),
  readIosAppBadgeEnabled: vi.fn(async () => false),
  setIosAppBadgeEnabled: vi.fn(async (enabled: boolean) => enabled ? 'enabled' : 'disabled'),
}));

vi.mock('./exact-alarm-notice', () => ({
  ExactAlarmNoticeRow: () => null,
  useExactAlarmPermission: exactAlarmPermission,
}));

vi.mock('./setting-row', () => ({
  SettingRow: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
  SettingToggleRow: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
}));

vi.mock('./settings.hooks', () => ({
  useSettingsLocalization: () => ({ language: 'en', t: (key: string) => key }),
  useSettingsScrollContent: () => ({}),
}));

vi.mock('./settings.shell', () => ({
  SettingsTopBar: () => null,
}));

describe('NotificationsSettingsScreen exact-alarm feature boundary', () => {
  beforeEach(() => {
    exactAlarmPermission.mockClear();
    storeState.settings = { notificationsEnabled: false };
    vi.mocked(requestNotificationPermission).mockClear();
  });

  it.each([
    { label: 'morning digest', settings: { dailyDigestMorningEnabled: true }, active: true },
    { label: 'evening digest', settings: { dailyDigestEveningEnabled: true }, active: true },
    { label: 'weekly review', settings: { weeklyReviewEnabled: true }, active: true },
    { label: 'no notification feature', settings: {}, active: false },
  ])('passes $active to exact-alarm permission for $label only', ({ settings, active }) => {
    storeState.settings = { notificationsEnabled: false, ...settings };
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(<NotificationsSettingsScreen />);
    });

    expect(exactAlarmPermission).toHaveBeenLastCalledWith(active);
    act(() => tree.unmount());
  });
  it('lets the default change to Skip without enabling this device or asking permission', () => {
    storeState.updateSettings.mockClear();
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<NotificationsSettingsScreen />); });
    const row = tree.root.findByProps({ testID: 'task-reminder-default' });
    act(() => row.props.onPress());
    const skip = tree.root.findAllByProps({ accessibilityRole: 'radio' })
      .find((option) => option.props.accessibilityLabel === 'settings.taskReminderDefaultSkip')!;
    act(() => skip.props.onPress());
    expect(storeState.updateSettings).toHaveBeenCalledExactlyOnceWith({ taskReminderDefault: 'skip' });
    expect(storeState.settings.notificationsEnabled).toBe(false);
    expect(requestNotificationPermission).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

});

describe('iOS app icon badge', () => {
  beforeEach(() => {
    vi.mocked(isIosAppBadgeSupported).mockReturnValue(true);
    vi.mocked(readIosAppBadgeEnabled).mockResolvedValue(false);
    vi.mocked(setIosAppBadgeEnabled).mockReset().mockImplementation(async (enabled) => enabled ? 'enabled' : 'disabled');
    storeState.updateSettings.mockClear();
    vi.mocked(requestNotificationPermission).mockClear();
    vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  async function mount() {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<NotificationsSettingsScreen />); });
    return tree;
  }
  it('enables and disables locally without enabling reminder alerts', async () => {
    const tree = await mount();
    const row = () => tree.root.findByProps({ testID: 'app-icon-badge' });
    expect(row().props.value).toBe(false);
    expect(row().props.disabled).toBe(false);
    await act(async () => row().props.onChange(true));
    expect(row().props.value).toBe(true);
    await act(async () => row().props.onChange(false));
    expect(setIosAppBadgeEnabled).toHaveBeenNthCalledWith(2, false);
    expect(row().props.value).toBe(false);
    expect(storeState.updateSettings).not.toHaveBeenCalled();
    expect(requestNotificationPermission).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
  it.each(['denied', 'unavailable', 'failure'] as const)('does not enable after %s', async (result) => {
    if (result === 'failure') vi.mocked(setIosAppBadgeEnabled).mockRejectedValue(new Error('storage'));
    else vi.mocked(setIosAppBadgeEnabled).mockResolvedValue(result);
    const tree = await mount();
    await act(async () => tree.root.findByProps({ testID: 'app-icon-badge' }).props.onChange(true));
    expect(tree.root.findByProps({ testID: 'app-icon-badge' }).props.value).toBe(false);
    expect(Alert.alert).toHaveBeenCalledWith('settings.appIconBadge', result === 'denied' ? 'settings.appIconBadgeDenied' : 'settings.appIconBadgeError');
    act(() => tree.unmount());
  });
  it('waits for the saved preference and prevents overlapping toggle requests', async () => {
    let load!: (enabled: boolean) => void;
    vi.mocked(readIosAppBadgeEnabled).mockReturnValue(new Promise((resolve) => { load = resolve; }));
    const tree = await mount();
    const row = () => tree.root.findByProps({ testID: 'app-icon-badge' });
    expect(row().props.disabled).toBe(true);
    await act(async () => row().props.onChange(true));
    expect(setIosAppBadgeEnabled).not.toHaveBeenCalled();
    await act(async () => load(true));
    expect(row().props.value).toBe(true);
    let finish!: (result: 'disabled') => void;
    vi.mocked(setIosAppBadgeEnabled).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await act(async () => { row().props.onChange(false); row().props.onChange(false); });
    expect(setIosAppBadgeEnabled).toHaveBeenCalledTimes(1);
    expect(row().props.disabled).toBe(true);
    await act(async () => finish('disabled'));
    expect(row().props.value).toBe(false);
    act(() => tree.unmount());
  });
  it('hides the option when the native badge bridge is unsupported', async () => {
    vi.mocked(isIosAppBadgeSupported).mockReturnValue(false);
    const tree = await mount();
    expect(tree.root.findAllByProps({ testID: 'app-icon-badge' })).toHaveLength(0);
    act(() => tree.unmount());
  });
});
