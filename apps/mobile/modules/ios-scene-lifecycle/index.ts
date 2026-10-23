import { requireOptionalNativeModule, type NativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type IosSceneDiagnosticStage =
  | 'sceneConnected'
  | 'rootStarted'
  | 'coldDelivery'
  | 'warmDelivery'
  | 'didBecomeActive'
  | 'willResignActive'
  | 'didEnterBackground'
  | 'willEnterForeground';

export type IosSceneDeliveryKind =
  | 'none'
  | 'url'
  | 'userActivity'
  | 'shortcut'
  | 'notification';

export interface IosSceneDiagnosticRecord {
  stage: IosSceneDiagnosticStage;
  deliveryKind: IosSceneDeliveryKind;
  count: number;
}

type IosSceneDiagnosticsSubscription = { remove(): void };

interface MindwtrIosSceneLifecycleNativeModule extends NativeModule {
  drainDiagnostics?: () => unknown;
  beginBackgroundTask?: (name: string) => unknown;
  endBackgroundTask?: (id: number) => void;
  addListener(
    eventName: 'onDiagnosticsChanged',
    listener: () => void,
  ): IosSceneDiagnosticsSubscription;
  addListener(
    eventName: 'onBackgroundTaskExpired',
    listener: (event: { id?: unknown } | undefined) => void,
  ): IosSceneDiagnosticsSubscription;
}

const allowedStages = new Set<IosSceneDiagnosticStage>([
  'sceneConnected',
  'rootStarted',
  'coldDelivery',
  'warmDelivery',
  'didBecomeActive',
  'willResignActive',
  'didEnterBackground',
  'willEnterForeground',
]);
const allowedDeliveryKinds = new Set<IosSceneDeliveryKind>([
  'none',
  'url',
  'userActivity',
  'shortcut',
  'notification',
]);

let cachedNativeModule: MindwtrIosSceneLifecycleNativeModule | null | undefined;

function getNativeModule(): MindwtrIosSceneLifecycleNativeModule | null {
  if (Platform.OS !== 'ios') return null;
  if (cachedNativeModule !== undefined) return cachedNativeModule;
  try {
    cachedNativeModule = requireOptionalNativeModule<MindwtrIosSceneLifecycleNativeModule>(
      'MindwtrIosSceneLifecycle',
    ) ?? null;
  } catch {
    cachedNativeModule = null;
  }
  return cachedNativeModule;
}

const validRecord = (value: unknown): value is IosSceneDiagnosticRecord => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<IosSceneDiagnosticRecord>;
  return allowedStages.has(record.stage as IosSceneDiagnosticStage)
    && allowedDeliveryKinds.has(record.deliveryKind as IosSceneDeliveryKind)
    && Number.isInteger(record.count)
    && Number(record.count) > 0
    && Number(record.count) <= 1_000_000;
};

/** Drains only fixed, privacy-safe fields from the bounded native queue. */
export function drainIosSceneDiagnostics(): IosSceneDiagnosticRecord[] {
  try {
    const raw = getNativeModule()?.drainDiagnostics?.();
    if (!Array.isArray(raw)) return [];
    return raw.filter(validRecord).slice(-32).map((record) => ({
      stage: record.stage,
      deliveryKind: record.deliveryKind,
      count: record.count,
    }));
  } catch {
    return [];
  }
}

/** A wake-up edge; records remain in the native queue until drained. */
export function subscribeIosSceneDiagnostics(
  listener: () => void,
): IosSceneDiagnosticsSubscription {
  try {
    const nativeModule = getNativeModule();
    if (!nativeModule || typeof nativeModule.addListener !== 'function') {
      return { remove: () => undefined };
    }
    return nativeModule.addListener('onDiagnosticsChanged', listener);
  } catch {
    return { remove: () => undefined };
  }
}

/**
 * Asks iOS to keep the app running in the background until the returned release is called
 * (#1432). Returns null off iOS, on an older build without the native function, or when iOS
 * grants no time. `onExpire` runs at most once, when iOS ends the time first; native has
 * already ended the task then, so a later release only cleans up.
 */
export function beginIosBackgroundTask(
  name: string,
  onExpire: () => void,
): (() => void) | null {
  const nativeModule = getNativeModule();
  if (!nativeModule?.beginBackgroundTask || !nativeModule.endBackgroundTask) return null;
  let id: unknown;
  try {
    id = nativeModule.beginBackgroundTask(name);
  } catch {
    return null;
  }
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
  const taskId = id;
  let subscription: IosSceneDiagnosticsSubscription | null = null;
  let finished = false;
  const finish = (): boolean => {
    if (finished) return false;
    finished = true;
    subscription?.remove();
    return true;
  };
  try {
    subscription = nativeModule.addListener('onBackgroundTaskExpired', (event) => {
      if (event?.id === taskId && finish()) onExpire();
    });
  } catch {
    // Without the event, iOS still ends the task itself when the time runs out.
  }
  return () => {
    if (!finish()) return;
    try {
      nativeModule.endBackgroundTask?.(taskId);
    } catch {
      // Native ignores an id it no longer holds; nothing else to release.
    }
  };
}
