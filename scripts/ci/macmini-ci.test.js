import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const prepareCacheScript = fileURLToPath(new URL('./prepare-apple-cache.sh', import.meta.url));
const dispatchScript = fileURLToPath(new URL('./dispatch-macmini.sh', import.meta.url));

test('Mac caches survive cleanup without Watchman while stale generated sources are removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'mindwtr-cache-'));
  try {
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    mkdirSync(repo); mkdirSync(bin);
    execFileSync('git', ['init', '-q', repo]);
    for (const path of ['node_modules/dependency', 'apps/mobile/node_modules/dependency', 'apps/mobile/ios/stale.swift']) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), 'fixture');
    }
    writeFileSync(join(bin, 'xcodebuild'), '#!/bin/sh\necho "Xcode $FIXTURE_XCODE"\n', { mode: 0o755 });
    writeFileSync(join(bin, 'watchman'), '#!/bin/sh\necho "CI must not start Watchman" >&2\nexit 88\n', { mode: 0o755 });
    writeFileSync(join(bin, 'df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 20000000 1 12582912 1%% /\\n"\n', { mode: 0o755 });
    const envFile = join(root, 'env');
    const run = (version) => {
      writeFileSync(envFile, '');
      execFileSync('bash', [prepareCacheScript], { cwd: repo, env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root,
        GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_TEMP: root,
        GITHUB_ENV: envFile, GITHUB_PATH: join(root, 'path'), FIXTURE_XCODE: version,
      }});
      return readFileSync(envFile, 'utf8').split('\n').find((line) => line.startsWith('MINDWTR_NATIVE_CACHE=')).split('=')[1];
    };
    const first = run('27A');
    writeFileSync(join(first, 'swift', 'compiled'), 'cached');
    expect(run('27A')).toBe(first);
    expect(existsSync(join(first, 'swift', 'compiled'))).toBe(true);
    expect(existsSync(join(repo, 'node_modules/dependency'))).toBe(true);
    expect(existsSync(join(repo, 'apps/mobile/node_modules/dependency'))).toBe(true);
    expect(existsSync(join(repo, 'apps/mobile/ios/stale.swift'))).toBe(false);
    expect(run('27B')).not.toBe(first);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const minimumKiB = 12 * 1024 * 1024;
const cacheFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'mindwtr-headroom-'));
  const repo = join(root, 'repo'); const bin = join(root, 'bin');
  mkdirSync(repo); mkdirSync(bin); execFileSync('git', ['init', '-q', repo]);
  const cacheRoot = join(root, 'Library/Caches/MindwtrNativeCI');
  mkdirSync(join(root, 'Library/Caches'), { recursive: true });
  for (const path of ['node_modules/dependency', 'apps/mobile/node_modules/dependency']) {
    mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), 'dependency');
  }
  writeFileSync(join(bin, 'xcodebuild'), '#!/bin/sh\necho "Xcode 27A"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'watchman'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'df'), `#!/bin/bash
set -eu
test "$1" = -Pk
test "$2" = "$HOME"
calls=0
[ ! -f "$FIXTURE_DF_STATE" ] || calls="$(cat "$FIXTURE_DF_STATE")"
calls=$((calls + 1))
echo "$calls" > "$FIXTURE_DF_STATE"
[ "$FIXTURE_DF_MODE" != failure ] || exit 1
if [ "$FIXTURE_DF_MODE" = malformed ]; then echo 'not df output'; exit 0; fi
available="$FIXTURE_BEFORE_KIB"
[ "$calls" -eq 1 ] || available="$FIXTURE_AFTER_KIB"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 40000000 1 %s 1%% /\n' "$available"
`, { mode: 0o755 });
  const seed = (version, child) => {
    const directory = join(cacheRoot, version, child); mkdirSync(directory, { recursive: true });
    const file = join(directory, 'preserved'); writeFileSync(file, 'fixture'); return file;
  };
  const run = (before = minimumKiB, after = minimumKiB, extra = {}, args = []) => spawnSync('bash', [prepareCacheScript, ...args], { cwd: repo, encoding: 'utf8', env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_TEMP: root, GITHUB_ENV: join(root, 'env'), GITHUB_PATH: join(root, 'path'),
    FIXTURE_DF_STATE: join(root, 'df-state'), FIXTURE_DF_MODE: 'valid', FIXTURE_BEFORE_KIB: String(before), FIXTURE_AFTER_KIB: String(after), ...extra,
  } });
  return { root, repo, cacheRoot, seed, run, close: () => rmSync(root, { recursive: true, force: true }) };
};

test('low Apple disk space trims only known generated children across compiler versions', () => {
  const fixture = cacheFixture();
  try {
    const removed = [];
    for (const version of ['a'.repeat(16), '0123456789abcdef']) for (const child of ['swift', 'simulator', 'archive']) removed.push(fixture.seed(version, child));
    const preserved = [fixture.seed('a'.repeat(16), 'unknown'), fixture.seed('future-compiler', 'swift'),
      fixture.seed('A'.repeat(16), 'archive'), fixture.seed('b'.repeat(15), 'simulator')];
    const result = fixture.run(minimumKiB - 1, minimumKiB);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`before_kib=${minimumKiB - 1} after_kib=${minimumKiB} trimmed_entries=6`);
    for (const file of removed) expect(existsSync(file)).toBe(false);
    for (const file of preserved) expect(readFileSync(file, 'utf8')).toBe('fixture');
    for (const path of ['node_modules/dependency', 'apps/mobile/node_modules/dependency']) expect(readFileSync(join(fixture.repo, path), 'utf8')).toBe('dependency');
    const cache = readFileSync(join(fixture.root, 'env'), 'utf8').split('\n').find((line) => line.startsWith('MINDWTR_NATIVE_CACHE=')).slice('MINDWTR_NATIVE_CACHE='.length);
    for (const child of ['swift', 'simulator', 'archive']) expect(existsSync(join(cache, child))).toBe(true);
    expect(readFileSync(join(fixture.root, 'df-state'), 'utf8').trim()).toBe('2');
  } finally { fixture.close(); }
});

test('healthy Apple space preserves every compiler cache and reads disk space once', () => {
  const fixture = cacheFixture();
  try {
    const files = ['swift', 'simulator', 'archive', 'unknown'].map((child) => fixture.seed('a'.repeat(16), child));
    const result = fixture.run(minimumKiB, 0);
    expect(result.status).toBe(0); expect(result.stdout).toContain(`before_kib=${minimumKiB} after_kib=${minimumKiB} trimmed_entries=0`);
    for (const file of files) expect(readFileSync(file, 'utf8')).toBe('fixture');
    expect(readFileSync(join(fixture.root, 'df-state'), 'utf8').trim()).toBe('1');
  } finally { fixture.close(); }
});

test('insufficient Apple space after bounded cleanup fails before cache creation and build setup', () => {
  const fixture = cacheFixture();
  try {
    const generated = fixture.seed('a'.repeat(16), 'swift'); const unknown = fixture.seed('a'.repeat(16), 'unknown');
    const result = fixture.run(100, 200);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('At least 12 GiB'); expect(result.stderr).toContain('free runner disk space before retrying');
    expect(result.stdout).toContain('before_kib=100 after_kib=200 trimmed_entries=1');
    expect(existsSync(generated)).toBe(false); expect(existsSync(unknown)).toBe(true); expect(existsSync(join(fixture.root, 'env'))).toBe(false);
  } finally { fixture.close(); }
});

test.each(['malformed', 'failure', 'invalid-count', 'overflow-count'])('unreadable or malformed df (%s) cannot erase cache data', (mode) => {
  const fixture = cacheFixture();
  try {
    const file = fixture.seed('a'.repeat(16), 'swift');
    const before = mode === 'invalid-count' ? 'not-a-number' : mode === 'overflow-count' ? '9'.repeat(30) : 100;
    const result = fixture.run(before, minimumKiB, { FIXTURE_DF_MODE: mode === 'invalid-count' || mode === 'overflow-count' ? 'valid' : mode });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Cannot measure'); expect(readFileSync(file, 'utf8')).toBe('fixture');
  } finally { fixture.close(); }
});

test.each(['root', 'version', 'child', 'dangling-child', 'library-parent', 'caches-parent', 'home-parent'])('symlinked owned cache %s is rejected without following or deleting its target', (kind) => {
  const fixture = cacheFixture();
  try {
    const target = join(fixture.root, 'outside'); mkdirSync(join(target, 'swift'), { recursive: true }); const sentinel = join(target, 'swift/preserved'); writeFileSync(sentinel, 'untouched');
    const extra = {};
    if (kind === 'home-parent') { const alias = join(fixture.root, 'home-alias'); symlinkSync(target, alias, 'dir'); extra.HOME = alias; }
    else if (kind === 'library-parent' || kind === 'caches-parent') {
      const parent = join(fixture.root, kind === 'library-parent' ? 'Library' : 'Library/Caches');
      rmSync(parent, { recursive: true }); symlinkSync(target, parent, 'dir');
    }
    else if (kind === 'root') symlinkSync(target, fixture.cacheRoot, 'dir');
    else {
      mkdirSync(fixture.cacheRoot);
      const version = join(fixture.cacheRoot, 'a'.repeat(16));
      if (kind === 'version') symlinkSync(target, version, 'dir');
      else { mkdirSync(version); symlinkSync(kind === 'dangling-child' ? join(target, 'missing') : target, join(version, 'swift'), 'dir'); }
    }
    const result = fixture.run(100, minimumKiB, extra);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Refusing symlinked'); expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
    expect(existsSync(join(fixture.root, 'df-state'))).toBe(false);
  } finally { fixture.close(); }
});

test('unknown cache symlinks and GitHub-hosted cache behavior remain untouched', () => {
  const fixture = cacheFixture();
  try {
    const target = join(fixture.root, 'outside'); mkdirSync(target); writeFileSync(join(target, 'preserved'), 'untouched');
    mkdirSync(fixture.cacheRoot); symlinkSync(target, join(fixture.cacheRoot, 'unknown-version'), 'dir');
    mkdirSync(join(fixture.cacheRoot, 'a'.repeat(16))); symlinkSync(target, join(fixture.cacheRoot, 'a'.repeat(16), 'unknown-child'), 'dir');
    const low = fixture.run(100, minimumKiB); expect(low.status).toBe(0); expect(low.stdout).toContain('trimmed_entries=0'); expect(readFileSync(join(target, 'preserved'), 'utf8')).toBe('untouched');
    rmSync(join(fixture.root, 'df-state'));
    const hosted = fixture.run(0, 0, { RUNNER_ENVIRONMENT: 'github-hosted', FIXTURE_DF_MODE: 'failure' });
    expect(hosted.status).toBe(0); expect(existsSync(join(fixture.root, 'df-state'))).toBe(false);
    expect(readFileSync(join(fixture.root, 'env'), 'utf8')).toContain(`MINDWTR_NATIVE_CACHE=${fixture.root}/mindwtr-native/`);
  } finally { fixture.close(); }
});

const archiveMinimumKiB = 20 * 1024 * 1024;
const fixtureCompiler = createHash('sha256').update('Xcode 27A\n').digest('hex').slice(0, 16);
const archiveFixture = () => {
  const fixture = cacheFixture();
  const current = join(fixture.cacheRoot, fixtureCompiler);
  const simulator = fixture.seed(fixtureCompiler, 'simulator');
  const archive = fixture.seed(fixtureCompiler, 'archive');
  const preserved = [fixture.seed(fixtureCompiler, 'swift'), fixture.seed(fixtureCompiler, 'unknown'),
    fixture.seed('a'.repeat(16), 'simulator'), fixture.seed('a'.repeat(16), 'archive'), fixture.seed('future-compiler', 'archive')];
  for (const path of ['ios27-artifacts/release-simulator-build.log', 'ios27-artifacts/smoke.json',
    'Library/Developer/CoreSimulator/Devices/installed-app/evidence', 'env', 'path']) {
    const file = join(fixture.root, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'preserved evidence'); preserved.push(file);
  }
  const source = join(fixture.repo, 'apps/mobile/ios/Mindwtr.xcworkspace/generated');
  mkdirSync(join(source, '..'), { recursive: true }); writeFileSync(source, 'preserved evidence'); preserved.push(source);
  for (const path of ['node_modules/dependency', 'apps/mobile/node_modules/dependency']) preserved.push(join(fixture.repo, path));

  for (const command of ['git', 'watchman']) writeFileSync(join(fixture.root, 'bin', command), `#!/bin/sh\ntouch "$HOME/${command}-called"\nexit 1\n`, { mode: 0o755 });
  const runArchive = (before = archiveMinimumKiB, after = archiveMinimumKiB, extra = {}) => fixture.run(before, after,
    { MINDWTR_NATIVE_CACHE: current, ...extra }, ['before-archive']);
  return { ...fixture, current, simulator, archive, preserved, runArchive };
};

test('pre-archive low space removes only completed current-compiler simulator and archive caches', () => {
  const fixture = archiveFixture();
  try {
    const contents = fixture.preserved.map((file) => readFileSync(file, 'utf8'));
    const result = fixture.runArchive(13 * 1024 * 1024, archiveMinimumKiB);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`after_kib=${archiveMinimumKiB} trimmed_entries=2 minimum_kib=${archiveMinimumKiB}`);
    expect(existsSync(fixture.simulator)).toBe(false); expect(existsSync(fixture.archive)).toBe(false);
    expect(existsSync(join(fixture.current, 'simulator'))).toBe(false); expect(existsSync(join(fixture.current, 'archive'))).toBe(false);
    fixture.preserved.forEach((file, index) => expect(readFileSync(file, 'utf8')).toBe(contents[index]));
    expect(existsSync(join(fixture.root, 'git-called'))).toBe(false); expect(existsSync(join(fixture.root, 'watchman-called'))).toBe(false);
    expect(readFileSync(join(fixture.root, 'df-state'), 'utf8').trim()).toBe('2');
  } finally { fixture.close(); }
});

test('pre-archive exact 20 GiB floor preserves caches and reads space once without startup environment requirements', () => {
  const fixture = archiveFixture();
  try {
    const result = fixture.runArchive(archiveMinimumKiB, 0, { GITHUB_ENV: '', GITHUB_PATH: '', RUNNER_TEMP: '' });
    expect(result.status).toBe(0); expect(result.stdout).toContain(`trimmed_entries=0 minimum_kib=${archiveMinimumKiB}`);
    expect(readFileSync(fixture.simulator, 'utf8')).toBe('fixture'); expect(readFileSync(fixture.archive, 'utf8')).toBe('fixture');
    expect(readFileSync(join(fixture.root, 'env'), 'utf8')).toBe('preserved evidence'); expect(readFileSync(join(fixture.root, 'path'), 'utf8')).toBe('preserved evidence');
    expect(readFileSync(join(fixture.root, 'df-state'), 'utf8').trim()).toBe('1');
    expect(existsSync(join(fixture.root, 'git-called'))).toBe(false); expect(existsSync(join(fixture.root, 'watchman-called'))).toBe(false);
  } finally { fixture.close(); }
});

test('pre-archive insufficient space after bounded cleanup fails while retaining checkout and evidence', () => {
  const fixture = archiveFixture();
  try {
    const contents = fixture.preserved.map((file) => readFileSync(file, 'utf8'));
    const result = fixture.runArchive(100, archiveMinimumKiB - 1);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('At least 20 GiB'); expect(result.stderr).toContain('before archiving');
    expect(result.stdout).toContain(`after_kib=${archiveMinimumKiB - 1} trimmed_entries=2`);
    expect(existsSync(fixture.simulator)).toBe(false); expect(existsSync(fixture.archive)).toBe(false);
    fixture.preserved.forEach((file, index) => expect(readFileSync(file, 'utf8')).toBe(contents[index]));
    expect(existsSync(join(fixture.root, 'git-called'))).toBe(false); expect(existsSync(join(fixture.root, 'watchman-called'))).toBe(false);
  } finally { fixture.close(); }
});

test.each(['malformed', 'failure', 'invalid-count', 'overflow-count'])('pre-archive invalid df (%s) cannot remove either generated cache', (mode) => {
  const fixture = archiveFixture();
  try {
    const before = mode === 'invalid-count' ? 'not-a-number' : mode === 'overflow-count' ? '9'.repeat(30) : 100;
    const result = fixture.runArchive(before, archiveMinimumKiB, { FIXTURE_DF_MODE: mode === 'invalid-count' || mode === 'overflow-count' ? 'valid' : mode });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Cannot measure');
    expect(readFileSync(fixture.simulator, 'utf8')).toBe('fixture'); expect(readFileSync(fixture.archive, 'utf8')).toBe('fixture');
  } finally { fixture.close(); }
});

test.each(['root', 'version', 'simulator', 'archive', 'dangling-archive', 'library-parent', 'caches-parent', 'home-parent'])('pre-archive symlinked %s is refused before either candidate is removed', (kind) => {
  const fixture = archiveFixture();
  try {
    const target = join(fixture.root, 'outside'); mkdirSync(target); const sentinel = join(target, 'preserved'); writeFileSync(sentinel, 'untouched');
    const extra = {};
    if (kind === 'home-parent') { const alias = join(fixture.root, 'home-alias'); symlinkSync(target, alias, 'dir'); extra.HOME = alias; }
    else {
      const path = kind === 'root' ? fixture.cacheRoot : kind === 'version' ? fixture.current
        : kind === 'library-parent' ? join(fixture.root, 'Library') : kind === 'caches-parent' ? join(fixture.root, 'Library/Caches')
          : join(fixture.current, kind === 'simulator' ? 'simulator' : 'archive');
      rmSync(path, { recursive: true }); symlinkSync(kind === 'dangling-archive' ? join(target, 'missing') : target, path, 'dir');
    }
    const result = fixture.runArchive(100, archiveMinimumKiB, extra);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Refusing symlinked'); expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
    if (kind === 'archive' || kind === 'dangling-archive') expect(readFileSync(fixture.simulator, 'utf8')).toBe('fixture');
    expect(existsSync(join(fixture.root, 'df-state'))).toBe(false);
  } finally { fixture.close(); }
});

test.each(['version', 'simulator', 'archive'])('pre-archive unexpected %s path type cannot authorize deletion', (kind) => {
  const fixture = archiveFixture();
  try {
    const path = kind === 'version' ? fixture.current : join(fixture.current, kind);
    rmSync(path, { recursive: true }); writeFileSync(path, 'unexpected file');
    const result = fixture.runArchive(100, archiveMinimumKiB);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Refusing'); expect(readFileSync(path, 'utf8')).toBe('unexpected file');
    if (kind === 'archive') expect(readFileSync(fixture.simulator, 'utf8')).toBe('fixture');
    expect(existsSync(join(fixture.root, 'df-state'))).toBe(false);
  } finally { fixture.close(); }
});

test.each(['other-compiler', 'outside', 'traversal', 'unset'])('pre-archive rejects %s cache identity instead of trusting supplied path', (kind) => {
  const fixture = archiveFixture();
  try {
    const supplied = kind === 'other-compiler' ? join(fixture.cacheRoot, 'a'.repeat(16)) : kind === 'outside' ? fixture.root
      : kind === 'traversal' ? `${fixture.current}/../${fixtureCompiler}` : '';
    const result = fixture.runArchive(100, archiveMinimumKiB, { MINDWTR_NATIVE_CACHE: supplied });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('does not match the current compiler');
    expect(readFileSync(fixture.simulator, 'utf8')).toBe('fixture'); expect(readFileSync(fixture.archive, 'utf8')).toBe('fixture'); expect(existsSync(join(fixture.root, 'df-state'))).toBe(false);
  } finally { fixture.close(); }
});

test('pre-archive ignores unknown and other-compiler symlinks without deleting their targets', () => {
  const fixture = archiveFixture();
  try {
    const target = join(fixture.root, 'outside'); mkdirSync(target); const sentinel = join(target, 'preserved'); writeFileSync(sentinel, 'untouched');
    symlinkSync(target, join(fixture.current, 'unknown-link'), 'dir'); symlinkSync(target, join(fixture.cacheRoot, 'b'.repeat(16)), 'dir');
    const result = fixture.runArchive(100, archiveMinimumKiB);
    expect(result.status).toBe(0); expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
    expect(existsSync(join(fixture.current, 'unknown-link'))).toBe(true); expect(existsSync(join(fixture.cacheRoot, 'b'.repeat(16)))).toBe(true);
  } finally { fixture.close(); }
});

test('pre-archive is a no-op on GitHub-hosted runners', () => {
  const fixture = archiveFixture();
  try {
    writeFileSync(join(fixture.root, 'bin/xcodebuild'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = fixture.runArchive(0, 0, { RUNNER_ENVIRONMENT: 'github-hosted', FIXTURE_DF_MODE: 'failure', MINDWTR_NATIVE_CACHE: 'untrusted', GITHUB_ENV: '', GITHUB_PATH: '', RUNNER_TEMP: '' });
    expect(result.status).toBe(0); expect(existsSync(join(fixture.root, 'df-state'))).toBe(false); expect(readFileSync(fixture.simulator, 'utf8')).toBe('fixture'); expect(readFileSync(fixture.archive, 'utf8')).toBe('fixture');
  } finally { fixture.close(); }
});

test.each([{ args: ['unknown'] }, { args: ['before-archive', 'extra'] }])('cache script refuses unsupported phase arguments %j without cleanup', ({ args }) => {
  const fixture = archiveFixture();
  try {
    const result = fixture.run(100, archiveMinimumKiB, {}, args);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Expected startup or before-archive'); expect(existsSync(join(fixture.root, 'df-state'))).toBe(false); expect(readFileSync(fixture.simulator, 'utf8')).toBe('fixture');
  } finally { fixture.close(); }
});

test.each(['version-command', 'malformed-hash'])('pre-archive compiler identification failure %s cannot authorize cleanup', (fault) => {
  const fixture = archiveFixture();
  try {
    const command = fault === 'version-command' ? 'xcodebuild' : 'shasum';
    writeFileSync(join(fixture.root, 'bin', command), fault === 'version-command' ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\ncat >/dev/null\necho invalid-hash\n', { mode: 0o755 });
    const result = fixture.runArchive(100, archiveMinimumKiB);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain(fault === 'version-command' ? 'Cannot identify the current compiler cache' : 'Invalid compiler cache identity');
    expect(readFileSync(fixture.simulator, 'utf8')).toBe('fixture'); expect(readFileSync(fixture.archive, 'utf8')).toBe('fixture'); expect(existsSync(join(fixture.root, 'df-state'))).toBe(false);
  } finally { fixture.close(); }
});

test.each([1, 2, 4])('symlinked HOME with %s trailing slashes is refused before startup or archive cache deletion', (slashes) => {
  for (const phase of ['startup', 'before-archive']) {
    const fixture = cacheFixture();
    try {
      const outside = join(fixture.root, 'outside');
      const outsideCache = join(outside, 'Library/Caches/MindwtrNativeCI', fixtureCompiler);
      const sentinels = ['swift', 'simulator', 'archive'].map((child) => {
        const file = join(outsideCache, child, 'preserved'); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'untouched'); return file;
      });
      const alias = join(fixture.root, 'home-alias'); symlinkSync(outside, alias, 'dir');
      const suppliedHome = alias + '/'.repeat(slashes);
      const result = fixture.run(100, archiveMinimumKiB, {
        HOME: suppliedHome, MINDWTR_NATIVE_CACHE: `${suppliedHome}/Library/Caches/MindwtrNativeCI/${fixtureCompiler}`,
      }, [phase]);
      expect(result.status).not.toBe(0); expect(result.stderr).toContain('Refusing symlinked owned cache parent');
      for (const file of sentinels) expect(readFileSync(file, 'utf8')).toBe('untouched');
      expect(existsSync(join(fixture.root, 'df-state'))).toBe(false); expect(existsSync(join(fixture.root, 'env'))).toBe(false); expect(existsSync(join(fixture.root, 'path'))).toBe(false);
    } finally { fixture.close(); }
  }
});

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
  expect(uploaded).toContain('path: ${{ runner.temp }}/ios27-artifacts');
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
