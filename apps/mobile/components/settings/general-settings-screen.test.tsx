import React from 'react';
import renderer from 'react-test-renderer';
import { Modal, ScrollView, Switch, Text, TouchableOpacity } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GeneralSettingsScreen } from './general-settings-screen';
import { MobileAppLockEnableContext } from '@/lib/mobile-app-lock';

const { authenticateMock, updateSettingsMock } = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  updateSettingsMock: vi.fn(),
}));


vi.mock('@mindwtr/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mindwtr/core')>()),
  shallow: Object.is,
  useTaskStore: (selector: (state: unknown) => unknown) => selector({
    settings: { weekStart: 'monday', dateFormat: 'ymd', timeFormat: '24h' },
    updateSettings: updateSettingsMock,
  }),
}));

vi.mock('@/contexts/theme-context', () => ({
  useTheme: () => ({ themeMode: 'dark', setThemeMode: vi.fn() }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a', cardBg: '#111827', filterBg: '#1f2937', border: '#334155',
    text: '#f8fafc', secondaryText: '#94a3b8', tint: '#3b82f6', danger: '#ef4444',
  }),
}));

vi.mock('@/lib/app-search-preference', () => ({
  isAppSearchSupported: () => false,
  readAppSearchIndexingEnabled: async () => false,
  writeAppSearchIndexingEnabled: async () => undefined,
}));
vi.mock('@/lib/app-search-service', () => ({
  enableAppSearchIndexing: async () => undefined,
  wipeAppSearchIndex: async () => undefined,
}));
vi.mock('@/lib/mobile-app-lock', async () => {
  const { createContext } = await import('react');
  return {
    MobileAppLockEnableContext: createContext<() => void>(() => undefined),
    authenticateWithDeviceLock: authenticateMock,
    getMobileAppLockErrorKey: () => 'appLock.failed',
  };
});
vi.mock('@/modules/system-date-format', () => ({ getSystemDateFormat: () => 'dd.MM.yyyy' }));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
}));


vi.mock('./settings.hooks', () => ({
  useSettingsLocalization: () => ({ language: 'fa', tr: (key: string) => key, t: (key: string) => key, setLanguage: vi.fn() }),
  useSettingsScrollContent: () => ({}),
}));

vi.mock('./settings.shell', () => ({
  SettingsTopBar: () => React.createElement('SettingsTopBar'),
}));

describe('GeneralSettingsScreen pickers', () => {
  beforeEach(() => {
    authenticateMock.mockReset();
    authenticateMock.mockResolvedValue({ success: false, reason: 'cancelled' });
    updateSettingsMock.mockReset();
    updateSettingsMock.mockResolvedValue(undefined);
  });

  it.each([false, true])('notifies its mounted gate only after successful enable authentication: %s', async (success) => {
    const confirm = vi.fn();
    authenticateMock.mockResolvedValue({ success, reason: 'cancelled' });
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<MobileAppLockEnableContext.Provider value={confirm}><GeneralSettingsScreen /></MobileAppLockEnableContext.Provider>);
    });
    await renderer.act(async () => {
      tree.root.findAllByType(Switch).find((node) => node.props.disabled === false)!.props.onValueChange(true);
    });
    expect(authenticateMock).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(updateSettingsMock).toHaveBeenCalledTimes(success ? 1 : 0);
    if (success) {
      expect(updateSettingsMock).toHaveBeenCalledWith(expect.objectContaining({ security: expect.objectContaining({ mobileAppLockEnabled: true }) }));
      expect(updateSettingsMock.mock.invocationCallOrder[0]).toBeLessThan(confirm.mock.invocationCallOrder[0]);
    }
    await renderer.act(async () => tree.unmount());
  });

  it('previews the actual native System date pattern even with an explicit format selected', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<GeneralSettingsScreen />); });
    const today = new Date();
    const sample = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
    expect(tree.root.findAllByType(Text).some((node) => node.props.children === `settings.dateFormatSystem (${sample})`)).toBe(true);
    renderer.act(() => tree.unmount());
  });

  it('tells a screen reader each option is a choice and which one is chosen', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GeneralSettingsScreen />);
    });


    const pickers = tree.root.findAllByType(Modal).map((modal) => modal.findByType(ScrollView).findAllByType(TouchableOpacity));

    expect(pickers).toHaveLength(7);
    for (const options of pickers) {
      for (const option of options) {
        const checked = option.findAll((node) => String(node.type) === 'Icon' && node.props.name === 'checkmark').length > 0;
        expect(option.props.accessibilityRole).toBe('radio');
        expect(option.props.accessibilityState).toEqual({ selected: checked });
      }
      expect(options.filter((option) => option.props.accessibilityState?.selected)).toHaveLength(1);
    }
  });
});
