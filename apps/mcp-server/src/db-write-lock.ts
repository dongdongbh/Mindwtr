const MCP_WRITE_LOCK_WAIT_TIMEOUT_MS = 15_000;

type LockDatabase = {
  exec: (sql: string) => void;
  close: () => void;
};

const isBun = () => typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

const openLockDatabase = async (path: string): Promise<LockDatabase> => {
  if (isBun()) {
    const { Database } = await import('bun:sqlite');
    return new Database(path);
  }

  const { default: Database } = await import('better-sqlite3');
  return new Database(path);
};

const isSqliteBusyError = (error: unknown): boolean => {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || /database is (?:busy|locked)/i.test(message);
};

const waitForRetry = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

export const getMcpWriteLockPath = (dbPath: string): string => `${dbPath}.mcp-write-lock.sqlite`;


export async function withMcpWriteLock<T>(dbPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = getMcpWriteLockPath(dbPath);
  const startedAt = Date.now();
  let attempt = 0;
  let lockDatabase: LockDatabase | null = null;

  while (true) {
    const candidate = await openLockDatabase(lockPath);
    try {
      candidate.exec('PRAGMA busy_timeout = 0;');
      candidate.exec('BEGIN IMMEDIATE;');
      lockDatabase = candidate;
      break;
    } catch (error) {
      candidate.close();
      if (!isSqliteBusyError(error)) throw error;
      if (Date.now() - startedAt > MCP_WRITE_LOCK_WAIT_TIMEOUT_MS) {
        throw new Error('Timed out waiting for the Mindwtr MCP database write lock', { cause: error });
      }
      attempt += 1;
      await waitForRetry(Math.min(250, 10 * attempt));
    }
  }

  try {
    return await operation();
  } finally {
    try {
      lockDatabase.exec('ROLLBACK;');
    } catch {

    } finally {
      lockDatabase.close();
    }
  }
}
