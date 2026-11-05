import { resolveThemeColorScheme } from '@mindwtr/core';
import { Colors } from '../constants/theme';
import { THEME_PRESETS } from '../constants/theme-presets';
import { M3Colors, type M3ColorRoles } from '../constants/material3/m3-color';
import { M3Typography } from '../constants/material3/m3-typography';
import { M3Shape } from '../constants/material3/m3-shape';
import { buildElevationStyle, type ElevationStyle, type M3ElevationLevel } from '../constants/material3/m3-elevation';
import { buildStateLayer, type M3StateName } from '../constants/material3/m3-state';
import { useTheme, type ThemeContextType } from '../contexts/theme-context';

type ResolvableTheme = Pick<ThemeContextType, 'isDark' | 'themeStyle' | 'themePreset' | 'themeMode'>;


export interface ThemeColors {
  bg: string; cardBg: string; taskItemBg: string; text: string; secondaryText: string;
  icon: string; border: string; tint: string; onTint: string; tabIconDefault: string;
  tabIconSelected: string; inputBg: string; danger: string; success: string; warning: string;
  filterBg: string;
}

export const FALLBACK_THEME_COLORS: ThemeColors = {
  bg: Colors.light.background, cardBg: '#FFFFFF', taskItemBg: '#F1F5F9',
  text: Colors.light.text, secondaryText: '#4B5563', icon: Colors.light.icon,
  border: '#E2E8F0', tint: Colors.light.tint, onTint: '#FFFFFF',
  tabIconDefault: Colors.light.tabIconDefault, tabIconSelected: Colors.light.tabIconSelected,
  inputBg: '#EEF2F7', danger: '#EF4444', success: '#10B981', warning: '#F59E0B', filterBg: '#EEF2F7',
};

export interface ThemeTokens {
  colors: ThemeColors;
  roles: M3ColorRoles | null;
  type: typeof M3Typography;
  shape: typeof M3Shape;
  elevation: (level: M3ElevationLevel) => ElevationStyle;
  state: { rippleColor: string | undefined; stateLayerColor: (s: M3StateName) => string };
  isMaterial: boolean;
  isDark: boolean;
}

function m3RolesFor(theme: ResolvableTheme): M3ColorRoles {
  const scheme = resolveThemeColorScheme(theme.themeMode, theme.isDark ? 'dark' : 'light');
  return scheme === 'dark' ? M3Colors.dark : M3Colors.light;
}


function resolveGenericColors(theme: ResolvableTheme): ThemeColors {
  if (theme.themePreset !== 'default') {
    return THEME_PRESETS[theme.themePreset];
  }
  if (theme.themeStyle === 'material3') {
    const p = m3RolesFor(theme);
    return {
      bg: p.background, cardBg: p.surfaceContainer, taskItemBg: p.surfaceContainerHigh,
      text: p.text, secondaryText: p.secondaryText, icon: p.secondaryText,
      border: p.outline, tint: p.primary, onTint: p.onPrimary,
      tabIconDefault: p.secondaryText, tabIconSelected: p.primary,
      inputBg: p.surfaceVariant, danger: p.error, success: p.success, warning: p.warning,
      filterBg: p.surfaceVariant,
    };
  }
  const isDark = theme.isDark;
  return {
    bg: isDark ? Colors.dark.background : Colors.light.background,
    cardBg: isDark ? '#1F2937' : '#FFFFFF',
    taskItemBg: isDark ? '#1F2937' : '#F1F5F9',
    text: isDark ? Colors.dark.text : Colors.light.text,
    secondaryText: isDark ? '#9CA3AF' : '#4B5563',
    icon: isDark ? Colors.dark.icon : Colors.light.icon,
    border: isDark ? '#374151' : '#E2E8F0',
    tint: isDark ? Colors.dark.tint : Colors.light.tint,
    onTint: isDark ? '#0F172A' : '#FFFFFF',
    tabIconDefault: isDark ? Colors.dark.tabIconDefault : Colors.light.tabIconDefault,
    tabIconSelected: isDark ? Colors.dark.tabIconSelected : Colors.light.tabIconSelected,
    inputBg: isDark ? '#374151' : '#EEF2F7',
    danger: '#EF4444', success: '#10B981', warning: '#F59E0B',
    filterBg: isDark ? '#374151' : '#EEF2F7',
  };
}

const FALLBACK: ThemeTokens = {
  colors: FALLBACK_THEME_COLORS,
  roles: null, type: M3Typography, shape: M3Shape,
  elevation: () => ({}), state: { rippleColor: undefined, stateLayerColor: () => 'transparent' },
  isMaterial: false,
  isDark: false,
};


const themeCacheKey = (theme: ResolvableTheme) =>
  `${theme.isDark}|${theme.themeStyle}|${theme.themePreset}|${theme.themeMode}`;


let cached: { key: string; tokens: ThemeTokens } | null = null;

export function resolveThemeTokens(theme?: ResolvableTheme | null): ThemeTokens {
  if (!theme) return FALLBACK;
  const key = themeCacheKey(theme);
  if (cached?.key === key) return cached.tokens;
  const isMaterial = theme.themeStyle === 'material3';
  const roles = isMaterial ? m3RolesFor(theme) : null;
  const tokens: ThemeTokens = {
    colors: resolveGenericColors(theme),
    roles,
    type: M3Typography,
    shape: M3Shape,
    elevation: (level) => buildElevationStyle(level, { isMaterial, roles }),
    state: buildStateLayer({ isMaterial, roles }),
    isMaterial,
    isDark: theme.isDark,
  };
  cached = { key, tokens };
  return tokens;
}

export function useThemeTokens(): ThemeTokens {
  return resolveThemeTokens(useTheme());
}
