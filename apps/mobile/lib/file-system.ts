import {
  Directory as ModernDirectory,
  File as ModernFile,
  Paths as ModernPaths,
  type InfoOptions,
} from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';

export const Directory = ModernDirectory;
export const File = ModernFile;
export const Paths = ModernPaths;

export const EncodingType = {
  UTF8: 'utf8',
  Base64: 'base64',
} as const;

type EncodingValue = (typeof EncodingType)[keyof typeof EncodingType];
type ReadOptions = { encoding?: EncodingValue };
type WriteOptions = { encoding?: EncodingValue };
type MakeDirectoryOptions = { intermediates?: boolean };
type DeleteOptions = { idempotent?: boolean };
type RelocatingOptions = { from: string; to: string };
type FileInfoLike = {
  creationTime?: number;
  exists: boolean;
  md5?: string;
  modificationTime?: number;
  size?: number;
  uri?: string;
};

const resolvePathUri = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'uri' in value) {
    const uri = (value as { uri?: unknown }).uri;
    return typeof uri === 'string' ? uri : null;
  }
  return null;
};

const resolveDirectoryUri = (primary: unknown, fallback: string | null | undefined): string | null => {
  const primaryUri = resolvePathUri(primary);
  if (primaryUri && primaryUri.includes('://')) {
    return primaryUri;
  }
  const fallbackUri = resolvePathUri(fallback);
  return fallbackUri ?? primaryUri ?? null;
};

const canUseModernApi = (): boolean =>
  typeof ModernDirectory === 'function' &&
  typeof ModernFile === 'function' &&
  typeof ModernPaths.info === 'function';

const ensureFileParentDirectory = (uri: string): void => {
  const file = new ModernFile(uri);
  try {
    file.parentDirectory.create({ intermediates: true, idempotent: true });
  } catch {
    // Ignore parent creation failures here and let the write/copy operation report a real error.
  }
};

const toLegacyInfo = (uri: string, options?: InfoOptions): FileInfoLike => {
  const pathInfo = ModernPaths.info(uri);
  if (!pathInfo.exists) {
    return { exists: false, uri };
  }
  if (pathInfo.isDirectory) {
    const info = new ModernDirectory(uri).info();
    return {
      exists: info.exists,
      uri: info.uri ?? uri,
      size: info.size ?? undefined,
      modificationTime: info.modificationTime ?? undefined,
      creationTime: info.creationTime ?? undefined,
    };
  }
  const info = new ModernFile(uri).info(options);
  return {
    exists: info.exists,
    uri: info.uri ?? uri,
    size: info.size ?? undefined,
    modificationTime: info.modificationTime ?? undefined,
    creationTime: info.creationTime ?? undefined,
    md5: info.md5 ?? undefined,
  };
};

const withLegacyFallback = async <T>(
  modern: (() => T | Promise<T>) | null,
  legacy: (() => Promise<T>) | null
): Promise<T> => {
  if (modern) {
    try {
      return await modern();
    } catch (error) {
      if (!legacy) throw error;
    }
  }
  if (!legacy) {
    throw new Error('File system operation is unavailable.');
  }
  return await legacy();
};

export const documentDirectory = resolveDirectoryUri(
  (ModernPaths as { document?: unknown }).document,
  LegacyFileSystem.documentDirectory ?? null
);
export const cacheDirectory = resolveDirectoryUri(
  (ModernPaths as { cache?: unknown }).cache,
  LegacyFileSystem.cacheDirectory ?? null
);

export const getInfoAsync = async (uri: string, options: InfoOptions = {}): Promise<FileInfoLike> =>
  withLegacyFallback(
    canUseModernApi() ? () => toLegacyInfo(uri, options) : null,
    LegacyFileSystem.getInfoAsync ? () => LegacyFileSystem.getInfoAsync(uri, options) : null
  );

export const makeDirectoryAsync = async (uri: string, options: MakeDirectoryOptions = {}) =>
  withLegacyFallback(
    canUseModernApi()
      ? () => {
          new ModernDirectory(uri).create({ intermediates: Boolean(options.intermediates) });
        }
      : null,
    LegacyFileSystem.makeDirectoryAsync ? () => LegacyFileSystem.makeDirectoryAsync(uri, options) : null
  );

export const readDirectoryAsync = async (uri: string): Promise<string[]> =>
  withLegacyFallback(
    canUseModernApi()
      ? () => new ModernDirectory(uri).list().map((entry) => entry.name)
      : null,
    LegacyFileSystem.readDirectoryAsync ? () => LegacyFileSystem.readDirectoryAsync(uri) : null
  );

export const readAsStringAsync = async (uri: string, options: ReadOptions = {}): Promise<string> =>
  withLegacyFallback(
    canUseModernApi()
      ? async () => {
          const file = new ModernFile(uri);
          return options.encoding === EncodingType.Base64 ? await file.base64() : await file.text();
        }
      : null,
    LegacyFileSystem.readAsStringAsync ? () => LegacyFileSystem.readAsStringAsync(uri, options) : null
  );

export const writeAsStringAsync = async (uri: string, contents: string, options: WriteOptions = {}): Promise<void> =>
  withLegacyFallback(
    canUseModernApi()
      ? () => {
          const file = new ModernFile(uri);
          ensureFileParentDirectory(uri);
          if (!file.exists) {
            file.create({ intermediates: true, overwrite: true });
          }
          file.write(contents, { encoding: options.encoding ?? EncodingType.UTF8 });
        }
      : null,
    LegacyFileSystem.writeAsStringAsync ? () => LegacyFileSystem.writeAsStringAsync(uri, contents, options) : null
  );

export const deleteAsync = async (uri: string, options: DeleteOptions = {}): Promise<void> =>
  withLegacyFallback(
    canUseModernApi()
      ? () => {
          const pathInfo = ModernPaths.info(uri);
          if (!pathInfo.exists) {
            if (options.idempotent) return;
            throw new Error(`File or directory does not exist: ${uri}`);
          }
          if (pathInfo.isDirectory) {
            new ModernDirectory(uri).delete();
            return;
          }
          new ModernFile(uri).delete();
        }
      : null,
    LegacyFileSystem.deleteAsync ? () => LegacyFileSystem.deleteAsync(uri, options) : null
  );

export const copyAsync = async ({ from, to }: RelocatingOptions): Promise<void> =>
  withLegacyFallback(
    canUseModernApi()
      ? () => {
          const sourceInfo = ModernPaths.info(from);
          if (sourceInfo.isDirectory) {
            new ModernDirectory(from).copy(new ModernDirectory(to));
            return;
          }
          ensureFileParentDirectory(to);
          new ModernFile(from).copy(new ModernFile(to));
        }
      : null,
    LegacyFileSystem.copyAsync ? () => LegacyFileSystem.copyAsync({ from, to }) : null
  );

export const moveAsync = async ({ from, to }: RelocatingOptions): Promise<void> =>
  withLegacyFallback(
    canUseModernApi()
      ? () => {
          const sourceInfo = ModernPaths.info(from);
          if (sourceInfo.isDirectory) {
            new ModernDirectory(from).move(new ModernDirectory(to));
            return;
          }
          ensureFileParentDirectory(to);
          new ModernFile(from).move(new ModernFile(to));
        }
      : null,
    LegacyFileSystem.moveAsync ? () => LegacyFileSystem.moveAsync({ from, to }) : null
  );

export const StorageAccessFramework = {
  requestDirectoryPermissionsAsync: async (initialUri?: string): Promise<{ directoryUri?: string; granted: boolean }> => {
    if (typeof ModernDirectory.pickDirectoryAsync === 'function') {
      try {
        const directory = await ModernDirectory.pickDirectoryAsync(initialUri);
        return { granted: true, directoryUri: directory.uri };
      } catch {
        return { granted: false };
      }
    }
    if (LegacyFileSystem.StorageAccessFramework?.requestDirectoryPermissionsAsync) {
      return await LegacyFileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(initialUri);
    }
    return { granted: false };
  },
  readDirectoryAsync: async (directoryUri: string): Promise<string[]> =>
    withLegacyFallback(
      canUseModernApi()
        ? () => new ModernDirectory(directoryUri).list().map((entry) => entry.uri)
        : null,
      LegacyFileSystem.StorageAccessFramework?.readDirectoryAsync
        ? () => LegacyFileSystem.StorageAccessFramework.readDirectoryAsync(directoryUri)
        : null
    ),
  makeDirectoryAsync: async (parentUri: string, name: string): Promise<string> =>
    withLegacyFallback(
      canUseModernApi() ? () => new ModernDirectory(parentUri).createDirectory(name).uri : null,
      LegacyFileSystem.StorageAccessFramework?.makeDirectoryAsync
        ? () => LegacyFileSystem.StorageAccessFramework.makeDirectoryAsync(parentUri, name)
        : null
    ),
  createFileAsync: async (parentUri: string, name: string, mimeType: string): Promise<string> =>
    withLegacyFallback(
      canUseModernApi() ? () => new ModernDirectory(parentUri).createFile(name, mimeType).uri : null,
      LegacyFileSystem.StorageAccessFramework?.createFileAsync
        ? () => LegacyFileSystem.StorageAccessFramework.createFileAsync(parentUri, name, mimeType)
        : null
    ),
  readAsStringAsync,
  writeAsStringAsync,
  deleteAsync,
};
