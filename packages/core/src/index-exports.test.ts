import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import exportsBaseline from './index-exports.baseline.json';


const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(srcDir, '..', '..', '..');
const packageJson = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
};

describe('barrel export surface', () => {
    it('is a superset of the committed baseline', () => {
        const currentNames = new Set(Object.keys(barrel));
        const missing = (exportsBaseline as string[]).filter((name) => !currentNames.has(name));
        expect(missing).toEqual([]);
    });
});

describe('package.json exports map', () => {
    it('points every subpath at a file that exists on disk', () => {
        const dangling = Object.entries(packageJson.exports)
            .filter(([, target]) => !existsSync(join(srcDir, '..', target)))
            .map(([subpath, target]) => `${subpath} -> ${target}`);
        expect(dangling).toEqual([]);
    });
});


const SKIP_DIRS = new Set([
    'node_modules', 'dist', 'build', 'coverage', '.expo', '.git', '.gradle', 'target', 'ios', 'android',
]);

function collectSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) files.push(...collectSourceFiles(join(dir, entry.name)));
            continue;
        }
        if (/\.tsx?$/.test(entry.name)) files.push(join(dir, entry.name));
    }
    return files;
}

function findImportedSubpaths(root: string): Set<string> {
    const subpaths = new Set<string>();
    const pattern = /@mindwtr\/core\/([A-Za-z0-9_/-]+)/g;
    for (const file of collectSourceFiles(root)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(pattern)) subpaths.add(match[1]);
    }
    return subpaths;
}

describe('@mindwtr/core subpath imports under apps/', () => {
    it('are all barrel-reachable', async () => {
        const barrelNames = new Set(Object.keys(barrel));
        const subpaths = findImportedSubpaths(join(repoRoot, 'apps'));


        expect(subpaths.size).toBeGreaterThan(0);

        const unreachable: string[] = [];
        for (const subpath of subpaths) {
            const base = join(srcDir, subpath);
            const modulePath = existsSync(`${base}.ts`) ? `${base}.ts` : join(base, 'index.ts');
            const moduleExports = await import(modulePath);
            for (const name of Object.keys(moduleExports)) {
                if (!barrelNames.has(name)) unreachable.push(`@mindwtr/core/${subpath}: ${name}`);
            }
        }
        expect(unreachable).toEqual([]);


    }, 60_000);
});
