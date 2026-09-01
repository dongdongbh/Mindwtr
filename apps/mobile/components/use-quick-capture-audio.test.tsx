import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureSessionCoordinator, type CaptureSessionId } from '@mindwtr/core';

const storeMocks = vi.hoisted(() => {
  const updateTask = vi.fn();
  const deleteTask = vi.fn();
  const addProject = vi.fn();
  const state = {
    addProject,
    areas: [],
    projects: [],
    settings: {},
    tasks: [] as { id: string; title: string; [key: string]: unknown }[],
    updateTask,
    deleteTask,
  };
  const useTaskStore = vi.fn((selector?: (value: typeof state) => unknown) => (
    selector ? selector(state) : state
  )) as unknown as {
    (selector?: (value: typeof state) => unknown): unknown;
    getState: () => typeof state;
  };
  useTaskStore.getState = () => state;
  return {
    addProject,
    deleteTask,
    state,
    updateTask,
    useTaskStore,
  };
});

const speechMocks = vi.hoisted(() => ({
  ensureWhisperModelPathForConfigAsync: vi.fn(),
  prepareAudioForLocalWhisper: vi.fn(),
  preloadWhisperContext: vi.fn(),
  processAudioCapture: vi.fn(),
  startWhisperRealtimeCapture: vi.fn(),
  transcribeLocalWhisper: vi.fn(),
}));

const audioMocks = vi.hoisted(() => ({
  audioRecorder: {
    prepareToRecordAsync: vi.fn(),
    record: vi.fn(),
    stop: vi.fn(),
    uri: 'file:///recording.m4a',
  },
  requestRecordingPermissionsAsync: vi.fn(),
  setAudioModeAsync: vi.fn(),
}));

const attachmentMocks = vi.hoisted(() => ({
  getAttachmentsDir: vi.fn(),
  persistAttachmentLocally: vi.fn(),
}));

const appLogMock = vi.hoisted(() => ({
  logInfo: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
}));

vi.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: audioMocks.requestRecordingPermissionsAsync,
  setAudioModeAsync: audioMocks.setAudioModeAsync,
  useAudioRecorder: () => audioMocks.audioRecorder,
}));

vi.mock('expo-file-system', () => ({
  Directory: class MockDirectory {
    uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists() {
      return true;
    }

    create() {
      return undefined;
    }
  },
  File: class MockFile {
    uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    info() {
      return {
        exists: true,
        isDirectory: false,
        size: this.uri.endsWith('.wav') ? 154668 : 77704715,
      };
    }

    delete() {
      return undefined;
    }
  },
  Paths: {
    cache: { uri: 'file:///cache/' },
    document: { uri: 'file:///document/' },
    info: vi.fn(() => ({ exists: true, isDirectory: false, size: 154668 })),
  },
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../test-support/mock-core');
  // Only the id and clock are pinned, so attachment names stay deterministic;
  // `buildTaskUpdatesFromSpeechResult` runs for real.
  return mockCore(importOriginal, () => ({}), {
    generateUUID: () => 'attachment-1',
    safeFormatDate: (_value: Date | string, format: string) => {
      if (format === 'yyyyMMdd-HHmmss') return '20260629-090027';
      if (format === 'Pp') return '06/29/2026, 9:00 AM';
      return '2026-06-29';
    },
    useTaskStore: storeMocks.useTaskStore,
  });
});

vi.mock('../lib/ai-config', () => ({
  loadAIKey: vi.fn().mockResolvedValue(''),
}));

vi.mock('../lib/app-log', () => appLogMock);

vi.mock('../lib/attachment-sync', () => ({
  persistAttachmentLocally: attachmentMocks.persistAttachmentLocally,
}));

vi.mock('../lib/attachment-sync-utils', () => ({
  getAttachmentsDir: attachmentMocks.getAttachmentsDir,
}));

vi.mock('../contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => toastMock,
}));

vi.mock('../lib/speech-to-text', () => ({
  ensureWhisperModelPathForConfigAsync: speechMocks.ensureWhisperModelPathForConfigAsync,
  prepareAudioForLocalWhisper: speechMocks.prepareAudioForLocalWhisper,
  preloadWhisperContext: speechMocks.preloadWhisperContext,
  processAudioCapture: speechMocks.processAudioCapture,
  resolveSpeechToTextRuntimeSettings: (speech: Record<string, unknown> | undefined) => ({
    enabled: speech?.enabled === true,
    fieldStrategy: 'smart',
    isFossBuild: false,
    language: 'en',
    mode: 'smart_parse',
    model: String(speech?.model ?? 'whisper-tiny.en'),
    modelPath: String(speech?.offlineModelPath ?? ''),
    provider: speech?.provider ?? 'whisper',
  }),
  startWhisperRealtimeCapture: speechMocks.startWhisperRealtimeCapture,
  transcribeLocalWhisper: speechMocks.transcribeLocalWhisper,
}));

// eslint-disable-next-line import/first
import { useQuickCaptureAudio } from './use-quick-capture-audio';

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('useQuickCaptureAudio', () => {
  let latest: ReturnType<typeof useQuickCaptureAudio> | null = null;
  const addTask = vi.fn();
  const buildTaskProps = vi.fn();
  const handleClose = vi.fn();
  const onError = vi.fn();
  const onWarn = vi.fn();
  const updateSpeechSettings = vi.fn();
  const onSubmissionBusyChange = vi.fn();
  let submissionCoordinator = new CaptureSessionCoordinator();
  let activeSubmissionSession: CaptureSessionId | null = null;

  const settings = {
    ai: {
      speechToText: {
        enabled: true,
        provider: 'whisper',
        model: 'whisper-tiny.en',
        offlineModelPath: 'file:///document/whisper-models/ggml-tiny.en.bin',
        language: 'en',
      },
    },
    gtd: {
      saveAudioAttachments: true,
    },
  } as const;

  function Harness({ submissionKey = 1 }: { submissionKey?: number }) {
    latest = useQuickCaptureAudio({
      addTask,
      buildTaskProps,
      getActiveSubmissionSession: () => activeSubmissionSession,
      handleClose,
      onError,
      onWarn,
      settings,
      submissionCoordinator,
      submissionKey,
      t: (key: string) => key,
      onSubmissionBusyChange,
      updateSpeechSettings,
      visible: true,
    });
    return null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    latest = null;
    submissionCoordinator = new CaptureSessionCoordinator();
    activeSubmissionSession = submissionCoordinator.beginSession();
    storeMocks.state.areas = [];
    storeMocks.state.projects = [];
    storeMocks.state.settings = settings;
    storeMocks.state.tasks = [];
    audioMocks.requestRecordingPermissionsAsync.mockResolvedValue({ granted: true });
    audioMocks.setAudioModeAsync.mockResolvedValue(undefined);
    attachmentMocks.getAttachmentsDir.mockResolvedValue('file:///document/attachments/');
    attachmentMocks.persistAttachmentLocally.mockImplementation(async (attachment: { uri: string }) => ({
      ...attachment,
      uri: 'file:///document/attachments/attachment-1.wav',
    }));
    buildTaskProps.mockImplementation(async (fallbackTitle: string, extraProps?: Record<string, unknown>) => ({
      title: fallbackTitle,
      props: extraProps ?? {},
      invalidDateCommands: [],
    }));
    addTask.mockImplementation(async (title: string, props?: Record<string, unknown>) => {
      storeMocks.state.tasks.push({ id: 'task-1', title, ...(props ?? {}) });
      return { success: true, id: 'task-1' };
    });
    storeMocks.updateTask.mockResolvedValue(undefined);
    speechMocks.ensureWhisperModelPathForConfigAsync.mockResolvedValue({
      exists: true,
      path: '/document/whisper-models/ggml-tiny.en.bin',
      uri: 'file:///document/whisper-models/ggml-tiny.en.bin',
      size: 77704715,
    });
    speechMocks.prepareAudioForLocalWhisper.mockResolvedValue({
      uri: 'file:///document/audio-captures/mindwtr-audio-20260629-090027.wav',
      format: 'wav-pcm',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      bytes: 154668,
      durationMs: 4832,
    });
    speechMocks.startWhisperRealtimeCapture.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(undefined),
      result: Promise.resolve({ transcript: 'Buy milk' }),
      hasRealtimeTranscript: true,
    });
    speechMocks.transcribeLocalWhisper.mockRejectedValue(new Error('duplicate native transcription'));
  });

  it('uses a successful iOS realtime Whisper result without starting duplicate file transcription', async () => {
    await act(async () => {
      create(<Harness />);
      await flushPromises();
    });

    await act(async () => {
      await latest?.startRecording();
      await flushPromises();
    });

    await act(async () => {
      await latest?.stopRecording({ saveTask: true });
      await flushPromises();
    });

    expect(speechMocks.transcribeLocalWhisper).not.toHaveBeenCalled();
    // Core's default 'smart' field strategy puts a short transcript (<=15 words)
    // in the title. The stub this suite used to carry always wrote `description`,
    // so this line asserted behaviour the app does not have.
    expect(storeMocks.updateTask).toHaveBeenCalledWith('task-1', { title: 'Buy milk' });
    expect(handleClose).toHaveBeenCalledOnce();
  });

  it('shows a notice and never starts the recorder when speech-to-text is unconfigured', async () => {
    // Reporter scenario (#886): STT was never enabled/configured. The voice button must
    // surface a translated notice pointing at Settings and keep the sheet open, instead of
    // showing a recording indicator and then silently aborting.
    const unconfiguredSettings = {
      ai: {
        speechToText: {
          enabled: false,
          provider: 'whisper',
          model: 'whisper-tiny.en',
          offlineModelPath: '',
        },
      },
      gtd: { saveAudioAttachments: true },
    } as const;
    storeMocks.state.settings = unconfiguredSettings;

    function UnconfiguredHarness() {
      latest = useQuickCaptureAudio({
        addTask,
        buildTaskProps,
        getActiveSubmissionSession: () => activeSubmissionSession,
        handleClose,
        onError,
        onWarn,
        settings: unconfiguredSettings,
        submissionCoordinator,
        submissionKey: 1,
        t: (key: string) => key,
        onSubmissionBusyChange,
        updateSpeechSettings,
        visible: true,
      });
      return null;
    }

    await act(async () => {
      create(<UnconfiguredHarness />);
      await flushPromises();
    });

    await act(async () => {
      await latest?.startRecording();
      await flushPromises();
    });

    expect(toastMock.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'quickAdd.speechNotConfigured' })
    );
    expect(audioMocks.requestRecordingPermissionsAsync).not.toHaveBeenCalled();
    expect(audioMocks.audioRecorder.prepareToRecordAsync).not.toHaveBeenCalled();
    expect(latest?.recording).toBeNull();
    expect(handleClose).not.toHaveBeenCalled();
  });

  it('does not create or close from stale audio A after capture B opens', async () => {
    const preparedTask = deferred<{
      title: string;
      props: Record<string, unknown>;
      invalidDateCommands: string[];
    }>();
    buildTaskProps.mockReturnValueOnce(preparedTask.promise);
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Harness submissionKey={1} />);
      await flushPromises();
    });
    await act(async () => {
      await latest?.startRecording();
      await flushPromises();
    });

    let stopRun!: Promise<void>;
    await act(async () => {
      stopRun = latest!.stopRecording({ saveTask: true });
      await flushPromises();
    });
    expect(buildTaskProps).toHaveBeenCalled();
    const audioSession = activeSubmissionSession!;
    submissionCoordinator.invalidateSession(audioSession);
    activeSubmissionSession = submissionCoordinator.beginSession();
    const reopenedSession = activeSubmissionSession;
    expect(submissionCoordinator.tryBeginSubmission(reopenedSession)).toBe(true);
    await act(async () => {
      tree.update(<Harness submissionKey={2} />);
      preparedTask.resolve({ title: 'Stale audio A', props: {}, invalidDateCommands: [] });
      await stopRun;
      await flushPromises();
    });

    expect(addTask).not.toHaveBeenCalled();
    expect(handleClose).not.toHaveBeenCalled();
    expect(submissionCoordinator.isSubmitting(reopenedSession)).toBe(true);
    expect(latest?.recordingBusy).toBe(false);
  });
});
