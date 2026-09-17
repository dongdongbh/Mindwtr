import { randomUUID } from 'node:crypto';

const DRIVE_API_ROOT = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_ROOT = 'https://www.googleapis.com/upload/drive/v3';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 16_384;
const RUN_MARKER_PROPERTY = 'mindwtrCapabilityProbeRun';

export type GoogleDriveCapabilityProbeOutcome =
  | 'pass-observed-undocumented'
  | 'unsupported'
  | 'unsafe'
  | 'request-error';

export type GoogleDriveCapabilityProbeErrorCategory =
  | 'authorization-rejected'
  | 'cleanup-failed'
  | 'create-conflict'
  | 'create-denied'
  | 'create-id-mismatch'
  | 'create-request-error'
  | 'create-request-timeout'
  | 'duplicate-create-mutated-original'
  | 'duplicate-create-not-conflict'
  | 'etag-after-write-unsupported'
  | 'etag-unsupported'
  | 'fresh-etag-unchanged'
  | 'fresh-write-not-observed'
  | 'fresh-write-rejected'
  | 'generate-id-failed'
  | 'invalid-response'
  | 'ownership-not-proven'
  | 'request-failed'
  | 'request-timeout'
  | 'rejected-stale-write-mutated-content'
  | 'stale-write-accepted';

export type GoogleDriveCapabilityProbeStage =
  | 'not-started'
  | 'generate-id'
  | 'create'
  | 'duplicate-create'
  | 'initial-read'
  | 'media-fresh-write'
  | 'media-stale-write'
  | 'multipart-baseline'
  | 'multipart-fresh-write'
  | 'multipart-stale-write'
  | 'complete';

type EtagObservation = 'strong' | 'weak' | 'missing';

type ProbeStatusCodes = {
  generateId: number | null;
  create: number | null;
  duplicateCreate: number | null;
  initialMetadataRead: number | null;
  initialMediaRead: number | null;
  mediaFreshPatch: number | null;
  mediaStalePatch: number | null;
  multipartFreshPatch: number | null;
  multipartStalePatch: number | null;
  cleanupValidation: number | null;
  cleanupDelete: number | null;
};

type ProbeEtagObservations = {
  initialMetadata: EtagObservation | null;
  initialMedia: EtagObservation | null;
  afterMediaMetadata: EtagObservation | null;
  afterMediaMedia: EtagObservation | null;
  multipartBaselineMetadata: EtagObservation | null;
  multipartBaselineMedia: EtagObservation | null;
  afterMultipartMetadata: EtagObservation | null;
  afterMultipartMedia: EtagObservation | null;
};

type ProbeChecks = {
  createdIdMatched: boolean;
  duplicateReturnedConflict: boolean | null;
  duplicatePreservedOriginalBytes: boolean | null;
  mediaFreshChangedBytes: boolean | null;
  mediaFreshMetadataTagChanged: boolean | null;
  mediaFreshMediaTagChanged: boolean | null;
  mediaStaleRejected: boolean | null;
  mediaStalePreservedWinner: boolean | null;
  multipartFreshChangedBytes: boolean | null;
  multipartFreshMetadataTagChanged: boolean | null;
  multipartFreshMediaTagChanged: boolean | null;
  multipartStaleRejected: boolean | null;
  multipartStalePreservedWinner: boolean | null;
};

export type GoogleDriveCapabilityProbeReport = {
  outcome: GoogleDriveCapabilityProbeOutcome;
  errorCategory: GoogleDriveCapabilityProbeErrorCategory | null;
  completedStage: GoogleDriveCapabilityProbeStage;
  requestCount: number;
  statusCodes: ProbeStatusCodes;
  etags: ProbeEtagObservations;
  checks: ProbeChecks;
  cleanup: {
    ownershipProven: boolean;
    attempted: boolean;
    confirmed: boolean;
    outcome: 'not-attempted' | 'deleted' | 'already-absent' | 'failed';
  };
};

export type GoogleDriveCapabilityProbeOptions = {
  accessToken: string;
  allowTestWrites?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type GoogleDriveCapabilityProbeInputErrorCategory =
  | 'invalid-access-token'
  | 'invalid-timeout'
  | 'writes-not-authorized';

export class GoogleDriveCapabilityProbeInputError extends Error {
  readonly category: GoogleDriveCapabilityProbeInputErrorCategory;

  constructor(category: GoogleDriveCapabilityProbeInputErrorCategory) {
    super(category);
    this.name = 'GoogleDriveCapabilityProbeInputError';
    this.category = category;
  }
}

class ProbeStop extends Error {
  constructor(
    readonly outcome: GoogleDriveCapabilityProbeOutcome,
    readonly category: GoogleDriveCapabilityProbeErrorCategory,
    readonly stage: GoogleDriveCapabilityProbeStage,
  ) {
    super(category);
  }
}

class ProbeRequestError extends Error {
  constructor(readonly timedOut: boolean) {
    super(timedOut ? 'request-timeout' : 'request-failed');
  }
}

type MetadataRead = {
  idMatched: boolean;
  markerMatched: boolean;
  etag: string | null;
  etagObservation: EtagObservation;
};

type MediaRead = {
  bytes: string;
  etag: string | null;
  etagObservation: EtagObservation;
};

type ProbeContext = {
  accessToken: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  report: GoogleDriveCapabilityProbeReport;
};

const emptyReport = (): GoogleDriveCapabilityProbeReport => ({
  outcome: 'request-error',
  errorCategory: null,
  completedStage: 'not-started',
  requestCount: 0,
  statusCodes: {
    generateId: null,
    create: null,
    duplicateCreate: null,
    initialMetadataRead: null,
    initialMediaRead: null,
    mediaFreshPatch: null,
    mediaStalePatch: null,
    multipartFreshPatch: null,
    multipartStalePatch: null,
    cleanupValidation: null,
    cleanupDelete: null,
  },
  etags: {
    initialMetadata: null,
    initialMedia: null,
    afterMediaMetadata: null,
    afterMediaMedia: null,
    multipartBaselineMetadata: null,
    multipartBaselineMedia: null,
    afterMultipartMetadata: null,
    afterMultipartMedia: null,
  },
  checks: {
    createdIdMatched: false,
    duplicateReturnedConflict: null,
    duplicatePreservedOriginalBytes: null,
    mediaFreshChangedBytes: null,
    mediaFreshMetadataTagChanged: null,
    mediaFreshMediaTagChanged: null,
    mediaStaleRejected: null,
    mediaStalePreservedWinner: null,
    multipartFreshChangedBytes: null,
    multipartFreshMetadataTagChanged: null,
    multipartFreshMediaTagChanged: null,
    multipartStaleRejected: null,
    multipartStalePreservedWinner: null,
  },
  cleanup: {
    ownershipProven: false,
    attempted: false,
    confirmed: false,
    outcome: 'not-attempted',
  },
});

function stop(
  outcome: GoogleDriveCapabilityProbeOutcome,
  category: GoogleDriveCapabilityProbeErrorCategory,
  stage: GoogleDriveCapabilityProbeStage,
): never {
  throw new ProbeStop(outcome, category, stage);
}

const etagObservation = (etag: string | null): EtagObservation => {
  if (etag === null) return 'missing';
  if (etag.startsWith('W/')) return 'weak';
  return /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) ? 'strong' : 'weak';
};

const isStrongEtag = (etag: string | null): etag is string =>
  etagObservation(etag) === 'strong';

const responseBodies = new WeakMap<Response, string>();

const readBoundedText = async (response: Response, signal?: AbortSignal): Promise<string> => {
  const cached = responseBodies.get(response);
  if (cached !== undefined) return cached;
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    stop('request-error', 'invalid-response', 'initial-read');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new ProbeRequestError(true);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new ProbeRequestError(true);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        cancel();
        stop('request-error', 'invalid-response', 'initial-read');
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
};

const readJsonObject = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const parsed = JSON.parse(await readBoundedText(response));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    if (error instanceof ProbeStop) throw error;
  }
  stop('request-error', 'invalid-response', 'initial-read');
};

const request = async (
  context: ProbeContext,
  url: string,
  init: RequestInit = {},
): Promise<Response> => {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProbeRequestError(true));
    }, context.timeoutMs);
  });

  context.report.requestCount += 1;
  try {
    const responsePromise = (async () => {
      const response = await context.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${context.accessToken}`,
          ...init.headers,
        },
        redirect: 'error',
        signal: controller.signal,
      });
      // Keep the timeout active through the complete bounded response body,
      // including bodies from writes and errors that callers do not inspect.
      const body = await readBoundedText(response, controller.signal);
      responseBodies.set(response, body);
      return response;
    })();
    return await Promise.race([responsePromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof ProbeRequestError || error instanceof ProbeStop) throw error;
    throw new ProbeRequestError(timedOut || controller.signal.aborted);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
};

const multipartBody = (
  boundary: string,
  metadata: Record<string, unknown>,
  media: string,
): string => [
  `--${boundary}`,
  'Content-Type: application/json; charset=UTF-8',
  '',
  JSON.stringify(metadata),
  `--${boundary}`,
  'Content-Type: application/json',
  '',
  media,
  `--${boundary}--`,
  '',
].join('\r\n');

const authorizationOrStatusFailure = (
  response: Response,
  fallbackCategory: GoogleDriveCapabilityProbeErrorCategory,
  stage: GoogleDriveCapabilityProbeStage,
): never => {
  if (response.status === 401 || response.status === 403) {
    stop('request-error', 'authorization-rejected', stage);
  }
  return stop('request-error', fallbackCategory, stage);
};

const metadataUrl = (fileId: string): string =>
  `${DRIVE_API_ROOT}/files/${encodeURIComponent(fileId)}?fields=id%2CappProperties`;

const mediaUrl = (fileId: string): string =>
  `${DRIVE_API_ROOT}/files/${encodeURIComponent(fileId)}?alt=media`;

const mediaPatchUrl = (fileId: string): string =>
  `${DRIVE_UPLOAD_ROOT}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id`;

const multipartPatchUrl = (fileId: string): string =>
  `${DRIVE_UPLOAD_ROOT}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id`;

const readMetadata = async (
  context: ProbeContext,
  fileId: string,
  runMarker: string,
  stage: GoogleDriveCapabilityProbeStage,
): Promise<{ response: Response; metadata: MetadataRead }> => {
  const response = await request(context, metadataUrl(fileId));
  if (response.status !== 200) {
    authorizationOrStatusFailure(response, 'request-failed', stage);
  }
  const body = await readJsonObject(response);
  const appProperties = body.appProperties;
  const marker = appProperties && typeof appProperties === 'object' && !Array.isArray(appProperties)
    ? (appProperties as Record<string, unknown>)[RUN_MARKER_PROPERTY]
    : undefined;
  const etag = response.headers.get('etag');
  return {
    response,
    metadata: {
      idMatched: body.id === fileId,
      markerMatched: marker === runMarker,
      etag,
      etagObservation: etagObservation(etag),
    },
  };
};

const readMedia = async (
  context: ProbeContext,
  fileId: string,
  stage: GoogleDriveCapabilityProbeStage,
): Promise<{ response: Response; media: MediaRead }> => {
  const response = await request(context, mediaUrl(fileId));
  if (response.status !== 200) {
    authorizationOrStatusFailure(response, 'request-failed', stage);
  }
  const etag = response.headers.get('etag');
  return {
    response,
    media: {
      bytes: await readBoundedText(response),
      etag,
      etagObservation: etagObservation(etag),
    },
  };
};

const verifyOwnership = async (
  context: ProbeContext,
  fileId: string,
  runMarker: string,
): Promise<boolean> => {
  try {
    const response = await request(context, metadataUrl(fileId));
    if (response.status !== 200) return false;
    const body = await readJsonObject(response);
    const appProperties = body.appProperties;
    if (!appProperties || typeof appProperties !== 'object' || Array.isArray(appProperties)) {
      return false;
    }
    return body.id === fileId
      && (appProperties as Record<string, unknown>)[RUN_MARKER_PROPERTY] === runMarker;
  } catch {
    return false;
  }
};

const cleanup = async (
  context: ProbeContext,
  fileId: string,
  runMarker: string,
): Promise<void> => {
  context.report.cleanup.attempted = true;
  try {
    const validation = await request(context, metadataUrl(fileId));
    context.report.statusCodes.cleanupValidation = validation.status;
    if (validation.status === 404) {
      context.report.cleanup.confirmed = true;
      context.report.cleanup.outcome = 'already-absent';
      return;
    }
    if (validation.status !== 200) {
      context.report.cleanup.outcome = 'failed';
      return;
    }
    const body = await readJsonObject(validation);
    const appProperties = body.appProperties;
    const markerMatched = appProperties
      && typeof appProperties === 'object'
      && !Array.isArray(appProperties)
      && (appProperties as Record<string, unknown>)[RUN_MARKER_PROPERTY] === runMarker;
    if (body.id !== fileId || !markerMatched) {
      context.report.cleanup.outcome = 'failed';
      return;
    }

    const deletion = await request(context, `${DRIVE_API_ROOT}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    });
    context.report.statusCodes.cleanupDelete = deletion.status;
    if (deletion.status === 204) {
      context.report.cleanup.confirmed = true;
      context.report.cleanup.outcome = 'deleted';
    } else if (deletion.status === 404) {
      context.report.cleanup.confirmed = true;
      context.report.cleanup.outcome = 'already-absent';
    } else {
      context.report.cleanup.outcome = 'failed';
    }
  } catch {
    context.report.cleanup.outcome = 'failed';
  }
};

const assertOwnedMetadata = (
  metadata: MetadataRead,
  stage: GoogleDriveCapabilityProbeStage,
): void => {
  if (!metadata.idMatched || !metadata.markerMatched) {
    stop('unsafe', 'ownership-not-proven', stage);
  }
};

const runProbe = async (
  context: ProbeContext,
  fileId: string,
  runMarker: string,
  createBody: string,
  createBoundary: string,
  baselineBytes: string,
): Promise<void> => {
  const { report } = context;
  const createUrl = `${DRIVE_UPLOAD_ROOT}/files?uploadType=multipart&fields=id`;

  report.completedStage = 'create';
  let createResponse: Response;
  try {
    createResponse = await request(context, createUrl, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${createBoundary}` },
      body: createBody,
    });
  } catch (error) {
    report.cleanup.ownershipProven = await verifyOwnership(context, fileId, runMarker);
    stop(
      'request-error',
      error instanceof ProbeRequestError && error.timedOut
        ? 'create-request-timeout'
        : 'create-request-error',
      'create',
    );
  }
  report.statusCodes.create = createResponse.status;
  if (createResponse.status === 409) {
    stop('request-error', 'create-conflict', 'create');
  }
  if (createResponse.status !== 200) {
    if (createResponse.status === 401 || createResponse.status === 403) {
      stop('request-error', 'authorization-rejected', 'create');
    }
    stop('request-error', 'create-denied', 'create');
  }

  let createResult: Record<string, unknown>;
  try {
    createResult = await readJsonObject(createResponse);
  } catch {
    report.cleanup.ownershipProven = await verifyOwnership(context, fileId, runMarker);
    stop('request-error', 'invalid-response', 'create');
  }
  report.checks.createdIdMatched = createResult.id === fileId;
  if (!report.checks.createdIdMatched) {
    report.cleanup.ownershipProven = await verifyOwnership(context, fileId, runMarker);
    stop('unsafe', 'create-id-mismatch', 'create');
  }
  report.cleanup.ownershipProven = true;

  report.completedStage = 'duplicate-create';
  const duplicateResponse = await request(context, createUrl, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${createBoundary}` },
    body: createBody,
  });
  report.statusCodes.duplicateCreate = duplicateResponse.status;
  report.checks.duplicateReturnedConflict = duplicateResponse.status === 409;
  if (duplicateResponse.status === 401 || duplicateResponse.status === 403) {
    stop('request-error', 'authorization-rejected', 'duplicate-create');
  }
  if (duplicateResponse.status !== 409 && duplicateResponse.status !== 200) {
    stop('request-error', 'request-failed', 'duplicate-create');
  }

  const duplicateMediaRead = await readMedia(context, fileId, 'duplicate-create');
  report.checks.duplicatePreservedOriginalBytes = duplicateMediaRead.media.bytes === baselineBytes;
  if (!report.checks.duplicatePreservedOriginalBytes) {
    stop('unsafe', 'duplicate-create-mutated-original', 'duplicate-create');
  }
  if (!report.checks.duplicateReturnedConflict) {
    stop('unsafe', 'duplicate-create-not-conflict', 'duplicate-create');
  }

  report.completedStage = 'initial-read';
  const initialMetadataRead = await readMetadata(context, fileId, runMarker, 'initial-read');
  report.statusCodes.initialMetadataRead = initialMetadataRead.response.status;
  report.etags.initialMetadata = initialMetadataRead.metadata.etagObservation;
  assertOwnedMetadata(initialMetadataRead.metadata, 'initial-read');

  const initialMediaRead = await readMedia(context, fileId, 'initial-read');
  report.statusCodes.initialMediaRead = initialMediaRead.response.status;
  report.etags.initialMedia = initialMediaRead.media.etagObservation;
  if (initialMediaRead.media.bytes !== baselineBytes) {
    stop('unsafe', 'duplicate-create-mutated-original', 'initial-read');
  }
  if (!isStrongEtag(initialMetadataRead.metadata.etag)) {
    stop('unsupported', 'etag-unsupported', 'initial-read');
  }

  const mediaWinnerBytes = JSON.stringify({
    probe: 'mindwtr-google-drive-capability',
    run: runMarker,
    revision: 'media-winner',
  });
  const mediaLoserBytes = JSON.stringify({
    probe: 'mindwtr-google-drive-capability',
    run: runMarker,
    revision: 'media-stale',
  });

  report.completedStage = 'media-fresh-write';
  const mediaFreshResponse = await request(context, mediaPatchUrl(fileId), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': initialMetadataRead.metadata.etag,
    },
    body: mediaWinnerBytes,
  });
  report.statusCodes.mediaFreshPatch = mediaFreshResponse.status;
  if (mediaFreshResponse.status !== 200) {
    if (mediaFreshResponse.status === 401 || mediaFreshResponse.status === 403) {
      stop('request-error', 'authorization-rejected', 'media-fresh-write');
    }
    stop('unsupported', 'fresh-write-rejected', 'media-fresh-write');
  }

  const afterMediaMetadataRead = await readMetadata(context, fileId, runMarker, 'media-fresh-write');
  const afterMediaRead = await readMedia(context, fileId, 'media-fresh-write');
  report.etags.afterMediaMetadata = afterMediaMetadataRead.metadata.etagObservation;
  report.etags.afterMediaMedia = afterMediaRead.media.etagObservation;
  assertOwnedMetadata(afterMediaMetadataRead.metadata, 'media-fresh-write');
  report.checks.mediaFreshChangedBytes = afterMediaRead.media.bytes === mediaWinnerBytes;
  if (!report.checks.mediaFreshChangedBytes) {
    stop('unsafe', 'fresh-write-not-observed', 'media-fresh-write');
  }
  if (!isStrongEtag(afterMediaMetadataRead.metadata.etag)) {
    stop('unsupported', 'etag-after-write-unsupported', 'media-fresh-write');
  }
  report.checks.mediaFreshMetadataTagChanged =
    afterMediaMetadataRead.metadata.etag !== initialMetadataRead.metadata.etag;
  report.checks.mediaFreshMediaTagChanged =
    isStrongEtag(afterMediaRead.media.etag) && isStrongEtag(initialMediaRead.media.etag)
      ? afterMediaRead.media.etag !== initialMediaRead.media.etag : null;
  if (!report.checks.mediaFreshMetadataTagChanged) {
    stop('unsafe', 'fresh-etag-unchanged', 'media-fresh-write');
  }

  report.completedStage = 'media-stale-write';
  const mediaStaleResponse = await request(context, mediaPatchUrl(fileId), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': initialMetadataRead.metadata.etag,
    },
    body: mediaLoserBytes,
  });
  report.statusCodes.mediaStalePatch = mediaStaleResponse.status;
  report.checks.mediaStaleRejected = mediaStaleResponse.status === 412;
  if (mediaStaleResponse.status === 401 || mediaStaleResponse.status === 403) {
    stop('request-error', 'authorization-rejected', 'media-stale-write');
  }
  if (mediaStaleResponse.status !== 200 && mediaStaleResponse.status !== 412) {
    stop('unsupported', 'fresh-write-rejected', 'media-stale-write');
  }
  const afterMediaStaleRead = await readMedia(context, fileId, 'media-stale-write');
  report.checks.mediaStalePreservedWinner = afterMediaStaleRead.media.bytes === mediaWinnerBytes;
  if (!report.checks.mediaStalePreservedWinner) {
    stop('unsafe', 'rejected-stale-write-mutated-content', 'media-stale-write');
  }
  if (!report.checks.mediaStaleRejected) {
    stop('unsafe', 'stale-write-accepted', 'media-stale-write');
  }

  report.completedStage = 'multipart-baseline';
  const multipartBaselineMetadataRead = await readMetadata(
    context,
    fileId,
    runMarker,
    'multipart-baseline',
  );
  const multipartBaselineMediaRead = await readMedia(context, fileId, 'multipart-baseline');
  report.etags.multipartBaselineMetadata = multipartBaselineMetadataRead.metadata.etagObservation;
  report.etags.multipartBaselineMedia = multipartBaselineMediaRead.media.etagObservation;
  assertOwnedMetadata(multipartBaselineMetadataRead.metadata, 'multipart-baseline');
  if (multipartBaselineMediaRead.media.bytes !== mediaWinnerBytes) {
    stop('unsafe', 'fresh-write-not-observed', 'multipart-baseline');
  }
  if (!isStrongEtag(multipartBaselineMetadataRead.metadata.etag)) {
    stop('unsupported', 'etag-unsupported', 'multipart-baseline');
  }

  const multipartWinnerBytes = JSON.stringify({
    probe: 'mindwtr-google-drive-capability',
    run: runMarker,
    revision: 'multipart-winner',
  });
  const multipartLoserBytes = JSON.stringify({
    probe: 'mindwtr-google-drive-capability',
    run: runMarker,
    revision: 'multipart-stale',
  });
  const patchMetadata = {
    mimeType: 'application/json',
    appProperties: { [RUN_MARKER_PROPERTY]: runMarker },
  };
  const multipartFreshBoundary = `mindwtr-probe-${randomUUID()}`;

  report.completedStage = 'multipart-fresh-write';
  const multipartFreshResponse = await request(context, multipartPatchUrl(fileId), {
    method: 'PATCH',
    headers: {
      'Content-Type': `multipart/related; boundary=${multipartFreshBoundary}`,
      'If-Match': multipartBaselineMetadataRead.metadata.etag,
    },
    body: multipartBody(
      multipartFreshBoundary,
      patchMetadata,
      multipartWinnerBytes,
    ),
  });
  report.statusCodes.multipartFreshPatch = multipartFreshResponse.status;
  if (multipartFreshResponse.status !== 200) {
    if (multipartFreshResponse.status === 401 || multipartFreshResponse.status === 403) {
      stop('request-error', 'authorization-rejected', 'multipart-fresh-write');
    }
    stop('unsupported', 'fresh-write-rejected', 'multipart-fresh-write');
  }

  const afterMultipartMetadataRead = await readMetadata(
    context,
    fileId,
    runMarker,
    'multipart-fresh-write',
  );
  const afterMultipartMediaRead = await readMedia(context, fileId, 'multipart-fresh-write');
  report.etags.afterMultipartMetadata = afterMultipartMetadataRead.metadata.etagObservation;
  report.etags.afterMultipartMedia = afterMultipartMediaRead.media.etagObservation;
  assertOwnedMetadata(afterMultipartMetadataRead.metadata, 'multipart-fresh-write');
  report.checks.multipartFreshChangedBytes =
    afterMultipartMediaRead.media.bytes === multipartWinnerBytes;
  if (!report.checks.multipartFreshChangedBytes) {
    stop('unsafe', 'fresh-write-not-observed', 'multipart-fresh-write');
  }
  if (!isStrongEtag(afterMultipartMetadataRead.metadata.etag)) {
    stop('unsupported', 'etag-after-write-unsupported', 'multipart-fresh-write');
  }
  report.checks.multipartFreshMetadataTagChanged =
    afterMultipartMetadataRead.metadata.etag !== multipartBaselineMetadataRead.metadata.etag;
  report.checks.multipartFreshMediaTagChanged =
    isStrongEtag(afterMultipartMediaRead.media.etag) && isStrongEtag(multipartBaselineMediaRead.media.etag)
      ? afterMultipartMediaRead.media.etag !== multipartBaselineMediaRead.media.etag : null;
  if (!report.checks.multipartFreshMetadataTagChanged) {
    stop('unsafe', 'fresh-etag-unchanged', 'multipart-fresh-write');
  }

  const multipartStaleBoundary = `mindwtr-probe-${randomUUID()}`;
  report.completedStage = 'multipart-stale-write';
  const multipartStaleResponse = await request(context, multipartPatchUrl(fileId), {
    method: 'PATCH',
    headers: {
      'Content-Type': `multipart/related; boundary=${multipartStaleBoundary}`,
      'If-Match': multipartBaselineMetadataRead.metadata.etag,
    },
    body: multipartBody(
      multipartStaleBoundary,
      patchMetadata,
      multipartLoserBytes,
    ),
  });
  report.statusCodes.multipartStalePatch = multipartStaleResponse.status;
  report.checks.multipartStaleRejected = multipartStaleResponse.status === 412;
  if (multipartStaleResponse.status === 401 || multipartStaleResponse.status === 403) {
    stop('request-error', 'authorization-rejected', 'multipart-stale-write');
  }
  if (multipartStaleResponse.status !== 200 && multipartStaleResponse.status !== 412) {
    stop('unsupported', 'fresh-write-rejected', 'multipart-stale-write');
  }
  const afterMultipartStaleRead = await readMedia(context, fileId, 'multipart-stale-write');
  report.checks.multipartStalePreservedWinner =
    afterMultipartStaleRead.media.bytes === multipartWinnerBytes;
  if (!report.checks.multipartStalePreservedWinner) {
    stop('unsafe', 'rejected-stale-write-mutated-content', 'multipart-stale-write');
  }
  if (!report.checks.multipartStaleRejected) {
    stop('unsafe', 'stale-write-accepted', 'multipart-stale-write');
  }

  report.completedStage = 'complete';
  report.outcome = 'pass-observed-undocumented';
  report.errorCategory = null;
};

/**
 * Runs a destructive, caller-authorized probe against one generated Drive file.
 * The returned report intentionally excludes identifiers, token data, entity-tag
 * values, response bodies, and provider error messages.
 */
export const runGoogleDriveCapabilityProbe = async (
  options: GoogleDriveCapabilityProbeOptions,
): Promise<GoogleDriveCapabilityProbeReport> => {
  if (options.allowTestWrites !== true) {
    throw new GoogleDriveCapabilityProbeInputError('writes-not-authorized');
  }
  if (typeof options.accessToken !== 'string' || options.accessToken.trim().length === 0) {
    throw new GoogleDriveCapabilityProbeInputError('invalid-access-token');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new GoogleDriveCapabilityProbeInputError('invalid-timeout');
  }

  const report = emptyReport();
  const context: ProbeContext = {
    accessToken: options.accessToken,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs,
    report,
  };
  const runMarker = randomUUID();
  let fileId: string | null = null;

  try {
    report.completedStage = 'generate-id';
    const generatedIdResponse = await request(
      context,
      `${DRIVE_API_ROOT}/files/generateIds?count=1&space=drive&type=files`,
    );
    report.statusCodes.generateId = generatedIdResponse.status;
    if (generatedIdResponse.status !== 200) {
      if (generatedIdResponse.status === 401 || generatedIdResponse.status === 403) {
        stop('request-error', 'authorization-rejected', 'generate-id');
      }
      stop('request-error', 'generate-id-failed', 'generate-id');
    }
    const generatedIdBody = await readJsonObject(generatedIdResponse);
    const ids = generatedIdBody.ids;
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string' || ids[0].length === 0) {
      stop('request-error', 'invalid-response', 'generate-id');
    }
    fileId = ids[0];

    const baselineBytes = JSON.stringify({
      probe: 'mindwtr-google-drive-capability',
      run: runMarker,
      revision: 'baseline',
    });
    const createBoundary = `mindwtr-probe-${randomUUID()}`;
    const createMetadata = {
      id: fileId,
      name: `mindwtr-capability-probe-${randomUUID()}.json`,
      mimeType: 'application/json',
      appProperties: { [RUN_MARKER_PROPERTY]: runMarker },
    };
    await runProbe(
      context,
      fileId,
      runMarker,
      multipartBody(createBoundary, createMetadata, baselineBytes),
      createBoundary,
      baselineBytes,
    );
  } catch (error) {
    if (error instanceof ProbeStop) {
      report.outcome = error.outcome;
      report.errorCategory = error.category;
      // Shared body parsers do not know the caller's phase. Keep the phase
      // recorded immediately before the request when parsing fails.
      if (error.category !== 'invalid-response') report.completedStage = error.stage;
    } else if (error instanceof ProbeRequestError) {
      report.outcome = 'request-error';
      report.errorCategory = error.timedOut ? 'request-timeout' : 'request-failed';
    } else {
      report.outcome = 'request-error';
      report.errorCategory = 'request-failed';
    }
  } finally {
    if (fileId !== null && report.cleanup.ownershipProven) {
      await cleanup(context, fileId, runMarker);
      if (!report.cleanup.confirmed && report.outcome !== 'unsafe') {
        report.outcome = 'request-error';
        report.errorCategory = 'cleanup-failed';
      }
    }
  }

  return report;
};
