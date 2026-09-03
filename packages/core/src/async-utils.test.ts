import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSleepBypass, sleep } from './async-utils';

describe('sleep', () => {
    afterEach(() => {
        setSleepBypass(null);
        vi.useRealTimers();
    });

    it('waits on a timer by default', async () => {
        vi.useFakeTimers();
        let done = false;
        void sleep(1000).then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(999);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
    });

    it('resolves without a timer while the bypass predicate holds', async () => {
        vi.useFakeTimers();
        setSleepBypass(() => true);
        let done = false;
        void sleep(60_000).then(() => { done = true; });
        await Promise.resolve();
        await Promise.resolve();
        expect(done).toBe(true);
    });
});
