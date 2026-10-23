import { fileSyncErrorCode } from '@mindwtr/core';
import { requireNativeModule, type NativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { logWarn } from './app-log';

export interface ResolvedSyncPathBookmark {
  uri: string;
  refreshedBookmark: string | null;
}

interface SyncPathBookmarksModule extends NativeModule {
  createBookmark(fileUri: string): Promise<string | null>;
  resolveBookmark(bookmarkBase64: string): Promise<{ uri?: string | null; refreshedBookmark?: string | null } | null>;
  readTextFile?(bookmarkBase64: string): Promise<string | null>;
  writeTextFile?(bookmarkBase64: string, content: string): Promise<void>;
}

let SyncPathBookmarks: SyncPathBookmarksModule | null = null;

try {
  SyncPathBookmarks = requireNativeModule<SyncPathBookmarksModule>('SyncPathBookmarks');
} catch {
  SyncPathBookmarks = null;
}

const isIosFileUri = (value: string): boolean => (
  Platform.OS === 'ios' && value.startsWith('file://')
);

export const isSyncPathBookmarksAvailable = (): boolean => (
  Platform.OS === 'ios' && SyncPathBookmarks !== null
);

// OTA JS updates can run against an older native binary without the IO functions.
export const supportsBookmarkedSyncFileIO = (): boolean => (
  isSyncPathBookmarksAvailable()
  && typeof SyncPathBookmarks?.readTextFile === 'function'
  && typeof SyncPathBookmarks?.writeTextFile === 'function'
);

export async function createSyncPathBookmark(fileUri?: string | null): Promise<string | null> {
  const trimmedUri = typeof fileUri === 'string' ? fileUri.trim() : '';
  if (!SyncPathBookmarks || !isIosFileUri(trimmedUri)) return null;

  try {
    const bookmark = await SyncPathBookmarks.createBookmark(trimmedUri);
    const normalizedBookmark = typeof bookmark === 'string' ? bookmark.trim() : '';
    return normalizedBookmark || null;
  } catch (error) {
    void logWarn('Failed to create iOS sync-folder bookmark', {
      scope: 'sync',
      extra: { error: fileSyncErrorCode(error) },
    });
    return null;
  }
}

export async function resolveSyncPathBookmark(
  bookmarkBase64?: string | null
): Promise<ResolvedSyncPathBookmark | null> {
  const trimmedBookmark = typeof bookmarkBase64 === 'string' ? bookmarkBase64.trim() : '';
  if (!SyncPathBookmarks || Platform.OS !== 'ios' || !trimmedBookmark) return null;

  try {
    const resolved = await SyncPathBookmarks.resolveBookmark(trimmedBookmark);
    const normalizedUri = typeof resolved?.uri === 'string' ? resolved.uri.trim() : '';
    if (!normalizedUri) return null;
    const refreshedBookmark = typeof resolved?.refreshedBookmark === 'string'
      ? resolved.refreshedBookmark.trim() || null
      : null;
    return { uri: normalizedUri, refreshedBookmark };
  } catch (error) {
    void logWarn('Failed to resolve iOS sync-folder bookmark', {
      scope: 'sync',
      extra: { error: fileSyncErrorCode(error) },
    });
    return null;
  }
}

export async function readBookmarkedSyncFileText(bookmarkBase64: string): Promise<string | null> {
  if (!supportsBookmarkedSyncFileIO() || !SyncPathBookmarks?.readTextFile) {
    throw new Error('Bookmarked sync file access is unavailable on this build');
  }
  return await SyncPathBookmarks.readTextFile(bookmarkBase64);
}

export async function writeBookmarkedSyncFileText(bookmarkBase64: string, content: string): Promise<void> {
  if (!supportsBookmarkedSyncFileIO() || !SyncPathBookmarks?.writeTextFile) {
    throw new Error('Bookmarked sync file access is unavailable on this build');
  }
  await SyncPathBookmarks.writeTextFile(bookmarkBase64, content);
}
