import { describe, expect, it, vi } from 'vitest';

import { dicewareWordlist, generateDicewarePassphrase } from './diceware';

const DICEWARE_WORDLIST = dicewareWordlist();

// A randomBytes stub that replays a fixed queue of 32-bit values, so the tests
// can steer which word each draw lands on (and force a rejected draw).
const bytesFrom = (values: number[]) => {
    let index = 0;
    return vi.fn((n: number) => {
        expect(n).toBe(4);
        const value = values[Math.min(index, values.length - 1)];
        index += 1;
        return new Uint8Array([
            (value >>> 24) & 0xff,
            (value >>> 16) & 0xff,
            (value >>> 8) & 0xff,
            value & 0xff,
        ]);
    });
};

describe('diceware wordlist', () => {
    it('is split on first use, not when the module loads (about 12 ms of the native start)', async () => {
        vi.resetModules();
        const split = vi.spyOn(String.prototype, 'split');
        const splitsOfTheList = () => split.mock.contexts.filter((text) => String(text).includes('abacus abdomen')).length;
        try {
            const fresh = await import('./diceware');
            expect(splitsOfTheList()).toBe(0);
            fresh.generateDicewarePassphrase(2, bytesFrom([0, 1]));
            fresh.generateDicewarePassphrase(2, bytesFrom([0, 1]));
            expect(splitsOfTheList()).toBe(1);
        } finally {
            split.mockRestore();
        }
    }, 30_000);

    it('is the EFF long list: 7776 unique lowercase words', () => {
        expect(DICEWARE_WORDLIST).toHaveLength(7776);
        expect(new Set(DICEWARE_WORDLIST).size).toBe(7776);
        expect(DICEWARE_WORDLIST[0]).toBe('abacus');
        expect(DICEWARE_WORDLIST[7775]).toBe('zoom');
        expect(DICEWARE_WORDLIST.every((word) => /^[a-z-]+$/.test(word))).toBe(true);
    });
});

describe('generateDicewarePassphrase', () => {
    it('returns six words from the list by default, using the injected source', () => {
        const randomBytes = bytesFrom([0, 1, 2, 3, 4, 5]);
        const phrase = generateDicewarePassphrase(undefined, randomBytes);
        const words = phrase.split(' ');

        expect(words).toHaveLength(6);
        expect(randomBytes).toHaveBeenCalledTimes(6);
        expect(words.every((word) => DICEWARE_WORDLIST.includes(word))).toBe(true);
        expect(words).toEqual(DICEWARE_WORDLIST.slice(0, 6));
    });

    it('honours an explicit word count', () => {
        expect(generateDicewarePassphrase(3, bytesFrom([10])).split(' ')).toHaveLength(3);
        expect(() => generateDicewarePassphrase(0, bytesFrom([0]))).toThrow();
    });

    it('rejects draws in the biased tail instead of folding them with a modulo', () => {
        // 2^32 - 1 is inside the discarded tail (2^32 is not a multiple of 7776);
        // a modulo would have folded it onto word 2559.
        const randomBytes = bytesFrom([0xffffffff, 7776 + 41]);
        const phrase = generateDicewarePassphrase(1, randomBytes);

        expect(randomBytes).toHaveBeenCalledTimes(2);
        expect(phrase).toBe(DICEWARE_WORDLIST[41]);
        expect(phrase).not.toBe(DICEWARE_WORDLIST[0xffffffff % 7776]);
    });

    it('gives up rather than looping forever on a source stuck in the biased tail', () => {
        expect(() => generateDicewarePassphrase(1, bytesFrom([0xffffffff]))).toThrow(/unbiased/);
    });

    it('draws uniformly across the list with the real crypto source', () => {
        const words = generateDicewarePassphrase(200).split(' ');
        expect(words).toHaveLength(200);
        expect(words.every((word) => DICEWARE_WORDLIST.includes(word))).toBe(true);
        // 200 draws from 7776 words repeating even once is already improbable;
        // a collapsed RNG (all-zero bytes, Math.random misuse) fails loudly here.
        expect(new Set(words).size).toBeGreaterThan(190);
    });
});
