import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type AndroidFoldingFeature = {
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  orientation: 'vertical' | 'horizontal';
  state: 'flat' | 'half-opened';
  isSeparating: boolean;
  occlusionType: 'none' | 'full';
};

export type AndroidWindowLayoutSnapshot = {
  width: number;
  height: number;
  features: AndroidFoldingFeature[];
};

export type AndroidActivitySession = {
  activityId: number;
  isChangingConfigurations: boolean;
};

type AndroidWindowLayoutNativeModule = {
  getLayout(): AndroidWindowLayoutSnapshot | null;
  getActivitySession(): AndroidActivitySession | null;
  getActivitySessionForId?(activityId: number): AndroidActivitySession | null;
  addListener(
    eventName: 'onLayoutChanged',
    listener: (snapshot: AndroidWindowLayoutSnapshot) => void,
  ): { remove(): void };
};

let cachedNativeModule: AndroidWindowLayoutNativeModule | null | undefined;

function getNativeModule(): AndroidWindowLayoutNativeModule | null {
  if (Platform.OS !== 'android') return null;
  if (cachedNativeModule !== undefined) return cachedNativeModule;

  try {
    cachedNativeModule = requireOptionalNativeModule<AndroidWindowLayoutNativeModule>(
      'AndroidWindowLayout',
    ) ?? null;
  } catch {
    cachedNativeModule = null;
  }
  return cachedNativeModule;
}

export function getAndroidWindowLayout(): AndroidWindowLayoutSnapshot | null {
  try {
    return getNativeModule()?.getLayout() ?? null;
  } catch {
    return null;
  }
}

export function getAndroidActivitySession(activityId?: number): AndroidActivitySession | null {
  try {
    const nativeModule = getNativeModule();
    if (!nativeModule) return null;
    if (activityId === undefined) return nativeModule.getActivitySession() ?? null;
    if (nativeModule.getActivitySessionForId) {
      return nativeModule.getActivitySessionForId(activityId) ?? null;
    }

    const current = nativeModule.getActivitySession();
    return current?.activityId === activityId ? current : null;
  } catch {
    return null;
  }
}

export function subscribeAndroidWindowLayout(
  listener: (snapshot: AndroidWindowLayoutSnapshot) => void,
): () => void {
  try {
    const subscription = getNativeModule()?.addListener('onLayoutChanged', listener);
    return () => {
      try {
        subscription?.remove();
      } catch {
        // The capability is optional, including during native teardown.
      }
    };
  } catch {
    return () => undefined;
  }
}
