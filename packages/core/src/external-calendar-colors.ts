import type { AppTheme } from './types';

export const EXTERNAL_CALENDAR_COLORS = [
    '#2563EB',
    '#7C3AED',
    '#DB2777',
    '#EA580C',
    '#059669',
    '#0891B2',
    '#4F46E5',
    '#65A30D',
] as const;

export type ExternalCalendarColor = typeof EXTERNAL_CALENDAR_COLORS[number];

export function normalizeExternalCalendarColor(value: unknown): ExternalCalendarColor | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toUpperCase();
    return (EXTERNAL_CALENDAR_COLORS as readonly string[]).includes(normalized)
        ? normalized as ExternalCalendarColor
        : undefined;
}

export function getExternalCalendarColorForId(sourceId: string): ExternalCalendarColor {
    let hash = 0;
    for (let index = 0; index < sourceId.length; index += 1) {
        hash = ((hash << 5) - hash) + sourceId.charCodeAt(index);
        hash |= 0;
    }
    return EXTERNAL_CALENDAR_COLORS[Math.abs(hash) % EXTERNAL_CALENDAR_COLORS.length] ?? EXTERNAL_CALENDAR_COLORS[0];
}

/**
 * Lenient hex validator for colors *derived* from a feed (ICS COLOR/
 * X-APPLE-CALENDAR-COLOR, an OS calendar's native color). Unlike
 * `normalizeExternalCalendarColor` this accepts any hex color, not just the
 * 8-swatch set a user can pick — these values are display-only and must
 * never be written into synced settings.
 */
export function normalizeDerivedIcsColor(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value.trim());
    if (!match) return undefined;
    let hex = match[1];
    if (hex.length === 3) hex = hex.split('').map((digit) => digit + digit).join('');
    else if (hex.length === 8) hex = hex.slice(0, 6); // drop alpha
    return `#${hex.toUpperCase()}`;
}

/**
 * The one precedence resolver both desktop and mobile calendar views call —
 * never inline `??` per view. User pick beats a feed-provided hint beats the
 * deterministic hash fallback (#974).
 *
 * `explicitColor` is trusted as-is (callers already sanitize it through
 * `normalizeExternalCalendarColor` before it's stored); `feedColor` comes
 * from untrusted feed text, so it's re-validated here.
 *
 * Before this resolver existed, both platforms persisted the hash color into
 * `explicitColor` the moment a calendar was created, so every pre-existing
 * calendar looks "explicitly picked" and would permanently outrank a feed
 * hint with no migration. Treating a stored color equal to the hash default
 * as unset closes that gap for free. Accepted tradeoff: a user who
 * deliberately picked the one swatch (1 of 8) that happens to equal the hash
 * default loses that pick, but only once a feed color is actually available
 * to replace it — picking any other swatch still wins outright.
 */
export function resolveExternalCalendarColor(
    sourceId: string,
    explicitColor?: string,
    feedColor?: string,
): string {
    if (hasExplicitExternalCalendarColor(sourceId, explicitColor)) return explicitColor as string;
    return normalizeDerivedIcsColor(feedColor)
        ?? explicitColor
        ?? getExternalCalendarColorForId(sourceId || 'calendar');
}

/**
 * Per-theme stand-ins for the 8 pickable swatches (#974). Display only — the
 * maps are applied to the *output* of `resolveExternalCalendarColor`, never to
 * what gets stored, so a pick made under one of these themes is still the
 * canonical hex on every other theme. A feed-provided COLOR hint is arbitrary
 * hex, misses these maps, and passes through unchanged.
 */
export const NORD_EXTERNAL_CALENDAR_COLOR_MAP: Record<string, string> = {
    '#2563eb': '#5e81ac',
    '#7c3aed': '#b48ead',
    '#db2777': '#bf616a',
    '#ea580c': '#d08770',
    '#059669': '#8fbcbb',
    '#0891b2': '#88c0d0',
    '#4f46e5': '#81a1c1',
    '#65a30d': '#a3be8c',
};

export const CATPPUCCIN_MACCHIATO_EXTERNAL_CALENDAR_COLOR_MAP: Record<string, string> = {
    '#2563eb': '#8aadf4',
    '#7c3aed': '#c6a0f6',
    '#db2777': '#f5bde6',
    '#ea580c': '#f5a97f',
    '#059669': '#8bd5ca',
    '#0891b2': '#91d7e3',
    '#4f46e5': '#b7bdf8',
    '#65a30d': '#a6da95',
};

export const DRACULA_EXTERNAL_CALENDAR_COLOR_MAP: Record<string, string> = {
    '#2563eb': '#8be9fd',
    '#7c3aed': '#bd93f9',
    '#db2777': '#ff79c6',
    '#ea580c': '#ffb86c',
    '#059669': '#50fa7b',
    '#0891b2': '#a4ffff',
    '#4f46e5': '#6272a4',
    '#65a30d': '#f1fa8c',
};

export const GRUVBOX_LIGHT_EXTERNAL_CALENDAR_COLOR_MAP: Record<string, string> = {
    '#2563eb': '#076678',
    '#7c3aed': '#8f3f71',
    '#db2777': '#9d0006',
    '#ea580c': '#af3a03',
    '#059669': '#427b58',
    '#0891b2': '#458588',
    '#4f46e5': '#b16286',
    '#65a30d': '#79740e',
};

export const GRUVBOX_DARK_EXTERNAL_CALENDAR_COLOR_MAP: Record<string, string> = {
    '#2563eb': '#83a598',
    '#7c3aed': '#d3869b',
    '#db2777': '#fb4934',
    '#ea580c': '#fe8019',
    '#059669': '#8ec07c',
    '#0891b2': '#689d6a',
    '#4f46e5': '#458588',
    '#65a30d': '#b8bb26',
};

const EXTERNAL_CALENDAR_COLOR_MAPS_BY_THEME = new Map<AppTheme, Record<string, string>>([
    ['nord', NORD_EXTERNAL_CALENDAR_COLOR_MAP],
    ['catppuccin-macchiato', CATPPUCCIN_MACCHIATO_EXTERNAL_CALENDAR_COLOR_MAP],
    ['dracula', DRACULA_EXTERNAL_CALENDAR_COLOR_MAP],
    ['gruvbox-light', GRUVBOX_LIGHT_EXTERNAL_CALENDAR_COLOR_MAP],
    ['gruvbox-dark', GRUVBOX_DARK_EXTERNAL_CALENDAR_COLOR_MAP],
]);

export function themeExternalCalendarDisplayColor(color: string, theme?: string): string {
    const map = theme ? EXTERNAL_CALENDAR_COLOR_MAPS_BY_THEME.get(theme as AppTheme) : undefined;
    if (!map) return color;
    return map[color.toLowerCase()] ?? color;
}

/**
 * Whether a stored color counts as a deliberate pick for
 * `resolveExternalCalendarColor` — a stored color equal to the hash default is
 * treated as unset (see the resolver note above). The settings screens use
 * this to mark the Auto swatch as the active one.
 */
export function hasExplicitExternalCalendarColor(sourceId: string, explicitColor?: string): boolean {
    return Boolean(explicitColor) && explicitColor !== getExternalCalendarColorForId(sourceId || 'calendar');
}
