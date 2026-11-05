import { describe, expect, it } from 'vitest';
import { resolveThemeTokens } from './use-theme-tokens';
import { M3Colors } from '../constants/material3/m3-color';

const m3Light = { isDark: false, themeStyle: 'material3', themePreset: 'default', themeMode: 'material3-light' } as const;
const eink = { isDark: false, themeStyle: 'default', themePreset: 'eink', themeMode: 'eink' } as const;

describe('resolveThemeTokens', () => {
  it('flags Material only for the material3 style', () => {
    expect(resolveThemeTokens(m3Light).isMaterial).toBe(true);
    expect(resolveThemeTokens(eink).isMaterial).toBe(false);
    expect(resolveThemeTokens(null).isMaterial).toBe(false);
  });
  it('exposes full M3 roles under Material and null otherwise', () => {
    expect(resolveThemeTokens(m3Light).roles).toEqual(M3Colors.light);
    expect(resolveThemeTokens(eink).roles).toBeNull();
  });
  it('self-gates behavioral tokens for non-Material themes', () => {
    const t = resolveThemeTokens(eink);
    expect(t.elevation(3)).toEqual({});
    expect(t.state.rippleColor).toBeUndefined();
    expect(t.state.stateLayerColor('pressed')).toBe('transparent');
  });
  it('activates behavioral tokens under Material', () => {
    const t = resolveThemeTokens(m3Light);
    expect(t.elevation(3).backgroundColor).toBe(M3Colors.light.surfaceContainerHigh);
    expect(t.state.rippleColor).toBeDefined();
  });


  it('returns the same object for equal inputs and a new one when the theme changes', () => {
    const light = { isDark: false, themeStyle: 'default', themePreset: 'default', themeMode: 'system' } as const;
    const first = resolveThemeTokens(light);
    expect(resolveThemeTokens({ ...light })).toBe(first);
    expect(resolveThemeTokens({ ...light }).colors).toBe(first.colors);

    const changed = [
      { ...light, isDark: true },
      { ...light, themeStyle: 'material3' as const, themeMode: 'material3-light' as const },
      { ...light, themePreset: 'nord' as const, themeMode: 'nord' as const },
    ];
    for (const theme of changed) {
      const next = resolveThemeTokens(theme);
      expect(next).not.toBe(first);
      expect(next.colors).not.toEqual(first.colors);
    }
  });
});
