import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type AndroidWidgetModule = {
  setPayload(json: string): void;
  updateWidgets(): void;
  getWidgetListSelections(): string[];
};

// Null in Expo Go and on every other platform; callers check isSupported().
const nativeModule = Platform.OS === 'android'
  ? requireOptionalNativeModule<AndroidWidgetModule>('MindwtrAndroidWidget')
  : null;

export function isSupported(): boolean {
  return nativeModule !== null;
}

/** Store the widget payload JSON natively; the widget provider draws from it. */
export function setPayload(json: string): void {
  nativeModule?.setPayload(json);
}

/** Redraw every placed home-screen widget from the stored payload. */
export function updateWidgets(): void {
  nativeModule?.updateWidgets();
}

/** Distinct list ids the placed Tasks widgets are configured to show. */
export function getWidgetListSelections(): string[] {
  return nativeModule?.getWidgetListSelections() ?? [];
}
