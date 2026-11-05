import { describe, expect, it } from 'vitest';

import { resolvePinnedRowStart } from './ProjectWorkspace';

const ESTIMATE = 88;

describe('pinned row placement in a virtualized project list (#916)', () => {
    it('uses the offset the virtualizer holds once rows have been measured', () => {


        const measuredStart = 8_235;

        expect(resolvePinnedRowStart(measuredStart, 135, 0)).toBe(measuredStart);
        expect(resolvePinnedRowStart(measuredStart, 135, 0)).not.toBe(135 * ESTIMATE);
    });

    it('falls back to the estimate, offset by the scroll margin, before anything is measured', () => {
        expect(resolvePinnedRowStart(undefined, 10, 240)).toBe(240 + 10 * ESTIMATE);
        expect(resolvePinnedRowStart(undefined, 0, 0)).toBe(0);
    });

    it('keeps a measured offset of zero rather than treating it as missing', () => {
        expect(resolvePinnedRowStart(0, 4, 120)).toBe(0);
    });
});
