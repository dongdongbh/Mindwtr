import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import type { AppSearchDoc } from '@/lib/app-search-projection';

type MindwtrAppSearchNativeModule = {
  isSupported(): boolean;
  upsertDocuments(docs: AppSearchDoc[]): Promise<void>;
  removeDocuments(ids: string[]): Promise<void>;
  wipeAll(): Promise<void>;
};

const nativeModule = Platform.OS === 'android'
  ? requireOptionalNativeModule<MindwtrAppSearchNativeModule>('MindwtrAppSearch')
  : null;


export function isMindwtrAppSearchNativeSupported(): boolean {
  if (Platform.OS !== 'android') return false;
  try {
    return nativeModule?.isSupported?.() === true;
  } catch {
    return false;
  }
}

export async function upsertAppSearchDocuments(docs: AppSearchDoc[]): Promise<void> {
  if (Platform.OS !== 'android' || docs.length === 0) return;
  await nativeModule?.upsertDocuments?.(docs);
}

export async function removeAppSearchDocuments(ids: string[]): Promise<void> {
  if (Platform.OS !== 'android' || ids.length === 0) return;
  await nativeModule?.removeDocuments?.(ids);
}

export async function wipeAppSearchIndexNative(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await nativeModule?.wipeAll?.();
}
