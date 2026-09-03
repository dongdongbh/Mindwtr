/**
 * Guard for #1001. React Native on Android pauses every JavaScript timer while
 * the app is off screen; anything on the background sync path that waits on a
 * timer freezes there and holds the WorkManager job until Android kills it.
 * This test freezes timers the same way and drives the real WebDAV client,
 * retry helper, and mobile fetch through a fake native XMLHttpRequest. If a
 * timer creeps back into that path, the promises below never settle and the
 * test times out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reactNativeMock = vi.hoisted(() => ({
  AppState: { currentState: 'background' as string },
  Platform: { OS: 'android' as string },
}));
vi.mock('react-native', () => reactNativeMock);

type Answer = { status: number; body?: string; headers?: Record<string, string> };

class FakeNativeXhr {
  static answer: (method: string, url: string) => Answer = () => ({ status: 404 });
  static requests: Array<{ method: string; url: string }> = [];
  method = '';
  url = '';
  responseType = '';
  withCredentials = false;
  timeout = 0;
  status = 0;
  statusText = '';
  responseURL = '';
  response: ArrayBuffer | null = null;
  private rawHeaders = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  abort() {
    this.onabort?.();
  }
  getAllResponseHeaders() {
    return this.rawHeaders;
  }
  send() {
    FakeNativeXhr.requests.push({ method: this.method, url: this.url });
    const answer = FakeNativeXhr.answer(this.method, this.url);
    // Native completion arrives as an event on a later tick, never via a timer.
    queueMicrotask(() => {
      this.status = answer.status;
      this.statusText = answer.status === 200 ? 'OK' : 'Not Found';
      this.responseURL = this.url;
      this.response = new TextEncoder().encode(answer.body ?? '').buffer;
      this.rawHeaders = Object.entries(answer.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      this.onload?.();
    });
  }
}

const inertTimer = (() => 0) as unknown as typeof setTimeout;

describe('background sync path with JavaScript timers frozen', () => {
  beforeEach(() => {
    FakeNativeXhr.requests = [];
    vi.stubGlobal('XMLHttpRequest', FakeNativeXhr);
    // Not fake timers: frozen ones. Nothing scheduled here ever runs.
    vi.stubGlobal('setTimeout', inertTimer);
    vi.stubGlobal('setInterval', inertTimer);
    reactNativeMock.AppState.currentState = 'background';
    reactNativeMock.Platform.OS = 'android';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and heads a WebDAV sync document through the real client', async () => {
    const { webdavGetSyncDocument, webdavHeadFile } = await import('@mindwtr/core');
    const { backgroundSafeFetch } = await import('./background-safe-fetch');
    await import('./js-timers');
    const headAnswer: Answer = { status: 200, headers: { ETag: '"v7"', 'Content-Length': '17' } };
    const getAnswer: Answer = { status: 200, body: '{"tasks":[],"v":7}', headers: { ETag: '"v7"', 'Content-Type': 'application/json' } };
    FakeNativeXhr.answer = (method) => (method === 'HEAD' ? headAnswer : getAnswer);

    const head = await webdavHeadFile('https://dav.example/Mindwtr/data.json', { fetcher: backgroundSafeFetch, timeoutMs: 1_000 });
    expect(head.exists).toBe(true);

    const read = await webdavGetSyncDocument<{ v: number }>('https://dav.example/Mindwtr/data.json', {
      fetcher: backgroundSafeFetch,
      timeoutMs: 1_000,
    });
    expect(read).toMatchObject({ exists: true, data: { tasks: [], v: 7 } });
    expect(FakeNativeXhr.requests.map((r) => r.method)).toEqual(['HEAD', 'GET']);
  }, 30_000);

  it('retries a failed request without sleeping', async () => {
    const { withRetry } = await import('@mindwtr/core');
    await import('./js-timers');
    let attempts = 0;
    const value = await withRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('Network request failed');
      return 'ok';
    }, { maxAttempts: 3, baseDelayMs: 60_000 });
    expect(value).toBe('ok');
    expect(attempts).toBe(3);
  }, 30_000);
});
