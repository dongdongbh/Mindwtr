import { describe, expect, it } from 'vitest';
import {
    CATPPUCCIN_MACCHIATO_CONTEXT_COLOR_PALETTE,
    DRACULA_CONTEXT_COLOR_PALETTE,
    getContextColor,
    GRUVBOX_DARK_CONTEXT_COLOR_PALETTE,
    GRUVBOX_LIGHT_CONTEXT_COLOR_PALETTE,
    NORD_CONTEXT_COLOR_PALETTE,
} from './context-color';

// One token per slot, so this table pins the canonical palette's values AND
// its order — the hash modulo is the palette length, so a reorder or a resize
// recolors contexts that have already been on screen for months (#974).
const SLOT_TOKENS: Array<[token: string, canonical: string, nord: string, catppuccin: string, dracula: string]> = [
    ['@office', '#2563eb', '#5e81ac', '#8aadf4', '#6272a4'],
    ['@calls', '#0f766e', '#8fbcbb', '#8bd5ca', '#8be9fd'],
    ['@phone', '#15803d', '#a3be8c', '#a6da95', '#50fa7b'],
    ['@anywhere', '#a21caf', '#b48ead', '#f5bde6', '#ff79c6'],
    ['@email', '#c2410c', '#d08770', '#f5a97f', '#ffb86c'],
    ['@work', '#be185d', '#bf616a', '#ed8796', '#ff5555'],
    ['@shop', '#0e7490', '#88c0d0', '#91d7e3', '#a4ffff'],
    ['@errands', '#7c3aed', '#81a1c1', '#c6a0f6', '#bd93f9'],
    ['@focus', '#166534', '#7a9161', '#7dc4e4', '#69ff94'],
    ['@home', '#b45309', '#ebcb8b', '#eed49f', '#f1fa8c'],
];

describe('getContextColor', () => {
    it('returns a deterministic color for the same context', () => {
        expect(getContextColor('@work')).toBe(getContextColor('@work'));
    });

    it('treats context values case-insensitively', () => {
        expect(getContextColor('@Home')).toBe(getContextColor('  @home  '));
    });

    it('returns a hex color string', () => {
        expect(getContextColor('@errands')).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('keeps the canonical palette on every slot', () => {
        expect(SLOT_TOKENS.map(([token]) => getContextColor(token)))
            .toEqual(SLOT_TOKENS.map(([, canonical]) => canonical));
    });

    it('swaps in the Nord palette slot-for-slot under the nord theme', () => {
        expect(SLOT_TOKENS.map(([token]) => getContextColor(token, 'nord')))
            .toEqual(SLOT_TOKENS.map(([, , nord]) => nord));
    });

    it('swaps in the Catppuccin Macchiato palette slot-for-slot', () => {
        expect(SLOT_TOKENS.map(([token]) => getContextColor(token, 'catppuccin-macchiato')))
            .toEqual(SLOT_TOKENS.map(([, , , catppuccin]) => catppuccin));
    });

    it('swaps in the Dracula palette slot-for-slot', () => {
        expect(SLOT_TOKENS.map(([token]) => getContextColor(token, 'dracula')))
            .toEqual(SLOT_TOKENS.map(([, , , , dracula]) => dracula));
    });

    it.each([
        ['gruvbox-light', GRUVBOX_LIGHT_CONTEXT_COLOR_PALETTE],
        ['gruvbox-dark', GRUVBOX_DARK_CONTEXT_COLOR_PALETTE],
    ] as const)('swaps in a ten-slot palette of distinct colors under %s', (theme, palette) => {
        expect(new Set(palette).size).toBe(SLOT_TOKENS.length);
        expect(SLOT_TOKENS.map(([token]) => getContextColor(token, theme))).toEqual([...palette]);
    });

    it('leaves every other theme on the canonical palette', () => {
        for (const [token, canonical] of SLOT_TOKENS) {
            expect(getContextColor(token, 'sepia')).toBe(canonical);
            expect(getContextColor(token, 'eink')).toBe(canonical);
            expect(getContextColor(token, 'dark')).toBe(canonical);
            expect(getContextColor(token, undefined)).toBe(canonical);
        }
    });

    it('themes the empty-context fallback too', () => {
        expect(getContextColor('   ')).toBe('#2563eb');
        expect(getContextColor('   ', 'nord')).toBe('#5e81ac');
    });
});

describe.each([
    ['NORD_CONTEXT_COLOR_PALETTE', NORD_CONTEXT_COLOR_PALETTE],
    ['CATPPUCCIN_MACCHIATO_CONTEXT_COLOR_PALETTE', CATPPUCCIN_MACCHIATO_CONTEXT_COLOR_PALETTE],
    ['DRACULA_CONTEXT_COLOR_PALETTE', DRACULA_CONTEXT_COLOR_PALETTE],
])('%s', (_name, palette) => {
    it('is the same length as the canonical palette so the hash modulo is unchanged', () => {
        expect(palette).toHaveLength(10);
    });

    it('has no repeated color, so two contexts never merge visually', () => {
        expect(new Set(palette).size).toBe(palette.length);
    });
});
