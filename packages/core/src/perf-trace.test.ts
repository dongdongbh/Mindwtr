import { afterEach, describe, expect, it } from 'vitest';
import { traceSection, traceSectionAsync } from './perf-trace';

const host = globalThis as { __mindwtrTraceSection?: (name: string) => void };

describe('perf-trace', () => {
    afterEach(() => { delete host.__mindwtrTraceSection; });

    it('opens and closes one section around the work, also when it throws', async () => {
        const calls: string[] = [];
        host.__mindwtrTraceSection = (name) => calls.push(name);
        expect(traceSection('a', () => 1)).toBe(1);
        expect(() => traceSection('b', () => { throw new Error('x'); })).toThrow('x');
        await expect(traceSectionAsync('c', async () => 2)).resolves.toBe(2);
        await expect(traceSectionAsync('d', async () => { throw new Error('y'); })).rejects.toThrow('y');
        expect(calls).toEqual(['a', '', 'b', '', 'c', '', 'd', '']);
    });

    it('is a plain call without a host hook', async () => {
        expect(traceSection('a', () => 3)).toBe(3);
        await expect(traceSectionAsync('b', async () => 4)).resolves.toBe(4);
    });
});
