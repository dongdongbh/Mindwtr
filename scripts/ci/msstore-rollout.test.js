import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { pwshTest } from './pwsh-test.mjs';
import {
  autoAdvanceRollout,
  createStoreRequest,
  manageRollout,
  parseArgs,
  runCli,
} from './msstore-rollout.mjs';

const appId = '9N0V5B0B6FRX';
const submissionId = '1152921504621225621';
const api = 'https://manage.devcenter.microsoft.com/v1.0/my';
const appPath = `applications/${appId}`;
const submissionPath = `${appPath}/submissions/${submissionId}`;
const rolloutPath = `${submissionPath}/packagerollout`;

function fixture({ app = {}, submission = {}, rollout = {}, postResponse } = {}) {
  const calls = [];
  const request = async (method, path) => {
    calls.push({ method, path });
    if (method === 'GET' && path === appPath) {
      return {
        id: appId,
        lastPublishedApplicationSubmission: { id: submissionId },
        ...app,
      };
    }
    if (method === 'GET' && path === submissionPath) {
      return { id: submissionId, status: 'Published', ...submission };
    }
    if (method === 'GET' && path === rolloutPath) {
      return {
        isPackageRollout: true,
        packageRolloutPercentage: 5,
        packageRolloutStatus: 'PackageRolloutInProgress',
        fallbackSubmissionId: '1152921504621000000',
        ...rollout,
      };
    }
    if (method === 'POST') {
      return postResponse ?? {
        isPackageRollout: true,
        packageRolloutPercentage: path.includes('percentage=')
          ? Number(new URL(`${api}/${path}`).searchParams.get('percentage'))
          : 0,
        packageRolloutStatus: path.endsWith('/haltpackagerollout')
          ? 'PackageRolloutStopped'
          : 'PackageRolloutComplete',
        fallbackSubmissionId: '1152921504621000000',
      };
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  const run = options => manageRollout({
    appId,
    submissionId,
    action: 'status',
    request,
    log: () => {},
    ...options,
  });
  return { calls, request, run };
}

test('CLI requires an explicit submission, a supported action, and a bounded percentage', () => {
  expect(parseArgs(['--submission-id', submissionId, '--action', 'status'])).toEqual({
    submissionId,
    action: 'status',
    percentage: undefined,
  });
  expect(parseArgs(['--submission-id', submissionId, '--action', 'increase', '--percentage', '20'])).toEqual({
    submissionId,
    action: 'increase',
    percentage: 20,
  });
  expect(parseArgs(['--action', 'auto'])).toEqual({
    submissionId: undefined,
    action: 'auto',
    percentage: undefined,
  });

  expect(parseArgs(['--action', 'status'])).toEqual({
    submissionId: undefined,
    action: 'status',
    percentage: undefined,
    resultPath: undefined,
  });
  for (const argv of [
    ['--submission-id', submissionId],
    ['--action', 'halt'],
    ['--action', 'finalize'],
    ['--action', 'increase', '--percentage', '20'],
    ['--submission-id', '../old', '--action', 'status'],
    ['--submission-id', submissionId, '--action', 'resume'],
    ['--submission-id', submissionId, '--action', 'increase'],
    ['--submission-id', submissionId, '--action', 'increase', '--percentage', '5e309'],
    ['--submission-id', submissionId, '--action', 'increase', '--percentage', '0'],
    ['--submission-id', submissionId, '--action', 'increase', '--percentage', '100'],
    ['--submission-id', submissionId, '--action', 'halt', '--percentage', '20'],
    ['--submission-id', submissionId, '--action', 'status', '--unknown', 'x'],
    ['--submission-id', submissionId, '--action', 'auto'],
    ['--action', 'auto', '--percentage', '20'],
  ]) {
    expect(() => parseArgs(argv)).toThrow();
  }
});

test('Store transport is fixed-origin, bodyless, authenticated, and never uploads', async () => {
  const calls = [];
  const request = createStoreRequest({
    token: 'fixture-token',
    tenantId: '11111111-2222-3333-4444-555555555555',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  await request('GET', appPath);
  await request('POST', `${submissionPath}/haltpackagerollout`);
  expect(calls.map(call => call.url)).toEqual([
    `${api}/${appPath}`,
    `${api}/${submissionPath}/haltpackagerollout`,
  ]);
  for (const { options } of calls) {
    expect(options.headers).toEqual({
      Authorization: 'Bearer fixture-token',
      TenantId: '11111111-2222-3333-4444-555555555555',
    });
    expect(options.body).toBeUndefined();
    expect(['GET', 'POST']).toContain(options.method);
    expect(options.redirect).toBe('error');
  }
  await expect(request('PUT', submissionPath)).rejects.toThrow('GET and POST');
  await expect(request('GET', 'https://example.blob.core.windows.net/upload')).rejects.toThrow('fixed Microsoft Store origin');
  await expect(request('GET', '../applications/other')).rejects.toThrow('fixed Microsoft Store origin');
});

test('CLI authentication and Store reads reject redirects', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://login.microsoftonline.com/')) {
      return new Response(JSON.stringify({ access_token: 'fixture-token' }), { status: 200 });
    }
    if (url === `${api}/${appPath}`) {
      return new Response(JSON.stringify({ id: appId, lastPublishedApplicationSubmission: { id: submissionId } }), { status: 200 });
    }
    if (url === `${api}/${submissionPath}`) {
      return new Response(JSON.stringify({ id: submissionId, status: 'Published' }), { status: 200 });
    }
    if (url === `${api}/${rolloutPath}`) {
      return new Response(JSON.stringify({
        isPackageRollout: true,
        packageRolloutPercentage: 5,
        packageRolloutStatus: 'PackageRolloutInProgress',
        fallbackSubmissionId: '1152921504621000000',
      }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  await runCli({
    argv: ['--submission-id', submissionId, '--action', 'status'],
    env: {
      MS_TENANT_ID: '11111111-2222-3333-4444-555555555555',
      MS_CLIENT_ID: 'fixture-client',
      MS_CLIENT_SECRET: 'fixture-secret',
      MS_STORE_APP_ID: appId,
    },
    fetchImpl,
    log: () => {},
  });
  expect(calls).toHaveLength(4);
  expect(calls.every(call => call.options.redirect === 'error')).toBe(true);
});

test('status is read-only and reports the current published rollout', async () => {
  const { calls, run } = fixture();
  const result = await run({ action: 'status' });
  expect(result).toEqual({
    submissionId,
    action: 'status',
    isPackageRollout: true,
    percentage: 5,
    status: 'PackageRolloutInProgress',
    open: true,
    fallbackSubmissionId: '1152921504621000000',
    pendingSubmissionId: '',
  });
  expect(calls.map(call => call.method)).toEqual(['GET', 'GET', 'GET']);
});

test('status reads the exact pending submission without rollout requests or mutations', async () => {
  for (const status of ['Certification', 'CommitStarted']) {
    const app = { lastPublishedApplicationSubmission: { id: '777' }, pendingApplicationSubmission: { id: submissionId } };
    const { calls, run } = fixture({ app, submission: { status } });
    expect(await run()).toEqual({ submissionId, action: 'status', status, percentage: null, open: false, pendingSubmissionId: submissionId });
    expect(calls).toEqual([{ method: 'GET', path: appPath }, { method: 'GET', path: submissionPath }]);
    for (const action of ['increase', 'halt', 'finalize']) {
      const mutation = fixture({ app, submission: { status } });
      await expect(mutation.run({ action, percentage: 20 })).rejects.toThrow('not the current last published');
      expect(mutation.calls).toEqual([{ method: 'GET', path: appPath }]);
    }
    const unrelated = fixture({ app: { ...app, pendingApplicationSubmission: { id: '888' } }, submission: { status } });
    await expect(unrelated.run()).rejects.toThrow('not the current last published');
    const wrong = fixture({ app, submission: { id: '888', status } });
    await expect(wrong.run()).rejects.toThrow('must be Published');
  }
});

test('status without a submission ID discovers production and reports whether it is open', async () => {
  for (const [status, open] of [
    ['PackageRolloutInProgress', true],
    ['PackageRolloutStopped', false],
    ['PackageRolloutComplete', false],
  ]) {
    const { calls, run } = fixture({ rollout: { packageRolloutStatus: status } });
    const result = await run({ action: 'status', submissionId: undefined });
    expect(result.submissionId).toBe(submissionId);
    expect(result.open).toBe(open);
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET', 'GET']);
  }

  const mutations = fixture();
  for (const action of ['increase', 'halt', 'finalize']) {
    await expect(mutations.run({ action, submissionId: undefined, percentage: 20 }))
      .rejects.toThrow('Invalid Microsoft Store submission ID.');
  }
  expect(mutations.calls).toHaveLength(0);
});

test('a pending submission is reported by status and still refuses every mutation', async () => {


  const pending = { pendingApplicationSubmission: { id: '1152921505701999999' } };
  for (const submission of [submissionId, undefined]) {
    const { calls, run } = fixture({ app: pending });
    const result = await run({ action: 'status', submissionId: submission });
    expect(result.submissionId).toBe(submissionId);
    expect(result.pendingSubmissionId).toBe('1152921505701999999');
    expect(result.open).toBe(true);
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET', 'GET']);
  }


  const settled = fixture({
    app: pending,
    rollout: { packageRolloutStatus: 'PackageRolloutComplete' },
  });
  expect((await settled.run({ action: 'status' })).open).toBe(false);

  for (const action of ['increase', 'halt', 'finalize']) {
    const blocked = fixture({ app: pending });
    await expect(blocked.run({ action, percentage: 20 })).rejects.toThrow('pending production submission');
    expect(blocked.calls.every(call => call.method === 'GET')).toBe(true);
  }
});

test('status reports an app with no published submission instead of failing', async () => {
  const unpublished = { lastPublishedApplicationSubmission: undefined };
  const { calls, run } = fixture({ app: unpublished });
  const result = await run({ action: 'status', submissionId: undefined });
  expect(result.open).toBe(false);
  expect(result.status).toBe('NoPublishedSubmission');
  expect(calls.map(call => call.method)).toEqual(['GET']);

  const mutation = fixture({ app: unpublished });
  await expect(mutation.run({ action: 'halt' })).rejects.toThrow('not the current last published');
});

test('increase is monotonic and uses the documented query endpoint without a body', async () => {
  const { calls, run } = fixture({
    postResponse: {
      isPackageRollout: true,
      packageRolloutPercentage: 20,
      packageRolloutStatus: 'PackageRolloutInProgress',
      fallbackSubmissionId: '1152921504621000000',
    },
  });
  const result = await run({ action: 'increase', percentage: 20 });
  expect(result.percentage).toBe(20);
  expect(calls.at(-1)).toEqual({
    method: 'POST',
    path: `${submissionPath}/updatepackagerolloutpercentage?percentage=20`,
  });

  for (const percentage of [4, 5]) {
    const blocked = fixture();
    await expect(blocked.run({ action: 'increase', percentage })).rejects.toThrow('greater than the current');
    expect(blocked.calls.some(call => call.method === 'POST')).toBe(false);
  }
});

test('halt and finalize use their dedicated endpoints exactly once', async () => {
  for (const [action, suffix] of [
    ['halt', 'haltpackagerollout'],
    ['finalize', 'finalizepackagerollout'],
  ]) {
    const { calls, run } = fixture();
    await run({ action });
    expect(calls.filter(call => call.method === 'POST')).toEqual([
      { method: 'POST', path: `${submissionPath}/${suffix}` },
    ]);
  }
});

test('automatic rollout discovers the latest published submission and advances one stage', async () => {
  for (const [percentage, expectedPath, expectedDecision] of [
    [5, `${submissionPath}/updatepackagerolloutpercentage?percentage=20`, 'increase'],
    [20, `${submissionPath}/updatepackagerolloutpercentage?percentage=50`, 'increase'],
    [50, `${submissionPath}/finalizepackagerollout`, 'finalize'],
  ]) {
    const { calls, request } = fixture({
      rollout: { packageRolloutPercentage: percentage },
      postResponse: {
        isPackageRollout: true,
        packageRolloutPercentage: expectedDecision === 'finalize' ? 100 : percentage === 5 ? 20 : 50,
        packageRolloutStatus: expectedDecision === 'finalize' ? 'PackageRolloutComplete' : 'PackageRolloutInProgress',
        fallbackSubmissionId: '1152921504621000000',
      },
    });
    const advanced = await autoAdvanceRollout({
      appId,
      request,
      log: () => {},
    });

    expect(advanced.submissionId).toBe(submissionId);
    expect(advanced.decision).toBe(expectedDecision);
    expect(advanced.committed).toBe(true);
    expect(calls.at(-1)).toEqual({ method: 'POST', path: expectedPath });
  }
});

test('automatic rollout treats pending, halted, complete, and unstaged states as no-ops', async () => {
  const cases = [
    {
      app: { pendingApplicationSubmission: { id: '777' } },
      expectedDecision: 'waiting',
      expectedCalls: 1,
    },
    {
      rollout: { packageRolloutPercentage: 20, packageRolloutStatus: 'PackageRolloutStopped' },
      expectedDecision: 'paused',
      expectedCalls: 3,
    },
    {
      rollout: { packageRolloutPercentage: 100, packageRolloutStatus: 'PackageRolloutComplete' },
      expectedDecision: 'complete',
      expectedCalls: 3,
    },
    {
      rollout: { isPackageRollout: false, packageRolloutPercentage: 0, packageRolloutStatus: 'PackageRolloutNotStarted' },
      expectedDecision: 'not-staged',
      expectedCalls: 3,
    },
  ];
  for (const { app = {}, rollout = {}, expectedDecision, expectedCalls } of cases) {
    const { calls, request } = fixture({ app, rollout });

    const result = await autoAdvanceRollout({ appId, request, log: () => {} });
    expect(result.decision).toBe(expectedDecision);
    expect(result.committed).toBe(false);
    expect(calls).toHaveLength(expectedCalls);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  }
});

test('automatic rollout fails closed on an unexpected percentage', async () => {
  const { calls, request } = fixture({ rollout: { packageRolloutPercentage: 10 } });
  await expect(autoAdvanceRollout({ appId, request, log: () => {} })).rejects.toThrow('automatic 5, 20, 50');
  expect(calls.every(call => call.method === 'GET')).toBe(true);
});

test('stale, pending, unpublished, disabled, and halted rollouts fail before mutation', async () => {
  const stale = fixture({ app: { lastPublishedApplicationSubmission: { id: '999' } } });
  await expect(stale.run({ action: 'halt' })).rejects.toThrow('not the current last published');
  expect(stale.calls.every(call => call.method === 'GET')).toBe(true);

  const pending = fixture({ app: { pendingApplicationSubmission: { id: '777' } } });
  await expect(pending.run({ action: 'finalize' })).rejects.toThrow('pending production submission');
  expect(pending.calls.every(call => call.method === 'GET')).toBe(true);

  const unpublished = fixture({ submission: { status: 'Certification' } });
  await expect(unpublished.run({ action: 'increase', percentage: 20 })).rejects.toThrow('must be Published');
  expect(unpublished.calls.every(call => call.method === 'GET')).toBe(true);

  const disabled = fixture({ rollout: { isPackageRollout: false, packageRolloutStatus: 'PackageRolloutNotStarted' } });
  await expect(disabled.run({ action: 'increase', percentage: 20 })).rejects.toThrow('not enabled');
  expect(disabled.calls.every(call => call.method === 'GET')).toBe(true);

  const halted = fixture({ rollout: { packageRolloutPercentage: 0, packageRolloutStatus: 'PackageRolloutStopped' } });
  await expect(halted.run({ action: 'increase', percentage: 20 })).rejects.toThrow('cannot be resumed through the API');
  expect(halted.calls.every(call => call.method === 'GET')).toBe(true);
});

test('Windows stable publication defaults to a five-percent rollout and exposes its identity', () => {
  const text = readFileSync('.github/workflows/release-windows.yml', 'utf8');
  const workflow = parse(text);
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    expect(workflow.on[trigger].inputs.rollout_mode).toMatchObject({ type: 'string', default: 'staged' });
    expect(workflow.on[trigger].inputs.rollout_percentage).toMatchObject({ type: 'number', default: 5 });
  }
  expect(workflow.on.workflow_call.outputs.msstore_submission_id.value).toBe('${{ jobs.standalone.outputs.msstore_submission_id }}');
  expect(workflow.on.workflow_call.outputs.msstore_rollout_policy.value).toBe('${{ jobs.standalone.outputs.msstore_rollout_policy }}');

  const job = workflow.jobs.standalone;
  expect(job.concurrency.group).toContain('msstore-production');
  expect(job.concurrency.group).not.toContain('msstore-beta-flight');
  expect(job.outputs.msstore_submission_id).toBe('${{ steps.msstore_publish.outputs.submission_id }}');
  expect(job.outputs.msstore_rollout_policy).toBe('${{ steps.msstore_publish.outputs.rollout_policy }}');

  const resolve = job.steps.find(step => step.id === 'version');
  expect(resolve.env.ROLLOUT_MODE).toBe('${{ inputs.rollout_mode }}');
  expect(resolve.env.ROLLOUT_PERCENTAGE).toBe('${{ inputs.rollout_percentage }}');
  expect(resolve.run).toContain("@('staged', 'immediate')");
  expect(resolve.run).toContain('[double]::IsNaN');
  expect(resolve.run).toContain('$rolloutPercentage -ge 100');

  const publish = job.steps.find(step => step.id === 'msstore_publish');
  expect(publish.env.ROLLOUT_MODE).toBe('${{ steps.version.outputs.rollout_mode }}');
  expect(publish.env.ROLLOUT_PERCENTAGE).toBe('${{ steps.version.outputs.rollout_percentage }}');
  expect(publish.run).toContain("isPackageRollout -Value $true");
  expect(publish.run).toContain("packageRolloutPercentage -Value $rolloutPercentage");
  expect(publish.run).toContain("isPackageRollout -Value $false");
  expect(publish.run).toContain("packageRolloutPercentage -Value 0.0");
  expect(publish.run).toContain('Microsoft Store production submission');
  expect(publish.run).toContain('submission_id=$submissionId');
  expect(publish.run).not.toContain('$submission.packageDeliveryOptions = @{');
  const commitStart = publish.run.indexOf('Write-Host "Committing submission..."');
  const pollStart = publish.run.indexOf('Write-Host "Polling submission status..."');
  expect(commitStart).toBeGreaterThan(-1);
  expect(pollStart).toBeGreaterThan(commitStart);
  const commitBlock = publish.run.slice(commitStart, pollStart);
  expect(commitBlock).toContain('-MaxAttempts 1');
  expect(commitBlock).toContain('outcome may be unknown');
  expect(commitBlock).toContain('Inspect submission status before retrying');

  const flight = job.steps.find(step => step.name === 'Submit Microsoft Store beta flight');
  expect(flight.if).toBe('inputs.run_msstore_flight');
  expect(flight.run).toContain('node scripts/ci/publish-msstore-flight.mjs');
});

pwshTest('Windows rollout payload mutates copied delivery options without replacing unrelated fields', () => {
  const workflow = parse(readFileSync('.github/workflows/release-windows.yml', 'utf8'));
  const publish = workflow.jobs.standalone.steps.find(step => step.id === 'msstore_publish');
  const start = publish.run.indexOf('function Set-RequiredSubmissionProperty');
  const end = publish.run.indexOf('function Apply-PublicSupportPropertiesIfPresent');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const applyRollout = publish.run.slice(start, end);

  const run = (submission, mode, percentage) => {
    const encodedFixture = Buffer.from(JSON.stringify(submission)).toString('base64');
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `$rolloutMode = '${mode}'`,
      `[double]$rolloutPercentage = ${percentage}`,
      `$submission = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedFixture}')) | ConvertFrom-Json`,
      applyRollout,
      '$submission.packageDeliveryOptions | ConvertTo-Json -Depth 20 -Compress',
    ].join('\n');
    const output = execFileSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(output.trim().split(/\r?\n/).at(-1));
  };

  for (const fixture of [{}, { packageDeliveryOptions: null }]) {
    const options = run(fixture, 'staged', 5);
    expect(options.packageRollout.isPackageRollout).toBe(true);
    expect(options.packageRollout.packageRolloutPercentage).toBe(5);
  }

  const copied = {
    packageDeliveryOptions: {
      isMandatoryUpdate: true,
      mandatoryUpdateEffectiveDate: '2030-01-02T03:04:05Z',
      packageRollout: {
        isPackageRollout: false,
        packageRolloutPercentage: 0,
        packageRolloutStatus: 'PackageRolloutNotStarted',
        fallbackSubmissionId: '42',
      },
    },
  };
  const staged = run(copied, 'staged', 5);
  expect(staged).toMatchObject({
    isMandatoryUpdate: true,
    mandatoryUpdateEffectiveDate: '2030-01-02T03:04:05Z',
    packageRollout: {
      isPackageRollout: true,
      packageRolloutPercentage: 5,
      packageRolloutStatus: 'PackageRolloutNotStarted',
      fallbackSubmissionId: '42',
    },
  });

  copied.packageDeliveryOptions.packageRollout = {
    isPackageRollout: true,
    packageRolloutPercentage: 25,
    packageRolloutStatus: 'PackageRolloutInProgress',
    fallbackSubmissionId: '41',
  };
  const immediate = run(copied, 'immediate', 5);
  expect(immediate).toMatchObject({
    isMandatoryUpdate: true,
    mandatoryUpdateEffectiveDate: '2030-01-02T03:04:05Z',
    packageRollout: {
      isPackageRollout: false,
      packageRolloutPercentage: 0,
      packageRolloutStatus: 'PackageRolloutInProgress',
      fallbackSubmissionId: '41',
    },
  });
}, 30_000);

pwshTest('Windows routing rejects invalid rollout policy before resolving a Store package', () => {
  const workflow = parse(readFileSync('.github/workflows/release-windows.yml', 'utf8'));
  const resolve = workflow.jobs.standalone.steps.find(step => step.id === 'version').run;
  const routingStart = resolve.indexOf("$tag = (($lines | Where-Object { $_ -like 'tag=*' })");
  expect(routingStart).toBeGreaterThan(-1);
  const routing = resolve.slice(routingStart);

  const modeRefusal = 'rollout_mode must be staged or immediate before Microsoft Store publication.';
  const percentageRefusal = 'rollout_percentage must be finite and greater than 0 and less than 100 before Microsoft Store publication.';
  const cases = [
    { mode: 'staged', percentage: '5', ok: true, message: '' },
    { mode: 'immediate', percentage: '5', ok: true, message: '' },
    { mode: 'resume', percentage: '5', ok: false, message: modeRefusal },
    ...['NaN', 'Infinity', '-1', '0', '100'].map(percentage => (
      { mode: 'staged', percentage, ok: false, message: percentageRefusal }
    )),
  ];


  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$lines = @('tag=v1.3.0', 'version=1.3.0')",
    `$routing = {\n${routing}\n}`,
    `$cases = '${JSON.stringify(cases.map(({ mode, percentage }) => ({ mode, percentage })))}' | ConvertFrom-Json`,
    '$results = foreach ($case in $cases) {',
    '  $env:ROLLOUT_MODE = $case.mode',
    '  $env:ROLLOUT_PERCENTAGE = $case.percentage',
    '  try { & $routing | Out-Null; [pscustomobject]@{ mode = $case.mode; percentage = $case.percentage; ok = $true; message = "" } }',
    '  catch { [pscustomobject]@{ mode = $case.mode; percentage = $case.percentage; ok = $false; message = $_.Exception.Message } }',
    '}',
    'ConvertTo-Json -InputObject @($results) -Compress',
  ].join('\n');
  const output = execFileSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    {
      env: {
        ...process.env,
        GITHUB_OUTPUT: '/dev/null',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main',
        RUN_MSSTORE: 'true',
        RUN_MSSTORE_FLIGHT: 'false',
        MSSTORE_FLIGHT_ID: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  expect(JSON.parse(output.trim().split(/\r?\n/).at(-1))).toEqual(cases);
}, 30_000);
