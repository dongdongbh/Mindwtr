import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readResponseText, webdavPutJson } from '@mindwtr/core';

const nativeText = vi.hoisted(() => ({ module: null as null | { decodeBase64Utf8: (base64: string) => string | null } }));
const logInfo = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/modules/native-utf8-text', () => ({ getNativeUtf8TextNative: () => nativeText.module }));
vi.mock('./app-log', () => ({ logInfo }));

class FakeXhr {
  static instances: FakeXhr[] = [];
  method = '';
  url = '';
  responseType = '';
  withCredentials = false;
  timeout = 0;
  status = 0;
  statusText = '';
  responseURL = '';
  response: ArrayBuffer | null = null;
  headers: Record<string, string> = {};
  rawResponseHeaders = '';
  sentBody: unknown = undefined;
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.sentBody = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  getAllResponseHeaders() {
    return this.rawResponseHeaders;
  }
}

const loadModule = async () => import('./background-safe-fetch');

describe('backgroundSafeFetch', () => {
  beforeEach(() => {
    vi.resetModules();
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    vi.useFakeTimers();
    nativeText.module = null;
    logInfo.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves a reply through the XHR event with no JavaScript timer involved', async () => {
    const { backgroundSafeFetch } = await loadModule();
    const pending = backgroundSafeFetch('https://dav.example/data.json', {
      method: 'PUT',
      headers: { Authorization: 'Basic abc', 'If-Match': '"etag-1"' },
      body: '{"ok":true}',
    });
    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe('PUT');
    expect(xhr.responseType).toBe('arraybuffer');
    expect(xhr.headers).toMatchObject({ authorization: 'Basic abc', 'if-match': '"etag-1"' });
    expect(xhr.sentBody).toBe('{"ok":true}');
    expect(xhr.timeout).toBeGreaterThan(0);

    xhr.status = 200;
    xhr.statusText = 'OK';
    xhr.responseURL = 'https://dav.example/data.json';
    xhr.rawResponseHeaders = 'ETag: "etag-2"\r\nContent-Type: application/json\r\n';
    xhr.response = new TextEncoder().encode('{"hello":"wörld"}').buffer;
    xhr.onload?.();

    // Timers are never advanced: the promise must settle from the event alone.
    const response = await pending;
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"etag-2"');
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('{"hello":"wörld"}');
    expect(await response.clone().json()).toEqual({ hello: 'wörld' });
  });

  it('rejects network failures and native timeouts as offline-style errors', async () => {
    const { backgroundSafeFetch } = await loadModule();
    const failing = backgroundSafeFetch('https://dav.example/a');
    FakeXhr.instances[0].onerror?.();
    await expect(failing).rejects.toThrow(/network request failed/i);

    const timingOut = backgroundSafeFetch('https://dav.example/b');
    FakeXhr.instances[1].ontimeout?.();
    await expect(timingOut).rejects.toThrow(/network request failed/i);
  });

  it('aborts the request when the signal fires', async () => {
    const { backgroundSafeFetch } = await loadModule();
    const controller = new AbortController();
    const pending = backgroundSafeFetch('https://dav.example/a', { signal: controller.signal });
    controller.abort(new Error('lifecycle'));
    expect(FakeXhr.instances[0].aborted).toBe(true);
    await expect(pending).rejects.toThrow('lifecycle');
  });

  it('refuses to start past the deadline and caps in-flight requests at it', async () => {
    const { backgroundSafeFetch, setBackgroundSafeFetchDeadline, BACKGROUND_SAFE_FETCH_NATIVE_TIMEOUT_MS } = await loadModule();
    vi.setSystemTime(new Date('2026-09-02T20:00:00.000Z'));
    setBackgroundSafeFetchDeadline(Date.now() + 30_000);
    void backgroundSafeFetch('https://dav.example/a').catch(() => undefined);
    expect(FakeXhr.instances[0].timeout).toBe(30_000);

    setBackgroundSafeFetchDeadline(null);
    void backgroundSafeFetch('https://dav.example/b').catch(() => undefined);
    expect(FakeXhr.instances[1].timeout).toBe(BACKGROUND_SAFE_FETCH_NATIVE_TIMEOUT_MS);

    setBackgroundSafeFetchDeadline(Date.now() - 1);
    await expect(backgroundSafeFetch('https://dav.example/c')).rejects.toThrow(/deadline/);
    expect(FakeXhr.instances).toHaveLength(2);
  });

  it('fails a sync PUT whose redirect the Android client handed back unfollowed', async () => {
    const { backgroundSafeFetch } = await loadModule();
    const pending = webdavPutJson('https://dav.example/dav/data.json', { tasks: [] }, { fetcher: backgroundSafeFetch });
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe('PUT');
    xhr.status = 301;
    xhr.responseURL = xhr.url;
    xhr.response = new ArrayBuffer(0);
    xhr.onload?.();

    await expect(pending).rejects.toThrow('fetch failed: unexpected redirect');
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it('fails a sync PUT that the iOS client followed to another URL as a GET', async () => {
    // RCTHTTPRequestHandler follows a 303 on a PUT as a GET without the Authorization
    // header, and reports the GET's 200 with the final URL as responseURL.
    const { backgroundSafeFetch } = await loadModule();
    const pending = webdavPutJson('http://dav.example/dav/data.json', { tasks: [] }, {
      fetcher: backgroundSafeFetch,
      allowInsecureHttp: true,
    });
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0];
    xhr.status = 200;
    xhr.responseURL = 'https://dav.example/dav/data.json';
    xhr.rawResponseHeaders = 'ETag: "old"\r\n';
    xhr.response = new TextEncoder().encode('{"tasks":[]}').buffer;
    xhr.onload?.();

    await expect(pending).rejects.toThrow('fetch failed: unexpected redirect');
  });

  it('keeps a sync PUT whose native client reports the same URL in its own spelling', async () => {
    const { backgroundSafeFetch } = await loadModule();
    const pending = webdavPutJson('https://dav.example/dav/My Tasks/data.json', { tasks: [] }, {
      fetcher: backgroundSafeFetch,
    });
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0];
    xhr.status = 201;
    xhr.responseURL = 'https://dav.example:443/dav/My%20Tasks/data.json';
    xhr.rawResponseHeaders = 'ETag: "new"\r\n';
    xhr.response = new ArrayBuffer(0);
    xhr.onload?.();

    await expect(pending).resolves.not.toThrow();
  });

  it('falls back to the platform fetch where React Native XMLHttpRequest is absent', async () => {
    vi.unstubAllGlobals();
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const { backgroundSafeFetch } = await loadModule();
    const response = await backgroundSafeFetch('https://dav.example/a', { method: 'HEAD' });
    expect(fetchMock).toHaveBeenCalledWith('https://dav.example/a', { method: 'HEAD' });
    expect(await response.text()).toBe('ok');
  });

  describe('native UTF-8 text (#1434)', () => {
    const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
    // React Native's XHR holds an 'arraybuffer' reply as base64 in _response and decodes it only when response is read.
    const answer = (bytes: Uint8Array) => {
      const xhr = FakeXhr.instances[FakeXhr.instances.length - 1] as FakeXhr & { _response?: string };
      const responseRead = vi.fn(() => bytes.slice().buffer);
      xhr._response = toBase64(bytes);
      Object.defineProperty(xhr, 'response', { get: responseRead });
      xhr.status = 200;
      xhr.onload?.();
      return responseRead;
    };

    it('reads a valid UTF-8 body through Swift under core\'s byte limit, skipping the JavaScript buffer', async () => {
      const decode = vi.fn((base64: string) => new TextDecoder().decode(Buffer.from(base64, 'base64')));
      nativeText.module = { decodeBase64Utf8: decode };
      const { backgroundSafeFetch } = await loadModule();
      const bytes = new TextEncoder().encode('{"title":"wörld 任务 🎯"}');
      const pending = backgroundSafeFetch('https://cloud.example/v1/data');
      const responseRead = answer(bytes);
      const response = await pending;

      expect((response as { mindwtrDecodedTextBytes?: number }).mindwtrDecodedTextBytes).toBe(bytes.length);
      await expect(readResponseText(response, bytes.length)).resolves.toBe('{"title":"wörld 任务 🎯"}');
      await expect(readResponseText(response.clone(), bytes.length - 1)).rejects.toThrow();
      expect(decode).toHaveBeenCalledOnce();
      expect(responseRead).not.toHaveBeenCalled();
      expect(logInfo).toHaveBeenCalledOnce();
      expect(logInfo.mock.calls[0]).toEqual(['Response text decoded natively', expect.objectContaining({
        force: true, extra: { releaseCheck: 'v1.3.8/ios-native-text-decode', bytes: String(bytes.length) },
      })]);
    });

    it.each([1, 2, 3])('counts the bytes of a body whose base64 has padding for length mod 3 = %i', async (extra) => {
      nativeText.module = { decodeBase64Utf8: (base64) => new TextDecoder().decode(Buffer.from(base64, 'base64')) };
      const { backgroundSafeFetch } = await loadModule();
      const bytes = new TextEncoder().encode('abc'.repeat(4) + 'x'.repeat(extra));
      const pending = backgroundSafeFetch('https://cloud.example/v1/data');
      answer(bytes);
      expect(((await pending) as { mindwtrDecodedTextBytes?: number }).mindwtrDecodedTextBytes).toBe(bytes.length);
    });

    it('decodes invalid UTF-8 in JavaScript as before when Swift declines it', async () => {
      nativeText.module = { decodeBase64Utf8: vi.fn(() => null) };
      const { backgroundSafeFetch } = await loadModule();
      const bytes = new Uint8Array([0x7b, 0xff, 0x7d]);
      const pending = backgroundSafeFetch('https://cloud.example/v1/data');
      const responseRead = answer(bytes);
      const response = await pending;

      expect((response as { mindwtrDecodedTextBytes?: number }).mindwtrDecodedTextBytes).toBeUndefined();
      await expect(readResponseText(response, 100)).resolves.toBe(new TextDecoder().decode(bytes));
      expect(responseRead).toHaveBeenCalledOnce();
      expect(logInfo).not.toHaveBeenCalled();
    });

    it('never asks Swift about a binary read', async () => {
      const decode = vi.fn(() => 'unused');
      nativeText.module = { decodeBase64Utf8: decode };
      const { backgroundSafeFetch } = await loadModule();
      const bytes = new Uint8Array([0, 1, 2, 250]);
      const pending = backgroundSafeFetch('https://cloud.example/attachment');
      answer(bytes);
      expect(new Uint8Array(await (await pending).arrayBuffer())).toEqual(bytes);
      expect(decode).not.toHaveBeenCalled();
    });
  });
});
