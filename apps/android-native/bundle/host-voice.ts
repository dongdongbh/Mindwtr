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


export type VoiceRecorderCalls = {
    permission(): Promise<'granted' | 'denied'>;
    start(format: 'm4a' | 'wav'): Promise<{ id: string }>;
    stop(id: string): Promise<{ uri: string; size: number }>;
    cancel(id: string): Promise<void>;
};

export type VoiceCaptureLine =
    | { kind: 'capture'; outcome: 'saved' | 'cancelled' | 'permission-denied' | 'not-configured'; provider: string; durationMs?: string }

    | { kind: 'capture'; outcome: 'kept'; provider: string; copied: boolean }

    | { kind: 'capture'; outcome: 'failed'; provider: string; errorKind: 'recorder' | 'attachment' | 'save' | 'save-pending' }
    | { kind: 'transcribe'; outcome: 'applied' | 'empty' | 'skipped' | 'failed'; provider: string; errorKind?: string };

export type NativeVoiceBindings = {
    recorder: VoiceRecorderCalls;
    settings: () => AppSettings;
    store: QuickCaptureAudioStore;
    isFossBuild: boolean;

    loadKey: (provider: AIProviderId) => Promise<string>;

    whisperModelReady: () => boolean;

    persistAttachment: (attachment: Attachment) => Promise<Attachment>;

    submit: (input: { text: string; options: QuickCaptureOptions; captureId: string; fallbackTitle: string; attachments: Attachment[];
        openAfterSave?: boolean }) =>
        Promise<NativeHostResult<NativeQuickCaptureSubmitResult>>;
    readBytes: (uri: string) => Promise<Uint8Array>;

    deleteFile: (uri: string) => void;

    label: () => string;
    newId: () => string;

    log: (line: VoiceCaptureLine) => void;
    fetcher?: typeof fetch;
    formatDate?: (value: Date, pattern: string) => string;
    now?: () => Date;

    sandbox?: () => boolean;
};


type SavedNext = { projectId?: string; next: string; reset: unknown };

const nextOf = (saved: NativeHostResult<NativeQuickCaptureSubmitResult>): SavedNext => (saved.ok && saved.value.kind === 'saved'
    ? { projectId: saved.value.projectId, next: saved.value.next, reset: saved.value.reset }
    : { next: 'close', reset: null });

type Active = { id: string; session: number; format: 'm4a' | 'wav'; provider: string; startedAt: number };

const errorCode = (error: unknown) => (error instanceof Error ? error.message : '');


export const createNativeSpeechPorts = (bindings: { readBytes: (uri: string) => Promise<Uint8Array> }, uri: string, mimeType: string,
    logWarn: (message: string) => void): SpeechCapturePorts => ({
    readBytes: async () => ({ bytes: await bindings.readBytes(uri), mimeType }),
    withOpenAIUpload: async (send) => {
        const bytes = await bindings.readBytes(uri);

        return send({ part: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }), fileName: uri.slice(uri.lastIndexOf('/') + 1) });
    },
    transcribeLocal: async () => { throw new Error('Local Whisper is not available on this host yet'); },

    logWarn: (message) => { logWarn(message); },
});


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


    let held: {
        session: number; attachments: Attachment[]; recordings: string[];

        uncopied: Attachment[];
        title: string; provider: string;
    } | null = null;
    const heldFor = (session: number) => held !== null && held.session === session;


    let submitting: number | null = null;
    const dropHeld = (keep: (session: number) => boolean) => {
        const kept = held;
        if (!kept || keep(kept.session) || kept.session === submitting) return;
        held = null;
        [...kept.attachments, ...kept.uncopied].map((attachment) => attachment.uri).concat(kept.recordings).forEach(deleteQuietly);
    };


    const copyHeld = async (kept: NonNullable<typeof held>) => {
        while (kept.uncopied.length > 0) {
            const raw = kept.uncopied[0]!;
            kept.attachments.push(await bindings.persistAttachment(raw));
            kept.recordings.push(raw.uri);
            kept.uncopied.shift();
        }
        return kept.attachments;
    };
    const defaultAudio = () => bindings.settings().gtd?.defaultCaptureMethod === 'audio';

    const settleSubmission = (session: number) => {
        if (submitting === session) submitting = null;
        if (!coordinator.isCurrent(session)) dropHeld((owner) => owner !== session);
    };

    const transcriptions = new Set<Promise<void>>();

    const runtimeOf = (settings: AppSettings) => resolveSpeechToTextRuntimeSettings(settings.ai?.speechToText, { isFossBuild: bindings.isFossBuild });
    const keyFor = (runtime: ResolvedSpeechToTextRuntimeSettings) => (runtime.provider === 'whisper'
        ? Promise.resolve('') : bindings.loadKey(runtime.provider).catch(() => ''));


    const readiness = (runtime: ResolvedSpeechToTextRuntimeSettings, apiKey: string) => {
        const whisperModelReady = runtime.provider === 'whisper' && bindings.whisperModelReady();
        return {
            whisperModelReady,
            ready: isQuickCaptureSpeechReady({
                speechEnabled: runtime.enabled, provider: runtime.provider, apiKey, baseUrl: runtime.baseUrl, whisperModelReady,
            }),
        };
    };
    const deleteQuietly = (uri: string) => { try { bindings.deleteFile(uri); } catch {                                           } };

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
        | ({ status: 'saved'; taskId: string } & SavedNext)
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
        if (input.save) submitting = input.session;

        const owned = new Set<string>();
        let adopted = false;
        let stage: 'recorder' | 'attachment' | 'save' = 'recorder';
        try {

            const stopped = await bindings.recorder.stop(current.id);
            owned.add(stopped.uri);
            if (!input.save) {
                bindings.log({ kind: 'capture', outcome: 'cancelled', provider: current.provider });
                return { status: 'cancelled' };
            }

            if (!coordinator.isCurrent(input.session)) return { status: 'stale' };
            const at = now();
            const title = buildAudioNoteTitle(bindings.label(), at, bindings.formatDate);
            const settings = bindings.settings();
            const runtime = runtimeOf(settings);
            const apiKey = await keyFor(runtime);
            const { ready } = readiness(runtime, apiKey);

            const canTranscribe = runtime.provider === 'whisper' ? false : ready;
            const mimeType = getAudioMimeType(`.${current.format}`);
            const recovery = buildQuickCaptureAudioAttachment({ title, uri: stopped.uri, mimeType, size: stopped.size || undefined, now: at, newId: bindings.newId });

            stage = 'attachment';
            const attachment = shouldSaveQuickCaptureAudio(settings, canTranscribe) ? await bindings.persistAttachment(recovery) : null;
            if (attachment) owned.add(attachment.uri);
            if (!coordinator.isCurrent(input.session)) return { status: 'stale' };

            const prior = held !== null && held.session === input.session ? held : null;
            const priorAttachments = prior ? await copyHeld(prior) : [];
            stage = 'save';
            const captureId = bindings.newId();
            const saved = await bindings.submit({
                text: input.text ?? '', options: input.options!, captureId, fallbackTitle: title,
                attachments: [...priorAttachments, ...(attachment ? [attachment] : [])],
            });
            if (saved.ok && saved.value.kind === 'refused') {


                let kept = attachment;
                if (!kept) kept = await bindings.persistAttachment(recovery).catch(() => null);
                held = {
                    session: input.session,
                    attachments: [...priorAttachments, ...(kept ? [kept] : [])],
                    recordings: [...(prior?.recordings ?? []), ...(kept && kept.uri !== stopped.uri ? [stopped.uri] : [])],
                    uncopied: kept ? [] : [recovery],
                    title, provider: runtime.provider,
                };
                adopted = true;
                bindings.log({ kind: 'capture', outcome: 'kept', provider: runtime.provider, copied: kept !== null });
                return { status: 'refused', notice: saved.value.notice };
            }


            const landed = bindings.store.getState().tasks.find((task) => task.id === captureId.toLowerCase());
            const taskId = saved.ok && saved.value.kind === 'saved' && saved.value.taskId ? saved.value.taskId : landed?.id;
            if (!taskId) {
                bindings.log({ kind: 'capture', outcome: 'failed', provider: runtime.provider, errorKind: 'save' });
                return { status: 'failed' };
            }
            adopted = true;
            if (prior && held === prior) {
                held = null;
                prior.recordings.forEach(deleteQuietly);
            }
            if (saved.ok) {
                bindings.log({ kind: 'capture', outcome: 'saved', provider: runtime.provider, durationMs: durationBucket(at.getTime() - current.startedAt) });
            } else {
                bindings.log({ kind: 'capture', outcome: 'failed', provider: runtime.provider, errorKind: 'save-pending' });
            }
            const cleanupSource = !attachment || attachment.uri !== stopped.uri;

            const titleAtSave = bindings.store.getState().tasks.find((task) => task.id === taskId)?.title;
            if (canTranscribe) transcribe(taskId, titleAtSave, stopped.uri, attachment, cleanupSource, runtime, apiKey, settings, mimeType);
            else if (cleanupSource) deleteQuietly(stopped.uri);
            return { status: 'saved', taskId, ...nextOf(saved) };
        } catch {
            if (input.save) bindings.log({ kind: 'capture', outcome: 'failed', provider: current.provider, errorKind: stage });
            return { status: 'failed' };
        } finally {
            if (input.save) coordinator.finishSubmission(input.session);
            stopping = false;
            if (!adopted) owned.forEach(deleteQuietly);
            settleSubmission(input.session);
        }
    };


    const save = async (input: { session: number; text: string; options?: QuickCaptureOptions; openAfterSave?: boolean }): Promise<
        | ({ status: 'saved'; taskId: string } & SavedNext)
        | { status: 'idle' | 'busy' | 'failed' }
        | { status: 'refused'; notice: unknown }
    > => {
        const kept = held;
        if (!kept || kept.session !== input.session) return { status: 'idle' };
        if (!input.options) throw new Error('A voice save needs the popup draft options');
        if (stopping || !coordinator.tryBeginSubmission(input.session)) return { status: 'busy' };
        stopping = true;
        submitting = input.session;
        let stage: 'attachment' | 'save' = 'attachment';
        try {
            const attachments = await copyHeld(kept);
            stage = 'save';
            const captureId = bindings.newId();
            const saved = await bindings.submit({
                text: input.text, options: input.options, captureId, fallbackTitle: kept.title, attachments,
                openAfterSave: input.openAfterSave === true,
            });
            if (saved.ok && saved.value.kind === 'refused') {
                bindings.log({ kind: 'capture', outcome: 'kept', provider: kept.provider, copied: true });
                return { status: 'refused', notice: saved.value.notice };
            }

            const landed = bindings.store.getState().tasks.find((task) => task.id === captureId.toLowerCase());
            const taskId = saved.ok && saved.value.kind === 'saved' && saved.value.taskId ? saved.value.taskId : landed?.id;
            if (!taskId) {
                bindings.log({ kind: 'capture', outcome: 'failed', provider: kept.provider, errorKind: 'save' });
                return { status: 'failed' };
            }
            held = null;
            bindings.log(saved.ok
                ? { kind: 'capture', outcome: 'saved', provider: kept.provider }
                : { kind: 'capture', outcome: 'failed', provider: kept.provider, errorKind: 'save-pending' });
            kept.recordings.forEach(deleteQuietly);
            return { status: 'saved', taskId, ...nextOf(saved) };
        } catch {
            bindings.log({ kind: 'capture', outcome: 'failed', provider: kept.provider, errorKind: stage });
            return { status: 'failed' };
        } finally {
            coordinator.finishSubmission(input.session);
            stopping = false;
            settleSubmission(input.session);
        }
    };


    const leave = async (): Promise<{ status: 'left' }> => {
        starting = null;
        await cancelRecording(() => true);
        return { status: 'left' };
    };

    return {

        async open(): Promise<{ session: number; defaultAudio: boolean; sandbox: boolean }> {
            const session = coordinator.beginSession();
            await cancelRecording((owner) => owner !== session);
            dropHeld((owner) => owner === session);

            return { session, defaultAudio: defaultAudio(), sandbox: (bindings.sandbox ?? isSandboxMode)() };
        },

        async close(session: number): Promise<{ status: 'closed' }> {
            coordinator.invalidateSession(session);
            await cancelRecording((owner) => owner === session);
            dropHeld((owner) => owner !== session);
            return { status: 'closed' };
        },
        start,
        stop,
        save,
        leave,
        state: () => ({ recording: active !== null, busy: starting !== null || stopping, format: active?.format ?? null, held: held !== null }),

        settled: () => Promise.all([...transcriptions]).then(() => undefined),
        async request(name: string, input: Record<string, unknown>): Promise<unknown> {
            const session = typeof input.session === 'number' ? input.session : -1;
            switch (name) {
                case 'open': return this.open();
                case 'close': return this.close(session);
                case 'start': return start(session);

                case 'stop': return { ...await stop({ session, save: input.save === true, text: typeof input.text === 'string' ? input.text : '',
                    options: input.options as QuickCaptureOptions | undefined }), held: heldFor(session) };
                case 'save': return { ...await save({ session, text: typeof input.text === 'string' ? input.text : '',
                    options: input.options as QuickCaptureOptions | undefined, openAfterSave: input.openAfterSave === true }), held: heldFor(session) };
                case 'leave': return leave();
                case 'state': return this.state();

                case 'defaults': return { defaultAudio: defaultAudio() };
                default: throw new Error(`Unknown voice request ${name}`);
            }
        },
    };


    async function cancelRecording(ends: (session: number) => boolean) {
        const current = active;
        if (!current || !ends(current.session) || stopping) return;
        active = null;
        await bindings.recorder.cancel(current.id).catch(() => undefined);
        bindings.log({ kind: 'capture', outcome: 'cancelled', provider: current.provider });
    }
}

export type NativeVoice = ReturnType<typeof createNativeVoice>;


export const managedAttachmentsDirectory = (documents: string): string => `${documents}${ATTACHMENTS_DIR_NAME}/`;


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
