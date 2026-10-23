import { describe, expect, it } from 'bun:test';
import { budgetVerdict } from './merge-budget.mjs';

// Real series (D9b change 5): c4b2t had longest blocks 331 / 376 ms; the regressed builds 906-954 / 935-975.
const series = ({ block = [331, 376], tap = 186, samples = 20, unansweredShare = 0, taps = 160 } = {}) => ({
    traces: samples,
    samples,
    longestBlockMs: { median: block[0], p90: block[1] },
    tapsInSyncSpan: taps ? { p90: tap, n: taps } : { n: 0 },
    taps: { inSpan: 160, unanswered: Math.round(unansweredShare * 160), unansweredShare },
});
const verdict = (summary, repeat = false) => budgetVerdict(summary, { tapP90Ms: 300, repeat }).verdict;

describe('merge series resume budget', () => {
    it('passes a known-good series and fails a regressed one whatever its tap p90', () => {
        expect(verdict(series())).toBe('pass');
        // The limits themselves pass; a repeat run whose gates agree passes too.
        expect(verdict(series({ block: [450, 550], tap: 300 }))).toBe('pass');
        expect(verdict(series(), true)).toBe('pass');
        expect(verdict(series({ block: [917, 951], tap: 362 }))).toBe('fail');
    });

    it('asks for a repeat when the gates disagree, and fails a second disagreement as noisy', () => {
        // mfb: the same ~900 ms block as the failing builds, but few taps landed in it.
        const mfb = series({ block: [906, 960], tap: 171 });
        expect(verdict(mfb)).toBe('repeat');
        expect(verdict(mfb, true)).toBe('fail');
        expect(verdict(series({ tap: 340 }))).toBe('repeat');
        expect(verdict(series({ block: [440, 560] }))).toBe('repeat');
        expect(verdict(series({ block: [460, 500] }))).toBe('repeat');
    });

    it('fails too few good samples, too many unanswered taps and a series with no tap in the sync span outright', () => {
        expect(verdict(series({ samples: 10 }))).toBe('fail');
        // Errored traces are no samples.
        expect(verdict({ ...series({ samples: 15 }), traces: 20 })).toBe('fail');
        expect(verdict(series({ unansweredShare: 0.06 }))).toBe('fail');
        const noTaps = budgetVerdict(series({ taps: 0 }), { tapP90Ms: 300 });
        expect(noTaps.verdict).toBe('fail');
        expect(noTaps.reasons[0]).toContain('no tap');
    });
});
