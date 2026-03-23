import { DropboxUnauthorizedError } from './dropbox-sync';
import { logError, logWarn } from './app-log';

export const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const isDropboxUnauthorizedError = (error: unknown): boolean => {
    if (error instanceof DropboxUnauthorizedError) return true;
    const message = formatError(error).toLowerCase();
    return message.includes('http 401')
        || message.includes('invalid_access_token')
        || message.includes('expired_access_token')
        || message.includes('unauthorized');
};

export const compareVersions = (v1: string, v2: string): number => {
    const parseVersionParts = (version: string): number[] => (
        version
            .trim()
            .replace(/^v/i, '')
            .split(/[+-]/)[0]
            .split('.')
            .map((part) => {
                const match = part.match(/\d+/);
                return match ? Number.parseInt(match[0], 10) : 0;
            })
    );

    const parts1 = parseVersionParts(v1);
    const parts2 = parseVersionParts(v2);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i += 1) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
};

const buildSettingsExtra = (message?: string, error?: unknown): Record<string, string> | undefined => {
    const extra: Record<string, string> = {};
    if (message) extra.message = message;
    if (error) extra.error = formatError(error);
    return Object.keys(extra).length ? extra : undefined;
};

export const logSettingsWarn = (messageOrError: unknown, error?: unknown) => {
    if (typeof messageOrError === 'string') {
        void logWarn(messageOrError, { scope: 'settings', extra: buildSettingsExtra(undefined, error) });
        return;
    }
    void logWarn('Settings warning', { scope: 'settings', extra: buildSettingsExtra(undefined, messageOrError) });
};

export const logSettingsError = (messageOrError: unknown, error?: unknown) => {
    if (typeof messageOrError === 'string') {
        const err = error instanceof Error ? error : new Error(messageOrError);
        void logError(err, { scope: 'settings', extra: buildSettingsExtra(messageOrError, error) });
        return;
    }
    void logError(messageOrError, { scope: 'settings', extra: buildSettingsExtra(undefined, messageOrError) });
};

export const maskCalendarUrl = (url: string): string => {
    const trimmed = url.trim();
    if (!trimmed) return '';
    const match = trimmed.match(/^(https?:\/\/)?([^/?#]+)([^?#]*)/i);
    if (!match) {
        return trimmed.length <= 8 ? '...' : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
    }
    const protocol = match[1] ?? '';
    const host = match[2] ?? '';
    const path = match[3] ?? '';
    const lastSegment = path.split('/').filter(Boolean).pop() ?? '';
    const suffix = lastSegment ? `...${lastSegment.slice(-6)}` : '...';
    return `${protocol}${host}/${suffix}`;
};

export const formatClockSkew = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
    const minutes = seconds / 60;
    return `${minutes.toFixed(1)} min`;
};
