import { describe, expect, it } from 'vitest';
import { applyMarkdownToolbarAction, MARKDOWN_TOOLBAR_ACTIONS } from './markdown';
import { createNativeHostContract } from './native-host-contract';
import { useTaskStore } from './store';


describe('the native Markdown toolbar', () => {
    it('lists core\'s actions in RN\'s order with RN\'s labels, falling back as translateWithFallback does', async () => {
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        const reply = host.getMarkdownToolbarActions();
        expect(reply.ok).toBe(true);
        if (!reply.ok) return;
        expect(reply.value.actions.map((action) => action.id)).toEqual(MARKDOWN_TOOLBAR_ACTIONS.map((action) => action.id));
        expect(reply.value.actions.slice(0, 2)).toEqual([{ id: 'heading', label: 'Insert heading', shortLabel: 'H1' }, { id: 'bold', label: 'Bold', shortLabel: 'B' }]);

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

    it('pairs, links and continues one typed edit as RN\'s task description does, and only continues project notes', () => {
        const host = createNativeHostContract();
        const change = (previous: string, next: string, start: number, end: number, pairs = true) =>
            host.applyMarkdownTextChange({ previous, next, start, end, pairs });
        expect(change('a', 'a[', 1, 1)).toEqual({ ok: true, value: { changed: true, value: 'a[]', start: 2, end: 2 } });
        expect(change('see note', 'see [', 4, 8)).toEqual({ ok: true, value: { changed: true, value: 'see [note]', start: 5, end: 9 } });
        expect(change('a]', 'a]]', 1, 1)).toEqual({ ok: true, value: { changed: true, value: 'a]', start: 2, end: 2 } });
        expect(change('docs', 'https://mindwtr.app', 0, 4))
            .toEqual({ ok: true, value: { changed: true, value: '[docs](https://mindwtr.app)', start: 27, end: 27 } });
        expect(change('- milk', '- milk\n', 6, 6)).toEqual({ ok: true, value: { changed: true, value: '- milk\n- ', start: 9, end: 9 } });
        expect(change('1. one', '1. one\n', 6, 6)).toEqual({ ok: true, value: { changed: true, value: '1. one\n2. ', start: 10, end: 10 } });
        expect(change('- [x] done', '- [x] done\n', 10, 10)).toEqual({ ok: true, value: { changed: true, value: '- [x] done\n- [ ] ', start: 17, end: 17 } });
        expect(change('a', 'a[', 1, 1, false)).toEqual({ ok: true, value: { changed: false, value: 'a[', start: 1, end: 1 } });
        expect(change('- milk', '- milk\n', 6, 6, false)).toEqual({ ok: true, value: { changed: true, value: '- milk\n- ', start: 9, end: 9 } });
        expect(change('plain', 'plainx', 5, 5)).toEqual({ ok: true, value: { changed: false, value: 'plainx', start: 5, end: 5 } });
    });

    it('leaves every typed edit alone when Markdown editor assist is off', () => {
        const host = createNativeHostContract();
        const settings = useTaskStore.getState().settings;
        useTaskStore.setState({ settings: { ...settings, markdownEditorAssist: false } });
        try {
            expect(host.applyMarkdownTextChange({ previous: 'a', next: 'a[', start: 1, end: 1, pairs: true }))
                .toEqual({ ok: true, value: { changed: false, value: 'a[', start: 1, end: 1 } });
            expect(host.applyMarkdownTextChange({ previous: '- milk', next: '- milk\n', start: 6, end: 6, pairs: false }))
                .toEqual({ ok: true, value: { changed: false, value: '- milk\n', start: 6, end: 6 } });
        } finally {
            useTaskStore.setState({ settings });
        }
    });

    it('refuses a text change without both texts, a selection inside the earlier text and a pairing mode', () => {
        const host = createNativeHostContract();
        for (const input of [null, {}, { previous: 'a', next: 'ab', start: 0, end: 2, pairs: true }, { previous: 'a', next: 'ab', start: 1, end: 0, pairs: true },
            { previous: 'a', next: 1, start: 0, end: 0, pairs: true }, { previous: 'a', next: 'ab', start: 0, end: 0 }, { previous: 'a', next: 'ab', start: 0.5, end: 1, pairs: true }]) {
            expect(host.applyMarkdownTextChange(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });
});
