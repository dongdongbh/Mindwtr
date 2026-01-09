/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors, Material3 } from '@/constants/theme';
import { useTheme } from '@/contexts/theme-context';

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  const { colorScheme, themeStyle } = useTheme();
  const colorFromProps = props[colorScheme];

  const palette = themeStyle === 'material3'
    ? (colorScheme === 'dark' ? Material3.dark : Material3.light)
    : (colorScheme === 'dark' ? Colors.dark : Colors.light);

  const material3Map: Record<keyof typeof Colors.light, string> = {
    text: palette.text,
    background: palette.background,
    tint: themeStyle === 'material3' ? palette.primary : palette.tint,
    icon: themeStyle === 'material3' ? palette.secondaryText : palette.icon,
    tabIconDefault: themeStyle === 'material3' ? palette.secondaryText : palette.tabIconDefault,
    tabIconSelected: themeStyle === 'material3' ? palette.primary : palette.tabIconSelected,
  };

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return themeStyle === 'material3' ? material3Map[colorName] : palette[colorName];
  }
}
