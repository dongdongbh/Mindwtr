import { sleep } from './async-utils';
import { isHostResponseTooLargeError } from './http-utils';

export type RetryOptions = {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    random?: () => number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;

const extractStatus = (error: unknown): number | null => {
    if (!error || typeof error !== 'object') return null;
    const anyError = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    const status = anyError.status ?? anyError.statusCode ?? anyError.response?.status;
    return typeof status === 'number' ? status : null;
};

export const isRetryableError = (error: unknown): boolean => {
    if (isHostResponseTooLargeError(error)) return false;
    const status = extractStatus(error);
    if (status === 401 || status === 403 || status === 404) return false;
    if (status === 429) return true;
    if (status && status >= 500) return true;

    const message = error instanceof Error ? error.message : String(error || '');
    const normalized = message.toLowerCase();
    if (normalized.includes('validation') || normalized.includes('invalid')) return false;
    return (
        normalized.includes('timeout') ||
        normalized.includes('timed out') ||
        normalized.includes('network') ||
        normalized.includes('failed to fetch') ||
        normalized.includes('econnrefused') ||
        normalized.includes('econnreset') ||
        normalized.includes('enotfound') ||
        normalized.includes('socket hang up')
    );
};

export const isWebdavInvalidJsonError = (error: unknown): boolean => {
    if (isHostResponseTooLargeError(error)) return false;
    const message = error instanceof Error ? error.message : String(error || '');
    const normalized = message.toLowerCase();
    return (
        normalized.includes('invalid webdav response') ||
        normalized.includes('webdav get failed: invalid json') ||
        normalized.includes('unexpected end of input') ||
        normalized.includes('unexpected end of json input') ||
        normalized.includes('unexpected eof') ||
        normalized.includes('eof while parsing') ||
        normalized.includes('error decoding response body')
    );
};

export const isRetryableWebdavReadError = (error: unknown): boolean => {
    if (isRetryableError(error)) return true;
    return isWebdavInvalidJsonError(error);
};

export async function withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
    const jitterRatio = Math.max(0, Math.min(1, options.jitterRatio ?? DEFAULT_JITTER_RATIO));
    const random = options.random ?? Math.random;
    const shouldRetry = options.shouldRetry ?? isRetryableError;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            const canRetry = attempt < maxAttempts && shouldRetry(error, attempt);
            if (!canRetry) break;
            const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
            const jitterSpan = exponentialDelay * jitterRatio;
            const jitterOffset = jitterSpan > 0 ? ((random() * 2) - 1) * jitterSpan : 0;
            const delayMs = Math.max(0, Math.min(maxDelayMs, exponentialDelay + jitterOffset));
            options.onRetry?.(error, attempt, delayMs);
            if (delayMs > 0) {
                await sleep(delayMs);
            }
        }
    }

    throw lastError;
}
