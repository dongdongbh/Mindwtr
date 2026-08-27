import { requireNativeModule } from 'expo-modules-core';

export const SYNC_FILE_TRANSITION_CAS_UNAVAILABLE = 'SYNC_FILE_TRANSITION_CAS_UNAVAILABLE';

export type SyncFileTransitionRenameResult = { uri: string; name: string };

type SyncFileTransitionCasNativeModule = {
  renameDocumentAsync(uri: string, displayName: string): Promise<SyncFileTransitionRenameResult>;
};

let testModule: SyncFileTransitionCasNativeModule | null | undefined;
let resolvedModule: SyncFileTransitionCasNativeModule | null | undefined;

const getModule = (): SyncFileTransitionCasNativeModule | null => {
  if (testModule !== undefined) return testModule;
  if (resolvedModule !== undefined) return resolvedModule;
  try {
    resolvedModule = requireNativeModule<SyncFileTransitionCasNativeModule>('SyncFileTransitionCas');
  } catch {
    resolvedModule = null;
  }
  return resolvedModule;
};

export const renameSafTransitionDocument = async (
  uri: string,
  displayName: string,
): Promise<SyncFileTransitionRenameResult> => {
  const nativeModule = getModule();
  if (!nativeModule) {
    throw new Error(`${SYNC_FILE_TRANSITION_CAS_UNAVAILABLE}: atomic SAF rename is unavailable in this build`);
  }
  const result = await nativeModule.renameDocumentAsync(uri, displayName);
  if (!result || typeof result.uri !== 'string' || typeof result.name !== 'string' || result.name !== displayName) {
    throw new Error(`${SYNC_FILE_TRANSITION_CAS_UNAVAILABLE}: the document provider changed the requested transition name`);
  }
  return result;
};

export const setSyncFileTransitionCasNativeModuleForTests = (
  nativeModule: SyncFileTransitionCasNativeModule | null | undefined,
): void => {
  testModule = nativeModule;
  resolvedModule = undefined;
};
