import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The palette path is the part a pure-function test cannot see, and getting it
// wrong fails silently: the app just stays on its own palette. Omarchy keeps
// the palette at `current/theme/colors.toml` and the active name at
// `current/theme.name`.
const fsMock = vi.hoisted(() => ({
    exists: vi.fn(),
    readTextFile: vi.fn(),
    watch: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { Home: 'Home' },
    exists: fsMock.exists,
    readTextFile: fsMock.readTextFile,
    watch: fsMock.watch,
}));

import {
    applyDesktopTheme,
    applyOmarchyPalette,
    clearOmarchyPalette,
    contrastRatio,
    contrastRgb,
    ensureReadable,
    hslTripleToRgb,
    mixHex,
    OMARCHY_CSS_VARIABLES,
    paletteToCssVariables,
    parseColorsToml,
    pickContrastText,
    readOmarchyTheme,
    resolveOmarchyPalette,
    toCustomProperty,
    toHslTriple,
    watchOmarchyTheme,
    type OmarchyThemeState,
    type ResolvedOmarchyPalette,
} from './omarchy-theme';
import { resolveSystemThemePreference } from './theme';

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

describe('applying the palette', () => {
    const state = (): OmarchyThemeState => {
        const palette = resolve(FLEXOKI_LIGHT);
        return { scheme: palette.scheme, variables: paletteToCssVariables(palette) };
    };

    const resetDocument = () => {
        document.documentElement.removeAttribute('style');
        document.documentElement.className = '';
    };

    afterEach(() => {
        clearOmarchyPalette();
        resetDocument();
        localStorage.clear();
    });

    it('writes every variable to the document root', () => {
        const applied = state();
        applyOmarchyPalette(applied);
        const root = document.documentElement;
        for (const name of OMARCHY_CSS_VARIABLES) {
            expect(root.style.getPropertyValue(toCustomProperty(name)), name).toBe(applied.variables[name]);
        }
        expect(root.style.colorScheme).toBe('light');
    });

    it('hands the light/dark decision to the palette', () => {
        applyOmarchyPalette(state());
        expect(resolveSystemThemePreference('dark')).toBe('light');
    });

    it('clears every variable and returns the decision to the platform', () => {
        applyOmarchyPalette(state());
        clearOmarchyPalette();
        const root = document.documentElement;
        for (const name of OMARCHY_CSS_VARIABLES) {
            expect(root.style.getPropertyValue(toCustomProperty(name)), name).toBe('');
        }
        expect(root.style.colorScheme).toBe('');
        expect(resolveSystemThemePreference('dark')).toBe('dark');
    });

    it('applies the cached palette synchronously so the first frame is already themed', () => {
        const cached = state();
        applyOmarchyPalette(cached);
        // Simulate the next launch: fresh document, palette only in storage.
        resetDocument();
        clearOmarchyPalette();

        applyDesktopTheme('system');

        expect(document.documentElement.style.getPropertyValue('--background')).toBe(cached.variables.background);
        expect(resolveSystemThemePreference('dark')).toBe('light');
    });

    it('drops the palette when the mode stops being system', () => {
        applyOmarchyPalette(state());
        applyDesktopTheme('nord');
        expect(document.documentElement.style.getPropertyValue('--background')).toBe('');
        expect(resolveSystemThemePreference('dark')).toBe('dark');
    });
});

// Real Omarchy themes, kept as fixtures because they break a naive mapping:
// Rose Pine Dawn's muted is 1.48:1 on its own background and its cyan 2.60:1,
// Tokyo Night's muted is 1.91:1. Both are fine in a terminal and not in a list.
const ROSE_PINE_DAWN = `
mode = "light"
accent = "#56949f"
muted = "#cecacd"
background = "#faf4ed"
foreground = "#575279"
red = "#b4637a"
yellow = "#ea9d34"
orange = "#cf8057"
green = "#286983"
cyan = "#d7827e"
blue = "#56949f"
magenta = "#907aa9"
`;

const TOKYO_NIGHT = `
mode = "dark"
accent = "#7aa2f7"
muted = "#414868"
background = "#1a1b26"
foreground = "#a9b1d6"
red = "#f7768e"
yellow = "#e0af68"
orange = "#eb927b"
green = "#9ece6a"
cyan = "#449dab"
blue = "#7aa2f7"
magenta = "#ad8ee6"
`;

describe('readability of the emitted palette', () => {
    const TEXT_ROLES = [
        'foreground',
        'muted-foreground',
        'destructive',
        'success',
        'warning',
        'info',
        'status-inbox',
        'status-next',
        'status-waiting',
        'status-someday',
        'status-reference',
        'status-done',
        'status-archived',
        'badge-project-fg',
        'badge-context-fg',
        'badge-priority-fg',
        'badge-estimate-fg',
        'badge-age-fg',
    ] as const;
    const UI_ROLES = ['focus-star', 'focus-star-outline'] as const;

    const emittedRgb = (triple: string) => {
        const rgb = hslTripleToRgb(triple);
        if (!rgb) throw new Error(`Not an emitted triple: ${triple}`);
        return rgb;
    };

    // The threshold is checked against the color the stylesheet renders, which
    // is the rounded triple, not the hex the mapping started from.
    for (const [name, fixture] of [['Rose Pine Dawn', ROSE_PINE_DAWN], ['Tokyo Night', TOKYO_NIGHT]] as const) {
        it(`keeps every text role at or above 4.5:1 on ${name}`, () => {
            const variables = paletteToCssVariables(resolve(fixture));
            const background = emittedRgb(variables.background);
            for (const role of TEXT_ROLES) {
                expect(contrastRgb(emittedRgb(variables[role]), background), role).toBeGreaterThanOrEqual(4.5);
            }
        });

        it(`keeps every non-text role at or above 3:1 on ${name}`, () => {
            const variables = paletteToCssVariables(resolve(fixture));
            const background = emittedRgb(variables.background);
            for (const role of UI_ROLES) {
                expect(contrastRgb(emittedRgb(variables[role]), background), role).toBeGreaterThanOrEqual(3);
            }
        });
    }
});

describe('reading and watching the live theme', () => {
    const COLORS_PATH = '.local/state/omarchy/current/theme/colors.toml';

    beforeEach(() => {
        fsMock.exists.mockReset();
        fsMock.readTextFile.mockReset();
        fsMock.watch.mockReset();
        (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
    });

    afterEach(() => {
        delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
        vi.restoreAllMocks();
    });

    const foundTheme = () => {
        fsMock.exists.mockImplementation(async (path: string) => path === COLORS_PATH);
        fsMock.readTextFile.mockResolvedValue(FLEXOKI_LIGHT);
    };

    it('reads the palette from inside theme/, not from current/', async () => {
        foundTheme();
        const state = await readOmarchyTheme();
        expect(state?.scheme).toBe('light');
        expect(fsMock.readTextFile).toHaveBeenCalledWith(COLORS_PATH, expect.anything());
    });

    it('returns null when the palette is not where Omarchy keeps it', async () => {
        fsMock.exists.mockResolvedValue(false);
        expect(await readOmarchyTheme()).toBeNull();
    });

    it('watches the theme name beside the theme directory, not inside it', async () => {
        foundTheme();
        fsMock.watch.mockResolvedValue(vi.fn());

        const stop = watchOmarchyTheme('system');
        await vi.waitFor(() => expect(fsMock.watch).toHaveBeenCalled());

        expect(fsMock.watch.mock.calls[0][0]).toBe('.local/state/omarchy/current/theme.name');
        stop();
    });

    it('does not read or watch outside a system theme mode', async () => {
        const stop = watchOmarchyTheme('nord');
        stop();
        expect(fsMock.watch).not.toHaveBeenCalled();
        expect(fsMock.exists).not.toHaveBeenCalled();
    });
});
