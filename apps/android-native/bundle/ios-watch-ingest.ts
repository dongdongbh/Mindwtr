import { createNativeRequestReceipts, isNativeRequestReceiptDurable, NativeReceiptSqliteAdapter } from '../../../packages/core/src/native-request-receipts';
import { flushPendingSave, getPersistenceStatus, getStorageAdapter, useTaskStore } from '../../../packages/core/src/store';
import type { createNativeHostContract } from '../../../packages/core/src/native-host-contract';
import { parsePendingCapture, type PendingCaptureAudioPort, type PendingCaptureRecordPort } from '../../../packages/core/src/pending-captures';

type Contract = Pick<ReturnType<typeof createNativeHostContract>, 'ingestPendingCaptures'>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const invalid = () => new Error('INVALID_INPUT: Native Watch batch is invalid');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

const bounded = (value: string, maximum: number) => value.length <= maximum && new TextEncoder().encode(value).byteLength <= maximum;
const flatJSON = (raw: string, maximum: number) => {
    if (typeof raw !== 'string' || !bounded(raw, maximum)) throw invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw invalid(); }
    if (!object(parsed) || Object.values(parsed).some(value => value !== null && typeof value === 'object')) throw invalid();
    const names = new Set<string>();
    // Scan complete string tokens so quoted JSON inside the immutable body is not mistaken for a field.
    for (const token of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"/gu)) {
        if (!/^\s*:/u.test(raw.slice(token.index + token[0].length))) continue;
        const name: unknown = JSON.parse(token[0]);
        if (typeof name !== 'string' || names.has(name)) throw invalid();
        names.add(name);
    }
    return parsed;
};

const readAudioSource = (body: string) => {
    const value = flatJSON(body, 32 * 1024);
    const required = ['protocolVersion', 'id', 'source', 'kind', 'createdAt', 'audioPath'];
    const optional = ['title', 'note', 'defaultStatus', 'status', 'outboxRetried'];
    if (!required.every(name => Object.hasOwn(value, name)) || Object.keys(value).some(name => !required.includes(name) && !optional.includes(name))
        || value.protocolVersion !== 1 || value.source !== 'apple-watch' || value.kind !== 'audio'
        || typeof value.id !== 'string' || !uuid.test(value.id)
        || typeof value.createdAt !== 'string' || value.createdAt.length > 35
        || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value.createdAt)
        || !Number.isFinite(Date.parse(value.createdAt))
        || !Number.isFinite(Date.parse(`${value.createdAt.slice(0, 10)}T00:00:00Z`))
        || new Date(`${value.createdAt.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.createdAt.slice(0, 10)
        || Date.parse(value.createdAt) < Date.parse('2000-01-01T00:00:00Z') || Date.parse(value.createdAt) > Date.parse('2100-01-01T00:00:00Z')
        || typeof value.audioPath !== 'string' || !value.audioPath || value.audioPath.trim() !== value.audioPath
        || /[\u0000-\u001f\u007f-\u009f]/u.test(value.audioPath)
        || ['title', 'note'].some(name => Object.hasOwn(value, name) && (typeof value[name] !== 'string' || !bounded(value[name], 8000)))
        || ['defaultStatus', 'status'].some(name => Object.hasOwn(value, name) && !['inbox', 'next', 'waiting', 'someday'].includes(String(value[name])))
        || (Object.hasOwn(value, 'outboxRetried') && value.outboxRetried !== true)) throw invalid();
    let url: URL;
    try { url = new URL(value.audioPath); } catch { throw invalid(); }
    if (url.protocol !== 'file:' || url.hostname || url.username || url.password || url.search || url.hash
        || !url.pathname.endsWith(`/watch-audio/${value.id}.wav`)) throw invalid();
    const capture = parsePendingCapture(body);
    if (!capture || capture.kind !== 'audio' || capture.id !== value.id || capture.source !== 'apple-watch') throw invalid();
    return { capture, name: `${capture.id}.json`, body };
};

const readAudioEnvelope = (raw: string) => {
    const frame = flatJSON(raw, 1024 * 1024);
    if (!exact(frame, ['version', 'requestId', 'name', 'body', 'transcript']) || frame.version !== 1
        || typeof frame.body !== 'string' || (frame.transcript !== null && (typeof frame.transcript !== 'string'
            || !frame.transcript || frame.transcript.trim() !== frame.transcript || !bounded(frame.transcript, 64 * 1024)))) throw invalid();
    const source = readAudioSource(frame.body);
    if (frame.requestId !== source.capture.id || frame.name !== source.name) throw invalid();
    return { ...source, transcript: frame.transcript };
};

const readBatch = (raw: string) => {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 4 * 1024 * 1024) throw invalid();
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { throw invalid(); }
    if (!object(frame) || !exact(frame, ['version', 'requestId', 'entries']) || frame.version !== 1
        || typeof frame.requestId !== 'string' || !uuid.test(frame.requestId)
        || !Array.isArray(frame.entries) || !frame.entries.length || frame.entries.length > 256) throw invalid();
    const bodies = new Map<string, string>(), checklistNames = new Map<string, string>();
    for (const entry of frame.entries) {
        if (!object(entry) || !exact(entry, ['name', 'body']) || typeof entry.name !== 'string'
            || typeof entry.body !== 'string' || new TextEncoder().encode(entry.body).byteLength > 32 * 1024) throw invalid();
        const capture = parsePendingCapture(entry.body);
        if (!capture || capture.source !== 'apple-watch' || !uuid.test(capture.id)
            || entry.name !== `${capture.id}.json` || bodies.has(entry.name)
            || !['text', 'complete', 'defer', 'checklist'].includes(capture.kind ?? '')) throw invalid();
        bodies.set(entry.name, entry.body);
        if (capture.kind === 'checklist') checklistNames.set(capture.id, entry.name);
    }
    return { requestId: frame.requestId, bodies, checklistNames };
};
const receiptPayload = (body: string) => JSON.stringify(['iosWatchIngestItem', body]);
const receiptReply = (value: unknown, name: string, checklist: boolean) => {
    if (!object(value) || !exact(value, checklist ? ['name', 'checklistOutcome'] : ['name']) || value.name !== name
        || (checklist && !['applied', 'stale', 'missing', 'terminal', 'changed'].includes(value.checklistOutcome as string)))
        throw new Error('SAVE_FAILED: Watch receipt is invalid');
    return { name, ...(checklist ? { checklistOutcome: value.checklistOutcome as string } : {}) };
};

export async function readIOSWatchBatchOutcome(raw: string, current: () => void) {
    current();
    const { bodies, checklistNames } = readBatch(raw), adapter = getStorageAdapter();
    if (!(adapter instanceof NativeReceiptSqliteAdapter)) throw new Error('NOT_READY: Watch intake requires durable receipts');
    const completed = [];
    for (const [name, body] of bodies) {
        const saved = await adapter.readDurableReceipt(name.slice(0, -5), receiptPayload(body), { committedOnly: true });
        current();
        if (getStorageAdapter() !== adapter || !saved.ok) throw new Error('SAVE_FAILED: Watch receipt cannot be proven');
        if (saved.value === null) return null;
        completed.push(receiptReply(saved.value, name, checklistNames.has(name.slice(0, -5))));
    }
    return { version: 1 as const, ingested: completed.length, completed };
}

/** Native journals the complete immutable batch; physical queue retirement follows its durable completion. */
export async function ingestIOSWatchBatch(raw: string, deps: {
    contract: Contract;
    current: () => void;
    lastApplied: PendingCaptureRecordPort;
}) {
    deps.current();
    return ingestWatchBatch(readBatch(raw), deps);
}

async function ingestWatchBatch({ requestId, bodies, checklistNames }: ReturnType<typeof readBatch>, deps: {
    contract: Contract; current: () => void; lastApplied: PendingCaptureRecordPort;
}, audio?: PendingCaptureAudioPort) {
    const completed = new Set<string>(), outcomes = new Map<string, string>();
    const adapter = getStorageAdapter();
    if (!(adapter instanceof NativeReceiptSqliteAdapter)) throw new Error('NOT_READY: Watch intake requires durable receipts');
    const receipts = createNativeRequestReceipts({
        save: async () => {
            deps.current();
            if (getStorageAdapter() !== adapter) throw new Error('NOT_READY: Watch library changed');
            await flushPendingSave();
            deps.current();
            const state = getPersistenceStatus();
            return state.failed || state.queued || state.inFlight || state.immediate || state.retrying
                ? { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'Watch receipt save remains pending' } }
                : { ok: true as const, value: null };
        },
        receiptOnly: async (id, payload) => {
            deps.current();
            if (getStorageAdapter() !== adapter) throw new Error('NOT_READY: Watch library changed');
            return adapter.commitReceiptOnly(id, payload);
        },
    });
    const payload = (name: string) => receiptPayload(bodies.get(name)!);
    for (const name of bodies.keys()) {
        const saved = receipts.saved<unknown>(name.slice(0, -5), payload(name));
        if (!saved) continue;
        if (!saved.ok) throw new Error(`${saved.error.code}: ${saved.error.message}`);
        const reply = receiptReply(saved.value, name, checklistNames.has(name.slice(0, -5)));
        completed.add(name);
        if (reply.checklistOutcome) outcomes.set(name, reply.checklistOutcome);
    }
    const alreadyCompleted = completed.size;
    let recordFailed = false;
    const result = await deps.contract.ingestPendingCaptures({
        requestId,
        queue: {
            list: async () => { deps.current(); return [...bodies.keys()].filter(name => !completed.has(name)); },
            read: async name => { deps.current(); const body = bodies.get(name); if (body === undefined) throw invalid(); return body; },
            delete: async name => {
                deps.current();
                if (!bodies.has(name)) throw invalid();
                if (recordFailed) throw new Error('SAVE_FAILED: Watch ordering record remains pending');
                const saved = await receipts.run(name.slice(0, -5), payload(name), async () => ({ ok: true,
                    value: { name, ...(outcomes.has(name) ? { checklistOutcome: outcomes.get(name)! } : {}) } }));
                if (!saved.ok) throw new Error(`${saved.error.code}: ${saved.error.message}`);
                completed.add(name);
            },
        },
        lastApplied: {
            read: async () => { deps.current(); const value = await deps.lastApplied.read(); deps.current(); return value; },
            write: async value => { deps.current(); try { await deps.lastApplied.write(value); deps.current(); }
                catch (error) { recordFailed = true; throw error; } },
        },
        ...(audio ? { audio } : {}),
        settleWatchChecklist: async (id, outcome) => {
            deps.current();
            const name = checklistNames.get(id);
            if (!name || !['applied', 'stale', 'missing', 'terminal', 'changed'].includes(outcome)) throw invalid();
            outcomes.set(name, outcome);
        },
    });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    deps.current();
    if (result.value.ingested + alreadyCompleted !== bodies.size || completed.size !== bodies.size) throw new Error('SAVE_FAILED: Native Watch batch is incomplete');
    return { version: 1 as const, ingested: completed.size,
        completed: [...bodies.keys()].map(name => ({ name, ...(outcomes.has(name) ? { checklistOutcome: outcomes.get(name)! } : {}) })) };
}

export async function readIOSWatchAudioOutcome(sourceJSON: string, current: () => void) {
    current();
    const { capture, name, body } = readAudioSource(sourceJSON), adapter = getStorageAdapter();
    if (!(adapter instanceof NativeReceiptSqliteAdapter) || !isNativeRequestReceiptDurable('iosWatchIngestItem'))
        throw new Error('NOT_READY: Watch intake requires durable receipts');
    const payload = receiptPayload(body);
    const known = createNativeRequestReceipts({ save: async () => ({ ok: false, error: { code: 'SAVE_FAILED', message: 'Read-only Watch audio probe' } }) })
        .saved<unknown>(capture.id, payload);
    if (known && !known.ok) throw new Error('SAVE_FAILED: Watch audio receipt identity changed');
    const saved = await adapter.readDurableReceipt(capture.id, payload, { committedOnly: true });
    current();
    if (getStorageAdapter() !== adapter || !saved.ok || (saved.value === null && known !== null))
        throw new Error('SAVE_FAILED: Watch audio receipt cannot be proven');
    return saved.value === null ? null : { version: 1 as const, ingested: 1, completed: [receiptReply(saved.value, name, false)] };
}

export function readIOSWatchAudioNeedsTranscript(sourceJSON: string, current: () => void): boolean {
    current();
    const { capture } = readAudioSource(sourceJSON);
    const needsTranscript = !useTaskStore.getState()._allTasks.some(task => task.id.toLowerCase() === capture.id);
    current();
    return needsTranscript;
}

/** Only the native-owned immutable transcript envelope grants the shared drain an audio port. */
export async function ingestIOSWatchAudio(raw: string, deps: {
    contract: Contract; current: () => void; lastApplied: PendingCaptureRecordPort;
}) {
    deps.current();
    const source = readAudioEnvelope(raw);
    const saved = await readIOSWatchAudioOutcome(source.body, deps.current);
    if (saved) return saved;
    const current = () => {
        deps.current();
        if (source.transcript === null && readIOSWatchAudioNeedsTranscript(source.body, deps.current))
            throw new Error('NOT_READY: Watch audio replay requires its existing task');
    };
    current();
    const path = `watch-audio/${source.capture.id}.wav`;
    return ingestWatchBatch({ requestId: source.capture.id, bodies: new Map([[source.name, source.body]]), checklistNames: new Map() },
        { ...deps, current }, {
            resolvePath: capture => {
                current();
                if (capture.id !== source.capture.id || capture.audioPath !== source.capture.audioPath) throw invalid();
                return path;
            },
            transcribe: async resolved => {
                current();
                if (resolved !== path || source.transcript === null) throw invalid();
                return source.transcript;
            },
            delete: async resolved => { current(); if (resolved !== path) throw invalid(); },
        });
}
