import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginCloseFlush, resetCloseFlushGate } from './close-flush-gate';


describe('close-flush-gate', () => {
    beforeEach(() => {
        resetCloseFlushGate();
    });

    const options = () => ({
        flush: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 1_000,
        reportError: vi.fn(),
    });

    it('runs the underlying flush once for concurrent callers and gives them the same result', async () => {
        const opts = options();

        const [a, b] = await Promise.all([beginCloseFlush(opts), beginCloseFlush(opts)]);

        expect(opts.flush).toHaveBeenCalledTimes(1);
        expect(a).toEqual({ timedOut: false });
        expect(b).toBe(a);
    });

    it('starts a new flush after resetCloseFlushGate()', async () => {
        const opts = options();

        await beginCloseFlush(opts);
        resetCloseFlushGate();
        await beginCloseFlush(opts);

        expect(opts.flush).toHaveBeenCalledTimes(2);
    });

    it('returns the settled result instantly without re-running the flush', async () => {
        const opts = options();

        await beginCloseFlush(opts);
        const second = await beginCloseFlush(opts);

        expect(opts.flush).toHaveBeenCalledTimes(1);
        expect(second).toEqual({ timedOut: false });
    });
});
