import { resolveThemeTokens, type ThemeColors, FALLBACK_THEME_COLORS } from './use-theme-tokens';
import { useTheme, type ThemeContextType } from '../contexts/theme-context';


export type { ThemeColors };
export { FALLBACK_THEME_COLORS };

export function resolveThemeColors(
  theme?: Pick<ThemeContextType, 'isDark' | 'themeStyle' | 'themePreset' | 'themeMode'> | null,
): ThemeColors {
  return resolveThemeTokens(theme).colors;
}

export function useThemeColors() {
  return resolveThemeColors(useTheme());
}
