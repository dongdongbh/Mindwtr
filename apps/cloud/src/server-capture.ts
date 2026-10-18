import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import {
    ATTACHMENTS_DIR_NAME,
    buildCloudKey,
    generateUUID,
    shouldSendTaskReminders,
    type AppData,
    type Attachment,
    type Task,
} from '@mindwtr/core';
import {
    CLOUD_API_REV_BY,
    errorResponse,
    jsonResponse,
    logInfo,
    logWarn,
    MAX_TASK_TITLE_LENGTH,
} from './server-config';
import {
    abandonPreparedFilePublication,
    durablyRemoveFile,
    isBodyReadError,
    prepareFilePublicationSafely,
    publishPreparedFilePublication,
    readRequestBytes,
    resolveAttachmentPath,
    throwIfRequestAborted,
    type PreparedFilePublication,
} from './server-storage';
import { loadAppDataOrError, writeCloudData } from './server-data-cache';
import { getBlockedAttachmentSignature } from './server-attachments';

/** Generic capture webhook path. Deliberately vendor-neutral: any watch, phone
 *  shortcut, script, or automation that can post a transcription may use it. */
export const CAPTURE_ROUTE_PATH = '/v1/capture';

/** Audio types a capture may attach, and the file extension stored for each.
 *  Anything else is refused rather than stored under a guessed extension. */
const AUDIO_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
};

/** A recording clock may run slightly ahead of the server's. Anything further
 *  into the future than this is not a real capture time, so `now` is used. */
/** Own-property lookup only: a bare index would accept inherited keys such as
 *  `constructor` and store the bytes under an undefined extension. */
const audioExtensionFor = (mimeType: string): string | undefined => (
    Object.prototype.hasOwnProperty.call(AUDIO_EXTENSION_BY_MIME_TYPE, mimeType)
        ? AUDIO_EXTENSION_BY_MIME_TYPE[mimeType]
        : undefined
);

const RECORDED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

const MAX_ATTACHMENT_TITLE_LENGTH = 120;

const normalizeContentType = (value: string | null): string => (
    value?.split(';', 1)[0]?.trim().toLowerCase() || ''
);

/** Strips line breaks and control characters from text that ends up in a stored
 *  title. The cloud key never uses it (that is `<attachment id>.<ext>`), but the
 *  synced document does. */
const sanitizeSingleLine = (value: string, maxLength: number): string => (
    // eslint-disable-next-line no-control-regex -- Stripping C0/C1 controls is the point.
    value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
);

const firstString = (...values: unknown[]): string => {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return '';
};

/** `recordedAt` as milliseconds since the epoch, from either an integer (what a
 *  recorder's multipart form typically sends) or an ISO 8601 string. */
export const parseRecordedAtMs = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+$/.test(trimmed)) {
        const asNumber = Number(trimmed);
        return Number.isFinite(asNumber) ? asNumber : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
};

/** `createdAt` for the captured task: the recording time when it parses and is
 *  not implausibly in the future, otherwise the server's clock. */
export const resolveCaptureCreatedAt = (recordedAtMs: number | null, nowMs: number): string => {
    if (recordedAtMs === null) return new Date(nowMs).toISOString();
    if (recordedAtMs > nowMs + RECORDED_AT_FUTURE_SKEW_MS) return new Date(nowMs).toISOString();
    const candidate = new Date(recordedAtMs);
    if (Number.isNaN(candidate.getTime())) return new Date(nowMs).toISOString();
    return candidate.toISOString();
};

export type CaptureAudio = {
    bytes: Uint8Array;
    mimeType: string;
    fileName: string;
};

export type CapturePayload = {
    transcription: string;
    recordedAtMs: number | null;
    audio: CaptureAudio | null;
    captureId: string | null;
};

// Same shape core accepts for a replay-safe capture id (packages/core/src/store-tasks.ts,
// CAPTURE_ID_PATTERN). Kept private there, so the pattern is repeated here on purpose.
const CAPTURE_ID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

/** `null` = not supplied; a Response = supplied but malformed. */
const parseCaptureId = (value: unknown): string | null | Response => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !CAPTURE_ID_PATTERN.test(value.trim())) {
        return errorResponse('Invalid captureId', 400);
    }
    return value.trim().toLowerCase();
};

const isBlobLike = (value: unknown): value is Blob => (
    typeof value === 'object'
    && value !== null
    && typeof (value as Blob).arrayBuffer === 'function'
    && typeof (value as Blob).type === 'string'
);

/**
 * Reads the capture fields out of a JSON object or a plain text body (multipart
 * has its own parser below). Unknown fields are ignored on purpose: a sender
 * that grows a new field must keep working against an older server.
 */
export function parseCaptureBody(
    contentType: string,
    bytes: Uint8Array,
): CapturePayload | Response {
    if (contentType === 'application/json') {
        const text = new TextDecoder().decode(bytes).trim();
        if (!text) return { transcription: '', recordedAtMs: null, audio: null, captureId: null };
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return errorResponse('Invalid JSON body');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return errorResponse('Invalid JSON body');
        }
        const record = parsed as Record<string, unknown>;
        const captureId = parseCaptureId(record.captureId);
        if (captureId instanceof Response) return captureId;
        return {
            transcription: firstString(record.transcription, record.text, record.title),
            recordedAtMs: parseRecordedAtMs(record.recordedAt),
            audio: null,
            captureId,
        };
    }
    return {
        transcription: new TextDecoder().decode(bytes),
        recordedAtMs: null,
        audio: null,
        captureId: null,
    };
}

/**
 * The `Content-Type` the sender declared on the `audio` part, read straight from
 * the raw body.
 *
 * Bun's own multipart parser throws that header away and re-derives `File.type`
 * from the filename extension instead: a part sent as `audio/mp4` named
 * `recording.m4a` comes back as `audio/x-m4a`, one named `clip.webm` as
 * `video/webm`, and one with no extension as the empty string. Trusting
 * `File.type` would therefore reject perfectly good audio whose filename carries
 * no extension, which is exactly what a watch or a shell script tends to send.
 * Only the small header block of each part is decoded, never the payload.
 */
export function readDeclaredPartContentType(
    rawContentType: string,
    bytes: Uint8Array,
    partName: string,
): string {
    const boundaryMatch = /;\s*boundary=(?:"([^"]*)"|([^;\s]+))/i.exec(rawContentType);
    const boundary = boundaryMatch?.[1] || boundaryMatch?.[2] || '';
    if (!boundary) return '';
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const marker = Buffer.from(`--${boundary}`, 'latin1');
    const headerSeparator = Buffer.from('\r\n\r\n', 'latin1');
    // `filename="audio"` must not count as the part named `audio`.
    const namePattern = new RegExp(`(?:^|[;\\s])name="?${partName}"?(?:[;\\s]|$)`, 'i');
    let index = buffer.indexOf(marker);
    while (index >= 0) {
        const headerStart = index + marker.byteLength;
        const headerEnd = buffer.indexOf(headerSeparator, headerStart);
        if (headerEnd < 0) return '';
        const headers = buffer.toString('latin1', headerStart, headerEnd);
        if (namePattern.test(headers)) {
            return normalizeContentType(/^content-type:[ \t]*([^\r\n]+)/im.exec(headers)?.[1] ?? null);
        }
        index = buffer.indexOf(marker, headerEnd + headerSeparator.byteLength);
    }
    return '';
}

/** Multipart is parsed by the runtime's own form parser, but only after the
 *  bytes have already been read under the request byte cap. */
async function parseCaptureMultipart(
    rawContentType: string,
    bytes: Uint8Array,
): Promise<CapturePayload | Response> {
    let form: FormData;
    try {
        // The request body is never backed by a SharedArrayBuffer, so this narrowing
        // is free; BodyInit only accepts the narrower view type.
        const body = bytes as Uint8Array<ArrayBuffer>;
        form = await new Response(body, { headers: { 'content-type': rawContentType } }).formData();
    } catch {
        return errorResponse('Invalid multipart body');
    }
    const audioPart = form.get('audio');
    let audio: CaptureAudio | null = null;
    if (isBlobLike(audioPart)) {
        audio = {
            bytes: new Uint8Array(await audioPart.arrayBuffer()),
            mimeType: readDeclaredPartContentType(rawContentType, bytes, 'audio')
                || normalizeContentType(audioPart.type),
            fileName: typeof (audioPart as File).name === 'string' ? (audioPart as File).name : '',
        };
    }
    const readField = (name: string): string => {
        const value = form.get(name);
        return typeof value === 'string' ? value : '';
    };
    const captureId = parseCaptureId(readField('captureId'));
    if (captureId instanceof Response) return captureId;
    return {
        transcription: firstString(readField('transcription'), readField('text'), readField('title')),
        recordedAtMs: parseRecordedAtMs(readField('recordedAt')),
        audio: audio && audio.bytes.byteLength > 0 ? audio : null,
        captureId,
    };
}

/** Title and description for the captured task. The transcription is spoken
 *  text, so it is never run through the quick-add parser: "call Dave #urgent"
 *  must stay the words that were said. */
export function buildCaptureTaskText(
    transcription: string,
    createdAt: string,
): { title: string; description?: string } {
    const body = transcription.replace(/\r\n?/g, '\n').trim();
    const firstNonEmptyLine = body.split('\n').map((line) => line.trim()).find((line) => line.length > 0) || '';
    const title = firstNonEmptyLine
        ? firstNonEmptyLine.slice(0, MAX_TASK_TITLE_LENGTH)
        : `Voice capture ${createdAt.replace(/\.\d{3}Z$/, 'Z')}`;
    // The sender's `client` label is accepted and ignored: a "Captured with ring"
    // line under every voice note is clutter, and the audio attachment already
    // says where the task came from (#1148).
    return body && body !== title ? { title, description: body } : { title };
}

/** The attachment record the apps expect to find in the synced document: the
 *  remote (sanitized) shape, with an empty `uri` and the cloud key the apps
 *  derive themselves through core's buildCloudKey. */
export function buildCaptureAttachment(
    audio: CaptureAudio,
    fallbackTitle: string,
    createdAt: string,
    updatedAt: string,
): Attachment {
    const extension = audioExtensionFor(audio.mimeType);
    const baseName = sanitizeSingleLine(audio.fileName, MAX_ATTACHMENT_TITLE_LENGTH)
        || sanitizeSingleLine(fallbackTitle, MAX_ATTACHMENT_TITLE_LENGTH)
        || 'audio';
    const title = baseName.toLowerCase().endsWith(`.${extension}`) ? baseName : `${baseName}.${extension}`;
    const attachment: Attachment = {
        id: generateUUID(),
        kind: 'file',
        title,
        uri: '',
        mimeType: audio.mimeType,
        size: audio.bytes.byteLength,
        createdAt,
        updatedAt,
        fileHash: createHash('sha256').update(audio.bytes).digest('hex'),
    };
    attachment.cloudKey = buildCloudKey(attachment);
    return attachment;
}

export type CaptureRequestOptions = {
    dataDir: string;
    /** Namespace key (the token digest), as resolved by withNamespace. */
    key: string;
    /** Which kind of token authenticated the request (#1178); logged, never stored. */
    tokenScope: 'full' | 'capture';
    filePath: string;
    /** Whole-request cap for a multipart capture; the audio rides inside it. */
    maxCaptureBytes: number;
    /** Cap for a text-only body, and for the transcription inside a multipart. */
    maxTextBytes: number;
    abortSignal: AbortSignal;
    assertStorageRoot: () => void;
    withWriteLock: <T>(key: string, handler: () => Promise<T>) => Promise<T>;
    finalizeForWrite: (data: AppData, nowIso: string) => AppData | { error: Response };
};

/**
 * Route body for POST /v1/capture, once withNamespace has authenticated the
 * token, applied the rate limit, and reserved the namespace.
 *
 * One posted transcription (plus optional audio) becomes one Inbox task. The
 * shape matches what a Pebble Index webhook already sends, but nothing here is
 * specific to that device.
 */
export async function handleCaptureRequest(
    req: Request,
    options: CaptureRequestOptions,
): Promise<Response> {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

    const rawContentType = req.headers.get('content-type') || '';
    const contentType = normalizeContentType(rawContentType);
    const isMultipart = contentType === 'multipart/form-data';
    const maxBytes = isMultipart ? options.maxCaptureBytes : options.maxTextBytes;

    const bytes = await readRequestBytes(req, maxBytes, options.abortSignal);
    if (isBodyReadError(bytes)) {
        return errorResponse(bytes.__mindwtrError.message, bytes.__mindwtrError.status);
    }
    throwIfRequestAborted(options.abortSignal);

    const payload = isMultipart
        ? await parseCaptureMultipart(rawContentType, bytes)
        : parseCaptureBody(contentType, bytes);
    if (payload instanceof Response) return payload;

    if (new TextEncoder().encode(payload.transcription).byteLength > options.maxTextBytes) {
        return errorResponse('Payload too large', 413);
    }
    if (!payload.transcription.trim() && !payload.audio) {
        return errorResponse('Missing transcription or audio', 400);
    }
    if (payload.audio && !audioExtensionFor(payload.audio.mimeType)) {
        return errorResponse('Unsupported audio type', 415);
    }
    if (payload.audio) {
        // Same admission check PUT /v1/attachments applies: these bytes become a
        // synced file attachment on the owner's devices.
        const blockedSignature = getBlockedAttachmentSignature(payload.audio.bytes);
        if (blockedSignature) {
            return errorResponse(`Blocked executable attachment signature: ${blockedSignature}`, 400);
        }
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const createdAt = resolveCaptureCreatedAt(payload.recordedAtMs, nowMs);
    const { title, description } = buildCaptureTaskText(payload.transcription, createdAt);
    const audio = payload.audio;
    const attachment = audio ? buildCaptureAttachment(audio, title, createdAt, nowIso) : null;

    const task: Task = {
        id: payload.captureId ?? generateUUID(),
        title,
        status: 'inbox',
        reminderPolicy: 'inherit',
        tags: [],
        contexts: [],
        rev: 1,
        revBy: CLOUD_API_REV_BY,
        createdAt,
        updatedAt: nowIso,
        ...(description ? { description } : {}),
        ...(attachment ? { attachments: [attachment] } : {}),
    };

    return await options.withWriteLock(options.key, async () => {
        throwIfRequestAborted(options.abortSignal);
        const dataResult = loadAppDataOrError(options.filePath);
        if ('error' in dataResult) return dataResult.error;
        const data = dataResult;
        if (payload.captureId && data.tasks.some((item) => item.id === payload.captureId)) {
            // A retry of a capture that already landed (deleted tasks count: it stays deleted).
            // Only the id goes back — a capture-only token must never read task content.
            logInfo('Capture webhook replay ignored', { tokenScope: options.tokenScope });
            return jsonResponse(
                { task: { id: payload.captureId }, attachment: null, replayed: true },
                { status: 200 },
            );
        }
        task.suppressMindwtrReminders = !shouldSendTaskReminders(task, data.settings);
        data.tasks.push(task);
        const finalized = options.finalizeForWrite(data, nowIso);
        if ('error' in finalized) return finalized.error;

        if (audio && attachment?.cloudKey) {
            const storeResponse = storeCaptureAudio(audio, attachment.cloudKey, options);
            if (storeResponse) return storeResponse;
        }

        // From here on, the audio (if any) is already on disk. A writeCloudData throw
        // can happen after publishing the task, so cleanup requires a fresh canonical
        // read that positively proves the cloudKey is unreferenced.
        try {
            throwIfRequestAborted(options.abortSignal);
            writeCloudData(options.filePath, finalized, { assertStorageRoot: options.assertStorageRoot });
        } catch (error) {
            if (audio && attachment?.cloudKey) removeOrphanedCaptureAudio(attachment.cloudKey, options);
            throw error;
        }
        const savedTask = finalized.tasks.find((item) => item.id === task.id) ?? task;
        // A self-hoster's watch, phone shortcut, or script posts here with no UI
        // feedback of its own; this is the only server-side proof the request
        // ever arrived (03e9cb9eb added the route without one). No transcription
        // text or token — only shape and size.
        logInfo('Capture webhook request accepted', {
            hasAudio: audio ? 'true' : 'false',
            bodyKind: isMultipart ? 'multipart' : contentType === 'application/json' ? 'json' : 'text',
            bytes: bytes.byteLength,
            tokenScope: options.tokenScope,
        });
        // Report what was actually stored, in case the shared finalize pass touched it.
        return jsonResponse({ task: savedTask, attachment: savedTask.attachments?.[0] ?? null }, { status: 201 });
    });
}

/** Best-effort cleanup for the gap above. A thrown document write can still have
 *  published the task before a later durability or authority check failed, so only
 *  remove the audio after the canonical document positively proves it unreferenced.
 *  Errors are swallowed because the original write failure remains authoritative. */
function removeOrphanedCaptureAudio(cloudKey: string, options: CaptureRequestOptions): void {
    const retain = (retentionReason: 'referenced' | 'unreadable' | 'storage-authority'): void => {
        try {
            logWarn('Capture audio retained after failed document write', {
                releaseCheck: 'v1.3.0/cloud-capture-audio-retained',
                retentionReason,
            });
        } catch {
            // Logging must not replace the original document-write failure.
        }
    };

    try {
        options.assertStorageRoot();
    } catch {
        retain('storage-authority');
        return;
    }

    let isReferenced: boolean;
    try {
        const canonical: unknown = JSON.parse(readFileSync(options.filePath, 'utf8'));
        if (!canonical || typeof canonical !== 'object') throw new Error('Invalid canonical document');
        const record = canonical as Record<string, unknown>;
        if (!Array.isArray(record.tasks) || !Array.isArray(record.projects)) {
            throw new Error('Invalid canonical attachment collections');
        }
        isReferenced = [...record.tasks, ...record.projects].some((entity) => {
            if (!entity || typeof entity !== 'object') throw new Error('Invalid canonical attachment owner');
            const attachments = (entity as Record<string, unknown>).attachments;
            if (attachments === undefined) return false;
            if (!Array.isArray(attachments)) throw new Error('Invalid canonical attachments');
            return attachments.some((item) => {
                if (!item || typeof item !== 'object') throw new Error('Invalid canonical attachment');
                const referencedCloudKey = (item as Record<string, unknown>).cloudKey;
                if (referencedCloudKey !== undefined && typeof referencedCloudKey !== 'string') {
                    throw new Error('Invalid canonical attachment reference');
                }
                return referencedCloudKey === cloudKey;
            });
        });
    } catch {
        retain('unreadable');
        return;
    }
    if (isReferenced) {
        retain('referenced');
        return;
    }

    try {
        options.assertStorageRoot();
    } catch {
        retain('storage-authority');
        return;
    }

    try {
        const resolved = resolveAttachmentPath(options.dataDir, options.key, captureAudioStoragePath(cloudKey), { create: false });
        if (resolved) durablyRemoveFile(resolved.filePath);
    } catch {
        // Best effort only; the original document-write failure stays authoritative.
    }
}

/** The apps fetch an attachment at `<base>/v1/<cloudKey>`, and cloudKey already
 *  starts with `attachments/`, so the /v1/attachments/:path handler stores and
 *  serves the bytes at the key WITHOUT that prefix. Storing under the full key
 *  put the audio one directory too deep, where no app ever looked (#1148). */
export function captureAudioStoragePath(cloudKey: string): string {
    const prefix = `${ATTACHMENTS_DIR_NAME}/`;
    return cloudKey.startsWith(prefix) ? cloudKey.slice(prefix.length) : cloudKey;
}

/** Publishes the audio bytes through the same durable path PUT
 *  /v1/attachments/:path uses. Returns a Response only on failure. */
function storeCaptureAudio(
    audio: CaptureAudio,
    cloudKey: string,
    options: CaptureRequestOptions,
): Response | null {
    options.assertStorageRoot();
    const resolved = resolveAttachmentPath(options.dataDir, options.key, captureAudioStoragePath(cloudKey), { create: true });
    if (!resolved) return errorResponse('Failed to store attachment', 500);
    let prepared: PreparedFilePublication | null;
    try {
        prepared = prepareFilePublicationSafely(resolved.rootRealPath, resolved.filePath, 'upload');
    } catch (error) {
        options.assertStorageRoot();
        throw error;
    }
    if (!prepared) return errorResponse('Failed to store attachment', 500);
    try {
        if (!publishPreparedFilePublication(prepared, audio.bytes, options.assertStorageRoot)) {
            return errorResponse('Failed to store attachment', 500);
        }
    } catch (error) {
        options.assertStorageRoot();
        throw error;
    } finally {
        abandonPreparedFilePublication(prepared);
    }
    return null;
}
