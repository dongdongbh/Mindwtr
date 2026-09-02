import { describe, expect, it, beforeEach } from 'vitest';

import { sanitizeLogContext } from './log-sanitize';
import {
    SYNC_ENCRYPTION_LOG_EVENTS,
    buildSyncEncryptionActivationExtra,
    buildSyncEncryptionErrorExtra,
    buildSyncEncryptionRemoteReadExtra,
    buildSyncEncryptionStateExtra,
    buildSyncEncryptionTransitionExtra,
    findSyncEncryptionSentinel,
    formatSyncEncryptionDiagnostics,
    getLastSyncEncryptionError,
    resetLastSyncEncryptionError,
    syncEncryptionArtifactLabel,
    syncEncryptionKdfLabel,
    syncEncryptionLogMessage,
    syncEncryptionSaltPrefix,
    syncEncryptionScopeLabel,
} from './sync-encryption-diagnostics';

const KDF = { mKib: 65536, t: 3, p: 1 };

beforeEach(() => {
    resetLastSyncEncryptionError();
});

describe('sync-encryption diagnostics helpers', () => {
    it('names every event under one grep-able prefix', () => {
        expect(syncEncryptionLogMessage(SYNC_ENCRYPTION_LOG_EVENTS.state)).toBe('[sync-encryption] state');
        expect(syncEncryptionLogMessage(SYNC_ENCRYPTION_LOG_EVENTS.remoteRead)).toBe('[sync-encryption] remote-read');
    });

    it('truncates a salt to 8 hex characters from either the hex or the byte form', () => {
        expect(syncEncryptionSaltPrefix('07'.repeat(16))).toBe('07070707');
        expect(syncEncryptionSaltPrefix(new Uint8Array(16).fill(0xab))).toBe('abababab');
        expect(syncEncryptionSaltPrefix('AB'.repeat(16))).toBe('abababab');
        expect(syncEncryptionSaltPrefix(undefined)).toBe('-');
        expect(syncEncryptionSaltPrefix(new Uint8Array(0))).toBe('-');
        // Not hex: refuse rather than print whatever was handed in.
        expect(syncEncryptionSaltPrefix('correct horse battery')).toBe('-');
    });

    it('formats KDF parameters exactly as the artifact header carries them', () => {
        expect(syncEncryptionKdfLabel(KDF)).toBe('m=65536,t=3,p=1');
        expect(syncEncryptionKdfLabel(null)).toBe('-');
    });

    it('reduces a location scope to backend plus digest, never the path or the username', () => {
        const fileScope = '["file","/home/u/Sync/data.json"]';
        expect(syncEncryptionScopeLabel(fileScope)).toBe('file#eb9492f4');
        expect(syncEncryptionScopeLabel(fileScope)).not.toContain('/home/u');
        expect(syncEncryptionScopeLabel('["cloud","dropbox"]')).toBe('cloud#0879d27a');

        const webdavScope = '["webdav","https://dav.example.com/remote.php/dav/","alice"]';
        const label = syncEncryptionScopeLabel(webdavScope);
        expect(label.startsWith('webdav#')).toBe(true);
        expect(label).not.toContain('alice');
        expect(label).not.toContain('dav.example.com');

        // Same location, same label — the whole point is comparing two scopes in one log.
        expect(syncEncryptionScopeLabel(fileScope)).toBe(syncEncryptionScopeLabel(fileScope));
        expect(syncEncryptionScopeLabel(fileScope)).not.toBe(syncEncryptionScopeLabel('["file","/other/data.json"]'));
        expect(syncEncryptionScopeLabel(null)).toBe('-');
    });

    it('reduces an artifact path or URL to its leaf name', () => {
        expect(syncEncryptionArtifactLabel('https://dav.example.com/u/alice/data.json.enc?x=1'))
            .toBe('data.json.enc');
        expect(syncEncryptionArtifactLabel('/home/u/Sync/data.json')).toBe('data.json');
        expect(syncEncryptionArtifactLabel('C:\\Users\\u\\Sync\\data.json')).toBe('data.json');
        expect(syncEncryptionArtifactLabel(null)).toBe('-');
    });

    it('reports the sentinel already embedded in an error message', () => {
        expect(findSyncEncryptionSentinel('SYNC_ENCRYPTION_REMOTE_ENCRYPTED: encrypted here'))
            .toBe('SYNC_ENCRYPTION_REMOTE_ENCRYPTED');
        expect(findSyncEncryptionSentinel('SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE: data.json'))
            .toBe('SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE');
        expect(findSyncEncryptionSentinel('boom')).toBe('-');
    });
});

describe('sync-encryption diagnostics field maps', () => {
    // The trap this test exists for: core's log sanitizer redacts any field whose NAME
    // contains "key", so a field called `hasKey` would reach every log as "[redacted]".
    it('keeps the material flag readable where a "key"-named field would be redacted', () => {
        expect(sanitizeLogContext({ hasKey: 'true' })?.hasKey).toBe('[redacted]');
        expect(buildSyncEncryptionStateExtra({
            backend: 'file',
            trigger: 'manual',
            state: 'enabled',
            hasMaterial: true,
            decision: 'proceed',
        }).hasMaterial).toBe('true');
    });

    it('fills every state column, with "-" for what is unknown', () => {
        expect(buildSyncEncryptionStateExtra({
            backend: 'cloud',
            trigger: 'auto',
            state: 'remote-encrypted-no-key',
            hasMaterial: false,
            salt: '07'.repeat(16),
            kdf: KDF,
            discoveredScope: '["cloud","dropbox"]',
            activeScope: '["file","/home/u/Sync/data.json"]',
            decision: 'blocked-no-key',
        })).toEqual({
            backend: 'cloud',
            trigger: 'auto',
            state: 'remote-encrypted-no-key',
            hasMaterial: 'false',
            saltPrefix: '07070707',
            kdf: 'm=65536,t=3,p=1',
            incompleteTransition: '-',
            discoveredScope: 'cloud#0879d27a',
            activeScope: 'file#eb9492f4',
            decision: 'blocked-no-key',
        });
    });

    it('names a read artifact by its leaf only', () => {
        const extra = buildSyncEncryptionRemoteReadExtra({
            artifact: 'https://dav.example.com/u/alice/data.json.enc',
            exists: true,
            kind: 'encrypted',
            headerSalt: new Uint8Array(16).fill(0xab),
            headerKdf: KDF,
            bytes: 4096,
            version: 'strong',
            foreignSalt: true,
            decision: 'no-key',
        });
        expect(extra).toEqual({
            artifact: 'data.json.enc',
            exists: 'true',
            kind: 'encrypted',
            headerSaltPrefix: 'abababab',
            headerKdf: 'm=65536,t=3,p=1',
            bytes: '4096',
            version: 'strong',
            foreignSalt: 'true',
            decision: 'no-key',
        });
        expect(JSON.stringify(extra)).not.toContain('alice');
    });

    it('clamps a transition error message and drops it when there was no error', () => {
        const ok = buildSyncEncryptionTransitionExtra({
            kind: 'enable',
            backend: 'file',
            phase: 'end',
            outcome: 'ok',
        });
        expect(ok.errorName).toBe('-');
        expect(ok.errorMessage).toBe('-');

        const failed = buildSyncEncryptionTransitionExtra({
            kind: 'change-passphrase',
            backend: 'webdav',
            phase: 'end',
            outcome: 'error',
            errorName: 'SyncEncryptionRemoteConflictError',
            errorMessage: 'x'.repeat(500),
        });
        expect(failed.errorName).toBe('SyncEncryptionRemoteConflictError');
        expect(failed.errorMessage.length).toBeLessThanOrEqual(201);
    });

    it('scrubs a credentialed URL out of a foreign error message before clamping it', () => {
        // The typed SyncEncryption*Error messages are fixed strings, but the transition
        // wrappers log the message of ANY thrown error, and that line is written with `force`.
        // `sanitizeLogContext` already scrubs http(s) userinfo on the way out; any OTHER
        // scheme reaches the log untouched unless this builder scrubs it first.
        const extra = buildSyncEncryptionTransitionExtra({
            kind: 'enable',
            backend: 'webdav',
            phase: 'end',
            outcome: 'error',
            errorName: 'TypeError',
            errorMessage: 'PUT ftp://alice:hunter2@files.example.com/mindwtr/data.json failed',
        });
        expect(extra.errorMessage).not.toContain('hunter2');
        expect(extra.errorMessage).not.toContain('alice');
        expect(extra.errorMessage).toContain('files.example.com');
    });

    it('records the last error for the Diagnostics block', () => {
        expect(getLastSyncEncryptionError()).toBeNull();
        buildSyncEncryptionErrorExtra({
            errorName: 'SyncEncryptionNoKeyError',
            errorMessage: 'SYNC_ENCRYPTION_REMOTE_ENCRYPTED: nope',
            backend: 'file',
            step: 'read',
            classification: 'needs-passphrase',
            at: '2026-09-01T10:00:00.000Z',
        });
        expect(getLastSyncEncryptionError()).toEqual({
            name: 'SyncEncryptionNoKeyError',
            at: '2026-09-01T10:00:00.000Z',
        });
        expect(formatSyncEncryptionDiagnostics({ state: 'off', hasMaterial: false }))
            .toContain('lastError: SyncEncryptionNoKeyError @ 2026-09-01T10:00:00.000Z');
    });

    it('reports an activation probe result without any credential', () => {
        expect(buildSyncEncryptionActivationExtra({
            activationProof: 'remote-encrypted-no-key',
            stateBefore: 'off',
            stateAfter: 'remote-encrypted-no-key',
            backend: 'webdav',
        })).toEqual({
            activationProof: 'remote-encrypted-no-key',
            stateBefore: 'off',
            stateAfter: 'remote-encrypted-no-key',
            backend: 'webdav',
        });
    });

    it('renders the Diagnostics block with a digested location and a truncated salt', () => {
        expect(formatSyncEncryptionDiagnostics({
            state: 'remote-encrypted-no-key',
            hasMaterial: false,
            salt: '07'.repeat(16),
            kdf: KDF,
            incompleteTransition: undefined,
            activeScope: '["file","/home/u/Sync/data.json"]',
        })).toEqual([
            'state: remote-encrypted-no-key',
            'location: file#eb9492f4',
            'material: false',
            'salt: 07070707',
            'kdf: m=65536,t=3,p=1',
            'transition: -',
            'lastError: -',
        ]);
    });
});
