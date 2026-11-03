import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';


const mobileRoot = path.resolve(__dirname, '..');
const coreSrc = path.resolve(mobileRoot, '../../packages/core/src');
const METRO_OWN_SUBPATHS = new Set(['share-card']);

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.') || name === 'android' || name === 'ios') return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
});

describe('@mindwtr/core subpath imports', () => {
    it('name values the core barrel holds too, as Metro resolves them', async () => {
        const barrel: Record<string, unknown> = await import(path.join(coreSrc, 'index.ts'));
        const problems: string[] = [];
        for (const file of sourceFiles(mobileRoot)) {
            const source = readFileSync(file, 'utf8');
            for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'@mindwtr\/core\/([^']+)'/g)) {
                if (match[1] || METRO_OWN_SUBPATHS.has(match[3])) continue;
                const subpath: Record<string, unknown> = await import(path.join(coreSrc, `${match[3]}.ts`));
                for (const specifier of match[2].split(',').map((part) => part.trim())) {
                    if (!specifier || specifier.startsWith('type ')) continue;
                    const name = specifier.split(/\s+as\s+/)[0].trim();
                    if (!(name in barrel)) problems.push(`${path.relative(mobileRoot, file)}: ${name} (${match[3]}) is not in the barrel`);
                    else if (barrel[name] !== subpath[name]) problems.push(`${path.relative(mobileRoot, file)}: ${name} (${match[3]}) differs in the barrel`);
                }
            }
        }
        expect(problems).toEqual([]);
    }, 120_000);
});
