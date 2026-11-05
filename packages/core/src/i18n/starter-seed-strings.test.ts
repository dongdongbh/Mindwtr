import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES } from './i18n-constants';
import { en } from './locales/en';
import { STARTER_SEED_STRINGS } from './starter-seed-strings';


describe('generated starter seed strings', () => {
    const starterKeys = Object.keys(en).filter((key) => key.startsWith('starter.'));

    it('covers every supported language', () => {
        expect(Object.keys(STARTER_SEED_STRINGS).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
    });

    it.each(Object.keys(STARTER_SEED_STRINGS))('gives %s every starter key with real copy', (language) => {
        const strings = STARTER_SEED_STRINGS[language as keyof typeof STARTER_SEED_STRINGS];
        expect(Object.keys(strings).sort()).toEqual([...starterKeys].sort());
        expect(Object.values(strings).filter((value) => !value)).toEqual([]);
    });
});
