// Built only with --attachment-upload-test; never the application resource.
import '../../android-native/bundle/host-entry';
import { createNativeAttachments, createNativeLocalAttachmentConfiguration, nativeFileChannels } from '../../android-native/bundle/host-attachments';
import { createHostSyncCrypto } from '../../android-native/bundle/host-sync';
import { logInfo, logWarn } from '../../../packages/core/src/logger';
import { CLOUD_PROVIDER_KEY, CLOUD_URL_KEY, SYNC_BACKEND_KEY, WEBDAV_URL_KEY, WEBDAV_USERNAME_KEY } from '../../../packages/core/src/sync-storage-keys';
import type { AppData, SyncKeyMaterial } from '@mindwtr/core';
import { ensureFreshLocalSyncSnapshot, getInMemoryAppDataSnapshot, LocalSyncAbort, useTaskStore } from '@mindwtr/core';

type SyntheticEncryptionFixture = {
    key: number[]; salt: number[]; params: SyncKeyMaterial['params'];
};

const host = globalThis as typeof globalThis & {
    __mindwtrCryptoCall?: Parameters<typeof createHostSyncCrypto>[0];
    attachmentUploadGate?: unknown;
    attachmentCleanupGate?: unknown;
};

// A private factory proof only: read the real loaded store, never persist the
// returned cleanup document or bind the ordinary host's Sync configuration.
host.attachmentCleanupGate = {
    async run() {
        const channels = nativeFileChannels();
        if (!channels) throw new Error('Attachment cleanup fixture file channels are unavailable');
        const appData = getInMemoryAppDataSnapshot();
        const before = JSON.stringify(appData), snapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
        const markers: Record<string, string>[] = [];
        let followUpRequested = false, warningCount = 0;
        const refuse = async (): Promise<never> => { throw new Error('Attachment cleanup fixture remote port is unavailable'); };
        const attachments = createNativeAttachments(createNativeLocalAttachmentConfiguration(), channels);
        const ensureLocalSnapshotFresh = () => {
            ensureFreshLocalSyncSnapshot({
                localSnapshotChangeAt: snapshotChangeAt,
                getCurrentChangeAt: () => useTaskStore.getState().lastDataChangeAt,
                requestFollowUp: () => { followUpRequested = true; },
            });
        };
        try {
            const result = await attachments.syncPort.runCleanup({
                appData, backend: 'file', webdavConfig: null, cloudConfig: null, cloudProvider: 'selfhosted',
                fetcher: refuse, deleteDropboxAttachment: refuse, isRemoteMissingError: () => false,
                ensureLocalSnapshotFresh,
                logSyncWarning: () => { warningCount += 1; },
                logSyncInfo: (message, extra) => {
                    if (message !== 'Attachment cleanup freshness guarded'
                        || extra?.releaseCheck !== 'v1.3.5/native-cleanup-freshness'
                        || (extra.outcome !== 'removed' && extra.outcome !== 'retained')) return;
                    const context = { releaseCheck: extra.releaseCheck, outcome: extra.outcome };
                    markers.push(context);
                    logInfo(message, { scope: 'native-ios', force: true, context });
                },
            });
            return { completed: true, result, inputUnchanged: JSON.stringify(appData) === before,
                followUpRequested, warningCount, markers };
        } catch (error) {
            if (!(error instanceof LocalSyncAbort)) throw error;
            return { completed: false, name: error.name, reason: error.reason,
                inputUnchanged: JSON.stringify(appData) === before, followUpRequested, warningCount, markers };
        }
    },
};
host.attachmentUploadGate = {
    async run(data: AppData, cap: number, phase: 'prepare' | 'post-merge', url: string, fixture?: SyntheticEncryptionFixture, provider: 'webdav' | 'selfhosted' = 'webdav', activationProbe = true) {
        if (!['webdav', 'selfhosted'].includes(provider) || provider === 'selfhosted' && fixture) {
            throw new Error('Attachment upload fixture provider is unavailable');
        }
        const channels = nativeFileChannels();
        if (!channels) throw new Error('Attachment upload fixture file channels are unavailable');
        const before = JSON.stringify(data), warnings: Record<string, string>[] = [];
        const material: SyncKeyMaterial | null = fixture
            ? { key: new Uint8Array(fixture.key), salt: new Uint8Array(fixture.salt), params: fixture.params } : null;
        const values = new Map<string, string>([
            [SYNC_BACKEND_KEY, provider === 'webdav' ? 'webdav' : 'cloud'],
            [WEBDAV_URL_KEY, url], [WEBDAV_USERNAME_KEY, 'synthetic-fixture'],
            [CLOUD_URL_KEY, url], [CLOUD_PROVIDER_KEY, 'selfhosted'],
        ]);
        const refuse = async (): Promise<never> => { throw new Error('Attachment upload fixture secret port is unavailable'); };
        const attachments = createNativeAttachments({
            storage: {
                getItem: async (name) => values.get(name) ?? null,
                setItem: async (name, value) => { values.set(name, value); },
                removeItem: async (name) => { values.delete(name); },
            },
            getSecureConfigValue: refuse,
            log: {
                info: () => {}, sanitize: () => 'Attachment upload fixture refused',
                warn: (_message, options) => {
                    const releaseCheck = options?.extra?.releaseCheck;
                    if (releaseCheck !== 'v1.3.5/webdav-host-upload-limit'
                        && releaseCheck !== 'v1.3.5/webdav-host-download-limit'
                        && releaseCheck !== 'v1.3.5/cloud-host-upload-limit'
                        && releaseCheck !== 'v1.3.5/cloud-host-response-limit') return;
                    const context = {
                        releaseCheck: options.extra.releaseCheck,
                        operation: options.extra.operation, outcome: options.extra.outcome,
                    };
                    warnings.push(context);
                    logWarn(provider === 'webdav' ? 'WebDAV host transfer admission refused' : 'Cloud host transfer admission refused',
                        { scope: 'native-ios', force: true, context });
                },
            },
            crypto: createHostSyncCrypto(host.__mindwtrCryptoCall),
            encryption: {
                getSyncEncryptionMaterial: async () => material,
                logSyncEncryptionEvent: () => {},
            },
            ...(provider === 'webdav' ? { maxWebdavBufferedUploadBytes: cap } : { maxCloudBufferedUploadBytes: cap }),
        }, channels);
        try {
            const signal = new AbortController().signal;
            const result = provider === 'webdav' ? await attachments.syncPort.syncWebdav(data, {
                url, username: 'synthetic-fixture', password: 'synthetic-not-a-credential',
            }, signal, { phase, activationProbe: true, material }) : await attachments.syncPort.syncCloud(data, {
                url, token: 'synthetic-fixture-token-395',
            }, { signal, phase, activationProbe });
            return { admitted: true, result, inputUnchanged: JSON.stringify(data) === before, warnings };
        } catch (error) {
            const name = error instanceof Error ? error.name : 'Error';
            const structured = error as Error & { code?: unknown; limitBytes?: unknown };
            const capped = error instanceof Error && structured.code === 'response-too-large'
                && Number.isSafeInteger(structured.limitBytes) && (structured.limitBytes as number) > 0;
            return {
                admitted: false, name,
                message: name === 'WebdavHostUploadLimitError' || name === 'CloudHostUploadLimitError'
                    ? (error as Error).message : capped
                        ? `Response exceeds the ${structured.limitBytes} byte download limit` : 'Attachment upload fixture failed',
                ...(capped ? { code: structured.code, limitBytes: structured.limitBytes } : {}),
                inputUnchanged: JSON.stringify(data) === before, warnings,
            };
        }
    },
};
