import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';

const [dataDir, displacedDataDir, key, readyPath, resultPath] = process.argv.slice(2);
if (!dataDir || !displacedDataDir || !key || !readyPath || !resultPath) {
    throw new Error('Expected dataDir, displacedDataDir, key, readyPath, and resultPath');
}

const lockId = createHash('sha256').update(key).digest('hex');
const shard = Number.parseInt(lockId.slice(0, 8), 16) % 64;
const lockPath = join(dataDir, '.locks', `shard-${shard.toString(16).padStart(2, '0')}.sqlite`);
const deadline = Date.now() + 15_000;
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
});

writeFileSync(readyPath, 'ready');

while (Date.now() < deadline) {
    if (!existsSync(lockPath)) {
        await sleep(1);
        continue;
    }

    let lockedByServer = false;
    const candidate = new Database(lockPath);
    try {
        candidate.exec('PRAGMA busy_timeout = 0;');
        candidate.exec('BEGIN IMMEDIATE;');
        candidate.exec('ROLLBACK;');
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code ?? '')
            : '';
        lockedByServer = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
        if (!lockedByServer) throw error;
    } finally {
        candidate.close();
    }

    if (!lockedByServer) {
        await sleep(1);
        continue;
    }

    let staged = false;
    const stageDeadline = Date.now() + 100;
    while (Date.now() < stageDeadline) {
        staged = readdirSync(dataDir).some((name) => name.startsWith('.mindwtr-data-'));
        if (staged) break;
        await sleep(1);
    }

    renameSync(dataDir, displacedDataDir);
    mkdirSync(dataDir, { mode: 0o700 });
    writeFileSync(join(dataDir, 'replacement-sentinel'), 'keep');
    writeFileSync(resultPath, staged ? 'stage-observed' : 'stage-not-observed');
    process.exit(0);
}

throw new Error('Timed out waiting for the Cloud namespace write lock');
