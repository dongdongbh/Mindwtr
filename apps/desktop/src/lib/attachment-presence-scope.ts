/**
 * "When did this device last prove, object by object, that the sync location still holds
 * every attachment it has a `cloudKey` for?" — the desktop half of the #1119 follow-up
 * (battery/traffic audit F3), ported from mobile's `attachment-sync-utils.ts`.
 *
 * An uploaded attachment's remote key is derived from its id and its bytes never change, so
 * a presence pass can only ever discover a server-side deletion behind the app's back. That
 * proof is worth having; it is not worth having every cycle. It now runs at most once per
 * day per sync location, plus every "don't know" case.
 *
 * ## Where the stamp lives, and why it is not in config.toml
 *
 * `localStorage`, next to `mindwtr-fast-sync-state-v1` in `sync-service-fast-sync.ts`. The
 * stamp is the same CLASS of fact as `FastSyncState` — a device-local, per-location, never
 * synced cache of what this device already proved about this remote — and the fresh-join
 * posture gate in `sync-service.ts` ORs the two together, so splitting one predicate's two
 * halves across two stores with different durability and different failure modes would be
 * the bug, not the safeguard.
 *
 * `config.toml` was the other candidate and is the wrong home: it is not a key-value store
 * but the sync CONFIGURATION, published as an atomic config/secrets pair with rollback
 * files, credential-state fingerprints and a crash journal behind one outer
 * read-modify-write lock — and the write would have to happen from inside a sync cycle,
 * which is exactly the code path already warned to use the direct native primitives rather
 * than nest that queue (see `getDropboxAccessTokenDirect`'s comment in `sync-service.ts`).
 * A daily cache stamp does not justify a Rust struct field, two Tauri commands and a
 * two-file fsync'd publication per write.
 *
 * Losing the stamp (a wiped profile, a portable move, a cleared WebView store) is fail-safe
 * in both directions: absent means "reconcile now" here, and "posture not established" to
 * the fresh-join gate — one extra HEAD pass, or one deferred prepare phase. Never the
 * other way.
 *
 * ## Scope
 *
 * The scope string is `desktopSyncLocationScope(context)` in `sync-service.ts` — the SAME
 * value the encryption posture gate uses, computed once per cycle from the fully-resolved
 * cycle context and handed to both the reader (`hasAttachmentSyncWork`,
 * `hasCompletedAttachmentPresenceReconciliation`) and the writer (each backend, through
 * `AttachmentBackendDeps.presenceScope`). Mobile had to derive it twice and a
 * reader/writer derivation mismatch was a blocking review finding there; on desktop there
 * is one derivation and one value per cycle, so the two sides cannot disagree.
 *
 * A null/empty scope always means doubt: reconcile, and never stamp.
 */

/** Once a day. See the module comment for why a longer or shorter cadence is not the point:
 *  the pass can only discover a deletion made outside the app. */
export const ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const ATTACHMENT_PRESENCE_RECONCILE_KEY = 'mindwtr-attachment-presence-reconcile-v1';

type AttachmentPresenceStamp = { scope: string; at: number };

const readAttachmentPresenceStamp = (): AttachmentPresenceStamp | null => {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(ATTACHMENT_PRESENCE_RECONCILE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<AttachmentPresenceStamp> | null;
        if (typeof parsed?.scope !== 'string' || !Number.isFinite(parsed?.at)) return null;
        return { scope: parsed.scope, at: Number(parsed.at) };
    } catch {
        return null;
    }
};

/**
 * Should the full per-attachment reconciliation pass run now?
 *
 * Due when: nothing has ever reconciled, the stamp is unreadable, the sync location changed
 * under it, it is older than a day, or the clock moved backwards since it was written. Each
 * of those is "don't know", and every "don't know" reconciles.
 */
export const isAttachmentPresenceReconciliationDue = (scope: string | null | undefined): boolean => {
    if (!scope) return true;
    const stamp = readAttachmentPresenceStamp();
    if (!stamp || stamp.scope !== scope) return true;
    const elapsed = Date.now() - stamp.at;
    return elapsed < 0 || elapsed >= ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS;
};

/**
 * Records that a full per-attachment pass just ran to COMPLETION against this location.
 * Called by each backend at the end of its own pass rather than by the predicate, so a pass
 * that never ran, aborted, or broke out on a rate limit leaves the stamp alone and the next
 * cycle retries instead of parking the reconciliation for a day.
 *
 * Never called on an activation probe: a probe proves the CANDIDATE location, while the
 * scope names the committed one.
 */
export const markAttachmentPresenceReconciled = (
    scope: string | null | undefined,
    logWarning?: (message: string, error?: unknown) => void,
): void => {
    if (!scope) return;
    if (typeof localStorage === 'undefined') return;
    try {
        const stamp: AttachmentPresenceStamp = { scope, at: Date.now() };
        localStorage.setItem(ATTACHMENT_PRESENCE_RECONCILE_KEY, JSON.stringify(stamp));
    } catch (error) {
        logWarning?.('Failed to record the attachment presence reconciliation stamp', error);
    }
};

/**
 * #1138 fresh-join posture: the durable "this device has completed at least one full cycle
 * against the active location" fact for a backend with no `FastSyncState` record — the file
 * backend above all, since `buildFastSyncScope` returns `null` for it and always will.
 *
 * A stamp is only ever written at the END of a completed attachment pass, so its existence
 * FOR THIS EXACT SCOPE proves a full cycle already ran here, which is all the sync-encryption
 * posture gate needs to stop treating an ordinary re-check as a fresh join. Scope-exact on
 * purpose: a stamp from a previous location must not vouch for a new one.
 */
export const hasCompletedAttachmentPresenceReconciliation = (scope: string | null | undefined): boolean => {
    if (!scope) return false;
    const stamp = readAttachmentPresenceStamp();
    return stamp !== null && stamp.scope === scope;
};

/** Test/reset seam; production never needs it, since a scope mismatch already retires a
 *  stamp written for a different location. */
export const clearAttachmentPresenceStamp = (): void => {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.removeItem(ATTACHMENT_PRESENCE_RECONCILE_KEY);
    } catch {
        // Best-effort local cache cleanup.
    }
};
