import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { msstoreVersion } from './msstore-version.mjs';
import { compareVersions, publishFlight } from './publish-msstore-flight.mjs';

const flightId = '640b80df-45ed-4604-acaf-e8c28c983184';
const root = `https://manage.devcenter.microsoft.com/v1.0/my/applications/9N0V5B0B6FRX/flights/${flightId}`;
const archive = Buffer.from('fixture archive');
const tag = 'v1.3.0-rc.2';
const marker = `Mindwtr flight ${tag}; MSIX 1.3.2.0; SHA256 ${createHash('sha256').update(archive).digest('hex')}`;

function fixture({ flight = {}, submission = {}, statuses = ['PreProcessing'], published } = {}) {
  const calls = [];
  let polls = 0;
  const created = { id: '123', flightId, status: 'PendingCommit', fileUploadUrl: 'https://example.blob.core.windows.net/upload?sig=secret', flightPackages: [], ...submission };
  const request = async (method, url, data) => {
    calls.push({ method, url, data });
    if (method === 'GET' && url === root) return { flightId, friendlyName: 'Mindwtr Beta', ...flight };
    if (method === 'GET' && url.endsWith('/submissions/old')) return published;
    if (method === 'GET' && url.endsWith('/submissions/123')) return created;
    if (method === 'POST' && url === `${root}/submissions`) return created;
    if (method === 'GET' && url.endsWith('/status')) return { status: statuses[Math.min(polls++, statuses.length - 1)] };
    if (method === 'UPLOAD' || method === 'PUT' || url.endsWith('/commit')) return {};
    throw new Error(`Unexpected fixture request ${method} ${url}`);
  };
  const run = overrides => publishFlight({ appId: '9N0V5B0B6FRX', flightId, tag, fileName: 'mindwtr_1.3.0-rc.2_x64.msix', archive, request, sleep: async () => {}, log: () => {}, ...overrides });
  return { calls, run };
}

test('Store versions order previous stable, RCs, stable, and next patch while reserving revision zero', () => {
  const versions = ['1.2.8.0', ...['v1.3.0-rc.1', tag, 'v1.3.0-rc.98', 'v1.3.0', 'v1.3.1-rc.1', 'v1.3.1', 'v1.4.0-rc.1'].map(msstoreVersion)];
  for (let i = 1; i < versions.length; i++) expect(compareVersions(versions[i], versions[i - 1])).toBe(1);
  expect(msstoreVersion(tag)).toBe('1.3.2.0');
  expect(msstoreVersion('v1.3.0')).toBe('1.3.99.0');
  expect(compareVersions('1.3.2.0', '1.3.2.7')).toBe(0);
  for (const invalid of ['v1.3.0-rc.0', 'v1.3.0-rc.99', 'v0.3.0', 'v1.3.655', 'v1.65536.0', 'v1.3.0-beta.1']) {
    expect(() => msstoreVersion(invalid)).toThrow();
  }
});

test('new flight sends only flightPackages, uploads before commit, and waits for ingestion', async () => {
  const { run, calls } = fixture({ submission: { flightPackages: [{ fileName: 'old.msix', version: '1.3.1.0' }] }, statuses: ['CommitStarted', 'Certification'] });
  expect(await run()).toEqual({ submissionId: '123', version: '1.3.2.0', status: 'Certification' });
  const update = calls.find(call => call.method === 'PUT');
  expect(update.data.applicationPackages).toBeUndefined();
  expect(update.data.targetPublishMode).toBe('Immediate');
  expect(update.data.flightPackages.map(pkg => pkg.fileStatus)).toEqual(['PendingDelete', 'PendingUpload']);
  expect(update.data.notesForCertification).toBe(marker);
  const uploadIndex = calls.findIndex(call => call.method === 'UPLOAD');
  expect(uploadIndex).toBeGreaterThan(calls.indexOf(update));
  expect(calls.findIndex(call => call.url.endsWith('/commit'))).toBeGreaterThan(uploadIndex);
  for (const call of calls.filter(call => call.method !== 'UPLOAD')) expect(call.url.startsWith(root)).toBe(true);
  expect(calls.some(call => call.method === 'DELETE')).toBe(false);
});

test('unrelated dashboard drafts and rebuilt archives are never overwritten', async () => {
  for (const notesForCertification of ['', 'someone else', marker.replace('SHA256 ', 'SHA256 other')]) {
    const { run, calls } = fixture({ flight: { pendingFlightSubmission: { id: '123' } }, submission: { notesForCertification } });
    await expect(run()).rejects.toThrow('no draft was changed');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  }
});

test('exact pending archive resumes, while committed submissions are only polled', async () => {
  const pending = { pendingFlightSubmission: { id: '123' } };
  const draft = fixture({ flight: pending, submission: { notesForCertification: marker, flightPackages: [{ fileName: 'mindwtr_1.3.0-rc.2_x64.msix', fileStatus: 'PendingUpload' }] } });
  await draft.run();
  expect(draft.calls.some(call => call.url === `${root}/submissions`)).toBe(false);
  expect(draft.calls.some(call => call.method === 'PUT')).toBe(false);
  const committing = fixture({ flight: pending, submission: { notesForCertification: marker, status: 'CommitStarted' } });
  await committing.run();
  expect(committing.calls.every(call => call.method === 'GET')).toBe(true);
});

test('a published exact archive is idempotent and equal or older versions fail before mutation', async () => {
  const flight = { lastPublishedFlightSubmission: { id: 'old' } };
  const exact = fixture({ flight, published: { id: 'old', status: 'Published', notesForCertification: marker } });
  expect((await exact.run()).status).toBe('Published');
  expect(exact.calls.every(call => call.method === 'GET')).toBe(true);
  for (const version of ['1.3.2.7', '1.3.99.0']) {
    const older = fixture({ flight, published: { flightPackages: [{ version }] } });
    await expect(older.run()).rejects.toThrow('must be higher');
    expect(older.calls.every(call => call.method === 'GET')).toBe(true);
  }
});

test('wrong flight, missing configuration, failed status, and timeouts fail closed', async () => {
  await expect(fixture({ flight: { friendlyName: 'Other' } }).run()).rejects.toThrow('not Mindwtr Beta');
  await expect(fixture().run({ flightId: '' })).rejects.toThrow('UUID');
  await expect(fixture().run({ flightId: '1152921505701865456' })).rejects.toThrow('UUID');
  for (const status of ['CommitFailed', 'PreProcessingFailed', 'CertificationFailed', 'PublishFailed', 'ReleaseFailed', 'Canceled']) {
    await expect(fixture({ statuses: [status] }).run()).rejects.toThrow('failed');
  }
  await expect(fixture({ statuses: ['CommitStarted'] }).run()).rejects.toThrow('Timed out');
  await expect(fixture({ submission: { fileUploadUrl: 'https://unexpected.example/upload' } }).run()).rejects.toThrow('upload destination');
});

test('upload failure does not commit and ambiguous create is not retried', async () => {
  const calls = [];
  const request = async (method, url) => {
    calls.push({ method, url });
    if (method === 'GET') return { flightId, friendlyName: 'Mindwtr Beta' };
    throw new Error('Network failure');
  };
  await expect(fixture().run({ request })).rejects.toThrow('Network failure');
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  const broken = fixture();
  await expect(broken.run({ request: async (method, url) => {
    calls.push({ method, url });
    if (method === 'GET') return { flightId, friendlyName: 'Mindwtr Beta' };
    if (url === `${root}/submissions`) return { id: '123', flightId, status: 'PendingCommit', fileUploadUrl: 'https://example.blob.core.windows.net/upload' };
    if (method === 'UPLOAD') throw new Error('Upload failure');
    return {};
  } })).rejects.toThrow('Upload failure');
  expect(calls.some(call => call.url.endsWith('/commit'))).toBe(false);
});

test('RC defaults enable only the flight; stable refreshes the configured tester flight', () => {
  const rc = parse(readFileSync('.github/workflows/release-rc.yml', 'utf8'));
  const stable = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
  const windows = parse(readFileSync('.github/workflows/release-windows.yml', 'utf8'));
  expect(rc.on.workflow_dispatch.inputs.run_msstore_flight.default).toBe(true);
  expect(rc.jobs.windows.with.run_msstore).toBe(false);
  const expression = rc.jobs.windows.with.run_msstore_flight.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const enabled = new Function('github', 'inputs', `return Boolean(${expression})`);
  expect(enabled({ event_name: 'push' }, {})).toBe(true);
  expect(enabled({ event_name: 'workflow_dispatch' }, { run_msstore_flight: true })).toBe(true);
  expect(enabled({ event_name: 'workflow_dispatch' }, { run_msstore_flight: false })).toBe(false);
  expect(stable.jobs.windows.with.run_msstore_flight).toBe("${{ vars.MSSTORE_FLIGHT_ID != '' }}");
  for (const trigger of ['workflow_call', 'workflow_dispatch']) expect(windows.on[trigger].inputs.run_msstore_flight.default).toBe(false);
  const steps = windows.jobs.standalone.steps;
  for (const name of ['Ensure MakeAppx is available', 'Create MSIX layout', 'Generate AppxManifest.xml', 'Build MSIX package']) {
    expect(steps.find(step => step.name === name).if).toBe("steps.version.outputs.store_package == 'true'");
  }
  expect(steps.find(step => step.name === 'Check Microsoft Store submission status').if).toBe("steps.version.outputs.store_stable == 'true'");
  expect(steps.find(step => step.name === 'Publish to Microsoft Store (metadata + package)').if).toContain("steps.version.outputs.store_stable == 'true'");
  expect(steps.find(step => step.name === 'Submit Microsoft Store beta flight').if).toBe('inputs.run_msstore_flight');
});

test('Windows PowerShell routes resolved RC tags away from public Store publication', () => {
  const windows = parse(readFileSync('.github/workflows/release-windows.yml', 'utf8'));
  const script = windows.jobs.standalone.steps.find(step => step.id === 'version').run;
  const tail = script.slice(script.indexOf('$msixVersion = node'));
  const run = ({ tag = 'v1.3.0-rc.2', ref = 'refs/tags/v1.3.0-rc.2', stable = false, flight = true, id = flightId } = {}) => {
    const directory = mkdtempSync(join(tmpdir(), 'msstore-routing-'));
    try {
      const output = join(directory, 'output');
      const command = `$ErrorActionPreference = 'Stop'\n$tag = '${tag}'\n${tail}`;
      execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
        env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_REF: ref, RUN_MSSTORE: String(stable), RUN_MSSTORE_FLIGHT: String(flight), MSSTORE_FLIGHT_ID: id },
        stdio: 'pipe',
      });
      return readFileSync(output, 'utf8');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  expect(run()).toContain('store_stable=false');
  expect(run()).toContain('store_package=true');
  expect(run({ flight: false })).toContain('store_package=false');
  expect(run({ ref: 'refs/heads/main' })).toContain('store_stable=false');
  expect(() => run({ stable: true })).toThrow();
  expect(() => run({ id: '' })).toThrow();
  expect(run({ tag: 'v1.3.0', ref: 'refs/tags/v1.3.0' })).toContain('store_stable=true');
  expect(run({ tag: 'v1.3.0', ref: 'refs/heads/main', stable: true })).toContain('store_stable=true');
}, 30_000);
