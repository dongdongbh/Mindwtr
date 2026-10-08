import { requireOptionalNativeModule, type NativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type WatchConnectivitySubscription = { remove(): void };

interface MindwtrWatchConnectivityNativeModule extends NativeModule {
  isWatchConnectivityAvailable?: () => boolean;
  activateWatchConnectivity?: () => Promise<void>;
  updateWatchApplicationContext?: (context: Record<string, unknown>) => Promise<void>;
  settleWatchChecklist?: (id: string, outcome: string) => Promise<void>;
  addListener(
    eventName: 'onPendingCapture',
    listener: () => void,
  ): WatchConnectivitySubscription;
}

const nativeModule = Platform.OS === 'ios'
  ? requireOptionalNativeModule<MindwtrWatchConnectivityNativeModule>('MindwtrWatchConnectivity')
  : null;

const noOpSubscription = (): WatchConnectivitySubscription => ({ remove: () => undefined });

export async function settleWatchChecklist(id: string, outcome: string): Promise<void> {
  if (!nativeModule?.settleWatchChecklist) throw new Error('Watch settlement unavailable');
  await nativeModule.settleWatchChecklist(id, outcome);
}

function withoutNullValues(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value
      .map(withoutNullValues)
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = withoutNullValues(item);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }
  return value;
}

/** True only for an enabled iOS build with the local native module linked. */
export function isWatchConnectivityAvailable(): boolean {
  if (Platform.OS !== 'ios' || !nativeModule) return false;
  try {
    return nativeModule.isWatchConnectivityAvailable?.() === true;
  } catch {
    return false;
  }
}

/** Activates the receiver. It is also activated natively at app launch. */
export async function activateWatchConnectivity(): Promise<void> {
  if (!isWatchConnectivityAvailable()) return;
  await nativeModule?.activateWatchConnectivity?.();
}

/** Sends the latest bounded Focus/Pomodoro snapshot to the companion Watch. */
export async function updateWatchApplicationContext(
  context: Record<string, unknown>,
): Promise<void> {
  if (!isWatchConnectivityAvailable()) return;
  const sanitized = withoutNullValues(context) as Record<string, unknown>;
  await nativeModule?.updateWatchApplicationContext?.(sanitized);
}

/** Wakes JS to drain pending-captures; the native event carries no task content. */
export function addPendingWatchCaptureListener(
  listener: () => void,
): WatchConnectivitySubscription {
  if (!isWatchConnectivityAvailable() || typeof nativeModule?.addListener !== 'function') {
    return noOpSubscription();
  }
  return nativeModule.addListener('onPendingCapture', () => listener());
}
