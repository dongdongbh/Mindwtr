import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fileSystemMock = vi.hoisted(() => ({
  bytes: vi.fn(),
  existingUris: null as Set<string> | null,
  directoryUris: null as Set<string> | null,
  fileUris: null as Set<string> | null,
  fileSizes: new Map<string, number>(),
  emulateDirectoryFileConstructorBug: false,
}));

function normalizeMockUri(uri: string) {
  return uri.replace(/\/+$/u, '');
}

function hasDirectoryUri(uri: string) {
  return Boolean(fileSystemMock.directoryUris?.has(normalizeMockUri(uri)));
}

function hasFileUri(uri: string) {
  return Boolean(fileSystemMock.fileUris?.has(normalizeMockUri(uri)));
}

const appLogMock = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const constantsMock = vi.hoisted(() => ({
  default: {
    appOwnership: 'standalone',
    expoConfig: {
      extra: {
        isFossBuild: false,
      },
    },
  },
}));

const whisperMock = vi.hoisted(() => ({
  initWhisper: vi.fn(),
}));

const rnfsMock = vi.hoisted(() => ({
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  readFile: vi.fn(),
  exists: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn(),
}));

const reactNativeMock = vi.hoisted(() => ({
  NativeModules: {
    RNFSManager: {} as Record<string, unknown> | null,
  },
  Platform: { OS: 'android' },
}));

vi.mock('react-native', () => reactNativeMock);

vi.mock('expo-constants', () => constantsMock);
vi.mock('react-native-fs', () => ({ ...rnfsMock, default: rnfsMock }));

vi.mock('expo-file-system', () => ({
  Directory: class MockDirectory {
    uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists() {
      if (fileSystemMock.directoryUris || fileSystemMock.fileUris) {
        return hasDirectoryUri(this.uri);
      }
      return fileSystemMock.existingUris ? fileSystemMock.existingUris.has(this.uri) : true;
    }

    create() {
      if (fileSystemMock.directoryUris || fileSystemMock.fileUris) {
        if (hasFileUri(this.uri)) {
          throw new Error('Unable to create file or directory: same name already exists');
        }
        fileSystemMock.directoryUris ??= new Set<string>();
        fileSystemMock.directoryUris.add(normalizeMockUri(this.uri));
        return;
      }
      if (fileSystemMock.existingUris) {
        fileSystemMock.existingUris.add(this.uri);
      }
    }

    list() {
      return [] as unknown[];
    }
  },
  File: class MockFile {
    uri: string;

    constructor(uri: string | { uri: string }, name?: string) {
      if (typeof uri === 'string') {
        this.uri = uri;
        return;
      }
      const base = uri.uri.endsWith('/') ? uri.uri : uri.uri + '/';
      this.uri = fileSystemMock.emulateDirectoryFileConstructorBug || !name
        ? uri.uri
        : base + name;
    }

    get name() {
      return this.uri.split('/').pop() ?? 'audio.wav';
    }

    get type() {
      return this.uri.endsWith('.wav') ? 'audio/wav' : 'audio/mp4';
    }

    get exists() {
      if (fileSystemMock.directoryUris || fileSystemMock.fileUris) {
        return hasFileUri(this.uri);
      }
      return fileSystemMock.existingUris ? fileSystemMock.existingUris.has(this.uri) : true;
    }

    get size() {
      return fileSystemMock.fileSizes.get(this.uri) ?? 44;
    }

    bytes() {
      return fileSystemMock.bytes(this.uri);
    }

    delete() {
      if (fileSystemMock.fileUris) {
        fileSystemMock.fileUris.delete(normalizeMockUri(this.uri));
      }
      if (fileSystemMock.existingUris) {
        fileSystemMock.existingUris.delete(this.uri);
      }
    }

    create() {
      if (fileSystemMock.directoryUris || fileSystemMock.fileUris) {
        fileSystemMock.fileUris ??= new Set<string>();
        fileSystemMock.fileUris.add(normalizeMockUri(this.uri));
      }
      if (fileSystemMock.existingUris) {
        fileSystemMock.existingUris.add(this.uri);
      }
    }
  },
  Paths: {
    cache: { uri: 'file:///cache/' },
    document: { uri: 'file:///document/' },
    info: vi.fn((uri: string) => ({
      exists: fileSystemMock.directoryUris || fileSystemMock.fileUris
        ? hasDirectoryUri(uri) || hasFileUri(uri)
        : (fileSystemMock.existingUris ? fileSystemMock.existingUris.has(uri) : true),
      isDirectory: fileSystemMock.directoryUris || fileSystemMock.fileUris
        ? hasDirectoryUri(uri)
        : false,
      size: fileSystemMock.fileSizes.get(uri) ?? fileSystemMock.fileSizes.get(normalizeMockUri(uri)),
    })),
  },
}));

vi.mock('./app-log', () => appLogMock);
vi.mock('whisper.rn/src/index', () => whisperMock);
vi.mock('whisper.rn/realtime-transcription/adapters/AudioPcmStreamAdapter.js', () => ({}));
vi.mock('whisper.rn/realtime-transcription/index.js', () => ({}));

import {
  ensureWhisperModelPathForConfigAsync,
  prepareAudioForLocalWhisper,
  resolveWhisperModelPathForConfigAsync,
  processAudioCapture,
  REMOTE_SPEECH_TO_TEXT_FOSS_ERROR,
  resolveSpeechToTextRuntimeSettings,
  startWhisperRealtimeCapture,
} from './speech-to-text';

const makePcmWav = ({
  sampleRate = 16000,
  channels = 1,
  bitsPerSample = 16,
  dataBytes = 6400,
} = {}) => {
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      bytes[offset + i] = value.charCodeAt(i);
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes;
};

const makeM4aHeader = () => new Uint8Array([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x4d, 0x34, 0x41, 0x20,
  0x00, 0x00, 0x00, 0x00,
]);

describe('speech-to-text', () => {
  beforeEach(() => {
    constantsMock.default.expoConfig.extra.isFossBuild = false;
    fileSystemMock.existingUris = null;
    fileSystemMock.directoryUris = null;
    fileSystemMock.fileUris = null;
    fileSystemMock.fileSizes.clear();
    fileSystemMock.emulateDirectoryFileConstructorBug = false;
    reactNativeMock.NativeModules.RNFSManager = {};
    vi.clearAllMocks();
  });

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

  it('blocks remote speech-to-text transport in FOSS builds', async () => {
    constantsMock.default.expoConfig.extra.isFossBuild = true;

    await expect(
      processAudioCapture('file:///tmp/audio.m4a', {
        provider: 'gemini',
        apiKey: 'secret',
        model: 'gemini-2.5-flash',
        isFossBuild: true,
      })
    ).rejects.toThrow(REMOTE_SPEECH_TO_TEXT_FOSS_ERROR);
    expect(appLogMock.logWarn).toHaveBeenCalledWith(
      'Remote speech-to-text blocked in FOSS build',
      expect.objectContaining({
        extra: { provider: 'gemini' },
      })
    );
  });

  it('finds a downloaded Whisper model when the stored root path is stale', async () => {
    fileSystemMock.existingUris = new Set([
      'file:///document/whisper-models/ggml-tiny.en.bin',
    ]);
    fileSystemMock.fileSizes.set('file:///document/whisper-models/ggml-tiny.en.bin', 77704715);

    await expect(resolveWhisperModelPathForConfigAsync(
      'whisper-tiny.en',
      'file:///document/ggml-tiny.en.bin'
    )).resolves.toMatchObject({
      uri: 'file:///document/whisper-models/ggml-tiny.en.bin',
      exists: true,
      size: 77704715,
    });
  });

  it('resolves an RNFS-written Whisper model when Expo metadata reports it missing', async () => {
    const uri = 'file:///document/whisper-models/ggml-tiny.en.bin';
    fileSystemMock.existingUris = new Set([
      'file:///document/',
      'file:///document/whisper-models',
    ]);
    rnfsMock.stat.mockResolvedValueOnce({
      path: '/document/whisper-models/ggml-tiny.en.bin',
      size: 77704715,
      isFile: () => true,
      isDirectory: () => false,
    });

    await expect(resolveWhisperModelPathForConfigAsync('whisper-tiny.en', uri)).resolves.toMatchObject({
      uri,
      path: '/document/whisper-models/ggml-tiny.en.bin',
      exists: true,
      size: 77704715,
    });
  });

  it('does not evaluate react-native-fs when the native RNFS module is missing', async () => {
    let rnfsLoadAttempts = 0;
    vi.resetModules();
    reactNativeMock.NativeModules.RNFSManager = null;
    vi.doMock('react-native-fs', () => {
      rnfsLoadAttempts += 1;
      throw new TypeError("Cannot read property 'RNFSFileTypeRegular' of null");
    });

    try {
      const freshSpeech = await import('./speech-to-text');
      fileSystemMock.existingUris = new Set([
        'file:///document/',
        'file:///cache/',
      ]);

      await expect(
        freshSpeech.resolveWhisperModelPathForConfigAsync(
          'whisper-tiny.en',
          'file:///document/whisper-models/ggml-tiny.en.bin'
        )
      ).resolves.toMatchObject({
        uri: 'file:///document/whisper-models/ggml-tiny.en.bin',
        exists: false,
      });
      expect(rnfsLoadAttempts).toBe(0);
    } finally {
      reactNativeMock.NativeModules.RNFSManager = {};
      vi.doMock('react-native-fs', () => ({ ...rnfsMock, default: rnfsMock }));
      vi.resetModules();
    }
  });

  it('does not retry RNFS import after native module evaluation fails', async () => {
    let rnfsLoadAttempts = 0;
    vi.resetModules();
    reactNativeMock.NativeModules.RNFSManager = {};
    vi.doMock('react-native-fs', () => {
      rnfsLoadAttempts += 1;
      throw new TypeError("Cannot read property 'RNFSFileTypeRegular' of null");
    });

    try {
      const freshSpeech = await import('./speech-to-text');
      fileSystemMock.existingUris = new Set([
        'file:///document/',
        'file:///cache/',
      ]);

      await expect(
        freshSpeech.resolveWhisperModelPathForConfigAsync(
          'whisper-tiny.en',
          'file:///document/whisper-models/ggml-tiny.en.bin'
        )
      ).resolves.toMatchObject({
        uri: 'file:///document/whisper-models/ggml-tiny.en.bin',
        exists: false,
      });
      expect(rnfsLoadAttempts).toBe(1);
    } finally {
      reactNativeMock.NativeModules.RNFSManager = {};
      vi.doMock('react-native-fs', () => ({ ...rnfsMock, default: rnfsMock }));
      vi.resetModules();
    }
  });

  it('resolves a missing Whisper model to the current container whisper-models path', async () => {
    fileSystemMock.existingUris = new Set([
      'file:///document/',
      'file:///cache/',
    ]);

    await expect(ensureWhisperModelPathForConfigAsync('whisper-tiny.en')).resolves.toMatchObject({
      uri: 'file:///document/whisper-models/ggml-tiny.en.bin',
      path: '/document/whisper-models/ggml-tiny.en.bin',
      exists: false,
      size: 0,
    });
  });

  it('repairs a file blocking the Whisper model directory before resolving the model path', async () => {
    fileSystemMock.directoryUris = new Set([
      'file:///document',
      'file:///cache',
    ]);
    fileSystemMock.fileUris = new Set([
      'file:///document/whisper-models',
    ]);

    await expect(ensureWhisperModelPathForConfigAsync('whisper-tiny.en')).resolves.toMatchObject({
      uri: 'file:///document/whisper-models/ggml-tiny.en.bin',
      path: '/document/whisper-models/ggml-tiny.en.bin',
      exists: false,
      size: 0,
    });
    expect(fileSystemMock.fileUris.has('file:///document/whisper-models')).toBe(false);
    expect(fileSystemMock.directoryUris.has('file:///document/whisper-models')).toBe(true);
  });

  it('does not create a file over the Whisper model directory while resolving the model path', async () => {
    fileSystemMock.emulateDirectoryFileConstructorBug = true;
    fileSystemMock.directoryUris = new Set([
      'file:///document',
      'file:///cache',
      'file:///document/whisper-models',
    ]);
    fileSystemMock.fileUris = new Set([
      'file:///document/whisper-models/ggml-tiny.en.bin',
    ]);
    fileSystemMock.fileSizes.set('file:///document/whisper-models/ggml-tiny.en.bin', 77704715);

    await expect(ensureWhisperModelPathForConfigAsync('whisper-tiny.en')).resolves.toMatchObject({
      uri: 'file:///document/whisper-models/ggml-tiny.en.bin',
      path: '/document/whisper-models/ggml-tiny.en.bin',
      exists: true,
      size: 77704715,
    });
    expect(fileSystemMock.fileUris.has('file:///document/whisper-models')).toBe(false);
    expect(fileSystemMock.directoryUris.has('file:///document/whisper-models')).toBe(true);
  });

  it('logs Whisper model search directories and candidates when the model is missing', async () => {
    fileSystemMock.existingUris = new Set([
      'file:///document/',
      'file:///cache/',
    ]);

    await expect(ensureWhisperModelPathForConfigAsync(
      'whisper-tiny.en',
      'file:///document/ggml-tiny.en.bin'
    )).resolves.toMatchObject({
      uri: 'file:///document/whisper-models/ggml-tiny.en.bin',
      exists: false,
      size: 0,
    });

    expect(appLogMock.logWarn).toHaveBeenCalledWith(
      'Whisper model missing',
      expect.objectContaining({
        extra: expect.objectContaining({
          whisperDirUri: 'file:///document/whisper-models',
          cacheWhisperDirUri: 'file:///cache/whisper-models',
          candidateUris: expect.stringContaining('file:///document/whisper-models/ggml-tiny.en.bin'),
        }),
      })
    );
  });

  it('fails cleanly when Android Whisper realtime helper modules are unavailable', async () => {
    await expect(
      startWhisperRealtimeCapture('/tmp/mindwtr-audio.wav', {
        provider: 'whisper',
        model: 'whisper-tiny',
        modelPath: '/tmp/ggml-tiny.en.bin',
      })
    ).rejects.toThrow('Whisper realtime transcription requires native audio stream modules.');
  });

  it('accepts 16 kHz mono PCM WAV input for local Whisper', async () => {
    fileSystemMock.bytes.mockResolvedValueOnce(makePcmWav());

    await expect(
      prepareAudioForLocalWhisper({
        uri: 'file:///tmp/audio.wav',
        platform: 'android',
        source: 'pcm-recorder',
        extension: '.wav',
      })
    ).resolves.toMatchObject({
      uri: 'file:///tmp/audio.wav',
      format: 'wav-pcm',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      bytes: 6444,
      durationMs: 200,
    });
    expect(appLogMock.logInfo).toHaveBeenCalledWith(
      'ASR_INPUT_ACCEPTED_LOCAL_WHISPER',
      expect.objectContaining({
        extra: expect.objectContaining({
          local_whisper_called: 'false',
          sniffed_format: 'wav',
        }),
      })
    );
  });

  it('rejects compressed audio before local Whisper can run', async () => {
    fileSystemMock.bytes.mockResolvedValueOnce(makeM4aHeader());

    await expect(
      prepareAudioForLocalWhisper({
        uri: 'file:///tmp/audio.m4a',
        platform: 'android',
        source: 'expo-recorder',
        extension: '.m4a',
      })
    ).resolves.toBeNull();
    expect(appLogMock.logWarn).toHaveBeenCalledWith(
      'ASR_INPUT_REJECTED_UNSUPPORTED_FORMAT',
      expect.objectContaining({
        extra: expect.objectContaining({
          extension: '.m4a',
          local_whisper_called: 'false',
          reject_reason: 'too_short',
        }),
      })
    );
  });

  it('does not initialize local Whisper for m4a input', async () => {
    fileSystemMock.bytes.mockResolvedValueOnce(makeM4aHeader());

    await expect(
      processAudioCapture('file:///tmp/audio.m4a', {
        provider: 'whisper',
        model: 'whisper-tiny',
        modelPath: '/tmp/ggml-tiny.en.bin',
      })
    ).rejects.toThrow('Local Whisper can only transcribe 16 kHz mono PCM WAV audio.');
    expect(whisperMock.initWhisper).not.toHaveBeenCalled();
  });
});

// #930: point OpenAI-shaped speech-to-text at a self-hosted server.
describe('processAudioCapture openai transcription against a custom base URL', () => {
  beforeEach(() => {
    constantsMock.default.expoConfig.extra.isFossBuild = false;
    fileSystemMock.bytes.mockReset();
    fileSystemMock.bytes.mockResolvedValue(makePcmWav());
  });

  const stubFetch = () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(
      JSON.stringify({ text: 'hello from whisperx' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives the transcribe endpoint from a base URL, stripping a trailing slash', async () => {
    const fetchMock = stubFetch();

    const result = await processAudioCapture('file:///tmp/audio.wav', {
      provider: 'openai',
      model: 'large-v3',
      baseUrl: 'http://localhost:8000/v1/',
      mode: 'transcribe_only',
    });

    expect(result).toEqual({ transcript: 'hello from whisperx' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/v1/audio/transcriptions',
      expect.anything()
    );
  });

  it('uses the official OpenAI URL when no base URL is configured', async () => {
    const fetchMock = stubFetch();

    await processAudioCapture('file:///tmp/audio.wav', {
      provider: 'openai',
      model: 'gpt-4o-transcribe',
      apiKey: 'secret-key',
      mode: 'transcribe_only',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.anything()
    );
  });

  it('sends no Authorization header when there is no key', async () => {
    const fetchMock = stubFetch();

    await processAudioCapture('file:///tmp/audio.wav', {
      provider: 'openai',
      model: 'large-v3',
      baseUrl: 'http://localhost:8000/v1',
      mode: 'transcribe_only',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('sends an Authorization header when a key is present', async () => {
    const fetchMock = stubFetch();

    await processAudioCapture('file:///tmp/audio.wav', {
      provider: 'openai',
      model: 'gpt-4o-transcribe',
      apiKey: 'secret-key',
      mode: 'transcribe_only',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer secret-key');
  });

  // gpt-transcribe-generation models take a `languages` array; earlier
  // models keep the singular `language` field (#984).
  it('sends languages[] for gpt-transcribe and language for earlier models', async () => {
    const fetchMock = stubFetch();

    await processAudioCapture('file:///tmp/audio.wav', {
      provider: 'openai',
      model: 'gpt-transcribe',
      apiKey: 'secret-key',
      language: 'en',
      mode: 'transcribe_only',
    });
    await processAudioCapture('file:///tmp/audio.wav', {
      provider: 'openai',
      model: 'whisper-1',
      apiKey: 'secret-key',
      language: 'en',
      mode: 'transcribe_only',
    });

    const newModelForm = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(newModelForm.get('languages[]')).toBe('en');
    expect(newModelForm.get('language')).toBeNull();

    const legacyModelForm = (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as FormData;
    expect(legacyModelForm.get('language')).toBe('en');
    expect(legacyModelForm.get('languages[]')).toBeNull();
  });
});
