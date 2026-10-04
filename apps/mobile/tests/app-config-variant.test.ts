import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import appJson from '../app.json';

const loadConfig = async (): Promise<ExpoConfig> => {
  vi.resetModules();
  const mod = await import('../app.config');
  return mod.default({ config: appJson.expo as ExpoConfig, projectRoot: '', staticConfigPath: null, packageJsonPath: null });
};

const widgetLabels = (config: ExpoConfig): string[] => (config.plugins ?? [])
  .filter((entry): entry is [string, { label: string }] => Array.isArray(entry) && entry[0] === './plugins/android-widget')
  .map(([, props]) => props.label);

describe('app.config APP_VARIANT', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('leaves the store identity alone when no variant is set', async () => {
    vi.stubEnv('APP_VARIANT', '');
    const config = await loadConfig();
    expect(config.name).toBe('Mindwtr');
    expect(config.ios?.infoPlist?.CFBundleSpokenName).toBe('Mind Water');
    expect(config.ios?.infoPlist?.INAlternativeAppNames).toEqual([{
      INAlternativeAppName: 'Mind Water',
      INAlternativeAppNamePronunciationHint: 'mind water',
    }]);
    expect(config.android?.package).toBe('tech.dongdongbh.mindwtr');
    expect(config.ios?.bundleIdentifier).toBe('tech.dongdongbh.mindwtr');
    expect(widgetLabels(config)).toEqual(['Mindwtr']);
  });

  it('builds Mindwtr Dev with its own ids so it installs beside the store app', async () => {
    vi.stubEnv('APP_VARIANT', 'development');
    const config = await loadConfig();
    expect(config.name).toBe('Mindwtr Dev');
    expect(config.ios?.infoPlist?.CFBundleSpokenName).toBe('Mind Water Dev');
    expect(config.ios?.infoPlist?.INAlternativeAppNames).toEqual([{
      INAlternativeAppName: 'Mind Water Dev',
      INAlternativeAppNamePronunciationHint: 'mind water dev',
    }]);
    expect(config.android?.package).toBe('tech.dongdongbh.mindwtr.dev');
    expect(config.ios?.bundleIdentifier).toBe('tech.dongdongbh.mindwtr.dev');
    expect(config.scheme).toBe('mindwtr');
    expect(widgetLabels(config)).toEqual(['Mindwtr Dev']);
  });

  it.each([
    ['benchmark', '', false],
    ['', '', false],
    ['development', '', true],
    ['development', 'false', false],
    ['', 'true', true],
    ['', '1', true],
    ['', '0', false],
  ])('gates Watch for variant=%s flag=%s', async (variant, flag, enabled) => {
    vi.stubEnv('APP_VARIANT', variant);
    vi.stubEnv('MINDWTR_WATCH_ENABLED', flag);
    const config = await loadConfig();
    expect(config.extra?.watchEnabled).toBe(enabled);
    expect(config.ios?.infoPlist?.MindwtrWatchEnabled).toBe(enabled);
    expect(config.plugins).toContainEqual(['./plugins/ios-watch', { enabled }]);
  });

  it('isolates the Android benchmark identity and disables heartbeat traffic', async () => {
    vi.stubEnv('APP_VARIANT', 'benchmark');
    const config = await loadConfig();
    expect(config.name).toBe('Mindwtr Benchmark');
    expect(config.android?.package).toBe('tech.dongdongbh.mindwtr.benchmark');
    expect(config.scheme).toBe('mindwtr-benchmark');
    expect(config.platforms).toEqual(['android']);
    expect(config.extra?.analyticsHeartbeatUrl).toBe('');
    expect(widgetLabels(config)).toEqual(['Mindwtr Benchmark']);
  });

  it.each([
    ['', '1'],
    ['benchmark', '1'],
    ['development', ''],
    ['development', '0'],
  ])('keeps PCC evaluation and its entitlement off for variant=%s flag=%s', async (variant, flag) => {
    vi.stubEnv('APP_VARIANT', variant);
    vi.stubEnv('MINDWTR_PCC_EVALUATION_ENABLED', flag);
    const config = await loadConfig();
    expect(config.extra?.applePccEvaluationEnabled).toBe(false);
    expect(config.ios?.infoPlist?.MindwtrPccEvaluationEnabled).toBe(false);
    expect(config.ios?.entitlements?.['com.apple.developer.private-cloud-compute']).toBeUndefined();
  });

  it('adds the managed PCC entitlement only to an explicitly opted-in development build', async () => {
    vi.stubEnv('APP_VARIANT', 'development');
    vi.stubEnv('MINDWTR_PCC_EVALUATION_ENABLED', '1');
    const config = await loadConfig();
    expect(config.extra?.applePccEvaluationEnabled).toBe(true);
    expect(config.ios?.infoPlist?.MindwtrPccEvaluationEnabled).toBe(true);
    expect(config.ios?.entitlements?.['com.apple.developer.private-cloud-compute']).toBe(true);
  });

  it('preserves unrelated iOS entitlements while stripping inherited PCC access when disabled', async () => {
    vi.stubEnv('APP_VARIANT', 'development');
    vi.stubEnv('MINDWTR_PCC_EVALUATION_ENABLED', '0');
    vi.resetModules();
    const mod = await import('../app.config');
    const base = {
      ...(appJson.expo as ExpoConfig),
      ios: {
        ...(appJson.expo.ios as ExpoConfig['ios']),
        entitlements: {
          'com.apple.developer.associated-domains': ['applinks:example.invalid'],
          'com.apple.developer.private-cloud-compute': true,
        },
      },
    } as ExpoConfig;
    const config = mod.default({ config: base, projectRoot: '', staticConfigPath: null, packageJsonPath: null });
    expect(config.ios?.entitlements).toEqual({
      'com.apple.developer.associated-domains': ['applinks:example.invalid'],
    });
  });
});
