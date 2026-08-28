import { SqliteAdapter, type AppData, type SqliteClient } from '@mindwtr/core';
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync } from 'fs';

const [dbPath, readyPath, releasePath, outcomePath] = process.argv.slice(2);
if (!dbPath || !readyPath || !releasePath || !outcomePath) {
  throw new Error('Usage: mcp-guarded-write-worker <db-path> <ready-path> <release-path> <outcome-path>');
}

const db = new Database(dbPath);
const client: SqliteClient = {
  run: async (sql, params = []) => { db.prepare(sql).run(params); },
  all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(params) as T[],
  get: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(params) as T | undefined,
  exec: async (sql) => { db.exec(sql); },
};
const adapter = new SqliteAdapter(client, { rejectConcurrentWrites: true });

try {
  await adapter.ensureSchema();
  const snapshot = await adapter.getData();
  writeFileSync(readyPath, 'loaded');
  while (!existsSync(releasePath)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const now = '2026-08-26T12:00:00.000Z';
  const next: AppData = {
    ...snapshot,
    projects: [{
      id: 'project-mcp',
      title: 'MCP project',
      status: 'active',
      color: '#2563EB',
      order: 0,
      tagIds: [],
      createdAt: now,
      updatedAt: now,
      rev: 1,
      revBy: 'mcp',
    }],
  };
  await adapter.saveData(next);
  writeFileSync(outcomePath, 'saved');
} catch (error) {
  writeFileSync(outcomePath, error instanceof Error ? error.message : String(error));
} finally {
  db.close();
}
