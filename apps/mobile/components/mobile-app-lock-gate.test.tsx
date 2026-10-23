import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState, Modal, Platform, type AppStateStatus } from 'react-native';
import { useTaskStore, type MobileAppLockRelockDelayMinutes } from '@mindwtr/core';

const authenticateWithDeviceLockMock = vi.hoisted(() => vi.fn());

vi.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0 },
  getEnrolledLevelAsync: vi.fn(),
  authenticateAsync: vi.fn(),
}));
vi.mock('@/lib/mobile-app-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mobile-app-lock')>()),
  authenticateWithDeviceLock: authenticateWithDeviceLockMock,
}));
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff', border: '#ccc', filterBg: '#eee', text: '#000', secondaryText: '#666', tint: '#36f', onTint: '#fff',
  }),
}));
vi.mock('@/hooks/use-filled-button-colors', () => ({ useFilledButtonColors: () => ({ backgroundColor: '#36f' }) }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
}));
vi.mock('lucide-react-native', () => ({ LockKeyhole: (props: any) => React.createElement('LockKeyhole', props) }));

import { MobileAppLockGate } from './mobile-app-lock-gate';

const textNode = (root: ReactTestInstance, text: string) => root.findAll((node) => (
  String(node.type) === 'Text' && node.props.children === text
))[0];

describe('MobileAppLockGate', () => {
  it('names the lock screen as a header and announces a failed unlock', async () => {
    authenticateWithDeviceLockMock.mockResolvedValue({ success: false, reason: 'failed' });
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<MobileAppLockGate enabled><></></MobileAppLockGate>);
    });

    expect(textNode(tree.root, 'Mindwtr is locked').props.accessibilityRole).toBe('header');

    const unlock = tree.root.findAll((node) => String(node.type) === 'TouchableOpacity')[0];
    await act(async () => { await unlock.props.onPress(); });

    expect(textNode(tree.root, 'Authentication failed. Try again.').props.accessibilityLiveRegion).toBe('polite');
    await act(async () => { tree.unmount(); });
  });

  describe('relock delay (#1423)', () => {
    const START = new Date('2026-10-21T10:00:00.000Z').getTime();
    let onAppStateChange: ((state: AppStateStatus) => void) | null = null;
    let mounted: ReactTestRenderer | null = null;

    beforeEach(() => {
      vi.useFakeTimers({ now: START });
      authenticateWithDeviceLockMock.mockReset();
      authenticateWithDeviceLockMock.mockResolvedValue({ success: true });
      vi.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (state: AppStateStatus) => void) => {
        onAppStateChange = listener;
        return { remove: () => { onAppStateChange = null; } };
      }) as never);
    });
    afterEach(async () => {
      await act(async () => { mounted?.unmount(); });
      mounted = null;
      vi.useRealTimers();
      vi.restoreAllMocks();
      useTaskStore.setState({ settings: {} });
    });

    const shows = (tree: ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'Content').length > 0;
    const setDelay = (delay: MobileAppLockRelockDelayMinutes | 'unknown') => {
      useTaskStore.setState({ settings: { security: {
        mobileAppLockEnabled: true, mobileAppLockRelockDelayMinutes: delay as MobileAppLockRelockDelayMinutes,
      } } });
    };
    const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    const changeTo = async (state: AppStateStatus) => { await act(async () => { onAppStateChange?.(state); }); };
    /** Mounts as a cold start and unlocks with the first prompt. */
    const coldStart = async () => {
      let tree!: ReactTestRenderer;
      await act(async () => {
        tree = create(<MobileAppLockGate enabled>{React.createElement('Content')}</MobileAppLockGate>);
      });
      mounted = tree;
      expect(shows(tree)).toBe(false);
      await wait(300);
      return tree;
    };
    const leaveAndReturn = async (awayMs: number) => {
      await changeTo('inactive');
      await changeTo('background');
      vi.setSystemTime(Date.now() + awayMs);
      await changeTo('active');
      await wait(300);
    };

    it('asks on a cold start whatever the delay', async () => {
      setDelay(15);
      const tree = await coldStart();
      expect(authenticateWithDeviceLockMock).toHaveBeenCalledTimes(1);
      expect(shows(tree)).toBe(true);
    });

    it('does not ask again when the app returns within the delay', async () => {
      setDelay(5);
      const tree = await coldStart();
      await leaveAndReturn(4 * 60_000);
      expect(authenticateWithDeviceLockMock).toHaveBeenCalledTimes(1);
      expect(shows(tree)).toBe(true);
    });

    it('covers the app while it is away, even within the delay', async () => {
      setDelay(5);
      const tree = await coldStart();
      await changeTo('inactive');
      expect(shows(tree)).toBe(false);
    });

    it.each([
      ['past the delay', 1 as const, 61_000],
      ['Immediately', 0 as const, 1_000],
      ['an unknown stored delay, read as Immediately', 'unknown' as const, 1_000],
      ['a clock moved back', 15 as const, -60_000],
    ])('asks again after %s', async (_name, delay, awayMs) => {
      setDelay(delay);
      const tree = await coldStart();
      authenticateWithDeviceLockMock.mockResolvedValue({ success: false, reason: 'cancelled' });
      await leaveAndReturn(awayMs);
      expect(authenticateWithDeviceLockMock).toHaveBeenCalledTimes(2);
      expect(shows(tree)).toBe(false);
    });

    it('stays locked on a quick return when the app left while still locked', async () => {
      setDelay(15);
      authenticateWithDeviceLockMock.mockResolvedValue({ success: false, reason: 'cancelled' });
      const tree = await coldStart();
      expect(shows(tree)).toBe(false);
      await leaveAndReturn(1_000);
      expect(authenticateWithDeviceLockMock).toHaveBeenCalledTimes(2);
      expect(shows(tree)).toBe(false);
    });

    describe('on Android', () => {
      const originalOs = Platform.OS;
      const setOs = (os: typeof Platform.OS) => Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
      beforeEach(() => setOs('android'));
      afterEach(() => setOs(originalOs));

      const lockModal = (tree: ReactTestRenderer) => tree.root.findByType(Modal);
      let contentMounts = 0;
      const MountCounter = () => {
        React.useEffect(() => { contentMounts += 1; }, []);
        return React.createElement('Content');
      };
      const coldStartCounting = async () => {
        contentMounts = 0;
        let tree!: ReactTestRenderer;
        await act(async () => {
          tree = create(<MobileAppLockGate enabled><MountCounter /></MobileAppLockGate>);
        });
        mounted = tree;
        expect(lockModal(tree).props.visible).toBe(true);
        await wait(300);
        return tree;
      };

      it('keeps the app, and an open task, mounted under the lock while it is away', async () => {
        setDelay(5);
        const tree = await coldStartCounting();
        await changeTo('inactive');
        await changeTo('background');
        expect(lockModal(tree).props.visible).toBe(true);
        expect(shows(tree)).toBe(true);
        expect(contentMounts).toBe(1);
      });

      it('shows the same screen at once when the app returns within the delay', async () => {
        setDelay(5);
        const tree = await coldStartCounting();
        await leaveAndReturn(60_000);
        expect(authenticateWithDeviceLockMock).toHaveBeenCalledTimes(1);
        expect(lockModal(tree).props.visible).toBe(false);
        expect(contentMounts).toBe(1);
      });

      it('keeps the screen after an unlock past the delay', async () => {
        setDelay(1);
        const tree = await coldStartCounting();
        await leaveAndReturn(5 * 60_000);
        expect(authenticateWithDeviceLockMock).toHaveBeenCalledTimes(2);
        expect(lockModal(tree).props.visible).toBe(false);
        expect(contentMounts).toBe(1);
      });
    });
  });
});
