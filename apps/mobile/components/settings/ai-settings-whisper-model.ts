export type WhisperModelDescriptor = {
    id: string;
    fileName: string;
    label: string;
    minBytes?: number;
    sha256?: string;
    sizeBytes?: number;
};


export type WhisperModelDownloadFile = {
    uri: string;
    delete?: () => void;
};

export type WhisperModelNativeDownloadResult = {
    statusCode?: number;
    bytesWritten?: number;
};

export type WhisperModelDownloadSuccess<TFile extends WhisperModelDownloadFile> = {
    file: TFile;
    statusCode: number;
    bytesWritten?: number;
};

export type WhisperModelNativeStatResult = {
    path?: string;
    originalFilepath?: string;
    size?: number;
    isFile?: () => boolean;
    isDirectory?: () => boolean;
};

export type WhisperModelDownloadProgress = { bytesWritten: number; contentLength?: number };

export type WhisperModelNativeFs = {
    downloadFile: (options: {
        fromUrl: string;
        toFile: string;
        headers?: Record<string, string>;
        cacheable?: boolean;
        readTimeout?: number;
        backgroundTimeout?: number;
        progress?: (progress: WhisperModelDownloadProgress) => void;
        progressDivider?: number;
    }) => { promise: Promise<WhisperModelNativeDownloadResult> };
    stat?: (path: string) => Promise<WhisperModelNativeStatResult>;
};

export type WhisperModelNativeHashFs = {
    hash: (path: string, algorithm: string) => Promise<string>;
};

type NativeModuleCandidate = Partial<WhisperModelNativeFs> & Partial<WhisperModelNativeHashFs>;

const isNativeModuleCandidate = (value: unknown): value is NativeModuleCandidate => (
    typeof value === 'object' && value !== null
);

const getNativeModuleCandidates = (value: unknown): NativeModuleCandidate[] => {
    const candidates: NativeModuleCandidate[] = [];
    if (isNativeModuleCandidate(value)) {
        candidates.push(value);
        const maybeDefault = (value as { default?: unknown }).default;
        if (isNativeModuleCandidate(maybeDefault)) {
            candidates.push(maybeDefault);
        }
    }
    return candidates;
};

const hasNativeDownloadFile = (candidate: NativeModuleCandidate): candidate is WhisperModelNativeFs => (
    typeof candidate.downloadFile === 'function'
);

const hasNativeHash = (candidate: NativeModuleCandidate): candidate is WhisperModelNativeHashFs => (
    typeof candidate.hash === 'function'
);

export const resolveWhisperNativeFsModule = (value: unknown): WhisperModelNativeFs | null => (
    getNativeModuleCandidates(value).find(hasNativeDownloadFile) ?? null
);

export const resolveWhisperNativeHashModule = (value: unknown): WhisperModelNativeHashFs | null => (
    getNativeModuleCandidates(value).find(hasNativeHash) ?? null
);

export type WhisperModelDownloadLogger = (
    event: string,
    details?: Record<string, unknown>
) => void | Promise<void>;

export type WhisperModelResolveDownloadUrl = (url: string) => Promise<string>;

const emitDownloadLog = async (
    logger: WhisperModelDownloadLogger | undefined,
    event: string,
    details?: Record<string, unknown>
): Promise<void> => {
    if (!logger) return;
    try {
        await logger(event, details);
    } catch {
    }
};

const describeError = (error: unknown): Record<string, unknown> => (
    error instanceof Error
        ? { errorName: error.name, errorMessage: error.message }
        : { errorMessage: String(error) }
);

export const describeWhisperDownloadUrl = (rawUrl: string): Record<string, unknown> => {
    try {
        const parsed = new URL(rawUrl);
        return {
            scheme: parsed.protocol.replace(/:$/u, ''),
            host: parsed.host,
            path: parsed.pathname,
            hasQuery: Boolean(parsed.search),
        };
    } catch {
        return {
            parseError: true,
            length: rawUrl.length,
            prefix: rawUrl.slice(0, 32),
        };
    }
};

export const resolveWhisperModelDownloadUrl = async (
    url: string,
    fetchImpl = globalThis.fetch,
    logger?: WhisperModelDownloadLogger
): Promise<string> => {
    if (typeof fetchImpl !== 'function') {
        await emitDownloadLog(logger, 'resolve-url-fetch-unavailable', { originalUrlParts: describeWhisperDownloadUrl(url) });
        return url;
    }

    const resolveFromHead = async (redirect: RequestRedirect): Promise<string> => {
        await emitDownloadLog(logger, 'resolve-url-head-start', { redirect, urlParts: describeWhisperDownloadUrl(url) });
        const response = await fetchImpl(url, { method: 'HEAD', redirect });
        const location = response.headers?.get?.('location');
        if (location) {
            const resolvedLocation = new URL(location, url).toString();
            await emitDownloadLog(logger, 'resolve-url-head-location', {
                redirect,
                location: describeWhisperDownloadUrl(resolvedLocation),
                responseUrlParts: typeof response.url === 'string' ? describeWhisperDownloadUrl(response.url) : undefined,
            });
            return resolvedLocation;
        }
        const resolvedUrl = typeof response.url === 'string' && response.url.trim() ? response.url : '';
        await emitDownloadLog(logger, 'resolve-url-head-response', {
            redirect,
            responseUrlParts: resolvedUrl ? describeWhisperDownloadUrl(resolvedUrl) : undefined,
            changed: Boolean(resolvedUrl && resolvedUrl !== url),
        });
        return resolvedUrl && resolvedUrl !== url ? resolvedUrl : '';
    };

    try {
        const manualRedirectUrl = await resolveFromHead('manual');
        if (manualRedirectUrl) {
            await emitDownloadLog(logger, 'resolve-url-complete', {
                mode: 'manual',
                changed: manualRedirectUrl !== url,
                finalUrlParts: describeWhisperDownloadUrl(manualRedirectUrl),
            });
            return manualRedirectUrl;
        }
    } catch (error) {

        await emitDownloadLog(logger, 'resolve-url-head-error', { redirect: 'manual', ...describeError(error) });
    }

    try {
        const followedUrl = await resolveFromHead('follow');
        if (followedUrl) {
            await emitDownloadLog(logger, 'resolve-url-complete', {
                mode: 'follow',
                changed: followedUrl !== url,
                finalUrlParts: describeWhisperDownloadUrl(followedUrl),
            });
            return followedUrl;
        }
    } catch (error) {

        await emitDownloadLog(logger, 'resolve-url-head-error', { redirect: 'follow', ...describeError(error) });
    }
    await emitDownloadLog(logger, 'resolve-url-complete', {
        mode: 'original',
        changed: false,
        finalUrlParts: describeWhisperDownloadUrl(url),
    });
    return url;
};

export type WhisperModelExpoDownloadFile<TFile extends WhisperModelDownloadFile> = (
    url: string,
    targetFile: TFile,
    options?: { idempotent?: boolean }
) => Promise<TFile>;

export const downloadWhisperModelFile = async <TFile extends WhisperModelDownloadFile>({
    url,
    targetFile,
    nativeTargetPath,
    nativeFs,
    resolveDownloadUrl,
    logger,
    onProgress,
}: {
    url: string;
    targetFile: TFile;


    nativeTargetPath: string;
    nativeFs?: WhisperModelNativeFs | null;
    resolveDownloadUrl?: WhisperModelResolveDownloadUrl;
    logger?: WhisperModelDownloadLogger;
    onProgress?: (loaded: number, total?: number) => void;
    expoDownloadFile: WhisperModelExpoDownloadFile<TFile>;
}): Promise<WhisperModelDownloadSuccess<TFile>> => {
    const downloadFile = nativeFs?.downloadFile;
    if (typeof downloadFile !== 'function') {
        await emitDownloadLog(logger, 'native-download-unavailable', {
            targetUri: targetFile.uri,
            urlParts: describeWhisperDownloadUrl(url),
        });
        throw new Error('Native streaming Whisper model downloads are unavailable in this build.');
    }

    let downloadUrl = url;
    if (resolveDownloadUrl) {
        try {
            const resolvedUrl = await resolveDownloadUrl(url);
            if (resolvedUrl.trim()) downloadUrl = resolvedUrl;
        } catch (error) {
            await emitDownloadLog(logger, 'resolve-url-wrapper-error', describeError(error));
            downloadUrl = url;
        }
    }

    const startedAt = Date.now();
    await emitDownloadLog(logger, 'native-download-start', {
        originalUrlParts: describeWhisperDownloadUrl(url),
        finalUrlParts: describeWhisperDownloadUrl(downloadUrl),
        finalUrlChanged: downloadUrl !== url,
        targetUri: targetFile.uri,
        nativeTargetPath,
    });

    try {
        const result = await downloadFile({
            fromUrl: downloadUrl,
            toFile: nativeTargetPath,
            headers: { Accept: 'application/octet-stream' },
            cacheable: false,
            readTimeout: 10 * 60 * 1000,
            backgroundTimeout: 30 * 60 * 1000,
            ...(onProgress ? {
                progress: (progress) => onProgress(progress.bytesWritten, progress.contentLength),
                progressDivider: 10,
            } : {}),
        }).promise;
        const statusCode = result.statusCode;
        await emitDownloadLog(logger, 'native-download-complete', {
            statusCode,
            bytesWritten: result.bytesWritten,
            elapsedMs: Date.now() - startedAt,
        });
        if (typeof statusCode !== 'number' || statusCode < 200 || statusCode >= 300) {
            throw new Error(`Whisper model download failed with HTTP ${statusCode ?? 'unknown'}`);
        }
        return {
            file: targetFile,
            statusCode,
            bytesWritten: typeof result.bytesWritten === 'number' ? result.bytesWritten : undefined,
        };
    } catch (error) {
        await emitDownloadLog(logger, 'native-download-error', {
            elapsedMs: Date.now() - startedAt,
            ...describeError(error),
        });
        try {
            targetFile.delete?.();
            await emitDownloadLog(logger, 'native-download-cleanup-complete', { targetUri: targetFile.uri });
        } catch (cleanupError) {
            await emitDownloadLog(logger, 'native-download-cleanup-error', describeError(cleanupError));
        }
        throw error;
    }
};

export type WhisperModelPathInfo = {
    exists?: boolean;
    isDirectory?: boolean | null;
    size?: number | null;
};

const normalizeForCompare = (uri: string): string => uri.trim().replace(/\\/gu, '/').replace(/\/+$/u, '');

const basename = (uri: string): string => {
    const normalized = normalizeForCompare(uri);
    return normalized.split('/').pop() ?? '';
};

export const getWhisperModelMinimumBytes = (model: WhisperModelDescriptor): number => Math.max(1, model.minBytes ?? 1);

export const getWhisperModelExpectedBytes = (model: WhisperModelDescriptor): number | undefined => (
    typeof model.sizeBytes === 'number' && Number.isFinite(model.sizeBytes) && model.sizeBytes > 0
        ? model.sizeBytes
        : undefined
);

const getPositiveFiniteByteCount = (value: unknown): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
);

export const isWhisperModelFileReady = (
    model: WhisperModelDescriptor,
    info: WhisperModelPathInfo | null | undefined,
    observedBytes?: number | null
): boolean => {
    if (!info?.exists || info.isDirectory !== false) return false;
    const size = getPositiveFiniteByteCount(info.size);
    const nativeBytes = getPositiveFiniteByteCount(observedBytes);
    const expectedBytes = getWhisperModelExpectedBytes(model);
    if (expectedBytes !== undefined) {
        if (size !== undefined) return size === expectedBytes;
        return nativeBytes === expectedBytes;
    }
    const minimumBytes = getWhisperModelMinimumBytes(model);
    if (size !== undefined) return size >= minimumBytes;
    return nativeBytes !== undefined && nativeBytes >= minimumBytes;
};

export type WhisperModelHashFile = (uri: string) => Promise<string>;

export const verifyWhisperModelFileHash = async (
    model: WhisperModelDescriptor,
    uri: string,
    hashFile: WhisperModelHashFile
): Promise<void> => {
    const expected = model.sha256?.trim().toLowerCase();
    if (!expected) return;
    const actual = (await hashFile(uri)).trim().toLowerCase();
    if (actual !== expected) {
        throw new Error(`Whisper model SHA-256 mismatch for ${model.label}: expected ${expected}, got ${actual}`);
    }
};

export const isWhisperModelSafeDeleteTarget = ({
    uri,
    fileName,
    allowedUris,
}: {
    uri: string;
    fileName: string;
    allowedUris: string[];
}): boolean => {
    if (!uri || !fileName || basename(uri) !== fileName) return false;
    const normalizedUri = normalizeForCompare(uri);
    return allowedUris.some((allowedUri) => normalizeForCompare(allowedUri) === normalizedUri);
};
