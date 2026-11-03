import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { raceCloseFlush } from './close-flush-race';

describe('raceCloseFlush (#913)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves without timing out when the flush settles first', async () => {
        const steps: string[] = [];
        const reportError = vi.fn();

        const result = await raceCloseFlush({
            flush: () => Promise.resolve(),
            timeoutMs: 10_000,
            logStep: (step) => steps.push(step),
            reportError,
        });

        expect(result).toEqual({ timedOut: false });
        expect(steps).toEqual(['flush before close started', 'flush before close settled']);
        expect(reportError).not.toHaveBeenCalled();
    });

    it('times out when the flush never settles, without cancelling it', async () => {
        const steps: string[] = [];
        let flushResolved = false;
        let resolveFlush!: () => void;
        const flush = () => new Promise<void>((resolve) => {
            resolveFlush = () => {
                flushResolved = true;
                resolve();
            };
        });

        const resultPromise = raceCloseFlush({
            flush,
            timeoutMs: 10_000,
            logStep: (step) => steps.push(step),
            reportError: vi.fn(),
        });

        await vi.advanceTimersByTimeAsync(9_999);
        expect(steps).toEqual(['flush before close started']);

        await vi.advanceTimersByTimeAsync(1);
        const result = await resultPromise;

        expect(result).toEqual({ timedOut: true });
        expect(steps).toEqual([
            'flush before close started',
            'flush before close timed out after 10000ms',
        ]);

        expect(flushResolved).toBe(false);
        resolveFlush();
        expect(flushResolved).toBe(true);
    });

    it('routes a flush rejection through reportError and still resolves as settled', async () => {
        const reportError = vi.fn();
        const error = new Error('save failed');

        const result = await raceCloseFlush({
            flush: () => Promise.reject(error),
            timeoutMs: 10_000,
            reportError,
        });

        expect(result).toEqual({ timedOut: false });
        expect(reportError).toHaveBeenCalledWith('Save failed', error);
    });
});
