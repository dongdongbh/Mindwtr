import { describe, expect, it } from 'vitest';

import {
    createCompactLinkTitle,
    getAttachmentDisplayTitle,
    normalizeAttachmentInput,
    normalizeLinkAttachmentInput,
    parseAttachmentLinkBatch,
} from './attachment-link-utils';

describe('normalizeLinkAttachmentInput', () => {
    it('builds a compact title for plain urls', () => {
        const result = normalizeLinkAttachmentInput('https://contoso.sharepoint.com/sites/Team/Shared%20Documents/very/deep/path/file.docx?web=1&download=1');
        expect(result.kind).toBe('link');
        expect(result.uri).toBe('https://contoso.sharepoint.com/sites/Team/Shared%20Documents/very/deep/path/file.docx?web=1&download=1');
        expect(result.title).toContain('contoso.sharepoint.com');
        expect(result.title).toContain('file.docx');
        expect(result.title).not.toContain('?');
    });

    it('supports markdown-style custom labels', () => {
        const result = normalizeLinkAttachmentInput('[Sprint Plan](https://example.com/doc)');
        expect(result.kind).toBe('link');
        expect(result.title).toBe('Sprint Plan');
        expect(result.uri).toBe('https://example.com/doc');
    });

    it('supports pipe-style custom labels', () => {
        const result = normalizeLinkAttachmentInput('Sprint Plan | https://example.com/doc');
        expect(result.kind).toBe('link');
        expect(result.title).toBe('Sprint Plan');
        expect(result.uri).toBe('https://example.com/doc');
    });
});

describe('parseAttachmentLinkBatch', () => {
    it('preserves UpNote URI encoding and query parameters in all Add Link forms', () => {
        const uri = 'upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true';
        const parsed = parseAttachmentLinkBatch(`${uri}\nNote | ${uri}\n[My note](${uri})`);
        expect(parsed.invalidLine).toBeNull();
        expect(parsed.entries.map((entry) => entry.uri)).toEqual([uri, uri, uri]);
        expect(parsed.entries.map((entry) => entry.kind)).toEqual(['link', 'link', 'link']);
        expect(parsed.entries.map((entry) => entry.title)).toEqual(['x-callback-url/openNote', 'Note', 'My note']);
    });
    it('preserves order, original line numbers, labels, and links containing spaces or commas', () => {
        const result = parseAttachmentLinkBatch('  https://example.com/one  \r\n\r\nTitle | https://example.com/two,three\n[Third](https://example.com/a%20b)');
        expect(result.invalidLine).toBeNull();
        expect(result.entries.map(({ title, uri }) => ({ title, uri }))).toEqual([
            { title: 'example.com/one', uri: 'https://example.com/one' },
            { title: 'Title', uri: 'https://example.com/two,three' },
            { title: 'Third', uri: 'https://example.com/a%20b' },
        ]);
    });

    it('rejects the whole batch at the original invalid line', () => {
        expect(parseAttachmentLinkBatch('https://example.com\n\nnot a link\nhttps://mindwtr.app')).toEqual({
            entries: [], invalidLine: 3,
        });
    });

    it('keeps desktop paths with spaces as link pointers and rejects them on mobile', () => {
        expect(parseAttachmentLinkBatch('/home/user/My Docs/spec.pdf\nhttps://example.com', true).entries[0]).toEqual({
            kind: 'link', title: 'spec.pdf', uri: '/home/user/My Docs/spec.pdf',
        });
        expect(parseAttachmentLinkBatch('/home/user/My Docs/spec.pdf')).toEqual({ entries: [], invalidLine: 1 });
    });
});

describe('normalizeAttachmentInput', () => {
    it('names a file path by its file name but keeps it a pointer', () => {


        const result = normalizeAttachmentInput('/home/user/Documents/spec.pdf');
        expect(result.kind).toBe('link');
        expect(result.title).toBe('spec.pdf');
        expect(result.uri).toBe('/home/user/Documents/spec.pdf');
    });

    it('keeps Windows and file:// paths pointers too', () => {
        expect(normalizeAttachmentInput('C:\\Users\\demo\\spec.pdf').kind).toBe('link');
        expect(normalizeAttachmentInput('file:///home/user/spec.pdf').kind).toBe('link');
    });
});

describe('getAttachmentDisplayTitle', () => {
    it('compacts raw url titles for link attachments', () => {
        const uri = 'https://example.com/a/really/long/path/to/resource?utm_source=abc';
        const display = getAttachmentDisplayTitle({
            kind: 'link',
            title: uri,
            uri,
        });
        expect(display).toContain('example.com');
        expect(display).not.toContain('?');
    });

    it('preserves explicit custom titles', () => {
        const display = getAttachmentDisplayTitle({
            kind: 'link',
            title: 'Q1 roadmap',
            uri: 'https://example.com/a/really/long/path',
        });
        expect(display).toBe('Q1 roadmap');
    });
});

describe('createCompactLinkTitle', () => {
    it('normalizes www urls into compact host/path labels', () => {
        const label = createCompactLinkTitle('www.example.com/path/to/resource');
        expect(label).toContain('example.com');
        expect(label).toContain('resource');
    });
});
