import { afterAll, describe, expect, it } from 'vitest';
import fixture from './__fixtures__/focus-admission/cases.json';
import { resolveTaskFocusUpdate } from './focus-star';
import type { Task } from './types';


const originalTz = process.env.TZ;

const timeZoneFor = (offsetMinutes: number): string => {
    if (offsetMinutes % 60 !== 0) throw new Error(`whole-hour offsets only: ${offsetMinutes}`);
    const hours = offsetMinutes / 60;

    return hours === 0 ? 'UTC' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
};

describe('Focus admission case table', () => {
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it('covers every Focus admission bug fixed in this area', () => {
        const names = fixture.cases.map((testCase) => testCase.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names.length).toBeGreaterThanOrEqual(15);
        const covered = new Set(fixture.cases.flatMap((testCase) => testCase.covers));
        for (const bug of ['B-1', 'B-2', 'B-2a', 'R-5', '#1277']) expect(covered).toContain(bug);
        for (const name of fixture.knownRustDivergences as string[]) expect(names).toContain(name);
    });

    for (const testCase of fixture.cases) {
        it(testCase.name, () => {
            process.env.TZ = timeZoneFor(testCase.utcOffsetMinutes);
            const decision = resolveTaskFocusUpdate(
                { ...fixture.taskDefaults, ...testCase.before } as Task,
                { ...fixture.taskDefaults, ...testCase.after } as Task,
                {
                    focusedCount: testCase.focusedCount,
                    focusTaskLimit: testCase.focusTaskLimit,
                    now: new Date(testCase.now),
                },
            );
            expect(decision).toEqual(testCase.outcome === 'refused-limit'
                ? { outcome: 'refused-limit', message: `Focus limit of ${testCase.focusTaskLimit} reached` }
                : { outcome: testCase.outcome });
        });
    }
});
