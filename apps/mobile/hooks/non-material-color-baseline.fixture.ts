import { THEME_PRESETS } from '../constants/theme-presets';
import type { ThemeContextType } from '../contexts/theme-context';

type Resolvable = Pick<ThemeContextType, 'isDark' | 'themeStyle' | 'themePreset' | 'themeMode'>;

// Frozen snapshot of TODAY's resolved colors for every non-Material theme.
// Altering any value here is a regression unless it is an intentional,
// separately-reviewed change to a non-Material theme.
export const DEFAULT_LIGHT = {
  bg: '#F6F7FB', cardBg: '#FFFFFF', taskItemBg: '#F1F5F9',
  text: '#0F172A', secondaryText: '#4B5563', icon: '#4B5563',
  border: '#E2E8F0', tint: '#2563EB', onTint: '#FFFFFF',
  tabIconDefault: '#4B5563', tabIconSelected: '#2563EB',
  inputBg: '#EEF2F7', danger: '#EF4444', success: '#10B981',
  warning: '#F59E0B', filterBg: '#EEF2F7',
};
export const DEFAULT_DARK = {
  bg: '#151718', cardBg: '#1F2937', taskItemBg: '#1F2937',
  text: '#ECEDEE', secondaryText: '#9CA3AF', icon: '#9BA1A6',
  border: '#374151', tint: '#60A5FA', onTint: '#0F172A',
  tabIconDefault: '#9BA1A6', tabIconSelected: '#60A5FA',
  inputBg: '#374151', danger: '#EF4444', success: '#10B981',
  warning: '#F59E0B', filterBg: '#374151',
};

export const NON_MATERIAL_CASES: { name: string; theme: Resolvable; expected: Record<string, string> }[] = [
  { name: 'default-light', theme: { isDark: false, themeStyle: 'default', themePreset: 'default', themeMode: 'light' }, expected: DEFAULT_LIGHT },
  { name: 'default-dark', theme: { isDark: true, themeStyle: 'default', themePreset: 'default', themeMode: 'dark' }, expected: DEFAULT_DARK },
  { name: 'eink', theme: { isDark: false, themeStyle: 'default', themePreset: 'eink', themeMode: 'eink' }, expected: THEME_PRESETS.eink },
  { name: 'nord', theme: { isDark: true, themeStyle: 'default', themePreset: 'nord', themeMode: 'nord' }, expected: THEME_PRESETS.nord },
  { name: 'catppuccin-macchiato', theme: { isDark: true, themeStyle: 'default', themePreset: 'catppuccin-macchiato', themeMode: 'catppuccin-macchiato' }, expected: THEME_PRESETS['catppuccin-macchiato'] },
  { name: 'dracula', theme: { isDark: true, themeStyle: 'default', themePreset: 'dracula', themeMode: 'dracula' }, expected: THEME_PRESETS.dracula },
  { name: 'gruvbox-light', theme: { isDark: false, themeStyle: 'default', themePreset: 'gruvbox-light', themeMode: 'gruvbox-light' }, expected: THEME_PRESETS['gruvbox-light'] },
  { name: 'gruvbox-dark', theme: { isDark: true, themeStyle: 'default', themePreset: 'gruvbox-dark', themeMode: 'gruvbox-dark' }, expected: THEME_PRESETS['gruvbox-dark'] },
  { name: 'sepia', theme: { isDark: false, themeStyle: 'default', themePreset: 'sepia', themeMode: 'sepia' }, expected: THEME_PRESETS.sepia },
  { name: 'oled', theme: { isDark: true, themeStyle: 'default', themePreset: 'oled', themeMode: 'oled' }, expected: THEME_PRESETS.oled },
];
