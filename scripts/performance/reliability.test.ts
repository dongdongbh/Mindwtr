import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

it('recovers committed SQLite data and converges restarted peers after lost acknowledgements', () => {
  const root = resolve(import.meta.dir, '../..');
  const scratch = join(root, 'build/performance-tools');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'reliability-test-'));
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, 'reliability.ts')], cwd: root,
      env: { ...process.env, ROUNDS: '2', SIZE: '4', RELIABILITY_OUT_DIR: directory },
      stdout: 'pipe', stderr: 'pipe', timeout: 30000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const report = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0], 'report.json'), 'utf8'));
    expect(report.status).toBe('passed');
    expect(report.crashes.map((item: { fault: string }) => item.fault)).toEqual(['before-commit', 'write-error', 'after-ack']);
    expect(report.lostAcknowledgements).toBe(2);
    expect(report.samples).toHaveLength(12);
    expect(report.metrics.totalMs.count).toBe(12);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 35000);
