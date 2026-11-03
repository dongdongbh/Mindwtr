import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function runSetup(packages) {

  const root = mkdtempSync(join(tmpdir(), 'mindwtr-sdk-setup-'));
  fixtures.push(root);
  const tools = join(root, 'cmdline-tools', '16.0', 'bin');
  mkdirSync(tools, { recursive: true });
  mkdirSync(join(root, 'platform-tools'));
  const manager = join(tools, 'sdkmanager');
  writeFileSync(manager, '#!/usr/bin/env bash\nif [[ "$1" == "--licenses" ]]; then cat >/dev/null; fi\nprintf "%s\\n" "$*" >> "$SDK_TEST_TRACE"\n');
  chmodSync(manager, 0o755);
  const env = { ...process.env, ANDROID_SDK_ROOT: root, SDK_TEST_TRACE: join(root, 'trace'), GITHUB_ENV: join(root, 'env'), GITHUB_PATH: join(root, 'path') };
  delete env.ANDROID_SDK_PACKAGES;
  delete env.ANDROID_CMDLINE_TOOLS_SHORT_VERSION;
  if (packages !== undefined) env.ANDROID_SDK_PACKAGES = packages;
  const result = spawnSync('bash', ['scripts/ci/setup-android-sdk.sh'], { env, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return { root, calls: readFileSync(env.SDK_TEST_TRACE, 'utf8').trim().split('\n'), exports: readFileSync(env.GITHUB_ENV, 'utf8'), paths: readFileSync(env.GITHUB_PATH, 'utf8') };
}

describe('Android SDK setup', () => {
  test('uses installed command-line tools and requests only current default packages', () => {
    const result = runSetup();
    expect(result.calls).toEqual(['--licenses', 'platform-tools']);
    expect(result.exports).toContain(`ANDROID_SDK_ROOT=${result.root}`);
    expect(result.paths).toContain(join(result.root, 'platform-tools'));
  });

  test('preserves explicit SDK package selections', () => {
    expect(runSetup('platform-tools platforms;android-36 build-tools;36.0.0').calls).toEqual([
      '--licenses', 'platform-tools', 'platforms;android-36', 'build-tools;36.0.0',
    ]);
  });
});
