import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABEL, extractIssueNumbers, notify, marker, commentBody, createApi } from './notify-release-confirmations.mjs';

const repo = 'dongdongbh/Mindwtr';
const tag = 'v1.3.9';
const issue = (number, extra = {}) => ({ number, state: 'open', locked: false, labels: [{ name: LABEL }], ...extra });
function fixture({ body = 'Fixed capture (#1460).', issues = [issue(1460)], release = {}, latest = {}, comments = {}, failPost = false } = {}) {
  const writes = [];
  const commentMap = structuredClone(comments);
  const published = { tag_name: tag, draft: false, prerelease: false,
    published_at: '2026-11-16T00:00:00Z', assets: [{ name: 'mindwtr.apk' }], body, ...release };
  const api = async (method, path, payload) => {
    const url = new URL(`https://api.github.com${path}`);
    if (method === 'GET' && url.pathname.endsWith(`/releases/tags/${tag}`)) return published;
    if (method === 'GET' && url.pathname === `/repos/${repo}/issues`) {
      const page = Number(url.searchParams.get('page'));
      return issues.slice((page - 1) * 100, page * 100);
    }
    const commentMatch = /\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentMatch) {
      const number = Number(commentMatch[1]);
      if (method === 'GET') {
        const page = Number(url.searchParams.get('page'));
        return (commentMap[number] ?? []).slice((page - 1) * 100, page * 100);
      }
      if (method === 'POST') {
        if (failPost) throw new Error('Simulated uncertain POST failure');
        writes.push({ number, body: payload.body });
        (commentMap[number] ??= []).push({ user: { login: 'github-actions[bot]' }, body: payload.body });
        return { id: writes.length };
      }
    }
    const issueMatch = /\/issues\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && issueMatch) {
      const number = Number(issueMatch[1]);
      return latest[number] ?? issues.find((item) => item.number === number);
    }
    throw new Error(`Unexpected API call ${method} ${path}`);
  };
  const run = (extra = {}) => notify({ repository: repo, tag, api, log: () => {}, sleep: async () => {}, ...extra });
  return { run, writes, commentMap, api };
}

test('extracts deduplicated local references and local URLs', () => {
  assert.deepEqual(extractIssueNumbers('Changes (#1460, #1475). Again #1460. https://github.com/dongdongbh/Mindwtr/issues/1506', repo), [1460, 1475, 1506]);
});
test('ignores code, unrelated repository references, and arbitrary URL fragments', () => {
  const body = '#1460 other/repo#111 https://github.com/other/repo/issues/222 https://example.org/#333 `#444`\n```js\n#555\n```\n<!-- #666 -->';
  assert.deepEqual(extractIssueNumbers(body, repo), [1460]);
});
test('explicit allowlist wins over all other issue mentions', () => {
  assert.deepEqual(extractIssueNumbers('#1460 #1475 <!-- mindwtr-confirmation-issues: #1506, 1475 -->', repo), [1475, 1506]);
});
test('empty allowlist disables notifications and malformed directives fail closed', () => {
  assert.deepEqual(extractIssueNumbers('#1460 <!-- mindwtr-confirmation-issues: -->', repo), []);
  assert.throws(() => extractIssueNumbers('<!-- mindwtr-confirmation-issues: #1460,nope -->', repo));
});
test('only whitespace denotes an intentionally empty confirmation list', () => {
  for (const value of ['`1460`', '14`x`60', ', ,']) {
    assert.throws(() => extractIssueNumbers(`<!-- mindwtr-confirmation-issues: ${value} -->`, repo));
  }
  assert.deepEqual(extractIssueNumbers('`<!-- mindwtr-confirmation-issues: 1460 -->` #1475', repo), [1475]);
});
test('dry run is the default and performs no writes', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.planned, 1);
  assert.equal(result.posted, 0);
  assert.equal(f.writes.length, 0);
});
test('posts only to eligible release-referenced issues and never closes or labels', async () => {
  const f = fixture({ body: '#1460 #1475 #1506 #1507 #1508', issues: [issue(1460), issue(1475, { state: 'closed' }), issue(1506, { pull_request: {} }), issue(1507, { labels: [] }), issue(1508, { locked: true }), issue(1600)] });
  await f.run({ dryRun: false });
  assert.deepEqual(f.writes.map((item) => item.number), [1460]);
  assert.match(f.writes[0].body, /installation channel/);
});
test('rerun deduplicates the same release and issue', async () => {
  const f = fixture();
  await f.run({ dryRun: false });
  const second = await f.run({ dryRun: false });
  assert.equal(second.alreadyNotified, 1);
  assert.equal(f.writes.length, 1);
});
test('a copied marker from an ordinary user does not suppress the bot', async () => {
  const f = fixture({ comments: { 1460: [{ user: { login: 'reporter' }, body: marker(tag, 1460) }] } });
  await f.run({ dryRun: false });
  assert.equal(f.writes.length, 1);
});
test('checks all comment pages for an existing marker', async () => {
  const items = Array.from({ length: 100 }, () => ({ user: { login: 'reporter' }, body: 'comment' }));
  items.push({ user: { login: 'github-actions[bot]' }, body: marker(tag, 1460) });
  const f = fixture({ comments: { 1460: items } });
  const result = await f.run({ dryRun: false });
  assert.equal(result.alreadyNotified, 1);
  assert.equal(f.writes.length, 0);
});
test('checks all issue pages', async () => {
  const issues = Array.from({ length: 100 }, (_, i) => issue(2000 + i));
  issues.push(issue(1460));
  const f = fixture({ issues });
  assert.equal((await f.run()).planned, 1);
});
test('rechecks label and open state immediately before posting', async () => {
  const f = fixture({ latest: { 1460: issue(1460, { labels: [] }) } });
  assert.equal((await f.run({ dryRun: false })).noLongerEligible, 1);
  assert.equal(f.writes.length, 0);
});
test('refuses drafts, prereleases, unpublished releases, and releases without assets', async () => {
  for (const release of [{ draft: true }, { prerelease: true }, { published_at: null }, { assets: [] }]) {
    const f = fixture({ release });
    await assert.rejects(f.run({ dryRun: false }));
    assert.equal(f.writes.length, 0);
  }
});
test('rejects invalid/component/prerelease tags', async () => {
  const f = fixture();
  for (const invalid of ['mcp-v1.1.14', 'v1.3.9-rc.1', 'main', 'v1.3.9;echo bad']) {
    await assert.rejects(f.run({ tag: invalid }));
  }
});
test('safety cap fails before any comments are posted', async () => {
  const f = fixture({ body: '#1460 #1475', issues: [issue(1460), issue(1475)] });
  await assert.rejects(f.run({ maxComments: 1, dryRun: false }));
  assert.equal(f.writes.length, 0);
});
test('does not blindly retry an uncertain POST', async () => {
  const f = fixture({ failPost: true });
  await assert.rejects(f.run({ dryRun: false }), /uncertain POST/);
  assert.equal(f.writes.length, 0);
});

test('Markdown labels cannot turn foreign links into local references', () => {
  assert.deepEqual(extractIssueNumbers('[#111](https://github.com/other/repo/issues/111) [#222](https://example.org/222) [#1460](https://github.com/dongdongbh/Mindwtr/issues/1460)', repo), [1460]);
});
test('release notice waits for the installed version and never promises store availability', () => {
  const body = commentBody(repo, tag, 1460);
  assert.match(body, /No action is needed until the update reaches you/);
  assert.match(body, /Once your installed version is v1\.3\.9 or newer/);
  assert.match(body, /store review, staged rollouts, and package updates/);
  assert.match(body, /stays open pending confirmation/);
});
test('a later release only notifies issues referenced by that release', async () => {
  const f = fixture({ body: '#1475', issues: [issue(1460), issue(1475)], comments: {
    1460: [{ user: { login: 'github-actions[bot]' }, body: marker('v1.3.8', 1460) }],
    1475: [{ user: { login: 'github-actions[bot]' }, body: marker('v1.3.8', 1475) }],
  } });
  await f.run({ dryRun: false });
  assert.deepEqual(f.writes.map((item) => item.number), [1475]);
});
test('an uncertain successful POST is deduplicated on the next run', async () => {
  const f = fixture();
  const uncertain = async (method, path, body) => {
    const result = await f.api(method, path, body);
    if (method === 'POST') throw new Error('Lost response');
    return result;
  };
  await assert.rejects(f.run({ api: uncertain, dryRun: false }), /Lost response/);
  assert.equal((await f.run({ dryRun: false })).alreadyNotified, 1);
  assert.equal(f.writes.length, 1);
});
test('HTTP errors expose neither token nor response body and do not retry', async () => {
  let calls = 0;
  const api = createApi('private-token', async () => {
    calls++;
    return { ok: false, status: 403, json: async () => ({ secret: 'private-body' }) };
  });
  await assert.rejects(api('POST', '/repos/dongdongbh/Mindwtr/issues/1/comments', {}), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /private-token|private-body/);
    return true;
  });
  assert.equal(calls, 1);
});

test('release integration requires publication success and skips prereleases', () => {
  const source = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const job = source.split('  notify-confirmations:')[1]?.split('  update-packages:')[0];
  assert.ok(job);
  assert.match(job, /needs: \[validate, release\]/);
  assert.match(job, /needs.release.result == 'success'/);
  assert.match(job, /!contains\(needs.validate.outputs.tag, '-'\)/);
  assert.match(job, /issues: write/);
  assert.match(job, /uses: \.\/\.github\/workflows\/notify-release-confirmations.yml/);
});

test('stable release preparation requires one valid confirmation list before exposing the publisher notes path', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const step = /      - name: Resolve and validate release notes\n([\s\S]*?)\n      - name:/.exec(workflow);
  assert.ok(step);
  const run = step[1].split('        run: |\n')[1];
  assert.ok(run);
  const publishCondition = /^  release:\n    if: (.+)$/m.exec(workflow)?.[1];
  assert.ok(publishCondition);
  assert.ok(step[1].includes(`PUBLISH_RELEASE: ${publishCondition}`));
  const publish = workflow.split('      - name: Create Release\n')[1]?.split('\n  notify-confirmations:')[0];
  assert.ok(publish);
  assert.match(publish, /NOTES_FILE: \$\{\{ needs\.validate\.outputs\.release_notes_path \}\}/);
  assert.match(publish, /--notes-file "\$NOTES_FILE"/);

  const dir = mkdtempSync(join(tmpdir(), 'release-confirmation-notes-'));
  try {
    const notes = 'docs/release-notes/1.3.9.md';
    const output = join(dir, 'output');
    mkdirSync(join(dir, 'docs/release-notes'), { recursive: true });
    symlinkSync(fileURLToPath(new URL('../../scripts', import.meta.url)), join(dir, 'scripts'));
    const check = (body, publishRelease = 'true') => {
      writeFileSync(join(dir, notes), `# Mindwtr 1.3.9\n\n${body}\n`);
      writeFileSync(output, '');
      return spawnSync('bash', ['-e', '-c', run.replace(/^ {10}/gm, '')], {
        cwd: dir, env: { ...process.env, TAG: tag, VERSION: '1.3.9', GITHUB_OUTPUT: output, PUBLISH_RELEASE: publishRelease }, encoding: 'utf8',
      });
    };

    for (const invalid of ['Fixed #1460.', '```html\n<!-- mindwtr-confirmation-issues: #1460 -->\n```',
      '<!-- mindwtr-confirmation-issues: #0 -->', '<!-- mindwtr-confirmation-issues: #1460 -->\n<!-- mindwtr-confirmation-issues: -->']) {
      const result = check(invalid);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /confirmation-issues/);
      assert.equal(readFileSync(output, 'utf8'), '');
    }
    for (const valid of ['<!-- mindwtr-confirmation-issues: #1460, 1575 -->', '#1460\n<!-- mindwtr-confirmation-issues: -->']) {
      const result = check(valid);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(output, 'utf8'), `body_path=${notes}\n`);
    }
    assert.equal(check('Historical release notes.', 'false').status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reference-style Markdown is skipped instead of misreading its labels as local issues', () => {
  const body = '[#111][foreign] [#222][] [#333] [local][local]\n[foreign]: https://github.com/other/repo/issues/111\n[#222]: https://github.com/other/repo/issues/222\n[#333]: https://example.org/333\n[local]: https://github.com/dongdongbh/Mindwtr/issues/444\n#1460';
  assert.deepEqual(extractIssueNumbers(body, repo), [1460]);
});
test('angle-wrapped inline links use their destination instead of the label', () => {
  assert.deepEqual(extractIssueNumbers('[#111](<https://github.com/other/repo/issues/111>) [#222](<https://github.com/dongdongbh/Mindwtr/issues/1460>)', repo), [1460]);
});

test('longer closing fences and indented code never become issue candidates', () => {
  assert.deepEqual(extractIssueNumbers('~~~text\n#333\n~~~~\n    #444\n\t#555\n#1460', repo), [1460]);
  assert.deepEqual(extractIssueNumbers('```text\n#333\n````\n#1460', repo), [1460]);
  assert.deepEqual(extractIssueNumbers('#1460\n```\n#333', repo), [1460]);
});
test('malformed or unclosed explicit lists fail closed rather than falling back to ordinary references', () => {
  for (const body of ['#111\n<!-- mindwtr-confirmation-issues: #222', '#111\n<!-- mindwtr-confirmation-issues #222 -->']) {
    assert.throws(() => extractIssueNumbers(body, repo), /Malformed/);
  }
  assert.deepEqual(extractIssueNumbers('#1460 <!-- unfinished #333', repo), [1460]);
});

test('nested link labels never fall through to local issue references', () => {
  for (const body of ['[[#111]](https://github.com/other/repo/issues/111)', '[[#111]][foreign]\n[foreign]: https://github.com/other/repo/issues/111']) {
    assert.deepEqual(extractIssueNumbers(body, repo), []);
  }
});
