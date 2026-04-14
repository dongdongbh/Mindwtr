// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './Markdown';
import { LanguageProvider } from '../contexts/language-context';

describe('Markdown', () => {
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

    it('renders horizontal separator from markdown hr syntax', () => {
        const { container } = render(
            <LanguageProvider>
                <Markdown markdown={'Top\n---\nBottom'} />
            </LanguageProvider>
        );
        expect(container.querySelector('hr')).not.toBeNull();
    });
});
