import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { getTranslationsSync } from '@mindwtr/core';


const LOCAL_SRC = join(process.cwd(), 'src');
const SRC_ROOT = existsSync(LOCAL_SRC) ? LOCAL_SRC : join(process.cwd(), 'apps', 'desktop', 'src');


const KEY_SHAPE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;


const LOOKUP_NAME = /^(t|tr|translate\w*|resolve\w*|format\w*)$/;

const NON_LOOKUP_NAMES = new Set(['markStartupPhase', 'measureStartupPhase', 'startActivityAsync']);

const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'coverage', '__tests__', 'dist', 'build']);


const KNOWN_MISSING_KEYS = new Set([
    'board.reorderFollowsSort',
    'bulk.organizeApplied',
    'calendar.collapsePlanningPanel',
    'calendar.expandPlanningPanel',
    'common.clearSearch',
    'common.saving',
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
    'projects.expandSidebar',
    'savedFilters.defaultName',
    'savedFilters.deleteTitle',
    'savedFilters.label',
    'savedFilters.save',
    'savedFilters.saveDescription',
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


function i18nKeyArgument(node: ts.CallExpression): ts.Expression | null {
    const args = node.arguments;
    const callee = node.expression;
    const calleeName = ts.isIdentifier(callee)
        ? String(callee.escapedText)
        : (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) ? String(callee.name.escapedText) : '');
    if (NON_LOOKUP_NAMES.has(calleeName)) return null;
    if (args.length === 1 && stringLiteralText(args[0]) && LOOKUP_NAME.test(calleeName)) {
        return args[0];
    }
    if (
        args.length >= 3
        && ts.isIdentifier(args[0]) && args[0].escapedText === 't'
        && KEY_SHAPE.test(stringLiteralText(args[1]) ?? '')
    ) {
        return args[1];
    }
    if (args.length >= 2 && KEY_SHAPE.test(stringLiteralText(args[0]) ?? '')) {
        return args[0];
    }
    return null;
}

type Reference = { key: string; site: string };

function scanKeyReferences(path: string, source: string): Reference[] {
    const references: Reference[] = [];
    const sourceFile = ts.createSourceFile(
        path,
        source,
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
    return references;
}

function collectKeyReferences(): Reference[] {
    return collectSourceFiles(SRC_ROOT).flatMap((path) => scanKeyReferences(path, readFileSync(path, 'utf8')));
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


    it('keeps no stale entries in the known-missing list', () => {
        expect([...KNOWN_MISSING_KEYS].filter((key) => !missing.has(key))).toEqual([]);
    });


    it('still finds i18n call sites to check', () => {
        expect(references.length).toBeGreaterThanOrEqual(1500);
    });
});

describe('i18n scanner computed fallbacks', () => {
    it('ignores diagnostic identifiers, Android intents and dynamic keys', () => {
        const source = `
            markStartupPhase('js.data_load.attempt_start', { attempt: 1 });
            measureStartupPhase('js.store.fetch_data', async () => load());
            IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: uri });
            resolveText(dynamicKey, fallbackText);
            iconName('trash.fill');
        `;
        expect(scanKeyReferences(join(SRC_ROOT, 'fixture.ts'), source)).toEqual([]);
    });

    it.each([
        "resolveText('closure.missingInline', `${n} matches`)",
        "tFallback(t, 'closure.missingVariable', fallbackText)",
    ])('recognizes a literal key in %s', (source) => {
        const references = scanKeyReferences(join(SRC_ROOT, 'fixture.ts'), source);
        expect(references).toEqual([{
            key: source.includes('missingInline') ? 'closure.missingInline' : 'closure.missingVariable',
            site: 'fixture.ts:1',
        }]);
        expect(Object.keys(getTranslationsSync('en'))).not.toContain(references[0]?.key);
    });
});
