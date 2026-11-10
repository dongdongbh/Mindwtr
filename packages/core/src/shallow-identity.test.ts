import { describe, expect, it } from 'vitest';
import { preserveShallowIdentity, sameShallowRecord } from './shallow-identity';

describe('sameShallowRecord', () => {
    it('matches records whose keys and values agree, in any key order', () => {
        expect(sameShallowRecord({ a: 1, b: 'x', c: undefined }, { a: 1, b: 'x', c: undefined })).toBe(true);
        expect(sameShallowRecord({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    });

    it('uses Object.is for values and compares arrays one level deep', () => {
        expect(sameShallowRecord({ a: NaN }, { a: NaN })).toBe(true);
        expect(sameShallowRecord({ a: 0 }, { a: -0 })).toBe(false);
        expect(sameShallowRecord({ a: ['x', 1] }, { a: ['x', 1] })).toBe(true);
        expect(sameShallowRecord({ a: [0] }, { a: [-0] })).toBe(false);
        expect(sameShallowRecord({ a: [NaN] }, { a: [NaN] })).toBe(true);
        expect(sameShallowRecord({ a: { b: 1 } }, { a: { b: 1 } })).toBe(false);
        expect(sameShallowRecord({ a: '1' }, { a: 1 })).toBe(false);
    });

    it('needs the same own keys, not only the same count or values', () => {
        expect(sameShallowRecord({ a: undefined }, { b: undefined })).toBe(false);
        expect(sameShallowRecord({ a: 1 }, { a: 1, b: undefined })).toBe(false);
        expect(sameShallowRecord(Object.create({ a: 1 }), { a: 1 })).toBe(false);
    });

    it('counts a non-enumerable own property as present, as before', () => {
        expect(sameShallowRecord(Object.defineProperty({ b: 2 }, 'a', { value: 1, enumerable: false }), { a: 1 })).toBe(true);
        expect(sameShallowRecord(Object.defineProperty({ c: 2 }, 'a', { value: 1, enumerable: false }), { a: 1, c: 2 })).toBe(false);
    });

    it('never matches an array with a plain record', () => {
        expect(sameShallowRecord([], {})).toBe(false);
        expect(sameShallowRecord([1], [1])).toBe(true);
    });

    it('keeps the input object when the candidate matches it', () => {
        const input = { amount: 2, unit: 'day' };
        expect(preserveShallowIdentity(input, { unit: 'day', amount: 2 })).toBe(input);
        const changed = { amount: 3, unit: 'day' };
        expect(preserveShallowIdentity(input, changed)).toBe(changed);
    });
});
