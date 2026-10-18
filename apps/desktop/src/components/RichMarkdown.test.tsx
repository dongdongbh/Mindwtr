import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LanguageProvider } from '../contexts/language-context';
import { RichMarkdown } from './RichMarkdown';

describe('RichMarkdown', () => {
    it('keeps explicit UpNote links clickable with the original encoded URI', () => {
        const uri = 'upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true';
        render(<LanguageProvider><RichMarkdown markdown={`[Note](${uri})`} /></LanguageProvider>);
        expect(screen.getByRole('link', { name: 'Note' })).toHaveAttribute('title', uri);
    });

    it('renders markdown headings with desktop heading styles', () => {
        render(<RichMarkdown markdown={'# Heading\n\n## Section\n\nBody'} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toHaveClass('text-lg', 'font-semibold');
        expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toHaveClass('text-base', 'font-semibold');
        expect(screen.getByText('Body')).toBeInTheDocument();
    });

    it('preserves soft line breaks inside paragraphs', () => {
        render(<RichMarkdown markdown={'line 1\nline 2'} />);

        expect(screen.getByText(/line 1/)).toHaveClass('whitespace-pre-line');
    });

    it('preserves intentional blank lines between blocks', () => {
        const { container } = render(<RichMarkdown markdown={'line 1\n\nline 2'} />);

        expect(container.querySelectorAll('.mindwtr-markdown-blank-line')).toHaveLength(1);
    });

    it('adds an accessible copy button to fenced code blocks', () => {
        render(
            <LanguageProvider>
                <RichMarkdown markdown={'```ts\nconst value = 1;\n```'} />
            </LanguageProvider>
        );

        expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
        expect(screen.getByText('const value = 1;')).toBeInTheDocument();
    });

    it('autolinks bare emails without lookbehind regexes (old WebKit crashes on them)', async () => {
        // The gfm autolink transform is patched (patches/mdast-util-gfm-autolink-literal@2.0.1.patch)
        // because its lookbehind regex throws "invalid group specifier name" on
        // WKWebView < Safari 16.4. Guard both the behavior and the patch itself.
        render(
            <LanguageProvider>
                <RichMarkdown markdown={'Contact person@example.com please.'} />
            </LanguageProvider>
        );

        // The URL lives in title, never href — an href invites the engine's
        // speculative preconnect to the linked host (#913).
        expect(screen.getByRole('link', { name: 'person@example.com' })).toHaveAttribute(
            'title',
            'mailto:person@example.com'
        );

        const { createRequire } = await import('node:module');
        const { readFileSync } = await import('node:fs');
        const { dirname, join } = await import('node:path');
        const entry = createRequire(import.meta.url).resolve('mdast-util-gfm-autolink-literal');
        const source = readFileSync(join(dirname(entry), 'lib', 'index.js'), 'utf8');
        expect(source).not.toMatch(/\(\?<[=!]/);
    });

    it('keeps RFC 2392 message-id links clickable', () => {
        render(
            <LanguageProvider>
                <RichMarkdown markdown={'Reply from [email](mid:960830.1639@example.com).'} />
            </LanguageProvider>
        );

        expect(screen.getByRole('link', { name: 'email' })).toHaveAttribute('title', 'mid:960830.1639@example.com');
    });
});
