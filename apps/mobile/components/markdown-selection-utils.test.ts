import { describe, expect, it } from 'vitest';

import {
    applyMarkdownPairInsertionWithSelectionFallback,
    applyMarkdownUrlPasteWithSelectionFallback,
    createIgnoredNativePairChangeFromTextChange,
    shouldIgnoreNativePairChange,
} from './markdown-selection-utils';

describe('markdown selection replacement fallbacks', () => {
    it('recognizes duplicate native pair changes after a text change applies the pair', () => {
        const paired = applyMarkdownPairInsertionWithSelectionFallback(
            '',
            '(',
            { start: 0, end: 0 },
        );
        expect(paired?.result).toEqual({
            value: '()',
            selection: { start: 1, end: 1 },
        });

        const ignored = createIgnoredNativePairChangeFromTextChange(
            '',
            '(',
            paired!.baseSelection,
            paired!.result,
        );
        expect(ignored).not.toBeNull();

        expect(shouldIgnoreNativePairChange('(', '()', ignored!)).toBe(true);
        expect(shouldIgnoreNativePairChange('(()', '()', ignored!)).toBe(true);
        expect(shouldIgnoreNativePairChange('(())', '()', ignored!)).toBe(true);
        expect(shouldIgnoreNativePairChange('()a', '()', ignored!)).toBe(false);
    });

    it('uses the last range selection when mobile paste collapses the current selection first', () => {
        expect(
            applyMarkdownUrlPasteWithSelectionFallback(
                'read docs today',
                'read https://example.com today',
                { start: 24, end: 24 },
                { start: 5, end: 9 },
            ),
        ).toEqual({
            result: {
                value: 'read [docs](https://example.com) today',
                selection: { start: 32, end: 32 },
            },
            baseSelection: { start: 5, end: 9 },
        });
    });

    it('does not use a stale range when the text change is not a matching replacement', () => {
        expect(
            applyMarkdownUrlPasteWithSelectionFallback(
                'read docs today',
                'read docs today https://example.com',
                { start: 35, end: 35 },
                { start: 5, end: 9 },
            ),
        ).toBeNull();
    });

    it('wraps selected text when the native change replaces the current range', () => {
        expect(
            applyMarkdownPairInsertionWithSelectionFallback(
                'read docs',
                'read [',
                { start: 5, end: 9 },
            ),
        ).toEqual({
            result: {
                value: 'read [docs]',
                selection: { start: 6, end: 10 },
            },
            baseSelection: { start: 5, end: 9 },
        });
    });

    it('also keeps pair insertion working when selection collapses before the text change', () => {
        expect(
            applyMarkdownPairInsertionWithSelectionFallback(
                'read docs',
                'read [',
                { start: 6, end: 6 },
                { start: 5, end: 9 },
            ),
        ).toEqual({
            result: {
                value: 'read [docs]',
                selection: { start: 6, end: 10 },
            },
            baseSelection: { start: 5, end: 9 },
        });
    });

    it('wraps selected text from a mobile quote text change', () => {
        expect(
            applyMarkdownPairInsertionWithSelectionFallback(
                'read docs',
                'read "',
                { start: 5, end: 9 },
            ),
        ).toEqual({
            result: {
                value: 'read "docs"',
                selection: { start: 6, end: 10 },
            },
            baseSelection: { start: 5, end: 9 },
        });
    });

    it('wraps selected text from a mobile backtick text change', () => {
        expect(
            applyMarkdownPairInsertionWithSelectionFallback(
                'run tests',
                '`',
                { start: 0, end: 9 },
            ),
        ).toEqual({
            result: {
                value: '`run tests`',
                selection: { start: 1, end: 10 },
            },
            baseSelection: { start: 0, end: 9 },
        });
    });

    it('escalates repeated backtick wraps into a fenced code block', () => {
        const once = applyMarkdownPairInsertionWithSelectionFallback(
            'run tests',
            '`',
            { start: 0, end: 9 },
        );
        expect(once).toEqual({
            result: {
                value: '`run tests`',
                selection: { start: 1, end: 10 },
            },
            baseSelection: { start: 0, end: 9 },
        });


        const twice = applyMarkdownPairInsertionWithSelectionFallback(
            once!.result.value,
            '```',
            once!.result.selection,
        );
        expect(twice).toEqual({
            result: {
                value: '``run tests``',
                selection: { start: 2, end: 11 },
            },
            baseSelection: { start: 1, end: 10 },
        });

        expect(
            applyMarkdownPairInsertionWithSelectionFallback(
                twice!.result.value,
                '`````',
                twice!.result.selection,
            ),
        ).toEqual({
            result: {
                value: '```\nrun tests\n```',
                selection: { start: 4, end: 13 },
            },
            baseSelection: { start: 2, end: 11 },
        });
    });

    it('creates a fenced code block from collapsed mobile triple-backtick text changes', () => {
        const once = applyMarkdownPairInsertionWithSelectionFallback(
            '',
            '`',
            { start: 0, end: 0 },
        );
        expect(once).toEqual({
            result: {
                value: '``',
                selection: { start: 1, end: 1 },
            },
            baseSelection: { start: 0, end: 0 },
        });


        const twice = applyMarkdownPairInsertionWithSelectionFallback(
            once!.result.value,
            '```',
            once!.result.selection,
        );
        expect(twice).toEqual({
            result: {
                value: '``',
                selection: { start: 2, end: 2 },
            },
            baseSelection: { start: 1, end: 1 },
        });

        expect(
            applyMarkdownPairInsertionWithSelectionFallback(
                twice!.result.value,
                '```',
                twice!.result.selection,
            ),
        ).toEqual({
            result: {
                value: '```\n\n```',
                selection: { start: 4, end: 4 },
            },
            baseSelection: { start: 2, end: 2 },
        });
    });

    it('wraps selected text from a mobile triple-backtick text change', () => {
        expect(
            applyMarkdownPairInsertionWithSelectionFallback(
                'run tests',
                '```',
                { start: 0, end: 9 },
            ),
        ).toEqual({
            result: {
                value: '```\nrun tests\n```',
                selection: { start: 4, end: 13 },
            },
            baseSelection: { start: 0, end: 9 },
        });
    });

    it('auto-pairs a mobile text change when native selection has already advanced', () => {
        expect(
            applyMarkdownPairInsertionWithSelectionFallback(
                'read docs',
                'read [docs',
                { start: 6, end: 6 },
            ),
        ).toEqual({
            result: {
                value: 'read []docs',
                selection: { start: 6, end: 6 },
            },
            baseSelection: { start: 6, end: 6 },
        });
    });

    it('ignores non-pair mobile text changes', () => {
        expect(
            applyMarkdownPairInsertionWithSelectionFallback(
                'read docs',
                'read adocs',
                { start: 5, end: 5 },
            ),
        ).toBeNull();
    });

    it('skips every fallback helper when editor assist is disabled', () => {
        const assistOff = { assist: false };
        expect(
            applyMarkdownUrlPasteWithSelectionFallback(
                'read docs today',
                'read https://example.com today',
                { start: 24, end: 24 },
                { start: 5, end: 9 },
                assistOff,
            ),
        ).toBeNull();
        expect(
            applyMarkdownPairInsertionWithSelectionFallback(
                'read docs',
                'read [',
                { start: 6, end: 6 },
                { start: 5, end: 9 },
                assistOff,
            ),
        ).toBeNull();
    });
});
