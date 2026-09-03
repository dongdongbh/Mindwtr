import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('falls back to the platform fetch where React Native XMLHttpRequest is absent', async () => {
    vi.unstubAllGlobals();
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const { backgroundSafeFetch } = await loadModule();
    const response = await backgroundSafeFetch('https://dav.example/a', { method: 'HEAD' });
    expect(fetchMock).toHaveBeenCalledWith('https://dav.example/a', { method: 'HEAD' });
    expect(await response.text()).toBe('ok');
  });
});
