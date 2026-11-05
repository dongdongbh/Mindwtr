import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';


const LOCAL_SRC = join(process.cwd(), 'src');
const SRC_ROOT = existsSync(LOCAL_SRC) ? LOCAL_SRC : join(process.cwd(), 'apps', 'desktop', 'src');


function collectSourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return collectSourceFiles(full);
        if (!/\.tsx?$/.test(entry.name)) return [];
        if (/\.test\.tsx?$/.test(entry.name)) return [];
        return [full];
    });
}


const MEASURED_ELEMENT = /<[a-zA-Z][^<>]*?ref=\{[^}]*measureElement[^}]*\}[^<>]*?>/gs;

describe('virtualized rows registered for re-measurement', () => {
    const sites = collectSourceFiles(SRC_ROOT).flatMap((file) => (
        (readFileSync(file, 'utf8').match(MEASURED_ELEMENT) ?? []).map((element) => ({
            file: relative(SRC_ROOT, file).split('\\').join('/'),
            hasDataIndex: element.includes('data-index='),
        }))
    ));

    it('all carry the data-index the virtualizer resolves them by (#825)', () => {
        expect(sites.filter((site) => !site.hasDataIndex).map((site) => site.file)).toEqual([]);
    });


    it('still finds every measureElement site', () => {
        expect(sites.length).toBeGreaterThanOrEqual(6);
    });
});
