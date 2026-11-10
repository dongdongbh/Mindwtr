import { describe, expect, it } from 'vitest';
import { toStringArray } from './entity-sync-schema';

describe('toStringArray', () => {
    it('returns a new array with the same strings', () => {
        const input = ['a', 'b'];
        const result = toStringArray(input);
        expect(result).toEqual(['a', 'b']);
        expect(result).not.toBe(input);
    });

    it('drops values that are not strings, including holes', () => {
        expect(toStringArray(['a', 1, null, 'b'])).toEqual(['a', 'b']);
        const sparse: unknown[] = new Array(2);
        sparse[1] = 'a';
        const result = toStringArray(sparse);
        expect(result).toEqual(['a']);
        expect(Object.keys(result)).toEqual(['0']);
    });

    it('reads anything that is not an array as empty', () => {
        expect(toStringArray('a')).toEqual([]);
        expect(toStringArray({ 0: 'a', length: 1 })).toEqual([]);
        expect(toStringArray(null)).toEqual([]);
    });
});
