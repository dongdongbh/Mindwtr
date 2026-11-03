import { useTaskStore } from '@mindwtr/core';
import { useUiStore } from '../store/ui-store';
import { logError } from './app-log';

type ReportErrorOptions = {
    category?: 'network' | 'validation' | 'permissions' | 'storage' | 'sync' | 'unknown';
    extra?: Record<string, unknown>;
    scope?: string;
    step?: string;
    toast?: boolean;

    userMessage?: string;
};

export const reportError = (label: string, error: unknown, options?: ReportErrorOptions) => {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = options?.category ? `[${options.category}] ` : '';
    const fullMessage = `${label}: ${message}`;
    const visibleMessage = options?.userMessage ?? fullMessage;
    useTaskStore.getState().setError(`${prefix}${visibleMessage}`);
    if (options?.toast !== false) {
        useUiStore.getState().showToast(visibleMessage, 'error');
    }
    void logError(error, {
        scope: options?.scope ?? 'ui',
        step: options?.step ?? label,
        extra: options?.extra,
    });
};
