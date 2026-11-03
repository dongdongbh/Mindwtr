import { logWarn } from './logger';

export const MAX_SYNC_REVISION = 2_147_483_647;
export const SYNC_REVISION_WARNING_THRESHOLD = Math.floor(MAX_SYNC_REVISION * 0.9);
export const SYNC_BACKUP_RESTORE_REV_BY = 'backup-restore';

type RevisionCoercion = {
    revision: number;
    clamped: boolean;
    raw: unknown;
};

const coerceRevision = (value: unknown): RevisionCoercion => {
    if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || !Number.isInteger(value)
        || value < 0
    ) {
        return { revision: 0, clamped: false, raw: value };
    }
    if (value > MAX_SYNC_REVISION) {
        return { revision: MAX_SYNC_REVISION, clamped: true, raw: value };
    }
    return { revision: value, clamped: false, raw: value };
};

export const isValidRevision = (value: unknown): value is number => (
    typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
);

export const normalizeRevision = (value?: unknown): number => {
    const coerced = coerceRevision(value);
    if (coerced.clamped) {
        logWarn('Clamped sync revision above safe maximum', {
            scope: 'sync',
            category: 'sync',
            context: { rev: coerced.raw, maxRev: MAX_SYNC_REVISION },
        });
    }
    return coerced.revision;
};

export const nextRevision = (value?: unknown, options?: { warn?: boolean }): number => {
    const coerced = coerceRevision(value);
    if (coerced.clamped || coerced.revision >= MAX_SYNC_REVISION) {
        if (options?.warn !== false) logWarn('Sync revision reached safe maximum; preserving capped revision', {
            scope: 'sync',
            category: 'sync',
            context: { rev: coerced.raw, maxRev: MAX_SYNC_REVISION },
        });
        return MAX_SYNC_REVISION;
    }
    const next = coerced.revision + 1;
    if (next >= SYNC_REVISION_WARNING_THRESHOLD && options?.warn !== false) {
        logWarn('Sync revision approaching safe maximum', {
            scope: 'sync',
            category: 'sync',
            context: {
                rev: coerced.raw,
                nextRev: next,
                warningThresholdRev: SYNC_REVISION_WARNING_THRESHOLD,
                maxRev: MAX_SYNC_REVISION,
            },
        });
    }
    return next;
};
