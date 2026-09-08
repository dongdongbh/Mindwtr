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
    expect(config.android?.package).toBe('tech.dongdongbh.mindwtr');
    expect(config.ios?.bundleIdentifier).toBe('tech.dongdongbh.mindwtr');
    expect(widgetLabels(config)).toEqual(['Mindwtr']);
  });

  it('builds Mindwtr Dev with its own ids so it installs beside the store app', async () => {
    vi.stubEnv('APP_VARIANT', 'development');
    const config = await loadConfig();
    expect(config.name).toBe('Mindwtr Dev');
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
});
