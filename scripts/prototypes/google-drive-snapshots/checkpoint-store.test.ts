import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { AppData } from '../../../packages/core/src/types';
import type { Checkpoint } from './incremental';
import type { Snapshot } from './model';
import { createSqliteCheckpointStore } from './checkpoint-store';

const ARTIFACT_ROOT = join(homedir(), 'build-artifacts');
const NAMESPACE = 'checkpoint-store-test';
const temporaryDirectories: string[] = [];

const data = (): AppData => ({
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  settings: {},
});

const snapshot = (id = 'root', namespace = NAMESPACE): Snapshot => ({
  format: 'mindwtr-drive-snapshot-prototype',
  version: 1,
  id,
  namespace,
  parents: [],
  data: data(),
});

const checkpoint = (
  revision: number,
  cursor = `cursor-${revision}`,
  namespace = NAMESPACE,
): Checkpoint => ({
  version: 1,
  revision,
  namespace,
  cursor,
  snapshots: [snapshot('root', namespace)],
});

const createPath = async (): Promise<string> => {
  await mkdir(ARTIFACT_ROOT, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(ARTIFACT_ROOT, 'checkpoint-store-'));
  temporaryDirectories.push(directory);
  return join(directory, 'checkpoint.sqlite');
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('SQLite checkpoint store', () => {
  test('starts empty and creates a private database file', async () => {
    const path = await createPath();
    const store = createSqliteCheckpointStore(path, NAMESPACE);

    expect(await store.load()).toBeNull();
    store.close();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('durably reloads the whole checkpoint after reopening', async () => {
    const path = await createPath();
    const original = checkpoint(1);
    const first = createSqliteCheckpointStore(path, NAMESPACE);
    await first.save(original, null);
    first.close();

    const reopened = createSqliteCheckpointStore(path, NAMESPACE);
    expect(await reopened.load()).toEqual(original);
    reopened.close();
  });

  test('uses revision CAS across instances even when the cursor is unchanged', async () => {
    const path = await createPath();
    const first = createSqliteCheckpointStore(path, NAMESPACE);
    const second = createSqliteCheckpointStore(path, NAMESPACE);
    const initial = checkpoint(1, 'same-cursor');
    await first.save(initial, null);

    await expect(second.save(checkpoint(1, 'same-cursor'), null)).rejects.toThrow(/stale/i);
    expect(await second.load()).toEqual(initial);

    const winner = { ...checkpoint(2, 'same-cursor'), snapshots: [snapshot('winner')] };
    const loser = { ...checkpoint(2, 'same-cursor'), snapshots: [snapshot('loser')] };
    await first.save(winner, 1);
    await expect(second.save(loser, 1)).rejects.toThrow(/stale/i);
    expect(await second.load()).toEqual(winner);

    first.close();
    second.close();
  });

  test('rejects invalid next revisions without changing the durable row', async () => {
    const path = await createPath();
    const store = createSqliteCheckpointStore(path, NAMESPACE);
    const original = checkpoint(1);
    await store.save(original, null);

    await expect(store.save(checkpoint(3), 1)).rejects.toThrow(/revision/i);
    expect(await store.load()).toEqual(original);
    store.close();
  });

  test('rolls back an SQLite write failure and keeps the prior checkpoint', async () => {
    const path = await createPath();
    const original = checkpoint(1);
    const setup = createSqliteCheckpointStore(path, NAMESPACE);
    await setup.save(original, null);
    setup.close();

    const injector = new Database(path);
    injector.exec(`
      CREATE TRIGGER reject_checkpoint_update
      BEFORE UPDATE ON checkpoint_state
      BEGIN
        SELECT RAISE(ABORT, 'injected checkpoint write failure');
      END
    `);
    injector.close();

    const store = createSqliteCheckpointStore(path, NAMESPACE);
    await expect(store.save(checkpoint(2), 1)).rejects.toThrow(/injected checkpoint write failure/i);
    expect(await store.load()).toEqual(original);
    store.close();
  });

  test('fails closed when a database is opened for a different namespace', async () => {
    const path = await createPath();
    const first = createSqliteCheckpointStore(path, NAMESPACE);
    await first.save(checkpoint(1), null);
    first.close();

    const wrongNamespace = createSqliteCheckpointStore(path, 'another-namespace');
    await expect(wrongNamespace.load()).rejects.toThrow(/namespace/i);
    await expect(
      wrongNamespace.save(checkpoint(1, 'cursor', 'another-namespace'), null),
    ).rejects.toThrow(/namespace/i);
    wrongNamespace.close();
  });

  test('rejects malformed stored JSON without resetting or overwriting it', async () => {
    const path = await createPath();
    const store = createSqliteCheckpointStore(path, NAMESPACE);
    await store.save(checkpoint(1), null);
    store.close();

    const corruptor = new Database(path);
    corruptor.query('UPDATE checkpoint_state SET checkpoint_json = ? WHERE singleton = 1').run('{not-json');
    corruptor.close();

    const reopened = createSqliteCheckpointStore(path, NAMESPACE);
    await expect(reopened.load()).rejects.toThrow(/corrupt|json/i);
    await expect(reopened.save(checkpoint(2), 1)).rejects.toThrow(/corrupt|json/i);
    reopened.close();

    const inspector = new Database(path, { readonly: true });
    const row = inspector.query(
      'SELECT checkpoint_json AS checkpointJson FROM checkpoint_state WHERE singleton = 1',
    ).get() as { checkpointJson: string };
    expect(row.checkpointJson).toBe('{not-json');
    inspector.close();
  });

  test('fails closed on a corrupt SQLite file and preserves its bytes', async () => {
    const path = await createPath();
    const corruptBytes = new TextEncoder().encode('not a sqlite database');
    await writeFile(path, corruptBytes, { mode: 0o600 });

    expect(() => createSqliteCheckpointStore(path, NAMESPACE)).toThrow();
    expect(await readFile(path)).toEqual(Buffer.from(corruptBytes));
  });

  test('validates checkpoint identity, cursor, snapshot shape, and history cap', async () => {
    const path = await createPath();
    const store = createSqliteCheckpointStore(path, NAMESPACE);

    await expect(store.save({ ...checkpoint(1), cursor: '' }, null)).rejects.toThrow(/cursor/i);
    await expect(store.save({ ...checkpoint(1), version: 2 } as unknown as Checkpoint, null))
      .rejects.toThrow(/version/i);
    await expect(store.save({ ...checkpoint(1), snapshots: [{} as Snapshot] }, null))
      .rejects.toThrow(/snapshot/i);
    const nonJson = checkpoint(1);
    (nonJson.snapshots[0]!.data as AppData & { omitted: undefined }).omitted = undefined;
    await expect(store.save(nonJson, null)).rejects.toThrow(/non-json/i);
    await expect(store.save({
      ...checkpoint(1),
      snapshots: Array.from({ length: 129 }, (_, index) => snapshot(`snapshot-${index}`)),
    }, null)).rejects.toThrow(/128|history/i);
    expect(await store.load()).toBeNull();
    store.close();
  });

  test('rejects checkpoints larger than 64 MiB before writing', async () => {
    const path = await createPath();
    const store = createSqliteCheckpointStore(path, NAMESPACE);
    const oversized = checkpoint(1);
    (oversized.snapshots[0]!.data as AppData & { padding: string }).padding = 'x'.repeat(64 * 1024 * 1024);

    await expect(store.save(oversized, null)).rejects.toThrow(/64 mib|size/i);
    expect(await store.load()).toBeNull();
    store.close();
  });

  test('rejects relative and directory paths', async () => {
    expect(() => createSqliteCheckpointStore('checkpoint.sqlite', NAMESPACE)).toThrow(/absolute|path/i);

    const unusedPath = await createPath();
    const directory = join(dirname(unusedPath), 'directory-target');
    await mkdir(directory, { mode: 0o700 });
    expect(() => createSqliteCheckpointStore(directory, NAMESPACE)).toThrow(/file|path/i);
  });

  test('rejects non-private existing files and parent directories', async () => {
    const insecureFile = await createPath();
    await writeFile(insecureFile, new Uint8Array(), { mode: 0o600 });
    await chmod(insecureFile, 0o644);
    expect(() => createSqliteCheckpointStore(insecureFile, NAMESPACE)).toThrow(/0600|mode/i);

    const privatePath = await createPath();
    const parent = dirname(privatePath);
    await chmod(parent, 0o755);
    expect(() => createSqliteCheckpointStore(privatePath, NAMESPACE)).toThrow(/private/i);
  });
});
