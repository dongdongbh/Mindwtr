import { describe, expect, test } from 'bun:test';

import {
  GoogleDriveCapabilityProbeInputError,
  runGoogleDriveCapabilityProbe,
} from './google-drive-capability-probe';

const GENERATED_ID = 'generated-drive-file-id';
const FOREIGN_ID = 'foreign-response-file-id';
const TEST_TOKEN = 'synthetic-test-access-token';
const MARKER_PROPERTY = 'mindwtrCapabilityProbeRun';

type CreateAmbiguity = 'none' | 'network-error' | 'timeout';
type StaleBehavior = 'reject' | 'accept' | 'accept-without-mutation' | 'reject-and-mutate';

type FakeDriveOptions = {
  generateStatus?: number;
  createStatus?: number;
  createAmbiguity?: CreateAmbiguity;
  ambiguousMarkerMatches?: boolean;
  createResponseId?: string;
  duplicateStatus?: number;
  duplicateMutatesBytes?: boolean;
  metadataEtag?: 'strong' | 'weak' | 'missing';
  mediaEtag?: 'strong' | 'weak' | 'missing';
  mediaStaleBehavior?: StaleBehavior;
  multipartStaleBehavior?: StaleBehavior;
  cleanupDeleteStatus?: number;
  tamperBeforeCleanup?: 'id' | 'marker';
};

type StoredFile = {
  id: string;
  marker: string;
  bytes: string;
  version: number;
};

const parseMultipart = (body: BodyInit | null | undefined) => {
  if (typeof body !== 'string') throw new Error('expected string multipart body');
  const jsonLines = body.split('\r\n').filter((line) => line.startsWith('{'));
  if (jsonLines.length !== 2) throw new Error('expected metadata and media JSON parts');
  return {
    metadata: JSON.parse(jsonLines[0]) as Record<string, unknown>,
    media: jsonLines[1],
  };
};

const headerValue = (headers: HeadersInit | undefined, name: string): string | null =>
  new Headers(headers).get(name);

class FakeDrive {
  readonly calls: Array<{ url: string; init: RequestInit }> = [];
  private file: StoredFile | null = null;
  private createAttempts = 0;

  constructor(private readonly options: FakeDriveOptions = {}) {}

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    this.calls.push({ url, init });
    const parsedUrl = new URL(url);
    const method = init.method ?? 'GET';

    if (parsedUrl.pathname === '/drive/v3/files/generateIds') {
      const status = this.options.generateStatus ?? 200;
      return status === 200
        ? Response.json({ ids: [GENERATED_ID], kind: 'drive#generatedIds', space: 'drive' })
        : new Response(null, { status });
    }

    if (parsedUrl.pathname === '/upload/drive/v3/files' && method === 'POST') {
      return this.handleCreate(init);
    }

    const filePath = `/drive/v3/files/${GENERATED_ID}`;
    const uploadFilePath = `/upload/drive/v3/files/${GENERATED_ID}`;
    if (parsedUrl.pathname === filePath && method === 'GET') {
      if (!this.file) return new Response(null, { status: 404 });
      if (parsedUrl.searchParams.get('alt') === 'media') {
        return new Response(this.file.bytes, {
          status: 200,
          headers: this.etagHeaders(this.options.mediaEtag ?? 'strong', 'media'),
        });
      }
      return Response.json(
        { id: this.file.id, appProperties: { [MARKER_PROPERTY]: this.file.marker } },
        { headers: this.etagHeaders(this.options.metadataEtag ?? 'strong', 'metadata') },
      );
    }

    if (parsedUrl.pathname === uploadFilePath && method === 'PATCH') {
      const uploadType = parsedUrl.searchParams.get('uploadType');
      if (uploadType === 'media') {
        return this.handlePatch(init, String(init.body), this.options.mediaStaleBehavior ?? 'reject');
      }
      if (uploadType === 'multipart') {
        const response = this.handlePatch(
          init,
          parseMultipart(init.body).media,
          this.options.multipartStaleBehavior ?? 'reject',
        );
        if (response.status === 412 && this.file) {
          if (this.options.tamperBeforeCleanup === 'id') this.file.id = FOREIGN_ID;
          if (this.options.tamperBeforeCleanup === 'marker') this.file.marker = 'foreign-marker';
        }
        return response;
      }
    }

    if (parsedUrl.pathname === filePath && method === 'DELETE') {
      const status = this.options.cleanupDeleteStatus ?? 204;
      if (status === 204 || status === 404) this.file = null;
      return new Response(null, { status });
    }

    throw new Error(`unexpected request: ${method} ${parsedUrl.pathname}${parsedUrl.search}`);
  };

  private handleCreate(init: RequestInit): Response | Promise<Response> {
    this.createAttempts += 1;
    const parsed = parseMultipart(init.body);
    const marker = (parsed.metadata.appProperties as Record<string, unknown>)[MARKER_PROPERTY];
    if (typeof marker !== 'string') throw new Error('probe marker missing');
    if (parsed.metadata.id !== GENERATED_ID) throw new Error('generated id was not used for create');

    if (this.createAttempts === 1) {
      const status = this.options.createStatus ?? 200;
      if (status !== 200) return new Response(null, { status });
      this.file = {
        id: GENERATED_ID,
        marker: this.options.ambiguousMarkerMatches === false ? 'foreign-marker' : marker,
        bytes: parsed.media,
        version: 1,
      };
      if (this.options.createAmbiguity === 'network-error') {
        throw new TypeError('private provider network detail');
      }
      if (this.options.createAmbiguity === 'timeout') {
        return new Promise((_, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('private provider abort detail', 'AbortError')),
            { once: true },
          );
        });
      }
      return Response.json({ id: this.options.createResponseId ?? GENERATED_ID });
    }

    const status = this.options.duplicateStatus ?? 409;
    if (this.options.duplicateMutatesBytes && this.file) {
      this.file.bytes = JSON.stringify({ changedByDuplicate: true });
      this.file.version += 1;
    }
    return status === 200
      ? Response.json({ id: GENERATED_ID })
      : new Response(null, { status });
  }

  private handlePatch(init: RequestInit, bytes: string, staleBehavior: StaleBehavior): Response {
    if (!this.file) return new Response(null, { status: 404 });
    const isFresh = headerValue(init.headers, 'if-match') === this.metadataTag();
    if (isFresh || staleBehavior === 'accept') {
      this.file.bytes = bytes;
      this.file.version += 1;
      return Response.json({ id: GENERATED_ID });
    }
    if (staleBehavior === 'accept-without-mutation') {
      return Response.json({ id: GENERATED_ID });
    }
    if (staleBehavior === 'reject-and-mutate') this.file.bytes = bytes;
    return new Response(null, { status: 412 });
  }

  private metadataTag(): string {
    return `"drive-metadata-etag-${this.file?.version ?? 0}"`;
  }

  private mediaTag(): string {
    return `"drive-media-etag-${this.file?.version ?? 0}"`;
  }

  private etagHeaders(
    kind: 'strong' | 'weak' | 'missing',
    surface: 'metadata' | 'media',
  ): HeadersInit {
    if (kind === 'missing') return {};
    const tag = surface === 'metadata' ? this.metadataTag() : this.mediaTag();
    return { ETag: kind === 'weak' ? `W/${tag}` : tag };
  }
}

const runWithFake = async (options: FakeDriveOptions = {}, timeoutMs = 100) => {
  const drive = new FakeDrive(options);
  const report = await runGoogleDriveCapabilityProbe({
    accessToken: TEST_TOKEN,
    allowTestWrites: true,
    fetchImpl: drive.fetch,
    timeoutMs,
  });
  return { drive, report };
};

describe('runGoogleDriveCapabilityProbe', () => {
  test('refuses writes before any network activity unless explicitly authorized', async () => {
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(null, { status: 500 });
    };
    await expect(runGoogleDriveCapabilityProbe({
      accessToken: TEST_TOKEN,
      fetchImpl,
    })).rejects.toMatchObject<Partial<GoogleDriveCapabilityProbeInputError>>({
      name: 'GoogleDriveCapabilityProbeInputError',
      category: 'writes-not-authorized',
    });
    expect(requestCount).toBe(0);
  });

  test('rejects invalid local input without making a request', async () => {
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response(null, { status: 500 });
    };
    await expect(runGoogleDriveCapabilityProbe({
      accessToken: '', allowTestWrites: true, fetchImpl,
    })).rejects.toMatchObject({ category: 'invalid-access-token' });
    await expect(runGoogleDriveCapabilityProbe({
      accessToken: TEST_TOKEN, allowTestWrites: true, fetchImpl, timeoutMs: 0,
    })).rejects.toMatchObject({ category: 'invalid-timeout' });
    expect(requestCount).toBe(0);
  });

  test('observes the full same-id, media-CAS, multipart-CAS, and exact cleanup sequence', async () => {
    const { drive, report } = await runWithFake();
    expect(report.outcome).toBe('pass-observed-undocumented');
    expect(report.errorCategory).toBeNull();
    expect(report.completedStage).toBe('complete');
    expect(report.requestCount).toBe(20);
    expect(report.statusCodes).toMatchObject({
      generateId: 200, create: 200, duplicateCreate: 409,
      mediaFreshPatch: 200, mediaStalePatch: 412,
      multipartFreshPatch: 200, multipartStalePatch: 412,
      cleanupValidation: 200, cleanupDelete: 204,
    });
    expect(report.checks).toEqual({
      createdIdMatched: true,
      duplicateReturnedConflict: true,
      duplicatePreservedOriginalBytes: true,
      mediaFreshChangedBytes: true,
      mediaFreshMetadataTagChanged: true,
      mediaFreshMediaTagChanged: true,
      mediaStaleRejected: true,
      mediaStalePreservedWinner: true,
      multipartFreshChangedBytes: true,
      multipartFreshMetadataTagChanged: true,
      multipartFreshMediaTagChanged: true,
      multipartStaleRejected: true,
      multipartStalePreservedWinner: true,
    });
    expect(report.cleanup).toEqual({
      ownershipProven: true, attempted: true, confirmed: true, outcome: 'deleted',
    });
    for (const call of drive.calls) {
      const url = new URL(call.url);
      expect(url.origin).toBe('https://www.googleapis.com');
      expect(url.pathname.startsWith('/drive/v3') || url.pathname.startsWith('/upload/drive/v3')).toBeTrue();
      expect(call.init.redirect).toBe('error');
    }
    expect(drive.calls.some(({ url }) => new URL(url).searchParams.has('q'))).toBeFalse();
    expect(drive.calls.some(({ url }) => url.includes(FOREIGN_ID))).toBeFalse();
    expect(drive.calls.every(({ url }) => !url.includes('appDataFolder'))).toBeTrue();
    const generateCall = drive.calls.find(({ url }) => url.includes('/files/generateIds'));
    expect(new URL(generateCall!.url).searchParams.get('space')).toBe('drive');
  });

  test.each([
    ['missing', 'strong'], ['weak', 'strong'],
  ] as const)('reports unsupported when the metadata ETag is %s', async (metadataEtag, mediaEtag) => {
    const { report } = await runWithFake({ metadataEtag, mediaEtag });
    expect(report.outcome).toBe('unsupported');
    expect(report.errorCategory).toBe('etag-unsupported');
    expect(report.etags.initialMetadata).toBe(metadataEtag);
    expect(report.etags.initialMedia).toBe(mediaEtag);
    expect(report.cleanup.confirmed).toBeTrue();
  });

  test.each(['missing', 'weak'] as const)(
    'observes a %s media ETag independently without blocking metadata-conditional writes',
    async (mediaEtag) => {
      const { report } = await runWithFake({ mediaEtag });
      expect(report.outcome).toBe('pass-observed-undocumented');
      expect(report.etags.initialMetadata).toBe('strong');
      expect(report.etags.initialMedia).toBe(mediaEtag);
      expect(report.checks.mediaFreshMetadataTagChanged).toBeTrue();
      expect(report.checks.mediaFreshMediaTagChanged).toBeNull();
    },
  );

  test.each([
    ['media', { mediaStaleBehavior: 'accept' }],
    ['multipart', { multipartStaleBehavior: 'accept' }],
  ] as const)('reports unsafe when a stale conditional %s write is accepted', async (_kind, options) => {
    const { report } = await runWithFake(options);
    expect(report.outcome).toBe('unsafe');
    expect(report.errorCategory).toBe('rejected-stale-write-mutated-content');
  });

  test.each([
    ['media', { mediaStaleBehavior: 'accept-without-mutation' }],
    ['multipart', { multipartStaleBehavior: 'accept-without-mutation' }],
  ] as const)(
    'reports unsafe when stale conditional %s returns 200 even if winner bytes remain',
    async (_kind, options) => {
      const { report } = await runWithFake(options);
      expect(report.outcome).toBe('unsafe');
      expect(report.errorCategory).toBe('stale-write-accepted');
    },
  );

  test.each([
    ['media', { mediaStaleBehavior: 'reject-and-mutate' }],
    ['multipart', { multipartStaleBehavior: 'reject-and-mutate' }],
  ] as const)('reports unsafe when a 412 %s response still changes bytes', async (_kind, options) => {
    const { report } = await runWithFake(options);
    expect(report.outcome).toBe('unsafe');
    expect(report.errorCategory).toBe('rejected-stale-write-mutated-content');
  });

  test('reports unsafe when duplicate create returns 409 but original bytes changed', async () => {
    const { report } = await runWithFake({ duplicateMutatesBytes: true });
    expect(report.outcome).toBe('unsafe');
    expect(report.errorCategory).toBe('duplicate-create-mutated-original');
    expect(report.statusCodes.duplicateCreate).toBe(409);
    expect(report.checks.duplicatePreservedOriginalBytes).toBeFalse();
  });

  test.each([401, 403])('reports expired or rejected authorization status %d', async (generateStatus) => {
    const { report } = await runWithFake({ generateStatus });
    expect(report.outcome).toBe('request-error');
    expect(report.errorCategory).toBe('authorization-rejected');
    expect(report.statusCodes.generateId).toBe(generateStatus);
    expect(report.cleanup.attempted).toBeFalse();
  });

  test('reports denied create without trying to delete an unowned file', async () => {
    const { drive, report } = await runWithFake({ createStatus: 403 });
    expect(report.outcome).toBe('request-error');
    expect(report.errorCategory).toBe('authorization-rejected');
    expect(report.statusCodes.create).toBe(403);
    expect(report.cleanup.ownershipProven).toBeFalse();
    expect(report.cleanup.attempted).toBeFalse();
    expect(drive.calls.some(({ init }) => init.method === 'DELETE')).toBeFalse();
  });

  test('never assumes ownership or deletes after an initial create conflict', async () => {
    const { drive, report } = await runWithFake({ createStatus: 409 });
    expect(report.outcome).toBe('request-error');
    expect(report.errorCategory).toBe('create-conflict');
    expect(report.cleanup.ownershipProven).toBeFalse();
    expect(report.cleanup.attempted).toBeFalse();
    expect(drive.calls.some(({ init }) => init.method === 'DELETE')).toBeFalse();
  });

  test('bounds an ambiguous create timeout, verifies its marker, then cleans up exact id', async () => {
    const startedAt = performance.now();
    const { report } = await runWithFake({
      createAmbiguity: 'timeout', ambiguousMarkerMatches: true,
    }, 20);
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(report.outcome).toBe('request-error');
    expect(report.errorCategory).toBe('create-request-timeout');
    expect(report.cleanup.ownershipProven).toBeTrue();
    expect(report.cleanup.confirmed).toBeTrue();
    expect(report.cleanup.outcome).toBe('deleted');
  });

  test('bounds response body consumption when headers arrive but the body stalls', async () => {
    const stalledBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
    });
    const fetchImpl: typeof fetch = async () => new Response(stalledBody, { status: 200 });
    const startedAt = performance.now();
    const report = await runGoogleDriveCapabilityProbe({
      accessToken: TEST_TOKEN,
      allowTestWrites: true,
      fetchImpl,
      timeoutMs: 20,
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(report.outcome).toBe('request-error');
    expect(report.errorCategory).toBe('request-timeout');
    expect(report.completedStage).toBe('generate-id');
    expect(report.cleanup.attempted).toBeFalse();
  });

  test('does not clean up an ambiguous create whose private marker does not match', async () => {
    const { drive, report } = await runWithFake({
      createAmbiguity: 'network-error', ambiguousMarkerMatches: false,
    });
    expect(report.outcome).toBe('request-error');
    expect(report.errorCategory).toBe('create-request-error');
    expect(report.cleanup.ownershipProven).toBeFalse();
    expect(report.cleanup.attempted).toBeFalse();
    expect(drive.calls.some(({ init }) => init.method === 'DELETE')).toBeFalse();
  });

  test('validates only the generated id after a mismatched create response id', async () => {
    const { drive, report } = await runWithFake({ createResponseId: FOREIGN_ID });
    expect(report.outcome).toBe('unsafe');
    expect(report.errorCategory).toBe('create-id-mismatch');
    expect(report.checks.createdIdMatched).toBeFalse();
    expect(report.cleanup.ownershipProven).toBeTrue();
    expect(report.cleanup.confirmed).toBeTrue();
    expect(drive.calls.every(({ url }) => !url.includes(FOREIGN_ID))).toBeTrue();
  });

  test('reports cleanup failure without deleting by name or enumerating files', async () => {
    const { drive, report } = await runWithFake({ cleanupDeleteStatus: 500 });
    expect(report.outcome).toBe('request-error');
    expect(report.errorCategory).toBe('cleanup-failed');
    expect(report.cleanup).toMatchObject({
      ownershipProven: true, attempted: true, confirmed: false, outcome: 'failed',
    });
    expect(report.statusCodes.cleanupDelete).toBe(500);
    expect(drive.calls.some(({ url }) => new URL(url).searchParams.has('q'))).toBeFalse();
  });

  test.each(['id', 'marker'] as const)(
    'does not DELETE when cleanup ownership %s revalidation no longer matches',
    async (tamperBeforeCleanup) => {
      const { drive, report } = await runWithFake({ tamperBeforeCleanup });
      expect(report.outcome).toBe('request-error');
      expect(report.errorCategory).toBe('cleanup-failed');
      expect(report.cleanup).toEqual({
        ownershipProven: true,
        attempted: true,
        confirmed: false,
        outcome: 'failed',
      });
      expect(report.statusCodes.cleanupValidation).toBe(200);
      expect(report.statusCodes.cleanupDelete).toBeNull();
      expect(drive.calls.some(({ init }) => init.method === 'DELETE')).toBeFalse();
    },
  );

  test('never logs or returns private request material', async () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.log = (...args) => logged.push(args);
    console.warn = (...args) => logged.push(args);
    console.error = (...args) => logged.push(args);
    try {
      const { drive, report } = await runWithFake({ createResponseId: FOREIGN_ID });
      const serializedReport = JSON.stringify(report);
      const requestMaterial = drive.calls.map(({ url, init }) => `${url}\n${String(init.body ?? '')}`).join('\n');
      const syntheticName = requestMaterial.match(/mindwtr-capability-probe-[a-f0-9-]+\.json/)?.[0];
      const marker = requestMaterial.match(/"mindwtrCapabilityProbeRun":"([a-f0-9-]+)"/)?.[1];
      expect(logged).toEqual([]);
      for (const privateValue of [
        TEST_TOKEN,
        GENERATED_ID,
        FOREIGN_ID,
        '"drive-metadata-etag-1"',
        '"drive-media-etag-1"',
      ]) {
        expect(serializedReport).not.toContain(privateValue);
      }
      expect(syntheticName).toBeDefined();
      expect(marker).toBeDefined();
      expect(serializedReport).not.toContain(syntheticName!);
      expect(serializedReport).not.toContain(marker!);
      expect(serializedReport).not.toContain('private provider');
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  });
});
