import { compareAppVersions, isDropboxUnauthorizedError, maskCalendarFeedUrl } from '@mindwtr/core';
import { logError, logWarn } from './app-log';

export const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export { isDropboxUnauthorizedError };

// Core's (calendar-settings-model.ts), shared with the native host.
export const maskCalendarUrl = maskCalendarFeedUrl;

export const compareVersions = compareAppVersions;

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

export const formatClockSkew = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
    const minutes = seconds / 60;
    return `${minutes.toFixed(1)} min`;
};
