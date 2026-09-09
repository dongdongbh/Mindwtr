import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsSidebar } from './SettingsSidebar';

const results = [
    { pageId: 'main' as const, key: 'theme', title: 'Theme', pageTitle: 'General' },
    { pageId: 'main' as const, key: 'themeDark', title: 'Theme dark', pageTitle: 'General' },
];
const Icon = () => null;
function setup() {
    const select = vi.fn();
    const pick = vi.fn();
    render(<SettingsSidebar title="Settings" subtitle="Preferences" activeId="main" onSelect={select}
        items={[{ id: 'main', label: 'General', icon: Icon }, { id: 'sync', label: 'Sync', icon: Icon }]}
        searchResults={results} onSelectSearchResult={pick} noResultsLabel="No matches" />);
    return { select, pick, input: screen.getByRole('combobox', { name: 'Search settings…' }) };
}

describe('SettingsSidebar responsive search', () => {
    it('keeps search and results in the narrow layout instead of hiding them behind lg', () => {
        const { input, pick } = setup();
        expect(input.parentElement!.className).not.toMatch(/\bhidden\b/);
        fireEvent.change(input, { target: { value: 'theme' } });
        const list = screen.getByRole('listbox');
        expect(list.className).not.toMatch(/\bhidden\b/);
        fireEvent.click(screen.getByRole('option', { name: 'Theme General' }));
        expect(pick).toHaveBeenCalledWith(results[0]);
        expect(input).toHaveValue('');
    });

    it('exposes keyboard selection to assistive technology and clears it on escape', () => {
        const { input, pick } = setup();
        fireEvent.change(input, { target: { value: 'theme' } });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Theme dark General' }).id);
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(pick).toHaveBeenCalledWith(results[1]);
        fireEvent.change(input, { target: { value: 'missing' } });
        expect(screen.getByText('No matches')).toBeVisible();
        expect(input).not.toHaveAttribute('aria-activedescendant');
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('clears old results when navigating with the narrow-layout page selector', () => {
        const { input, select } = setup();
        fireEvent.change(input, { target: { value: 'theme' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Settings' }), { target: { value: 'sync' } });
        expect(select).toHaveBeenCalledWith('sync');
        expect(input).toHaveValue('');
    });
});
