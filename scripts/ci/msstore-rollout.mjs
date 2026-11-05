import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://manage.devcenter.microsoft.com/v1.0/my';
const API_BASE = new URL(`${API}/`);
const ACTIONS = new Set(['status', 'increase', 'halt', 'finalize', 'auto']);
const IN_PROGRESS = 'PackageRolloutInProgress';
const STOPPED = 'PackageRolloutStopped';
const COMPLETE = 'PackageRolloutComplete';
const AUTO_ROLLOUT_PERCENTAGES = [5, 20, 50];

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePercentage(value) {
  const percentage = Number(value);
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage >= 100) {
    throw new Error('Rollout percentage must be finite and greater than 0 and less than 100.');
  }
  return percentage;
}

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--submission-id', '--action', '--percentage', '--result'].includes(flag)) {
      throw new Error(`Unknown argument: ${flag || '<empty>'}.`);
    }
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}.`);
    values.set(flag, requiredValue(argv, index, flag));
  }

  const submissionId = values.get('--submission-id');
  const action = values.get('--action');
  if (!action) throw new Error('--action is required.');
  if (!ACTIONS.has(action)) throw new Error('--action must be one of status, increase, halt, finalize, or auto.');
  if (action === 'auto') {
    if (submissionId) throw new Error('--submission-id is not supported when --action is auto.');
  } else if (submissionId) {
    if (!/^\d+$/.test(submissionId)) throw new Error('--submission-id must be a numeric Store submission ID.');


  } else if (action !== 'status') {
    throw new Error('--submission-id is required.');
  }

  const rawPercentage = values.get('--percentage');
  if (action === 'increase' && rawPercentage === undefined) {
    throw new Error('--percentage is required when --action is increase.');
  }
  if (action !== 'increase' && rawPercentage !== undefined) {
    throw new Error('--percentage is supported only when --action is increase.');
  }

  return {
    submissionId,
    action,
    percentage: rawPercentage === undefined ? undefined : parsePercentage(rawPercentage),
    resultPath: values.get('--result'),
  };
}

function storeUrl(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) {
    throw new Error('Store requests must stay on the fixed Microsoft Store origin.');
  }
  const url = new URL(path, API_BASE);
  if (url.origin !== API_BASE.origin || !url.pathname.startsWith(API_BASE.pathname)) {
    throw new Error('Store requests must stay on the fixed Microsoft Store origin.');
  }
  return url;
}

export function createStoreRequest({ token, tenantId, fetchImpl = fetch }) {
  if (!token || !tenantId) throw new Error('Store request authentication is incomplete.');
  return async (method, path) => {
    if (!['GET', 'POST'].includes(method)) {
      throw new Error('Rollout transport supports only GET and POST requests.');
    }
    const url = storeUrl(path);
    const response = await fetchImpl(url.href, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        TenantId: tenantId,
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const uncertainty = method === 'POST'
        ? ' The write outcome may be uncertain; inspect Partner Center before retrying.'
        : '';
      throw new Error(`Microsoft Store rollout ${method} failed (HTTP ${response.status}).${uncertainty}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  };
}

function validateIdentity({ app, appId, submissionId, allowPending = false }) {
  if (!app || String(app.id) !== appId) {
    throw new Error('Microsoft Store returned the wrong application identity.');
  }
  const publishedId = app.lastPublishedApplicationSubmission?.id;
  const pendingId = String(app.pendingApplicationSubmission?.id ?? '');
  if (String(publishedId ?? '') !== submissionId && !(allowPending && pendingId === submissionId)) {
    throw new Error(`Submission ${submissionId} is not the current last published application submission.`);
  }


  if (!allowPending && app.pendingApplicationSubmission?.id) {
    throw new Error(`Application has pending production submission ${app.pendingApplicationSubmission.id}; resolve it before managing rollout ${submissionId}.`);
  }
}

function rolloutResult(submissionId, action, rollout) {
  const percentage = Number(rollout?.packageRolloutPercentage);
  if (!rollout || typeof rollout.isPackageRollout !== 'boolean' || !Number.isFinite(percentage) || typeof rollout.packageRolloutStatus !== 'string') {
    throw new Error('Microsoft Store returned invalid package rollout data.');
  }
  return {
    submissionId,
    action,
    isPackageRollout: rollout.isPackageRollout,
    percentage,
    status: rollout.packageRolloutStatus,


    open: rollout.packageRolloutStatus === IN_PROGRESS,
    fallbackSubmissionId: String(rollout.fallbackSubmissionId ?? ''),
  };
}

export async function manageRollout({
  appId,
  submissionId,
  action,
  percentage,
  request,
  log = console.log,
}) {
  if (!/^[A-Z0-9]+$/.test(appId)) throw new Error('Invalid Microsoft Store application ID.');
  if (!ACTIONS.has(action)) throw new Error('Unsupported Microsoft Store rollout action.');
  if (submissionId === undefined && action !== 'status') {
    throw new Error('Invalid Microsoft Store submission ID.');
  }
  if (submissionId !== undefined && !/^\d+$/.test(submissionId)) {
    throw new Error('Invalid Microsoft Store submission ID.');
  }
  if (action === 'increase') parsePercentage(percentage);

  const appPath = `applications/${appId}`;
  const app = await request('GET', appPath);
  const pendingSubmissionId = String(app?.pendingApplicationSubmission?.id ?? '');
  if (submissionId === undefined) {
    submissionId = String(app?.lastPublishedApplicationSubmission?.id ?? '');
    if (!/^\d+$/.test(submissionId)) {


      const empty = {
        submissionId: '',
        action,
        isPackageRollout: false,
        percentage: 0,
        status: 'NoPublishedSubmission',
        open: false,
        fallbackSubmissionId: '',
        pendingSubmissionId,
      };
      log(`Microsoft Store has no published submission to roll out.${pendingSubmissionId ? ` Pending submission ${pendingSubmissionId}.` : ''}`);
      return empty;
    }
  }
  const submissionPath = `${appPath}/submissions/${submissionId}`;
  validateIdentity({ app, appId, submissionId, allowPending: action === 'status' });

  const submission = await request('GET', submissionPath);
  if (String(submission?.id ?? '') === submissionId && action === 'status'
      && typeof submission.status === 'string' && submission.status && submission.status !== 'Published') {
    log(`Microsoft Store submission ${submissionId}: ${submission.status}; not distributing yet.`);
    return { submissionId, action, status: submission.status, percentage: null, open: false, pendingSubmissionId };
  }
  if (String(submission?.id ?? '') !== submissionId || submission.status !== 'Published') {
    throw new Error(`Submission ${submissionId} must be Published before its package rollout can be managed.`);
  }

  const rolloutPath = `${submissionPath}/packagerollout`;
  const rollout = await request('GET', rolloutPath);
  const current = rolloutResult(submissionId, action, rollout);
  if (action === 'status') {
    log(`Microsoft Store submission ${submissionId}: ${current.status}, ${current.percentage}% rollout.${pendingSubmissionId ? ` Pending submission ${pendingSubmissionId}.` : ''}`);
    return { ...current, pendingSubmissionId };
  }

  if (current.status === STOPPED) {
    throw new Error('This package rollout was halted and cannot be resumed through the API. Publish a new submission to deliver another update.');
  }
  if (!current.isPackageRollout) {
    throw new Error(`Package rollout is not enabled for submission ${submissionId}.`);
  }
  if (current.status !== IN_PROGRESS) {
    throw new Error(`Package rollout action ${action} requires ${IN_PROGRESS}; current state is ${current.status}.`);
  }

  let actionPath;
  if (action === 'increase') {
    const target = parsePercentage(percentage);
    if (target <= current.percentage) {
      throw new Error(`New rollout percentage ${target} must be greater than the current ${current.percentage}.`);
    }
    actionPath = `${submissionPath}/updatepackagerolloutpercentage?percentage=${encodeURIComponent(target)}`;
  } else if (action === 'halt') {
    actionPath = `${submissionPath}/haltpackagerollout`;
  } else {
    actionPath = `${submissionPath}/finalizepackagerollout`;
  }


  const updated = rolloutResult(submissionId, action, await request('POST', actionPath));
  log(`Microsoft Store submission ${submissionId}: ${updated.status}, ${updated.percentage}% rollout after ${action}.`);
  return updated;
}

function automaticDecision(percentage) {
  const matches = value => Math.abs(percentage - value) < 1e-6;
  if (matches(AUTO_ROLLOUT_PERCENTAGES[0])) return { action: 'increase', percentage: AUTO_ROLLOUT_PERCENTAGES[1] };
  if (matches(AUTO_ROLLOUT_PERCENTAGES[1])) return { action: 'increase', percentage: AUTO_ROLLOUT_PERCENTAGES[2] };
  if (matches(AUTO_ROLLOUT_PERCENTAGES[2])) return { action: 'finalize' };
  throw new Error('Microsoft Store rollout percentage is outside the automatic 5, 20, 50 schedule.');
}

export async function autoAdvanceRollout({ appId, request, log = console.log }) {
  if (!/^[A-Z0-9]+$/.test(appId)) throw new Error('Invalid Microsoft Store application ID.');
  const appPath = `applications/${appId}`;
  const app = await request('GET', appPath);
  if (!app || String(app.id) !== appId) {
    throw new Error('Microsoft Store returned the wrong application identity.');
  }

  const submissionId = String(app.lastPublishedApplicationSubmission?.id ?? '');
  if (!/^\d+$/.test(submissionId)) {
    throw new Error('Microsoft Store returned no numeric last-published submission ID.');
  }
  if (app.pendingApplicationSubmission?.id) {
    const result = {
      submissionId,
      action: 'auto',
      decision: 'waiting',
      isPackageRollout: false,
      percentage: 0,
      status: 'PendingApplicationSubmission',
      fallbackSubmissionId: '',
      committed: false,
    };
    log(`Microsoft Store has pending submission ${app.pendingApplicationSubmission.id}; automatic rollout is waiting.`);
    return result;
  }

  const submissionPath = `${appPath}/submissions/${submissionId}`;
  const submission = await request('GET', submissionPath);
  if (String(submission?.id ?? '') !== submissionId || submission.status !== 'Published') {
    throw new Error(`Submission ${submissionId} must be Published before its package rollout can be managed.`);
  }

  const rolloutPath = `${submissionPath}/packagerollout`;
  const current = rolloutResult(submissionId, 'auto', await request('GET', rolloutPath));
  if (current.status === STOPPED) {
    const result = { ...current, decision: 'paused', committed: false };
    log(`Microsoft Store submission ${submissionId} is halted; automatic rollout will not resume it.`);
    return result;
  }
  if (!current.isPackageRollout) {
    const result = { ...current, decision: 'not-staged', committed: false };
    log(`Microsoft Store submission ${submissionId} is not staged; no automatic rollout action is needed.`);
    return result;
  }
  if (current.status === COMPLETE) {
    const result = { ...current, decision: 'complete', committed: false };
    log(`Microsoft Store submission ${submissionId} rollout is complete.`);
    return result;
  }
  if (current.status !== IN_PROGRESS) {
    throw new Error(`Automatic rollout requires ${IN_PROGRESS}; current state is ${current.status}.`);
  }

  const decision = automaticDecision(current.percentage);
  const actionPath = decision.action === 'increase'
    ? `${submissionPath}/updatepackagerolloutpercentage?percentage=${encodeURIComponent(decision.percentage)}`
    : `${submissionPath}/finalizepackagerollout`;
  const updated = rolloutResult(submissionId, 'auto', await request('POST', actionPath));
  const result = { ...updated, decision: decision.action, committed: true };
  log(`Microsoft Store submission ${submissionId}: ${updated.status}, ${updated.percentage}% rollout after automatic ${decision.action}.`);
  return result;
}

async function accessToken({ env, fetchImpl }) {
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(env.MS_TENANT_ID)}/oauth2/token`,
    {
      method: 'POST',
      redirect: 'error',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        resource: 'https://manage.devcenter.microsoft.com',
        client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`Microsoft Store authentication failed (HTTP ${response.status}).`);
  const token = (await response.json()).access_token;
  if (!token) throw new Error('Microsoft Store authentication returned no access token.');
  return token;
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const args = parseArgs(argv);
  for (const name of ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_STORE_APP_ID']) {
    if (!env[name]) throw new Error(`Missing required configuration: ${name}.`);
  }
  const token = await accessToken({ env, fetchImpl });
  log(`::add-mask::${token}`);
  const request = createStoreRequest({
    token,
    tenantId: env.MS_TENANT_ID,
    fetchImpl,
  });
  const result = args.action === 'auto'
    ? await autoAdvanceRollout({ appId: env.MS_STORE_APP_ID, request, log })
    : await manageRollout({
      appId: env.MS_STORE_APP_ID,
      ...args,
      request,
      log,
    });
  if (args.resultPath) {
    writeFileSync(args.resultPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `\n## Microsoft Store package rollout\n\n- Submission: \`${result.submissionId}\`\n- Action: **${result.action}**\n- Decision: **${result.decision ?? result.action}**\n- State: **${result.status}**\n- Percentage: **${result.percentage == null ? 'not distributing' : `${result.percentage}%`}**\n`,
    );
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(error => {

    console.error(error instanceof TypeError || error instanceof SyntaxError
      ? 'Microsoft Store rollout request failed; check connectivity and configuration.'
      : error.message);
    process.exitCode = 1;
  });
}
