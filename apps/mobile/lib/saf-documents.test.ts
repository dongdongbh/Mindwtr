import { afterEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('./app-log', () => log);
vi.mock('expo-modules-core', () => ({
  requireNativeModule: vi.fn(() => { throw new Error('native module unavailable'); }),
}));

import { listSafChildren, setSafDocumentsNativeModuleForTests, statSafDocument } from './saf-documents';

afterEach(() => {
  setSafDocumentsNativeModuleForTests(undefined);
  vi.clearAllMocks();
});

describe('saf-documents', () => {
  it('fails closed when the native SAF document calls are missing', async () => {
    await expect(listSafChildren('content://p/tree/t')).rejects.toThrow('SAF_DOCUMENTS_UNAVAILABLE');
    setSafDocumentsNativeModuleForTests(null);
    await expect(statSafDocument('content://p/tree/t/document/x')).rejects.toThrow('SAF_DOCUMENTS_UNAVAILABLE');
  });

  it('passes a provider error through and logs the refusal', async () => {
    setSafDocumentsNativeModuleForTests({
      listChildrenAsync: vi.fn(async () => { throw new Error('SAF_DOCUMENT_UNAVAILABLE: no listing'); }),
      statAsync: vi.fn(async () => null),
      readAsync: vi.fn(async () => ({ base64: '', lengthVerified: true })),
      writeAsync: vi.fn(async () => undefined),
    });
    await expect(listSafChildren('content://p/tree/t')).rejects.toThrow('SAF_DOCUMENT_UNAVAILABLE');
    expect(log.logWarn).toHaveBeenCalledWith('File Sync provider error kept the folder unread', {
      scope: 'sync', extra: { releaseCheck: 'v1.3.7/file-sync-saf-safety', check: 'listing', outcome: 'refused' },
    });
    await expect(statSafDocument('content://p/tree/t/document/x')).resolves.toBeNull();
  });
});
