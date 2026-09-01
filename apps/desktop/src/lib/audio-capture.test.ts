import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));
const fsMocks = vi.hoisted(() => ({
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    remove: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({ join: async (...parts: string[]) => parts.join('/') }));
vi.mock('@tauri-apps/plugin-fs', () => fsMocks);
vi.mock('./managed-paths', () => ({ getManagedPath: async (dir: string) => `/data/${dir}` }));
vi.mock('./app-log', () => ({ logWarn: vi.fn(async () => undefined) }));

import { AudioCaptureError, startAudioCapture } from './audio-capture';

const enableTauri = () => {
    (window as any).__TAURI_INTERNALS__ = {};
};

/** Minimal ScriptProcessor graph good enough to drive one capture cycle. */
const installFakeWebAudio = () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    (navigator as any).mediaDevices = {
        getUserMedia: vi.fn(async () => stream),
        enumerateDevices: vi.fn(async () => [{ kind: 'audioinput' }]),
    };

    const processor: any = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
    const context: any = {
        state: 'running',
        sampleRate: 48_000,
        resume: vi.fn(async () => undefined),
        suspend: vi.fn(async () => { context.state = 'suspended'; }),
        close: vi.fn(async () => { context.state = 'closed'; }),
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        createScriptProcessor: vi.fn(() => processor),
        createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() })),
        destination: {},
    };
    (window as any).AudioContext = vi.fn(() => context);
    return { context, processor, track };
};

const pushSamples = (processor: any, samples: Float32Array) => {
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
};

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.useRealTimers();
    delete (window as any).__TAURI_INTERNALS__;
    delete (navigator as any).mediaDevices;
    delete (window as any).AudioContext;
});

describe('startAudioCapture — native backend', () => {
    it('stops into a canonical capture result', async () => {
        enableTauri();
        tauriMocks.invoke.mockImplementation(async (command: string) => (
            command === 'stop_audio_recording'
                ? { path: '/tmp/captures/note.wav', sampleRate: 16_000, channels: 1, size: 42 }
                : undefined
        ));

        const session = await startAudioCapture();
        expect(session.backend).toBe('native');
        expect(tauriMocks.invoke).toHaveBeenCalledWith('start_audio_recording');

        const capture = await session.stop();
        expect(capture).toMatchObject({ path: '/tmp/captures/note.wav', name: 'note.wav', mimeType: 'audio/wav', size: 42 });
        await expect(capture.bytes()).resolves.toEqual(new Uint8Array([1, 2, 3]));
    });

    it('reads the captured file only once however many consumers ask for the bytes', async () => {
        enableTauri();
        tauriMocks.invoke.mockImplementation(async (command: string) => (
            command === 'stop_audio_recording'
                ? { path: '/tmp/captures/note.wav', sampleRate: 16_000, channels: 1, size: 42 }
                : undefined
        ));

        const capture = await (await startAudioCapture()).stop();
        await capture.bytes();
        await capture.bytes();
        expect(fsMocks.readFile).toHaveBeenCalledTimes(1);
    });

    it('deletes the recording it wrote when the capture is cancelled', async () => {
        enableTauri();
        tauriMocks.invoke.mockImplementation(async (command: string) => (
            command === 'stop_audio_recording'
                ? { path: '/tmp/captures/note.wav', sampleRate: 16_000, channels: 1, size: 42 }
                : undefined
        ));

        await (await startAudioCapture()).cancel();
        expect(fsMocks.remove).toHaveBeenCalledWith('/tmp/captures/note.wav');
    });
});

describe('startAudioCapture — fallback', () => {
    it('uses distinct default paths for captures stopped in the same second', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
        const firstGraph = installFakeWebAudio();
        const firstSession = await startAudioCapture();
        pushSamples(firstGraph.processor, new Float32Array([0.1]));
        const firstCapture = await firstSession.stop();

        const secondGraph = installFakeWebAudio();
        const secondSession = await startAudioCapture();
        pushSamples(secondGraph.processor, new Float32Array([0.1]));
        const secondCapture = await secondSession.stop();

        expect(firstCapture.path).not.toBe(secondCapture.path);
        expect(firstCapture.name).not.toBe(secondCapture.name);
    });

    it('falls back to web capture when the native recorder refuses to start', async () => {
        // This is the defect the shared module fixes: the task editor used to
        // hard-fail here instead of recording through the page.
        enableTauri();
        const { processor } = installFakeWebAudio();
        tauriMocks.invoke.mockRejectedValue(new Error('no audio device'));

        const session = await startAudioCapture({ defaultName: () => 'note.wav' });
        expect(session.backend).toBe('web');

        pushSamples(processor, new Float32Array([0.1, -0.1, 0.2, -0.2]));
        const capture = await session.stop();
        expect(capture).toMatchObject({ path: '/data/audio-captures/note.wav', name: 'note.wav', mimeType: 'audio/wav' });
        expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
    });

    it('uses the web recorder outside Tauri', async () => {
        const { processor } = installFakeWebAudio();
        const session = await startAudioCapture({ defaultName: () => 'note.wav' });
        expect(session.backend).toBe('web');
        expect(tauriMocks.invoke).not.toHaveBeenCalled();
        pushSamples(processor, new Float32Array([0.1]));
        await expect(session.stop()).resolves.toMatchObject({ name: 'note.wav' });
    });

    it('reports an unsupported runtime rather than a file-type error', async () => {
        await expect(startAudioCapture()).rejects.toBeInstanceOf(AudioCaptureError);
        await expect(startAudioCapture()).rejects.toMatchObject({ reason: 'unsupported' });
    });

    it('reports a missing microphone distinctly', async () => {
        installFakeWebAudio();
        (navigator as any).mediaDevices.enumerateDevices = vi.fn(async () => [{ kind: 'videoinput' }]);
        await expect(startAudioCapture()).rejects.toMatchObject({ reason: 'no-microphone' });
    });

    it('tears the audio graph down without writing a file when cancelled', async () => {
        const { context, track } = installFakeWebAudio();
        const session = await startAudioCapture({ defaultName: () => 'note.wav' });
        await session.cancel();
        expect(context.close).toHaveBeenCalled();
        expect(track.stop).toHaveBeenCalled();
        expect(fsMocks.writeFile).not.toHaveBeenCalled();
    });

    it('rejects a stop with no captured audio', async () => {
        installFakeWebAudio();
        const session = await startAudioCapture({ defaultName: () => 'note.wav' });
        await expect(session.stop()).rejects.toThrow('No audio data captured');
    });
});
