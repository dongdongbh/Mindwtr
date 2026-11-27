import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocalWebdavFolder, localWebdavFetch } from './local-webdav';
import { invokeNative } from './tauri-invoke';

vi.mock('./tauri-invoke', () => ({ invokeNative: vi.fn() }));
vi.mock('./app-log', () => ({ logInfo: vi.fn() }));

const folder = 'http://127.0.0.1:6806/webdav/data/webDAV/mindwtr';
const document = folder + '/data.json';
const headers = { Authorization: 'Basic Zm9vOmJhcg==', 'If-Match': '"old"' };

describe('local desktop WebDAV', () => {
    beforeEach(() => vi.resetAllMocks());

    it('selects loopback SiYuan folders and ordinary data.json sync URLs', () => {
        expect(isLocalWebdavFolder(folder)).toBe(true);
        expect(isLocalWebdavFolder(document)).toBe(true);
        for (const url of ['https://remote.example/webdav/data/tasks', folder.replace('/webdav/data/', '/other/'), folder + '?token=x', folder + '/custom.json']) {
            expect(isLocalWebdavFolder(url)).toBe(false);
        }
    });

    it('preserves conditional headers and returns the native conflict status', async () => {
        const invoke = vi.mocked(invokeNative);
        const frame = new TextEncoder().encode('[412,{"etag":"new"}]\nconflict');
        invoke.mockResolvedValueOnce(3).mockResolvedValueOnce(frame.buffer).mockResolvedValueOnce(undefined);
        const response = await localWebdavFetch(folder, vi.fn())(document, { method: 'PUT', body: 'fixture', headers });
        expect(response.status).toBe(412);
        expect(response.headers.get('etag')).toBe('new');
        expect(await response.text()).toBe('conflict');
        expect(invoke).toHaveBeenNthCalledWith(1, 'local_webdav_prepare', { request: {
            folder, url: document, method: 'PUT', authorization: headers.Authorization,
            headers: { 'if-match': '"old"' }, body: [...new TextEncoder().encode('fixture')],
        } });
        expect(invoke).toHaveBeenLastCalledWith('local_webdav_close', { rid: 3 });
    });

    it('closes a prepared request without sending when canceled during preparation', async () => {
        const abort = new AbortController();
        const invoke = vi.mocked(invokeNative);
        invoke.mockImplementationOnce(async () => { abort.abort(); return 4; }).mockResolvedValueOnce(undefined);
        await expect(localWebdavFetch(folder, vi.fn())(document, { headers, signal: abort.signal })).rejects.toThrow();
        expect(invoke.mock.calls.map(([command]) => command)).toEqual(['local_webdav_prepare', 'local_webdav_close']);
    });
});
