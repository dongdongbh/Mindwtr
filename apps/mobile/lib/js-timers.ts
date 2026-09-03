import { AppState, Platform } from 'react-native';
import { setSleepBypass } from '@mindwtr/core';

// React Native on Android pauses every JavaScript timer while the activity is
// paused (JavaTimerManager.onHostPause), and a headless instance starts paused.
// Nothing scheduled with setTimeout runs again until the app is on screen.
export const areJsTimersPaused = (): boolean => (
  Platform.OS === 'android' && AppState.currentState !== 'active'
);

// Retry back-off in core sleeps with setTimeout, which would never wake up in
// the background; there is no UI to pace there, so the wait is skipped.
setSleepBypass(areJsTimersPaused);
