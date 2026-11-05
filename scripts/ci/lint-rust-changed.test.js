import { describe, expect, it } from 'bun:test';
import { hunkRanges, overlaps } from './lint-rust-changed.mjs';

describe('lint-rust-changed hunk overlap', () => {
    const diff = [
        '@@ -3,2 +3,3 @@ fn a() {',
        '@@ -10 +11 @@',
        '@@ -20,0 +22,4 @@',
        '@@ -30,5 +35,0 @@',
    ].join('\n');

    it('reads both sides of each hunk, with pure insertions and deletions as one line', () => {
        expect(hunkRanges(diff, 'old')).toEqual([[3, 4], [10, 10], [20, 20], [30, 34]]);
        expect(hunkRanges(diff, 'new')).toEqual([[3, 5], [11, 11], [22, 25], [35, 35]]);
    });

    it('fails only a formatting difference that touches a changed line', () => {
        const changed = [[22, 25]];
        expect(overlaps([[25, 27]], changed)).toBe(true);
        expect(overlaps([[20, 21]], changed)).toBe(false);
        expect(overlaps([[26, 30]], changed)).toBe(false);
    });
});
