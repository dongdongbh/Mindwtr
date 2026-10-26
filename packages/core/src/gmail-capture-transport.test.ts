import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it, vi } from 'vitest';
import { createGmailCaptureTransport as createTransport, parseGmailMessage as parseMessage, type GmailAuthorization } from './gmail-capture-transport';
import type { GmailReceiptConfig, GmailReceiptStore } from './gmail-receipt-store';
// Moved from apps/mobile/lib/gmail-capture-service.test.ts as is: these two bind the parser RN passes, as RN's binding does.
const createGmailCaptureTransport = (native: GmailAuthorization | null, getStore: () => GmailReceiptStore, newId = () => 'batch') => (
    createTransport(native, getStore, newId, DOMParser));
const parseGmailMessage = (value: unknown) => parseMessage(value, DOMParser);
const message = (id = 'm1', text = 'Body') => ({ id, labelIds: ['label'], payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Subject' }], body: { data: Buffer.from(text).toString('base64url'), size: Buffer.byteLength(text) } } });
function setup() {
    let config: GmailReceiptConfig = { account: 'account', label: 'label', enabled: true, blocked: false };
    const receipts = new Set<string>();
    const store: GmailReceiptStore = {
        config: () => config, configure: (value) => { config = value; },
        seen: (account, id) => receipts.has(`${account}:${id}`),
        acknowledge: vi.fn((account: string, ids: string[]) => { ids.forEach((id) => receipts.add(`${account}:${id}`)); }),
    };
    const state = { available: true, connected: true, account: 'test@example.invalid', accountId: 'account' };
    const native: GmailAuthorization = {
        status: vi.fn(async () => state), connect: vi.fn(async () => state), cancel: vi.fn(async () => {}),
        disconnect: vi.fn(async () => ({ revoked: true })),
        get: vi.fn(async (path) => path.startsWith('messages?') ? { messages: [{ id: 'm1' }] }
            : path.startsWith('messages/') ? message() : { id: 'label' }),
    };
    let sequence = 0;
    const transport = createGmailCaptureTransport(native, () => store, () => String(++sequence));
    return { transport, native, store, state, receipts };
}
describe('RN Gmail transport', () => {
    it('replays the exact unacknowledged batch, then skips durable receipts', async () => {
        const { transport, receipts } = setup();
        const batch = await transport.poll();
        expect(await transport.poll()).toEqual(batch);
        expect(receipts.size).toBe(0);
        await transport.commit(batch.batchId);
        expect((await transport.poll()).messages).toEqual([]);
    });
    it('does not acknowledge a wrong batch or a changed account', async () => {
        const { transport, store, state } = setup();
        const batch = await transport.poll();
        await expect(transport.commit('wrong')).rejects.toMatchObject({ kind: 'cancelled' });
        state.accountId = 'other';
        await expect(transport.commit(batch.batchId)).rejects.toMatchObject({ kind: 'cancelled' });
        expect(store.acknowledge).not.toHaveBeenCalled();
    });
    it('pauses durably before changing configuration, even when label lookup fails', async () => {
        const { transport, store, native } = setup();
        native.get = vi.fn(async () => { expect(store.config().blocked).toBe(true); throw { code: 'E_GMAIL_NETWORK' }; });
        await expect(transport.configure('other', true)).rejects.toMatchObject({ kind: 'network' });
        expect((await transport.status()).enabled).toBe(false);
    });
    it('rejects a late network result after disconnect and keeps receipts', async () => {
        const { transport, native, receipts, store } = setup();
        store.acknowledge('account', ['old']);
        let finish!: (value: unknown) => void;
        native.get = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
        const pending = transport.poll();
        await vi.waitFor(() => expect(native.get).toHaveBeenCalled());
        await transport.disconnect();
        finish({ messages: [] });
        await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
        expect(receipts.has('account:old')).toBe(true);
    });
    it('leaves failed acknowledgements replayable and does not advance pagination', async () => {
        const { transport, store } = setup();
        const batch = await transport.poll();
        store.acknowledge = vi.fn(() => { throw { kind: 'storage' }; });
        await expect(transport.commit(batch.batchId)).rejects.toMatchObject({ kind: 'storage' });
        expect(await transport.poll()).toEqual(batch);
    });
    it('skips messages no longer bearing the selected label', async () => {
        const { transport, native } = setup();
        native.get = vi.fn(async (path) => path.startsWith('messages?') ? { messages: [{ id: 'm1' }] } : { ...message(), labelIds: [] });
        expect((await transport.poll()).messages).toEqual([]);
    });
    it('does not let a stale auth failure disable a reconnected account', async () => {
        const { transport, native, store } = setup();
        let reject!: (error: unknown) => void;
        native.get = vi.fn((path) => path === 'labels'
            ? new Promise((_, fail) => { reject = fail; }) : Promise.resolve({ id: 'label' }));
        const old = transport.labels();
        await transport.connect();
        await transport.configure('label', true);
        reject({ code: 'E_GMAIL_AUTH' });
        await expect(old).rejects.toMatchObject({ kind: 'auth' });
        expect(store.config()).toMatchObject({ enabled: true, blocked: false });
        expect((await transport.status()).enabled).toBe(true);
    });
    it('blocks imports durably when access is revoked', async () => {
        const { transport, native, store } = setup();
        native.get = vi.fn(async () => { throw { code: 'E_GMAIL_AUTH' }; });
        await expect(transport.poll()).rejects.toMatchObject({ kind: 'auth' });
        expect(store.config()).toMatchObject({ blocked: true, enabled: false });
    });
    it('still cancels and disconnects native authorization when receipt storage fails', async () => {
        const { transport, native, store } = setup();
        store.configure = () => { throw { kind: 'storage' }; };
        await expect(transport.cancel()).rejects.toMatchObject({ kind: 'storage' });
        expect(native.cancel).toHaveBeenCalled();
        await expect(transport.disconnect()).rejects.toMatchObject({ kind: 'storage' });
        expect(native.disconnect).toHaveBeenCalled();
        expect((await transport.status()).enabled).toBe(false);
    });
    it('keeps the optional module unavailable without touching storage', async () => {
        const storage = vi.fn();
        expect((await createGmailCaptureTransport(null, storage).status()).available).toBe(false);
        expect(storage).not.toHaveBeenCalled();
    });
});
describe('bounded Gmail MIME parsing', () => {
    it('decodes UTF-8, ignores file attachments and prefers plain alternatives', () => {
        const plain = message('m1', 'Hello 🌊').payload;
        expect(parseGmailMessage({ ...message(), payload: { mimeType: 'multipart/mixed', parts: [
            { mimeType: 'multipart/alternative', parts: [{ ...plain, mimeType: 'text/html' }, plain] },
            { filename: 'private.txt', mimeType: 'text/plain', body: { attachmentId: 'x' } },
            { filename: '', headers: [{ name: 'Content-Disposition', value: 'attachment' }], mimeType: 'text/plain', body: { attachmentId: 'y' } },
        ] } }).bodyText).toBe('Hello 🌊');
    });
    it('extracts HTML text without script/style content', () => {
        const value = message('m1', '<p>Hello &amp; world</p><script>private()</script><p>Next</p>');
        value.payload.mimeType = 'text/html';
        expect(parseGmailMessage(value).bodyText).toBe('Hello & world\nNext');
    });
    it('rejects absent external body and malformed encoding instead of acknowledging empty mail', () => {
        expect(() => parseGmailMessage({ ...message(), payload: { mimeType: 'text/plain', body: { attachmentId: 'x', size: 20 } } })).toThrow();
        const truncated = message(); truncated.payload.body.size += 1;
        expect(() => parseGmailMessage(truncated)).toThrow();
        const value = message(); value.payload.body.data = 'invalid!';
        expect(() => parseGmailMessage(value)).toThrow();
    });
});

// Metro maps every core subpath to the barrel, so an XML parser imported here would ship in every bundle that uses core.
describe('core Gmail transport imports', () => {
    it('imports no XML parser; each host passes its own', async () => {
        const { readdirSync, readFileSync } = await import('node:fs');
        const sources = readdirSync(__dirname).filter((name) => name.endsWith('.ts') && !name.includes('.test.'));
        expect(sources.length).toBeGreaterThan(100);
        expect(sources.filter((name) => /from ['"]@xmldom\//.test(readFileSync(`${__dirname}/${name}`, 'utf8')))).toEqual([]);
    });
});
