// Structured sync-encryption diagnostics (#1056 follow-up). One event family, one message
// prefix, five fixed event names, and one builder per event that produces the sanitized
// `extra` map the platform loggers take.
//
// Why this lives in core: mobile and desktop both emit the same trail, and two hand-written
// field maps drift within one release. Rust mirrors the field NAMES by hand
// (`apps/desktop/src-tauri/src/sync_encryption.rs`, `sync_encryption_diagnostic`) because it
// cannot import this — keep the two in step.
//
// Nothing here reads or changes sync state; every builder is pure apart from the in-memory
// last-error note the Diagnostics screens display.
//
// SECRETS: never accept a passphrase or key bytes. Salts are public (they sit in every MWENC1
// header) but only the first 8 hex characters are logged — enough to tell two encryption
// generations apart, not enough to be mistaken for key material. Location scopes carry a
// WebDAV username and a folder path, so they are logged as `<backend>#<digest>`, never raw.

import { sanitizeForLog, sanitizeLogContext, sanitizeUrl } from './log-sanitize';
import type { SyncCryptoKdfParams } from './sync-crypto';
import type { SyncEncryptionState, SyncEncryptionTransitionKind } from './sync-encryption';

export const SYNC_ENCRYPTION_LOG_PREFIX = '[sync-encryption]';

/** The five events. Fixed: greps and support docs reference these names. */
export const SYNC_ENCRYPTION_LOG_EVENTS = {
    state: 'state',
    remoteRead: 'remote-read',
    transition: 'transition',
    error: 'error',
    activation: 'activation',
} as const;

export type SyncEncryptionLogEvent =
    (typeof SYNC_ENCRYPTION_LOG_EVENTS)[keyof typeof SYNC_ENCRYPTION_LOG_EVENTS];

/** `[sync-encryption] <event>` — the whole trail is one grep. */
export const syncEncryptionLogMessage = (event: SyncEncryptionLogEvent): string =>
    `${SYNC_ENCRYPTION_LOG_PREFIX} ${event}`;

/** Absent/unknown. A fixed token so a column is never empty in a shared log. */
export const SYNC_ENCRYPTION_LOG_ABSENT = '-';

const MAX_LOGGED_MESSAGE_CHARS = 200;

const HEX_ONLY = /^[0-9a-f]*$/i;

const finalize = (fields: Record<string, unknown>): Record<string, string> =>
    sanitizeLogContext(fields) ?? {};

const flag = (value: boolean | null | undefined): string =>
    value === null || value === undefined ? SYNC_ENCRYPTION_LOG_ABSENT : String(value === true);

/** First 8 hex characters of a salt, or `-`. Accepts the hex form the local state persists
 *  and the raw bytes an artifact header carries. Never the whole salt: 8 characters separate
 *  two encryption generations, which is the only question a log has to answer. */
export const syncEncryptionSaltPrefix = (salt?: string | Uint8Array | null): string => {
    if (!salt) return SYNC_ENCRYPTION_LOG_ABSENT;
    if (typeof salt === 'string') {
        const trimmed = salt.trim();
        if (!trimmed || !HEX_ONLY.test(trimmed)) return SYNC_ENCRYPTION_LOG_ABSENT;
        return trimmed.slice(0, 8).toLowerCase();
    }
    if (salt.length === 0) return SYNC_ENCRYPTION_LOG_ABSENT;
    let out = '';
    for (let index = 0; index < salt.length && out.length < 8; index += 1) {
        out += salt[index]!.toString(16).padStart(2, '0');
    }
    return out.slice(0, 8);
};

/** `m=65536,t=3,p=1`, or `-`. Matches the header the artifact carries. */
export const syncEncryptionKdfLabel = (params?: SyncCryptoKdfParams | null): string => {
    if (!params) return SYNC_ENCRYPTION_LOG_ABSENT;
    return `m=${params.mKib},t=${params.t},p=${params.p}`;
};

/** FNV-1a/32. Not a security primitive — it exists so two scope strings can be compared in a
 *  shared log without the log carrying the folder path or the WebDAV username inside them. */
const digest32 = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        // >>> 0 after the multiply keeps this in uint32 without BigInt.
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
};

/**
 * `<backend>#<digest>` for a location scope built by `buildSyncLocationScope`.
 *
 * The scope string itself is `["webdav","https://host/dav","alice"]` — a URL and a username,
 * neither of which belongs in a log the user hands to a stranger. The backend name is the part
 * a reader needs in prose ("you were locked for dropbox, you are syncing a folder now"); the
 * digest answers the only other question, "is this the same location the lock was set on".
 */
export const syncEncryptionScopeLabel = (scope?: string | null): string => {
    if (!scope) return SYNC_ENCRYPTION_LOG_ABSENT;
    let backend = 'scope';
    try {
        const parsed: unknown = JSON.parse(scope);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0]) {
            backend = parsed[0];
        }
    } catch {
        // A scope we cannot parse is still comparable by digest.
    }
    return `${backend}#${digest32(scope)}`;
};

/** Leaf name of an artifact path or URL: `data.json.enc`, never the folder it sits in. */
export const syncEncryptionArtifactLabel = (name?: string | null): string => {
    if (!name) return SYNC_ENCRYPTION_LOG_ABSENT;
    const stripped = name.split('?')[0]!.split('#')[0]!.replace(/[\\/]+$/, '');
    if (!stripped) return SYNC_ENCRYPTION_LOG_ABSENT;
    const lastSeparator = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
    const leaf = lastSeparator >= 0 ? stripped.slice(lastSeparator + 1) : stripped;
    return leaf || SYNC_ENCRYPTION_LOG_ABSENT;
};

/** Any absolute URL inside a free-form message. `sanitizeUrl` is the only path that strips
 *  `user:pass@` userinfo, and `sanitizeLogContext`'s generic string path does not run it. */
const URL_IN_MESSAGE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

const clampMessage = (message?: string | null): string => {
    const trimmed = message?.trim();
    if (!trimmed) return SYNC_ENCRYPTION_LOG_ABSENT;
    // Sanitize BEFORE clamping: a truncated credential is still a credential, and clamping
    // first can cut a URL in half so `sanitizeUrl` no longer recognises it.
    const safe = sanitizeForLog(
        trimmed.replace(URL_IN_MESSAGE, (url) => sanitizeUrl(url) ?? '[redacted]'),
    );
    return safe.length > MAX_LOGGED_MESSAGE_CHARS
        ? `${safe.slice(0, MAX_LOGGED_MESSAGE_CHARS)}…`
        : safe;
};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** What the encryption gate decided for this cycle. `quiet` is an automatic run going
 *  no-op where a manual run would have thrown; `probe` is an activation candidate, which
 *  bypasses the block on purpose (57f8e2420). */
export type SyncEncryptionStateDecision =
    | 'proceed'
    | 'blocked-no-key'
    | 'blocked-plaintext'
    | 'blocked-transition'
    | 'quiet'
    | 'legacy-plaintext'
    | 'probe';

export type SyncEncryptionTrigger = 'manual' | 'auto' | 'background' | 'probe';

export type SyncEncryptionStateLogInput = {
    backend: string;
    trigger: SyncEncryptionTrigger;
    state: SyncEncryptionState | 'unknown';
    /** Whether key material resolved. Named for the material, not the key: core's log
     *  sanitizer redacts any field whose name contains "key", which would blank the value. */
    hasMaterial: boolean | null;
    salt?: string | Uint8Array | null;
    kdf?: SyncCryptoKdfParams | null;
    incompleteTransition?: SyncEncryptionTransitionKind | null;
    discoveredScope?: string | null;
    /** A scope the platform already reduced to `<backend>#<digest>`. Desktop's native layer
     *  reduces it in Rust so no raw scope (WebDAV username, folder path) ever crosses IPC;
     *  passing it here keeps it from being digested a second time. Wins over
     *  `discoveredScope`. */
    discoveredScopeLabel?: string | null;
    activeScope?: string | null;
    decision: SyncEncryptionStateDecision;
};

export const buildSyncEncryptionStateExtra = (
    input: SyncEncryptionStateLogInput,
): Record<string, string> => finalize({
    backend: input.backend || SYNC_ENCRYPTION_LOG_ABSENT,
    trigger: input.trigger,
    state: input.state,
    hasMaterial: flag(input.hasMaterial),
    saltPrefix: syncEncryptionSaltPrefix(input.salt),
    kdf: syncEncryptionKdfLabel(input.kdf),
    incompleteTransition: input.incompleteTransition ?? SYNC_ENCRYPTION_LOG_ABSENT,
    discoveredScope: input.discoveredScopeLabel?.trim()
        || syncEncryptionScopeLabel(input.discoveredScope),
    activeScope: syncEncryptionScopeLabel(input.activeScope),
    decision: input.decision,
});

// ---------------------------------------------------------------------------
// remote-read
// ---------------------------------------------------------------------------

export type SyncEncryptionRemoteReadKind =
    | 'encrypted'
    | 'plaintext'
    | 'absent'
    | 'unsupported'
    | 'invalid';

/** `absent` and `plaintext` are the ordinary outcomes; the rest are the ones that precede a
 *  refusal. Every seam that can throw a SyncEncryption*Error emits one of these first. */
export type SyncEncryptionRemoteReadDecision =
    | 'decrypt'
    | 'no-key'
    | 'plaintext-discovered'
    | 'legacy-plaintext'
    | 'version-unavailable'
    | 'plaintext'
    | 'absent';

/** How safe the backend generation is for a compare-and-swap. */
export type SyncEncryptionRemoteVersionKind = 'strong' | 'weak' | 'none' | 'n/a';

export type SyncEncryptionRemoteReadLogInput = {
    artifact: string;
    exists: boolean | null;
    kind: SyncEncryptionRemoteReadKind;
    headerSalt?: string | Uint8Array | null;
    headerKdf?: SyncCryptoKdfParams | null;
    bytes?: number | null;
    version?: SyncEncryptionRemoteVersionKind | null;
    foreignSalt?: boolean | null;
    decision: SyncEncryptionRemoteReadDecision;
};

export const buildSyncEncryptionRemoteReadExtra = (
    input: SyncEncryptionRemoteReadLogInput,
): Record<string, string> => finalize({
    artifact: syncEncryptionArtifactLabel(input.artifact),
    exists: flag(input.exists),
    kind: input.kind,
    headerSaltPrefix: syncEncryptionSaltPrefix(input.headerSalt),
    headerKdf: syncEncryptionKdfLabel(input.headerKdf),
    bytes: input.bytes === null || input.bytes === undefined
        ? SYNC_ENCRYPTION_LOG_ABSENT
        : String(input.bytes),
    version: input.version ?? SYNC_ENCRYPTION_LOG_ABSENT,
    foreignSalt: flag(input.foreignSalt),
    decision: input.decision,
});

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

/** The six user-visible transitions. `unlock` is core's provide-passphrase flow; the two
 *  `-local-only` kinds are the no-backend variants (#1001). */
export type SyncEncryptionTransitionLogKind =
    | SyncEncryptionTransitionKind
    | 'unlock'
    | 'enable-local-only'
    | 'disable-local-only';

export type SyncEncryptionTransitionOutcome =
    | 'ok'
    | 'wrong-passphrase'
    | 'no-encrypted-remote'
    | 'conflict'
    | 'backend-required'
    | 'error';

export type SyncEncryptionTransitionLogInput = {
    kind: SyncEncryptionTransitionLogKind;
    backend: string;
    phase: 'start' | 'artifact' | 'end';
    artifact?: string | null;
    planned?: number | null;
    done?: number | null;
    outcome?: SyncEncryptionTransitionOutcome | null;
    errorName?: string | null;
    errorMessage?: string | null;
};

export const buildSyncEncryptionTransitionExtra = (
    input: SyncEncryptionTransitionLogInput,
): Record<string, string> => finalize({
    kind: input.kind,
    backend: input.backend || SYNC_ENCRYPTION_LOG_ABSENT,
    phase: input.phase,
    artifact: input.artifact
        ? syncEncryptionArtifactLabel(input.artifact)
        : SYNC_ENCRYPTION_LOG_ABSENT,
    planned: input.planned === null || input.planned === undefined
        ? SYNC_ENCRYPTION_LOG_ABSENT
        : String(input.planned),
    done: input.done === null || input.done === undefined
        ? SYNC_ENCRYPTION_LOG_ABSENT
        : String(input.done),
    outcome: input.outcome ?? SYNC_ENCRYPTION_LOG_ABSENT,
    errorName: input.errorName || SYNC_ENCRYPTION_LOG_ABSENT,
    errorMessage: input.errorName ? clampMessage(input.errorMessage) : SYNC_ENCRYPTION_LOG_ABSENT,
});

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

/** The sentinels that already travel inside error messages. Logged as-is rather than
 *  re-coded, so a log line and a Rust rejection string say the same word. */
export const SYNC_ENCRYPTION_LOG_SENTINELS = [
    'SYNC_ENCRYPTION_REMOTE_ENCRYPTED',
    'SYNC_ENCRYPTION_REMOTE_PLAINTEXT',
    'SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE',
    'SYNC_ENCRYPTION_TRANSITION_INCOMPLETE',
    'SYNC_ENCRYPTION_STATE_UNAVAILABLE',
    'SYNC_ENCRYPTION_TERMINAL',
    'SYNC_ENCRYPTION_WRONG_PASSPHRASE',
    'SYNC_ENCRYPTION_BACKEND_REQUIRED',
] as const;

export const findSyncEncryptionSentinel = (message?: string | null): string => {
    if (!message) return SYNC_ENCRYPTION_LOG_ABSENT;
    // Longest first: SYNC_ENCRYPTION_TERMINAL is a prefix of nothing here, but
    // SYNC_ENCRYPTION_REMOTE_* pairs share a prefix with each other.
    for (const sentinel of [...SYNC_ENCRYPTION_LOG_SENTINELS].sort((a, b) => b.length - a.length)) {
        if (message.includes(sentinel)) return sentinel;
    }
    return SYNC_ENCRYPTION_LOG_ABSENT;
};

export type SyncEncryptionErrorLogInput = {
    errorName: string;
    errorMessage?: string | null;
    backend: string;
    step: string;
    /** The discriminant the UI turns into a toast/card, e.g. `needs-passphrase`. */
    classification: string;
    /** Defaults to now. Injectable so tests can pin the Diagnostics-block timestamp. */
    at?: string;
};

let lastSyncEncryptionError: { name: string; at: string } | null = null;

/** In-memory only, on purpose: the Diagnostics block answers "did this device hit an
 *  encryption failure in this session", and persisting it would add a second source of truth
 *  next to the sidecar for something the log already records durably. */
export const getLastSyncEncryptionError = (): { name: string; at: string } | null =>
    lastSyncEncryptionError;

export const resetLastSyncEncryptionError = (): void => {
    lastSyncEncryptionError = null;
};

export const buildSyncEncryptionErrorExtra = (
    input: SyncEncryptionErrorLogInput,
): Record<string, string> => {
    const at = input.at ?? new Date().toISOString();
    lastSyncEncryptionError = { name: input.errorName, at };
    return finalize({
        errorName: input.errorName || SYNC_ENCRYPTION_LOG_ABSENT,
        sentinel: findSyncEncryptionSentinel(input.errorMessage),
        backend: input.backend || SYNC_ENCRYPTION_LOG_ABSENT,
        step: input.step || SYNC_ENCRYPTION_LOG_ABSENT,
        classification: input.classification || SYNC_ENCRYPTION_LOG_ABSENT,
        errorMessage: clampMessage(input.errorMessage),
    });
};

// ---------------------------------------------------------------------------
// activation
// ---------------------------------------------------------------------------

export type SyncEncryptionActivationLogInput = {
    activationProof: string | null;
    stateBefore: SyncEncryptionState | 'unknown';
    stateAfter: SyncEncryptionState | 'unknown';
    backend: string;
};

export const buildSyncEncryptionActivationExtra = (
    input: SyncEncryptionActivationLogInput,
): Record<string, string> => finalize({
    activationProof: input.activationProof ?? SYNC_ENCRYPTION_LOG_ABSENT,
    stateBefore: input.stateBefore,
    stateAfter: input.stateAfter,
    backend: input.backend || SYNC_ENCRYPTION_LOG_ABSENT,
});

// ---------------------------------------------------------------------------
// Diagnostics screen block
// ---------------------------------------------------------------------------

export type SyncEncryptionDiagnosticsInput = {
    state: SyncEncryptionState | 'unknown';
    hasMaterial: boolean | null;
    salt?: string | Uint8Array | null;
    kdf?: SyncCryptoKdfParams | null;
    incompleteTransition?: SyncEncryptionTransitionKind | null;
    activeScope?: string | null;
};

/**
 * The "Encryption" block both Diagnostics screens render, as `label: value` lines.
 *
 * The labels are deliberately untranslated technical tokens. The block exists to be copied
 * into a bug report, where `state: remote-encrypted-no-key` has to read the same for a
 * Japanese user and for whoever triages the report; translating the keys would make half the
 * incoming reports unmatchable against the log lines they describe. Only the section heading
 * is translated, and it reuses the existing `settings.syncEncryption` string.
 */
export const formatSyncEncryptionDiagnostics = (
    input: SyncEncryptionDiagnosticsInput,
): string[] => {
    const lastError = getLastSyncEncryptionError();
    return [
        `state: ${input.state}`,
        `location: ${syncEncryptionScopeLabel(input.activeScope)}`,
        `material: ${flag(input.hasMaterial)}`,
        `salt: ${syncEncryptionSaltPrefix(input.salt)}`,
        `kdf: ${syncEncryptionKdfLabel(input.kdf)}`,
        `transition: ${input.incompleteTransition ?? SYNC_ENCRYPTION_LOG_ABSENT}`,
        `lastError: ${lastError ? `${lastError.name} @ ${lastError.at}` : SYNC_ENCRYPTION_LOG_ABSENT}`,
    ];
};
