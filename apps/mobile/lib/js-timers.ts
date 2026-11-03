import { AppState, Platform } from 'react-native';
import { setSleepBypass } from '@mindwtr/core';


export const areJsTimersPaused = (): boolean => (
  Platform.OS === 'android' && AppState.currentState !== 'active'
);


setSleepBypass(areJsTimersPaused);
