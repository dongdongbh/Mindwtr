import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';


const REACT_HOOK_MODULES = new Set(['startup-prompts.ts', 'task-filter-selections.ts']);
const forbidden = (specifier: string, file: string): boolean => {
    if (/^(expo(-[\w-]+)?|@expo\/[\w-]+)(\/|$)/.test(specifier)) return true;
    if (/^(react-native(-[\w-]+)?|@react-native(-[\w-]+)?\/[\w-]+)(\/|$)/.test(specifier)) return true;
    if (/^whisper\.rn(\/|$)/.test(specifier)) return true;
    if (/^react(-dom)?(\/|$)/.test(specifier)) return !REACT_HOOK_MODULES.has(file);
    return false;
};


const offendersIn = (code: string, file: string): string[] => {

    const stripped = code.replace(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        (match, literal: string | undefined) => literal ?? '');
    const specifiers = [
        ...stripped.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g),
        ...stripped.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
        ...stripped.matchAll(/\b(?:import|require)\s*\(\s*(?:['"]([^'"]+)['"]|`([^`$]+)`)\s*\)/g),
    ].map((match) => (match[1] ?? match[2])!);
    return specifiers.filter((specifier) => forbidden(specifier, file)).map((specifier) => `${file}: ${specifier}`);
};

describe('core source', () => {
    it('never imports Expo, React Native or whisper.rn, and React only in its two shared hooks', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) { walk(path); continue; }
                if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
                offenders.push(...offendersIn(readFileSync(path, 'utf8'), relative(import.meta.dirname, path)));
            }
        };
        walk(import.meta.dirname);
        expect(offenders).toEqual([]);
    });


    it('catches a template-literal import and an import after a string that holds a comment opener', () => {
        expect(offendersIn('const w = await import(`whisper.rn`);', 'a.ts')).toEqual(['a.ts: whisper.rn']);
        expect(offendersIn("const glob = 'src/*.ts';\nimport { File } from 'expo-file-system';\nconst end = '*/';", 'b.ts'))
            .toEqual(['b.ts: expo-file-system']);
        expect(offendersIn("const url = 'https://example.com'; import 'react-native';", 'c.ts')).toEqual(['c.ts: react-native']);

        expect(offendersIn("/* import 'expo-audio'; */\n// import 'whisper.rn';\nimport { x } from './y';", 'd.ts')).toEqual([]);
    });
});
