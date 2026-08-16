import { describe, expect, it } from 'vitest';

import {
    createCompactLinkTitle,
    getAttachmentDisplayTitle,
    normalizeAttachmentInput,
    normalizeLinkAttachmentInput,
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

describe('normalizeAttachmentInput', () => {
    it('names a file path by its file name but keeps it a pointer', () => {
        // A copy is what "Add file" is for; a path typed into "Add link" must
        // stay a pointer so attachment sync never claims the bytes (#1001).
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
