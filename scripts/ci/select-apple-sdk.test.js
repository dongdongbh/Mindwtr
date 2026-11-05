import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { parse } from 'yaml';

const fixtures = [];
afterEach(() => fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture({ installed = ['26.4', '27.0'], sdk = '27.0', xcodeVersion = 'Xcode 27.0\nBuild version 27A266a' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mindwtr-sdk-test-'));
  fixtures.push(root);
  const applications = join(root, 'Applications');
  const bin = join(root, 'bin');
  mkdirSync(applications);
  mkdirSync(bin);
  for (const version of installed) {
    const app = version === 'default' ? 'Xcode.app' : `Xcode_${version}.app`;
    mkdirSync(join(applications, app, 'Contents', 'Developer'), { recursive: true });
  }
  writeFileSync(join(bin, 'xcodebuild'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_XCODE_VERSION"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'xcrun'), '#!/bin/sh\nif [ "$1" = "swiftc" ]; then echo "Swift fixture"; else echo "$FIXTURE_SDK"; fi\n', { mode: 0o755 });
  return {
    root,
    run: (major, script) => spawnSync('bash', script ? ['-c', script] : [resolve('scripts/ci/select-apple-sdk.sh'), major], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        MINDWTR_XCODE_APPLICATIONS_DIR: applications,
        FIXTURE_SDK: sdk,
        FIXTURE_XCODE_VERSION: xcodeVersion,
        GITHUB_ENV: join(root, 'env'),
        GITHUB_STEP_SUMMARY: join(root, 'summary'),
      },
    }),
  };
}

test('the requested SDK is recorded for subsequent native build steps', () => {
  const testCase = fixture();
  const result = testCase.run('27');
  expect(result.status).toBe(0);
  expect(readFileSync(join(testCase.root, 'env'), 'utf8')).toContain('Xcode_27.0.app/Contents/Developer');
  expect(readFileSync(join(testCase.root, 'env'), 'utf8')).toContain('MINDWTR_VALIDATED_IOS_SDK=27.0');
});

test('an unavailable requested Xcode fails instead of falling back to another SDK', () => {
  const result = fixture({ installed: ['26.4'], sdk: '26.4' }).run('27');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Required Xcode 27 is not installed');
});

test('a matching application name is insufficient if the SDK is wrong', () => {
  const result = fixture({ sdk: '26.4' }).run('27');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('selected Xcode provides 26.4');
});

test('the explicit legacy SDK selector still works and rejects arbitrary input', () => {
  expect(fixture({ sdk: '26.4' }).run('26').status).toBe(0);
  expect(fixture().run('latest').status).not.toBe(0);
  execFileSync('bash', ['-n', 'scripts/ci/select-apple-sdk.sh']);
});

test('iOS 27 matrix validation includes an unsigned archive and states its limits', () => {
  const workflow = parse(readFileSync('.github/workflows/native-platform-ci.yml', 'utf8'));
  expect(workflow.jobs['ios-native'].strategy.matrix).toBe('${{ fromJSON(needs.changes.outputs.ios_matrix) }}');
  const steps = workflow.jobs['ios-native'].steps;
  expect(steps.find((step) => step.name === 'Select the requested Apple SDK').run).toContain('select-apple-sdk.sh');
  const archive = steps.find((step) => step.name === 'Create unsigned Release device archive with Xcode 27');
  expect(archive.if).toContain("matrix.lane == 'xcode27'");
  expect(archive.run).toContain('-configuration Release');
  expect(archive.run).toContain('CODE_SIGNING_ALLOWED=NO');
  expect(steps.find((step) => step.name === 'Record archive validation limits').run).toContain('remain separate validation gates');
});


test('release preflight accepts validated Xcode 27.x and rejects other SDKs', () => {
  const release = parse(readFileSync('.github/workflows/release-ios-appstore.yml', 'utf8'));
  const job = release.jobs['ios-appstore'];
  expect(job['runs-on']).toBe('xcode-27');
  const step = job.steps.find((step) => step.name === 'Select release Xcode 27.x');
  const supported = fixture({ installed: ['default', '27.2_beta'], sdk: '27.0' });
  expect(supported.run('27', step.run).status).toBe(0);
  expect(readFileSync(join(supported.root, 'env'), 'utf8')).toContain('Xcode.app/Contents/Developer');
  expect(fixture({ installed: ['default'], sdk: '26.4' }).run('27', step.run).status).not.toBe(0);
  expect(fixture({ installed: ['26.4'] }).run('27', step.run).status).not.toBe(0);
  const betaOnly = fixture({ installed: ['27.2_beta'], sdk: '27.2' });
  const betaApp = join(betaOnly.root, 'Applications', 'Xcode_27.2_beta.app');
  rmSync(join(betaOnly.root, 'Applications', 'Xcode.app'), { recursive: true, force: true });
  symlinkSync(betaApp, join(betaOnly.root, 'Applications', 'Xcode.app'));
  expect(betaOnly.run('27', step.run).status).not.toBe(0);
});
