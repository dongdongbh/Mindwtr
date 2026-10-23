// React Native's global fetch is the whatwg-fetch polyfill, which hands every
// result back to JavaScript through setTimeout(..., 0). Android pauses all
// JavaScript timers while the activity is paused (JavaTimerManager.onHostPause),
// and a headless instance starts paused. So a request made after the app went
// to the background completes on the network and then sits unresolved until
// the app is foregrounded again. A scheduled background sync froze at its first
// reply this way and held its WorkManager job open until Android killed it
// (#1001). XMLHttpRequest completes through a native event instead, and its
// timeout is enforced by OkHttp, so neither depends on a JavaScript timer.

import { getNativeUtf8TextNative } from '@/modules/native-utf8-text';
import { logInfo } from './app-log';

/** Ceiling for one request, enforced natively; foreground code keeps its own
 *  shorter JavaScript timeouts on top. */
export const BACKGROUND_SAFE_FETCH_NATIVE_TIMEOUT_MS = 5 * 60 * 1000;

let deadlineAt: number | null = null;

/** While set, no request may start after this time, and every request is cut
 *  short at it. The background sync job uses it as a deadline that holds even
 *  though its own timers do not fire. */
export const setBackgroundSafeFetchDeadline = (at: number | null): void => {
  deadlineAt = at;
};

/** Read back the deadline set above. CloudKit calls in cloudkit-sync.ts are
 *  not fetch requests, so they cannot share the enforcement above, but they
 *  share this same wall-clock deadline: it is checked before and after every
 *  native CloudKit call so a run resumed from suspension past its deadline
 *  aborts at once instead of starting (or trusting the result of) another one. */
export const getBackgroundSafeFetchDeadline = (): number | null => deadlineAt;

// Only React Native's XMLHttpRequest has the timer-free completion and the
// native timeout; a browser (the web build, tests) keeps its own fetch.
const hasNativeXhr = (): boolean => (
  typeof XMLHttpRequest === 'function' && typeof document === 'undefined'
);

const createAbortError = (message: string): Error => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

const parseResponseHeaders = (raw: string): Headers => {
  const headers = new Headers();
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!name) continue;
    try {
      headers.append(name, value);
    } catch {
      // A header the platform refuses to represent is not worth failing the request over.
    }
  }
  return headers;
};

type NativeText = { text: string; bytes: number };
type XhrBody = { buffer: () => ArrayBuffer; nativeText: () => NativeText | null };

let nativeTextLogged = false;

// #1434: Expo's TextDecoder is JavaScript, and a sync document of a few MB took seconds to decode in the
// background. Swift decodes it when it is valid UTF-8; any other body takes the JavaScript path as before.
const decodeNatively = (base64: string | null): NativeText | null => {
  if (base64 === null) return null;
  const native = getNativeUtf8TextNative();
  if (!native) return null;
  let text: unknown;
  try {
    text = native.decodeBase64Utf8(base64);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  const bytes = (base64.length / 4) * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (!nativeTextLogged) {
    nativeTextLogged = true;
    void logInfo('Response text decoded natively', {
      scope: 'sync', force: true, extra: { releaseCheck: 'v1.3.8/ios-native-text-decode', bytes: String(bytes) },
    }).catch(() => undefined);
  }
  return { text, bytes };
};

class XhrResponse {
  readonly body = null;
  readonly redirected = false;
  readonly type = 'basic' as const;
  bodyUsed = false;

  constructor(
    private readonly content: XhrBody,
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
    readonly headers: Headers,
  ) {}

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  /** Core's readDecodedResponseText (http-utils.ts) reads text() under its byte limit when this is set. */
  get mindwtrDecodedTextBytes(): number | undefined {
    return this.content.nativeText()?.bytes;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.bodyUsed = true;
    return this.content.buffer().slice(0);
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer());
  }

  async text(): Promise<string> {
    this.bodyUsed = true;
    return this.content.nativeText()?.text ?? new TextDecoder().decode(new Uint8Array(this.content.buffer()));
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  clone(): XhrResponse {
    return new XhrResponse(this.content, this.status, this.statusText, this.url, this.headers);
  }
}

const resolveRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const resolveRequestBody = (body: BodyInit | null | undefined): unknown => {
  if (body === null || body === undefined) return null;
  if (typeof URLSearchParams === 'function' && body instanceof URLSearchParams) return body.toString();
  if (typeof ReadableStream === 'function' && body instanceof ReadableStream) {
    throw new TypeError('Streaming request bodies are not supported on this platform');
  }
  return body;
};

export const backgroundSafeFetch: typeof fetch = (input, init) => {
  if (!hasNativeXhr()) return fetch(input, init);
  return xhrFetch(input, init);
};

const xhrFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise<Response>((resolve, reject) => {
  const url = resolveRequestUrl(input);
  const signal = init?.signal ?? null;
  if (signal?.aborted) {
    reject(signal.reason ?? createAbortError('Request cancelled'));
    return;
  }
  const now = Date.now();
  if (deadlineAt !== null && now >= deadlineAt) {
    reject(createAbortError('Mobile background sync deadline passed before the request started'));
    return;
  }

  const xhr = new XMLHttpRequest();
  let settled = false;
  const finish = (settle: () => void) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    settle();
  };
  const onAbort = () => {
    xhr.abort();
    finish(() => reject(signal?.reason ?? createAbortError('Request cancelled')));
  };

  xhr.open((init?.method ?? 'GET').toUpperCase(), url, true);
  xhr.responseType = 'arraybuffer';
  xhr.withCredentials = init?.credentials === 'include';
  const remainingMs = deadlineAt === null ? Infinity : Math.max(1, deadlineAt - now);
  xhr.timeout = Math.min(BACKGROUND_SAFE_FETCH_NATIVE_TIMEOUT_MS, remainingMs);
  new Headers(init?.headers ?? undefined).forEach((value, name) => {
    xhr.setRequestHeader(name, value);
  });

  xhr.onload = () => {
    // React Native keeps an 'arraybuffer' reply as the native side's base64 string and builds the
    // ArrayBuffer in JavaScript only when `response` is read, so a text read skips that step too.
    const nativeBase64 = (xhr as unknown as { _response?: unknown })._response;
    let buffer: ArrayBuffer | undefined;
    let nativeText: NativeText | null | undefined;
    const content: XhrBody = {
      buffer: () => {
        if (!buffer) {
          const raw = xhr.response as ArrayBuffer | null;
          buffer = raw instanceof ArrayBuffer ? raw : new ArrayBuffer(0);
        }
        return buffer;
      },
      nativeText: () => {
        if (nativeText === undefined) nativeText = decodeNatively(typeof nativeBase64 === 'string' ? nativeBase64 : null);
        return nativeText;
      },
    };
    finish(() => resolve(new XhrResponse(
      content,
      xhr.status,
      xhr.statusText ?? '',
      xhr.responseURL || url,
      parseResponseHeaders(xhr.getAllResponseHeaders() ?? ''),
    ) as unknown as Response));
  };
  xhr.onerror = () => finish(() => reject(new TypeError('Network request failed')));
  // Worded like a dropped connection so the sync classifies it as offline
  // (retry later, no failure banner) rather than as a server error.
  xhr.ontimeout = () => finish(() => reject(new TypeError(
    `Network request failed: no answer within ${Math.round(xhr.timeout / 1000)} s`,
  )));
  xhr.onabort = () => finish(() => reject(signal?.reason ?? createAbortError('Request cancelled')));

  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    xhr.send(resolveRequestBody(init?.body) as Document | XMLHttpRequestBodyInit | null);
  } catch (error) {
    finish(() => reject(error));
  }
});
