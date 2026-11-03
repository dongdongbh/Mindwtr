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
        return [full];
    });
}

describe('desktop source files', () => {
    it('contain no NUL bytes', () => {
        const offenders = collectSourceFiles(SRC_ROOT)
            .filter((file) => readFileSync(file, 'utf8').includes('\0'))
            .map((file) => relative(SRC_ROOT, file).split('\\').join('/'));
        expect(offenders).toEqual([]);
    });
});
