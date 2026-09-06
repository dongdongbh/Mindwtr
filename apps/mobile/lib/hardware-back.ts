import { BackHandler, Platform, type NativeEventSubscription } from 'react-native';

export function addHardwareBackPressListener(
  handler: () => boolean,
): NativeEventSubscription {
  return BackHandler.addEventListener('hardwareBackPress', handler);
}

/** Put Mindwtr behind whatever was on screen before a system entry point
 *  (home-screen widget, Quick Settings tile, app shortcut, capture
 *  notification) opened it, so a capture ends where the user was (#1169).
 *  Android only: an iOS app cannot dismiss itself. Returns true when the app
 *  was sent to the back. */
export function returnToPreviousApp(): boolean {
  if (Platform.OS !== 'android') return false;
  BackHandler.exitApp();
  return true;
}
