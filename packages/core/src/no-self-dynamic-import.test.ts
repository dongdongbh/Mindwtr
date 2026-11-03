import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';


describe('core source', () => {
    it('never imports its own modules at run time, except the locale loaders', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) { walk(path); continue; }
                if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
                const code = readFileSync(path, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
                for (const match of code.matchAll(/(?<![\w.])import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {

                    const before = code.slice(Math.max(0, match.index - 8), match.index);
                    if (/typeof\s*$|[:<,|]\s*$/.test(before)) continue;
                    if (/^\.\/locales\//.test(match[1])) continue;
                    offenders.push(`${path}: ${match[0]}`);
                }
            }
        };
        walk(import.meta.dirname);
        expect(offenders).toEqual([]);
    });
});
