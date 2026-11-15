import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const allowed = (version) => spawnSync('bash', ['scripts/ci/rn-ios-release-allowed.sh', version], { encoding: 'utf8' });
const workflow = (name) => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
const condition = (expression) => {
  const body = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/always\(\)/g, 'true').replace(/\bneeds\.([\w-]+)/g, 'needs["$1"]');
  return new Function('github', 'inputs', 'needs', `return Boolean(${body})`);
};

test('React Native iOS release candidates stop at 1.4.0, where native iOS RCs start', () => {
  for (const version of ['1.3.9', 'v1.3.9', '1.3.9-rc.2', 'v1.3.10-rc.1', '0.9.0']) {
    expect(allowed(version)).toMatchObject({ status: 0, stdout: 'true\n' });
  }
  for (const version of ['1.4.0', 'v1.4.0-rc.1', '1.4.1', '1.10.0', '2.0.0']) {
    expect(allowed(version)).toMatchObject({ status: 0, stdout: 'false\n' });
  }
  for (const version of ['', 'x', '1.4', 'v1.x.0']) expect(allowed(version).status).not.toBe(0);
});

test('an RC at 1.4.0 or higher skips the React Native iOS TestFlight job and still publishes the prerelease', () => {
  const rc = workflow('release-rc');
  const base = rc.jobs.validate.steps.find((step) => step.id === 'base');
  expect(base.run).toContain('rn_ios=$(bash scripts/ci/rn-ios-release-allowed.sh "$BASE_VERSION")');
  expect(rc.jobs.validate.outputs.rn_ios).toBe('${{ steps.base.outputs.rn_ios }}');
  const ios = condition(rc.jobs['ios-appstore'].if);
  const needs = (rnIos) => ({ validate: { result: 'success', outputs: { existing_release: 'false', rn_ios: rnIos } } });
  expect(ios({ event_name: 'push' }, {}, needs('true'))).toBe(true);
  expect(ios({ event_name: 'push' }, {}, needs('false'))).toBe(false);
  expect(ios({ event_name: 'workflow_dispatch' }, { run_ios_testflight: true }, needs('false'))).toBe(false);
  expect(rc.jobs.prerelease.if).toContain("needs.ios-appstore.result == 'skipped'");
});
