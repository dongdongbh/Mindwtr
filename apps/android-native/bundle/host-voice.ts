import {
    applySpeechResult,
    ATTACHMENTS_DIR_NAME,
    buildAudioNoteTitle,
    buildQuickCaptureAudioAttachment,
    CaptureSessionCoordinator,
    discardEmptySpeechTask,
    dispatchSpeechCapture,
    getAudioMimeType,
    isQuickCaptureSpeechReady,
    isSandboxMode,
    REMOTE_SPEECH_TO_TEXT_FOSS_ERROR,
    resolveQuickCaptureAudioFormat,
    resolveSpeechToTextRuntimeSettings,
    shouldSaveQuickCaptureAudio,
    type AIProviderId,
    type AppSettings,
    type Attachment,
    type NativeHostResult,
    type NativeQuickCaptureSubmitResult,
    type QuickCaptureAudioStore,
    type QuickCaptureOptions,
    type ResolvedSpeechToTextRuntimeSettings,
    type SpeechCapturePorts,
    type SpeechToTextConfig,
} from '@mindwtr/core';

/**
 * Voice capture on this host (voice pass V3): RN's use-quick-capture-audio.ts start and stop, over core's quick-capture-audio
 * rules, Kotlin's recorder (VoiceRecorder.kt through `__mindwtrVoiceCall`), the capture contract's save and the polyfill's
 * fetch. The popup (V5) opens a session, starts, then stops with its draft: the task saves first with the recording, and the
 * transcript reaches it later, as in RN. Local Whisper comes with V4: until then Whisper is not ready, so it records nothing.
 */

/** Kotlin's microphone (HostVoice.kt). A start rejects with E_VOICE_START_FAILED, E_VOICE_BUSY or E_VOICE_CANCELLED. */
export type VoiceRecorderCalls = {
    permission(): Promise<'granted' | 'denied'>;
    start(format: 'm4a' | 'wav'): Promise<{ id: string }>;
    stop(id: string): Promise<{ uri: string; size: number }>;
    cancel(id: string): Promise<void>;
};

export type VoiceCaptureLine =
    | { kind: 'capture'; outcome: 'saved' | 'cancelled' | 'permission-denied' | 'not-configured'; provider: string; durationMs?: string }
    /** A stop that saved no durable task: `save-pending` landed in the store and its save is retried; the others saved nothing. */
    | { kind: 'capture'; outcome: 'failed'; provider: string; errorKind: 'recorder' | 'attachment' | 'save' | 'save-pending' }
    | { kind: 'transcribe'; outcome: 'applied' | 'empty' | 'skipped' | 'failed'; provider: string; errorKind?: string };

export type NativeVoiceBindings = {
    recorder: VoiceRecorderCalls;
    settings: () => AppSettings;
    store: QuickCaptureAudioStore;
    isFossBuild: boolean;
    /** RN's loadAIKey: the provider's key, '' when none. */
    loadKey: (provider: AIProviderId) => Promise<string>;
    /** Local Whisper's model is on the device (pass V4). */
    whisperModelReady: () => boolean;
    /** RN's cacheAudioAttachmentOrThrow: the recording copied into managed attachment storage and checked there. */
    persistAttachment: (attachment: Attachment) => Promise<Attachment>;
    /** The capture contract's submitQuickCaptureAudio. */
    submit: (input: { text: string; options: QuickCaptureOptions; captureId: string; fallbackTitle: string; attachments: Attachment[] }) =>
        Promise<NativeHostResult<NativeQuickCaptureSubmitResult>>;
    readBytes: (uri: string) => Promise<Uint8Array>;
    /** Deletes a recording or its managed copy; a file already gone is no error. */
    deleteFile: (uri: string) => void;
    /** quickAdd.audioNoteTitle in the app's language. */
    label: () => string;
    newId: () => string;
    /** Fixed fields only: never audio, transcript, titles, keys, paths or a provider's error text. */
    log: (line: VoiceCaptureLine) => void;
    fetcher?: typeof fetch;
    formatDate?: (value: Date, pattern: string) => string;
    now?: () => Date;
    /** core's isSandboxMode unless set: a sandboxed capture records nothing, as RN's. */
    sandbox?: () => boolean;
};

type Active = { id: string; session: number; format: 'm4a' | 'wav'; provider: string; startedAt: number };

const errorCode = (error: unknown) => (error instanceof Error ? error.message : '');

/** RN's processAudioCapture ports for one recording: its bytes, an OpenAI multipart part (the polyfill's Blob), no local Whisper yet. */
export const createNativeSpeechPorts = (bindings: { readBytes: (uri: string) => Promise<Uint8Array> }, uri: string, mimeType: string,
    logWarn: (message: string) => void): SpeechCapturePorts => ({
    readBytes: async () => ({ bytes: await bindings.readBytes(uri), mimeType }),
    withOpenAIUpload: async (send) => {
        const bytes = await bindings.readBytes(uri);
        // The recording's own bytes: the file port answers them on a plain ArrayBuffer, so no copy is needed.
        return send({ part: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }), fileName: uri.slice(uri.lastIndexOf('/') + 1) });
    },
    transcribeLocal: async () => { throw new Error('Local Whisper is not available on this host yet'); },
    // Core's warning carries the provider's error text in `extra`: only the message goes to the log.
    logWarn: (message) => { logWarn(message); },
});

/** RN's speech config for a capture (use-quick-capture-audio.ts speechConfig, watch-audio.ts transcribePendingAudio). */
export const speechConfigFor = (runtime: ResolvedSpeechToTextRuntimeSettings, apiKey: string, settings: AppSettings, now: Date): SpeechToTextConfig => ({
    provider: runtime.provider,
    apiKey,
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    modelPath: runtime.modelPath,
    isFossBuild: runtime.isFossBuild,
    language: runtime.language,
    mode: runtime.mode,
    fieldStrategy: runtime.fieldStrategy,
    parseModel: runtime.provider === 'openai' && settings.ai?.provider === 'openai' ? settings.ai?.model : undefined,
    now,
    timeZone: typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
});

/** A failure's fixed kind for the log, never its text. */
const transcribeErrorKind = (error: unknown) => {
    if (error instanceof Error && error.message === REMOTE_SPEECH_TO_TEXT_FOSS_ERROR) return 'foss-refused';
    if (error instanceof Error && error.name === 'AbortError') return 'aborted';
    if (error instanceof TypeError) return 'network';
    return 'provider';
};

const durationBucket = (ms: number) => (ms < 5_000 ? '<5s' : ms < 30_000 ? '<30s' : ms < 120_000 ? '<2m' : '>=2m');

export function createNativeVoice(bindings: NativeVoiceBindings) {
    const coordinator = new CaptureSessionCoordinator();
    const now = bindings.now ?? (() => new Date());
    let active: Active | null = null;
    let starting: { session: number } | null = null;
    let stopping = false;
    /** Transcriptions still running after their task saved (RN's detached speech promise). */
    const transcriptions = new Set<Promise<void>>();

    const runtimeOf = (settings: AppSettings) => resolveSpeechToTextRuntimeSettings(settings.ai?.speechToText, { isFossBuild: bindings.isFossBuild });
    const keyFor = (runtime: ResolvedSpeechToTextRuntimeSettings) => (runtime.provider === 'whisper'
        ? Promise.resolve('') : bindings.loadKey(runtime.provider).catch(() => ''));
    // RN's isQuickCaptureSpeechReady with this host's Whisper: ready only with a model on the device (V4). No stored model path
    // counts, so a path whose file is gone never reads as ready (RN bug 1, rn-voice-bugs, is not carried here).
    const readiness = (runtime: ResolvedSpeechToTextRuntimeSettings, apiKey: string) => {
        const whisperModelReady = runtime.provider === 'whisper' && bindings.whisperModelReady();
        return {
            whisperModelReady,
            ready: isQuickCaptureSpeechReady({
                speechEnabled: runtime.enabled, provider: runtime.provider, apiKey, baseUrl: runtime.baseUrl, whisperModelReady,
            }),
        };
    };
    const deleteQuietly = (uri: string) => { try { bindings.deleteFile(uri); } catch { /* best effort, as RN's safeDeleteFile */ } };

    const start = async (session: number): Promise<{ status: string; format?: 'm4a' | 'wav' }> => {
        if ((bindings.sandbox ?? isSandboxMode)()) return { status: 'sandbox' };
        if (active || starting || stopping) return { status: 'busy' };
        if (!coordinator.isCurrent(session)) return { status: 'stale' };
        const owner = { session };
        starting = owner;
        const current = () => starting === owner && coordinator.isCurrent(session);
        try {
            const runtime = runtimeOf(bindings.settings());
            const apiKey = await keyFor(runtime);
            if (!current()) return { status: 'stale' };
            const { ready, whisperModelReady } = readiness(runtime, apiKey);
            // RN 767dca040 (#886): no speech set up, no recording: the popup shows quickAdd.speechNotConfigured.
            if (!ready) {
                bindings.log({ kind: 'capture', outcome: 'not-configured', provider: runtime.provider });
                return { status: 'not-configured' };
            }
            const permission = await bindings.recorder.permission();
            if (!current()) return { status: 'stale' };
            if (permission !== 'granted') {
                bindings.log({ kind: 'capture', outcome: 'permission-denied', provider: runtime.provider });
                return { status: 'permission-denied' };
            }
            let format = resolveQuickCaptureAudioFormat({ speechEnabled: runtime.enabled, provider: runtime.provider, whisperModelReady });
            let started: { id: string };
            try {
                started = await bindings.recorder.start(format);
            } catch (error) {
                // RN falls back to an m4a recording when its Whisper start fails ('Whisper realtime start failed, falling back').
                if (format !== 'wav' || errorCode(error) !== 'E_VOICE_START_FAILED' || !current()) throw error;
                format = 'm4a';
                started = await bindings.recorder.start(format);
            }
            if (!current()) {
                await bindings.recorder.cancel(started.id).catch(() => undefined);
                return { status: 'stale' };
            }
            active = { id: started.id, session, format, provider: runtime.provider, startedAt: now().getTime() };
            return { status: 'recording', format };
        } catch (error) {
            // The app left before the microphone opened: nothing recorded, nothing to retry or show, as RN's stale start.
            if (errorCode(error) === 'E_VOICE_CANCELLED') return { status: 'stale' };
            return { status: 'failed' };
        } finally {
            if (starting === owner) starting = null;
        }
    };

    const transcribe = (taskId: string, titleAtSave: string | undefined, recording: string, attachment: Attachment | null, cleanupSource: boolean,
        runtime: ResolvedSpeechToTextRuntimeSettings, apiKey: string, settings: AppSettings, mimeType: string) => {
        const run = (async () => {
            const transcriptionUri = attachment?.uri ?? recording;
            try {
                const ports = { ...createNativeSpeechPorts(bindings, transcriptionUri, mimeType, () => undefined),
                    ...(bindings.fetcher ? { fetcher: bindings.fetcher } : {}) };
                const result = await dispatchSpeechCapture(speechConfigFor(runtime, apiKey, settings, now()), runtime.isFossBuild, ports);
                const applied = await applySpeechResult(taskId, result, bindings.store, { titleAtSave });
                if (applied === 'empty') {
                    await discardEmptySpeechTask(taskId, [{ uri: recording }, attachment ? { uri: attachment.uri } : null], 'speech_empty_transcript', {
                        store: bindings.store, deleteFile: (file) => deleteQuietly(file.uri), onWarn: () => undefined,
                    });
                }
                bindings.log({ kind: 'transcribe', outcome: applied, provider: runtime.provider });
            } catch (error) {
                bindings.log({ kind: 'transcribe', outcome: 'failed', provider: runtime.provider, errorKind: transcribeErrorKind(error) });
            } finally {
                if (cleanupSource) deleteQuietly(recording);
            }
        })();
        transcriptions.add(run);
        void run.finally(() => transcriptions.delete(run));
    };

    const stop = async (input: { session: number; save: boolean; text?: string; options?: QuickCaptureOptions }): Promise<
        | { status: 'saved'; taskId: string }
        | { status: 'cancelled' | 'stale' | 'idle' | 'busy' | 'failed' }
        | { status: 'refused'; notice: unknown }
    > => {
        const current = active;
        if (!current || stopping) return { status: 'idle' };
        if (current.session !== input.session) return { status: 'stale' };
        if (input.save && !input.options) throw new Error('A voice save needs the popup draft options');
        if (input.save && !coordinator.tryBeginSubmission(input.session)) return { status: 'busy' };
        active = null;
        stopping = true;
        // Files this stop made: deleted at the end unless a saved task adopted them (RN 47b2f11a1).
        const owned = new Set<string>();
        let adopted = false;
        let stage: 'recorder' | 'attachment' | 'save' = 'recorder';
        try {
            // RN d596ecce6: the recorder is stopped and released before anything reads the file.
            const stopped = await bindings.recorder.stop(current.id);
            owned.add(stopped.uri);
            if (!input.save) {
                bindings.log({ kind: 'capture', outcome: 'cancelled', provider: current.provider });
                return { status: 'cancelled' };
            }
            // RN 9604387e4 / c5fc870fe: a closed or reopened popup's recording saves nothing.
            if (!coordinator.isCurrent(input.session)) return { status: 'stale' };
            const at = now();
            const title = buildAudioNoteTitle(bindings.label(), at, bindings.formatDate);
            const settings = bindings.settings();
            const runtime = runtimeOf(settings);
            const apiKey = await keyFor(runtime);
            const { ready } = readiness(runtime, apiKey);
            // Whisper transcribes on the device (V4): until then a Whisper recording keeps its audio and no transcript.
            const canTranscribe = runtime.provider === 'whisper' ? false : ready;
            const mimeType = getAudioMimeType(`.${current.format}`);
            const recovery = buildQuickCaptureAudioAttachment({ title, uri: stopped.uri, mimeType, size: stopped.size || undefined, now: at, newId: bindings.newId });
            // RN 763c5192c / 67b707e3e / a11bc850d (#788): the attachment is durable in managed storage before the task saves.
            stage = 'attachment';
            const attachment = shouldSaveQuickCaptureAudio(settings, canTranscribe) ? await bindings.persistAttachment(recovery) : null;
            if (attachment) owned.add(attachment.uri);
            if (!coordinator.isCurrent(input.session)) return { status: 'stale' };
            stage = 'save';
            const captureId = bindings.newId();
            const saved = await bindings.submit({
                text: input.text ?? '', options: input.options!, captureId, fallbackTitle: title, attachments: attachment ? [attachment] : [],
            });
            if (saved.ok && saved.value.kind === 'refused') return { status: 'refused', notice: saved.value.notice };
            // Review B1: a task with this capture ID in the store points to these files, saved or not (core's addTask landed it and
            // the store retries its save), so they stay, as RN keeps them once addTask succeeded.
            const landed = bindings.store.getState().tasks.find((task) => task.id === captureId.toLowerCase());
            const taskId = saved.ok && saved.value.kind === 'saved' && saved.value.taskId ? saved.value.taskId : landed?.id;
            if (!taskId) {
                bindings.log({ kind: 'capture', outcome: 'failed', provider: runtime.provider, errorKind: 'save' });
                return { status: 'failed' };
            }
            adopted = true;
            if (saved.ok) {
                bindings.log({ kind: 'capture', outcome: 'saved', provider: runtime.provider, durationMs: durationBucket(at.getTime() - current.startedAt) });
            } else {
                bindings.log({ kind: 'capture', outcome: 'failed', provider: runtime.provider, errorKind: 'save-pending' });
            }
            const cleanupSource = !attachment || attachment.uri !== stopped.uri;
            // The title as it saved: a title the user types before the transcript arrives stays (voice V3 review N11).
            const titleAtSave = bindings.store.getState().tasks.find((task) => task.id === taskId)?.title;
            if (canTranscribe) transcribe(taskId, titleAtSave, stopped.uri, attachment, cleanupSource, runtime, apiKey, settings, mimeType);
            else if (cleanupSource) deleteQuietly(stopped.uri);
            return { status: 'saved', taskId };
        } catch {
            if (input.save) bindings.log({ kind: 'capture', outcome: 'failed', provider: current.provider, errorKind: stage });
            return { status: 'failed' };
        } finally {
            if (input.save) coordinator.finishSubmission(input.session);
            stopping = false;
            if (!adopted) owned.forEach(deleteQuietly);
        }
    };

    return {
        /** The popup opened: a new session; an older session's recording ends without saving. */
        async open(): Promise<{ session: number }> {
            const session = coordinator.beginSession();
            await cancelRecording((owner) => owner !== session);
            return { session };
        },
        /** The popup closed: its session ends, and its recording with it, unsaved (RN's sheet close). */
        async close(session: number): Promise<{ status: 'closed' }> {
            coordinator.invalidateSession(session);
            await cancelRecording((owner) => owner === session);
            return { status: 'closed' };
        },
        start,
        stop,
        state: () => ({ recording: active !== null, busy: starting !== null || stopping, format: active?.format ?? null }),
        /** Tests and the boot: every transcription still running has ended. */
        settled: () => Promise.all([...transcriptions]).then(() => undefined),
        async request(name: string, input: Record<string, unknown>): Promise<unknown> {
            const session = typeof input.session === 'number' ? input.session : -1;
            switch (name) {
                case 'open': return this.open();
                case 'close': return this.close(session);
                case 'start': return start(session);
                case 'stop': return stop({ session, save: input.save === true, text: typeof input.text === 'string' ? input.text : '',
                    options: input.options as QuickCaptureOptions | undefined });
                case 'state': return this.state();
                default: throw new Error(`Unknown voice request ${name}`);
            }
        },
    };

    /** Ends the recording of a closed or replaced popup's session ([ends] picks it), with no file left. */
    async function cancelRecording(ends: (session: number) => boolean) {
        const current = active;
        if (!current || !ends(current.session) || stopping) return;
        active = null;
        await bindings.recorder.cancel(current.id).catch(() => undefined);
        bindings.log({ kind: 'capture', outcome: 'cancelled', provider: current.provider });
    }
}

export type NativeVoice = ReturnType<typeof createNativeVoice>;

/** RN's getAttachmentsDir: core's ATTACHMENTS_DIR_NAME under the app's documents folder (`file:///…/files/`). */
export const managedAttachmentsDirectory = (documents: string): string => `${documents}${ATTACHMENTS_DIR_NAME}/`;

/**
 * RN's cacheAudioAttachmentOrThrow: the recording copied into managed attachment storage (the attachment port), then checked
 * there, a file under [managedDirectory], before any task points to it (#788).
 */
export const persistIntoManagedStorage = async (attachment: Attachment, ports: {
    persist: (attachment: Attachment) => Promise<Attachment>;
    getInfo: (uri: string) => Promise<{ exists?: boolean; isDirectory?: boolean } | null>;
    managedDirectory: string;
}): Promise<Attachment> => {
    const cached = await ports.persist(attachment);
    const info = await ports.getInfo(cached.uri);
    if (!cached.uri.startsWith(ports.managedDirectory) || info?.exists !== true || info.isDirectory) {
        throw new Error('Audio attachment was not cached into managed storage');
    }
    return cached;
};
