import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_FILE_SIZE_BYTES } from '@mindwtr/core';
import { createWebAttachmentDraft } from './web-attachment-upload';
import { writeCloudConfig, writeSyncBackend } from './sync-service-config';

const config = vi.hoisted(() => ({
    backend: 'cloud', provider: 'selfhosted', encryption: { state: 'off', incompleteTransition: undefined as string | undefined },
    url: 'https://cloud.example.com', token: 'test-token-1234567890',
}));
vi.mock('./sync-service', () => ({ SyncService: {
    getSyncBackend: async () => config.backend,
    getCloudProvider: async () => config.provider,
    getSyncEncryptionStatus: async () => config.encryption,
    getCloudConfig: async () => ({ url: config.url, token: config.token }),
} }));
vi.mock('./app-log', () => ({ logInfo: vi.fn() }));

const fetcher = vi.fn<typeof fetch>();
const image = () => new File(['image bytes'], 'Photo.PNG', { type: 'image/png' });
const browserConfigDeps = {
    isTauriRuntimeEnv: () => false, maybeMigrateLegacyLocalStorageToConfig: async () => undefined,
    reportError: vi.fn(), invokeNative: async <T,>() => undefined as T, startFileWatcher: async () => undefined,
};
beforeEach(() => {
    localStorage.clear();
    Object.assign(config, { backend: 'cloud', provider: 'selfhosted', url: 'https://cloud.example.com', token: 'test-token-1234567890' });
    config.encryption = { state: 'off', incompleteTransition: undefined };
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    fetcher.mockReset().mockImplementation(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
});

describe('browser draft upload through production cloud transport', () => {
    it('stages without network, uses the generated shared key, then preserves store-owned bytes', async () => {
        const draft = createWebAttachmentDraft();
        const file = image();
        const attachment = draft.stage(file);
        expect(fetcher).not.toHaveBeenCalled();
        expect(attachment.uri).toBe('');
        expect(attachment.cloudKey).toBeUndefined();
        const pending = draft.prepareSave([attachment]);
        expect(draft.prepareSave([attachment])).toBe(pending);
        const saved = await pending;
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0][0]).toBe(`https://cloud.example.com/v1/attachments/${attachment.id}.png`);
        expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: file });
        expect(saved[0]).toMatchObject({ id: attachment.id, cloudKey: `attachments/${attachment.id}.png`, uri: '' });
        expect(saved[0].localStatus).toBeUndefined();
        draft.retainBeforeStore(saved);
        draft.discard();
        expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT']);
    });

    it.each([
        ['backend', () => { config.backend = 'webdav'; }, 'attachments.webUploadRequiresCloud'],
        ['provider', () => { config.provider = 'dropbox'; }, 'attachments.webUploadRequiresCloud'],
        ['encryption', () => { config.encryption.state = 'enabled'; }, 'attachments.webUploadEncrypted'],
        ['unknown encryption', () => { config.encryption.state = 'unknown'; }, 'attachments.webUploadEncrypted'],
        ['transition', () => { config.encryption.incompleteTransition = 'enable'; }, 'attachments.webUploadEncrypted'],
        ['offline', () => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); }, 'attachments.webUploadOffline'],
    ])('rejects %s without losing the staged identity', async (_name, change, translationKey) => {
        const draft = createWebAttachmentDraft();
        const attachment = draft.stage(image());
        change();
        await expect(draft.prepareSave([attachment])).rejects.toMatchObject({ translationKey });
        expect(draft.has([attachment])).toBe(true);
        expect(fetcher).not.toHaveBeenCalled();
        draft.remove(attachment.id);
        expect(await draft.prepareSave([])).toEqual([]);
    });

    it('applies the existing 50 MiB and MIME limits before sending bytes', async () => {
        for (const file of [new File(['x'], 'program', { type: 'application/x-executable' }), image()]) {
            if (file.type === 'image/png') Object.defineProperty(file, 'size', { value: DEFAULT_MAX_FILE_SIZE_BYTES + 1 });
            const draft = createWebAttachmentDraft();
            await expect(draft.prepareSave([draft.stage(file)])).rejects.toMatchObject({
                translationKey: file.type === 'image/png' ? 'attachments.fileTooLarge' : 'attachments.invalidFileType',
            });
        }
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('keeps failed and permanently refused files for explicit retry with the same identity', async () => {
        const draft = createWebAttachmentDraft();
        const attachment = draft.stage(image());
        fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Blocked executable attachment signature: exe' }), { status: 400 }));
        await expect(draft.prepareSave([attachment])).rejects.toMatchObject({ translationKey: 'attachments.invalidFileType' });
        expect(draft.has([attachment])).toBe(true);
        const saved = await draft.prepareSave([attachment]);
        expect(saved[0].id).toBe(attachment.id);
        expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
        draft.discard();
        expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'PUT']);
    });

    it('cleans only definite unused uploads against their original target', async () => {
        const draft = createWebAttachmentDraft();
        const attachment = draft.stage(image());
        await draft.prepareSave([attachment]);
        config.url = 'https://other.example.com';
        draft.remove(attachment.id);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        expect(fetcher.mock.calls[1]).toMatchObject([`https://cloud.example.com/v1/attachments/${attachment.id}.png`, { method: 'DELETE' }]);
    });

    it('rejects a configuration A-to-B-to-A mutation before metadata adoption', async () => {
        const draft = createWebAttachmentDraft();
        const attachment = draft.stage(image());
        fetcher.mockImplementationOnce(async () => {
            await writeSyncBackend('off', browserConfigDeps);
            await writeSyncBackend('cloud', browserConfigDeps);
            return new Response(null, { status: 200 });
        });
        await expect(draft.prepareSave([attachment])).rejects.toMatchObject({ translationKey: 'attachments.webUploadChanged' });
        expect(() => draft.retainBeforeStore([attachment])).toThrow('attachments.webUploadChanged');
    });

    it('checks configuration again synchronously at store admission', async () => {
        const draft = createWebAttachmentDraft();
        const saved = await draft.prepareSave([draft.stage(image())]);
        await writeCloudConfig({ url: config.url, token: config.token }, browserConfigDeps);
        expect(() => draft.retainBeforeStore(saved)).toThrow('attachments.webUploadChanged');
    });

    it('rejects discarded in-flight work and does not race remote deletion after abort', async () => {
        const draft = createWebAttachmentDraft();
        const attachment = draft.stage(image());
        let reject!: (error: Error) => void;
        fetcher.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
        const pending = draft.prepareSave([attachment]);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
        draft.discard();
        reject(new DOMException('aborted', 'AbortError'));
        await expect(pending).rejects.toThrow();
        expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT']);
        expect(draft.has([attachment])).toBe(false);
    });
});
