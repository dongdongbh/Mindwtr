import { describe, expect, it, vi } from 'vitest';
import {
    applySpeechResult,
    buildAudioNoteTitle,
    buildQuickCaptureAudioAttachment,
    discardEmptySpeechTask,
    dispatchSpeechCapture,
    getAudioMimeType,
    isQuickCaptureSpeechReady,
    REMOTE_SPEECH_TO_TEXT_FOSS_ERROR,
    resolveQuickCaptureAudioFormat,
    resolveSpeechToTextRuntimeSettings,
    shouldSaveQuickCaptureAudio,
    type QuickCaptureAudioStore,
} from './quick-capture-audio';
import type { AppSettings, Project, Task } from './types';

// Moved from apps/mobile (pass V1): the speech settings tests from lib/speech-to-text.test.ts, the readiness tests from
// components/quick-capture-sheet.utils.test.ts. RN's hook tests (use-quick-capture-audio.test.tsx) still cover the rest
// through the hook.
describe('speech-to-text runtime settings (moved from RN)', () => {
    it('forces synced remote speech settings to local Whisper in FOSS builds', () => {
        expect(
            resolveSpeechToTextRuntimeSettings(
                {
                    enabled: true,
                    provider: 'openai',
                    model: 'gpt-4o-transcribe',
                    offlineModelPath: 'file:///document/whisper-models/ggml-tiny.bin',
                    language: 'en',
                    mode: 'transcribe_only',
                    fieldStrategy: 'description_only',
                },
                { isFossBuild: true }
            )
        ).toMatchObject({
            provider: 'whisper',
            enabled: true,
            model: 'whisper-tiny',
            modelPath: 'file:///document/whisper-models/ggml-tiny.bin',
            language: 'en',
            mode: 'transcribe_only',
            fieldStrategy: 'description_only',
            isFossBuild: true,
        });
    });

    it('keeps synced Parakeet disabled outside FOSS builds', () => {
        expect(
            resolveSpeechToTextRuntimeSettings(
                { enabled: true, provider: 'parakeet', model: 'parakeet-tdt-0.6b-v3-int8' },
                { isFossBuild: false }
            )
        ).toMatchObject({
            provider: 'whisper',
            enabled: false,
            model: 'whisper-tiny',
            isFossBuild: false,
        });
    });
});

describe('quick-capture speech readiness (moved from RN)', () => {
    it('treats a ready local Whisper model as quick-capture speech ready', () => {
        expect(isQuickCaptureSpeechReady({
            speechEnabled: true,
            provider: 'whisper',
            whisperModelReady: true,
        })).toBe(true);
        expect(isQuickCaptureSpeechReady({
            speechEnabled: true,
            provider: 'whisper',
            whisperModelReady: false,
        })).toBe(false);
        expect(isQuickCaptureSpeechReady({
            speechEnabled: true,
            provider: 'whisper',
            whisperModelReady: false,
            whisperModelPath: 'file:///document/whisper-models/ggml-tiny.en.bin',
        })).toBe(true);
        expect(isQuickCaptureSpeechReady({
            speechEnabled: true,
            provider: 'gemini',
            apiKey: '',
            whisperModelReady: true,
        })).toBe(false);
    });

    it('treats a custom OpenAI base URL as ready without a key, but not for gemini (#930)', () => {
        expect(isQuickCaptureSpeechReady({
            speechEnabled: true,
            provider: 'openai',
            apiKey: '',
            baseUrl: 'http://localhost:8000/v1',
            whisperModelReady: false,
        })).toBe(true);
        expect(isQuickCaptureSpeechReady({
            speechEnabled: true,
            provider: 'openai',
            apiKey: '',
            baseUrl: '',
            whisperModelReady: false,
        })).toBe(false);
        expect(isQuickCaptureSpeechReady({
            speechEnabled: true,
            provider: 'gemini',
            apiKey: '',
            baseUrl: 'http://localhost:8000/v1',
            whisperModelReady: false,
        })).toBe(false);
    });
});

const task = (overrides: Partial<Task> = {}): Task => ({
    id: 't1',
    title: 'Audio note 06/29/2026, 9:00 AM',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: '2026-06-29T09:00:00.000Z',
    updatedAt: '2026-06-29T09:00:00.000Z',
    ...overrides,
} as Task);

const fakeStore = (tasks: Task[], projects: Project[] = []) => {
    const state = {
        tasks,
        projects,
        settings: {} as AppSettings,
        addProject: vi.fn(async (title: string, color: string, props?: Partial<Project>) => {
            const project = { id: `p-${title}`, title, color, status: 'active', ...props } as Project;
            state.projects = [...state.projects, project];
            return project;
        }),
        updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
            state.tasks = state.tasks.map((item) => (item.id === id ? { ...item, ...updates } : item));
            return { success: true };
        }),
        deleteTask: vi.fn(async (_id: string) => ({ success: true })),
    };
    return { state, store: { getState: () => state } as unknown as QuickCaptureAudioStore };
};

describe('quick-capture audio rules', () => {
    it('records WAV only for Whisper with a ready model, m4a for every other capture (RN, decision Q1)', () => {
        expect(resolveQuickCaptureAudioFormat({ speechEnabled: true, provider: 'whisper', whisperModelReady: true })).toBe('wav');
        expect(resolveQuickCaptureAudioFormat({ speechEnabled: true, provider: 'whisper', whisperModelReady: false })).toBe('m4a');
        expect(resolveQuickCaptureAudioFormat({ speechEnabled: false, provider: 'whisper', whisperModelReady: true })).toBe('m4a');
        expect(resolveQuickCaptureAudioFormat({ speechEnabled: true, provider: 'gemini', whisperModelReady: true })).toBe('m4a');
        expect(resolveQuickCaptureAudioFormat({ speechEnabled: true, provider: 'openai', whisperModelReady: false })).toBe('m4a');
    });

    it('keeps the recording unless save audio is off and speech can transcribe it', () => {
        expect(shouldSaveQuickCaptureAudio({ gtd: {} } as AppSettings, true)).toBe(true);
        expect(shouldSaveQuickCaptureAudio({ gtd: { saveAudioAttachments: false } } as AppSettings, true)).toBe(false);
        expect(shouldSaveQuickCaptureAudio({ gtd: { saveAudioAttachments: false } } as AppSettings, false)).toBe(true);
        expect(shouldSaveQuickCaptureAudio(undefined, true)).toBe(true);
    });

    it('titles the task "Audio note" and the local time, and shapes the attachment as RN does', () => {
        const now = new Date('2026-06-29T09:00:27.000Z');
        const title = buildAudioNoteTitle('Audio note', now, (_value, pattern) => (pattern === 'Pp' ? '06/29/2026, 9:00 AM' : 'x'));
        expect(title).toBe('Audio note 06/29/2026, 9:00 AM');
        const withoutSize = buildQuickCaptureAudioAttachment({ title, uri: 'file:///a.m4a', mimeType: 'audio/mp4', now, newId: () => 'id-1' });
        expect(Object.keys(withoutSize)).toEqual(['id', 'kind', 'title', 'uri', 'mimeType', 'createdAt', 'updatedAt', 'localStatus']);
        expect(withoutSize).toEqual({
            id: 'id-1', kind: 'file', title, uri: 'file:///a.m4a', mimeType: 'audio/mp4',
            createdAt: '2026-06-29T09:00:27.000Z', updatedAt: '2026-06-29T09:00:27.000Z', localStatus: 'available',
        });
        // RN's Whisper path reads the size at once, so the key is there even when the size is unknown.
        const unknownSize = buildQuickCaptureAudioAttachment({ title, uri: 'file:///a.wav', mimeType: 'audio/wav', size: undefined, now, newId: () => 'id-2' });
        expect(Object.keys(unknownSize)).toEqual(['id', 'kind', 'title', 'uri', 'mimeType', 'size', 'createdAt', 'updatedAt', 'localStatus']);
        expect(buildQuickCaptureAudioAttachment({ title, uri: 'file:///a.wav', mimeType: 'audio/wav', size: 154668, now }).size).toBe(154668);
    });

    it('applies a transcript to the saved task and matches its suggested project by title', async () => {
        const home = { id: 'p-home', title: 'Home', color: '#fff', status: 'active' } as Project;
        const { state, store } = fakeStore([task()], [home]);
        await expect(applySpeechResult('t1', { transcript: 'Buy milk', title: 'Buy milk', projectTitle: 'Home' }, store)).resolves.toBe('applied');
        expect(state.addProject).not.toHaveBeenCalled();
        expect(state.updateTask).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Buy milk', projectId: 'p-home' }));
    });

    it('makes the suggested project when none matches, skips a task that is gone, and reports an empty result', async () => {
        const { state, store } = fakeStore([task()]);
        await expect(applySpeechResult('t1', { transcript: 'Paint', title: 'Paint', projectTitle: 'Garage' }, store)).resolves.toBe('applied');
        expect(state.addProject).toHaveBeenCalledWith('Garage', expect.any(String), undefined);
        expect(state.tasks[0]?.projectId).toBe('p-Garage');
        await expect(applySpeechResult('gone', { transcript: 'x', title: 'x' }, store)).resolves.toBe('skipped');
        const empty = fakeStore([task()]);
        await expect(applySpeechResult('t1', { transcript: '   ' }, empty.store)).resolves.toBe('empty');
        expect(empty.state.updateTask).not.toHaveBeenCalled();
    });

    it('discards an empty transcript\'s task, then each recording file once, even when the delete fails', async () => {
        const { state, store } = fakeStore([task()]);
        state.deleteTask.mockRejectedValueOnce(new Error('locked'));
        const deleted: string[] = [];
        const warned: string[] = [];
        await discardEmptySpeechTask('t1', [{ uri: 'file:///a.wav' }, null, { uri: '' }, { uri: 'file:///a.wav' }, { uri: 'file:///b.wav' }], 'whisper_empty_transcript', {
            store,
            deleteFile: (file, reason) => deleted.push(`${file.uri}:${reason}`),
            onWarn: (message) => warned.push(message),
        });
        expect(state.deleteTask).toHaveBeenCalledWith('t1');
        expect(warned).toEqual(['Failed to discard empty speech task']);
        expect(deleted).toEqual(['file:///a.wav:whisper_empty_transcript', 'file:///b.wav:whisper_empty_transcript']);
    });
});

// RN voice bug 3: two mime tables disagreed on .webm (the capture attachment said audio/mp4, the speech upload audio/webm).
describe('the audio mime table', () => {
    it('names each recording extension once, for the attachment and the upload alike', () => {
        expect(getAudioMimeType('.webm')).toBe('audio/webm');
        expect(getAudioMimeType('.WAV')).toBe('audio/wav');
        expect(getAudioMimeType('.m4a')).toBe('audio/mp4');
        expect(getAudioMimeType('.aac')).toBe('audio/aac');
        expect(getAudioMimeType('.mp3')).toBe('audio/mpeg');
        expect(getAudioMimeType('.caf')).toBe('audio/x-caf');
        expect(getAudioMimeType('.3gp')).toBe('audio/3gpp');
        expect(getAudioMimeType('.ogg')).toBe('audio/mp4');
    });
});

describe('speech provider dispatch', () => {
    const ports = () => ({
        readBytes: vi.fn(async () => ({ bytes: new Uint8Array([1]), mimeType: 'audio/mp4' })),
        withOpenAIUpload: vi.fn(),
        transcribeLocal: vi.fn(async () => 'Call the bank'),
        logWarn: vi.fn(),
    });

    it('refuses a cloud provider in a FOSS build and logs it, before reading the recording', async () => {
        const p = ports();
        await expect(dispatchSpeechCapture({ provider: 'gemini', apiKey: 'secret', model: 'gemini-2.5-flash' }, true, p))
            .rejects.toThrow(REMOTE_SPEECH_TO_TEXT_FOSS_ERROR);
        expect(p.logWarn).toHaveBeenCalledWith('Remote speech-to-text blocked in FOSS build', { scope: 'speech', force: true, extra: { provider: 'gemini' } });
        expect(p.readBytes).not.toHaveBeenCalled();
    });

    it('transcribes Whisper on the device', async () => {
        const p = ports();
        const result = await dispatchSpeechCapture({ provider: 'whisper', model: 'whisper-tiny', mode: 'transcribe_only' }, true, p);
        expect(p.transcribeLocal).toHaveBeenCalledTimes(1);
        expect(result.transcript).toBe('Call the bank');
        expect(p.logWarn).not.toHaveBeenCalled();
    });
});
