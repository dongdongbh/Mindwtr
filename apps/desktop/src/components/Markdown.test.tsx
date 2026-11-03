// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { Markdown } from './Markdown';
import { LanguageProvider } from '../contexts/language-context';

const openShell = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openShell }));

describe('Markdown', () => {
    it.each(['upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true', 'obsidian://open?vault=Obsidian%20Vault&file=Folder%2FNote%2520&heading=Section%20One'])('preserves explicit app links through the opener: %s', async (uri) => {
        (window as any).__TAURI_INTERNALS__ = {};
        try {
            const { getByRole } = render(<LanguageProvider><Markdown markdown={`[Note](${uri})`} /></LanguageProvider>);
            expect(openShell).not.toHaveBeenCalled();
            expect(getByRole('link', { name: 'Note' })).toHaveAttribute('title', uri);
            fireEvent.click(getByRole('link', { name: 'Note' }));
            await waitFor(() => expect(openShell).toHaveBeenCalledWith(uri));
        } finally {
            delete (window as any).__TAURI_INTERNALS__;
            openShell.mockClear();
        }
    });

    it('renders list blocks after plain text without requiring a blank line', () => {
        const { container, getByText } = render(
            <LanguageProvider>
                <Markdown markdown={'Intro line\n- item one\n- item two'} />
            </LanguageProvider>
        );
        expect(getByText('item one')).toBeTruthy();
        expect(container.querySelectorAll('ul').length).toBe(1);
    });

    it('renders task list checkboxes when immediately following text', () => {
        const { getAllByRole } = render(
            <LanguageProvider>
                <Markdown markdown={'Notes\n- [x] done\n- [ ] todo'} />
            </LanguageProvider>
        );
        const checkboxes = getAllByRole('checkbox') as HTMLInputElement[];
        expect(checkboxes).toHaveLength(2);
        expect(checkboxes[0]?.checked).toBe(true);
        expect(checkboxes[1]?.checked).toBe(false);
    });

    it('renders ordered items separately with their explicit markers and inline formatting', () => {
        const { container } = render(
            <LanguageProvider>
                <Markdown markdown={'3. first\n7) **second**\n007. `third`\n9) [link](https://example.com)'} />
            </LanguageProvider>
        );
        const items = Array.from(container.querySelectorAll<HTMLLIElement>('ol > li'));
        expect(items).toHaveLength(4);
        expect(items.map((item) => item.firstElementChild?.textContent)).toEqual(['3.', '7)', '007.', '9)']);
        expect(items[0]?.lastElementChild?.textContent).toBe('first');
        expect(items[1]?.querySelector('strong')?.textContent).toBe('second');
        expect(items[2]?.querySelector('code')?.textContent).toBe('third');
        expect(items[3]?.querySelector('[role="link"]')?.getAttribute('title')).toBe('https://example.com');
    });

    it('keeps mixed ordered and bullet lists separate from surrounding paragraphs', () => {
        const { container } = render(
            <LanguageProvider>
                <Markdown markdown={'Intro\n1. first\n2. second\n- bullet\n7) third\n* another bullet\n9) last\nOutro'} />
            </LanguageProvider>
        );
        const blocks = Array.from(container.firstElementChild?.children ?? []);
        expect(blocks.map((block) => block.tagName)).toEqual(['P', 'OL', 'UL', 'OL', 'UL', 'OL', 'P']);
        expect(blocks[0]?.textContent).toBe('Intro');
        expect(blocks[6]?.textContent).toBe('Outro');
        expect(container.querySelectorAll('li')).toHaveLength(6);
    });

    it('indents ordered items by the same leading whitespace as other lists', () => {
        const { container } = render(
            <LanguageProvider>
                <Markdown markdown={'1. parent\n  4) child\n\t2. grandchild'} />
            </LanguageProvider>
        );
        const items = Array.from(container.querySelectorAll<HTMLLIElement>('ol > li'));
        expect(items.map((item) => item.style.marginLeft)).toEqual(['', '14px', '28px']);
    });

    it('indents nested bullet and task list items by their leading whitespace', () => {
        const { container } = render(
            <LanguageProvider>
                <Markdown markdown={'- parent\n  - child\n    - grandchild\nSteps\n- [ ] top\n\t- [x] nested'} />
            </LanguageProvider>
        );
        const bullets = Array.from(container.querySelectorAll('ul')[0]?.querySelectorAll('li') ?? []);
        expect(bullets.map((li) => li.style.marginLeft)).toEqual(['', '14px', '28px']);
        const tasks = Array.from(container.querySelectorAll('ul')[1]?.querySelectorAll('li') ?? []);
        expect(tasks.map((li) => li.style.marginLeft)).toEqual(['', '28px']);
    });

    it('renders horizontal separator from markdown hr syntax', () => {
        const { container } = render(
            <LanguageProvider>
                <Markdown markdown={'Top\n---\nBottom'} />
            </LanguageProvider>
        );
        expect(container.querySelector('hr')).not.toBeNull();
    });

    it('preserves intentional blank lines between blocks', () => {
        const { container } = render(
            <LanguageProvider>
                <Markdown markdown={'Top\n\nBottom'} />
            </LanguageProvider>
        );

        expect(container.querySelectorAll('.mindwtr-markdown-blank-line')).toHaveLength(1);
    });
});
