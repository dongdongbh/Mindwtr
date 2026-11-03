import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';


const LOCAL_SRC = join(process.cwd(), 'src');
const SRC_ROOT = existsSync(LOCAL_SRC) ? LOCAL_SRC : join(process.cwd(), 'apps', 'desktop', 'src');


const ALLOWED_LITERAL_TOASTS = new Map<string, string>();


const TRANSLATOR_CALL = /\b(t|translate|tFallback|translateWithFallback|resolve[A-Z]\w*|format[A-Z]\w*)\s*\(/;

function collectSourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return collectSourceFiles(full);
        if (!/\.tsx?$/.test(entry.name)) return [];
        if (/\.test\.tsx?$/.test(entry.name)) return [];
        return [full];
    });
}


function firstArguments(source: string): string[] {
    const args: string[] = [];
    const call = /showToast\(/g;
    let match: RegExpExecArray | null;
    while ((match = call.exec(source)) !== null) {
        let depth = 0;
        let quote: string | null = null;
        let index = match.index + match[0].length;
        const start = index;
        for (; index < source.length; index += 1) {
            const char = source[index];
            if (quote) {
                if (char === '\\') index += 1;
                else if (char === quote) quote = null;
                continue;
            }
            if (char === "'" || char === '"' || char === '`') quote = char;
            else if (char === '(' || char === '[' || char === '{') depth += 1;
            else if (char === ')' && depth === 0) break;
            else if (char === ')' || char === ']' || char === '}') depth -= 1;
            else if (char === ',' && depth === 0) break;
        }
        args.push(source.slice(start, index));
    }
    return args;
}


function hasProseLiteral(argument: string): boolean {
    const code = argument.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    const literals = code.match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? [];
    return literals.some((literal) => /[A-Za-z]/.test(literal.slice(1, -1).replace(/\$\{[^}]*\}/g, '')));
}

describe('desktop toasts', () => {
    const offenders = collectSourceFiles(SRC_ROOT)
        .filter((file) => {
            const source = readFileSync(file, 'utf8');
            return firstArguments(source).some((argument) => (
                hasProseLiteral(argument) && !TRANSLATOR_CALL.test(argument)
            ));
        })
        .map((file) => relative(SRC_ROOT, file).split('\\').join('/'));

    it('never pass user-facing English straight to showToast', () => {
        expect(offenders.filter((file) => !ALLOWED_LITERAL_TOASTS.has(file))).toEqual([]);
    });


    it('keeps no stale exclusions', () => {
        expect([...ALLOWED_LITERAL_TOASTS.keys()].filter((file) => !offenders.includes(file))).toEqual([]);
    });


    it('still finds showToast calls to check', () => {
        const scanned = collectSourceFiles(SRC_ROOT)
            .reduce((total, file) => total + firstArguments(readFileSync(file, 'utf8')).length, 0);
        expect(scanned).toBeGreaterThanOrEqual(60);
    });
});
