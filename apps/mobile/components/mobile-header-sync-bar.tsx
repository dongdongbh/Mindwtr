import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useTaskStore } from '@mindwtr/core';

import { getMobileSyncActivityState, subscribeMobileSyncActivityState } from '../lib/sync-service';
import { useThemeColors } from '@/hooks/use-theme-colors';

export function MobileHeaderSyncBar() {
  const tc = useThemeColors();
  const { width } = useWindowDimensions();
  const pendingRemoteWriteAt = useTaskStore((state) => state.settings?.pendingRemoteWriteAt);
  const [activityState, setActivityState] = useState(getMobileSyncActivityState());
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    return subscribeMobileSyncActivityState(setActivityState);
  }, []);

  const visible = activityState === 'syncing' || Boolean(pendingRemoteWriteAt);

  useEffect(() => {
    if (!visible) {
      progress.stopAnimation();
      progress.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1100,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    progress.setValue(0);
    animation.start();
    return () => {
      animation.stop();
      progress.stopAnimation();
    };
  }, [progress, visible]);

  if (!visible) return null;

  const segmentWidth = Math.max(72, Math.round(width * 0.28));
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-segmentWidth, width],
  });

  return (
    <View pointerEvents="none" style={[styles.track, { backgroundColor: `${tc.tint}14` }]}>
      <Animated.View
        style={[
          styles.bar,
          {
            width: segmentWidth,
            backgroundColor: tc.tint,
            transform: [{ translateX }],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    overflow: 'hidden',
  },
  bar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: 999,
  },
});
