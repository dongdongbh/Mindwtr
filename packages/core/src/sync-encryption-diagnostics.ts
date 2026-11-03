


import { sanitizeForLog, sanitizeLogContext, sanitizeUrl } from './log-sanitize';
import type { SyncCryptoKdfParams } from './sync-crypto';
import type { SyncEncryptionState, SyncEncryptionTransitionKind } from './sync-encryption';

export const SYNC_ENCRYPTION_LOG_PREFIX = '[sync-encryption]';


export const SYNC_ENCRYPTION_LOG_EVENTS = {
    state: 'state',
    remoteRead: 'remote-read',
    transition: 'transition',
    error: 'error',
    activation: 'activation',
} as const;

export type SyncEncryptionLogEvent =
    (typeof SYNC_ENCRYPTION_LOG_EVENTS)[keyof typeof SYNC_ENCRYPTION_LOG_EVENTS];


export const syncEncryptionLogMessage = (event: SyncEncryptionLogEvent): string =>
    `${SYNC_ENCRYPTION_LOG_PREFIX} ${event}`;


export const SYNC_ENCRYPTION_LOG_ABSENT = '-';

const MAX_LOGGED_MESSAGE_CHARS = 200;

const HEX_ONLY = /^[0-9a-f]*$/i;

const finalize = (fields: Record<string, unknown>): Record<string, string> =>
    sanitizeLogContext(fields) ?? {};

const flag = (value: boolean | null | undefined): string =>
    value === null || value === undefined ? SYNC_ENCRYPTION_LOG_ABSENT : String(value === true);


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


export const syncEncryptionKdfLabel = (params?: SyncCryptoKdfParams | null): string => {
    if (!params) return SYNC_ENCRYPTION_LOG_ABSENT;
    return `m=${params.mKib},t=${params.t},p=${params.p}`;
};


const digest32 = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);

        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
};


export const syncEncryptionScopeLabel = (scope?: string | null): string => {
    if (!scope) return SYNC_ENCRYPTION_LOG_ABSENT;
    let backend = 'scope';
    try {
        const parsed: unknown = JSON.parse(scope);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0]) {
            backend = parsed[0];
        }
    } catch {

    }
    return `${backend}#${digest32(scope)}`;
};


export const syncEncryptionArtifactLabel = (name?: string | null): string => {
    if (!name) return SYNC_ENCRYPTION_LOG_ABSENT;
    const stripped = name.split('?')[0]!.split('#')[0]!.replace(/[\\/]+$/, '');
    if (!stripped) return SYNC_ENCRYPTION_LOG_ABSENT;
    const lastSeparator = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
    const leaf = lastSeparator >= 0 ? stripped.slice(lastSeparator + 1) : stripped;
    return leaf || SYNC_ENCRYPTION_LOG_ABSENT;
};


const URL_IN_MESSAGE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

const clampMessage = (message?: string | null): string => {
    const trimmed = message?.trim();
    if (!trimmed) return SYNC_ENCRYPTION_LOG_ABSENT;


    const safe = sanitizeForLog(
        trimmed.replace(URL_IN_MESSAGE, (url) => sanitizeUrl(url) ?? '[redacted]'),
    );
    return safe.length > MAX_LOGGED_MESSAGE_CHARS
        ? `${safe.slice(0, MAX_LOGGED_MESSAGE_CHARS)}…`
        : safe;
};


export type SyncEncryptionStateDecision =
    | 'proceed'
    | 'blocked-no-key'
    | 'blocked-plaintext'
    | 'blocked-transition'
    | 'blocked-partly-encrypted'
    | 'quiet'
    | 'legacy-plaintext'
    | 'probe';

export type SyncEncryptionTrigger = 'manual' | 'auto' | 'background' | 'probe';

export type SyncEncryptionStateLogInput = {
    backend: string;
    trigger: SyncEncryptionTrigger;
    state: SyncEncryptionState | 'unknown';


    hasMaterial: boolean | null;
    salt?: string | Uint8Array | null;
    kdf?: SyncCryptoKdfParams | null;
    incompleteTransition?: SyncEncryptionTransitionKind | null;
    discoveredScope?: string | null;


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


export type SyncEncryptionRemoteReadKind =
    | 'encrypted'
    | 'plaintext'
    | 'absent'
    | 'unsupported'
    | 'invalid';


export type SyncEncryptionRemoteReadDecision =
    | 'decrypt'
    | 'no-key'
    | 'plaintext-discovered'
    | 'legacy-plaintext'
    | 'version-unavailable'
    | 'plaintext'
    | 'absent'
    | 'seal';


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


export type SyncEncryptionTransitionLogKind =
    | SyncEncryptionTransitionKind
    | 'unlock'
    | 'enable-local-only'
    | 'disable-local-only'
    | 'abandon'
    | 'recheck';

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

    classification: string;

    at?: string;
};

let lastSyncEncryptionError: { name: string; at: string } | null = null;


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


export type SyncEncryptionDiagnosticsInput = {
    state: SyncEncryptionState | 'unknown';
    hasMaterial: boolean | null;
    salt?: string | Uint8Array | null;
    kdf?: SyncCryptoKdfParams | null;
    incompleteTransition?: SyncEncryptionTransitionKind | null;
    activeScope?: string | null;
};


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
