/** Durable, namespace-scoped checkpoint storage for the discovery prototype. */
import { Database } from 'bun:sqlite';
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, normalize, parse } from 'node:path';
import type { Checkpoint, CheckpointStore } from './incremental';

const MAX_SNAPSHOTS = 128;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const CHECKPOINT_KEYS = ['cursor', 'namespace', 'revision', 'snapshots', 'version'] as const;
const SNAPSHOT_KEYS = ['data', 'format', 'id', 'namespace', 'parents', 'version'] as const;

type StoredRow = {
  revision: unknown;
  namespace: unknown;
  checkpointJson: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`checkpoint store: ${message}`);
}

const assertExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected fields`);
  }
};

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
}

const assertJsonValue = (value: unknown, ancestors = new WeakSet<object>()): void => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('checkpoint contains a non-finite number');
    return;
  }
  if (typeof value !== 'object') fail('checkpoint contains a non-JSON value');
  if (ancestors.has(value)) fail('checkpoint contains a circular value');

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('checkpoint contains a non-JSON object');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail('checkpoint contains symbol fields');
    }
    for (const item of Object.values(value)) assertJsonValue(item, ancestors);
  }
  ancestors.delete(value);
};

const validateCheckpoint = (value: unknown, namespace: string): Checkpoint => {
  if (!isRecord(value)) fail('checkpoint must be an object');
  assertExactKeys(value, CHECKPOINT_KEYS, 'checkpoint');
  if (value.version !== 1) fail('checkpoint version must be 1');
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    fail('checkpoint revision must be a positive safe integer');
  }
  assertNonEmptyString(value.namespace, 'checkpoint namespace');
  if (value.namespace !== namespace) fail('checkpoint namespace mismatch');
  assertNonEmptyString(value.cursor, 'checkpoint cursor');
  if (!Array.isArray(value.snapshots)) fail('checkpoint snapshots must be an array');
  if (value.snapshots.length > MAX_SNAPSHOTS) fail('checkpoint history exceeds 128 snapshots');

  for (const [index, candidate] of value.snapshots.entries()) {
    if (!isRecord(candidate)) fail(`snapshot ${index} must be an object`);
    assertExactKeys(candidate, SNAPSHOT_KEYS, `snapshot ${index}`);
    if (candidate.format !== 'mindwtr-drive-snapshot-prototype' || candidate.version !== 1) {
      fail(`snapshot ${index} has an unsupported format or version`);
    }
    assertNonEmptyString(candidate.id, `snapshot ${index} id`);
    if (candidate.namespace !== namespace) fail(`snapshot ${index} namespace mismatch`);
    if (!Array.isArray(candidate.parents)
      || candidate.parents.some((parent) => typeof parent !== 'string' || parent.length === 0)) {
      fail(`snapshot ${index} parents must be an array of non-empty strings`);
    }
    if (!isRecord(candidate.data)) fail(`snapshot ${index} data must be an object`);
  }

  assertJsonValue(value);
  return value as Checkpoint;
};

const serializeCheckpoint = (value: unknown, namespace: string): string => {
  validateCheckpoint(value, namespace);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return fail('checkpoint cannot be serialized as JSON');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_CHECKPOINT_BYTES) {
    fail('serialized checkpoint exceeds 64 MiB size limit');
  }
  return json;
};

const parseCheckpoint = (json: unknown, namespace: string): Checkpoint => {
  if (typeof json !== 'string') fail('corrupt checkpoint JSON storage');
  if (Buffer.byteLength(json, 'utf8') > MAX_CHECKPOINT_BYTES) {
    fail('stored checkpoint exceeds 64 MiB size limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail('corrupt checkpoint JSON');
  }
  return validateCheckpoint(parsed, namespace);
};

const validatePath = (path: string): void => {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
    fail('database path must be an absolute file path');
  }
  if (normalize(path) !== path || parse(path).root === path) fail('invalid database file path');

  const parent = statSync(dirname(path));
  if (!parent.isDirectory()) fail('database parent path must be a directory');
  if ((parent.mode & 0o077) !== 0) fail('database parent directory must be private');
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) fail('database path must name a regular file');
    if ((existing.mode & 0o777) !== 0o600) fail('existing database file mode must be 0600');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const ensurePrivateFile = (path: string): void => {
  try {
    const descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    closeSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) fail('database path must name a regular file');
    if ((existing.mode & 0o777) !== 0o600) fail('existing database file mode must be 0600');
  }
};

const decodeRow = (row: StoredRow, namespace: string): Checkpoint => {
  if (row.namespace !== namespace) fail('stored checkpoint namespace mismatch');
  const checkpoint = parseCheckpoint(row.checkpointJson, namespace);
  if (!Number.isSafeInteger(row.revision) || row.revision !== checkpoint.revision) {
    fail('corrupt checkpoint revision metadata');
  }
  return checkpoint;
};

export function createSqliteCheckpointStore(
  path: string,
  namespace: string,
): CheckpointStore & { close(): void } {
  assertNonEmptyString(namespace, 'namespace');
  validatePath(path);
  ensurePrivateFile(path);

  const database = new Database(path, { strict: true });
  const initialize = (): CheckpointStore & { close(): void } => {
    database.exec('PRAGMA journal_mode = DELETE');
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec(`
      CREATE TABLE IF NOT EXISTS checkpoint_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        namespace TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL
      )
    `);

    const select = database.query(`
      SELECT revision, namespace, checkpoint_json AS checkpointJson
      FROM checkpoint_state
      WHERE singleton = 1
    `);
    const insert = database.query(`
      INSERT INTO checkpoint_state (singleton, revision, namespace, checkpoint_json)
      VALUES (1, ?, ?, ?)
    `);
    const update = database.query(`
      UPDATE checkpoint_state
      SET revision = ?, namespace = ?, checkpoint_json = ?
      WHERE singleton = 1 AND revision = ? AND namespace = ?
    `);
    let closed = false;

    const assertOpen = (): void => {
      if (closed) fail('store is closed');
    };

    return {
      async load(): Promise<Checkpoint | null> {
        assertOpen();
        const row = select.get() as StoredRow | null;
        return row === null ? null : decodeRow(row, namespace);
      },

      async save(next: Checkpoint, expectedRevision: number | null): Promise<void> {
        assertOpen();
        if (expectedRevision !== null
          && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
          fail('expected revision must be null or a positive safe integer');
        }
        const requiredRevision = (expectedRevision ?? 0) + 1;
        if (next?.revision !== requiredRevision) {
          fail('next revision must immediately follow the expected revision');
        }
        const json = serializeCheckpoint(next, namespace);

        let inTransaction = false;
        try {
          database.exec('BEGIN IMMEDIATE');
          inTransaction = true;
          const row = select.get() as StoredRow | null;
          if (row === null) {
            if (expectedRevision !== null) fail('stale checkpoint revision');
            insert.run(next.revision, namespace, json);
          } else {
            const stored = decodeRow(row, namespace);
            if (expectedRevision === null || stored.revision !== expectedRevision) {
              fail('stale checkpoint revision');
            }
            const result = update.run(next.revision, namespace, json, expectedRevision, namespace);
            if (result.changes !== 1) fail('stale checkpoint revision');
          }
          database.exec('COMMIT');
          inTransaction = false;
        } catch (error) {
          if (inTransaction) {
            try {
              database.exec('ROLLBACK');
            } catch {
              closed = true;
              try {
                database.close();
              } catch {
                // Preserve the original transaction failure.
              }
            }
          }
          throw error;
        }
      },

      close(): void {
        if (closed) return;
        closed = true;
        database.close();
      },
    };
  };

  try {
    return initialize();
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the initialization failure.
    }
    throw error;
  }
}
