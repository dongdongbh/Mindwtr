import { describe, expect, it } from 'vitest';
import { resolveMarkdownInline } from './markdown-blocks';
import { isSafeMarkdownExternalHref } from './markdown-links';

const upnote = 'upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true';
const obsidian = 'obsidian://open?vault=Obsidian%20Vault&file=Folder%2FNote%2520&heading=Section%20One';
const lookup = { task: () => null, project: () => null };

describe('Markdown external links', () => {
    it.each(['https://example.com', 'HTTP://example.com', 'mailto:person@example.com', 'tel:+1234', upnote, obsidian])('permits %s', (href) => {
        expect(isSafeMarkdownExternalHref(href)).toBe(true);
    });
    it.each(['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/a', 'obsidian:open', 'custom://open', 'mid:123', '#local', 'mindwtr://task/a', 'upnote:open'])('rejects %s', (href) => {
        expect(isSafeMarkdownExternalHref(href)).toBe(false);
        expect(resolveMarkdownInline(`[Label](${href})`, lookup).every((node) => node.type !== 'link')).toBe(true);
    });
    it('does not trim or otherwise normalize targets in the external predicate', () => {
        expect(isSafeMarkdownExternalHref(' https://example.com')).toBe(false);
    });
    it.each([upnote, obsidian])('resolves explicit app links without changing the URI: %s', (href) => {
        expect(resolveMarkdownInline(`[Note](${href})`, lookup)).toEqual([
            { type: 'link', text: 'Note', target: { kind: 'external', href } },
        ]);
    });
});
