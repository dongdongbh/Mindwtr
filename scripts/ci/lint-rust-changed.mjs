#!/usr/bin/env node
// rustfmt on changed lines only: `bun run lint:rust:changed <base-commit>`.
// Each .rs file changed since <base> (working tree included) is formatted in memory; only a
// formatting difference that overlaps a line changed since <base> fails. Older unformatted code
// elsewhere in the file is left alone. rustfmt has no line-range mode on stable, hence the overlap.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `@@ -a,b +c,d @@` hunks of a unified diff, as 1-based [start, end] line ranges on one side. */
export const hunkRanges = (diff, side) => {
    const ranges = [];
    for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(side === 'old' ? match[1] : match[3]);
        const count = Number((side === 'old' ? match[2] : match[4]) ?? 1);
        // A pure insertion or deletion sits after line `start`: count the line it touches.
        ranges.push(count === 0 ? [Math.max(start, 1), Math.max(start, 1)] : [start, start + count - 1]);
    }
    return ranges;
};

export const overlaps = (left, right) => left.some(([a, b]) => right.some(([c, d]) => a <= d && c <= b));

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const editionFor = (file) => {
    for (let dir = dirname(file); ; dir = dirname(dir)) {
        const manifest = join(dir, 'Cargo.toml');
        if (existsSync(manifest)) return /^edition\s*=\s*"(\d+)"/m.exec(readFileSync(manifest, 'utf8'))?.[1] ?? '2021';
        if (dirname(dir) === dir) return '2021';
    }
};

/** Formatting differences of `file` that touch lines changed since `base`, as old-side ranges. */
const offendingRanges = (root, base, file) => {
    const changed = hunkRanges(git(['-C', root, 'diff', '-U0', base, '--', file]), 'new');
    if (changed.length === 0) return [];
    const path = join(root, file);
    const source = readFileSync(path, 'utf8');
    // stdin: rustfmt neither follows `mod x;` into other files nor writes anything.
    const formatted = spawnSync('rustfmt', ['--edition', editionFor(path), '--emit', 'stdout', '--quiet'], {
        cwd: dirname(path), input: source, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (formatted.status !== 0) throw new Error(`rustfmt failed on ${file}:\n${formatted.stderr}`);
    if (formatted.stdout === source) return [];
    const diff = spawnSync('git', ['diff', '--no-index', '-U0', '--', '-', path], { input: formatted.stdout, encoding: 'utf8' });
    // `git diff --no-index a b` compares a -> b; here "-" (formatted) -> file, so the file is the new side.
    return hunkRanges(diff.stdout, 'new').filter((range) => overlaps([range], changed));
};

const main = () => {
    const base = process.argv[2];
    if (!base) {
        console.error('Usage: bun run lint:rust:changed <base-commit>');
        process.exit(2);
    }
    const root = git(['rev-parse', '--show-toplevel']).trim();
    const files = git(['-C', root, 'diff', '--name-only', '--diff-filter=ACMR', base, '--', '*.rs']).split('\n').filter(Boolean);
    let failed = false;
    for (const file of files) {
        for (const [start, end] of offendingRanges(root, base, file)) {
            failed = true;
            console.error(`${file}:${start}${end > start ? `-${end}` : ''}: not rustfmt-formatted (changed since ${base})`);
        }
    }
    if (failed) {
        console.error('Run rustfmt on these lines (or the file, keeping unrelated hunks out of the commit).');
        process.exit(1);
    }
    console.log(`rustfmt: ${files.length} changed .rs file(s) clean on changed lines since ${base}`);
};

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') main();
