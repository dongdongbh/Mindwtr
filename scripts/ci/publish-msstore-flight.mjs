import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { msstoreVersion } from './msstore-version.mjs';

const API = 'https://manage.devcenter.microsoft.com/v1.0/my';
const ACCEPTED = new Set(['PreProcessing', 'Certification', 'PendingPublication', 'Publishing', 'Release', 'Published']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function compareVersions(left, right) {
  const parse = value => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) throw new Error('Invalid Store package version.');
    return value.split('.').map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  // Ignore the Store-owned revision when comparing uploaded package identities.
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

export function assertStatus(submission) {
  const status = submission.status;
  if (submission.statusDetails?.errors?.length || /Failed$/.test(status) || status === 'Canceled') {
    throw new Error(`Flight submission ${submission.id || ''} failed (${status}); inspect Partner Center diagnostics.`);
  }
  return status;
}

// All submission writes are constructed beneath this flight's URL. There is no
// production-submission fallback and no automatic deletion of existing drafts.
export async function publishFlight({ appId, flightId, tag, fileName, archive, request, sleep = pause, log = console.log }) {
  if (!/^[A-Z0-9]+$/.test(appId)) throw new Error('Invalid Store app ID.');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(flightId)) {
    throw new Error('MSSTORE_FLIGHT_ID must be the flight UUID, not a submission ID.');
  }
  const version = msstoreVersion(tag);
  if (!/^[a-zA-Z0-9_.-]+\.msix$/.test(fileName)) throw new Error('Expected a flat MSIX filename.');
  if (!archive?.length) throw new Error('The flight upload archive is empty.');
  const marker = `Mindwtr flight ${tag}; MSIX ${version}; SHA256 ${createHash('sha256').update(archive).digest('hex')}`;
  const root = `${API}/applications/${appId}/flights/${flightId}`;
  const flight = await request('GET', root);
  if (flight.flightId !== flightId || flight.friendlyName !== 'Mindwtr Beta') {
    throw new Error('Configured flight is not Mindwtr Beta. Check MSSTORE_FLIGHT_ID.');
  }

  let submission;
  let ownedDraft = false;
  if (flight.pendingFlightSubmission?.id) {
    const pendingId = encodeURIComponent(flight.pendingFlightSubmission.id);
    submission = await request('GET', `${root}/submissions/${pendingId}`);
    if (submission.notesForCertification !== marker) {
      throw new Error('An unrelated or rebuilt flight draft is pending. Publish or discard that flight submission in Partner Center before retrying; no draft was changed.');
    }
    ownedDraft = true;
  } else if (flight.lastPublishedFlightSubmission?.id) {
    const published = await request('GET', `${root}/submissions/${encodeURIComponent(flight.lastPublishedFlightSubmission.id)}`);
    if (published.notesForCertification === marker && assertStatus(published) === 'Published') {
      log(`Flight submission ${published.id} already published (${version}).`);
      return { submissionId: published.id, version, status: 'Published' };
    }
    for (const pkg of published.flightPackages || []) {
      if (pkg.fileStatus !== 'PendingDelete' && compareVersions(version, pkg.version) <= 0) {
        throw new Error(`Flight already contains MSIX ${pkg.version}; new package ${version} must be higher.`);
      }
    }
  }

  if (!submission) {
    // POST is intentionally not retried: a lost response may still create a draft.
    submission = await request('POST', `${root}/submissions`);
  }
  if (!submission.id || submission.flightId !== flightId) throw new Error('Microsoft returned an invalid flight submission.');
  const submissionId = submission.id;
  const url = `${root}/submissions/${encodeURIComponent(submissionId)}`;
  let status = assertStatus(submission);
  if (status === 'PendingCommit') {
    const uploadUrl = new URL(submission.fileUploadUrl);
    if (uploadUrl.protocol !== 'https:' || !uploadUrl.hostname.endsWith('.blob.core.windows.net')) {
      throw new Error('Microsoft returned an unexpected upload destination.');
    }
    if (!ownedDraft) {
      const flightPackages = (submission.flightPackages || []).map(pkg => ({ ...pkg, fileStatus: 'PendingDelete' }));
      flightPackages.push({ fileName, fileStatus: 'PendingUpload', minimumDirectXVersion: 'None', minimumSystemRam: 'None' });
      await request('PUT', url, {
        flightPackages,
        targetPublishMode: 'Immediate',
        notesForCertification: marker,
        packageDeliveryOptions: { packageRollout: { isPackageRollout: false } },
      });
    } else {
      const activePackages = (submission.flightPackages || []).filter(pkg => pkg.fileStatus !== 'PendingDelete');
      if (activePackages.length !== 1 || activePackages[0].fileName !== fileName) {
        throw new Error('Owned flight draft package references changed; inspect the draft before retrying.');
      }
    }
    await request('UPLOAD', uploadUrl.href, archive);
    await request('POST', `${url}/commit`);
    status = 'CommitStarted';
  }

  for (let poll = 0; poll < 60; poll++) {
    if (ACCEPTED.has(status)) {
      log(`Flight submission ${submissionId}: MSIX ${version}, status ${status}. Certification and tester availability may still be pending.`);
      return { submissionId, version, status };
    }
    if (status !== 'CommitStarted') throw new Error(`Unexpected flight status: ${status}.`);
    await sleep(30_000);
    status = assertStatus(await request('GET', `${url}/status`));
  }
  throw new Error(`Timed out waiting for flight submission ${submissionId} to finish committing.`);
}

export async function main(env = process.env) {
  for (const name of ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_STORE_APP_ID', 'MSSTORE_FLIGHT_ID', 'RELEASE_TAG', 'MSIX_FILE_NAME', 'MSIX_ZIP_PATH']) {
    if (!env[name]) throw new Error(`Missing required configuration: ${name}.`);
  }
  const tokenResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.MS_TENANT_ID)}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', resource: 'https://manage.devcenter.microsoft.com', client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!tokenResponse.ok) throw new Error(`Store authentication failed (HTTP ${tokenResponse.status}).`);
  const { access_token: token } = await tokenResponse.json();
  if (!token) throw new Error('Store authentication returned no access token.');
  console.log(`::add-mask::${token}`);
  const request = async (method, url, data) => {
    const upload = method === 'UPLOAD';
    if (upload) console.log(`::add-mask::${url}`);
    const response = await fetch(url, {
      method: upload ? 'PUT' : method,
      headers: upload
        ? { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/octet-stream' }
        : { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      body: data ? (upload ? data : JSON.stringify(data)) : undefined,
      signal: AbortSignal.timeout(upload ? 300_000 : 60_000),
    });
    if (!response.ok) throw new Error(`Store ${upload ? 'upload' : method} failed (HTTP ${response.status}); inspect the flight in Partner Center.`);
    const text = await response.text();
    return text && !upload ? JSON.parse(text) : {};
  };
  const result = await publishFlight({
    appId: env.MS_STORE_APP_ID, flightId: env.MSSTORE_FLIGHT_ID, tag: env.RELEASE_TAG,
    fileName: env.MSIX_FILE_NAME, archive: readFileSync(env.MSIX_ZIP_PATH), request,
  });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
    `\nMicrosoft Store beta flight: \`${env.MSSTORE_FLIGHT_ID}\`\n\nSubmission: \`${result.submissionId}\`; MSIX: \`${result.version}\`; status: **${result.status}**.\n\nStore certification and installation by testers are separate checks.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Do not print request objects, response bodies, tokens, or SAS query strings.
    console.error(error instanceof TypeError || error instanceof SyntaxError ? 'Store request failed; check connectivity and configuration.' : error.message);
    process.exitCode = 1;
  });
}
