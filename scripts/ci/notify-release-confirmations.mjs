import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const LABEL = 'status:needs-confirmation';
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const DEFAULT_BOT = 'github-actions[bot]';

export function extractIssueNumbers(body, repository) {
  let fence = null;
  const lines = [];
  for (const line of String(body ?? '').split('\n')) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
    } else if (delimiter) fence = delimiter[1];
    else if (!/^( {4}|\t)/.test(line)) lines.push(line);
  }
  const text = lines.join('\n').replace(/`+[^`\n]*`+/g, '');
  const directives = [...text.matchAll(/<!--\s*mindwtr-confirmation-issues\s*:\s*([\s\S]*?)-->/gi)];
  const directiveStarts = [...text.matchAll(/<!--\s*mindwtr-confirmation-issues\b/gi)];
  if (directiveStarts.length !== directives.length) throw new Error('Malformed confirmation-issues directive.');
  const numbers = new Set();
  const add = (raw) => {
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid issue number: ${raw}`);
    numbers.add(number);
  };
  if (directives.length) {
    if (directives.length !== 1) throw new Error('Use only one confirmation-issues directive per release.');
    for (const token of directives[0][1].trim().split(/[\s,]+/).filter(Boolean)) {
      if (!/^#?[1-9]\d*$/.test(token)) throw new Error(`Invalid confirmation-issues token: ${token}`);
      add(token.replace(/^#/, ''));
    }
    return [...numbers].sort((a, b) => a - b);
  }
  let remaining = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const referenceLabels = new Set();
  const normalizeLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  remaining = remaining.replace(/^ {0,3}\[([^\]\n]+)\]:[^\n]*$/gm, (_, label) => {
    referenceLabels.add(normalizeLabel(label));
    return ' ';
  });
  remaining = remaining.replace(/\[[^\]\n]*\][ \t]*\n?[ \t]*\[[^\]\n]*\]/g, ' ');
  remaining = remaining.replace(/\[[^\]\n]*\]\([ \t]*<?(https?:\/\/[^\s)>]+)>?(?:\s+[^)]*)?\)/g, '$1');
  remaining = remaining.replace(/\[([^\]\n]+)\]/g, (text, label) => referenceLabels.has(normalizeLabel(label)) ? ' ' : text);
  remaining = remaining.replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/([1-9]\d*)(?:[/?#]|$)/i.exec(url);
    if (match && match[1].toLowerCase() === repository.toLowerCase()) add(match[2]);
    return ' ';
  });
  remaining = remaining.replace(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#([1-9]\d*)/g, (reference, number) => {
    if (reference.slice(0, reference.lastIndexOf('#')).toLowerCase() === repository.toLowerCase()) add(number);
    return ' ';
  });
  while (/\[[^\[\]\n]*\]/.test(remaining)) remaining = remaining.replace(/\[[^\[\]\n]*\]/g, ' ');
  for (const match of remaining.matchAll(/(?:^|[^\w/#])#([1-9]\d*)\b/g)) add(match[1]);
  return [...numbers].sort((a, b) => a - b);
}

export function eligible(issue) {
  return issue.state === 'open' && !issue.pull_request && !issue.locked &&
    (issue.labels ?? []).some((label) => (typeof label === 'string' ? label : label.name) === LABEL);
}

export function marker(tag, number) {
  return `<!-- mindwtr-release-confirmation:${tag}:${number} -->`;
}

export function commentBody(repository, tag, number) {
  const releaseUrl = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
  return [
    marker(tag, number),
    `A change for this issue is included in [Mindwtr ${tag}](${releaseUrl}).`,
    '',
    'It may not be available through your usual installation channel yet: store review, staged rollouts, and package updates take time. No action is needed until the update reaches you.',
    '',
    `Once your installed version is ${tag} or newer, please retry the reported steps and let us know the result. If the problem persists, include your installed version, platform, installation channel, and updated steps or diagnostic logs.`,
    '',
    'This issue stays open pending confirmation.',
  ].join('\n');
}

export function createApi(token, fetchImpl = fetch) {
  return async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mindwtr-release-confirmations',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path} failed: HTTP ${response.status}. Rerun after checking the workflow; POSTs are not blindly retried.`);
    }
    return response.status === 204 ? null : response.json();
  };
}

async function paginate(api, path) {
  const result = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= 1_000; page++) {
    const data = await api('GET', `${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new Error(`Expected a list from ${path}`);
    result.push(...data);
    if (data.length < 100) return result;
  }
  throw new Error(`Pagination safety limit reached: ${path}`);
}

export async function notify({ repository, tag, dryRun = true, api, botLogin = DEFAULT_BOT,
  maxComments = 50, log = console.log, sleep = delay }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Invalid GITHUB_REPOSITORY');
  if (!STABLE_TAG.test(tag ?? '')) throw new Error('RELEASE_TAG must be a stable app tag such as v1.3.9.');
  if (!Number.isSafeInteger(maxComments) || maxComments < 1) throw new Error('MAX_COMMENTS must be a positive integer.');
  const root = `/repos/${repository}`;
  const release = await api('GET', `${root}/releases/tags/${encodeURIComponent(tag)}`);
  if (release.tag_name !== tag || release.draft || release.prerelease || !release.published_at) {
    throw new Error('Refusing to notify for an unpublished, draft, or prerelease release.');
  }
  if (!Array.isArray(release.assets) || release.assets.length === 0) {
    throw new Error('Refusing to notify before release assets exist.');
  }
  const referenced = new Set(extractIssueNumbers(release.body, repository));
  const result = { dryRun, tag, referenced: referenced.size, candidates: 0, alreadyNotified: 0,
    noLongerEligible: 0, planned: 0, posted: 0 };
  if (!referenced.size) { log('No issue references / allowlisted issues in this release; nothing to notify.'); return result; }
  const issues = await paginate(api, `${root}/issues?state=open&labels=${encodeURIComponent(LABEL)}`);
  const candidates = issues.filter((issue) => referenced.has(issue.number) && eligible(issue))
    .sort((a, b) => a.number - b.number);
  result.candidates = candidates.length;
  if (candidates.length > maxComments) throw new Error(`Found ${candidates.length} candidates; exceeds MAX_COMMENTS=${maxComments}. Inspect a dry run / narrow the allowlist first.`);
  for (const candidate of candidates) {
    const number = candidate.number;
    const comments = await paginate(api, `${root}/issues/${number}/comments`);
    if (comments.some((comment) => comment.user?.login === botLogin &&
      (comment.body ?? '').includes(marker(tag, number)))) {
      result.alreadyNotified++; log(`#${number}: already notified for ${tag}.`); continue;
    }
    const current = await api('GET', `${root}/issues/${number}`);
    if (!eligible(current)) { result.noLongerEligible++; log(`#${number}: no longer eligible.`); continue; }
    const body = commentBody(repository, tag, number);
    result.planned++;
    if (dryRun) { log(`[DRY RUN] Would comment on #${number}:\n${body}\n`); continue; }
    await api('POST', `${root}/issues/${number}/comments`, { body });
    result.posted++;
    log(`#${number}: posted ${tag} retest request.`);
    await sleep(1_100);
  }
  return result;
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required, including for authenticated dry runs.');
  const flag = (process.env.DRY_RUN ?? 'true').toLowerCase();
  if (!['true', 'false'].includes(flag)) throw new Error('DRY_RUN must be true or false.');
  const result = await notify({ repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG,
    dryRun: flag !== 'false', api: createApi(token),
    maxComments: Number(process.env.MAX_COMMENTS ?? '50'),
    botLogin: process.env.NOTIFIER_BOT_LOGIN || DEFAULT_BOT });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Release confirmation notifier\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
