import { describe, expect, it } from 'bun:test';
import type { AppSettings, Attachment, Project, QuickCaptureAudioStore, QuickCaptureOptions, Task } from '@mindwtr/core';
import { createNativeVoice, persistIntoManagedStorage, type NativeVoiceBindings, type VoiceCaptureLine } from './host-voice';

// Voice pass V3: RN's quick capture recording on this host (use-quick-capture-audio.ts), with stand-ins for Kotlin's recorder,
// the store, the attachment port and the provider. Each RN fix this pass carries has its test, named by its commit.

const DOCS = 'file:///data/user/0/tech.dongdongbh.mindwtr.nativeclient.dev/files/';
const OPTIONS: QuickCaptureOptions = {
    note: '', dueDate: null, dueDateHasTime: false, startTime: null, contexts: [], projectId: null, areaId: null, priority: null,
    focus: false, addAnother: false,
};
const gemini = (extra: Record<string, unknown> = {}): AppSettings => ({ ai: { speechToText: { enabled: true, provider: 'gemini', ...extra } } } as never);

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};

const harness = (overrides: Partial<NativeVoiceBindings> = {}, setup: {
    settings?: AppSettings; key?: string; transcript?: string | Promise<string>; tags?: string[]; projectTitle?: string; save?: 'fails' | 'refused-before-landing';
} = {}) => {
    const deleted: string[] = [];
    const persisted: string[] = [];
    const lines: VoiceCaptureLine[] = [];
    const calls: string[] = [];
    const submitted: Array<{ text: string; fallbackTitle: string; attachments: Attachment[] }> = [];
    let next = 0;
    const state = {
        tasks: [] as Task[],
        projects: [] as Project[],
        settings: setup.settings ?? gemini(),
        addProject: async (title: string, color: string) => ({ id: `p-${title}`, title, color, status: 'active' } as Project),
        updateTask: async (id: string, updates: Partial<Task>) => {
            state.tasks = state.tasks.map((task) => (task.id === id ? { ...task, ...updates } : task));
            return { success: true };
        },
        deleteTask: async (id: string) => {
            calls.push(`deleteTask:${id}`);
            state.tasks = state.tasks.filter((task) => task.id !== id);
            return { success: true };
        },
    };
    // A test can land a "sync" when the store is read (onRead): a real sync lands between reads, never inside a store command.
    const reads = { onRead: undefined as undefined | (() => void) };
    const store = { getState: () => { reads.onRead?.(); return state; } } as unknown as QuickCaptureAudioStore;
    const transcript = setup.transcript ?? 'Buy milk';
    const voice = createNativeVoice({
        recorder: {
            permission: async () => { calls.push('permission'); return 'granted'; },
            start: async (format) => { calls.push(`start:${format}`); return { id: `rec-${++next}` }; },
            stop: async (id) => { calls.push(`stop:${id}`); return { uri: `${DOCS}voice-captures/${id}.m4a`, size: 2048 }; },
            cancel: async (id) => { calls.push(`cancel:${id}`); },
        },
        settings: () => state.settings,
        store,
        isFossBuild: false,
        loadKey: async () => setup.key ?? 'secret-key',
        whisperModelReady: () => false,
        persistAttachment: async (attachment) => {
            persisted.push(attachment.uri);
            return { ...attachment, uri: `${DOCS}attachments/${attachment.id}.m4a` };
        },
        submit: async (input) => {
            submitted.push(input);
            const task = { id: input.captureId, title: input.text.trim() || input.fallbackTitle, status: 'inbox', tags: ['#synced'], contexts: [],
                attachments: input.attachments, createdAt: '', updatedAt: '' } as unknown as Task;
            // Core's addTask lands the task before the save; a save that fails leaves it in the store (SAVE_FAILED).
            if (setup.save === 'refused-before-landing') return { ok: false, error: { code: 'ACTION_FAILED', message: 'Write failed' } };
            state.tasks = [...state.tasks, task];
            if (setup.save === 'fails') return { ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } };
            return { ok: true, value: { kind: 'saved', taskId: task.id, projectId: undefined, next: 'close', reset: null } };
        },
        readBytes: async () => new Uint8Array([1, 2, 3]),
        deleteFile: (uri) => { deleted.push(uri); },
        label: () => 'Audio note',
        newId: () => `00000000-0000-4000-8000-00000000000${++next}`,
        log: (line) => { lines.push(line); },
        formatDate: () => '06/29/2026, 9:00 AM',
        // Another bundle test file can leave core's sandbox on for the process.
        sandbox: () => false,
        fetcher: (async () => new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: await transcript, title: (await transcript) || null, tags: setup.tags ?? null, projectTitle: setup.projectTitle ?? null }) }] } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
        ...overrides,
    });
    return { voice, state, deleted, persisted, lines, calls, submitted, reads };
};

const record = async (h: ReturnType<typeof harness>) => {
    const { session } = await h.voice.open();
    expect(await h.voice.start(session)).toEqual({ status: 'recording', format: 'm4a' });
    return session;
};

describe('native voice capture', () => {
    it('saves the task first with its recording, then a late transcript updates the latest row (RN 78c151b2e)', async () => {
        const late = deferred<string>();
        const h = harness({}, { transcript: late.promise, tags: ['#errand'], projectTitle: 'Errands' });
        const session = await record(h);
        const saved = await h.voice.stop({ session, save: true, text: '', options: OPTIONS });
        expect(saved.status).toBe('saved');
        const taskId = (saved as { taskId: string }).taskId;
        expect(h.submitted[0]?.fallbackTitle).toBe('Audio note 06/29/2026, 9:00 AM');
        expect(h.submitted[0]?.attachments.map((attachment) => attachment.uri)).toEqual([`${DOCS}attachments/${h.submitted[0]!.attachments[0]!.id}.m4a`]);
        // A sync lands after the transcript's first read of the row and before its store command: the write is built again on
        // the row as it is then.
        let count = 0;
        h.reads.onRead = () => {
            count += 1;
            if (count === 2) h.state.tasks = h.state.tasks.map((task) => (task.id === taskId ? { ...task, tags: ['#synced', '#later'] } : task));
        };
        late.resolve('Buy milk');
        await h.voice.settled();
        const task = h.state.tasks.find((entry) => entry.id === taskId)!;
        expect(task.title).toBe('Buy milk');
        // The transcript's tag joins the row as stored now: the tag the sync added meanwhile survives.
        expect(task.tags).toEqual(expect.arrayContaining(['#synced', '#later', '#errand']));
        expect(task.projectId).toBe('p-Errands');
        // The original recording goes once its managed copy is the task's.
        expect(h.deleted).toEqual([`${DOCS}voice-captures/rec-1.m4a`]);
        expect(h.lines.map((line) => `${line.kind}:${line.outcome}`)).toEqual(['capture:saved', 'transcribe:applied']);
    });

    it('an empty transcript deletes the task and both files', async () => {
        const h = harness({}, { transcript: '' });
        const session = await record(h);
        const saved = await h.voice.stop({ session, save: true, text: '', options: OPTIONS }) as { taskId: string };
        await h.voice.settled();
        expect(h.calls).toContain(`deleteTask:${saved.taskId}`);
        expect(h.state.tasks).toEqual([]);
        expect(new Set(h.deleted)).toEqual(new Set([`${DOCS}voice-captures/rec-1.m4a`, h.submitted[0]!.attachments[0]!.uri]));
        expect(h.lines.at(-1)).toEqual({ kind: 'transcribe', outcome: 'empty', provider: 'gemini' });
    });

    it('with save audio off and speech ready, the task keeps no recording and the file goes', async () => {
        const h = harness({}, { settings: { ...gemini(), gtd: { saveAudioAttachments: false } } as AppSettings });
        const session = await record(h);
        await h.voice.stop({ session, save: true, text: '', options: OPTIONS });
        await h.voice.settled();
        expect(h.persisted).toEqual([]);
        expect(h.submitted[0]?.attachments).toEqual([]);
        expect(h.deleted).toEqual([`${DOCS}voice-captures/rec-1.m4a`]);
    });

    it('with no speech set up, a start toasts and records nothing (RN 767dca040, #886)', async () => {
        const h = harness({}, { key: '' });
        const { session } = await h.voice.open();
        expect(await h.voice.start(session)).toEqual({ status: 'not-configured' });
        expect(h.calls).toEqual([]);
        expect(h.lines).toEqual([{ kind: 'capture', outcome: 'not-configured', provider: 'gemini' }]);
    });

    it('a FOSS build forces Whisper and refuses cloud speech: with no local model, nothing records', async () => {
        const h = harness({ isFossBuild: true }, { settings: gemini({ provider: 'openai' }) });
        const { session } = await h.voice.open();
        expect(await h.voice.start(session)).toEqual({ status: 'not-configured' });
        expect(h.calls).toEqual([]);
        expect(h.lines[0]).toEqual({ kind: 'capture', outcome: 'not-configured', provider: 'whisper' });
    });

    it('a popup closed or reopened while it recorded saves nothing and leaves no file (RN 9604387e4, c5fc870fe, 47b2f11a1)', async () => {
        const h = harness();
        const first = await record(h);
        // Reopened: the old session's recording ends unsaved.
        const { session } = await h.voice.open();
        expect(h.calls).toContain('cancel:rec-1');
        expect(await h.voice.stop({ session: first, save: true, text: '', options: OPTIONS })).toEqual({ status: 'idle' });

        // Closed while the save copies the recording: the stale submission writes nothing, and the recording and its copy go.
        const gate = deferred<void>();
        const copying = deferred<void>();
        const slow = harness({
            persistAttachment: async (attachment) => {
                copying.resolve();
                await gate.promise;
                return { ...attachment, uri: `${DOCS}attachments/${attachment.id}.m4a` };
            },
        });
        const current = await record(slow);
        const stopping = slow.voice.stop({ session: current, save: true, text: '', options: OPTIONS });
        await copying.promise;
        await slow.voice.close(current);
        gate.resolve();
        expect(await stopping).toEqual({ status: 'stale' });
        expect(slow.submitted).toEqual([]);
        expect(slow.deleted.length).toBe(2);
        expect(slow.deleted[0]).toBe(`${DOCS}voice-captures/rec-1.m4a`);
        expect(slow.deleted[1]!.startsWith(`${DOCS}attachments/`)).toBe(true);
        expect(session).toBeGreaterThan(first);
    });

    it('a recording that cannot reach managed storage saves no task and leaves no file (RN 763c5192c, 67b707e3e, a11bc850d, #788)', async () => {
        const h = harness({ persistAttachment: async () => { throw new Error('disk full'); } });
        const session = await record(h);
        expect(await h.voice.stop({ session, save: true, text: '', options: OPTIONS })).toEqual({ status: 'failed' });
        expect(h.submitted).toEqual([]);
        expect(h.deleted).toEqual([`${DOCS}voice-captures/rec-1.m4a`]);
    });

    it('a WAV start that cannot open the microphone records m4a instead, as RN falls back from Whisper', async () => {
        const starts: string[] = [];
        const h = harness({
            whisperModelReady: () => true,
            recorder: {
                permission: async () => 'granted',
                start: async (format) => {
                    starts.push(format);
                    if (format === 'wav') throw new Error('E_VOICE_START_FAILED');
                    return { id: 'rec-m4a' };
                },
                stop: async () => ({ uri: `${DOCS}voice-captures/rec-m4a.m4a`, size: 1 }),
                cancel: async () => undefined,
            },
        }, { settings: gemini({ provider: 'whisper' }) });
        const { session } = await h.voice.open();
        expect(await h.voice.start(session)).toEqual({ status: 'recording', format: 'm4a' });
        expect(starts).toEqual(['wav', 'm4a']);
    });

    it('a start the app left before the microphone opened does nothing: no m4a retry, no error', async () => {
        const starts: string[] = [];
        const h = harness({
            whisperModelReady: () => true,
            recorder: {
                permission: async () => 'granted',
                start: async (format) => { starts.push(format); throw new Error('E_VOICE_CANCELLED'); },
                stop: async () => ({ uri: '', size: 0 }),
                cancel: async () => undefined,
            },
        }, { settings: gemini({ provider: 'whisper' }) });
        const { session } = await h.voice.open();
        expect(await h.voice.start(session)).toEqual({ status: 'stale' });
        expect(starts).toEqual(['wav']);
        expect(h.voice.state()).toEqual({ recording: false, busy: false, format: null });
    });

    it('a save that landed but could not reach the disk keeps its files and transcribes, as RN keeps them once addTask succeeded (review B1)', async () => {
        const h = harness({}, { save: 'fails' });
        const session = await record(h);
        const saved = await h.voice.stop({ session, save: true, text: '', options: OPTIONS }) as { status: string; taskId: string };
        expect(saved.status).toBe('saved');
        await h.voice.settled();
        // The managed copy stays with the task; only the original recording goes, after the transcription, as on a saved capture.
        expect(h.deleted).toEqual([`${DOCS}voice-captures/rec-1.m4a`]);
        expect(h.state.tasks.find((task) => task.id === saved.taskId)?.title).toBe('Buy milk');
        expect(h.lines.map((line) => `${line.kind}:${line.outcome}:${'errorKind' in line ? line.errorKind ?? '' : ''}`))
            .toEqual(['capture:failed:save-pending', 'transcribe:applied:']);
    });

    it('a save refused before the task landed leaves no file and says why, by kind only', async () => {
        const h = harness({}, { save: 'refused-before-landing' });
        const session = await record(h);
        expect(await h.voice.stop({ session, save: true, text: '', options: OPTIONS })).toEqual({ status: 'failed' });
        expect(h.deleted.length).toBe(2);
        expect(h.lines).toEqual([{ kind: 'capture', outcome: 'failed', provider: 'gemini', errorKind: 'save' }]);
    });

    it('the managed copy must be a file under the attachments folder before the task saves (RN cacheAudioAttachmentOrThrow)', async () => {
        const attachment = { id: 'a1', kind: 'file', title: 'Audio note', uri: `${DOCS}voice-captures/r.m4a`, createdAt: '', updatedAt: '' } as Attachment;
        const check = (uri: string, info: { exists?: boolean; isDirectory?: boolean } | null) => persistIntoManagedStorage(attachment, {
            persist: async (entry) => ({ ...entry, uri }), getInfo: async () => info, managedDirectory: `${DOCS}attachments/`,
        });
        await expect(check(`${DOCS}attachments/a1.m4a`, { exists: true, isDirectory: false })).resolves.toMatchObject({ uri: `${DOCS}attachments/a1.m4a` });
        await expect(check(`${DOCS}voice-captures/r.m4a`, { exists: true })).rejects.toThrow('not cached');
        await expect(check(`${DOCS}attachments/a1.m4a`, { exists: false })).rejects.toThrow('not cached');
        await expect(check(`${DOCS}attachments/a1.m4a`, null)).rejects.toThrow('not cached');
        await expect(check(`${DOCS}attachments/a1.m4a`, { exists: true, isDirectory: true })).rejects.toThrow('not cached');
    });

    it('a cancel deletes the recording and saves nothing', async () => {
        const h = harness();
        const session = await record(h);
        expect(await h.voice.stop({ session, save: false })).toEqual({ status: 'cancelled' });
        expect(h.submitted).toEqual([]);
        expect(h.deleted).toEqual([`${DOCS}voice-captures/rec-1.m4a`]);
    });

    it('never logs a transcript, a title or a key', async () => {
        const h = harness({}, { transcript: 'Secret plan' });
        const session = await record(h);
        await h.voice.stop({ session, save: true, text: '', options: OPTIONS });
        await h.voice.settled();
        const text = JSON.stringify(h.lines);
        for (const secret of ['Secret plan', 'Audio note', 'secret-key', 'voice-captures']) expect(text).not.toContain(secret);
    });
});
