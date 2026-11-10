import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const prepareCacheScript = fileURLToPath(new URL('./prepare-apple-cache.sh', import.meta.url));
const dispatchScript = fileURLToPath(new URL('./dispatch-macmini.sh', import.meta.url));

test('self-hosted pre-archive retirement requires smoke and uploaded evidence before the unchanged floor and archive', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/native-platform-ci.yml', import.meta.url)), 'utf8');
  const smoke = workflow.indexOf('- name: Smoke test cold and warm links');
  const upload = workflow.indexOf('- name: Upload completed simulator validation evidence');
  const retire = workflow.indexOf('- name: Retire completed simulator build outputs before archive');
  const floor = workflow.indexOf('- name: Ensure disk headroom before the device archive');
  const archive = workflow.indexOf('- name: Create unsigned Release device archive');
  expect(smoke).toBeGreaterThan(0); expect(upload).toBeGreaterThan(smoke);
  expect(retire).toBeGreaterThan(upload); expect(floor).toBeGreaterThan(retire); expect(archive).toBeGreaterThan(floor);
  expect(workflow.slice(smoke, upload)).toContain('id: ios27_smoke');
  const uploaded = workflow.slice(upload, retire);
  expect(uploaded).toContain('id: ios27_pre_archive_evidence');
  expect(uploaded).toContain("if: success() && runner.environment == 'self-hosted' && matrix.lane == 'xcode27' && steps.ios27_smoke.outcome == 'success'");
  expect(uploaded).toContain('uses: actions/upload-artifact@');
  expect(uploaded).toContain('name: ios27-simulator-validation-${{ github.run_id }}-${{ github.run_attempt }}');
  expect(uploaded).toContain('path: ${{ env.MINDWTR_APPLE_TEMP }}/ios27-artifacts');
  expect(uploaded).toContain('if-no-files-found: error');
  const retired = workflow.slice(retire, floor);
  for (const requirement of ["success()", "runner.environment == 'self-hosted'", "matrix.lane == 'xcode27'",
    "steps.apple_cache.outcome == 'success'", "steps.ios27_smoke.outcome == 'success'",
    "steps.ios27_pre_archive_evidence.outcome == 'success'", "steps.ios27_pre_archive_evidence.outputs.artifact-id != ''"]) {
    expect(retired).toContain(requirement);
  }
  expect(retired).toContain('MINDWTR_EVIDENCE_UPLOADED: "true"');
  expect(retired).toContain('run: python3 scripts/ci/cleanup-apple-outputs.py ios-pre-archive');
  expect(retired).not.toContain('always()');
  const step = workflow.slice(floor, archive);
  expect(step).toContain("if: success() && runner.environment == 'self-hosted' && matrix.lane == 'xcode27'");
  expect(step).toContain('run: bash scripts/ci/prepare-apple-cache.sh before-archive'); expect(step).not.toContain('always()');
  expect(workflow.match(/prepare-apple-cache\.sh before-archive/g)).toHaveLength(1);
  const finalUpload = workflow.indexOf('- name: Upload Xcode 27 validation evidence');
  const finalCleanup = workflow.indexOf('- name: Retire completed iOS build outputs');
  expect(finalUpload).toBeGreaterThan(archive); expect(finalCleanup).toBeGreaterThan(finalUpload);
  expect(workflow.slice(finalUpload, finalCleanup)).toContain('if: ${{ always() && matrix.lane');
  expect(workflow.slice(finalCleanup)).toContain("steps.ios27_evidence.outputs.artifact-id != ''");
  expect(workflow.slice(finalCleanup)).toContain('run: python3 scripts/ci/cleanup-apple-outputs.py ios');
});

test('the dispatch broker propagates failures, cancels interrupted runs, and rejects invalid commits', () => {
  const root = mkdtempSync(join(tmpdir(), 'mindwtr-dispatch-'));
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'uuidgen'), '#!/bin/sh\necho fixture-request\n', { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), `#!/bin/bash
set -eu
case "$1 $2" in
  'workflow run') ;;
  'run list') printf '[{"databaseId":123,"displayTitle":"Mindwtr %s / fixture-request"}]' "$SOURCE_SHA" ;;
  'api repos/dongdongbh/Mindwtr-native-ci/actions/runs/123')
    [ "$FIXTURE_RESULT" != interrupted ] || exit 1
    printf '{"status":"completed","conclusion":"%s"}' "$FIXTURE_RESULT" ;;
  'run download') touch "$RUNNER_TEMP/downloaded" ;;
  'run cancel') touch "$RUNNER_TEMP/cancelled" ;;
  *) echo "Unexpected gh arguments: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
    const run = (result, sha = 'a'.repeat(40)) => spawnSync('bash', [dispatchScript], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'fixture', RUNNER_TEMP: root,
      SOURCE_SHA: sha, FIXTURE_RESULT: result, GITHUB_STEP_SUMMARY: join(root, 'summary'),
    }});
    expect(run('success').status).toBe(0);
    expect(existsSync(join(root, 'downloaded'))).toBe(true);
    expect(run('failure').status).not.toBe(0);
    expect(existsSync(join(root, 'cancelled'))).toBe(false);
    expect(run('interrupted').status).not.toBe(0);
    expect(existsSync(join(root, 'cancelled'))).toBe(true);
    expect(run('success', 'main').status).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hosted Apple cache setup preserves its paths and does not require the SSD', () => {
  const root = mkdtempSync(join(tmpdir(), 'mindwtr-hosted-cache-'));
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'xcodebuild'), '#!/bin/sh\necho Xcode27\n', { mode: 0o755 });
    const envFile = join(root, 'env');
    const result = spawnSync('bash', [prepareCacheScript], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: root, GITHUB_ENV: envFile,
    } });
    expect(result.status).toBe(0);
    const output = readFileSync(envFile, 'utf8');
    expect(output).toContain(`MINDWTR_NATIVE_CACHE=${root}/mindwtr-native/`);
    expect(output).toContain(`MINDWTR_APPLE_TEMP=${root}`);
    expect(output).not.toContain('TMPDIR=');
    const archive = spawnSync('bash', [prepareCacheScript, 'before-archive'], { env: {
      ...process.env, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    } });
    expect(archive.status).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('self-hosted startup keeps dependencies and cleans stale generated sources after storage preparation', () => {
  const root = mkdtempSync(join(tmpdir(), 'mindwtr-self-hosted-cache-'));
  try {
    const bin = join(root, 'bin'); const repo = join(root, 'repo'); mkdirSync(bin); mkdirSync(repo);
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    for (const path of ['node_modules/dependency', 'apps/mobile/node_modules/dependency', 'apps/mobile/ios/stale.swift']) {
      mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), 'fixture');
    }
    writeFileSync(join(bin, 'python3'), '#!/bin/sh\ntest "$DEVELOPER_DIR" = /Applications/Xcode.app/Contents/Developer\ntest "$2" = startup\necho prepared > "$HOME/prepared"\n', { mode: 0o755 });
    writeFileSync(join(bin, 'watchman'), '#!/bin/sh\nexit 88\n', { mode: 0o755 });
    const result = spawnSync('bash', [prepareCacheScript], { cwd: repo, encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root,
      GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted',
      GITHUB_ENV: join(root, 'env'), GITHUB_PATH: join(root, 'path'),
    } });
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, 'prepared'), 'utf8').trim()).toBe('prepared');
    expect(existsSync(join(repo, 'node_modules/dependency'))).toBe(true);
    expect(existsSync(join(repo, 'apps/mobile/node_modules/dependency'))).toBe(true);
    expect(existsSync(join(repo, 'apps/mobile/ios/stale.swift'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
