export const formatCaptureError = (error: unknown) =>
    (error instanceof Error ? error.message : String(error));

export const buildCaptureExtra = (message?: string, error?: unknown): Record<string, string> | undefined => {
    const extra: Record<string, string> = {};
    if (message) extra.message = message;
    if (error) {
        extra.error = formatCaptureError(error);
        if (error instanceof Error && error.stack) {
            extra.stack = error.stack;
        }
    }
    return Object.keys(extra).length ? extra : undefined;
};


export const buildCaptureDirectoryUri = (rootUri: string, directoryName: string) => {
    const baseUri = rootUri.endsWith('/') ? rootUri : `${rootUri}/`;
    const childName = directoryName.replace(/^\/+|\/+$/gu, '');
    return `${baseUri}${childName}`;
};


export const buildCaptureFileUri = (directoryUri: string, fileName: string) => {
    const baseUri = directoryUri.endsWith('/') ? directoryUri : `${directoryUri}/`;
    return `${baseUri}${fileName}`;
};

export type CaptureFileInfo = {
    exists?: boolean;
    isDirectory?: boolean;
    size?: number;
};

export type CaptureFileLike = {
    uri: string;
    info: () => CaptureFileInfo;
};

export const selectExistingCaptureFile = <T extends CaptureFileLike>(
    candidates: (T | null | undefined)[]
): { file: T; info: CaptureFileInfo } | null => {
    for (const file of candidates) {
        if (!file) continue;
        try {
            const info = file.info();
            if (info?.exists && !info.isDirectory) {
                return { file, info };
            }
        } catch {
            // Try the next candidate. The caller decides how to report total failure.
        }
    }
    return null;
};

type QuickCaptureSettingsLike = {
    ai?: unknown;
} | null | undefined;

export const selectQuickCaptureSettings = <T extends QuickCaptureSettingsLike>(
    snapshotSettings: T,
    latestSettings: T
): T => latestSettings ?? snapshotSettings;

export const getCaptureFileExtension = (uri: string) => {
    const match = uri.match(/\.[a-z0-9]+$/i);
    return match ? match[0] : '.m4a';
};

export const getCaptureMimeType = (extension: string) => {
    switch (extension.toLowerCase()) {
        case '.aac':
            return 'audio/aac';
        case '.mp3':
            return 'audio/mpeg';
        case '.wav':
            return 'audio/wav';
        case '.caf':
            return 'audio/x-caf';
        case '.3gp':
        case '.3gpp':
            return 'audio/3gpp';
        case '.m4a':
        default:
            return 'audio/mp4';
    }
};
