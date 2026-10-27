import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureDateFormatting } from './date';
import { runQuickAddCorpus } from './quick-add-chrono-corpus.fixture';

// Quick-add's date parsing, frozen across every language chrono-node parses here (and English with each date order), from before
// chrono-node was loaded per locale on first use (native start-up, about 18 ms). Each case's whole result must stay the same.
// Regenerate only on purpose: UPDATE_QUICKADD_CORPUS=1.

const corpusFile = join(dirname(fileURLToPath(import.meta.url)), 'quick-add-chrono-corpus.json');

describe('quick-add date parsing corpus (every chrono language)', () => {
    // Frozen in UTC, as task-row-meta.test.ts pins its zone.
    const originalTz = process.env.TZ;
    beforeAll(() => { process.env.TZ = 'UTC'; });
    afterAll(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });
    afterEach(() => configureDateFormatting({}));

    it('parses every case exactly as before chrono-node loaded per locale', () => {
        const cases = runQuickAddCorpus();
        if (process.env.UPDATE_QUICKADD_CORPUS === '1') writeFileSync(corpusFile, `${JSON.stringify(cases, null, 1)}\n`);
        const frozen = JSON.parse(readFileSync(corpusFile, 'utf8')) as typeof cases;
        expect(cases.length).toBe(frozen.length);
        for (let index = 0; index < cases.length; index += 1) expect(cases[index], `${cases[index].language} ${cases[index].input}`).toEqual(frozen[index]);
        // The corpus exercises chrono: dates were found in every chrono language.
        for (const language of ['en', 'de', 'es', 'fr', 'it', 'ja', 'nl', 'pt', 'ru', 'sv', 'zh', 'zh-Hant']) {
            expect(cases.some((c) => c.language === language && (c.result.detectedDate || c.result.props?.dueDate)), language).toBe(true);
        }
    }, 60_000);
});
