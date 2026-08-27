import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({
  requireNativeModule: vi.fn(() => { throw new Error('native module unavailable'); }),
}));

import {
  renameSafTransitionDocument,
  setSyncFileTransitionCasNativeModuleForTests,
  SYNC_FILE_TRANSITION_CAS_UNAVAILABLE,
} from './sync-file-transition-cas';

afterEach(() => {
  setSyncFileTransitionCasNativeModuleForTests(undefined);
});

describe('sync-file-transition-cas', () => {
  it('fails closed when the transition-specific native capability is unavailable', async () => {
    setSyncFileTransitionCasNativeModuleForTests(null);
    await expect(renameSafTransitionDocument('content://provider/document/data', 'data.json.quarantine'))
      .rejects.toThrow(SYNC_FILE_TRANSITION_CAS_UNAVAILABLE);
  });

  it('returns only a provider-verified exact rename', async () => {
    setSyncFileTransitionCasNativeModuleForTests({
      renameDocumentAsync: vi.fn(async () => ({
        uri: 'content://provider/document/quarantine',
        name: 'data.json.quarantine',
      })),
    });
    await expect(renameSafTransitionDocument(
      'content://provider/document/data',
      'data.json.quarantine',
    )).resolves.toEqual({
      uri: 'content://provider/document/quarantine',
      name: 'data.json.quarantine',
    });
  });

  it('rejects a provider that silently changes the requested name', async () => {
    setSyncFileTransitionCasNativeModuleForTests({
      renameDocumentAsync: vi.fn(async () => ({
        uri: 'content://provider/document/quarantine-1',
        name: 'data (1).json',
      })),
    });
    await expect(renameSafTransitionDocument(
      'content://provider/document/data',
      'data.json.quarantine',
    )).rejects.toThrow(SYNC_FILE_TRANSITION_CAS_UNAVAILABLE);
  });
});
