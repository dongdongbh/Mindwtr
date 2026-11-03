import { beforeEach, describe, expect, it, vi } from 'vitest';


const fileSystemMock = vi.hoisted(() => ({
  directoryUris: new Set<string>(),
  fileUris: new Set<string>(),
  fileSizes: new Map<string, number>(),
}));

function normalizeMockUri(uri: string) {
  return uri.replace(/\/+$/u, '');
}

function hasDirectoryUri(uri: string) {
  return fileSystemMock.directoryUris.has(normalizeMockUri(uri));
}

function hasFileUri(uri: string) {
  return fileSystemMock.fileUris.has(normalizeMockUri(uri));
}

const appLogMock = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

const rnfsMock = vi.hoisted(() => ({
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  readFile: vi.fn(),
  exists: vi.fn(),
  unlink: vi.fn(async (path: string) => {
    fileSystemMock.fileUris.delete(normalizeMockUri(path));
  }),
  stat: vi.fn(async () => {
    throw new Error('not found');
  }),
  downloadFile: vi.fn(),
  hash: vi.fn(async () => 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'),
}));

const reactNativeMock = vi.hoisted(() => ({
  NativeModules: { RNFSManager: {} as Record<string, unknown> | null },
}));

vi.mock('react-native', () => reactNativeMock);
vi.mock('react-native-fs', () => ({ ...rnfsMock, default: rnfsMock }));

vi.mock('expo-file-system', () => ({
  Directory: class MockDirectory {
    uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists() {
      return hasDirectoryUri(this.uri);
    }

    create() {
      if (hasFileUri(this.uri)) {
        throw new Error('Unable to create file or directory: same name already exists');
      }
      fileSystemMock.directoryUris.add(normalizeMockUri(this.uri));
    }

    list() {
      return [] as unknown[];
    }
  },
  File: class MockFile {
    uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists() {
      return hasFileUri(this.uri);
    }

    get size() {
      return fileSystemMock.fileSizes.get(normalizeMockUri(this.uri)) ?? 0;
    }

    delete() {
      fileSystemMock.fileUris.delete(normalizeMockUri(this.uri));
    }

    copy(destination: { uri: string }) {
      fileSystemMock.fileUris.add(normalizeMockUri(destination.uri));
      const size = fileSystemMock.fileSizes.get(normalizeMockUri(this.uri));
      if (typeof size === 'number') fileSystemMock.fileSizes.set(normalizeMockUri(destination.uri), size);
    }

    static async downloadFileAsync(): Promise<never> {
      throw new Error('Expo buffered download should not run when native streaming is available');
    }
  },
  Paths: {
    cache: { uri: 'file:///cache/' },
    document: { uri: 'file:///document/' },
    basename: (uri: string) => uri.split('/').pop() ?? '',
    info: vi.fn((uri: string) => ({
      exists: hasDirectoryUri(uri) || hasFileUri(uri),
      isDirectory: hasDirectoryUri(uri),
      size: fileSystemMock.fileSizes.get(normalizeMockUri(uri)),
    })),
  },
}));

vi.mock('./app-log', () => appLogMock);

import { download, ensure, ensureLocation, getPreferredModelUri, locate, locateSync, remove } from './whisper-model-store';

const TINY_ID = 'whisper-tiny';
const TINY_SIZE = 77691713;

const DOC_PREFERRED = 'file:///document/whisper-models/ggml-tiny.bin';
const CACHE_LEGACY = 'file:///cache/ggml-tiny.bin';

describe('whisper-model-store', () => {
  beforeEach(() => {
    fileSystemMock.directoryUris = new Set(['file:///document', 'file:///cache']);
    fileSystemMock.fileUris = new Set();
    fileSystemMock.fileSizes.clear();
    reactNativeMock.NativeModules.RNFSManager = {};
    vi.clearAllMocks();


    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in tests'); }));
  });

  describe('locate', () => {
    it('finds the model when it is present in the preferred directory', async () => {
      fileSystemMock.fileUris.add(normalizeMockUri(DOC_PREFERRED));
      fileSystemMock.fileSizes.set(normalizeMockUri(DOC_PREFERRED), TINY_SIZE);

      await expect(locate(TINY_ID)).resolves.toMatchObject({
        uri: DOC_PREFERRED,
        exists: true,
        size: TINY_SIZE,
      });
    });

    it('reports the model as absent when it is nowhere in the candidate ladder', async () => {


      await expect(locate(TINY_ID)).resolves.toMatchObject({
        exists: false,
        size: 0,
      });
    });

    it('finds the model in a legacy candidate path (cache root, pre-whisper-models layout)', async () => {
      fileSystemMock.fileUris.add(normalizeMockUri(CACHE_LEGACY));
      fileSystemMock.fileSizes.set(normalizeMockUri(CACHE_LEGACY), TINY_SIZE);

      await expect(locate(TINY_ID)).resolves.toMatchObject({
        uri: CACHE_LEGACY,
        exists: true,
        size: TINY_SIZE,
      });
    });

    it('finds a stored path even when it does not match the catalogue filename layout', async () => {
      const storedPath = 'file:///document/custom-name.bin';
      fileSystemMock.fileUris.add(normalizeMockUri(storedPath));
      fileSystemMock.fileSizes.set(normalizeMockUri(storedPath), TINY_SIZE);

      await expect(locate(TINY_ID, storedPath)).resolves.toMatchObject({
        uri: storedPath,
        exists: true,
        size: TINY_SIZE,
      });
    });
  });

  describe('locateSync', () => {
    it('is the zero-await fast path a render body can call: same result as locate() when found via Expo metadata', () => {
      fileSystemMock.fileUris.add(normalizeMockUri(DOC_PREFERRED));
      fileSystemMock.fileSizes.set(normalizeMockUri(DOC_PREFERRED), TINY_SIZE);

      expect(locateSync(TINY_ID)).toMatchObject({ uri: DOC_PREFERRED, exists: true, size: TINY_SIZE });
    });

    it('reports absent (never a native RNFS pass) when the file is nowhere in Expo metadata', () => {
      expect(locateSync(TINY_ID)).toMatchObject({ exists: false, size: 0 });
    });
  });

  describe('getPreferredModelUri', () => {
    it('builds the canonical Documents/whisper-models path with zero I/O', () => {
      expect(getPreferredModelUri(TINY_ID)).toBe(DOC_PREFERRED);
    });

    it('returns undefined for an unknown model id', () => {
      expect(getPreferredModelUri('not-a-model')).toBeUndefined();
    });
  });

  describe('ensure / ensureLocation', () => {
    it('copies a model found in a legacy/cache location into the preferred directory', async () => {
      fileSystemMock.fileUris.add(normalizeMockUri(CACHE_LEGACY));
      fileSystemMock.fileSizes.set(normalizeMockUri(CACHE_LEGACY), TINY_SIZE);

      const resolved = await ensureLocation(TINY_ID);

      expect(resolved).toMatchObject({ uri: DOC_PREFERRED, exists: true, size: TINY_SIZE });

      expect(fileSystemMock.fileUris.has(normalizeMockUri(DOC_PREFERRED))).toBe(true);
    });

    it('ensure() returns the resolved native path, not the file:// uri', async () => {
      fileSystemMock.fileUris.add(normalizeMockUri(DOC_PREFERRED));
      fileSystemMock.fileSizes.set(normalizeMockUri(DOC_PREFERRED), TINY_SIZE);

      await expect(ensure(TINY_ID)).resolves.toBe('/document/whisper-models/ggml-tiny.bin');
    });

    it('creates the preferred directory and reports the canonical path even when the model is not found anywhere', async () => {
      await expect(ensureLocation(TINY_ID)).resolves.toMatchObject({ uri: DOC_PREFERRED, exists: false, size: 0 });
      expect(fileSystemMock.directoryUris.has('file:///document/whisper-models')).toBe(true);
    });
  });

  describe('download', () => {
    it('streams the model via native fs into the preferred directory and verifies its hash', async () => {
      rnfsMock.downloadFile.mockImplementation((options: { toFile: string }) => {
        fileSystemMock.fileUris.add(normalizeMockUri(`file://${options.toFile}`));
        fileSystemMock.fileSizes.set(normalizeMockUri(`file://${options.toFile}`), TINY_SIZE);
        return { promise: Promise.resolve({ statusCode: 200, bytesWritten: TINY_SIZE }) };
      });

      const uri = await download(TINY_ID);

      expect(uri).toBe(DOC_PREFERRED);
      expect(rnfsMock.hash).toHaveBeenCalled();
    });

    it('falls back to the mirror host when the first host cannot be reached', async () => {
      const urls: string[] = [];
      rnfsMock.downloadFile.mockImplementation((options: { fromUrl: string; toFile: string }) => {
        urls.push(options.fromUrl);
        if (options.fromUrl.includes('huggingface.co')) {
          return { promise: Promise.reject(new Error('Unable to resolve host "huggingface.co"')) };
        }
        fileSystemMock.fileUris.add(normalizeMockUri(`file://${options.toFile}`));
        fileSystemMock.fileSizes.set(normalizeMockUri(`file://${options.toFile}`), TINY_SIZE);
        return { promise: Promise.resolve({ statusCode: 200, bytesWritten: TINY_SIZE }) };
      });

      await expect(download(TINY_ID)).resolves.toBe(DOC_PREFERRED);
      expect(urls.map((url) => new URL(url).host)).toEqual(['huggingface.co', 'hf-mirror.com']);
      expect(rnfsMock.hash).toHaveBeenCalled();
    });

    it('reports the first host\'s error when every host fails', async () => {
      rnfsMock.downloadFile.mockImplementation((options: { fromUrl: string }) => ({
        promise: Promise.reject(new Error(`unreachable ${new URL(options.fromUrl).host}`)),
      }));

      await expect(download(TINY_ID)).rejects.toThrow('unreachable huggingface.co');
    });

    it('rejects a model whose hash does not match the pinned digest and cleans it up', async () => {

      for (let attempt = 0; attempt < 4; attempt += 1) rnfsMock.hash.mockResolvedValueOnce('0'.repeat(64));
      rnfsMock.downloadFile.mockImplementation((options: { toFile: string }) => {
        fileSystemMock.fileUris.add(normalizeMockUri(`file://${options.toFile}`));
        fileSystemMock.fileSizes.set(normalizeMockUri(`file://${options.toFile}`), TINY_SIZE);
        return { promise: Promise.resolve({ statusCode: 200, bytesWritten: TINY_SIZE }) };
      });

      await expect(download(TINY_ID)).rejects.toThrow('SHA-256 mismatch');
      expect(fileSystemMock.fileUris.has(normalizeMockUri(DOC_PREFERRED))).toBe(false);
    });
  });

  describe('remove', () => {
    it('deletes the model from whichever canonical directory it is actually in', async () => {
      fileSystemMock.fileUris.add(normalizeMockUri(DOC_PREFERRED));
      fileSystemMock.fileSizes.set(normalizeMockUri(DOC_PREFERRED), TINY_SIZE);

      await remove(TINY_ID);

      expect(fileSystemMock.fileUris.has(normalizeMockUri(DOC_PREFERRED))).toBe(false);
    });

    it('is a no-op when the model is not present in any canonical directory', async () => {
      await expect(remove(TINY_ID)).resolves.toBeUndefined();
    });

    it('never deletes a legacy root path — only the canonical whisper-models subdirectory', async () => {
      fileSystemMock.fileUris.add(normalizeMockUri(CACHE_LEGACY));
      fileSystemMock.fileSizes.set(normalizeMockUri(CACHE_LEGACY), TINY_SIZE);

      await remove(TINY_ID);


      expect(fileSystemMock.fileUris.has(normalizeMockUri(CACHE_LEGACY))).toBe(true);
    });
  });
});
