import type { AppTheme } from './types';

const CONTEXT_COLOR_PALETTE = [
    '#2563eb',
    '#0f766e',
    '#15803d',


    '#a21caf',
    '#c2410c',
    '#be185d',
    '#0e7490',
    '#7c3aed',
    '#166534',
    '#b45309',
];


export const NORD_CONTEXT_COLOR_PALETTE = [
    '#5e81ac',
    '#8fbcbb',
    '#a3be8c',
    '#b48ead',
    '#d08770',
    '#bf616a',
    '#88c0d0',
    '#81a1c1',


    '#7a9161',
    '#ebcb8b',
];


export const CATPPUCCIN_MACCHIATO_CONTEXT_COLOR_PALETTE = [
    '#8aadf4',
    '#8bd5ca',
    '#a6da95',
    '#f5bde6',
    '#f5a97f',
    '#ed8796',
    '#91d7e3',
    '#c6a0f6',


    '#7dc4e4',
    '#eed49f',
];


export const DRACULA_CONTEXT_COLOR_PALETTE = [
    '#6272a4',
    '#8be9fd',
    '#50fa7b',
    '#ff79c6',
    '#ffb86c',
    '#ff5555',


    '#a4ffff',
    '#bd93f9',
    '#69ff94',
    '#f1fa8c',
];


export const GRUVBOX_LIGHT_CONTEXT_COLOR_PALETTE = [
    '#076678',
    '#427b58',
    '#79740e',
    '#8f3f71',
    '#af3a03',
    '#9d0006',
    '#458588',
    '#b16286',
    '#cc241d',
    '#b57614',
];


export const GRUVBOX_DARK_CONTEXT_COLOR_PALETTE = [
    '#83a598',
    '#8ec07c',
    '#b8bb26',
    '#d3869b',
    '#fe8019',
    '#fb4934',
    '#689d6a',
    '#b16286',
    '#98971a',
    '#fabd2f',
];

const CONTEXT_COLOR_PALETTES_BY_THEME = new Map<AppTheme, readonly string[]>([
    ['eink', ['#000000']],
    ['nord', NORD_CONTEXT_COLOR_PALETTE],
    ['catppuccin-macchiato', CATPPUCCIN_MACCHIATO_CONTEXT_COLOR_PALETTE],
    ['dracula', DRACULA_CONTEXT_COLOR_PALETTE],
    ['gruvbox-light', GRUVBOX_LIGHT_CONTEXT_COLOR_PALETTE],
    ['gruvbox-dark', GRUVBOX_DARK_CONTEXT_COLOR_PALETTE],
]);

function hashText(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash) + value.charCodeAt(index);
        hash |= 0;
    }
    return hash;
}

export function getContextColor(context: string, theme?: string): string {
    const palette = (theme && CONTEXT_COLOR_PALETTES_BY_THEME.get(theme as AppTheme)) ?? CONTEXT_COLOR_PALETTE;
    const normalized = context.trim().toLowerCase();
    if (!normalized) return palette[0];
    const hash = hashText(normalized);
    const index = Math.abs(hash) % palette.length;
    return palette[index];
}
