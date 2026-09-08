import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

it('benchmarks real SQLite commits and sync output using a disposable synthetic database', () => {
  const root = resolve(import.meta.dir, '../..');
  const scratch = join(root, 'build/performance-tools');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'storage-test-'));
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, 'storage-sync.ts')], cwd: root,
      env: { ...process.env, RUNS: '1', SIZES: '2', STORAGE_OUT_DIR: directory },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const report = JSON.parse(readFileSync(join(directory, '2-report.json'), 'utf8'));
    expect(report.sampleCount).toBe(1);
    expect(report.metadata.synchronous).toBe('FULL');
    expect(Object.keys(report.metrics)).toHaveLength(8);
    expect(report.samples[0].unchangedStats.writtenRows).toBe(0);
    expect(report.samples[0].changedStats.writtenRows).toBe(1);
    expect(report.metrics.syncOneTaskMerge.count).toBe(1);
    expect(report.metrics.sqliteTargetedTaskSave.medianMs).toBeGreaterThanOrEqual(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
