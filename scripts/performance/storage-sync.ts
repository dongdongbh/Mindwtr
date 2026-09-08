import { Database, type SQLQueryBindings } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteAdapter, type SqliteClient } from '../../packages/core/src/sqlite-adapter';
import { mergeAppData } from '../../packages/core/src/sync';
import type { AppData } from '../../packages/core/src/types';
import { fixture } from './fixture.mjs';
import { summarize } from './report.mjs';

// Never accepts an existing database. Keep synthetic databases beside reports,
// on disk (not tmpfs), for inspecting query plans or reproducing a slow sample.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.env.STORAGE_OUT_DIR ?? join(root, 'build/performance-storage', new Date().toISOString().replaceAll(':', '-')));
const runs = Number(process.env.RUNS ?? 10);
const sizes = (process.env.SIZES ?? '1000,10000,50000').split(',').map(Number);
assert(Number.isInteger(runs) && runs >= 1 && runs <= 1000, 'RUNS must be 1..1000');
for (const size of sizes) { fixture(size); assert(size >= 2, 'Storage fixtures need at least two tasks'); }
mkdirSync(output, { recursive: true });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());

for (const size of sizes) {
  const seed = fixture(size);
  const directory = mkdtempSync(join(output, `${size}-`));
  const path = join(directory, 'synthetic.sqlite');
  const db = new Database(path);
  const client: SqliteClient = {
    run: async (sql, params = []) => { db.query(sql).run(...params as SQLQueryBindings[]); },
    all: async <T>(sql: string, params: unknown[] = []) => db.query(sql).all(...params as SQLQueryBindings[]) as T[],
    get: async <T>(sql: string, params: unknown[] = []) => (db.query(sql).get(...params as SQLQueryBindings[]) ?? undefined) as T | undefined,
    exec: async (sql) => { db.exec(sql); },
  };
  const adapter = new SqliteAdapter(client);
  const samples: Array<Record<string, unknown>> = [];
  try {
    // FULL acknowledgement is intentionally retained; do not trade durability
    // for a lower write timing. This runner does not emulate the Tauri/RN bridge.
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const initialStart = performance.now();
    await adapter.saveData(seed.data as AppData);
    const initialWriteMs = performance.now() - initialStart;
    let canonical = await adapter.getData();
    // Align the adapter fingerprint cache with the canonical hydrated shape.
    await adapter.saveData(canonical);
    for (let run = 0; run <= runs; run++) {
      const durations: Record<string, number> = {};
      const time = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
        const start = performance.now();
        const value = await work();
        durations[name] = performance.now() - start;
        return value;
      };
      const loaded = await time('sqliteHydrate', () => new SqliteAdapter(client).getData());
      assert.equal(loaded.tasks.length, size);
      await time('sqliteUnchangedSave', () => adapter.saveData(canonical));
      const unchangedStats = adapter.getLastSaveDataStats();
      assert.equal(unchangedStats?.writtenRows, 0, 'Unchanged snapshot rewrote entity rows');
      assert.equal(unchangedStats?.removedRows, 0);
      assert.equal(unchangedStats?.settingsWritten, false);
      const json = await time('jsonSerialize', () => JSON.stringify(canonical));
      const peer = await time('jsonParse', () => JSON.parse(json) as AppData);
      assert.equal(peer.tasks.length, size);
      const unchangedMerge = await time('syncUnchangedMerge', () => mergeAppData(canonical, peer, { nowIso: '2026-09-08T12:00:00.000Z' }));
      assert.equal(unchangedMerge.tasks.length, size);
      peer.tasks[0] = { ...peer.tasks[0], title: `Synthetic edit ${run}`, rev: (peer.tasks[0].rev ?? 0) + 1, updatedAt: '2020-01-02T00:00:00.000Z' };
      const merged = await time('syncOneTaskMerge', () => mergeAppData(canonical, peer, { nowIso: '2026-09-08T12:00:00.000Z' }));
      assert.equal(merged.tasks.find(task => task.id === peer.tasks[0].id)?.title, peer.tasks[0].title);
      // Isolate a single changed row from merge normalization/settings changes.
      canonical = { ...canonical, tasks: canonical.tasks.map((task, index) => index === 0 ? peer.tasks[0] : task) };
      await time('sqliteOneTaskSnapshotSave', () => adapter.saveData(canonical));
      const changedStats = adapter.getLastSaveDataStats();
      assert.equal(changedStats?.writtenRows, 1, 'Single edit rewrote unrelated entity rows');
      assert.equal(changedStats?.removedRows, 0);
      const targeted = { ...canonical.tasks[1], title: `Synthetic direct edit ${run}`, rev: (canonical.tasks[1].rev ?? 0) + 1 };
      await time('sqliteTargetedTaskSave', () => adapter.saveTask(targeted));
      canonical = { ...canonical, tasks: canonical.tasks.map((task, index) => index === 1 ? targeted : task) };
      // A fresh connection validates committed readback, outside timed regions.
      const checkDb = new Database(path, { readonly: true });
      try {
        assert.equal((checkDb.query('SELECT title FROM tasks WHERE id = ?').get(targeted.id) as { title: string }).title, targeted.title);
        assert.equal((checkDb.query('SELECT title FROM tasks WHERE id = ?').get(peer.tasks[0].id) as { title: string }).title, peer.tasks[0].title);
      } finally { checkDb.close(); }
      if (run) samples.push({ run, quality: 'ok', durations, unchangedStats, changedStats, jsonBytes: Buffer.byteLength(json) });
    }
    const metrics = Object.fromEntries(Object.keys(samples[0].durations as Record<string, number>).map(name => [
      name, summarize(samples.map(sample => (sample.durations as Record<string, number>)[name])),
    ]));
    const report = {
      schemaVersion: 1,
      metadata: { platform: 'bun-sqlite', runtime: `bun-${Bun.version}`, os: `${platform()}-${release()}`,
        device: process.env.DEVICE_LABEL ?? `local-${cpus()[0]?.model}-${cpus().length}cpu`, buildType: 'source',
        revision, dirty, dataset: seed.id, network: 'none', scenario: 'storage-sync-v1',
        journalMode: 'WAL', synchronous: 'FULL', capturedAt: new Date().toISOString() },
      initialWriteMs, sampleCount: samples.length, invalidSamples: 0, metrics, samples,
      warnings: ['Warm OS caches; Bun SQLite binding, not native mobile/Tauri bridge or cloud round-trip.',
        'Initial population is one descriptive sample; timings are reporting-only, not a hosted CI gate.'],
    };
    writeFileSync(join(output, `${size}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${seed.id}: ${JSON.stringify(metrics)}`);
  } finally { db.close(); }
}
console.log(`Storage/sync reports: ${output}`);
