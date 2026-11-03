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


export async function claimPendingCompletions(): Promise<IosWidgetPendingCompletion[]> {
  const claim = requireLinkedMethod('claimPendingCompletions');
  if (!claim) return [];
  return claim();
}


export async function acknowledgePendingCompletion(id: string): Promise<void> {
  const acknowledge = requireLinkedMethod('acknowledgePendingCompletion');
  if (!acknowledge) return;
  await acknowledge(id);
}


export async function getNextPendingCompletionAt(): Promise<number | null> {
  const getNext = requireLinkedMethod('getNextPendingCompletionAt');
  if (!getNext) return null;
  return getNext();
}
