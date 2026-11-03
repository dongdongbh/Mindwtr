import { base64ToBytes, bytesToBase64 } from '@mindwtr/core';
import { requireNativeModule } from 'expo-modules-core';

import { logInfo, logWarn } from './app-log';


export const SAF_DOCUMENTS_UNAVAILABLE = 'SAF_DOCUMENTS_UNAVAILABLE';


export type SafDocumentEntry = {
  uri: string;
  name: string | null;
  mime: string | null;
  size: number | null;
  lastModified: number | null;
};


export type SafDocumentRead = { bytes: Uint8Array; lengthVerified: boolean };

type SafDocumentsNativeModule = {
  listChildrenAsync(uri: string): Promise<SafDocumentEntry[]>;
  statAsync(uri: string): Promise<SafDocumentEntry | null>;
  readAsync(uri: string): Promise<{ base64: string; lengthVerified: boolean }>;
  writeAsync(uri: string, base64: string): Promise<void>;
};

let testModule: SafDocumentsNativeModule | null | undefined;
let resolvedModule: SafDocumentsNativeModule | null | undefined;

const getModule = (): SafDocumentsNativeModule => {
  if (testModule !== undefined) {
    if (!testModule) throw new Error(`${SAF_DOCUMENTS_UNAVAILABLE}: SAF document calls are unavailable in this build`);
    return testModule;
  }
  if (resolvedModule === undefined) {
    try {
      resolvedModule = requireNativeModule<SafDocumentsNativeModule>('SyncFileTransitionCas');
    } catch {
      resolvedModule = null;
    }
  }
  if (!resolvedModule?.listChildrenAsync || !resolvedModule.statAsync || !resolvedModule.readAsync || !resolvedModule.writeAsync) {
    throw new Error(`${SAF_DOCUMENTS_UNAVAILABLE}: SAF document calls are unavailable in this build`);
  }
  return resolvedModule;
};

const RELEASE_CHECK = 'v1.3.7/file-sync-saf-safety';
let listedOnce = false;


const traced = async <T>(check: 'listing' | 'lookup' | 'read' | 'write', call: () => Promise<T>): Promise<T> => {
  try {
    const value = await call();
    if (check === 'listing' && !listedOnce) {
      listedOnce = true;
      void logInfo('File Sync folder listed through SafDocumentsCore', {
        scope: 'sync', extra: { releaseCheck: RELEASE_CHECK, check, outcome: 'listed' },
      });
    }
    return value;
  } catch (error) {
    void logWarn('File Sync provider error kept the folder unread', {
      scope: 'sync', extra: { releaseCheck: RELEASE_CHECK, check, outcome: 'refused' },
    });
    throw error;
  }
};


export const listSafChildren = async (dirUri: string): Promise<SafDocumentEntry[]> =>
  traced('listing', () => getModule().listChildrenAsync(dirUri));


export const statSafDocument = async (uri: string): Promise<SafDocumentEntry | null> =>
  traced('lookup', () => getModule().statAsync(uri));


export const readSafDocument = async (uri: string): Promise<SafDocumentRead> => traced('read', async () => {
  const read = await getModule().readAsync(uri);
  return { bytes: base64ToBytes(read.base64), lengthVerified: read.lengthVerified === true };
});


export const writeSafDocument = async (uri: string, bytes: Uint8Array): Promise<void> =>
  traced('write', () => getModule().writeAsync(uri, bytesToBase64(bytes)));

export const setSafDocumentsNativeModuleForTests = (
  nativeModule: SafDocumentsNativeModule | null | undefined,
): void => {
  testModule = nativeModule;
  resolvedModule = undefined;
};
