import { describe, expect, it, vi } from 'vitest';
import { isRetryableError, isRetryableWebdavReadError, isWebdavInvalidJsonError, withRetry } from './retry-utils';

describe('withRetry', () => {
    it('returns on first success', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        await expect(withRetry(fn)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries after a failure and succeeds', async () => {
        let attempts = 0;
        const fn = vi.fn().mockImplementation(async () => {
            attempts += 1;
            if (attempts < 2) {
                throw new Error('timeout');
            }
            return 'ok';
        });

        const promise = withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 });
        await expect(promise).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('uses exponential backoff delays', async () => {
        const delays: number[] = [];
        const fn = vi.fn().mockRejectedValue(new Error('timeout'));

        const promise = withRetry(fn, {
            maxAttempts: 3,
            baseDelayMs: 1,
            maxDelayMs: 4,
            jitterRatio: 0,
            onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
        });

        await expect(promise).rejects.toBeDefined();
        expect(delays).toEqual([1, 2]);
    });

    it('stops after max attempts', async () => {
        let attempts = 0;
        const fn = vi.fn().mockImplementation(async () => {
            attempts += 1;
            throw new Error('timeout');
        });
        await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 0 })).rejects.toBeDefined();
        expect(attempts).toBe(2);
    });

    it('does not retry non-retryable errors', async () => {
        const error = Object.assign(new Error('Not found'), { status: 404 });
        const fn = vi.fn().mockRejectedValue(error);
        await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).rejects.toBe(error);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['network timeout', { status: 429 }],
        ['failed to fetch', { response: { status: 503 } }],
        ['WebDAV GET failed: invalid JSON (Unexpected end of input)', { statusCode: 500 }],
    ])('never retries a host cap hidden behind %s', async (message, status) => {
        const error = Object.assign(new TypeError(message), status, {
            code: 'response-too-large', limitBytes: 8,
        });
        expect(isRetryableError(error)).toBe(false);
        expect(isRetryableWebdavReadError(error)).toBe(false);
        expect(isWebdavInvalidJsonError(error)).toBe(false);
        const operation = vi.fn().mockRejectedValue(error);
        const onRetry = vi.fn();
        await expect(withRetry(operation, {
            maxAttempts: 3, baseDelayMs: 0, shouldRetry: isRetryableWebdavReadError, onRetry,
        })).rejects.toBe(error);
        expect(operation).toHaveBeenCalledTimes(1);
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('keeps malformed host metadata on the existing retry policy', () => {
        expect(isRetryableError(Object.assign(new TypeError('network timeout'), {
            code: 'response-too-large', limitBytes: '8',
        }))).toBe(true);
        expect(isRetryableWebdavReadError(Object.assign(new Error('invalid WebDAV response'), {
            code: 'other', limitBytes: 8,
        }))).toBe(true);
    });

    it('applies jitter to exponential delay when enabled', async () => {
        const delays: number[] = [];
        const fn = vi.fn().mockRejectedValue(new Error('timeout'));

        await expect(withRetry(fn, {
            maxAttempts: 2,
            baseDelayMs: 10,
            maxDelayMs: 100,
            jitterRatio: 0.5,
            random: () => 1, // max positive jitter
            onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
        })).rejects.toBeDefined();

        expect(delays).toHaveLength(1);
        expect(delays[0]).toBe(15);
    });

    it('treats transient webdav read decode/parse failures as retryable', () => {
        expect(isRetryableWebdavReadError(new Error('Invalid WebDAV response: error decoding response body'))).toBe(true);
        expect(isRetryableWebdavReadError(new Error('WebDAV GET failed: invalid JSON (Unexpected end of input)'))).toBe(true);
        expect(isRetryableWebdavReadError(new Error('validation error'))).toBe(false);
    });

    it('detects webdav invalid json/decode errors', () => {
        expect(isWebdavInvalidJsonError(new Error('Invalid WebDAV response: error decoding response body: EOF while parsing a string'))).toBe(true);
        expect(isWebdavInvalidJsonError(new Error('WebDAV GET failed: invalid JSON (Unexpected end of input)'))).toBe(true);
        expect(isWebdavInvalidJsonError(new Error('timeout exceeded'))).toBe(false);
    });
});
