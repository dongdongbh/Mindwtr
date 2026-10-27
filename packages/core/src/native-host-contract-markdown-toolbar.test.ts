import { describe, expect, it } from 'vitest';
import { applyMarkdownToolbarAction, MARKDOWN_TOOLBAR_ACTIONS } from './markdown';
import { createNativeHostContract } from './native-host-contract';

// The Android expanded editor's Markdown toolbar (RN's MarkdownFormatToolbar): core's actions with RN's labels, and each
// action on the editor's text and selection. Both are reads; nothing is written.
describe('the native Markdown toolbar', () => {
    it('lists core\'s actions in RN\'s order with RN\'s labels, falling back as translateWithFallback does', async () => {
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        const reply = host.getMarkdownToolbarActions();
        expect(reply.ok).toBe(true);
        if (!reply.ok) return;
        expect(reply.value.actions.map((action) => action.id)).toEqual(MARKDOWN_TOOLBAR_ACTIONS.map((action) => action.id));
        expect(reply.value.actions.slice(0, 2)).toEqual([{ id: 'heading', label: 'Insert heading', shortLabel: 'H1' }, { id: 'bold', label: 'Bold', shortLabel: 'B' }]);
        // en.ts now has its own text, the same as core's fallback label.
        expect(reply.value.actions.find((action) => action.id === 'quote')?.label).toBe('Quote');
        expect(reply.value.undoLabel).toBe('Undo');
    });

    it('applies one action to the text and selection as core\'s applyMarkdownToolbarAction does', () => {
        const host = createNativeHostContract();
        expect(host.applyMarkdownToolbar({ value: 'pack the boxes', start: 5, end: 8, action: 'bold' }))
            .toEqual({ ok: true, value: { value: 'pack **the** boxes', start: 7, end: 10 } });
        for (const action of MARKDOWN_TOOLBAR_ACTIONS) {
            const { value, selection } = applyMarkdownToolbarAction('one\ntwo', { start: 1, end: 6 }, action.id);
            expect(host.applyMarkdownToolbar({ value: 'one\ntwo', start: 1, end: 6, action: action.id }))
                .toEqual({ ok: true, value: { value, start: selection.start, end: selection.end } });
        }
    });

    it('refuses an unknown action or a selection outside the text', () => {
        const host = createNativeHostContract();
        for (const input of [null, {}, { value: 'a', start: 0, end: 0, action: 'underline' }, { value: 'a', start: 0, end: 2, action: 'bold' },
            { value: 'a', start: 1, end: 0, action: 'bold' }, { value: 'a', start: 0.5, end: 1, action: 'bold' }, { value: 1, start: 0, end: 0, action: 'bold' }]) {
            expect(host.applyMarkdownToolbar(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });
});
