export const SYNC_REMOTE_MUTATION_FENCE_NAME = '.mindwtr-sync-fence-v1.json';

/** Minimum verified lease lifetime immediately before a provider mutation.
 * It covers the bounded 30-second request plus a small scheduling margin. */
export const SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS = 35_000;


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
    /** Set when acquisition reclaimed a lease whose holder stopped renewing. */
    readonly reclaimedFrom?: SyncRemoteMutationFenceHolder | null;
    /** Revalidates ownership and renews when less than `minRemainingMs` remains. */
    assertHeld(minRemainingMs?: number): Promise<void>;
    renew(): Promise<void>;
    /** Best-effort delay until this lease's last server-observed expiry. Used
     *  only to schedule cleanup after a conditional release request fails. */
    retryAfterMs(): number;
    /** Conditional and peer-safe. A failed release leaves only a bounded, expiring lease. */
    release(): Promise<void>;
};

type SyncRemoteMutationFenceRecord = {
    schema: 1;
    leaseId: string;
    ownerId: string;
    purpose: SyncRemoteMutationFencePurpose;
    expiresAt: number;
    /** Liveness advertisement (absent on records from older clients): the
     * holder's renewal cadence and the server time of its last write. A waiter
     * that sees no renewal for several cadences may reclaim the lease by CAS
     * instead of waiting out `expiresAt`. */
    heartbeatMs?: number;
    renewedAt?: number;
};

export type SyncRemoteMutationFenceHolder = {
    ownerId: string;
    leaseId: string;
    purpose: SyncRemoteMutationFencePurpose;
    /** Server-observed remaining life. A live holder renews at ttl/3, so a few
     * seconds left means the holder died and the lease is about to lapse. */
    remainingMs: number;
};

export class SyncRemoteMutationFenceBusyError extends Error {
    readonly retryAfterMs: number;
    readonly holder: SyncRemoteMutationFenceHolder | null;

    constructor(retryAfterMs: number, holder: SyncRemoteMutationFenceHolder | null = null) {
        super(holder
            ? `Remote sync is temporarily reserved by ${holder.ownerId} (${holder.purpose}, lease ${holder.leaseId}, ${Math.ceil(holder.remainingMs / 1000)}s left)`
            : 'Remote sync is temporarily reserved by another compatible client');
        this.name = 'SyncRemoteMutationFenceBusyError';
        this.retryAfterMs = Math.max(0, Math.floor(retryAfterMs));
        this.holder = holder;
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
/** Provider Date headers can move slightly between frontends. Anything farther
 *  into the future than a legal maximum lease plus this tolerance cannot have
 *  been written by a conforming client and must not permanently block sync. */
const MAX_FUTURE_EXPIRY_TOLERANCE_MS = 60_000;
const MAX_RECORD_BYTES = 4_096;
const DEFAULT_ACQUIRE_ATTEMPTS = 4;
/** Renewal cadence advertised in the record. Decoupled from the TTL so a dead
 * holder is detected by missed heartbeats (seconds), not by lease expiry
 * (minutes); the TTL stays the safety backstop for older clients' records. */
const DEFAULT_HEARTBEAT_MS = 20_000;
const ABANDONED_AFTER_MISSED_HEARTBEATS = 3;
const ABANDONED_JITTER_MARGIN_MS = 5_000;

// Constructed per call, not once at module scope: on React Native the global
// TextDecoder only exists after Expo's winter runtime installs it, which is
// later than the first import of this module — a module-scope instance threw
// "Property 'TextDecoder' doesn't exist" before the app could boot.
const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

const requireServerNow = (snapshot: SyncRemoteMutationFenceSnapshot): number => {
    if (snapshot.serverNowMs === null || !Number.isFinite(snapshot.serverNowMs)) {
        throw new SyncRemoteMutationFenceUnavailableError(
            'Remote sync mutation fencing requires a valid provider Date response header',
        );
    }
    return snapshot.serverNowMs;
};

const isImpossibleFutureExpiry = (expiresAt: number, serverNowMs: number): boolean => (
    expiresAt - serverNowMs > MAX_TTL_MS + MAX_FUTURE_EXPIRY_TOLERANCE_MS
);

/** A holder that advertises a heartbeat and has not renewed for several of
 * them is presumed dead. Records without the advertisement (older clients)
 * can only be waited out. */
const isAbandonedRecord = (record: SyncRemoteMutationFenceRecord, serverNowMs: number): boolean => {
    if (typeof record.heartbeatMs !== 'number' || record.heartbeatMs <= 0) return false;
    if (typeof record.renewedAt !== 'number') return false;
    const silentForMs = serverNowMs - record.renewedAt;
    return silentForMs > record.heartbeatMs * ABANDONED_AFTER_MISSED_HEARTBEATS + ABANDONED_JITTER_MARGIN_MS;
};

const parseRecord = (bytes: Uint8Array): SyncRemoteMutationFenceRecord => {
    if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) {
        throw new SyncRemoteMutationFenceUnavailableError('Remote sync mutation fence record is malformed');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(decodeUtf8(bytes));
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
    const parsedRecord = record as SyncRemoteMutationFenceRecord;
    // Liveness fields are optional and advisory: anything malformed is
    // dropped rather than rejecting a record an older client wrote.
    if (typeof parsedRecord.heartbeatMs !== 'number' || !Number.isFinite(parsedRecord.heartbeatMs) || parsedRecord.heartbeatMs < 0) {
        delete parsedRecord.heartbeatMs;
    }
    if (typeof parsedRecord.renewedAt !== 'number' || !Number.isFinite(parsedRecord.renewedAt)) {
        delete parsedRecord.renewedAt;
    }
    return parsedRecord;
};

const encodeRecord = (record: SyncRemoteMutationFenceRecord): Uint8Array => encodeUtf8(JSON.stringify(record));

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
    const heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(ttlMs / 3)));
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
    let acquiredRemainingMs = ttlMs;
    let reclaimedFrom: SyncRemoteMutationFenceHolder | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const snapshot = await port.read();
        const serverNowMs = requireServerNow(snapshot);
        reclaimedFrom = null;
        if (snapshot.bytes) {
            if (!snapshot.version) {
                throw new SyncRemoteMutationFenceUnavailableError(
                    'Existing remote sync mutation fence has no safe version',
                );
            }
            const current = parseRecord(snapshot.bytes);
            if (current.expiresAt > serverNowMs && !isImpossibleFutureExpiry(current.expiresAt, serverNowMs)) {
                const holder: SyncRemoteMutationFenceHolder = {
                    ownerId: current.ownerId,
                    leaseId: current.leaseId,
                    purpose: current.purpose,
                    remainingMs: current.expiresAt - serverNowMs,
                };
                if (!isAbandonedRecord(current, serverNowMs)) {
                    throw new SyncRemoteMutationFenceBusyError(current.expiresAt - serverNowMs, holder);
                }
                // Presumed dead: fall through to a CAS write over its exact
                // version. A holder that was merely paused loses that race (or
                // fails its next ownership check) and aborts before mutating.
                reclaimedFrom = holder;
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
            heartbeatMs,
            renewedAt: serverNowMs,
        };
        try {
            await port.write(encodeRecord(record), snapshot.version);
        } catch (error) {
            if (port.isConflict(error)) continue;
            throw error;
        }
        const verified = await port.read();
        const verifiedServerNowMs = requireServerNow(verified);
        if (!verified.bytes || !verified.version) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence disappeared after acquisition');
        }
        const verifiedRecord = parseRecord(verified.bytes);
        if (
            verifiedRecord.leaseId !== leaseId
            || verifiedRecord.ownerId !== ownerId
            || verifiedRecord.expiresAt !== record.expiresAt
        ) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence was replaced during acquisition');
        }
        if (
            verifiedRecord.expiresAt <= verifiedServerNowMs
            || isImpossibleFutureExpiry(verifiedRecord.expiresAt, verifiedServerNowMs)
        ) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence is not live after acquisition');
        }
        acquiredVersion = verified.version;
        acquiredRemainingMs = verifiedRecord.expiresAt - verifiedServerNowMs;
        break;
    }
    if (!acquiredVersion) {
        throw new SyncRemoteMutationFenceBusyError(0);
    }

    let currentVersion = acquiredVersion;
    let lastKnownRemainingMs = acquiredRemainingMs;
    const monotonicNow = (): number => (
        typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now()
    );
    let remainingObservedAtMs = monotonicNow();
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
        lastKnownRemainingMs = record.expiresAt - serverNowMs;
        remainingObservedAtMs = monotonicNow();
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
            heartbeatMs,
            renewedAt: serverNowMs,
        };
        try {
            await port.write(encodeRecord(replacement), snapshot.version);
        } catch (error) {
            if (port.isConflict(error)) throw new SyncRemoteMutationFenceLostError();
            throw error;
        }
        const verified = await port.read();
        const verifiedServerNowMs = requireServerNow(verified);
        if (!verified.bytes || !verified.version) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence disappeared after renewal');
        }
        const verifiedRecord = parseRecord(verified.bytes);
        if (
            verifiedRecord.leaseId !== leaseId
            || verifiedRecord.ownerId !== ownerId
            || verifiedRecord.expiresAt !== replacement.expiresAt
        ) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence was replaced during renewal');
        }
        if (
            verifiedRecord.expiresAt <= verifiedServerNowMs
            || isImpossibleFutureExpiry(verifiedRecord.expiresAt, verifiedServerNowMs)
        ) {
            throw new SyncRemoteMutationFenceLostError('Remote sync mutation fence is not live after renewal');
        }
        currentVersion = verified.version;
        lastKnownRemainingMs = verifiedRecord.expiresAt - verifiedServerNowMs;
        remainingObservedAtMs = monotonicNow();
    };

    const scheduleHeartbeat = (): void => {
        if (closed || heartbeatMs === 0 || lostError) return;
        heartbeatTimer = setTimeout(() => {
            heartbeatTimer = null;
            void serialize(renewOwned).then(
                () => scheduleHeartbeat(),
                (error) => {
                    lostError = error;
                    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
                    heartbeatTimer = null;
                },
            );
        }, heartbeatMs);
        const timer = heartbeatTimer as unknown as { unref?: () => void };
        timer.unref?.();
    };
    scheduleHeartbeat();

    return {
        reclaimedFrom,
        assertHeld: (minRemainingMs = 0) => serialize(async () => {
            if (!Number.isFinite(minRemainingMs) || minRemainingMs < 0 || minRemainingMs >= ttlMs) {
                throw new Error('Remote sync mutation fence remaining-time requirement is invalid');
            }
            const { record, serverNowMs } = await requireOwnedSnapshot();
            if (record.expiresAt - serverNowMs <= minRemainingMs) await renewOwned();
        }),
        renew: () => serialize(renewOwned),
        retryAfterMs: () => Math.max(0, Math.ceil(
            lastKnownRemainingMs - (monotonicNow() - remainingObservedAtMs),
        )),
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
