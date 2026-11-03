import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';


const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{23E9}-\u{23FF}\u{FE0F}]/u;

describe('locale strings', () => {
    it('contain no emoji', () => {
        const dir = path.join(__dirname, 'locales');
        const offenders: string[] = [];
        for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
            readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, index) => {
                if (EMOJI.test(line)) offenders.push(`${file}:${index + 1}`);
            });
        }
        expect(offenders).toEqual([]);
    });
});
