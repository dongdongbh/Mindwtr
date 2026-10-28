import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Core runs in the RN app, the desktop app, the native Android bundle (QuickJS) and the servers, so it never imports an app's
// runtime: Expo, React Native or whisper.rn (the voice rules moved here in pass V1 bind those through ports). React is allowed
// only in the two shared hooks that predate this guard; a new React import needs a reason, not a quiet addition here.
const REACT_HOOK_MODULES = new Set(['startup-prompts.ts', 'task-filter-selections.ts']);
const forbidden = (specifier: string, file: string): boolean => {
    if (/^(expo(-[\w-]+)?|@expo\/[\w-]+)(\/|$)/.test(specifier)) return true;
    if (/^(react-native(-[\w-]+)?|@react-native(-[\w-]+)?\/[\w-]+)(\/|$)/.test(specifier)) return true;
    if (/^whisper\.rn(\/|$)/.test(specifier)) return true;
    if (/^react(-dom)?(\/|$)/.test(specifier)) return !REACT_HOOK_MODULES.has(file);
    return false;
};

describe('core source', () => {
    it('never imports Expo, React Native or whisper.rn, and React only in its two shared hooks', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) { walk(path); continue; }
                if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
                const file = relative(import.meta.dirname, path);
                const code = readFileSync(path, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
                const specifiers = [
                    ...code.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g),
                    ...code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
                    ...code.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
                ].map((match) => match[1]!);
                for (const specifier of specifiers) {
                    if (forbidden(specifier, file)) offenders.push(`${file}: ${specifier}`);
                }
            }
        };
        walk(import.meta.dirname);
        expect(offenders).toEqual([]);
    });
});
