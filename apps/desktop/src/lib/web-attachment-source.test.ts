import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '@mindwtr/core';
import {
    clearWebAttachmentMemoryCaches,
    fetchWebCloudAttachmentBlob,
    fetchWebCloudAttachmentText,
    retainOpenedWebAttachmentUrl,
    WEB_ATTACHMENT_BYTE_CACHE_MAX_BYTES,
    WEB_ATTACHMENT_BYTE_CACHE_MAX_ENTRIES,
    WEB_ATTACHMENT_OPEN_URL_MAX_ENTRIES,
} from './web-attachment-source';

const syncState = {
    backend: 'cloud',
    provider: 'selfhosted',
    encryption: { state: 'off' as string },
    config: { url: 'https://cloud.example.com/v1/data', token: 'token-123', allowInsecureHttp: false },
};

vi.mock('./runtime', () => ({
    isTauriRuntime: () => false,
}));

vi.mock('./sync-service', () => ({
    SyncService: {
        getSyncBackend: async () => syncState.backend,
        getCloudProvider: async () => syncState.provider,
        getSyncEncryptionStatus: async () => syncState.encryption,
        getCloudConfig: async () => syncState.config,
    },
}));

let attachmentSeq = 0;
const makeAttachment = (overrides: Partial<Attachment> = {}): Attachment => {
    attachmentSeq += 1;
    return {
        id: `attachment-${attachmentSeq}`,
        kind: 'file',
        title: 'photo.png',
        uri: '',
        cloudKey: `attachments/attachment-${attachmentSeq}.png`,
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
        ...overrides,
    } as Attachment;
};

const okFetcher = (body: Uint8Array) => vi.fn(async () => new Response(body.buffer as ArrayBuffer, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
}));

describe('fetchWebCloudAttachmentBlob', () => {
    beforeEach(() => {
        clearWebAttachmentMemoryCaches();
        syncState.backend = 'cloud';
        syncState.provider = 'selfhosted';
        syncState.encryption = { state: 'off' };
        syncState.config = { url: 'https://cloud.example.com/v1/data', token: 'token-123', allowInsecureHttp: false };
        (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock-url');
        (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    });

    it('GETs <cloud base>/<cloudKey> with the bearer token', async () => {
        const attachment = makeAttachment();
        const fetcher = okFetcher(new Uint8Array([1, 2, 3]));

        await expect(fetchWebCloudAttachmentBlob(attachment, { fetcher: fetcher as unknown as typeof fetch }))
            .resolves.toBe('blob:mock-url');

        expect(fetcher).toHaveBeenCalledTimes(1);
        const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`https://cloud.example.com/v1/${attachment.cloudKey}`);
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
    });

    it('reuses the cached bytes but mints a fresh object URL per caller', async () => {
        const attachment = makeAttachment();
        const fetcher = okFetcher(new Uint8Array([1]));
        const options = { fetcher: fetcher as unknown as typeof fetch };

        await fetchWebCloudAttachmentBlob(attachment, options);
        await fetchWebCloudAttachmentBlob(attachment, options);

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    });

    it('evicts least-recently-used byte entries after the entry budget', async () => {
        const first = makeAttachment();
        const firstFetcher = okFetcher(new Uint8Array([1]));
        await fetchWebCloudAttachmentBlob(first, { fetcher: firstFetcher as unknown as typeof fetch });

        for (let index = 0; index < WEB_ATTACHMENT_BYTE_CACHE_MAX_ENTRIES; index += 1) {
            const fetcher = okFetcher(new Uint8Array([index]));
            await fetchWebCloudAttachmentBlob(makeAttachment(), { fetcher: fetcher as unknown as typeof fetch });
        }

        const refetcher = okFetcher(new Uint8Array([9]));
        await fetchWebCloudAttachmentBlob(first, { fetcher: refetcher as unknown as typeof fetch });
        expect(refetcher).toHaveBeenCalledTimes(1);
    });

    it('does not retain a single byte entry larger than the byte budget', async () => {
        const attachment = makeAttachment();
        const oversized = new Uint8Array(WEB_ATTACHMENT_BYTE_CACHE_MAX_BYTES + 1);
        await fetchWebCloudAttachmentBlob(attachment, {
            fetcher: okFetcher(oversized) as unknown as typeof fetch,
        });

        const refetcher = okFetcher(new Uint8Array([1]));
        await fetchWebCloudAttachmentBlob(attachment, { fetcher: refetcher as unknown as typeof fetch });
        expect(refetcher).toHaveBeenCalledTimes(1);
    });

    it('bounds externally opened object URLs and revokes retained URLs on clear', () => {
        for (let index = 0; index <= WEB_ATTACHMENT_OPEN_URL_MAX_ENTRIES; index += 1) {
            retainOpenedWebAttachmentUrl(`blob:opened-${index}`);
        }

        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:opened-0');
        clearWebAttachmentMemoryCaches();
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(WEB_ATTACHMENT_OPEN_URL_MAX_ENTRIES + 1);
    });

    it('decodes text attachments as UTF-8', async () => {
        const attachment = makeAttachment({ title: 'notes.txt' });
        const fetcher = okFetcher(new TextEncoder().encode('héllo'));

        await expect(fetchWebCloudAttachmentText(attachment, { fetcher: fetcher as unknown as typeof fetch }))
            .resolves.toBe('héllo');
    });

    it('returns null without a request when the attachment has no cloudKey', async () => {
        const fetcher = okFetcher(new Uint8Array([1]));
        const attachment = makeAttachment({ cloudKey: undefined });

        await expect(fetchWebCloudAttachmentBlob(attachment, { fetcher: fetcher as unknown as typeof fetch }))
            .resolves.toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('returns null for a non-cloud backend', async () => {
        syncState.backend = 'webdav';
        const fetcher = okFetcher(new Uint8Array([1]));

        await expect(fetchWebCloudAttachmentBlob(makeAttachment(), { fetcher: fetcher as unknown as typeof fetch }))
            .resolves.toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('returns null for the Dropbox cloud provider', async () => {
        syncState.provider = 'dropbox';
        const fetcher = okFetcher(new Uint8Array([1]));

        await expect(fetchWebCloudAttachmentBlob(makeAttachment(), { fetcher: fetcher as unknown as typeof fetch }))
            .resolves.toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('returns null when sync encryption is on (no key material in the web build)', async () => {
        syncState.encryption = { state: 'enabled' };
        const fetcher = okFetcher(new Uint8Array([1]));

        await expect(fetchWebCloudAttachmentBlob(makeAttachment(), { fetcher: fetcher as unknown as typeof fetch }))
            .resolves.toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('returns null and stays retryable after a failed request', async () => {
        const attachment = makeAttachment();
        const failing = vi.fn(async () => new Response('nope', { status: 500 }));
        const succeeding = okFetcher(new Uint8Array([9]));

        await expect(fetchWebCloudAttachmentBlob(attachment, { fetcher: failing as unknown as typeof fetch }))
            .resolves.toBeNull();
        await expect(fetchWebCloudAttachmentBlob(attachment, { fetcher: succeeding as unknown as typeof fetch }))
            .resolves.toBe('blob:mock-url');
        expect(succeeding).toHaveBeenCalledTimes(1);
    });
});
