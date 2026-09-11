import { requireOptionalNativeModule, type NativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export interface IosWidgetPendingCompletion {
  id: string;
  taskId: string;
  token: string;
  createdAt: number;
  notBefore: number;
  claimed: boolean;
}

interface MindwtrIosWidgetNativeModule extends NativeModule {
  claimPendingCompletions?: () => Promise<IosWidgetPendingCompletion[]>;
  acknowledgePendingCompletion?: (id: string) => Promise<void>;
  getNextPendingCompletionAt?: () => Promise<number | null>;
}

const nativeModule = Platform.OS === 'ios'
  ? requireOptionalNativeModule<MindwtrIosWidgetNativeModule>('MindwtrIosWidget')
  : null;

function requireLinkedMethod<K extends keyof MindwtrIosWidgetNativeModule>(
  name: K,
): NonNullable<MindwtrIosWidgetNativeModule[K]> | null {
  if (Platform.OS !== 'ios' || !nativeModule) return null;
  const method = nativeModule[name];
  if (typeof method !== 'function') {
    throw new Error(`MindwtrIosWidget native method ${String(name)} is unavailable`);
  }
  return method.bind(nativeModule) as NonNullable<MindwtrIosWidgetNativeModule[K]>;
}

/**
 * Claims every completion that is ready, plus any previously claimed completion
 * that still awaits durable acknowledgement from the normal task store.
 */
export async function claimPendingCompletions(): Promise<IosWidgetPendingCompletion[]> {
  const claim = requireLinkedMethod('claimPendingCompletions');
  if (!claim) return [];
  return claim();
}

/** Acknowledges a completion only after the task update and pending save flush. */
export async function acknowledgePendingCompletion(id: string): Promise<void> {
  const acknowledge = requireLinkedMethod('acknowledgePendingCompletion');
  if (!acknowledge) return;
  await acknowledge(id);
}

/** Returns the next unclaimed action time, in milliseconds since the Unix epoch. */
export async function getNextPendingCompletionAt(): Promise<number | null> {
  const getNext = requireLinkedMethod('getNextPendingCompletionAt');
  if (!getNext) return null;
  return getNext();
}
