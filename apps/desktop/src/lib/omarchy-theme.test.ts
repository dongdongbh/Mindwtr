import { describe, expect, it } from 'vitest';
import {
    contrastRatio,
    ensureReadable,
    mixHex,
    OMARCHY_CSS_VARIABLES,
    paletteToCssVariables,
    parseColorsToml,
    pickContrastText,
    resolveOmarchyPalette,
    toCustomProperty,
    toHslTriple,
    type ResolvedOmarchyPalette,
} from './omarchy-theme';

// A real Omarchy 4 theme, trimmed to the keys the app reads. Omarchy 4 replaced
// the ANSI color0..color15 spellings with semantic names.
const FLEXOKI_LIGHT = `
mode = "light"

accent = "#205EA6"
selection = "#CECDC3"
selection_foreground = "#100F0F"
muted = "#B7B5AC"

background = "#FFFCF0"
foreground = "#100F0F"

red = "#D14D41"
yellow = "#D0A215"
orange = "#d0772b"
green = "#879A39"
cyan = "#3AA99F"
blue = "#205EA6"
magenta = "#CE5D97"
`;

const AUTUMN_DARK = `
mode = "dark"
accent = "#a78854"
background = "#343434"
foreground = "#cccccc"
red = "#af7150"
yellow = "#b47664"
green = "#8a766c"
cyan = "#b89268"
blue = "#a78854"
magenta = "#918775"
`;

// A theme generated before the semantic palette existed: ANSI names only.
const LEGACY_ANSI = `
accent = "#a78854"
color0 = "#343434"
color1 = "#af7150"
color2 = "#8a766c"
color3 = "#b47664"
color4 = "#a78854"
color5 = "#918775"
color6 = "#b89268"
color7 = "#cccccc"
color8 = "#818181"
`;

const resolve = (text: string) => {
    const palette = resolveOmarchyPalette(parseColorsToml(text));
    if (!palette) throw new Error('fixture did not resolve');
    return palette;
};

describe('parseColorsToml', () => {
    it('reads quoted values', () => {
        expect(parseColorsToml('accent = "#205EA6"').get('accent')).toBe('#205EA6');
    });

    it('reads bare values', () => {
        expect(parseColorsToml('mode = light').get('mode')).toBe('light');
    });

    it('stops a quoted value at its closing quote so an inline comment is not part of it', () => {
        expect(parseColorsToml('accent = "#205EA6" # the blue').get('accent')).toBe('#205EA6');
    });

    it('skips comments and blank lines', () => {
        const entries = parseColorsToml('# a comment\n\n   \naccent = "#205EA6"');
        expect([...entries.keys()]).toEqual(['accent']);
    });

    it('keeps underscores and dashes in keys', () => {
        expect(parseColorsToml('selection_foreground = "#100F0F"').get('selection_foreground')).toBe('#100F0F');
    });
});

describe('resolveOmarchyPalette', () => {
    it('resolves an Omarchy 4 semantic palette', () => {
        const palette = resolve(FLEXOKI_LIGHT);
        expect(palette.scheme).toBe('light');
        expect(palette.background).toBe('#FFFCF0');
        expect(palette.foreground).toBe('#100F0F');
        expect(palette.accent).toBe('#205EA6');
        expect(palette.magenta).toBe('#CE5D97');
        expect(palette.orange).toBe('#d0772b');
    });

    it('resolves a legacy ANSI-only palette through the colorN aliases', () => {
        const palette = resolve(LEGACY_ANSI);
        expect(palette.scheme).toBe('dark');
        expect(palette.background).toBe('#343434');
        expect(palette.foreground).toBe('#cccccc');
        expect(palette.red).toBe('#af7150');
        expect(palette.green).toBe('#8a766c');
        expect(palette.yellow).toBe('#b47664');
        expect(palette.blue).toBe('#a78854');
        expect(palette.magenta).toBe('#918775');
        expect(palette.cyan).toBe('#b89268');
        expect(palette.muted).toBe('#818181');
    });

    it('accepts purple as the magenta spelling', () => {
        const palette = resolve(AUTUMN_DARK.replace('magenta = "#918775"', 'purple = "#918775"'));
        expect(palette.magenta).toBe('#918775');
    });

    it('falls back to yellow when a theme names no orange', () => {
        expect(resolve(AUTUMN_DARK).orange).toBe('#b47664');
    });

    it('falls back to the foreground when a theme names no muted or color8', () => {
        const palette = resolve(FLEXOKI_LIGHT.replace('muted = "#B7B5AC"\n', ''));
        expect(palette.muted).toBe('#100F0F');
    });

    it('returns null when the theme is too incomplete to map', () => {
        expect(resolveOmarchyPalette(parseColorsToml('background = "#FFFCF0"'))).toBeNull();
    });

    it('returns null when a required key is not a hex color', () => {
        expect(resolveOmarchyPalette(parseColorsToml('accent = "blue"'))).toBeNull();
    });
});

describe('resolveOmarchyPalette mode precedence', () => {
    it('prefers the mode key', () => {
        expect(resolve('mode = "light"\n' + AUTUMN_DARK.replace('mode = "dark"', '')).scheme).toBe('light');
    });

    it('falls back to the legacy theme_type key', () => {
        const text = AUTUMN_DARK.replace('mode = "dark"', 'theme_type = "light"');
        expect(resolve(text).scheme).toBe('light');
    });

    it('honours a light.mode file over background luminance', () => {
        // The file only decides when the theme declares no mode of its own.
        const text = AUTUMN_DARK.replace('mode = "dark"\n', '');
        const palette = resolveOmarchyPalette(parseColorsToml(text), { lightModeHint: true });
        expect(palette?.scheme).toBe('light');
    });

    it('derives light from a bright background when no mode is declared', () => {
        const text = AUTUMN_DARK.replace('mode = "dark"\n', '').replace('#343434', '#FFFCF0');
        expect(resolve(text).scheme).toBe('light');
    });

    it('derives dark from a dim background when no mode is declared', () => {
        const text = AUTUMN_DARK.replace('mode = "dark"\n', '');
        expect(resolve(text).scheme).toBe('dark');
    });
});

describe('toHslTriple', () => {
    it('converts to the H S% L% triple the stylesheet composes', () => {
        expect(toHslTriple('#205EA6')).toBe('212 68% 39%');
    });

    it('reports zero saturation for greys', () => {
        expect(toHslTriple('#808080')).toBe('0 0% 50%');
    });

    it('throws on a value that is not a hex color', () => {
        expect(() => toHslTriple('blue')).toThrow(/Not a hex color/);
    });
});

describe('mixHex', () => {
    it('returns the start color at zero and the end color at one', () => {
        expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
        expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    });

    it('blends between the two', () => {
        expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    });
});

describe('contrastRatio', () => {
    it('reports 21 for black on white and 1 for a color on itself', () => {
        expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
        expect(contrastRatio('#205EA6', '#205EA6')).toBeCloseTo(1, 5);
    });
});

describe('ensureReadable', () => {
    it('leaves a hue that already clears the ratio untouched', () => {
        const palette = resolve(FLEXOKI_LIGHT);
        expect(ensureReadable(palette.blue, palette)).toBe(palette.blue);
    });

    it('darkens an ANSI yellow that Omarchy picked for terminal text', () => {
        const palette = resolve(FLEXOKI_LIGHT);
        const readable = ensureReadable(palette.yellow, palette);
        expect(readable).not.toBe(palette.yellow);
        expect(contrastRatio(readable, palette.background)).toBeGreaterThanOrEqual(4.5);
    });

    it('falls back to the foreground when no ratio can satisfy the target', () => {
        const palette = resolve(FLEXOKI_LIGHT);
        expect(ensureReadable(palette.yellow, palette, 21)).toBe(palette.foreground);
    });
});

describe('pickContrastText', () => {
    it('picks the background when the color is dark on a light theme', () => {
        const palette = resolve(FLEXOKI_LIGHT);
        expect(pickContrastText(palette.accent, palette)).toBe(palette.background);
    });

    it('picks the foreground when the color is light on a dark theme', () => {
        const palette = resolve(AUTUMN_DARK);
        expect(pickContrastText(palette.foreground, palette)).toBe(palette.background);
    });
});

describe('paletteToCssVariables', () => {
    const palette: ResolvedOmarchyPalette = resolve(FLEXOKI_LIGHT);

    it('sets every color variable the stylesheet declares', () => {
        const variables = paletteToCssVariables(palette);
        expect(Object.keys(variables)).toHaveLength(OMARCHY_CSS_VARIABLES.length);
        expect(new Set(OMARCHY_CSS_VARIABLES).size).toBe(OMARCHY_CSS_VARIABLES.length);
        expect(variables.background).toBe(toHslTriple(palette.background));
        expect(variables['status-archived']).toBeDefined();
        expect(variables['badge-info-fg']).toBeDefined();
    });

    it('produces a value for every variable in the H S% L% shape', () => {
        const variables = paletteToCssVariables(palette);
        for (const [name, value] of Object.entries(variables)) {
            expect(value, name).toMatch(/^\d+ \d+% \d+%$/);
        }
    });

    it('prefixes names into custom properties', () => {
        expect(toCustomProperty('status-inbox')).toBe('--status-inbox');
    });
});
