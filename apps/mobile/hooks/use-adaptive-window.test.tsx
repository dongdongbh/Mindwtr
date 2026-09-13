import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform, Text, TextInput, TouchableOpacity } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdaptiveWindowProvider, useAdaptiveWindow } from './use-adaptive-window';
import { AdaptiveModalSurface } from '@/components/adaptive-modal-surface';
import { RootAdaptiveWindowHost } from '@/app/_layout';
import AppLayout from '@/app/(drawer)/_layout';

const nativeState = vi.hoisted(() => ({
  current: null as import('@/modules/android-window-layout').AndroidWindowLayoutSnapshot | null,
  listener: null as ((snapshot: import('@/modules/android-window-layout').AndroidWindowLayoutSnapshot) => void) | null,
  subscriptionCount: 0,
}));
const logInfo = vi.hoisted(() => vi.fn());

vi.mock('../polyfills', () => ({}));

vi.mock('@/modules/android-window-layout', () => ({
  getAndroidWindowLayout: () => nativeState.current,
  subscribeAndroidWindowLayout: (listener: typeof nativeState.listener) => {
    nativeState.subscriptionCount += 1;
    nativeState.listener = listener;
    return () => {
      nativeState.listener = null;
    };
  },
}));

vi.mock('@/lib/app-log', () => ({ logInfo }));

vi.mock('@/hooks/root-layout/use-root-layout-context-automation', () => ({ useRootLayoutContextAutomation: vi.fn() }));
vi.mock('@/hooks/root-layout/use-root-layout-external-capture', () => ({ useRootLayoutExternalCapture: vi.fn() }));
vi.mock('@/hooks/root-layout/use-root-layout-notification-open-handler', () => ({ useRootLayoutNotificationOpenHandler: vi.fn() }));
vi.mock('@/hooks/root-layout/use-root-layout-pending-captures', () => ({ useRootLayoutPendingCaptures: vi.fn() }));
vi.mock('@/hooks/root-layout/use-root-layout-pomodoro', () => ({ useRootLayoutPomodoro: vi.fn() }));
vi.mock('@/hooks/root-layout/use-root-layout-startup', () => ({ useRootLayoutStartup: vi.fn() }));
vi.mock('@/hooks/root-layout/use-root-layout-sync-effects', () => ({ useRootLayoutSyncEffects: vi.fn() }));
vi.mock('@/hooks/root-layout/use-root-layout-watch', () => ({ useRootLayoutWatch: vi.fn() }));

vi.mock('@/components/mobile-app-lock-gate', () => ({
  MobileAppLockGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/mobile-workspace-boot-gate', () => ({
  MobileWorkspaceBootGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/MobileOnboardingFlow', () => ({ MobileOnboardingFlow: () => null }));
vi.mock('@/components/app-announcement-modal', () => ({ AppAnnouncementModal: () => null }));
vi.mock('@/components/persistence-failure-banner', () => ({ PersistenceFailureBanner: () => null }));
vi.mock('@/components/sandbox-workspace-banner', () => ({
  MobileWorkspaceSwitchOverlay: () => null,
  SandboxWorkspaceBanner: () => null,
}));

vi.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('expo-application', () => ({ getInstallReferrerAsync: vi.fn().mockResolvedValue('') }));

vi.mock('expo-constants', () => ({
  default: { appOwnership: 'expo', expoConfig: { extra: {}, version: '0.0.0' } },
}));

vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(undefined) }));

vi.mock('expo-calendar', () => ({}));

vi.mock('@react-navigation/native', () => ({
  DarkTheme: {},
  DefaultTheme: {},
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@react-navigation/elements', () => ({ getHeaderTitle: () => 'Title' }));

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-screens', () => ({ enableFreeze: vi.fn() }));

vi.mock('react-native-widgetkit', () => ({}));

vi.mock('expo-share-intent', () => ({
  ShareIntentProvider: ({ children }: { children: React.ReactNode }) => children,
  useShareIntentContext: () => ({ hasShareIntent: false, resetShareIntent: vi.fn() }),
}));

vi.mock('expo-router', async () => {
  const ReactModule = await import('react');
  const Stack = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement(
    ReactModule.Fragment,
    null,
    children,
  );
  Stack.Screen = () => null;
  return {
    Stack,
    useGlobalSearchParams: () => ({}),
    useNavigationContainerRef: () => ({}),
    usePathname: () => '/',
    useRouter: () => ({}),
  };
});

vi.mock('@/contexts/language-context', () => ({
  LanguageProvider: ({ children }: { children: React.ReactNode }) => children,
  useLanguage: () => ({ language: 'en', setLanguage: vi.fn(), isReady: true, t: (key: string) => key }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ bg: '#fff', border: '#ddd', cardBg: '#fff', text: '#111' }),
}));

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

function RootSiblingEditorProbe() {
  const [draft, setDraft] = React.useState('initial draft');
  return (
    <AdaptiveModalSurface testID="root-sibling-editor" variant="editor">
      <TextInput testID="root-sibling-draft" value={draft} onChangeText={setDraft} />
    </AdaptiveModalSurface>
  );
}

function AdaptiveGeometryProbe() {
  const adaptiveWindow = useAdaptiveWindow();
  return (
    <Text testID="adaptive-geometry">
      {`${adaptiveWindow.width}:${adaptiveWindow.height}:${adaptiveWindow.mode}:${adaptiveWindow.activeFeature?.orientation ?? 'none'}`}
    </Text>
  );
}

const flattenStyle = (style: unknown) => Object.assign(
  {},
  ...(Array.isArray(style) ? style : [style]).filter(Boolean),
);

const findEditorSurface = (tree: ReactTestRenderer) => tree.root.findAllByProps({
  testID: 'root-sibling-editor',
}).find((node) => Array.isArray(node.props.style));

describe('AdaptiveWindowProvider', () => {
  let tree: ReactTestRenderer | null = null;

  beforeEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = null;
    nativeState.current = null;
    nativeState.listener = null;
    nativeState.subscriptionCount = 0;
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

  it('shares one native-aware root provider with drawer and sibling editors while preserving drafts', () => {
    act(() => {
      tree = create(
        <RootAdaptiveWindowHost>
          <AppLayout />
          <RootSiblingEditorProbe />
        </RootAdaptiveWindowHost>,
      );
    });

    expect(tree!.root.findAllByType(AdaptiveWindowProvider)).toHaveLength(1);
    expect(nativeState.subscriptionCount).toBe(1);

    const input = tree!.root.findByProps({ testID: 'root-sibling-draft' });
    act(() => input.props.onChangeText('typed across geometry'));

    const root = tree!.root.findByProps({ testID: 'adaptive-window-root' });
    act(() => {
      root.props.onLayout({ nativeEvent: { layout: { width: 900, height: 700 } } });
      nativeState.listener?.({
        width: 900,
        height: 700,
        features: [{
          bounds: { left: 440, top: 0, right: 460, bottom: 700 },
          orientation: 'vertical',
          state: 'half-opened',
          isSeparating: true,
          occlusionType: 'full',
        }],
      });
    });

    const editor = findEditorSurface(tree!);
    expect(editor).toBeDefined();
    expect(flattenStyle(editor!.props.style)).toMatchObject({ left: 468, width: 432 });
    expect(tree!.root.findByProps({ testID: 'root-sibling-draft' }).props.value).toBe('typed across geometry');
    expect(nativeState.subscriptionCount).toBe(1);
  });

  it('keeps the root provider on the dimension fallback without subscribing on iOS', () => {
    Platform.OS = 'ios';

    act(() => {
      tree = create(
        <RootAdaptiveWindowHost>
          <AdaptiveGeometryProbe />
          <RootSiblingEditorProbe />
        </RootAdaptiveWindowHost>,
      );
    });

    const root = tree!.root.findByProps({ testID: 'adaptive-window-root' });
    act(() => root.props.onLayout({ nativeEvent: { layout: { width: 900, height: 700 } } }));

    const editor = findEditorSurface(tree!);
    expect(editor).toBeDefined();
    expect(flattenStyle(editor!.props.style)).toEqual({});
    expect(tree!.root.findByProps({ testID: 'adaptive-geometry' }).props.children)
      .toBe('900:700:compact:none');
    expect(nativeState.subscriptionCount).toBe(0);
  });
});
