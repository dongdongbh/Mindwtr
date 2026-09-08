import { describe, expect, it, vi } from 'vitest';
import { afterPaint } from './after-paint';

describe('afterPaint', () => {
    it('waits for two frames and supports cancelling either frame', () => {
        for (const cancelAfter of [0, 1, 2]) {
            const queue: FrameRequestCallback[] = [];
            const ready = vi.fn();
            const cancelFrame = vi.fn();
            const stop = afterPaint(ready, (callback) => queue.push(callback), cancelFrame);
            for (let i = 0; i < cancelAfter; i++) queue[i](0);
            expect(ready).toHaveBeenCalledTimes(cancelAfter === 2 ? 1 : 0);
            stop();
            queue.at(-1)?.(0);
            expect(ready).toHaveBeenCalledTimes(cancelAfter === 2 ? 1 : 0);
            expect(cancelFrame).toHaveBeenCalledOnce();
        }
    });
});
