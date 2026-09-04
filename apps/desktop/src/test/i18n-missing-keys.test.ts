import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { getTranslationsSync } from '@mindwtr/core';

// vitest runs with apps/desktop as the root; tolerate a repo-root invocation too.
const LOCAL_SRC = join(process.cwd(), 'src');
const SRC_ROOT = existsSync(LOCAL_SRC) ? LOCAL_SRC : join(process.cwd(), 'apps', 'desktop', 'src');

/**
 * A key that never reached en.ts is not a translation bug in one locale — it is
 * permanent English in all 20, and a silent one. `t()` returns the key itself on a
 * miss, so a call site that supplies its own inline fallback renders that fallback
 * forever and looks completely correct on screen while every locale file is
 * powerless to change it. Nothing else catches this: locale-parity.test.ts compares
 * locale files against en.ts, so a string that never became an en.ts key is outside
 * everything it checks.
 *
 * WHY THIS SCAN IS NOT A LIST OF WRAPPER NAMES
 *
 * Core's i18n-fallback-idiom.test.ts already scans both apps for `t()` and
 * `tFallback()`, and it was green while 18 keys were missing. The reason is that
 * almost every call site here goes through a locally-defined wrapper instead:
 * `translate`, `translateOr`, `translateOrFallback`, `resolveText`, `formatText`,
 * `resolveSyncText`, `tr`. Each is a fresh `useCallback` in one file, so a name
 * list is a list of the wrappers that existed the day it was written and goes
 * stale the next time somebody names one something else.
 *
 * So this matches the CALL SHAPE rather than the callee. Three rules, below. The
 * decisive one is rule 3: a key-shaped string literal immediately followed by a
 * prose string literal is the "key, English fallback" idiom no matter what the
 * function is called. Across 2050 matching desktop call sites it produced no false
 * positives; single-argument lookalikes that are not i18n (`files.get('a.b')`,
 * an `'audio.wav'` extension, an `'calendar.fill'` icon name) never pair with a
 * prose fallback and so never match.
 */
const KEY_SHAPE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** A fallback argument that reads as English copy rather than a flag like 'error'. */
const PROSE_SHAPE = /[A-Za-z]{2}/;
/**
 * Rule 1 is the one place a callee name is unavoidable: `translate('projects.reorderSections')`
 * and `iconName('trash.fill')` are the same shape, so only the name separates them. It is a
 * family pattern rather than a list for the reason above. Measured across both apps the only
 * names it actually matches are `t`, `tr` and `translate` — every hit is a real lookup, and
 * the icon-name and file-extension literals that share the key shape are not calls at all.
 */
const LOOKUP_NAME = /^(t|tr|translate\w*|resolve\w*|format\w*)$/;

const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'coverage', '__tests__', 'dist', 'build']);

/**
 * Keys that were already missing when this ratchet landed (2026-09-04), left as
 * English-only call sites in every locale. They are listed by name rather than
 * silently tolerated, and the stale-entry test below means the list can only ever
 * shrink: add the key to en.ts, delete the line here.
 *
 * These are whole features that never got i18n keys at all, not stragglers — the
 * Obsidian view (35), the People manager (11), saved filters (8), the Pomodoro
 * phase labels (3). Translating them is its own task; adding them to en.ts alone
 * would break locale parity for the five full-parity locales.
 */
const KNOWN_MISSING_KEYS = new Set([
    'board.reorderFollowsSort',
    'calendar.collapsePlanningPanel',
    'calendar.expandPlanningPanel',
    'common.clearSearch',
    'common.saving',
    'contexts.tags',
    'nav.obsidian',
    'obsidian.addTask',
    'obsidian.addTaskAction',
    'obsidian.addTaskHint',
    'obsidian.addTaskNotesHint',
    'obsidian.addTaskNotesPlaceholder',
    'obsidian.addTaskPlaceholder',
    'obsidian.completed',
    'obsidian.createFailed',
    'obsidian.dataviewBadge',
    'obsidian.disabledBody',
    'obsidian.disabledTitle',
    'obsidian.due',
    'obsidian.emptyBody',
    'obsidian.emptyTitle',
    'obsidian.inlineBadge',
    'obsidian.lastScanned',
    'obsidian.liveUpdatesUnavailable',
    'obsidian.manualRefreshOnly',
    'obsidian.markComplete',
    'obsidian.markIncomplete',
    'obsidian.neverScanned',
    'obsidian.notesCount',
    'obsidian.openFailed',
    'obsidian.openSettings',
    'obsidian.openTask',
    'obsidian.rescan',
    'obsidian.rescanning',
    'obsidian.scanSuccess',
    'obsidian.scheduled',
    'obsidian.setupBody',
    'obsidian.setupTitle',
    'obsidian.taskNotesBadge',
    'obsidian.tasksCount',
    'obsidian.toggleFailed',
    'obsidian.vaultPath',
    'obsidian.watching',
    'people.create',
    'people.empty',
    'people.name',
    'people.namePlaceholder',
    'people.note',
    'people.notePlaceholder',
    'people.openReference',
    'people.referenceLink',
    'people.referencePlaceholder',
    'pomodoro.phaseBreak',
    'pomodoro.phaseFocus',
    'pomodoro.switchPhase',
    'projects.expandSidebar',
    'projects.sequenceMode',
    'savedFilters.defaultName',
    'savedFilters.deleteTitle',
    'savedFilters.label',
    'savedFilters.namePlaceholder',
    'savedFilters.save',
    'savedFilters.saveDescription',
    'savedFilters.saveTitle',
    'settings.importTickTickSummary',
]);

function collectSourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) return [];
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return collectSourceFiles(full);
        if (!/\.tsx?$/.test(entry.name)) return [];
        if (/\.test\.tsx?$/.test(entry.name)) return [];
        return [full];
    });
}

function stringLiteralText(node: ts.Node | null | undefined): string | null {
    return node && ts.isStringLiteral(node) ? node.text : null;
}

/**
 * The key argument of `node`, if `node` is an i18n lookup:
 *  1. `t('key')` / `translate('key')` — a one-argument lookup, matched by callee name.
 *  2. `f(t, 'key', 'English')`  — the tFallback / translateWithFallback shape.
 *  3. `f('key', 'English')`     — any wrapper taking a key and an English fallback.
 * Anything built from a variable or a template literal is dynamic and unresolvable
 * without running the program; those call sites are out of scope here and are
 * covered instead by whatever union drives the interpolated value.
 */
function i18nKeyArgument(node: ts.CallExpression): ts.Expression | null {
    const args = node.arguments;
    const callee = node.expression;
    const calleeName = ts.isIdentifier(callee)
        ? String(callee.escapedText)
        : (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) ? String(callee.name.escapedText) : '');
    if (args.length === 1 && stringLiteralText(args[0]) && LOOKUP_NAME.test(calleeName)) {
        return args[0];
    }
    if (
        args.length >= 3
        && ts.isIdentifier(args[0]) && args[0].escapedText === 't'
        && stringLiteralText(args[1]) && stringLiteralText(args[2])
    ) {
        return args[1];
    }
    const fallback = stringLiteralText(args[1]);
    if (args.length >= 2 && stringLiteralText(args[0]) && fallback && PROSE_SHAPE.test(fallback)) {
        return args[0];
    }
    return null;
}

type Reference = { key: string; site: string };

function collectKeyReferences(): Reference[] {
    const references: Reference[] = [];
    for (const path of collectSourceFiles(SRC_ROOT)) {
        const sourceFile = ts.createSourceFile(
            path,
            readFileSync(path, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                const keyArgument = i18nKeyArgument(node);
                const key = stringLiteralText(keyArgument);
                if (key !== null && KEY_SHAPE.test(key)) {
                    const { line } = sourceFile.getLineAndCharacterOfPosition(keyArgument!.getStart(sourceFile));
                    const file = relative(SRC_ROOT, path).split('\\').join('/');
                    references.push({ key, site: `${file}:${line + 1}` });
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
    return references;
}

describe('desktop i18n keys', () => {
    const englishKeys = new Set(Object.keys(getTranslationsSync('en')));
    const references = collectKeyReferences();
    const missing = new Map<string, string>();
    for (const { key, site } of references) {
        if (!englishKeys.has(key) && !missing.has(key)) missing.set(key, site);
    }

    it('names only keys that exist in en.ts', () => {
        const unlisted = [...missing.entries()]
            .filter(([key]) => !KNOWN_MISSING_KEYS.has(key))
            .map(([key, site]) => `${key} (${site})`);
        expect(unlisted).toEqual([]);
    });

    // Without this the allowlist rots: an entry left behind after its key lands in
    // en.ts quietly re-opens the door for that key to be deleted again.
    it('keeps no stale entries in the known-missing list', () => {
        expect([...KNOWN_MISSING_KEYS].filter((key) => !missing.has(key))).toEqual([]);
    });

    // A refactor that renames the translator or changes the call shape would empty
    // the scan and leave both tests passing on nothing.
    // Parsing every desktop source file happens once, in the describe body above, so
    // it is collection time rather than test time and needs no raised timeout.
    it('still finds i18n call sites to check', () => {
        expect(references.length).toBeGreaterThanOrEqual(1500);
    });
});
