/**
 * Resolves the live Omarchy palette into the app's CSS custom properties.
 *
 * Omarchy publishes the active theme as `colors.toml` under its state directory
 * (Omarchy 4: `~/.local/state/omarchy/current/theme`; 3.x kept the same file
 * under `~/.config/omarchy/current/theme`). That file is the single source of
 * truth here. Nothing in this module touches the filesystem — it turns palette
 * text into custom-property values so the mapping can be tested without Tauri.
 *
 * The alias and fallback cascade mirrors `omarchy-theme-color`, Omarchy's own
 * colors.toml consumer, so the app agrees with the terminal and the shell
 * instead of inventing a second reading of the same file.
 */

export type OmarchyScheme = 'light' | 'dark';

/**
 * The palette keys the app maps from, after Omarchy's cascade has filled in
 * every alias. Only the keys a variable actually reads are kept; a field the
 * mapping never touches would be dead weight on the type.
 */
export type ResolvedOmarchyPalette = {
    scheme: OmarchyScheme;
    background: string;
    foreground: string;
    accent: string;
    muted: string;
    red: string;
    green: string;
    yellow: string;
    orange: string;
    blue: string;
    magenta: string;
    cyan: string;
};

/**
 * Every color custom property `apps/desktop/src/index.css` declares. The union
 * is the point: adding a variable to the stylesheet without deciding what the
 * Omarchy palette feeds it becomes a compile error rather than a color that
 * silently keeps the app's default.
 */
export const OMARCHY_CSS_VARIABLES = [
    'background',
    'foreground',
    'card',
    'card-foreground',
    'popover',
    'popover-foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'muted',
    'muted-foreground',
    'accent',
    'accent-foreground',
    'destructive',
    'destructive-foreground',
    'success',
    'success-foreground',
    'warning',
    'warning-foreground',
    'focus-star',
    'focus-star-outline',
    'info',
    'info-foreground',
    'status-inbox',
    'status-next',
    'status-waiting',
    'status-someday',
    'status-reference',
    'status-done',
    'status-archived',
    'badge-project-bg',
    'badge-project-fg',
    'badge-context-bg',
    'badge-context-fg',
    'badge-tag-bg',
    'badge-tag-fg',
    'badge-priority-bg',
    'badge-priority-fg',
    'badge-estimate-bg',
    'badge-estimate-fg',
    'badge-age-bg',
    'badge-age-fg',
    'badge-info-bg',
    'badge-info-fg',
    'border',
    'input',
    'ring',
] as const;

export type OmarchyCssVariable = (typeof OMARCHY_CSS_VARIABLES)[number];

/** Minimum contrast ratio for a hue the app renders as text (WCAG AA). */
const MIN_TEXT_CONTRAST = 4.5;

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/** The background luminance rule Omarchy falls back to when a theme declares no mode. */
const LIGHT_BACKGROUND_LUMINANCE = 382;

type Rgb = { r: number; g: number; b: number };

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

const parseHex = (value: string): Rgb | null => {
    if (!HEX_PATTERN.test(value)) return null;
    return {
        r: parseInt(value.slice(1, 3), 16),
        g: parseInt(value.slice(3, 5), 16),
        b: parseInt(value.slice(5, 7), 16),
    };
};

const toHex = ({ r, g, b }: Rgb): string =>
    `#${[r, g, b]
        .map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0'))
        .join('')}`;

const mixRgb = (start: Rgb, end: Rgb, amount: number): Rgb => {
    const ratio = clamp(amount, 0, 1);
    return {
        r: start.r + (end.r - start.r) * ratio,
        g: start.g + (end.g - start.g) * ratio,
        b: start.b + (end.b - start.b) * ratio,
    };
};

/** Blends two hex colors. `amount` is how far to move from `start` toward `end`. */
export const mixHex = (start: string, end: string, amount: number): string => {
    const from = parseHex(start);
    const to = parseHex(end);
    if (!from || !to) throw new Error(`Not a hex color: ${start} / ${end}`);
    return toHex(mixRgb(from, to, amount));
};

const channelLuminance = (value: number): number => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = ({ r, g, b }: Rgb): number =>
    0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);

/** WCAG contrast ratio between two hex colors, from 1 (identical) to 21. */
export const contrastRatio = (a: string, b: string): number => {
    const first = parseHex(a);
    const second = parseHex(b);
    if (!first || !second) throw new Error(`Not a hex color: ${a} / ${b}`);
    const ratios = [relativeLuminance(first), relativeLuminance(second)].sort((x, y) => y - x);
    return (ratios[0] + 0.05) / (ratios[1] + 0.05);
};

/**
 * Pushes `hue` toward the theme's foreground until it clears `minRatio` against
 * the background.
 *
 * Omarchy's ANSI hues are picked for terminal text, where a low-contrast yellow
 * is a style choice. The app reuses those hues for status text and warnings,
 * where the same yellow is a legibility problem — its own light palette uses a
 * much darker amber for exactly this reason. Blending toward the foreground is
 * the direction that works for both schemes: the foreground is the highest
 * contrast color a theme has against its own background.
 */
export const ensureReadable = (
    hue: string,
    palette: ResolvedOmarchyPalette,
    minRatio = MIN_TEXT_CONTRAST,
): string => {
    const source = parseHex(hue);
    const foreground = parseHex(palette.foreground);
    if (!source || !foreground) throw new Error(`Not a hex color: ${hue}`);
    if (contrastRatio(hue, palette.background) >= minRatio) return hue;

    const STEPS = 20;
    for (let step = 1; step <= STEPS; step += 1) {
        const candidate = toHex(mixRgb(source, foreground, step / STEPS));
        if (contrastRatio(candidate, palette.background) >= minRatio) return candidate;
    }
    return palette.foreground;
};

/** Whichever of the palette's two text colors reads better on `color`. */
export const pickContrastText = (color: string, palette: ResolvedOmarchyPalette): string =>
    contrastRatio(color, palette.background) >= contrastRatio(color, palette.foreground)
        ? palette.background
        : palette.foreground;

/**
 * Hex to the `H S% L%` triple the stylesheet composes as `hsl(var(--name))`.
 * Throws on a non-hex value: every caller feeds it a validated palette color,
 * and the apply layer treats a throw as "no Omarchy palette here".
 */
export const toHslTriple = (hex: string): string => {
    const { r, g, b } = parseHex(hex) ?? (() => {
        throw new Error(`Not a hex color: ${hex}`);
    })();
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    const lightness = (max + min) / 2;

    let hue = 0;
    let saturation = 0;
    if (delta !== 0) {
        saturation = delta / (1 - Math.abs(2 * lightness - 1));
        if (max === red) hue = ((green - blue) / delta) % 6;
        else if (max === green) hue = (blue - red) / delta + 2;
        else hue = (red - green) / delta + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
    }

    return `${Math.round(hue)} ${Math.round(clamp(saturation, 0, 1) * 100)}% ${Math.round(lightness * 100)}%`;
};

/**
 * Reads `key = "value"` pairs out of a colors.toml.
 *
 * Omarchy's parser accepts bare values too and stops a quoted value at its
 * closing quote, so an inline `# comment` never becomes part of a color. Both
 * spellings appear in shipped themes.
 */
export const parseColorsToml = (text: string): Map<string, string> => {
    const entries = new Map<string, string>();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^#]*))/);
        if (!match) continue;
        const value = (match[2] ?? match[3] ?? '').trim();
        if (value) entries.set(match[1], value);
    }
    return entries;
};

const firstHex = (entries: Map<string, string>, keys: readonly string[]): string | null => {
    for (const key of keys) {
        const value = entries.get(key);
        if (value && HEX_PATTERN.test(value)) return value;
    }
    return null;
};

/**
 * Omarchy's mode precedence: the `mode` key, then legacy `theme_type`, then a
 * `light.mode` file beside the colors.toml, then background luminance, then
 * dark. The file check is the caller's because it needs the filesystem.
 */
const resolveScheme = (entries: Map<string, string>, lightModeHint: boolean): OmarchyScheme => {
    const declared = entries.get('mode') ?? entries.get('theme_type');
    if (declared === 'light' || declared === 'dark') return declared;
    if (lightModeHint) return 'light';

    const background = firstHex(entries, ['background', 'bg', 'color0']);
    if (!background) return 'dark';
    const rgb = parseHex(background);
    if (!rgb) return 'dark';
    return rgb.r + rgb.g + rgb.b > LIGHT_BACKGROUND_LUMINANCE ? 'light' : 'dark';
};

export type ResolveOmarchyPaletteOptions = {
    /** Whether a `light.mode` file sits beside the colors.toml. */
    lightModeHint?: boolean;
};

/**
 * Fills in every alias and fallback the mapping reads, or returns null when the
 * file is too incomplete to theme the app from. Null is not an error: a theme
 * that names no accent leaves the app on its own System palette.
 */
export const resolveOmarchyPalette = (
    entries: Map<string, string>,
    options: ResolveOmarchyPaletteOptions = {},
): ResolvedOmarchyPalette | null => {
    const background = firstHex(entries, ['background', 'bg', 'color0']);
    const foreground = firstHex(entries, ['foreground', 'fg', 'color7']);
    const accent = firstHex(entries, ['accent']);
    const red = firstHex(entries, ['red', 'color1']);
    const green = firstHex(entries, ['green', 'color2']);
    const yellow = firstHex(entries, ['yellow', 'color3']);
    const blue = firstHex(entries, ['blue', 'color4']);
    const magenta = firstHex(entries, ['magenta', 'purple', 'color5']);
    const cyan = firstHex(entries, ['cyan', 'color6']);
    if (!background || !foreground || !accent || !red || !green || !yellow || !blue || !magenta || !cyan) {
        return null;
    }

    const darkForeground = firstHex(entries, ['dark_foreground', 'dark_fg', 'color8']) ?? foreground;
    return {
        scheme: resolveScheme(entries, options.lightModeHint ?? false),
        background,
        foreground,
        accent,
        muted: firstHex(entries, ['muted', 'color8']) ?? darkForeground,
        red,
        green,
        yellow,
        orange: firstHex(entries, ['orange']) ?? yellow,
        blue,
        magenta,
        cyan,
    };
};

/**
 * The palette-to-variable table. Surfaces derive from background and foreground
 * by mixing, so one table serves light and dark themes. Text-role hues pass
 * through the readability gate; surfaces do not, because a tint is meant to sit
 * close to the background.
 */
const paletteSources = (palette: ResolvedOmarchyPalette): Record<OmarchyCssVariable, string> => {
    const surface = (amount: number) => mixHex(palette.background, palette.foreground, amount);
    const text = (hue: string) => ensureReadable(hue, palette);
    const tint = (hue: string, amount: number) => mixHex(palette.background, hue, amount);

    return {
        'background': palette.background,
        'foreground': palette.foreground,
        'card': surface(0.08),
        'card-foreground': palette.foreground,
        'popover': surface(0.12),
        'popover-foreground': palette.foreground,
        'primary': palette.accent,
        'primary-foreground': pickContrastText(palette.accent, palette),
        'secondary': surface(0.12),
        'secondary-foreground': palette.foreground,
        'muted': surface(0.08),
        'muted-foreground': surface(0.58),
        'accent': surface(0.12),
        'accent-foreground': palette.foreground,
        'destructive': text(palette.red),
        'destructive-foreground': pickContrastText(palette.red, palette),
        'success': text(palette.green),
        'success-foreground': pickContrastText(palette.green, palette),
        'warning': text(palette.yellow),
        'warning-foreground': pickContrastText(palette.yellow, palette),
        'info': text(palette.blue),
        'info-foreground': pickContrastText(palette.blue, palette),
        'focus-star': text(palette.yellow),
        'focus-star-outline': text(palette.orange),
        'status-inbox': text(palette.blue),
        'status-next': text(palette.green),
        'status-waiting': text(palette.yellow),
        'status-someday': text(palette.magenta),
        'status-reference': text(palette.cyan),
        'status-done': text(palette.muted),
        'status-archived': text(palette.blue),
        'badge-project-bg': tint(palette.accent, 0.18),
        'badge-project-fg': text(palette.accent),
        'badge-context-bg': tint(palette.magenta, 0.18),
        'badge-context-fg': text(palette.magenta),
        'badge-tag-bg': surface(0.12),
        'badge-tag-fg': palette.foreground,
        'badge-priority-bg': tint(palette.yellow, 0.18),
        'badge-priority-fg': text(palette.yellow),
        'badge-estimate-bg': tint(palette.green, 0.18),
        'badge-estimate-fg': text(palette.green),
        'badge-age-bg': tint(palette.orange, 0.14),
        'badge-age-fg': text(palette.orange),
        'badge-info-bg': surface(0.12),
        'badge-info-fg': palette.foreground,
        'border': surface(0.18),
        'input': surface(0.18),
        'ring': palette.accent,
    };
};

/** Every custom property the palette sets, as `H S% L%` values. */
export const paletteToCssVariables = (
    palette: ResolvedOmarchyPalette,
): Record<OmarchyCssVariable, string> => {
    const variables = {} as Record<OmarchyCssVariable, string>;
    for (const [name, hex] of Object.entries(paletteSources(palette)) as [OmarchyCssVariable, string][]) {
        variables[name] = toHslTriple(hex);
    }
    return variables;
};

export const toCustomProperty = (name: OmarchyCssVariable): string => `--${name}`;
