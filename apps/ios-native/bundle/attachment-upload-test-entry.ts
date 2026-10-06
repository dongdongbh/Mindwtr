// Built only with --attachment-upload-test; never the application resource.
import '../../android-native/bundle/host-entry';
import { createNativeAttachments, nativeFileChannels } from '../../android-native/bundle/host-attachments';
import { createHostSyncCrypto } from '../../android-native/bundle/host-sync';
import { logWarn } from '../../../packages/core/src/logger';
import { SYNC_BACKEND_KEY, WEBDAV_URL_KEY, WEBDAV_USERNAME_KEY } from '../../../packages/core/src/sync-storage-keys';
import type { AppData } from '@mindwtr/core';

const host = globalThis as typeof globalThis & {
    __mindwtrCryptoCall?: Parameters<typeof createHostSyncCrypto>[0];
    attachmentUploadGate?: unknown;
};
host.attachmentUploadGate = {
    async run(data: AppData, cap: number, phase: 'prepare' | 'post-merge', url: string) {
        const channels = nativeFileChannels();
        if (!channels) throw new Error('Attachment upload fixture file channels are unavailable');
        const before = JSON.stringify(data), warnings: Record<string, string>[] = [];
        const values = new Map<string, string>([
            [SYNC_BACKEND_KEY, 'webdav'], [WEBDAV_URL_KEY, url], [WEBDAV_USERNAME_KEY, 'synthetic-fixture'],
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
                    if (options?.extra?.releaseCheck !== 'v1.3.5/webdav-host-upload-limit') return;
                    const context = {
                        releaseCheck: options.extra.releaseCheck,
                        operation: options.extra.operation, outcome: options.extra.outcome,
                    };
                    warnings.push(context);
                    logWarn('WebDAV host upload admission refused', { scope: 'native-ios', force: true, context });
                },
            },
            crypto: createHostSyncCrypto(host.__mindwtrCryptoCall),
            encryption: { getSyncEncryptionMaterial: async () => null, logSyncEncryptionEvent: () => {} },
            maxWebdavBufferedUploadBytes: cap,
        }, channels);
        try {
            const result = await attachments.syncPort.syncWebdav(data, {
                url, username: 'synthetic-fixture', password: 'synthetic-not-a-credential',
            }, new AbortController().signal, { phase, activationProbe: true });
            return { admitted: true, result, inputUnchanged: JSON.stringify(data) === before, warnings };
        } catch (error) {
            const name = error instanceof Error ? error.name : 'Error';
            return {
                admitted: false, name,
                message: name === 'WebdavHostUploadLimitError'
                    ? (error as Error).message : 'Attachment upload fixture failed',
                inputUnchanged: JSON.stringify(data) === before, warnings,
            };
        }
    },
};
