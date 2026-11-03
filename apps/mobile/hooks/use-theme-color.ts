


import { resolveThemeColorScheme } from '@mindwtr/core';
import { Colors, Material3 } from '@/constants/theme';
import { THEME_PRESETS } from '@/constants/theme-presets';
import { useTheme } from '@/contexts/theme-context';

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  const { colorScheme, themeStyle, themePreset, themeMode } = useTheme();
  const colorFromProps = props[colorScheme];

  const defaultPalette = colorScheme === 'dark' ? Colors.dark : Colors.light;
  const materialPalette = resolveThemeColorScheme(themeMode, colorScheme) === 'dark'
    ? Material3.dark
    : Material3.light;
  const presetPalette = themePreset !== 'default' ? THEME_PRESETS[themePreset] : null;

  const mapColors = (): Record<keyof typeof Colors.light, string> => {
    if (presetPalette) {
      return {
        text: presetPalette.text,
        background: presetPalette.bg,
        tint: presetPalette.tint,
        icon: presetPalette.icon,
        tabIconDefault: presetPalette.tabIconDefault,
        tabIconSelected: presetPalette.tabIconSelected,
      };
    }
    if (themeStyle === 'material3') {
      return {
        text: materialPalette.text,
        background: materialPalette.background,
        tint: materialPalette.primary,
        icon: materialPalette.secondaryText,
        tabIconDefault: materialPalette.secondaryText,
        tabIconSelected: materialPalette.primary,
      };
    }
    return {
      text: defaultPalette.text,
      background: defaultPalette.background,
      tint: defaultPalette.tint,
      icon: defaultPalette.icon,
      tabIconDefault: defaultPalette.tabIconDefault,
      tabIconSelected: defaultPalette.tabIconSelected,
    };
  };

  const mapped = mapColors();

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return mapped[colorName];
  }
}
