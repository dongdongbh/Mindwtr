import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';


const LOCAL_SRC = join(process.cwd(), 'src');
const SRC_ROOT = existsSync(LOCAL_SRC) ? LOCAL_SRC : join(process.cwd(), 'apps', 'desktop', 'src');


const ALLOWED_OVERLAY_FILES = new Map<string, string>([
    ['components/ui/Dialog.tsx', 'the module itself'],
    ['components/AppLockGate.tsx', 'the privacy lock screen is not a dismissable dialog: no Escape, no click-outside, and it must cover every Dialog'],
]);

function collectSourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return collectSourceFiles(full);
        if (!/\.tsx?$/.test(entry.name)) return [];
        if (/\.test\.tsx?$/.test(entry.name)) return [];
        return [full];
    });
}

describe('desktop modal overlays', () => {
    const offenders = collectSourceFiles(SRC_ROOT)
        .filter((file) => readFileSync(file, 'utf8').includes('fixed inset-0'))
        .map((file) => relative(SRC_ROOT, file).split('\\').join('/'));

    it('all go through the Dialog module', () => {
        expect(offenders.filter((file) => !ALLOWED_OVERLAY_FILES.has(file))).toEqual([]);
    });


    it('keeps no stale exclusions', () => {
        expect([...ALLOWED_OVERLAY_FILES.keys()].filter((file) => !offenders.includes(file))).toEqual([]);
    });
});
