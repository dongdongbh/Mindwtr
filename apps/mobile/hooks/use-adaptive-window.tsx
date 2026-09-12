import React from 'react';
import {
  I18nManager,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  getAndroidWindowLayout,
  subscribeAndroidWindowLayout,
  type AndroidWindowLayoutSnapshot,
} from '@/modules/android-window-layout';
import {
  getAdaptiveWindowDiagnostic,
  resolveAdaptiveWindow,
} from '@/lib/adaptive-window';
import { logInfo } from '@/lib/app-log';
import {
  AdaptiveWindowContextProvider,
  useAdaptiveWindow,
} from '@/components/adaptive-window-context';

const readInitialNativeSnapshot = (enabled: boolean): AndroidWindowLayoutSnapshot | null => {
  if (!enabled || Platform.OS !== 'android') return null;
  return getAndroidWindowLayout();
};

const useResolvedAdaptiveWindow = (enabled: boolean) => {
  const dimensions = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [measuredSize, setMeasuredSize] = React.useState<{ width: number; height: number } | null>(null);
  const [nativeSnapshot, setNativeSnapshot] = React.useState<AndroidWindowLayoutSnapshot | null>(() => (
    readInitialNativeSnapshot(enabled)
  ));

  React.useEffect(() => {
    if (!enabled || Platform.OS !== 'android') {
      setNativeSnapshot(null);
      return;
    }
    setNativeSnapshot(getAndroidWindowLayout());
    return subscribeAndroidWindowLayout(setNativeSnapshot);
  }, [enabled]);

  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    setMeasuredSize((current) => (
      current?.width === width && current.height === height ? current : { width, height }
    ));
  }, []);

  const layout = React.useMemo(() => resolveAdaptiveWindow({
    width: measuredSize?.width ?? dimensions.width,
    height: measuredSize?.height ?? dimensions.height,
    fontScale: dimensions.fontScale,
    insets,
    isRtl: I18nManager.isRTL,
    platform: Platform.OS === 'android' ? 'android' : 'other',
    nativeSnapshot,
  }), [
    dimensions.fontScale,
    dimensions.height,
    dimensions.width,
    insets,
    measuredSize?.height,
    measuredSize?.width,
    nativeSnapshot,
  ]);

  return { layout, onLayout };
};

export function AdaptiveWindowProvider({ children }: { children: React.ReactNode }) {
  const { layout, onLayout } = useResolvedAdaptiveWindow(true);
  const lastLoggedDiagnosticRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const diagnostic = getAdaptiveWindowDiagnostic(layout);
    if (!diagnostic) return;
    const signature = `${diagnostic.reason}:${diagnostic.count}`;
    if (signature === lastLoggedDiagnosticRef.current) return;
    lastLoggedDiagnosticRef.current = signature;
    void logInfo('Android adaptive window updated', {
      scope: 'adaptive-window',
      extra: {
        releaseCheck: 'v1.3.0/android-adaptive-window',
        count: diagnostic.count,
        reason: diagnostic.reason,
      },
    });
  }, [layout]);

  return (
    <AdaptiveWindowContextProvider value={layout}>
      <View style={styles.container} onLayout={onLayout} testID="adaptive-window-root">
        {children}
      </View>
    </AdaptiveWindowContextProvider>
  );
}

export { useAdaptiveWindow };

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
