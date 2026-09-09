import { Database, type SQLQueryBindings } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SqliteAdapter, type SqliteClient } from '../../packages/core/src/sqlite-adapter';
import { performSyncCycle } from '../../packages/core/src/sync';
import type { AppData } from '../../packages/core/src/types';
import { fixture } from './fixture.mjs';
import { summarize } from './report.mjs';

type Fault = 'before-commit' | 'after-ack' | 'write-error' | undefined;

function open(path: string, fault?: Fault) {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  let armed = false;
  const client: SqliteClient = {
    run: async (sql, params = []) => {
      if (armed && sql === 'COMMIT') {
        if (fault === 'before-commit') process.kill(process.pid, 'SIGKILL');
        if (fault === 'write-error') throw new Error('Injected SQLITE_FULL at commit boundary');
      }
      db.query(sql).run(...params as SQLQueryBindings[]);
    },
    all: async <T>(sql: string, params: unknown[] = []) => db.query(sql).all(...params as SQLQueryBindings[]) as T[],
    get: async <T>(sql: string, params: unknown[] = []) => (db.query(sql).get(...params as SQLQueryBindings[]) ?? undefined) as T | undefined,
    exec: async (sql) => { db.exec(sql); },
  };
  return { adapter: new SqliteAdapter(client), db, arm: () => { armed = true; } };
}

// Only child processes created by this runner may open its newly created DB.
if (process.argv[2] === '--crash-child') {
  const [directory, fault] = process.argv.slice(3);
  assert(['before-commit', 'after-ack', 'write-error'].includes(fault));
  assert.equal(readFileSync(join(directory, 'synthetic-only'), 'utf8'), 'mindwtr-reliability-v1');
  const connection = open(join(directory, 'crash.sqlite'), fault as Fault);
  const data = await connection.adapter.getData();
  connection.arm();
  const changed = { ...data, tasks: data.tasks.map(task => ({ ...task, title: 'Synthetic committed batch', rev: (task.rev ?? 0) + 1 })) };
  if (fault === 'write-error') {
    await assert.rejects(connection.adapter.saveData(changed), /Injected SQLITE_FULL/);
    connection.db.close();
  } else {
    await connection.adapter.saveData(changed);
    if (fault === 'after-ack') process.kill(process.pid, 'SIGKILL');
    throw new Error('Crash checkpoint was not reached');
  }
} else {
  const root = resolve(import.meta.dir, '../..');
  const output = resolve(process.env.RELIABILITY_OUT_DIR ?? join(root, 'build/reliability'));
  const rounds = Number(process.env.ROUNDS ?? 20);
  const size = Number(process.env.SIZE ?? 100);
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10000, 'ROUNDS must be 1..10000');
  assert(Number.isInteger(size) && size >= 4 && size <= 50000, 'SIZE must be 4..50000');
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, 'synthetic-'));
  writeFileSync(join(directory, 'synthetic-only'), 'mindwtr-reliability-v1');
  const seed = fixture(size);
  const report: Record<string, unknown> = {
    schemaVersion: 1, status: 'running',
    metadata: {
      scenario: 'sqlite-restart-sync-v1', dataset: seed.id, rounds, runtime: `bun-${Bun.version}`,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
      capturedAt: new Date().toISOString(), journalMode: 'WAL', synchronous: 'FULL', transport: 'synthetic-local-file',
    },
    warnings: ['Process SIGKILL is not hardware power loss. SQLITE_FULL is an injected client error, not a full disk.',
      'Sync uses the production cycle with synthetic file IO, not the native scheduler or a cloud backend.',
      'Connections reopen between peer cycles. Native queue replay, old-version upgrades and attachment recovery require separate device tests.'],
  };
  const saveReport = () => writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  try {
    const crashes = [];
    for (const fault of ['before-commit', 'write-error', 'after-ack'] as const) {
      const initial = open(join(directory, 'crash.sqlite'));
      await initial.adapter.getData();
      await initial.adapter.saveData(seed.data as AppData);
      initial.db.close();
      const child = Bun.spawnSync({ cmd: [process.execPath, import.meta.path, '--crash-child', directory, fault], stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
      if (fault === 'write-error') assert.equal(child.exitCode, 0, child.stderr.toString());
      else assert.equal(child.signalCode, 'SIGKILL', child.stderr.toString());
      const restarted = open(join(directory, 'crash.sqlite'));
      try {
        assert.equal((restarted.db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
        const recovered = await restarted.adapter.getData();
        assert.equal(recovered.tasks.length, size);
        assert.equal(new Set(recovered.tasks.map(task => task.id)).size, size);
        for (const task of recovered.tasks) {
          assert.equal(task.title, fault === 'after-ack' ? 'Synthetic committed batch' : seed.data.tasks.find(item => item.id === task.id)!.title);
        }
        crashes.push({ fault, status: 'passed', rows: size });
      } finally { restarted.db.close(); }
    }
    report.crashes = crashes;
    const stale = open(join(directory, 'crash.sqlite'));
    const fresh = open(join(directory, 'crash.sqlite'));
    try {
      const snapshot = await stale.adapter.getData();
      const latest = await fresh.adapter.getData();
      const task = latest.tasks[0];
      await fresh.adapter.saveTask({ ...task, title: 'Synthetic newer writer', rev: (task.rev ?? 0) + 1 });
      // Row-level revision guards may safely skip stale rows without rejecting
      // the whole snapshot. Test the durable outcome, not an exception policy.
      await stale.adapter.saveData(snapshot);
      assert.equal((await fresh.adapter.getData()).tasks.find(item => item.id === task.id)?.title, 'Synthetic newer writer');
      report.staleSnapshotPreservedNewerWrite = true;
    } finally { stale.db.close(); fresh.db.close(); }
    saveReport();

    const peers = ['a', 'b', 'c'].map(peer => join(directory, `${peer}.sqlite`));
    for (const path of peers) {
      const connection = open(path);
      await connection.adapter.saveData(seed.data as AppData);
      connection.db.close();
    }
    const remotePath = join(directory, 'remote.json');
    writeFileSync(remotePath, seed.payload);
    const expected = new Map<string, string>();
    const samples: Array<Record<string, number>> = [];
    let tick = Date.parse('2026-09-08T12:00:00.000Z');
    let lostAcknowledgements = 0;
    async function cycle(path: string, loseAck = false) {
      const connection = open(path);
      const durations: Record<string, number> = {};
      const time = async <T>(name: string, action: () => T | Promise<T>): Promise<T> => {
        const start = performance.now();
        try { return await action(); } finally { durations[name] = (durations[name] ?? 0) + performance.now() - start; }
      };
      tick += 60_000; // Advance past retry backoff without sleeping or altering production policy.
      try {
        const result = await time('totalMs', () => performSyncCycle({
          readLocal: () => time('sqliteReadMs', () => connection.adapter.getData()),
          readRemote: () => time('remoteReadParseMs', async () => JSON.parse(readFileSync(remotePath, 'utf8')) as AppData),
          writeLocal: data => time('sqliteWriteMs', () => connection.adapter.saveData(data)),
          writeRemote: data => time('remoteSerializeWriteMs', async () => {
            writeFileSync(remotePath, JSON.stringify(data));
            if (loseAck) throw new Error('Synthetic lost remote acknowledgement');
          }),
          now: () => new Date(tick).toISOString(),
        }));
        assert.notEqual(result.status, 'skipped', 'Retry did not make progress');
        assert.equal(result.data.settings.pendingRemoteWriteAt, undefined);
        durations.cycleProcessingMs = Math.max(0, durations.totalMs - ['sqliteReadMs', 'remoteReadParseMs', 'sqliteWriteMs', 'remoteSerializeWriteMs'].reduce((sum, name) => sum + (durations[name] ?? 0), 0));
        samples.push(durations);
      } catch (error) {
        if (!loseAck || !(error instanceof Error) || error.message !== 'Synthetic lost remote acknowledgement') throw error;
        const pending = await connection.adapter.getData();
        assert(pending.settings.pendingRemoteWriteAt, 'Failed upload must remain pending after persistence');
        lostAcknowledgements++;
      } finally { connection.db.close(); }
    }

    // Each round edits separate IDs on disconnected peers, then reconnects in
    // rotating order. Peer c keeps stale live rows until the first exchange.
    for (let round = 0; round < rounds; round++) {
      for (let peer = 0; peer < peers.length; peer++) {
        const connection = open(peers[peer]);
        try {
          const data = await connection.adapter.getData();
          const id = `perf-task-${peer}`;
          const task = data.tasks.find(item => item.id === id)!;
          const title = `Synthetic peer ${peer} round ${round}`;
          expected.set(id, title);
          await connection.adapter.saveTask({ ...task, title, rev: (task.rev ?? 0) + 1, revBy: `synthetic-${peer}`, updatedAt: new Date(tick).toISOString() });
          if (round === 0 && peer === 0) {
            const deleted = data.tasks.find(item => item.id === 'perf-task-3')!;
            await connection.adapter.saveTask({ ...deleted, deletedAt: new Date(tick).toISOString(), updatedAt: new Date(tick).toISOString(), rev: (deleted.rev ?? 0) + 1 });
          }
        } finally { connection.db.close(); }
      }
      for (let offset = 0; offset < peers.length; offset++) {
        const path = peers[(round + offset) % peers.length];
        if (offset === 0) await cycle(path, true);
        await cycle(path);
      }
      for (const path of peers) await cycle(path);
      let convergedEntities: unknown;
      for (const path of peers) {
        const connection = open(path);
        try {
          const data = await connection.adapter.getData();
          assert.equal(data.tasks.length, size);
          assert.equal(new Set(data.tasks.map(task => task.id)).size, size, 'Duplicate task identity');
          for (const [id, title] of expected) assert.equal(data.tasks.find(task => task.id === id)?.title, title, 'Acknowledged edit lost');
          assert(data.tasks.find(task => task.id === 'perf-task-3')?.deletedAt, 'Deleted task resurrected');
          assert.equal(data.settings.pendingRemoteWriteAt, undefined, 'Retry failed to settle');
          const entities = [data.tasks, data.projects, data.sections, data.areas, data.people ?? []]
            .map(items => [...items].sort((a, b) => a.id.localeCompare(b.id)));
          if (convergedEntities) assert.deepEqual(entities, convergedEntities, 'Peers did not converge across all entity fields');
          else convergedEntities = entities;
        } finally { connection.db.close(); }
      }
    }
    report.status = 'passed';
    report.lostAcknowledgements = lostAcknowledgements;
    report.samples = samples;
    report.metrics = Object.fromEntries(Object.keys(samples[0]).map(name => [name, summarize(samples.map(sample => sample[name]))]));
    saveReport();
    console.log(`Recovery and sync report: ${join(directory, 'report.json')}`);
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack : String(error);
    saveReport();
    console.error(`Failure retained at ${directory}`);
    throw error;
  }
}
