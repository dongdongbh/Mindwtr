import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isNativeCapturePersisted,
  readNativeCaptureState,
  validateNativeCaptureBefore,
  validateNativeCaptureEvidence,
} from './native-capture-storage.mjs';

const expected = { id: 'captured-0', title: 'Native benchmark capture 0' };
type CaptureRow = typeof expected & { status: string; deletedAt: string | null };
const capture = (overrides: Partial<CaptureRow> = {}): CaptureRow => ({
  ...expected,
  status: 'inbox',
  deletedAt: null,
  ...overrides,
});
const state = (taskCount: number, captures: CaptureRow[] = []) => ({ taskCount, captures });

describe('native capture storage evidence', () => {
  it('requires the exact fixture count and no matching title before capture', () => {
    const before = state(1000);
    expect(validateNativeCaptureBefore(before, 1000)).toBe(before);
    expect(() => validateNativeCaptureBefore(state(999), 1000)).toThrow();
    expect(() => validateNativeCaptureBefore(state(1000, [capture()]), 1000)).toThrow();
  });

  it('rejects unrelated row growth that the old total-count condition accepted', () => {
    const unrelatedGrowth = state(1001);
    expect(unrelatedGrowth.taskCount === 1000 + 1).toBe(true);
    expect(isNativeCapturePersisted(unrelatedGrowth, expected, 1000)).toBe(false);
  });

  it('accepts only one live Inbox row with the exact capture identity and content', () => {
    expect(isNativeCapturePersisted(state(1000), expected, 1000)).toBe(false);
    expect(isNativeCapturePersisted(state(1001, [capture()]), expected, 1000)).toBe(true);

    for (const captures of [
      [capture({ id: 'another-id' })],
      [capture({ title: 'Another title' })],
      [capture({ status: 'next' })],
      [capture({ deletedAt: '2026-09-12T00:00:00.000Z' })],
      [capture(), capture({ id: 'duplicate-id' })],
    ]) expect(isNativeCapturePersisted(state(1001, captures), expected, 1000)).toBe(false);
  });

  it('throws on malformed state instead of treating corrupt evidence as pending', () => {
    for (const malformed of [
      null,
      {},
      state(-1),
      state(1.5),
      { taskCount: 0, captures: null },
      state(1, [{ id: 'x', title: 'Title', status: 'inbox' }]),
      state(1, [{ id: 'x', title: 'Title', status: 'inbox', deletedAt: 3 }]),
    ]) expect(() => isNativeCapturePersisted(malformed, expected, 0)).toThrow();
  });

  it('validates before, durable, reload, and visible-reload evidence together', () => {
    const evidence = {
      expected,
      before: state(1000),
      after: state(1001, [capture()]),
      reload: state(1001, [capture()]),
      reloadVisible: true,
    };
    expect(validateNativeCaptureEvidence(evidence, 1000)).toBe(evidence);

    for (const invalid of [
      { ...evidence, expected: { ...expected, id: '' } },
      { ...evidence, expected: { ...expected, title: 'User task' } },
      { ...evidence, before: state(999) },
      { ...evidence, before: state(1000, [capture()]) },
      { ...evidence, after: state(1001) },
      { ...evidence, reload: state(1001, [capture({ id: 'wrong-id' })]) },
      { ...evidence, reloadVisible: false },
    ]) expect(() => validateNativeCaptureEvidence(invalid, 1000)).toThrow();
  });
});

describe('native capture SQLite reader', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('reads one exact safely quoted title with the total from a synthetic database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindwtr-native-capture-storage-'));
    directories.push(directory);
    const database = join(directory, 'mindwtr.db');
    const title = "Native benchmark capture 0's quoted title";
    execFileSync('sqlite3', [database, `
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, deletedAt TEXT);
      INSERT INTO tasks VALUES ('unrelated', 'Other task', 'next', NULL);
      INSERT INTO tasks VALUES ('quoted', 'Native benchmark capture 0''s quoted title', 'inbox', NULL);
      INSERT INTO tasks VALUES ('near-match', 'Native benchmark capture 0''s quoted title extra', 'inbox', NULL);
    `], { timeout: 6000 });

    expect(readNativeCaptureState(database, title)).toEqual({
      taskCount: 3,
      captures: [{ id: 'quoted', title, status: 'inbox', deletedAt: null }],
    });
  });
});
