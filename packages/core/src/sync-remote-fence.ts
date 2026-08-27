export const SYNC_REMOTE_MUTATION_FENCE_NAME = '.mindwtr-sync-fence-v1.json';

export type SyncRemoteMutationFencePurpose = 'ordinary-sync' | 'encryption-transition';

export type SyncRemoteMutationFenceSnapshot = {
    bytes: Uint8Array | null;
    version: string | null;
    /** Provider/server time from the response's HTTP Date header. Client wall clocks are not
     * trusted for expiry because skew could otherwise make a crashed lease permanent. */
    serverNowMs: number | null;
};

export type SyncRemoteMutationFencePort = {
    read(): Promise<SyncRemoteMutationFenceSnapshot>;
    /** `null` is create-only; a version replaces exactly that observed generation. */
    write(bytes: Uint8Array, expectedVersion: string | null): Promise<void>;
    remove(expectedVersion: string): Promise<void>;
    isConflict(error: unknown): boolean;
};

export type SyncRemoteMutationFenceLease = {
    /** Revalidates ownership and renews when less than `minRemainingMs` remains. */
    assertHeld(minRemainingMs?: number): Promise<void>;
    renew(): Promise<void>;
    /** Conditional and peer-safe. A failed release leaves only a bounded, expiring lease. */
    release(): Promise<void>;
};

type SyncRemoteMutationFenceRecord = {
    schema: 1;
    leaseId: string;
    ownerId: string;
    purpose: SyncRemoteMutationFencePurpose;
    expiresAt: number;
};

export class SyncRemoteMutationFenceBusyError extends Error {
    readonly retryAfterMs: number;

    constructor(retryAfterMs: number) {
        super('Remote sync is temporarily reserved by another compatible client');
        this.name = 'SyncRemoteMutationFenceBusyError';
        this.retryAfterMs = Math.max(0, Math.floor(retryAfterMs));
    }
}

export class SyncRemoteMutationFenceLostError extends Error {
    constructor(message = 'Remote sync mutation fence ownership was lost') {
        super(message);
        this.name = 'SyncRemoteMutationFenceLostError';
    }
}

export class SyncRemoteMutationFenceUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SyncRemoteMutationFenceUnavailableError';
    }
}

export const isSyncRemoteMutationFenceError = (error: unknown): boolean => (
    error instanceof SyncRemoteMutationFenceBusyError
    || error instanceof SyncRemoteMutationFenceLostError
    || error instanceof SyncRemoteMutationFenceUnavailableError
);

const FENCE_SCHEMA = 1;
const MIN_TTL_MS = 10_000;
const MAX_TTL_MS = 15 * 60_000;
const MAX_RECORD_BYTES = 4_096;
const DEFAULT_ACQUIRE_ATTEMPTS = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const requireServerNow = (snapshot: SyncRemoteMutationFenceSnapshot): number => {
    if (snapshot.serverNowMs === null || !Number.isFinite(snapshot.serverNowMs)) {
        throw new SyncRemoteMutationFenceUnavailableError(
            'Remote sync mutation fencing requires a valid provider Date response header',
        );
    }
    return snapshot.serverNowMs;
};

const parseRecord = (bytes: Uint8Array): SyncRemoteMutationFenceRecord => {
    if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) {
        throw new SyncRemoteMutationFenceUnavailableError('Remote sync mutation fence record is malformed');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(decoder.decode(bytes));
    } catch {
        throw new SyncRemoteMutationFenceUnavailableError('Remote sync mutation fence record is malformed');
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new SyncRemoteMutationFenceUnavailableError('Remote sync mutation fence record is malformed');
    }
    const record = parsed as Partial<SyncRemoteMutationFenceRecord>;
    if (
        record.schema !== FENCE_SCHEMA
        || typeof record.leaseId !== 'string'
        || record.leaseId.length < 8
        || typeof record.ownerId !== 'string'
        || record.ownerId.length < 1
        || (record.purpose !== 'ordinary-sync' && record.purpose !== 'encryption-transition')
        || typeof record.expiresAt !== 'number'
        || !Number.isFinite(record.expiresAt)
    ) {
        throw new SyncRemoteMutationFenceUnavailableError('Remote sync mutation fence record is malformed');
    }
    return record as SyncRemoteMutationFenceRecord;
};

const encodeRecord = (record: SyncRemoteMutationFenceRecord): Uint8Array => encoder.encode(JSON.stringify(record));

const randomLeaseId = (): string => {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) return randomUuid;
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
};

type AcquireSyncRemoteMutationFenceOptions = {
    ownerId: string;
    purpose: SyncRemoteMutationFencePurpose;
    ttlMs?: number;
    heartbeatMs?: number;
    maxAttempts?: number;
    leaseId?: string;
};

/**
 * Acquires the one remote mutation lease shared by ordinary sync and encryption transitions.
 * Every mutation-capable compatible client must honor this record; a marker cannot constrain
 * legacy clients that never read it, so artifact CAS/final inventory checks remain required.
 */
export async function acquireSyncRemoteMutationFence(
    port: SyncRemoteMutationFencePort,
    options: AcquireSyncRemoteMutationFenceOptions,
): Promise<SyncRemoteMutationFenceLease> {
    const ownerId = options.ownerId.trim();
    if (!ownerId) throw new Error('Remote sync mutation fence ownerId is required');
    const ttlMs = options.ttlMs ?? 5 * 60_000;
    if (!Number.isFinite(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
        throw new Error(`Remote sync mutation fence ttlMs must be between ${MIN_TTL_MS} and ${MAX_TTL_MS}`);
    }
    const heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(ttlMs / 3));
    if (!Number.isFinite(heartbeatMs) || heartbeatMs < 0 || heartbeatMs >= ttlMs) {
        throw new Error('Remote sync mutation fence heartbeatMs must be zero or shorter than ttlMs');
    }
    const maxAttempts = options.maxAttempts ?? DEFAULT_ACQUIRE_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        throw new Error('Remote sync mutation fence maxAttempts must be between 1 and 20');
    }
    const leaseId = options.leaseId ?? randomLeaseId();
    if (leaseId.length < 8) throw new Error('Remote sync mutation fence leaseId is too short');

    let acquiredVersion: string | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const snapshot = await port.read();
        const serverNowMs = requireServerNow(snapshot);
        if (snapshot.bytes) {
            if (!snapshot.version) {
                throw new SyncRemoteMutationFenceUnavailableError(
                    'Existing remote sync mutation fence has no safe version',
                );
            }
            const current = parseRecord(snapshot.bytes);
            if (current.expiresAt > serverNowMs) {
                throw new SyncRemoteMutationFenceBusyError(current.expiresAt - serverNowMs);
            }
        } else if (snapshot.version !== null) {
            throw new SyncRemoteMutationFenceUnavailableError(
                'Missing remote sync mutation fence unexpectedly has a version',
            );
        }

        const record: SyncRemoteMutationFenceRecord = {
            schema: FENCE_SCHEMA,
            leaseId,
            ownerId,
            purpose: options.purpose,
            expiresAt: serverNowMs + ttlMs,
        };
        try {
            await port.write(encodeRecord(record), snapshot.version);
        } catch (error) {
            if (port.isConflict(error)) continue;
            throw error;
        }
        const verified = await port.read();
        requireServerNow(verified);
        if (!verified.bytes || !verified.version) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence disappeared after acquisition');
        }
        const verifiedRecord = parseRecord(verified.bytes);
        if (verifiedRecord.leaseId !== leaseId || verifiedRecord.ownerId !== ownerId) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence was replaced during acquisition');
        }
        acquiredVersion = verified.version;
        break;
    }
    if (!acquiredVersion) {
        throw new SyncRemoteMutationFenceBusyError(0);
    }

    let currentVersion = acquiredVersion;
    let closed = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let lostError: unknown = null;
    let operationQueue: Promise<unknown> = Promise.resolve();

    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = operationQueue.then(operation, operation);
        operationQueue = next.catch(() => undefined);
        return next;
    };

    const requireOwnedSnapshot = async (): Promise<{
        snapshot: SyncRemoteMutationFenceSnapshot;
        record: SyncRemoteMutationFenceRecord;
        serverNowMs: number;
    }> => {
        if (closed) throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence is already released');
        if (lostError) throw lostError;
        const snapshot = await port.read();
        const serverNowMs = requireServerNow(snapshot);
        if (!snapshot.bytes || !snapshot.version) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence disappeared');
        }
        const record = parseRecord(snapshot.bytes);
        if (record.leaseId !== leaseId || record.ownerId !== ownerId) {
            throw new SyncRemoteMutationFenceLostError();
        }
        if (record.expiresAt <= serverNowMs) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence expired');
        }
        currentVersion = snapshot.version;
        return { snapshot, record, serverNowMs };
    };

    const renewOwned = async (): Promise<void> => {
        const { snapshot, serverNowMs } = await requireOwnedSnapshot();
        const replacement: SyncRemoteMutationFenceRecord = {
            schema: FENCE_SCHEMA,
            leaseId,
            ownerId,
            purpose: options.purpose,
            expiresAt: serverNowMs + ttlMs,
        };
        try {
            await port.write(encodeRecord(replacement), snapshot.version);
        } catch (error) {
            if (port.isConflict(error)) throw new SyncRemoteMutationFenceLostError();
            throw error;
        }
        const verified = await port.read();
        requireServerNow(verified);
        if (!verified.bytes || !verified.version) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence disappeared after renewal');
        }
        const verifiedRecord = parseRecord(verified.bytes);
        if (verifiedRecord.leaseId !== leaseId || verifiedRecord.ownerId !== ownerId) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence was replaced during renewal');
        }
        currentVersion = verified.version;
    };

    const scheduleHeartbeat = (): void => {
        if (closed || heartbeatMs === 0 || lostError) return;
        heartbeatTimer = setTimeout(() => {
            void serialize(renewOwned).then(
                () => scheduleHeartbeat(),
                (error) => {
                    lostError = error;
                },
            );
        }, heartbeatMs);
        const timer = heartbeatTimer as unknown as { unref?: () => void };
        timer.unref?.();
    };
    scheduleHeartbeat();

    return {
        assertHeld: (minRemainingMs = 0) => serialize(async () => {
            if (!Number.isFinite(minRemainingMs) || minRemainingMs < 0 || minRemainingMs >= ttlMs) {
                throw new Error('Remote sync mutation fence remaining-time requirement is invalid');
            }
            const { record, serverNowMs } = await requireOwnedSnapshot();
            if (record.expiresAt - serverNowMs <= minRemainingMs) await renewOwned();
        }),
        renew: () => serialize(renewOwned),
        release: () => serialize(async () => {
            if (closed) return;
            if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
            heartbeatTimer = null;
            const snapshot = await port.read();
            requireServerNow(snapshot);
            if (!snapshot.bytes) {
                closed = true;
                return;
            }
            if (!snapshot.version) {
                throw new SyncRemoteMutationFenceUnavailableError(
                    'Existing remote sync mutation fence has no safe version',
                );
            }
            const record = parseRecord(snapshot.bytes);
            if (record.leaseId !== leaseId || record.ownerId !== ownerId) {
                throw new SyncRemoteMutationFenceLostError('Refusing to release a peer remote sync mutation fence');
            }
            try {
                await port.remove(snapshot.version ?? currentVersion);
            } catch (error) {
                if (port.isConflict(error)) {
                    throw new SyncRemoteMutationFenceLostError(
                        'Refusing to release a changed remote sync mutation fence',
                    );
                }
                throw error;
            }
            closed = true;
        }),
    };
}
