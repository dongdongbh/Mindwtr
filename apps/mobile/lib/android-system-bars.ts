import { requireOptionalNativeModule, type NativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { logInfo, logWarn } from './app-log';

interface MindwtrSystemBarsModule extends NativeModule {
  setNavigationBarColorAsync(color: string, darkButtons: boolean): Promise<boolean>;
  applyNavigationBarStyleAsync?(color: string, darkButtons: boolean): Promise<string>;
}

type AndroidSystemBarStyle = {
  navigationBarColor: string;
  darkNavigationButtons: boolean;
};

const systemBarsModule = Platform.OS === 'android'
  ? requireOptionalNativeModule<MindwtrSystemBarsModule>('MindwtrSystemBars')
  : null;

const parseHexColor = (color: string): { red: number; green: number; blue: number } | null => {
  const value = color.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(value);
  if (short) {
    const [red, green, blue] = short[1].split('').map((part) => Number.parseInt(`${part}${part}`, 16));
    return { red, green, blue };
  }

  const full = /^#([0-9a-f]{6})$/i.exec(value);
  if (!full) return null;
  const numeric = Number.parseInt(full[1], 16);
  return {
    red: (numeric >> 16) & 255,
    green: (numeric >> 8) & 255,
    blue: numeric & 255,
  };
};

const toLinearChannel = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const shouldUseDarkNavigationButtons = (backgroundColor: string, fallbackIsDark: boolean): boolean => {
  const rgb = parseHexColor(backgroundColor);
  if (!rgb) return !fallbackIsDark;
  const luminance = (0.2126 * toLinearChannel(rgb.red)) +
    (0.7152 * toLinearChannel(rgb.green)) +
    (0.0722 * toLinearChannel(rgb.blue));
  return luminance > 0.5;
};

export function resolveAndroidSystemBarStyle(colors: Pick<ThemeColors, 'bg'>, isDark: boolean): AndroidSystemBarStyle {
  return {
    navigationBarColor: colors.bg,
    darkNavigationButtons: shouldUseDarkNavigationButtons(colors.bg, isDark),
  };
}

export async function applyAndroidSystemBars(colors: Pick<ThemeColors, 'bg'>, isDark: boolean): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!systemBarsModule) return;

  const style = resolveAndroidSystemBarStyle(colors, isDark);
  try {


    if (!systemBarsModule.applyNavigationBarStyleAsync) {
      await systemBarsModule.setNavigationBarColorAsync(style.navigationBarColor, style.darkNavigationButtons);
      return;
    }
    const backend = await systemBarsModule.applyNavigationBarStyleAsync(style.navigationBarColor, style.darkNavigationButtons);


    if (backend === 'edge-to-edge' || backend === 'legacy-color') {
      void logInfo('Android navigation bar style applied', {
        scope: 'theme',
        extra: { releaseCheck: 'v1.3.1/android-system-bars', backend, outcome: 'applied' },
      });
    }
  } catch {
    void logWarn('Failed to apply Android system bar colors', {
      scope: 'theme',
      extra: { releaseCheck: 'v1.3.1/android-system-bars', outcome: 'failed' },
    });
  }
}
