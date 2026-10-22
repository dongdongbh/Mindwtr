// In-memory hosts for the mobile attachment modules' tests: a file system with the React
// Native layout (`<files>/attachments/`), a key-value store and a log that records its lines.
import type { MobileAttachmentFileSystemPort, MobileAttachmentSafPort } from '../mobile-attachment-files';
import type { SyncKeyValueStoragePort } from '../sync-storage-keys';

export const DOCUMENTS = 'file:///data/files/';
export const CACHE = 'file:///data/cache/';
export const MANAGED = `${DOCUMENTS}attachments/`;

type FileOp = Exclude<keyof MobileAttachmentFileSystemPort, 'documentDirectory' | 'cacheDirectory' | 'saf'>;

export const createMemoryFileSystem = (options: { saf?: MobileAttachmentSafPort; sha256?: (bytes: Uint8Array) => Promise<string> } = {}) => {
  const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  const directories = new Set<string>();
  const calls: string[] = [];
  /** A fault makes the next matching call throw. */
  const faults: { op: FileOp; uri?: string; error: unknown }[] = [];
  let clock = 1_000_000;

  const enter = (op: FileOp, uri: string) => {
    calls.push(`${op} ${uri}`);
    const index = faults.findIndex((fault) => fault.op === op && (!fault.uri || fault.uri === uri));
    if (index >= 0) {
      const [fault] = faults.splice(index, 1);
      throw fault.error;
    }
  };
  const notFound = (uri: string) => Object.assign(new Error(`ENOENT: no such file or directory ${uri}`), { code: 'ENOENT' });
  const put = (uri: string, bytes: Uint8Array) => {
    clock += 1_000;
    files.set(uri, { bytes: bytes.slice(), mtimeMs: clock });
  };

  const fs: MobileAttachmentFileSystemPort = {
    documentDirectory: () => DOCUMENTS,
    cacheDirectory: () => CACHE,
    getInfo: async (uri) => {
      enter('getInfo', uri);
      const file = files.get(uri);
      if (file) return { exists: true, size: file.bytes.byteLength, modificationTime: file.mtimeMs / 1000 };
      return directories.has(uri) ? { exists: true, isDirectory: true } : { exists: false };
    },
    makeDirectory: async (uri) => {
      enter('makeDirectory', uri);
      directories.add(uri);
    },
    readDirectory: async (uri) => {
      enter('readDirectory', uri);
      // Files and subfolders directly in the folder, as expo's readDirectoryAsync lists them.
      const subfolders = [...directories].map((dir) => dir.replace(/\/$/, ''))
        .filter((dir) => dir.startsWith(uri) && dir.length > uri.length && !dir.slice(uri.length).includes('/'));
      return [...[...files.keys()].filter((key) => key.startsWith(uri) && !key.slice(uri.length).includes('/')), ...subfolders]
        .map((key) => key.slice(uri.length));
    },
    readBytes: async (uri) => {
      enter('readBytes', uri);
      const file = files.get(uri);
      if (!file) throw notFound(uri);
      return file.bytes.slice();
    },
    readBytesRange: async (uri, position, length) => {
      enter('readBytesRange', uri);
      const file = files.get(uri);
      if (!file) throw notFound(uri);
      return file.bytes.slice(position, position + length);
    },
    writeBytes: async (uri, bytes) => {
      enter('writeBytes', uri);
      put(uri, bytes);
    },
    copy: async (from, to) => {
      enter('copy', `${from} -> ${to}`);
      const file = files.get(from);
      if (!file) throw notFound(from);
      put(to, file.bytes);
    },
    move: async (from, to) => {
      enter('move', `${from} -> ${to}`);
      const file = files.get(from);
      if (!file) throw notFound(from);
      files.delete(from);
      put(to, file.bytes);
    },
    delete: async (uri) => {
      enter('delete', uri);
      files.delete(uri);
      directories.delete(uri);
    },
    saf: () => options.saf ?? null,
    ...(options.sha256 ? {
      sha256: async (uri: string) => {
        enter('sha256', uri);
        const file = files.get(uri);
        if (!file) throw notFound(uri);
        return options.sha256!(file.bytes);
      },
    } : {}),
  };

  return {
    fs,
    files,
    calls,
    put,
    read: (uri: string) => files.get(uri)?.bytes,
    fail: (op: FileOp, error: unknown, uri?: string) => { faults.push({ op, uri, error }); },
  };
};

export const createMemoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  const storage: SyncKeyValueStoragePort = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
  };
  return { storage, values };
};

export const createRecordingLog = () => {
  const lines: { level: 'info' | 'warn'; message: string; extra?: Record<string, string> }[] = [];
  return {
    lines,
    log: {
      info: (message: string, context?: { extra?: Record<string, string> }) => {
        lines.push({ level: 'info', message, extra: context?.extra });
      },
      warn: (message: string, context?: { extra?: Record<string, string> }) => {
        lines.push({ level: 'warn', message, extra: context?.extra });
      },
      sanitize: (message: string) => message,
    },
  };
};
