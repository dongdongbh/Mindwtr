import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import * as ts from 'typescript';
import { en } from './locales/en';


const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const APP_ROOTS = [
    join(REPO_ROOT, 'apps/desktop/src'),
    join(REPO_ROOT, 'apps/mobile'),
];
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'coverage', '__tests__', '.expo', 'ios', 'android']);

type SourceFileEntry = { path: string; sourceFile: ts.SourceFile };

function collectSourceFiles(): SourceFileEntry[] {
    const files: SourceFileEntry[] = [];
    function walk(dir: string) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.tsx?$/.test(entry.name)) continue;
            if (/\.test\.tsx?$/.test(entry.name)) continue;
            const text = readFileSync(full, 'utf8');
            const sourceFile = ts.createSourceFile(
                full,
                text,
                ts.ScriptTarget.Latest,
                true,
                entry.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            );
            files.push({ path: full, sourceFile });
        }
    }
    for (const root of APP_ROOTS) walk(root);
    return files;
}

function unwrapParens(node: ts.Expression): ts.Expression {
    let current = node;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
}


function asTCall(node: ts.Expression): ts.CallExpression | null {
    const unwrapped = unwrapParens(node);
    if (
        ts.isCallExpression(unwrapped)
        && ts.isIdentifier(unwrapped.expression)
        && unwrapped.expression.escapedText === 't'
        && unwrapped.arguments.length === 1
    ) {
        return unwrapped;
    }
    return null;
}

function isOrIdiom(node: ts.Node): node is ts.BinaryExpression {
    return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken;
}


function isChainHead(node: ts.BinaryExpression): boolean {
    const parent = node.parent;
    return !(parent && isOrIdiom(parent) && parent.left === node);
}

function flattenOrChain(node: ts.BinaryExpression): ts.Expression[] {
    if (isOrIdiom(node.left)) return [...flattenOrChain(node.left), node.right];
    return [node.left, node.right];
}

describe('i18n fallback idiom ratchet', () => {
    it('keeps the dead t(key) || fallback idiom out of apps/desktop and apps/mobile source', () => {


        const EXCLUDED_FILES = new Set<string>();

        const violations: string[] = [];
        for (const { path, sourceFile } of collectSourceFiles()) {
            if (EXCLUDED_FILES.has(path)) continue;
            const visit = (node: ts.Node) => {
                if (isOrIdiom(node) && isChainHead(node)) {
                    const operands = flattenOrChain(node);
                    const firstTIndex = operands.findIndex((operand) => asTCall(operand) !== null);
                    if (firstTIndex !== -1 && firstTIndex < operands.length - 1) {
                        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                        const snippet = node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 120);
                        violations.push(`${path}:${line + 1}  ${snippet}`);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
        }

        expect(violations).toEqual([]);


    }, 60_000);

    it('keeps app-local "what do I show on a miss" policies out of apps/desktop and apps/mobile source', () => {


        const violations: string[] = [];
        for (const { path, sourceFile } of collectSourceFiles()) {
            const visit = (node: ts.Node) => {
                if (ts.isFunctionLike(node) && node.body) {
                    let readsEnglish = false;
                    let readsT = false;
                    const scan = (inner: ts.Node) => {
                        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
                            if (inner.expression.escapedText === 'getEnglishI18nValue') readsEnglish = true;
                            if (asTCall(inner)) readsT = true;
                        }
                        ts.forEachChild(inner, scan);
                    };
                    scan(node.body);
                    if (readsEnglish && readsT) {
                        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                        violations.push(`${path}:${line + 1}`);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
        }


        expect(violations).toEqual([]);

    }, 60_000);

    it('keeps hand-rolled locale-dictionary fallbacks out of apps/desktop and apps/mobile source', () => {


        const violations: string[] = [];
        for (const { path, sourceFile } of collectSourceFiles()) {
            let calls = 0;
            const visit = (node: ts.Node) => {
                if (
                    ts.isCallExpression(node)
                    && ts.isIdentifier(node.expression)
                    && node.expression.escapedText === 'getTranslationsSync'
                ) {
                    calls += 1;
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
            if (calls > 1) violations.push(`${path}  (${calls} getTranslationsSync reads)`);
        }

        expect(violations).toEqual([]);

    }, 60_000);

    it('keeps every statically-referenced i18n key present in en.ts', () => {


        const enKeys = new Set(Object.keys(en));
        const missing = new Map<string, string>();

        function staticStringValue(node: ts.Expression): string | null {
            if (ts.isStringLiteralLike(node)) return node.text;
            return null;
        }

        for (const { path, sourceFile } of collectSourceFiles()) {
            const visit = (node: ts.Node) => {
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                    const name = node.expression.escapedText;
                    let keyArg: ts.Expression | undefined;
                    if (name === 't' && node.arguments.length === 1) keyArg = node.arguments[0];
                    else if ((name === 'tFallback' || name === 'translateWithFallback') && node.arguments.length === 3) keyArg = node.arguments[1];
                    if (keyArg) {
                        const key = staticStringValue(keyArg);
                        if (key !== null && !enKeys.has(key) && !missing.has(key)) {
                            const { line } = sourceFile.getLineAndCharacterOfPosition(keyArg.getStart(sourceFile));
                            missing.set(key, `${path}:${line + 1}`);
                        }
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
        }

        const report = [...missing.entries()].map(([key, site]) => `${key} (${site})`);
        expect(report).toEqual([]);

    }, 60_000);
});
