import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import appJson from '../app.json';

const loadConfig = async (): Promise<ExpoConfig> => {
  vi.resetModules();
  const mod = await import('../app.config');
  return mod.default({ config: appJson.expo as ExpoConfig, projectRoot: '', staticConfigPath: null, packageJsonPath: null });
};

const widgetLabels = (config: ExpoConfig): string[] => (config.plugins ?? [])
  .filter((entry): entry is [string, { widgets: Array<{ label: string }> }] => Array.isArray(entry) && entry[0] === './plugins/react-native-android-widget')
  .flatMap(([, props]) => props.widgets.map((widget) => widget.label));

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
});
