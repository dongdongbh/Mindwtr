import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const workflow = (name) => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));

test('Play status discovers production and its maximum without an empty version code', () => {
  const step = workflow('rollout').jobs.play.steps.find((entry) => entry.env?.VERSION_CODE);
  const directory = mkdtempSync(join(tmpdir(), 'mindwtr-play-status-'));
  try {
    const result = spawnSync('bash', ['-c', `
      python3() {
        printf '%s\\n' "$*"
        for argument in "$@"; do
          [ -n "$argument" ] || return 1
        done
        printf '{}' > "\${!#}"
      }
      ${step.run}
    `], {
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: join(directory, 'summary'), ROLLOUT_ACTION: 'status', VERSION_CODE: '', ROLLOUT_PERCENTAGE: '20' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('rollout --package tech.dongdongbh.mindwtr --action status --result');
    expect(result.stdout).not.toContain('--version-code');
    expect(result.stdout).toContain('max-version-code --package tech.dongdongbh.mindwtr --result');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stable policy is validated before publishing and forwarded to every production store', () => {
  const stable = workflow('release');
  const inputs = stable.on.workflow_dispatch.inputs;
  expect(inputs.rollout_mode.default).toBe('staged');
  expect(inputs.rollout_percentage.default).toBe(5);
  const gate = stable.jobs.validate.steps.find((step) => step.id === 'rollout');
  expect(gate.env.ROLLOUT_MODE).toContain("vars.RELEASE_ROLLOUT_MODE || 'staged'");
  for (const job of ['android', 'windows']) {
    expect(stable.jobs[job].with.rollout_mode).toBe('${{ needs.validate.outputs.rollout_mode }}');
    expect(stable.jobs[job].with.rollout_percentage).toBe('${{ fromJSON(needs.validate.outputs.rollout_percentage) }}');
  }
  expect(inputs.run_msstore.default).toBe(true);
  expect(stable.jobs.windows.with.run_msstore).toBe("${{ github.event_name != 'workflow_dispatch' || inputs.run_msstore }}");
  for (const job of ['ios-appstore', 'macos-appstore']) {
    expect(stable.jobs[job].with.phased_release).toBe("${{ needs.validate.outputs.rollout_mode == 'staged' }}");
  }
});

test('an open production rollout fails the stable release before any build job', () => {
  const stable = workflow('release');
  const preflight = stable.jobs['rollout-preflight'];
  expect(preflight.needs).toBe('validate');
  expect(preflight.if).toContain("needs.validate.outputs.rollout_mode == 'staged'");

  expect(preflight.if).toContain("github.repository == 'dongdongbh/Mindwtr'");
  expect(preflight.concurrency.group).toBe('google-play-production');


  const selected = new Function('github', 'inputs', 'needs', `return Boolean(${
    preflight.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/always\(\)/g, 'true')
      .replace(/\bneeds\.([\w-]+)/g, 'needs["$1"]')
  })`);
  const needs = { validate: { result: 'success', outputs: { rollout_mode: 'staged' } } };
  const repository = 'dongdongbh/Mindwtr';
  expect(selected({ event_name: 'push', repository }, {}, needs)).toBe(true);
  expect(selected({ event_name: 'push', repository: 'someone/Mindwtr' }, {}, needs)).toBe(false);
  expect(selected({ event_name: 'push', repository }, {}, {
    validate: { result: 'success', outputs: { rollout_mode: 'immediate' } },
  })).toBe(false);
  for (const [dispatched, expected] of [
    [{ run_linux: true, run_macos: true }, false],
    [{ run_update_packages: true }, false],
    [{ run_android: true }, true],
    [{ run_windows: true, run_msstore: true }, true],
    [{ run_windows: true, run_msstore: false }, false],
  ]) {
    expect(selected({ event_name: 'workflow_dispatch', repository }, dispatched, needs)).toBe(expected);
  }

  const check = preflight.steps.at(-1);
  expect(check.env.CHECK_PLAY).toContain('inputs.run_android');
  expect(check.env.CHECK_MSSTORE).toContain('inputs.run_windows');
  expect(check.env.CHECK_MSSTORE).toContain('inputs.run_msstore');
  expect(check.run).toContain('if [ "${CHECK_PLAY:-}" != "true" ]');
  expect(check.run).toContain('if [ "${CHECK_MSSTORE:-}" != "true" ]');
  expect(check.run).toContain('--action status');
  expect(check.run).toContain('google-play-edit.py rollout');
  expect(check.run).toContain('msstore-rollout.mjs --action status');
  expect(check.run).toContain('docs/development/store-rollouts.md');
  expect(check.run).toContain('exit 1');
  for (const step of preflight.steps) {
    expect(step.run ?? '').not.toMatch(/(?:upload|publish|--action (?:auto|increase|halt|finalize)|tauri build)/);
  }

  for (const job of [
    'android-version-code', 'linux', 'macos', 'windows',
    'android', 'android-foss', 'ios-appstore', 'macos-appstore',
  ]) {
    expect(stable.jobs[job].needs).toContain('rollout-preflight');

    expect(stable.jobs[job].if).toContain(
      "(needs['rollout-preflight'].result == 'success' || needs['rollout-preflight'].result == 'skipped')",
    );
  }
});

test('Windows artifact recovery can leave an accepted Store submission and flight intact', () => {
  const stable = workflow('release');
  const evaluate = (expression, event_name, run_msstore) => new Function(
    'github', 'inputs', 'vars',
    `return Boolean(${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')})`,
  )({ event_name }, { run_windows: true, run_msstore }, { MSSTORE_FLIGHT_ID: 'existing-flight' });
  for (const [event, selected, expected] of [
    ['push', false, true],
    ['workflow_dispatch', true, true],
    ['workflow_dispatch', false, false],
  ]) {
    expect(evaluate(stable.jobs.windows.with.run_msstore, event, selected)).toBe(expected);
    expect(evaluate(stable.jobs.windows.with.run_msstore_flight, event, selected)).toBe(expected);
    const preflight = stable.jobs['rollout-preflight'].steps.at(-1);
    expect(evaluate(preflight.env.CHECK_MSSTORE, event, selected)).toBe(expected);
  }
  const windows = workflow('release-windows').jobs.standalone.steps;
  const resolve = windows.find((step) => step.id === 'version');
  expect(resolve.env.RUN_MSSTORE).toBe('${{ inputs.run_msstore }}');
  expect(resolve.run).toContain("-or $env:RUN_MSSTORE -eq 'true'");
  for (const name of ['Check Microsoft Store submission status', 'Publish to Microsoft Store (metadata + package)']) {
    expect(windows.find((step) => step.name === name).if).toContain("steps.version.outputs.store_stable == 'true'");
  }
});

test('the Windows stable Store path fails instead of exiting zero on an open rollout', () => {
  const windows = workflow('release-windows');
  const publish = windows.jobs.standalone.steps.find(
    (step) => step.id === 'msstore_publish',
  );
  expect(publish.if).toContain("steps.version.outputs.store_stable == 'true'");
  const refusals = [...publish.run.matchAll(/if \(& \$is(RolloutOpen|StoreBusy) \$errText\) \{\n(.*)\n/g)]
    .map((match) => [match[1], match[2].trim()]);

  expect(refusals.map(([matcher]) => matcher)).toEqual([
    'RolloutOpen', 'StoreBusy', 'RolloutOpen', 'StoreBusy',
  ]);
  for (const [matcher, body] of refusals) {
    if (matcher === 'RolloutOpen') expect(body).toBe('throw $rolloutOpenMessage');
    else expect(body).toStartWith('Write-Warning');
  }
  expect(publish.run).toContain('package rollout is still open');
  expect(publish.run).toContain('Get-StoreErrorText -ErrorRecord $_');
});

test('release policy shell accepts valid modes and rejects unsafe percentages and unknown modes', () => {
  const gate = workflow('release').jobs.validate.steps.find((step) => step.id === 'rollout');
  const directory = mkdtempSync(join(tmpdir(), 'mindwtr-rollout-policy-'));
  try {
    for (const [mode, percentage, valid] of [
      ['staged', '5', true], ['staged', '20.5', true], ['immediate', '5', true],
      ['oops', '5', false], ['staged', '0', false], ['staged', '-1', false],
      ['staged', '100', false], ['staged', 'nan', false], ['staged', 'inf', false],
      ['staged', '', false],
    ]) {
      const outputPath = join(directory, `${mode}-${percentage}.txt`);
      const result = spawnSync('bash', ['-e', '-c', gate.run], {
        encoding: 'utf8',
        env: { ...process.env, ROLLOUT_MODE: mode, ROLLOUT_PERCENTAGE: percentage,
          GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: join(directory, 'summary.md') },
      });
      expect(result.status === 0).toBe(valid);
      if (valid) expect(readFileSync(outputPath, 'utf8')).toContain(`mode=${mode}\n`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Apple stable metadata enables phasing while TestFlight-only metadata remains untouched', () => {
  for (const [name, job, upload] of [
    ['release-ios-appstore', 'ios-appstore', 'Upload IPA to App Store Connect'],
    ['release-macos-appstore', 'macos-appstore', 'Upload to App Store Connect'],
  ]) {
    const apple = workflow(name);
    for (const trigger of ['workflow_call', 'workflow_dispatch']) {
      expect(apple.on[trigger].inputs.phased_release.default).toBe(true);
    }
    const step = apple.jobs[job].steps.find((item) => item.name === upload)
      ?? apple.jobs[job].steps.find((item) => item.run?.includes('deliver_options = {'));
    expect(step.env.PHASED_RELEASE).toBe("${{ inputs.phased_release && 'true' || 'false' }}");
    expect(step.run).toContain('automatic_release: true');
    expect(step.run).toContain('unless ENV.fetch("SKIP_METADATA", "false") == "true"\n');
    expect(step.run).toContain('deliver_options[:phased_release] = ENV.fetch("PHASED_RELEASE", "true") == "true"');
  }
  const rc = workflow('release-rc');
  expect(rc.jobs['ios-appstore'].with.testflight_only).toBe(true);
  expect(rc.jobs['ios-appstore'].with.submit_for_review).toBe(false);
  expect(rc.jobs['macos-appstore'].with.submit_for_review).toBe(false);
});

test('rollout workflow schedules one automatic stage per day and retains explicit controls', () => {
  const rollout = workflow('rollout');
  expect(Object.keys(rollout.on)).toEqual(['schedule', 'workflow_dispatch']);
  expect(rollout.on.schedule).toEqual([{ cron: '17 15 * * *' }]);
  expect(rollout.on.workflow_dispatch.inputs.action.default).toBe('status');
  expect(rollout.permissions).toEqual({ contents: 'read' });
  const gate = rollout.jobs['promotion-gate'];
  expect(gate.if).toContain("github.repository == 'dongdongbh/Mindwtr'");
  expect(gate.outputs.ready).toBe('${{ steps.age.outputs.ready }}');
  const age = gate.steps.find((step) => step.id === 'age');
  expect(age.run).toContain('releases/latest');
  expect(age.run).toContain('age_seconds');
  expect(age.run).toContain('-lt 86400');
  expect(rollout.jobs.play.concurrency.group).toBe('google-play-production');
  expect(rollout.jobs.msstore.concurrency.group).toBe('msstore-production');
  expect(rollout.jobs.play.needs).toBe('promotion-gate');
  expect(rollout.jobs.msstore.needs).toBe('promotion-gate');
  expect(rollout.jobs.play.if).toContain("github.event_name == 'schedule'");
  expect(rollout.jobs.msstore.if).toContain("github.event_name == 'schedule'");
  expect(rollout.jobs.play.if).toContain("needs.promotion-gate.outputs.ready == 'true'");
  expect(rollout.jobs.msstore.if).toContain("needs.promotion-gate.outputs.ready == 'true'");

  for (const job of [rollout.jobs.play, rollout.jobs.msstore]) {
    expect(job.if).toContain("github.repository == 'dongdongbh/Mindwtr'");
  }
  const play = rollout.jobs.play.steps.find((step) => step.env?.VERSION_CODE);
  expect(play.run).toContain('--version-code "$VERSION_CODE"');
  expect(play.run).toContain('auto-rollout --package tech.dongdongbh.mindwtr');
  expect(play.env.ROLLOUT_ACTION).toContain("github.event_name == 'schedule'");
  expect(play.run).toContain('google-play-edit.py "${args[@]}"');
  const msstore = rollout.jobs.msstore.steps.find((step) => step.env?.SUBMISSION_ID);
  expect(msstore.run).toContain('--submission-id "$SUBMISSION_ID"');
  expect(msstore.run).toContain('[ "$ROLLOUT_ACTION" = status ] && [ -z "$SUBMISSION_ID" ]');
  expect(msstore.run).toContain('args=(--action status)');
  expect(msstore.run).toContain('args=(--action auto)');
  expect(msstore.env.ROLLOUT_ACTION).toContain("github.event_name == 'schedule'");
  expect(msstore.env.MS_STORE_APP_ID).toBe("${{ secrets.MS_STORE_APP_ID || '9N0V5B0B6FRX' }}");
  for (const job of [rollout.jobs.play, rollout.jobs.msstore]) {
    expect(job.concurrency['cancel-in-progress']).toBe(false);
    for (const step of job.steps) {
      expect(step.run ?? '').not.toMatch(/(?:upload|create-plan|build-aab|tauri build)/);
    }
  }
});

test('automatic rollout waits for the newest stable release and its first 24 hours', () => {
  const gate = workflow('rollout').jobs['promotion-gate'].steps.find((step) => step.id === 'age');
  const directory = mkdtempSync(join(tmpdir(), 'mindwtr-rollout-age-'));
  try {
    writeFileSync(join(directory, 'gh'), `#!/bin/sh
case "$2" in
  */git/matching-refs/tags/v) printf '%s\\n' "$MOCK_STABLE_TAGS" ;;
  *) if [ "$4" = .tag_name ]; then printf 'v1.3.5\\n'; else printf '%s\\n' "$MOCK_PUBLISHED_AT"; fi ;;
esac
`, { mode: 0o755 });
    for (const [hours, tags, ready] of [[23, 'v1.3.5', false], [25, 'v1.3.5', true], [25, 'v1.3.10\nv1.3.9\nv1.3.5', false]]) {
      const outputPath = join(directory, `${hours}-${ready}.txt`);
      const result = spawnSync('bash', ['-e', '-c', gate.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_EVENT_NAME: 'schedule',
          GITHUB_REPOSITORY: 'dongdongbh/Mindwtr',
          GITHUB_OUTPUT: outputPath,
          MOCK_PUBLISHED_AT: new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(),
          MOCK_STABLE_TAGS: tags,
        },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(outputPath, 'utf8')).toContain(`ready=${ready}\n`);
      if (tags.includes('v1.3.10')) expect(result.stdout).toContain('Stable tag v1.3.10 has not published');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('generated Fastlane code passes the requested phase policy and omits it for skipped metadata', () => {
  for (const [name, job] of [
    ['release-ios-appstore', 'ios-appstore'],
    ['release-macos-appstore', 'macos-appstore'],
  ]) {
    const step = workflow(name).jobs[job].steps.find((item) => item.run?.includes('deliver_options = {'));
    const fastfile = step.run.match(/cat <<'EOF' > fastlane\/Fastfile\n([\s\S]*?)\nEOF/)[1];
    const stubs = `require 'json'
def opt_out_usage; end
def default_platform(*); end
def platform(*); yield; end
def lane(*); yield; end
def app_store_connect_api_key(**); nil; end
def update_app_age_rating(**options); $age_rating = JSON.parse(File.read(options.fetch(:age_rating_config_path))); end
def deliver(options); puts JSON.generate(options.merge(age_rating: $age_rating)); end
`;
    for (const [phased, skipMetadata] of [['true', 'false'], ['false', 'false'], ['true', 'true']]) {
      const result = spawnSync('ruby', ['-'], {
        input: stubs + fastfile,
        encoding: 'utf8',
        env: { ...process.env, PHASED_RELEASE: phased, SKIP_METADATA: skipMetadata,
          GITHUB_WORKSPACE: process.cwd(),
          EXPECTED_BUNDLE_ID: 'tech.dongdongbh.mindwtr', APP_VERSION: '1.0.5',
          IPA_PATH: 'fixture.ipa', PKG_PATH: 'fixture.pkg', FASTLANE_METADATA_PATH: 'fixture',
          FASTLANE_ASC_KEY_ID: 'fixture', FASTLANE_ASC_ISSUER_ID: 'fixture', ASC_KEY_PATH: 'fixture',
        },
      });
      expect(result.status).toBe(0);
      const options = JSON.parse(result.stdout);
      expect(options.automatic_release).toBe(true);
      expect(options.age_rating).toEqual(skipMetadata === 'true' ? null : { socialMedia: false, socialMediaAgeRestricted: false });
      expect(options.phased_release).toBe(skipMetadata === 'true' ? undefined : phased === 'true');
    }
  }
});

test('all Play edit sessions share the rollout lock, including RC and version lookups', () => {
  const expected = workflow('rollout').jobs.play.concurrency;
  for (const [name, jobs] of [
    ['release', ['android-version-code']],
    ['release-rc', ['android-version-code']],
    ['release-android', ['preflight', 'publish']],
  ]) {
    const release = workflow(name);
    for (const job of jobs) expect(release.jobs[job].concurrency).toEqual(expected);

    expect(release.concurrency.group).not.toBe(expected.group);
  }
});
