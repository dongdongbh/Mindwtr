import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AppData, Attachment, Task } from '@mindwtr/core';
import { startCloudServer } from './server';
import {
    buildCaptureTaskText,
    handleCaptureRequest,
    parseRecordedAtMs,
    readDeclaredPartContentType,
    resolveCaptureCreatedAt,
} from './server-capture';

const TOKEN = 'capture-webhook-test-token-1234567890';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

// A short, real-looking audio payload. Nothing decodes it; the route stores bytes.
const AUDIO_BYTES = new Uint8Array([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
    0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00,
    0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04,
]);

type Harness = {
    url: string;
    dataDir: string;
    stop: () => void;
};

let harness: Harness;

const startHarness = async (options: { maxAttachmentBytes?: number } = {}): Promise<Harness> => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-capture-'));
    const server = await startCloudServer({
        host: '127.0.0.1',
        port: 0,
        dataDir,
        allowedAuthTokens: new Set([TOKEN]),
        ...(options.maxAttachmentBytes === undefined ? {} : { maxAttachmentBytes: options.maxAttachmentBytes }),
    });
    return {
        url: `http://127.0.0.1:${server.port}`,
        dataDir,
        stop: () => {
            server.stop();
            rmSync(dataDir, { recursive: true, force: true });
        },
    };
};

const postCapture = (init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> => (
    fetch(`${harness.url}/v1/capture`, {
        method: 'POST',
        ...init,
        headers: { ...AUTH, ...(init.headers ?? {}) },
    })
);

const postJsonCapture = (body: unknown): Promise<Response> => postCapture({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
});

// The multipart body is assembled by hand rather than through FormData: Bun's
// FormData serializer discards a Blob's own type and re-derives each part's
// Content-Type from the filename (an .m4a part goes out as audio/x-m4a, a .webm
// part as video/webm). Writing the wire bytes keeps these tests posting exactly
// what a webhook sender posts, with the part Content-Type it actually chose.
const BOUNDARY = 'mindwtr-capture-test-boundary';

type CapturePart =
    | { name: string; value: string }
    | { name: string; fileName: string; contentType: string; bytes: Uint8Array };

const buildMultipartBody = (parts: CapturePart[]): Uint8Array<ArrayBuffer> => {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (const part of parts) {
        if ('value' in part) {
            chunks.push(encoder.encode(
                `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
            ));
            continue;
        }
        chunks.push(encoder.encode(
            `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.fileName}"\r\n`
            + `Content-Type: ${part.contentType}\r\n\r\n`,
        ));
        chunks.push(part.bytes);
        chunks.push(encoder.encode('\r\n'));
    }
    chunks.push(encoder.encode(`--${BOUNDARY}--\r\n`));
    const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
};

const captureParts = (fields: {
    transcription?: string;
    recordedAt?: string;
    client?: string;
    audio?: { bytes: Uint8Array; type: string; name: string };
    extra?: Record<string, string>;
}): CapturePart[] => {
    const parts: CapturePart[] = [];
    if (fields.transcription !== undefined) parts.push({ name: 'transcription', value: fields.transcription });
    if (fields.recordedAt !== undefined) parts.push({ name: 'recordedAt', value: fields.recordedAt });
    if (fields.client !== undefined) parts.push({ name: 'client', value: fields.client });
    if (fields.audio) {
        parts.push({
            name: 'audio',
            fileName: fields.audio.name,
            contentType: fields.audio.type,
            bytes: fields.audio.bytes,
        });
    }
    for (const [name, value] of Object.entries(fields.extra ?? {})) parts.push({ name, value });
    return parts;
};

const postFormCapture = (fields: Parameters<typeof captureParts>[0]): Promise<Response> => postCapture({
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body: new Blob([buildMultipartBody(captureParts(fields))]),
});

const readStoredTasks = async (): Promise<Task[]> => {
    const response = await fetch(`${harness.url}/v1/data`, { headers: AUTH });
    const data = (await response.json()) as AppData;
    return data.tasks;
};

beforeEach(async () => {
    harness = await startHarness();
});

afterEach(() => {
    harness.stop();
});

describe('POST /v1/capture', () => {
    test('multipart transcription plus audio creates one inbox task with a readable attachment', async () => {
        const response = await postFormCapture({
                transcription: 'Book the dentist\nAsk about the crown that came loose',
                client: 'ring',
                audio: { bytes: AUDIO_BYTES, type: 'audio/mp4', name: 'recording.m4a' },
            });
        expect(response.status).toBe(201);
        const payload = (await response.json()) as { task: Task; attachment: Attachment };

        expect(payload.task.status).toBe('inbox');
        expect(payload.task.title).toBe('Book the dentist');
        expect(payload.task.description).toBe(
            'Book the dentist\nAsk about the crown that came loose\n\nCaptured with ring',
        );
        expect(payload.task.rev).toBe(1);
        expect(payload.task.revBy).toBe('cloud');
        expect(payload.task.attachments).toHaveLength(1);

        const attachment = payload.attachment;
        expect(attachment.kind).toBe('file');
        expect(attachment.uri).toBe('');
        expect(attachment.mimeType).toBe('audio/mp4');
        expect(attachment.size).toBe(AUDIO_BYTES.byteLength);
        expect(attachment.title).toBe('recording.m4a');
        expect(attachment.cloudKey).toBe(`attachments/${attachment.id}.m4a`);
        expect(attachment.fileHash).toBe(createHash('sha256').update(AUDIO_BYTES).digest('hex'));
        expect(attachment.createdAt).toBe(payload.task.createdAt);

        const download = await fetch(`${harness.url}/v1/attachments/${attachment.cloudKey}`, { headers: AUTH });
        expect(download.status).toBe(200);
        const downloaded = new Uint8Array(await download.arrayBuffer());
        expect([...downloaded]).toEqual([...AUDIO_BYTES]);
        expect(createHash('sha256').update(downloaded).digest('hex')).toBe(attachment.fileHash);

        const tasks = await readStoredTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].attachments?.[0].cloudKey).toBe(attachment.cloudKey);
    });

    test('accepts a transcription with no audio as multipart, JSON, and plain text', async () => {
        const multipart = await postFormCapture({ transcription: 'Water the plants' });
        expect(multipart.status).toBe(201);
        expect(((await multipart.json()) as { task: Task; attachment: null }).attachment).toBeNull();

        const json = await postJsonCapture({ transcription: 'Renew the passport' });
        expect(json.status).toBe(201);
        expect(((await json.json()) as { task: Task }).task.title).toBe('Renew the passport');

        const plain = await postCapture({
            headers: { 'content-type': 'text/plain' },
            body: 'Call the plumber back',
        });
        expect(plain.status).toBe(201);
        const plainPayload = (await plain.json()) as { task: Task; attachment: null };
        expect(plainPayload.task.title).toBe('Call the plumber back');
        expect(plainPayload.task.description).toBeUndefined();
        expect(plainPayload.attachment).toBeNull();

        const titles = (await readStoredTasks()).map((task) => task.title).sort();
        expect(titles).toEqual(['Call the plumber back', 'Renew the passport', 'Water the plants']);
    });

    test('logs a releaseCheck line proving the request arrived, with no transcription text or token', async () => {
        const captured: string[] = [];
        const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
            captured.push(String(chunk));
            return true;
        });

        try {
            const multipart = await postFormCapture({ transcription: 'Secret errand text' });
            expect(multipart.status).toBe(201);

            const json = await postJsonCapture({ transcription: 'Another secret line' });
            expect(json.status).toBe(201);
        } finally {
            stdoutSpy.mockRestore();
        }

        const lines = captured.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const proofLines = lines.filter((line) => line.message === 'Capture webhook request accepted');
        expect(proofLines).toHaveLength(2);
        for (const line of proofLines) {
            expect(line.context.releaseCheck).toBe('v1.2.8/cloud-capture-accepted');
        }
        expect(proofLines[0].context.hasAudio).toBe('false');
        expect(proofLines[0].context.bodyKind).toBe('multipart');
        expect(typeof proofLines[0].context.bytes).toBe('number');
        expect(proofLines[1].context.hasAudio).toBe('false');
        expect(proofLines[1].context.bodyKind).toBe('json');
        expect(typeof proofLines[1].context.bytes).toBe('number');

        const serialized = captured.join('');
        expect(serialized).not.toContain('Secret errand text');
        expect(serialized).not.toContain('Another secret line');
        expect(serialized).not.toContain(TOKEN);
    });

    test('accepts text and title as transcription aliases', async () => {
        const viaText = await postJsonCapture({ text: 'Return the library books' });
        expect(((await viaText.json()) as { task: Task }).task.title).toBe('Return the library books');

        const viaTitle = await postJsonCapture({ title: 'Pick up the parcel' });
        expect(((await viaTitle.json()) as { task: Task }).task.title).toBe('Pick up the parcel');
    });

    test('audio with no transcription is titled from the recorded time', async () => {
        const recordedAt = Date.parse('2026-09-03T12:34:56.000Z');
        const response = await postFormCapture({
                recordedAt: String(recordedAt),
                audio: { bytes: AUDIO_BYTES, type: 'audio/mp4', name: '' },
            });
        expect(response.status).toBe(201);
        const payload = (await response.json()) as { task: Task; attachment: Attachment };
        expect(payload.task.title).toBe('Voice capture 2026-09-03T12:34:56Z');
        expect(payload.task.description).toBeUndefined();
        expect(payload.attachment.title).toBe('Voice capture 2026-09-03T12:34:56Z.m4a');
    });

    test('recordedAt sets createdAt as epoch milliseconds and as an ISO string', async () => {
        const recordedAtIso = '2026-08-01T09:15:00.000Z';
        const viaMs = await postJsonCapture({
            transcription: 'From milliseconds',
            recordedAt: Date.parse(recordedAtIso),
        });
        expect(((await viaMs.json()) as { task: Task }).task.createdAt).toBe(recordedAtIso);

        const viaIso = await postJsonCapture({ transcription: 'From ISO', recordedAt: recordedAtIso });
        expect(((await viaIso.json()) as { task: Task }).task.createdAt).toBe(recordedAtIso);

        const viaFormMs = await postFormCapture({
            transcription: 'From form',
            recordedAt: String(Date.parse(recordedAtIso)),
        });
        expect(((await viaFormMs.json()) as { task: Task }).task.createdAt).toBe(recordedAtIso);
    });

    test('a recordedAt beyond the allowed skew falls back to now', async () => {
        const before = Date.now();
        const response = await postJsonCapture({
            transcription: 'Clock is wrong',
            recordedAt: before + 60 * 60 * 1000,
        });
        const task = ((await response.json()) as { task: Task }).task;
        const createdAtMs = Date.parse(task.createdAt);
        expect(createdAtMs).toBeGreaterThanOrEqual(before);
        expect(createdAtMs).toBeLessThanOrEqual(Date.now());

        // Inside the 5-minute skew window the recorded time is still honoured.
        const nearFuture = new Date(before + 60_000).toISOString();
        const skewed = await postJsonCapture({ transcription: 'Slightly fast clock', recordedAt: nearFuture });
        expect(((await skewed.json()) as { task: Task }).task.createdAt).toBe(nearFuture);
    });

    test('ignores unknown fields', async () => {
        const response = await postFormCapture({
            transcription: 'Keep working',
            extra: { deviceModel: 'index-01', battery: '84', status: 'done', projectId: 'p1' },
        });
        expect(response.status).toBe(201);
        const task = ((await response.json()) as { task: Task }).task;
        expect(task.status).toBe('inbox');
        expect(task.projectId).toBeUndefined();
    });

    test('does not run the quick-add parser on spoken text', async () => {
        const response = await postJsonCapture({ transcription: 'Call Dave #urgent @phone tomorrow !1' });
        const task = ((await response.json()) as { task: Task }).task;
        expect(task.title).toBe('Call Dave #urgent @phone tomorrow !1');
        expect(task.tags).toEqual([]);
        expect(task.contexts).toEqual([]);
        expect(task.dueDate).toBeUndefined();
        expect(task.priority).toBeUndefined();
    });

    test('rejects a request with no token', async () => {
        const response = await fetch(`${harness.url}/v1/capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ transcription: 'No token' }),
        });
        expect(response.status).toBe(401);
    });

    test('rejects a body with neither transcription nor audio', async () => {
        const empty = await postCapture({ headers: { 'content-type': 'text/plain' }, body: '' });
        expect(empty.status).toBe(400);
        expect(((await empty.json()) as { error: string }).error).toBe('Missing transcription or audio');

        const blank = await postJsonCapture({ transcription: '   \n  ', client: 'ring' });
        expect(blank.status).toBe(400);

        const formOnlyClient = await postFormCapture({ client: 'ring' });
        expect(formOnlyClient.status).toBe(400);

        expect(await readStoredTasks()).toHaveLength(0);
    });

    test('rejects an unsupported audio content type', async () => {
        const response = await postFormCapture({
                transcription: 'Has a bad attachment',
                audio: { bytes: AUDIO_BYTES, type: 'application/zip', name: 'payload.zip' },
            });
        expect(response.status).toBe(415);
        expect(((await response.json()) as { error: string }).error).toBe('Unsupported audio type');
        expect(await readStoredTasks()).toHaveLength(0);
    });

    test('rejects audio over the attachment byte limit', async () => {
        harness.stop();
        harness = await startHarness({ maxAttachmentBytes: 1024 });
        const response = await postFormCapture({
                transcription: 'Too long a recording',
                audio: { bytes: new Uint8Array(4096), type: 'audio/mp4', name: 'long.m4a' },
            });
        expect(response.status).toBe(413);
        expect(((await response.json()) as { error: string }).error).toBe('Payload too large');
        expect(await readStoredTasks()).toHaveLength(0);
    });

    test('maps every supported audio type to its stored extension', async () => {
        const cases: Array<[string, string]> = [
            ['audio/mp4', 'm4a'],
            ['audio/x-m4a', 'm4a'],
            ['audio/aac', 'aac'],
            ['audio/mpeg', 'mp3'],
            ['audio/wav', 'wav'],
            ['audio/x-wav', 'wav'],
            ['audio/ogg', 'ogg'],
            ['audio/webm', 'webm'],
        ];
        for (const [mimeType, extension] of cases) {
            const response = await postFormCapture({
                    transcription: `Recorded as ${mimeType}`,
                    audio: { bytes: AUDIO_BYTES, type: mimeType, name: 'clip' },
                });
            expect(response.status).toBe(201);
            const attachment = ((await response.json()) as { attachment: Attachment }).attachment;
            expect(attachment.cloudKey).toBe(`attachments/${attachment.id}.${extension}`);
            expect(attachment.title).toBe(`clip.${extension}`);
        }
    });

    test('trusts the Content-Type the sender declared on the audio part', async () => {
        // Bun's formData() re-derives File.type from the filename: `voicenote` would
        // report no type at all and `clip.webm` would report video/webm. The type the
        // sender actually declared is what decides the stored extension.
        const noExtension = await postFormCapture({
            transcription: 'No filename extension',
            audio: { bytes: AUDIO_BYTES, type: 'audio/mp4', name: 'voicenote' },
        });
        expect(noExtension.status).toBe(201);
        const noExtensionAttachment = ((await noExtension.json()) as { attachment: Attachment }).attachment;
        expect(noExtensionAttachment.mimeType).toBe('audio/mp4');
        expect(noExtensionAttachment.title).toBe('voicenote.m4a');

        const mismatched = await postFormCapture({
            transcription: 'Filename disagrees with the declared type',
            audio: { bytes: AUDIO_BYTES, type: 'audio/mpeg', name: 'clip.webm' },
        });
        expect(mismatched.status).toBe(201);
        const attachment = ((await mismatched.json()) as { attachment: Attachment }).attachment;
        expect(attachment.mimeType).toBe('audio/mpeg');
        expect(attachment.title).toBe('clip.webm.mp3');
        expect(attachment.cloudKey).toBe(`attachments/${attachment.id}.mp3`);
    });

    test('a captured task survives a client PUT /v1/data that has never seen it', async () => {
        const captureResponse = await postFormCapture({
                transcription: 'Sync me to the phone',
                client: 'ring',
                audio: { bytes: AUDIO_BYTES, type: 'audio/mp4', name: 'note.m4a' },
            });
        expect(captureResponse.status).toBe(201);
        const { task, attachment } = (await captureResponse.json()) as { task: Task; attachment: Attachment };

        // A phone that synced before the capture pushes its own snapshot back.
        const staleSnapshot: AppData = {
            tasks: [{
                id: 'phone-only-task',
                title: 'Written on the phone',
                status: 'inbox',
                tags: [],
                contexts: [],
                rev: 1,
                revBy: 'phone',
                createdAt: '2026-09-01T00:00:00.000Z',
                updatedAt: '2026-09-01T00:00:00.000Z',
            }],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        const putResponse = await fetch(`${harness.url}/v1/data`, {
            method: 'PUT',
            headers: { ...AUTH, 'content-type': 'application/json' },
            body: JSON.stringify(staleSnapshot),
        });
        expect(putResponse.status).toBe(200);

        const merged = await readStoredTasks();
        const mergedCapture = merged.find((item) => item.id === task.id);
        expect(mergedCapture).toBeTruthy();
        expect(mergedCapture?.deletedAt).toBeUndefined();
        expect(mergedCapture?.attachments?.[0].cloudKey).toBe(attachment.cloudKey);
        expect(mergedCapture?.attachments?.[0].fileHash).toBe(attachment.fileHash);
        expect(merged.some((item) => item.id === 'phone-only-task')).toBe(true);

        // The bytes are still downloadable after the merge, so the phone can fetch them.
        const download = await fetch(`${harness.url}/v1/attachments/${attachment.cloudKey}`, { headers: AUTH });
        expect(download.status).toBe(200);
        expect(new Uint8Array(await download.arrayBuffer()).byteLength).toBe(AUDIO_BYTES.byteLength);
    });

    // storeCaptureAudio publishes the audio bytes, then throwIfRequestAborted and
    // writeCloudData run. A throw in that gap used to leave the just-published file
    // orphaned on disk (no task ever ends up referencing its cloudKey). Calls
    // handleCaptureRequest directly (not through the HTTP server) so a hand-rolled
    // assertStorageRoot can fail deterministically right after the audio is durably
    // on disk, without a real race.
    test('removes the just-published audio file when the write after it fails', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-capture-cleanup-'));
        try {
            const key = 'cleanup-ns';
            const filePath = join(dataDir, `${key}.json`);
            writeFileSync(filePath, JSON.stringify({
                tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
            }));

            let assertCalls = 0;
            // storeCaptureAudio calls assertStorageRoot once up front (server-capture.ts),
            // then publishPreparedFilePublication calls it three more times around the
            // rename that actually publishes the file (server-storage.ts:732-742). Failing
            // from the 5th call on therefore always lands after the audio is durably on
            // disk, in the writeCloudData step that follows.
            const assertStorageRoot = () => {
                assertCalls += 1;
                if (assertCalls > 4) throw new Error('storage root changed');
            };

            const request = new Request('http://cloud.test/v1/capture', {
                method: 'POST',
                headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
                body: new Blob([buildMultipartBody(captureParts({
                    transcription: 'Book the dentist',
                    audio: { bytes: AUDIO_BYTES, type: 'audio/mp4', name: 'recording.m4a' },
                }))]),
            });

            await expect(handleCaptureRequest(request, {
                dataDir,
                key,
                filePath,
                maxCaptureBytes: 10_000_000,
                maxTextBytes: 100_000,
                abortSignal: new AbortController().signal,
                assertStorageRoot,
                withWriteLock: async (_key, handler) => handler(),
                finalizeForWrite: (data) => data,
            })).rejects.toThrow('storage root changed');

            expect(assertCalls).toBeGreaterThan(4);

            // cloudKey already carries an "attachments/" prefix (buildCloudKey), so the
            // real file lands a level deeper than this directory - walk recursively and
            // check no audio file bytes were left behind anywhere under it, rather than
            // assuming the directory tree itself is empty (an empty parent dir is fine).
            const attachmentsDir = join(dataDir, key, 'attachments');
            const remainingAudioFiles = existsSync(attachmentsDir)
                ? (readdirSync(attachmentsDir, { recursive: true }) as string[]).filter((name) => name.endsWith('.m4a'))
                : [];
            expect(remainingAudioFiles).toEqual([]);

            // The failed write never persisted the task either.
            const stored = JSON.parse(readFileSync(filePath, 'utf8')) as AppData;
            expect(stored.tasks).toHaveLength(0);
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('rejects any method other than POST', async () => {
        const response = await fetch(`${harness.url}/v1/capture`, { method: 'GET', headers: AUTH });
        expect(response.status).toBe(405);
    });
});

describe('capture field helpers', () => {
    test('parseRecordedAtMs reads epoch milliseconds and ISO strings only', () => {
        expect(parseRecordedAtMs(1_756_900_496_000)).toBe(1_756_900_496_000);
        expect(parseRecordedAtMs('1756900496000')).toBe(1_756_900_496_000);
        expect(parseRecordedAtMs('2026-09-03T12:34:56Z')).toBe(Date.parse('2026-09-03T12:34:56Z'));
        expect(parseRecordedAtMs('yesterday')).toBeNull();
        expect(parseRecordedAtMs('')).toBeNull();
        expect(parseRecordedAtMs(undefined)).toBeNull();
        expect(parseRecordedAtMs(Number.NaN)).toBeNull();
    });

    test('resolveCaptureCreatedAt keeps a plausible recording time and drops a future one', () => {
        const now = Date.parse('2026-09-03T12:00:00.000Z');
        expect(resolveCaptureCreatedAt(Date.parse('2026-09-03T11:00:00.000Z'), now))
            .toBe('2026-09-03T11:00:00.000Z');
        // Four minutes ahead is inside the allowed clock skew.
        expect(resolveCaptureCreatedAt(now + 4 * 60 * 1000, now)).toBe('2026-09-03T12:04:00.000Z');
        expect(resolveCaptureCreatedAt(now + 6 * 60 * 1000, now)).toBe('2026-09-03T12:00:00.000Z');
        expect(resolveCaptureCreatedAt(null, now)).toBe('2026-09-03T12:00:00.000Z');
        expect(resolveCaptureCreatedAt(Number.MAX_SAFE_INTEGER, now)).toBe('2026-09-03T12:00:00.000Z');
    });

    test('buildCaptureTaskText takes the first non-empty line and keeps the rest as description', () => {
        const createdAt = '2026-09-03T12:34:56.000Z';
        expect(buildCaptureTaskText('  \n\n  Fix the gate  \nIt sticks in the rain', '', createdAt)).toEqual({
            title: 'Fix the gate',
            description: 'Fix the gate  \nIt sticks in the rain',
        });
        expect(buildCaptureTaskText('Single line', '', createdAt)).toEqual({ title: 'Single line' });
        expect(buildCaptureTaskText('Single line', 'ring', createdAt)).toEqual({
            title: 'Single line',
            description: 'Captured with ring',
        });
        expect(buildCaptureTaskText('', '', createdAt)).toEqual({ title: 'Voice capture 2026-09-03T12:34:56Z' });
    });

    test('readDeclaredPartContentType finds the named part and ignores a lookalike filename', () => {
        const contentType = `multipart/form-data; boundary=${BOUNDARY}`;
        const body = buildMultipartBody([
            { name: 'transcription', value: 'Hello' },
            { name: 'photo', fileName: 'audio', contentType: 'image/png', bytes: new Uint8Array([1]) },
            { name: 'audio', fileName: 'clip.bin', contentType: 'audio/mp4; codecs=mp4a', bytes: AUDIO_BYTES },
        ]);
        expect(readDeclaredPartContentType(contentType, body, 'audio')).toBe('audio/mp4');
        expect(readDeclaredPartContentType(contentType, body, 'photo')).toBe('image/png');
        expect(readDeclaredPartContentType(contentType, body, 'missing')).toBe('');
        expect(readDeclaredPartContentType('multipart/form-data', body, 'audio')).toBe('');

        const noPartHeader = buildMultipartBody([{ name: 'transcription', value: 'Hello' }]);
        expect(readDeclaredPartContentType(contentType, noPartHeader, 'transcription')).toBe('');
    });

    test('buildCaptureTaskText cuts a long spoken line to the task title limit', () => {
        const spoken = 'a'.repeat(900);
        const built = buildCaptureTaskText(spoken, '', '2026-09-03T12:34:56.000Z');
        expect(built.title).toHaveLength(500);
        expect(built.description).toBe(spoken);
    });
});
