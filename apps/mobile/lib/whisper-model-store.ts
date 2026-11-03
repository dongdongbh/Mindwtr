


import { Directory, File, Paths } from 'expo-file-system';
import { NativeModules } from 'react-native';
import { WHISPER_MODEL_BASE_URLS, WHISPER_MODELS } from '@mindwtr/core/whisper-models';

import { logWarn } from './app-log';
import {
  downloadWhisperModelFile,
  isWhisperModelFileReady,
  isWhisperModelSafeDeleteTarget,
  resolveWhisperModelDownloadUrl,
  resolveWhisperNativeFsModule,
  resolveWhisperNativeHashModule,
  verifyWhisperModelFileHash,
} from '../components/settings/ai-settings-whisper-model';

export const WHISPER_MODEL_DIR_NAME = 'whisper-models';

export type WhisperModelLocation = { uri: string; path: string; exists: boolean; size: number };


export type WhisperDownloadError = Error & { retryOnWifi?: boolean };
type WhisperPathInfo = { exists: boolean; isDirectory: boolean; size: number };


type RNFSModule = typeof import('react-native-fs');
let rnfsModuleCache: RNFSModule | null | undefined;
let rnfsModuleRequireFailed = false;
let rnfsModuleImportFailed = false;

const isRNFSNativeModuleEvaluationError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('RNFSFileTypeRegular') || message.includes('RNFSManager');
};

const hasRNFSNativeModule = (): boolean => Boolean(
  (NativeModules as Record<string, unknown> | undefined)?.RNFSManager
);

const resolveRNFSModule = (value: unknown): RNFSModule | null => {
  const candidates = [
    value,
    value && typeof value === 'object' ? (value as { default?: unknown }).default : undefined,
  ];
  for (const candidate of candidates) {
    const mod = candidate as RNFSModule | undefined;
    const hasCoreFs = !!mod
      && typeof (mod as unknown as { writeFile?: unknown }).writeFile === 'function'
      && typeof (mod as unknown as { appendFile?: unknown }).appendFile === 'function'
      && typeof (mod as unknown as { readFile?: unknown }).readFile === 'function'
      && typeof (mod as unknown as { exists?: unknown }).exists === 'function'
      && typeof (mod as unknown as { unlink?: unknown }).unlink === 'function';
    if (hasCoreFs) return mod;
  }
  return null;
};

const getRNFSModule = (): RNFSModule | null => {
  if (rnfsModuleCache !== undefined) return rnfsModuleCache;
  if (!hasRNFSNativeModule()) {
    rnfsModuleRequireFailed = true;
    rnfsModuleImportFailed = true;
    rnfsModuleCache = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    rnfsModuleCache = resolveRNFSModule(require('react-native-fs'));
    return rnfsModuleCache;
  } catch (error) {
    rnfsModuleRequireFailed = isRNFSNativeModuleEvaluationError(error);
    rnfsModuleCache = null;
    return null;
  }
};


export const getRNFSModuleAsync = async (): Promise<RNFSModule | null> => {
  const loaded = getRNFSModule();
  if (loaded || rnfsModuleRequireFailed || rnfsModuleImportFailed) return loaded;
  try {
    const imported = await import('react-native-fs');
    rnfsModuleCache = resolveRNFSModule(imported);
    return rnfsModuleCache;
  } catch (error) {
    rnfsModuleImportFailed = true;
    rnfsModuleRequireFailed = rnfsModuleRequireFailed || isRNFSNativeModuleEvaluationError(error);
    rnfsModuleCache = null;
    return null;
  }
};


export const normalizeWhisperModelUri = (value: string): { path: string; uri: string } => {
  let rawPath = value;
  let uri = value;
  if (value.startsWith('file://')) {
    rawPath = value.slice('file://'.length);
  } else if (value.startsWith('file:/')) {
    rawPath = value.replace(/^file:\//u, '/');
    uri = `file://${rawPath}`;
  } else if (value.startsWith('/')) {
    uri = `file://${value}`;
  }
  let path = rawPath;
  try {
    path = decodeURI(rawPath);
  } catch {

  }
  return { path, uri };
};

const getPathInfoSize = (info: unknown): number => {
  if (!info || typeof info !== 'object') return 0;
  const size = (info as { size?: unknown }).size;
  return typeof size === 'number' ? size : 0;
};


export const probeModelPathSync = (uri?: string): WhisperPathInfo => {
  if (!uri) return { exists: false, isDirectory: false, size: 0 };
  let pathInfo: ReturnType<typeof Paths.info> | null = null;
  try {
    pathInfo = Paths.info(uri);
    if (pathInfo?.exists && pathInfo.isDirectory) {
      return { exists: true, isDirectory: true, size: getPathInfoSize(pathInfo) };
    }
  } catch {

  }


  try {
    const file = new File(uri);
    if (file.exists) {
      const pathInfoSize = pathInfo && 'size' in pathInfo && typeof pathInfo.size === 'number' ? pathInfo.size : undefined;
      const size = typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0
        ? file.size
        : (pathInfoSize ?? 0);
      return { exists: true, isDirectory: false, size };
    }
  } catch {

  }
  try {
    const dir = new Directory(uri);
    if (dir.exists) return { exists: true, isDirectory: true, size: 0 };
  } catch {

  }
  if (pathInfo?.exists) {
    return { exists: true, isDirectory: Boolean(pathInfo.isDirectory), size: getPathInfoSize(pathInfo) };
  }
  return { exists: false, isDirectory: false, size: 0 };
};


const probeDirectoryPathSync = (uri?: string): WhisperPathInfo => {
  if (!uri) return { exists: false, isDirectory: false, size: 0 };
  let pathInfo: ReturnType<typeof Paths.info> | null = null;
  try {
    pathInfo = Paths.info(uri);
    if (pathInfo?.exists && pathInfo.isDirectory) {
      return { exists: true, isDirectory: true, size: getPathInfoSize(pathInfo) };
    }
  } catch {

  }
  try {
    const dir = new Directory(uri);
    if (dir.exists) return { exists: true, isDirectory: true, size: 0 };
  } catch {

  }
  try {
    const file = new File(uri);
    if (file.exists) {
      return { exists: true, isDirectory: false, size: typeof file.size === 'number' ? file.size : 0 };
    }
  } catch {

  }
  if (pathInfo?.exists) {
    return { exists: true, isDirectory: Boolean(pathInfo.isDirectory), size: getPathInfoSize(pathInfo) };
  }
  return { exists: false, isDirectory: false, size: 0 };
};

type NativeStatLike = { size?: unknown; isFile?: () => boolean; isDirectory?: () => boolean };


export const probeModelPathNative = async (path: string): Promise<WhisperPathInfo> => {
  const rnfs = await getRNFSModuleAsync() as (RNFSModule & { stat?: (path: string) => Promise<NativeStatLike> }) | null;
  if (!rnfs || typeof rnfs.stat !== 'function') return { exists: false, isDirectory: false, size: 0 };
  try {
    const stat = await rnfs.stat(path);
    const isDirectory = typeof stat.isDirectory === 'function' ? stat.isDirectory() : false;
    const isFile = typeof stat.isFile === 'function' ? stat.isFile() : !isDirectory;
    const size = typeof stat.size === 'number' && Number.isFinite(stat.size) ? stat.size : 0;
    if (isFile || isDirectory) return { exists: true, isDirectory, size };
  } catch {

  }
  return { exists: false, isDirectory: false, size: 0 };
};

const unlinkNative = async (uri: string): Promise<boolean> => {
  const rnfs = await getRNFSModuleAsync() as (RNFSModule & { unlink?: (path: string) => Promise<void> }) | null;
  if (typeof rnfs?.unlink !== 'function') return false;
  await rnfs.unlink(normalizeWhisperModelUri(uri).path);
  return true;
};

const hashNative = async (uri: string): Promise<string> => {
  const rnfs = resolveWhisperNativeHashModule(await getRNFSModuleAsync());
  if (!rnfs) {
    throw new Error('Whisper model hashing is unavailable in this build. Use a dev build or production build.');
  }
  return rnfs.hash(normalizeWhisperModelUri(uri).path, 'sha256');
};


const getModel = (modelId: string | undefined) => (
  modelId ? WHISPER_MODELS.find((entry) => entry.id === modelId) : undefined
);

const buildWhisperModelDirectoryUri = (rootUri: string): string => {
  const normalized = rootUri.endsWith('/') ? rootUri : `${rootUri}/`;
  return `${normalized}${WHISPER_MODEL_DIR_NAME}`;
};

const buildModelFileUri = (rootUri: string, fileName: string): string => {
  const dirUri = buildWhisperModelDirectoryUri(rootUri);
  return `${dirUri.endsWith('/') ? dirUri : `${dirUri}/`}${fileName}`;
};


const getWhisperModelRoots = (): Directory[] => {
  const roots: Directory[] = [];
  try { roots.push(Paths.document); } catch {                                 }
  try { roots.push(Paths.cache); } catch {                                 }
  return roots;
};

const getWhisperModelDirectories = (): Directory[] => getWhisperModelRoots()
  .map((root) => new Directory(buildWhisperModelDirectoryUri(root.uri)));


const whisperDirectoryRoot = (uri: string): string => {
  const normalized = normalizeWhisperModelUri(uri).uri;
  const root = getWhisperModelRoots().find((candidate) => normalized.startsWith(normalizeWhisperModelUri(candidate.uri).uri));
  if (!root) return 'other';
  try { return root.uri === Paths.document.uri ? 'document' : 'cache'; } catch { return 'cache'; }
};

const isKnownWhisperModelDirectoryUri = (uri: string): boolean => {
  const normalized = normalizeWhisperModelUri(uri).uri.replace(/\/+$/u, '');
  return getWhisperModelDirectories()
    .some((dir) => normalizeWhisperModelUri(dir.uri).uri.replace(/\/+$/u, '') === normalized);
};


const repairDirectoryBlockingFile = async (uri: string, reason: string): Promise<boolean> => {
  const normalized = normalizeWhisperModelUri(uri).uri;
  if (!isKnownWhisperModelDirectoryUri(normalized)) {
    void logWarn('Refusing to repair unsafe Whisper model directory target', {
      scope: 'speech', force: true, extra: { root: whisperDirectoryRoot(normalized), reason },
    });
    return false;
  }
  const before = probeDirectoryPathSync(normalized);
  if (!before.exists || before.isDirectory) return false;
  let deleted = false;
  try {
    new File(normalized).delete();
    deleted = true;
  } catch (error) {
    void logWarn('Whisper model directory file cleanup failed', {
      scope: 'speech', force: true,
      extra: { root: whisperDirectoryRoot(normalized), reason, error: error instanceof Error ? error.message : String(error) },
    });
  }
  if (!deleted) {
    try {
      deleted = await unlinkNative(normalized);
    } catch (error) {
      void logWarn('Whisper model directory file cleanup with native fs failed', {
        scope: 'speech', force: true,
        extra: { root: whisperDirectoryRoot(normalized), reason, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  const after = probeDirectoryPathSync(normalized);
  return !after.exists || after.isDirectory;
};

const ensureDirectoryReady = async (directory: Directory): Promise<void> => {
  const createDirectory = () => directory.create({ intermediates: true, idempotent: true });
  const info = probeDirectoryPathSync(directory.uri);
  if (info.exists && !info.isDirectory) {
    await repairDirectoryBlockingFile(directory.uri, 'pre-create');
  }
  try {
    createDirectory();
  } catch (error) {
    const repaired = await repairDirectoryBlockingFile(directory.uri, 'create-failed');
    if (!repaired) throw error;
    createDirectory();
  }
  const afterInfo = probeDirectoryPathSync(directory.uri);
  const afterNativeInfo = afterInfo.isDirectory ? null : await probeModelPathNative(normalizeWhisperModelUri(directory.uri).path);
  if (!afterInfo.isDirectory && !afterNativeInfo?.isDirectory) {
    throw new Error(`Whisper model directory is blocked by a file: ${normalizeWhisperModelUri(directory.uri).uri.replace(/\/+$/u, '')}`);
  }
};


export const getPreferredModelUri = (modelId: string | undefined): string | undefined => {
  const fileName = getModel(modelId)?.fileName;
  if (!fileName) return undefined;
  let docUri: string | undefined;
  try { docUri = Paths.document?.uri; } catch { docUri = undefined; }
  return docUri ? buildModelFileUri(docUri, fileName) : undefined;
};

const buildCandidates = (modelId: string | undefined, storedPath?: string): string[] => {
  const candidates: string[] = [];
  if (storedPath) {
    const normalized = normalizeWhisperModelUri(storedPath);
    candidates.push(normalized.uri);
    if (normalized.uri !== storedPath) candidates.push(storedPath);
  }
  const fileName = getModel(modelId)?.fileName;
  if (fileName) {
    const appendCandidates = (base?: string | null) => {
      if (!base) return;
      const normalizedBase = base.endsWith('/') ? base : `${base}/`;
      candidates.push(buildModelFileUri(normalizedBase, fileName));
      candidates.push(`${normalizedBase}${fileName}`);
    };
    appendCandidates(Paths.document?.uri ?? null);
    appendCandidates(Paths.cache?.uri ?? null);
  }
  return candidates;
};

const listDirectorySample = (uri?: string): string => {
  if (!uri) return '';
  try {
    const dir = new Directory(uri);
    if (!dir.exists) return '';
    const entries = dir.list();
    if (!entries.length) return '';
    return entries
      .slice(0, 8)
      .map((entry) => {
        try { return Paths.basename(entry.uri) ?? ''; } catch { return ''; }
      })
      .filter(Boolean)
      .join(', ');
  } catch {
    return '';
  }
};


const buildMissingModelDiagnostics = (
  modelId: string | undefined,
  storedPath: string | undefined,
  resolved: WhisperModelLocation,
  candidates: string[]
): Record<string, string> => {
  const docUri = Paths.document?.uri ?? '';
  const cacheUri = Paths.cache?.uri ?? '';
  const normalizedDoc = docUri ? normalizeWhisperModelUri(docUri).uri : '';
  const normalizedCache = cacheUri ? normalizeWhisperModelUri(cacheUri).uri : '';
  const docInfo = probeDirectoryPathSync(normalizedDoc);
  const cacheInfo = probeDirectoryPathSync(normalizedCache);
  const whisperDirUri = normalizedDoc ? buildWhisperModelDirectoryUri(normalizedDoc) : '';
  const cacheWhisperDirUri = normalizedCache ? buildWhisperModelDirectoryUri(normalizedCache) : '';
  const whisperDirInfo = probeDirectoryPathSync(whisperDirUri);
  const cacheWhisperDirInfo = probeDirectoryPathSync(cacheWhisperDirUri);
  const resolvedInfo = probeModelPathSync(resolved.uri);
  const candidateUris = candidates
    .map((candidate) => normalizeWhisperModelUri(candidate).uri)
    .filter(Boolean)
    .join(', ');
  return {
    modelId: modelId ?? '',
    storedPath: storedPath ?? '',
    resolvedUri: resolved.uri,
    resolvedExists: String(resolvedInfo.exists),
    resolvedSize: String(resolvedInfo.size),
    documentUri: normalizedDoc,
    documentExists: String(docInfo.exists),
    documentIsDir: String(docInfo.isDirectory),
    documentSample: listDirectorySample(normalizedDoc),
    cacheUri: normalizedCache,
    cacheExists: String(cacheInfo.exists),
    cacheIsDir: String(cacheInfo.isDirectory),
    cacheSample: listDirectorySample(normalizedCache),
    whisperDirUri,
    whisperDirExists: String(whisperDirInfo.exists),
    whisperDirIsDir: String(whisperDirInfo.isDirectory),
    whisperDirSample: listDirectorySample(whisperDirUri),
    cacheWhisperDirUri,
    cacheWhisperDirExists: String(cacheWhisperDirInfo.exists),
    cacheWhisperDirIsDir: String(cacheWhisperDirInfo.isDirectory),
    cacheWhisperDirSample: listDirectorySample(cacheWhisperDirUri),
    candidateUris,
  };
};


export const locateSync = (modelId: string | undefined, storedPath?: string): WhisperModelLocation => {
  const candidates = buildCandidates(modelId, storedPath);
  for (const candidate of candidates) {
    const normalized = normalizeWhisperModelUri(candidate);
    const info = probeModelPathSync(normalized.uri);
    if (info.exists && !info.isDirectory) {
      return { uri: normalized.uri, path: normalized.path, exists: true, size: info.size };
    }
  }
  const fileName = getModel(modelId)?.fileName;
  const fallback = storedPath ? normalizeWhisperModelUri(storedPath) : normalizeWhisperModelUri(fileName ?? '');
  return { uri: fallback.uri, path: fallback.path, exists: false, size: 0 };
};


export const locate = async (modelId: string | undefined, storedPath?: string): Promise<WhisperModelLocation> => {
  const syncResult = locateSync(modelId, storedPath);
  if (syncResult.exists) return syncResult;

  const candidates = buildCandidates(modelId, storedPath);
  for (const candidate of candidates) {
    const normalized = normalizeWhisperModelUri(candidate);
    const info = await probeModelPathNative(normalized.path);
    if (info.exists && !info.isDirectory) {
      return { uri: normalized.uri, path: normalized.path, exists: true, size: info.size };
    }
  }
  return syncResult;
};


const ensurePreferredModelDirectory = async (): Promise<string | null> => {
  for (const directory of getWhisperModelDirectories()) {
    try {
      await ensureDirectoryReady(directory);
      return directory.uri;
    } catch (error) {
      void logWarn('Whisper model directory create failed', {
        scope: 'speech', force: true,
        extra: { root: whisperDirectoryRoot(directory.uri), error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return null;
};


const ensureLocation = async (modelId: string | undefined, storedPath?: string): Promise<WhisperModelLocation> => {
  const resolved = await locate(modelId, storedPath);
  const fileName = getModel(modelId)?.fileName;
  if (!fileName) return resolved;

  const preferredDirUri = await ensurePreferredModelDirectory();
  const preferredUri = preferredDirUri
    ? `${preferredDirUri.endsWith('/') ? preferredDirUri : `${preferredDirUri}/`}${fileName}`
    : null;

  if (preferredUri) {
    const preferred = normalizeWhisperModelUri(preferredUri);
    const preferredInfo = probeModelPathSync(preferred.uri);
    if (preferredInfo.exists && !preferredInfo.isDirectory) {
      return { uri: preferred.uri, path: preferred.path, exists: true, size: preferredInfo.size };
    }
    const preferredNativeInfo = await probeModelPathNative(preferred.path);
    if (preferredNativeInfo.exists && !preferredNativeInfo.isDirectory) {
      return { uri: preferred.uri, path: preferred.path, exists: true, size: preferredNativeInfo.size };
    }
    if (resolved.exists) {
      try {
        const destination = new File(preferred.uri);
        if (!destination.exists) new File(resolved.uri).copy(destination);
        const destInfo = probeModelPathSync(preferred.uri);
        if (destInfo.exists) {
          return { uri: preferred.uri, path: preferred.path, exists: true, size: destInfo.size };
        }
      } catch {

      }
    }
  }

  if (resolved.exists) return resolved;

  void logWarn('Whisper model missing', {
    scope: 'speech', force: true,
    extra: buildMissingModelDiagnostics(modelId, storedPath, resolved, buildCandidates(modelId, storedPath)),
  });

  return preferredUri ? { ...normalizeWhisperModelUri(preferredUri), exists: false, size: 0 } : resolved;
};


export const ensure = async (modelId: string | undefined, storedPath?: string): Promise<string> => (
  (await ensureLocation(modelId, storedPath)).path
);

export { ensureLocation };


export const download = async (
  modelId: string,
  onProgress?: (loaded: number, total?: number) => void
): Promise<string> => {
  const model = getModel(modelId);
  if (!model) throw new Error(`Unknown Whisper model: ${modelId}`);

  const directories = getWhisperModelDirectories();
  if (!directories.length) throw new Error('Whisper storage unavailable');

  let lastError: Error | null = null;

  for (const directory of directories) {
    try {
      await ensureDirectoryReady(directory);
      const dirUri = directory.uri.endsWith('/') ? directory.uri : `${directory.uri}/`;
      const targetFile = new File(`${dirUri}${model.fileName}`);
      const targetUri = targetFile.uri;
      const normalizedTarget = normalizeWhisperModelUri(targetUri);

      const conflictInfo = probeModelPathSync(targetUri);
      if (conflictInfo.exists && conflictInfo.isDirectory) {
        throw new Error(`Whisper model path is a folder: ${targetUri}`);
      }
      const safeTarget = isWhisperModelSafeDeleteTarget({
        uri: normalizedTarget.uri,
        fileName: model.fileName,
        allowedUris: [normalizedTarget.uri],
      });
      if (!safeTarget) {
        throw new Error(`Whisper model path is unsafe: ${targetUri}`);
      }

      const existingInfo = probeModelPathSync(targetUri);
      const existingNativeInfo = existingInfo.exists ? null : await probeModelPathNative(normalizedTarget.path);
      const existingReady = isWhisperModelFileReady(model, existingInfo) || isWhisperModelFileReady(model, existingNativeInfo);
      if ((existingInfo.exists && !existingInfo.isDirectory) || existingNativeInfo?.exists) {
        if (existingReady) {
          try {
            await verifyWhisperModelFileHash(model, targetUri, hashNative);
            return targetUri;
          } catch (error) {
            void logWarn('Whisper existing model hash verification failed', {
              scope: 'speech', force: true, extra: { error: error instanceof Error ? error.message : String(error) },
            });
          }
        }
        try {
          targetFile.delete();
        } catch (error) {
          void logWarn('Whisper incomplete file cleanup failed', {
            scope: 'speech', force: true, extra: { error: error instanceof Error ? error.message : String(error) },
          });
        }
      }

      const downloadFromHost = async (
        url: string,
        nativeFs: ReturnType<typeof resolveWhisperNativeFsModule>,
      ): Promise<string> => {
        const { bytesWritten } = await downloadWhisperModelFile({
          url,
          targetFile,
          nativeTargetPath: normalizedTarget.path,
          nativeFs,
          resolveDownloadUrl: resolveWhisperModelDownloadUrl,
          onProgress,
          expoDownloadFile: async (downloadUrl, destination, options) => {
            await File.downloadFileAsync(downloadUrl, destination, options);
            return destination;
          },
        });

        const downloadedInfo = probeModelPathSync(targetUri);
        const nativeDownloadedInfo = await probeModelPathNative(normalizedTarget.path);
        const ready = isWhisperModelFileReady(model, downloadedInfo, bytesWritten)
          || isWhisperModelFileReady(model, nativeDownloadedInfo, bytesWritten);
        if (!ready) {
          try { targetFile.delete(); } catch (error) {
            void logWarn('Whisper incomplete download cleanup failed', {
              scope: 'speech', force: true, extra: { error: error instanceof Error ? error.message : String(error) },
            });
          }
          throw new Error('Downloaded Whisper model file looks incomplete. Please retry on Wi-Fi.');
        }
        try {
          await verifyWhisperModelFileHash(model, targetUri, hashNative);
        } catch (error) {
          try { targetFile.delete(); } catch (cleanupError) {
            void logWarn('Whisper failed integrity cleanup failed', {
              scope: 'speech', force: true, extra: { error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) },
            });
          }
          throw error;
        }
        return targetUri;
      };

      try {
        const nativeFs = resolveWhisperNativeFsModule(await getRNFSModuleAsync());

        let firstHostError: unknown;
        for (const baseUrl of WHISPER_MODEL_BASE_URLS) {
          try {
            return await downloadFromHost(`${baseUrl}/${model.fileName}`, nativeFs);
          } catch (error) {
            firstHostError ??= error;
            void logWarn('Whisper model host failed', {
              scope: 'speech', force: true,
              extra: { host: baseUrl, error: error instanceof Error ? error.message : String(error) },
            });
          }
        }
        throw firstHostError;
      } catch (error) {


        if (error instanceof Error) (error as WhisperDownloadError).retryOnWifi = true;
        throw error;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      void logWarn('Whisper model download failed', {
        scope: 'speech', force: true, extra: { root: whisperDirectoryRoot(directory.uri), error: lastError.message },
      });
    }
  }
  throw lastError ?? new Error('Whisper storage unavailable');
};


export const remove = async (modelId: string): Promise<void> => {
  const model = getModel(modelId);
  if (!model) return;

  const allowedUris = getWhisperModelDirectories().map((directory) => {
    const dirUri = directory.uri.endsWith('/') ? directory.uri : `${directory.uri}/`;
    return normalizeWhisperModelUri(`${dirUri}${model.fileName}`).uri;
  });

  for (const uri of allowedUris) {
    if (!isWhisperModelSafeDeleteTarget({ uri, fileName: model.fileName, allowedUris })) continue;
    const info = probeModelPathSync(uri);
    const nativeInfo = info.exists ? null : await probeModelPathNative(normalizeWhisperModelUri(uri).path);
    const exists = info.exists || Boolean(nativeInfo?.exists);
    const isDirectory = info.isDirectory || Boolean(nativeInfo?.isDirectory);
    if (!exists || isDirectory) continue;
    try {
      new File(uri).delete();
      return;
    } catch (error) {
      if (await unlinkNative(uri)) return;
      throw error;
    }
  }
};
