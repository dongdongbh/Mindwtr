import { BackHandler, Platform, type NativeEventSubscription } from 'react-native';

export function addHardwareBackPressListener(
  handler: () => boolean,
): NativeEventSubscription {
  return BackHandler.addEventListener('hardwareBackPress', handler);
}


export function returnToPreviousApp(): boolean {
  if (Platform.OS !== 'android') return false;
  BackHandler.exitApp();
  return true;
}
