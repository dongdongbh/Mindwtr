import { createHash } from 'node:crypto';
import { SqliteAdapter, type AppData, type Task } from '@mindwtr/core';
import type { SqliteClient } from '../packages/core/src/sqlite-adapter';
import { taskFromSqliteRow } from '../packages/core/src/task-sync-schema';
import { normalizeTaskForLoad, TASK_STATUS_VALUES } from '../packages/core/src/task-status';

export const HELPER_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const HELPER_RECEIPT_CAPACITY = 10_000;

const canonicalValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([name, field]) => [name, canonicalValue(field)]));
    }
    return value;
};
export const helperDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
export const helperTaskVersion = (task: Task): string => `sha256-${helperDigest(task)}`;
export const helperTaskResponse = (task: Task) => ({ version: helperTaskVersion(task), task });
export const helperTaskListResponse = (tasks: Task[]) => ({
    tasks, versions: Object.fromEntries(tasks.map((task) => [task.id, helperTaskVersion(task)])),
});

type TaskMatchCondition = { kind: 'exists' } | { kind: 'versions'; versions: string[] };
export type HelperTaskWriteControls = { expectedVersion?: string; ifMatch?: never } | { ifMatch: string; expectedVersion?: never };
export type HelperTaskCreateControls = { idempotencyKey?: string; credential?: string };

const validVersion = (version: string): boolean => /^sha256-[0-9a-f]{64}$/.test(version);
export const parseHelperIfMatch = (header: string): TaskMatchCondition => {
    let remaining = header.trim();
    if (remaining === '*') return { kind: 'exists' };
    const versions: string[] = [];
    let parsed = false;
    while (remaining.length > 0) {
        if (remaining.startsWith(',')) {
            remaining = remaining.slice(1).replace(/^[ \t]+/, '');
            continue;
        }
        const match = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"/.exec(remaining);
        if (!match) throw new Error('Invalid If-Match');
        parsed = true;
        if (!match[1]) versions.push(match[2]);
        remaining = remaining.slice(match[0].length).replace(/^[ \t]+/, '');
        if (remaining.length > 0 && !remaining.startsWith(',')) throw new Error('Invalid If-Match');
    }
    if (!parsed) throw new Error('Invalid If-Match');
    return { kind: 'versions', versions };
};
export const ensureHelperTaskVersion = (task: Task | undefined, controls: HelperTaskWriteControls): void => {
    let condition: TaskMatchCondition | undefined;
    if (controls.ifMatch !== undefined) condition = parseHelperIfMatch(controls.ifMatch);
    else if (controls.expectedVersion !== undefined) {
        if (!validVersion(controls.expectedVersion)) throw new Error('Invalid expectedVersion');
        condition = { kind: 'versions', versions: [controls.expectedVersion] };
    }
    if (condition && (!task || task.purgedAt
        || (condition.kind === 'versions' && !condition.versions.includes(helperTaskVersion(task))))) {
        throw new Error('task_version_conflict');
    }
};

export type HelperCreateReceipt = { scope: string; token: string; fingerprint: string; taskId: string };
type PendingCreateReceipt = HelperCreateReceipt & { beforeTaskIds: Set<string> };
type StoredReceipt = { fingerprint: string; task_id: string; reply: string; expires_at: number };
export const validateHelperIdempotencyKey = (value: string): void => {
    if (!/^[\x21-\x7e]{1,128}$/.test(value)) throw new Error('Invalid Idempotency-Key');
};
export const createHelperReceipt = (
    input: unknown, controls: HelperTaskCreateControls, taskId: string,
): HelperCreateReceipt | undefined => {
    if (controls.idempotencyKey === undefined) return undefined;
    validateHelperIdempotencyKey(controls.idempotencyKey);
    return {
        scope: helperDigest({ operation: 'bun-helper-create-task-v1', credential: controls.credential ?? null }),
        token: helperDigest(controls.idempotencyKey), fingerprint: helperDigest(input), taskId,
    };
};

const receiptTask = (receipt: StoredReceipt): Task => {
    const task: unknown = JSON.parse(receipt.reply);
    if (task === null || typeof task !== 'object' || !('id' in task) || task.id !== receipt.task_id
        || !('title' in task) || typeof task.title !== 'string' || !('status' in task) || !TASK_STATUS_VALUES.some((status) => status === task.status)
        || !('createdAt' in task) || typeof task.createdAt !== 'string' || !('updatedAt' in task) || typeof task.updatedAt !== 'string'
        || !('tags' in task) || !Array.isArray(task.tags) || !task.tags.every((item) => typeof item === 'string')
        || !('contexts' in task) || !Array.isArray(task.contexts) || !task.contexts.every((item) => typeof item === 'string')) {
        throw new Error('Stored helper receipt is invalid');
    }
    return task as Task;
};

export class HelperReceiptSqliteAdapter extends SqliteAdapter {
    private pendingReceipt: PendingCreateReceipt | null = null;

    constructor(private readonly receiptClient: SqliteClient) {
        super(receiptClient, { rejectConcurrentWrites: true });
    }

    async initializeReceipts(): Promise<void> {
        await this.receiptClient.run(`CREATE TABLE IF NOT EXISTS automation_create_receipts (
            scope TEXT NOT NULL, token TEXT NOT NULL, fingerprint TEXT NOT NULL,
            task_id TEXT NOT NULL, reply TEXT NOT NULL, expires_at INTEGER NOT NULL,
            PRIMARY KEY (scope, token)
        )`);
    }

    private storedReceipt(receipt: HelperCreateReceipt): Promise<StoredReceipt | undefined> {
        return this.receiptClient.get<StoredReceipt>(
            'SELECT fingerprint, task_id, reply, expires_at FROM automation_create_receipts WHERE scope = ? AND token = ?',
            [receipt.scope, receipt.token],
        );
    }

    async lookupReceipt(receipt: HelperCreateReceipt): Promise<Task | null> {
        const stored = await this.storedReceipt(receipt);
        if (!stored || stored.expires_at <= Date.now()) return null;
        if (stored.fingerprint !== receipt.fingerprint) throw new Error('idempotency_conflict');
        return receiptTask(stored);
    }

    armReceipt(receipt: HelperCreateReceipt, beforeTaskIds: Set<string>): void {
        if (this.pendingReceipt || beforeTaskIds.has(receipt.taskId)) throw new Error('Helper create receipt ownership changed');
        this.pendingReceipt = { ...receipt, beforeTaskIds };
    }

    clearReceipt(): void { this.pendingReceipt = null; }

    protected override async beforeCommit(write: { data: AppData } | { task: Task }): Promise<void> {
        const pending = this.pendingReceipt;
        if (!pending) return;
        const added = 'data' in write
            ? write.data.tasks.filter((task) => !pending.beforeTaskIds.has(task.id)) : [write.task];
        if (added.length === 0) return;
        if (added.length !== 1 || added[0].id !== pending.taskId) throw new Error('Helper create receipt ownership changed');
        const saved = await this.receiptClient.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [pending.taskId]);
        if (!saved) throw new Error('Helper create receipt task is missing');
        const task = normalizeTaskForLoad(taskFromSqliteRow(saved));
        const now = Date.now();
        const existing = await this.storedReceipt(pending);
        if (existing && existing.expires_at > now) {
            if (existing.fingerprint !== pending.fingerprint) throw new Error('idempotency_conflict');
            if (existing.task_id === pending.taskId && helperTaskVersion(receiptTask(existing)) === helperTaskVersion(task)) return;
            throw Object.assign(new Error('Helper create receipt was committed concurrently'), { code: 'SQLITE_BUSY' });
        }
        await this.receiptClient.run('DELETE FROM automation_create_receipts WHERE expires_at <= ?', [now]);
        const count = await this.receiptClient.get<{ count: number }>('SELECT COUNT(*) AS count FROM automation_create_receipts');
        if (!count || count.count >= HELPER_RECEIPT_CAPACITY) throw new Error('idempotency_capacity');
        await this.receiptClient.run(
            'INSERT INTO automation_create_receipts (scope, token, fingerprint, task_id, reply, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
            [pending.scope, pending.token, pending.fingerprint, pending.taskId, JSON.stringify(task), now + HELPER_RECEIPT_RETENTION_MS],
        );
    }
}

export const logHelperReliability = (outcome: 'created' | 'replayed' | 'conditional-write' | 'unchanged'): void => {
    process.stderr.write(`${JSON.stringify({
        ts: new Date().toISOString(), level: 'info', scope: 'automation-storage', message: 'Helper reliability completed',
        context: { releaseCheck: 'v1.3.9/helper-api-reliability', outcome },
    })}\n`);
};
