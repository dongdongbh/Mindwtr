import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioRecorder as ExpoAudioRecorder,
} from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import {
  DEFAULT_PROJECT_COLOR,
  buildTaskUpdatesFromSpeechResult,
  generateUUID,
  findSelectableProjectByTitleAndArea,
  safeFormatDate,
  type AppSettings,
  type Attachment,
  type CaptureSessionCoordinator,
  type CaptureSessionId,
  type SpeechToTextSettings,
  type Task,
  useTaskStore,
} from '@mindwtr/core';
import { loadAIKey } from '../lib/ai-config';
import { persistAttachmentLocally } from '../lib/attachment-sync';
import { getAttachmentsDir } from '../lib/attachment-sync-utils';
import { showInvalidDateCommandToast } from '../lib/quick-add-toast';
import { useToast } from '../contexts/toast-context';
import {
  ensureWhisperModelPathForConfigAsync,
  prepareAudioForLocalWhisper,
  preloadWhisperContext,
  processAudioCapture,
  resolveSpeechToTextRuntimeSettings,
  startWhisperRealtimeCapture,
  transcribeLocalWhisper,
  type LocalWhisperAudio,
  type SpeechToTextConfig,
  type SpeechToTextResult,
} from '../lib/speech-to-text';
import {
  buildCaptureDirectoryUri,
  buildCaptureFileUri,
  getCaptureFileExtension,
  getCaptureMimeType,
  isQuickCaptureSpeechReady,
  selectExistingCaptureFile,
  selectQuickCaptureSettings,
} from './quick-capture-sheet.utils';

type SpeechSettings = SpeechToTextSettings;
type BuildTaskPropsResult = {
  title: string;
  props: Partial<Task>;
  invalidDateCommands?: string[];
};
type SpeechApplyResult = 'applied' | 'empty' | 'skipped';

export type RecordingState =
  | { kind: 'expo'; recorder: ExpoAudioRecorder }
  | {
      kind: 'whisper';
      stop: () => Promise<void>;
      result: Promise<SpeechToTextResult>;
      file: File;
      allowRealtimeFallback: boolean;
    };

type UseQuickCaptureAudioParams = {
  addTask: (title: string, props?: Partial<Task>) => Promise<{ success: boolean; id?: string }>;
  autoRecord?: boolean;
  buildTaskProps: (fallbackTitle: string, extraProps?: Partial<Task>) => Promise<BuildTaskPropsResult>;
  getActiveSubmissionSession: () => CaptureSessionId | null;
  handleClose: () => void;
  initialAttachments?: Attachment[];
  onError: (message: string, error?: unknown) => void;
  onSubmissionBusyChange: (busy: boolean) => void;
  onWarn: (message: string, error?: unknown) => void;
  settings: AppSettings;
  submissionCoordinator: CaptureSessionCoordinator;
  submissionKey?: string | number;
  t: (key: string) => string;
  updateSpeechSettings: (next: Partial<SpeechSettings>) => void;
  visible: boolean;
};

const getWhisperCapturePlatform = (): 'ios' | 'android' => (Platform.OS === 'ios' ? 'ios' : 'android');

let recordingDeviceQueue: Promise<void> = Promise.resolve();

const queueRecordingDeviceOperation = <T,>(operation: () => Promise<T>): Promise<T> => {
  const result = recordingDeviceQueue.catch(() => undefined).then(operation);
  recordingDeviceQueue = result.then(() => undefined, () => undefined);
  return result;
};

const createExpoAudioRecorder = (): ExpoAudioRecorder => {
  const preset = RecordingPresets.HIGH_QUALITY;
  const platformOptions = Platform.OS === 'ios'
    ? preset.ios
    : Platform.OS === 'android'
      ? preset.android
      : preset.web;
  // Expo exports the native constructor through AudioModule at runtime, while
  // eslint-plugin-import cannot follow the generated native-module shape.
  // eslint-disable-next-line import/namespace
  return new AudioModule.AudioRecorder({
    extension: preset.extension,
    sampleRate: preset.sampleRate,
    numberOfChannels: preset.numberOfChannels,
    bitRate: preset.bitRate,
    isMeteringEnabled: false,
    ...platformOptions,
  });
};

const stopAndReleaseExpoRecorder = async (recorder: ExpoAudioRecorder) => {
  let error: unknown;
  try {
    await recorder.stop();
  } catch (stopError) {
    error = stopError;
  }
  const uri = recorder.uri;
  recorder.release();
  return { error, uri };
};

const releaseRecordingOnTeardown = async (recording: RecordingState) => {
  if (recording.kind === 'expo') {
    const stopped = await stopAndReleaseExpoRecorder(recording.recorder);
    return stopped.uri ? new File(stopped.uri) : null;
  }
  try {
    await recording.stop();
  } catch {
    // Teardown is best-effort; the session is already invalid and cannot own UI errors.
  }
  void recording.result.catch(() => undefined);
  return recording.file;
};

const runWhisperLocalTranscription = async (input: LocalWhisperAudio, config: SpeechToTextConfig): Promise<SpeechToTextResult> => ({
  transcript: await transcribeLocalWhisper(input, config),
});

const describeAttachmentCacheInfo = (uri: string): Record<string, string> => {
  try {
    const info = new File(uri).info() as { exists?: boolean; isDirectory?: boolean; size?: number };
    return {
      uri,
      exists: String(Boolean(info?.exists)),
      isDirectory: String(Boolean(info?.isDirectory)),
      size: typeof info?.size === 'number' ? String(info.size) : 'unknown',
    };
  } catch (error) {
    return {
      uri,
      exists: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const cacheAudioAttachmentOrThrow = async (attachment: Attachment): Promise<Attachment> => {
  const cached = await persistAttachmentLocally(attachment);
  const attachmentsDir = await getAttachmentsDir();
  const cachedInfo = describeAttachmentCacheInfo(cached.uri);
  const cachedInManagedDir = Boolean(attachmentsDir && cached.uri.startsWith(attachmentsDir));
  if (!cachedInManagedDir || cachedInfo.exists !== 'true' || cachedInfo.isDirectory === 'true') {
    throw new Error(`Audio attachment was not cached into managed storage: ${cached.uri}`);
  }
  return cached;
};

export function useQuickCaptureAudio({
  addTask,
  autoRecord,
  buildTaskProps,
  getActiveSubmissionSession,
  handleClose,
  initialAttachments,
  onError,
  onSubmissionBusyChange,
  onWarn,
  settings,
  submissionCoordinator,
  submissionKey,
  t,
  updateSpeechSettings,
  visible,
}: UseQuickCaptureAudioParams) {
  const { showToast } = useToast();
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingReady, setRecordingReady] = useState(false);
  const recordingStartOwnerRef = useRef<{ id: number; session: CaptureSessionId } | null>(null);
  const recordingStartSequenceRef = useRef(0);
  const activeRecordingRef = useRef<RecordingState | null>(null);
  const safeDeleteFileRef = useRef<(file: File, reason: string) => void>(() => undefined);

  useEffect(() => () => {
    recordingStartOwnerRef.current = null;
    const activeRecording = activeRecordingRef.current;
    activeRecordingRef.current = null;
    if (activeRecording) {
      void queueRecordingDeviceOperation(() => releaseRecordingOnTeardown(activeRecording))
        .then((file) => {
          if (file) safeDeleteFileRef.current(file, 'recording_unmount');
        })
        .catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    recordingStartOwnerRef.current = null;
    setRecordingBusy(false);
    onSubmissionBusyChange(false);
  }, [onSubmissionBusyChange, submissionKey, visible]);

  const ensureAudioDirectory = useCallback(async () => {
    const candidates: Directory[] = [];
    try {
      candidates.push(Paths.document);
    } catch (error) {
      onWarn('Document directory unavailable', error);
    }
    try {
      candidates.push(Paths.cache);
    } catch (error) {
      onWarn('Cache directory unavailable', error);
    }
    for (const root of candidates) {
      try {
        const directoryUri = buildCaptureDirectoryUri(root.uri, 'audio-captures');
        const dir = new Directory(directoryUri);
        dir.create({ intermediates: true, idempotent: true });
        return dir;
      } catch (error) {
        onWarn('Failed to create audio directory', error);
      }
    }
    return null;
  }, [onWarn]);

  const stripFileScheme = useCallback((uri: string) => {
    if (uri.startsWith('file://')) return uri.slice(7);
    if (uri.startsWith('file:/')) return uri.replace(/^file:\//, '/');
    return uri;
  }, []);

  const isUnsafeDeleteTarget = useCallback((uri: string) => {
    if (!uri) return true;
    const normalized = stripFileScheme(uri).replace(/\/+$/, '');
    const docBase = stripFileScheme(Paths.document?.uri ?? '').replace(/\/+$/, '');
    const cacheBase = stripFileScheme(Paths.cache?.uri ?? '').replace(/\/+$/, '');
    if (!normalized) return true;
    if (normalized === '/' || normalized === docBase || normalized === cacheBase) return true;
    return false;
  }, [stripFileScheme]);

  const safeDeleteFile = useCallback((file: File, reason: string) => {
    try {
      const uri = file.uri ?? '';
      if (isUnsafeDeleteTarget(uri)) {
        onWarn('Refusing to delete unsafe file target', new Error(`${reason}:${uri}`));
        return;
      }
      const info = Paths.info(uri);
      if (info?.exists && info.isDirectory) {
        onWarn('Refusing to delete directory target', new Error(`${reason}:${uri}`));
        return;
      }
      file.delete();
    } catch (error) {
      onWarn('Audio cleanup failed', error);
    }
  }, [isUnsafeDeleteTarget, onWarn]);
  safeDeleteFileRef.current = safeDeleteFile;

  const isSpeechSettingsLeaseCurrent = useCallback((
    expectedProvider: string,
    expectedModel: string,
    expectedModelPath?: string,
  ) => {
    const latestSettings = selectQuickCaptureSettings(settings, useTaskStore.getState().settings);
    const latestRuntime = resolveSpeechToTextRuntimeSettings(latestSettings.ai?.speechToText);
    return latestRuntime.provider === expectedProvider
      && latestRuntime.model === expectedModel
      && stripFileScheme(latestRuntime.modelPath ?? '') === stripFileScheme(expectedModelPath ?? '');
  }, [settings, stripFileScheme]);

  const resolveWhisperModelAsync = useCallback(async (
    modelId: string,
    storedPath?: string,
    canApply: () => boolean = () => true,
  ) => {
    const resolved = await ensureWhisperModelPathForConfigAsync(modelId, storedPath);
    if (resolved.exists && canApply()) {
      const currentPath = storedPath ? stripFileScheme(storedPath) : '';
      const resolvedPath = stripFileScheme(resolved.uri);
      if (!currentPath || currentPath !== resolvedPath) {
        updateSpeechSettings({ model: modelId, offlineModelPath: resolved.uri });
      }
    }
    return resolved;
  }, [stripFileScheme, updateSpeechSettings]);

  useEffect(() => {
    if (!visible) return;
    const speech = settings.ai?.speechToText;
    const speechRuntime = resolveSpeechToTextRuntimeSettings(speech);
    if (!speechRuntime.enabled || speechRuntime.provider !== 'whisper') return;
    const { model, modelPath } = speechRuntime;
    let cancelled = false;
    void resolveWhisperModelAsync(model, modelPath, () => (
      !cancelled && isSpeechSettingsLeaseCurrent('whisper', model, modelPath)
    ))
      .then((resolved) => {
        if (cancelled || !resolved.exists) return undefined;
        return preloadWhisperContext({ model, modelPath: resolved.path });
      })
      .catch((error) => {
        if (cancelled) return;
        onWarn('Failed to preload whisper model', error);
      });
    return () => {
      cancelled = true;
    };
  }, [isSpeechSettingsLeaseCurrent, onWarn, resolveWhisperModelAsync, settings.ai?.speechToText, visible]);

  const applySpeechResult = useCallback(async (taskId: string, result: SpeechToTextResult): Promise<SpeechApplyResult> => {
    const { tasks: currentTasks, projects: currentProjects, addProject: addProjectNow, updateTask: updateTaskNow, settings: currentSettings } = useTaskStore.getState();
    const existing = currentTasks.find((task) => task.id === taskId);
    if (!existing) return 'skipped';

    const { updates, suggestedProjectTitle } = buildTaskUpdatesFromSpeechResult(existing, result, currentSettings);
    if (suggestedProjectTitle && !existing.projectId) {
      const targetAreaId = updates.areaId ?? existing.areaId;
      const match = findSelectableProjectByTitleAndArea(currentProjects, suggestedProjectTitle, targetAreaId);
      if (match) {
        updates.projectId = match.id;
      } else {
        const created = await addProjectNow(
          suggestedProjectTitle,
          DEFAULT_PROJECT_COLOR,
          targetAreaId ? { areaId: targetAreaId } : undefined
        );
        if (!created) return 'skipped';
        updates.projectId = created.id;
      }
    }

    if (Object.keys(updates).length) {
      await updateTaskNow(taskId, updates);
      return 'applied';
    }

    return 'empty';
  }, []);

  const discardEmptySpeechTask = useCallback(async (taskId: string, files: (File | null | undefined)[], reason = 'empty_transcript') => {
    try {
      await useTaskStore.getState().deleteTask(taskId);
    } catch (error) {
      onWarn('Failed to discard empty speech task', error);
    }
    const seen = new Set<string>();
    for (const file of files) {
      const uri = file?.uri ?? '';
      if (!file || !uri || seen.has(uri)) continue;
      seen.add(uri);
      safeDeleteFile(file, reason);
    }
  }, [onWarn, safeDeleteFile]);

  const startRecording = useCallback((): Promise<void> => {
    if (recording || recordingBusy || recordingStartOwnerRef.current !== null) return Promise.resolve();
    const session = getActiveSubmissionSession();
    if (session === null || !submissionCoordinator.isCurrent(session)) return Promise.resolve();
    const owner = { id: recordingStartSequenceRef.current + 1, session };
    recordingStartSequenceRef.current = owner.id;
    recordingStartOwnerRef.current = owner;
    setRecordingBusy(true);
    setRecordingReady(false);
    const isStartCurrent = () => (
      recordingStartOwnerRef.current === owner
      && getActiveSubmissionSession() === session
      && submissionCoordinator.isCurrent(session)
    );
    const runStart = async () => {
      try {
        // Voice capture is speech-to-text: if no model/key is configured, transcription can
        // never run. Resolve it under the current capture-session lease so a dismissed start
        // cannot toast, record, or clear state belonging to the next sheet.
        const guardSettings = selectQuickCaptureSettings(settings, useTaskStore.getState().settings);
        const guardRuntime = resolveSpeechToTextRuntimeSettings(guardSettings.ai?.speechToText);
        const guardApiKey = guardRuntime.provider === 'whisper'
          ? ''
          : await loadAIKey(guardRuntime.provider).catch(() => '');
        if (!isStartCurrent()) return;
        const guardWhisper = guardRuntime.provider === 'whisper'
          ? await resolveWhisperModelAsync(guardRuntime.model, guardRuntime.modelPath, () => (
            isStartCurrent()
            && isSpeechSettingsLeaseCurrent(guardRuntime.provider, guardRuntime.model, guardRuntime.modelPath)
          )).catch(() => null)
          : null;
        if (!isStartCurrent()) return;
        const speechConfigured = isQuickCaptureSpeechReady({
          speechEnabled: guardRuntime.enabled,
          provider: guardRuntime.provider,
          apiKey: guardApiKey,
          baseUrl: guardRuntime.baseUrl,
          whisperModelReady: guardRuntime.provider === 'whisper' ? Boolean(guardWhisper?.exists) : false,
          whisperModelPath: guardRuntime.modelPath,
        });
        if (!speechConfigured) {
          showToast({
            title: t('common.notice'),
            message: t('quickAdd.speechNotConfigured'),
            tone: 'warning',
            durationMs: 4200,
          });
          return;
        }
        const permission = await requestRecordingPermissionsAsync();
        if (!isStartCurrent()) return;
        if (!permission.granted) {
          Alert.alert(t('quickAdd.audioPermissionTitle'), t('quickAdd.audioPermissionBody'));
          return;
        }
        const currentSettings = selectQuickCaptureSettings(settings, useTaskStore.getState().settings);
        const speech = currentSettings.ai?.speechToText;
        const speechRuntime = resolveSpeechToTextRuntimeSettings(speech);
        const { provider, model, modelPath } = speechRuntime;
        const whisperResolved = provider === 'whisper'
          ? await resolveWhisperModelAsync(model, modelPath, () => (
            isStartCurrent() && isSpeechSettingsLeaseCurrent(provider, model, modelPath)
          ))
          : null;
        if (!isStartCurrent()) return;
        const whisperModelReady = provider === 'whisper' ? Boolean(whisperResolved?.exists) : false;
        const resolvedModelPath = provider === 'whisper'
          ? (whisperResolved?.exists ? whisperResolved.path : modelPath)
          : undefined;
        const useWhisperRealtime = speechRuntime.enabled
          && provider === 'whisper'
          && whisperModelReady;
        if (useWhisperRealtime) {
          try {
            const now = new Date();
            const timestamp = safeFormatDate(now, 'yyyyMMdd-HHmmss');
            const directory = await ensureAudioDirectory();
            if (!isStartCurrent()) return;
            const fileName = `mindwtr-audio-${timestamp}-${generateUUID()}.wav`;
            const buildOutputFile = (base?: Directory | null) => {
              if (!base?.uri) return null;
              return new File(buildCaptureFileUri(base.uri, fileName));
            };
            let outputFile: File | null = buildOutputFile(directory);
            if (!outputFile) {
              try {
                outputFile = buildOutputFile(Paths.cache);
              } catch (error) {
                onWarn('Whisper cache directory unavailable', error);
              }
            }
            if (!outputFile) {
              try {
                outputFile = buildOutputFile(Paths.document);
              } catch (error) {
                onWarn('Whisper document directory unavailable', error);
              }
            }
            if (!outputFile) throw new Error('Whisper audio output path unavailable');
            const outputPath = stripFileScheme(outputFile.uri);
            const handle = await queueRecordingDeviceOperation(async () => {
              if (!isStartCurrent()) return null;
              await setAudioModeAsync({
                allowsRecording: true,
                playsInSilentMode: true,
                interruptionMode: 'duckOthers',
                interruptionModeAndroid: 'duckOthers',
              });
              if (!isStartCurrent()) return null;
              const acquired = await startWhisperRealtimeCapture(outputPath, {
                provider,
                model,
                modelPath: resolvedModelPath,
                isFossBuild: speechRuntime.isFossBuild,
                language: speechRuntime.language,
                mode: speechRuntime.mode,
                fieldStrategy: speechRuntime.fieldStrategy,
              });
              if (!isStartCurrent()) {
                await acquired.stop().catch((error) => onWarn('Failed to clean up stale Whisper start', error));
                void acquired.result.catch((error) => onWarn('Stale Whisper result failed', error));
                safeDeleteFile(outputFile, 'stale_whisper_start');
                return null;
              }
              return acquired;
            });
            if (!handle) return;
            if (!isStartCurrent()) {
              await queueRecordingDeviceOperation(async () => {
                await handle.stop().catch((error) => onWarn('Failed to clean up stale Whisper start', error));
                void handle.result.catch((error) => onWarn('Stale Whisper result failed', error));
                safeDeleteFile(outputFile, 'stale_whisper_start');
              });
              return;
            }
            const nextRecording: RecordingState = {
              kind: 'whisper',
              stop: handle.stop,
              result: handle.result,
              file: outputFile,
              allowRealtimeFallback: handle.hasRealtimeTranscript,
            };
            activeRecordingRef.current = nextRecording;
            setRecording(nextRecording);
            setRecordingReady(true);
            return;
          } catch (error) {
            if (!isStartCurrent()) return;
            onWarn('Whisper realtime start failed, falling back to audio recording', error);
          }
        }

        const recorder = await queueRecordingDeviceOperation(async () => {
          if (!isStartCurrent()) return null;
          await setAudioModeAsync({
            allowsRecording: true,
            playsInSilentMode: true,
            interruptionMode: 'duckOthers',
            interruptionModeAndroid: 'duckOthers',
          });
          if (!isStartCurrent()) return null;
          const acquired = createExpoAudioRecorder();
          try {
            await acquired.prepareToRecordAsync();
            if (!isStartCurrent()) {
              const staleUri = acquired.uri;
              acquired.release();
              if (staleUri) safeDeleteFile(new File(staleUri), 'stale_expo_prepare');
              return null;
            }
            acquired.record();
            return acquired;
          } catch (error) {
            acquired.release();
            throw error;
          }
        });
        if (!recorder) return;
        if (!isStartCurrent()) {
          const stopped = await queueRecordingDeviceOperation(() => stopAndReleaseExpoRecorder(recorder));
          if (stopped.error) onWarn('Failed to clean up stale Expo start', stopped.error);
          if (stopped.uri) safeDeleteFile(new File(stopped.uri), 'stale_expo_start');
          return;
        }
        const nextRecording: RecordingState = { kind: 'expo', recorder };
        activeRecordingRef.current = nextRecording;
        setRecording(nextRecording);
        setRecordingReady(true);
      } catch (error) {
        if (!isStartCurrent()) return;
        onError('Failed to start recording', error);
        Alert.alert(t('quickAdd.audioErrorTitle'), t('quickAdd.audioErrorBody'));
        setRecordingReady(false);
      } finally {
        if (recordingStartOwnerRef.current === owner) {
          const ownsCurrentSurface = getActiveSubmissionSession() === session
            && submissionCoordinator.isCurrent(session);
          recordingStartOwnerRef.current = null;
          if (ownsCurrentSurface) setRecordingBusy(false);
        }
      }
    };
    return runStart();
  }, [
    ensureAudioDirectory,
    getActiveSubmissionSession,
    isSpeechSettingsLeaseCurrent,
    onError,
    onWarn,
    recording,
    recordingBusy,
    resolveWhisperModelAsync,
    safeDeleteFile,
    settings,
    showToast,
    stripFileScheme,
    submissionCoordinator,
    t,
  ]);

  const stopRecording = useCallback(async ({ saveTask }: { saveTask: boolean }) => {
    if (recordingBusy) return;
    const currentRecording = activeRecordingRef.current ?? recording;
    if (!currentRecording) return;
    const ownedSubmissionFiles = new Map<string, File>();
    let submissionFilesAdopted = false;
    const trackSubmissionFile = (file: File): File => {
      if (file.uri) ownedSubmissionFiles.set(file.uri, new File(file.uri));
      return file;
    };
    const forgetSubmissionFile = (uri: string) => {
      ownedSubmissionFiles.delete(uri);
    };
    const cleanupAbandonedSubmissionFiles = (reason: string) => {
      for (const file of ownedSubmissionFiles.values()) {
        safeDeleteFile(file, reason);
      }
      ownedSubmissionFiles.clear();
    };
    const captureSurfaceSession = getActiveSubmissionSession();
    const submissionSession = saveTask ? captureSurfaceSession : null;
    if (saveTask) {
      if (submissionSession === null || !submissionCoordinator.tryBeginSubmission(submissionSession)) return;
      onSubmissionBusyChange(true);
    }
    const isSubmissionCurrent = () => (
      captureSurfaceSession === null || submissionCoordinator.isCurrent(captureSurfaceSession)
    );
    setRecordingBusy(true);
    setRecordingReady(false);
    activeRecordingRef.current = null;
    setRecording(null);
    try {
      if (currentRecording.kind === 'whisper') {
        try {
          await queueRecordingDeviceOperation(() => currentRecording.stop());
        } catch (error) {
          onWarn('Failed to stop whisper recording', error);
        }
        const finalFile = trackSubmissionFile(currentRecording.file);
        if (!saveTask) {
          if (currentRecording.allowRealtimeFallback) {
            void currentRecording.result.catch((error) => onWarn('Speech-to-text failed', error));
          }
          safeDeleteFile(currentRecording.file, 'whisper_cancel');
          forgetSubmissionFile(finalFile.uri);
          return;
        }
        if (!isSubmissionCurrent()) return;

        let fileInfo: { exists?: boolean; size?: number } | null = null;
        try {
          fileInfo = finalFile.info();
        } catch (error) {
          onWarn('Audio info lookup failed', error);
        }
        const now = new Date();
        const nowIso = now.toISOString();
        const displayTitle = `${t('quickAdd.audioNoteTitle')} ${safeFormatDate(now, 'Pp')}`;
        const currentSettings = selectQuickCaptureSettings(settings, useTaskStore.getState().settings);
        const speech = currentSettings.ai?.speechToText;
        const speechRuntime = resolveSpeechToTextRuntimeSettings(speech);
        const { provider, model, modelPath } = speechRuntime;
        const apiKey = provider === 'whisper' ? '' : await loadAIKey(provider).catch(() => '');
        const whisperResolved = provider === 'whisper'
          ? await resolveWhisperModelAsync(model, modelPath, () => (
            isSubmissionCurrent() && isSpeechSettingsLeaseCurrent(provider, model, modelPath)
          ))
          : null;
        const whisperModelReady = provider === 'whisper' ? Boolean(whisperResolved?.exists) : false;
        const resolvedModelPath = provider === 'whisper'
          ? (whisperResolved?.exists ? whisperResolved.path : modelPath)
          : undefined;
        if (!isSubmissionCurrent()) return;

        const speechReady = isQuickCaptureSpeechReady({
          speechEnabled: speechRuntime.enabled,
          provider,
          apiKey,
          baseUrl: speechRuntime.baseUrl,
          whisperModelReady,
          whisperModelPath: modelPath,
        });
        let realtimeResult: SpeechToTextResult | null = null;
        let realtimeTranscriptReady = false;
        if (speechReady && provider === 'whisper' && currentRecording.allowRealtimeFallback) {
          try {
            const result = await currentRecording.result;
            if (result.transcript?.trim()) {
              realtimeResult = result;
              realtimeTranscriptReady = true;
            }
          } catch (error) {
            onWarn('Whisper realtime transcription failed', error);
          }
        }
        const localWhisperInput = speechReady && provider === 'whisper' && !realtimeTranscriptReady
          ? await prepareAudioForLocalWhisper({
            uri: finalFile.uri,
            platform: getWhisperCapturePlatform(),
            source: 'pcm-recorder',
            extension: '.wav',
          })
          : null;
        if (!isSubmissionCurrent()) return;
        const canTranscribeSpeech = provider === 'whisper'
          ? realtimeTranscriptReady || Boolean(localWhisperInput)
          : speechReady;
        const saveAudioAttachments = currentSettings.gtd?.saveAudioAttachments !== false || !canTranscribeSpeech;

        let attachment: Attachment | null = saveAudioAttachments ? {
          id: generateUUID(),
          kind: 'file',
          title: displayTitle,
          uri: finalFile.uri,
          mimeType: getCaptureMimeType('.wav'),
          size: fileInfo?.exists && fileInfo.size ? fileInfo.size : undefined,
          createdAt: nowIso,
          updatedAt: nowIso,
          localStatus: 'available',
        } : null;
        if (attachment) {
          try {
            attachment = await cacheAudioAttachmentOrThrow(attachment);
            trackSubmissionFile(new File(attachment.uri));
          } catch (error) {
            onWarn('Failed to persist audio attachment', error);
            throw error;
          }
        }
        if (!isSubmissionCurrent()) return;

        const attachments = [...(initialAttachments ?? [])];
        if (attachment) attachments.push(attachment);
        const { title, props, invalidDateCommands } = await buildTaskProps(displayTitle, { attachments });
        if (!isSubmissionCurrent()) return;
        if (invalidDateCommands && invalidDateCommands.length > 0) {
          showInvalidDateCommandToast(showToast, t, invalidDateCommands);
          return;
        }
        if (!title.trim()) return;

        const addTaskResult = await addTask(title, props);
        if (addTaskResult.success && addTaskResult.id) submissionFilesAdopted = true;
        if (!isSubmissionCurrent()) return;
        handleClose();

        if (!addTaskResult.success || !addTaskResult.id) return;
        const taskId = addTaskResult.id;

        if (canTranscribeSpeech) {
          const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : undefined;
          const transcriptionUri = stripFileScheme(attachment?.uri ?? finalFile.uri);
          const speechConfig = {
            provider,
            apiKey,
            baseUrl: speechRuntime.baseUrl,
            model,
            modelPath: resolvedModelPath,
            isFossBuild: speechRuntime.isFossBuild,
            language: speechRuntime.language,
            mode: speechRuntime.mode,
            fieldStrategy: speechRuntime.fieldStrategy,
            parseModel: provider === 'openai' && currentSettings.ai?.provider === 'openai' ? currentSettings.ai?.model : undefined,
            now: new Date(),
            timeZone,
          } satisfies SpeechToTextConfig;
          if (provider === 'whisper' && realtimeResult) {
            void Promise.resolve(realtimeResult)
              .then(async (result) => {
                const applyResult = await applySpeechResult(taskId, result);
                if (applyResult === 'empty') {
                  await discardEmptySpeechTask(taskId, [
                    finalFile,
                    attachment?.uri ? new File(attachment.uri) : null,
                  ], 'whisper_empty_realtime');
                }
              })
              .catch((error) => onWarn('Speech-to-text failed', error))
              .finally(() => {
                if (!saveAudioAttachments) {
                  safeDeleteFile(finalFile, 'whisper_realtime_cleanup');
                }
              });
            return;
          }
          const speechPromise = provider === 'whisper' && localWhisperInput
            ? runWhisperLocalTranscription(localWhisperInput, speechConfig)
            : processAudioCapture(transcriptionUri, speechConfig);
          void speechPromise
            .then(async (result) => {
              const applyResult = await applySpeechResult(taskId, result);
              if (applyResult === 'empty') {
                await discardEmptySpeechTask(taskId, [
                  finalFile,
                  attachment?.uri ? new File(attachment.uri) : null,
                ], 'whisper_empty_transcript');
              }
            })
            .catch((error) => {
              if (!currentRecording.allowRealtimeFallback) {
                onWarn('Whisper offline transcription failed', error);
                return undefined;
              }
              onWarn('Whisper offline transcription failed, using realtime result', error);
              return currentRecording.result
                .then(async (result) => {
                  const applyResult = await applySpeechResult(taskId, result);
                  if (applyResult === 'empty') {
                    await discardEmptySpeechTask(taskId, [
                      finalFile,
                      attachment?.uri ? new File(attachment.uri) : null,
                    ], 'whisper_empty_realtime_fallback');
                  }
                })
                .catch((realtimeError) => onWarn('Speech-to-text failed', realtimeError));
            })
            .finally(() => {
              if (!saveAudioAttachments) {
                safeDeleteFile(finalFile, 'whisper_cleanup');
              }
            });
        } else {
          if (!saveAudioAttachments) {
            safeDeleteFile(finalFile, 'whisper_skip_cleanup');
          }
        }
        return;
      }

      const stopped = await queueRecordingDeviceOperation(
        () => stopAndReleaseExpoRecorder(currentRecording.recorder),
      );
      if (stopped.error) {
        const error = stopped.error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('not recording') && !message.includes('already')) {
          throw error;
        }
      }
      const uri = stopped.uri;
      if (!uri) {
        throw new Error('Recording URI missing');
      }
      const sourceFile = trackSubmissionFile(new File(uri));
      if (!saveTask) {
        safeDeleteFile(sourceFile, 'expo_cancel');
        forgetSubmissionFile(uri);
        return;
      }
      if (!isSubmissionCurrent()) return;

      const now = new Date();
      const timestamp = safeFormatDate(now, 'yyyyMMdd-HHmmss');
      const extension = getCaptureFileExtension(uri);
      const shouldRelocateRecording = Platform.OS !== 'ios';
      const directory = shouldRelocateRecording ? await ensureAudioDirectory() : null;
      const fileName = `mindwtr-audio-${timestamp}-${generateUUID()}${extension}`;
      const destinationFile = directory ? new File(buildCaptureFileUri(directory.uri, fileName)) : null;
      let captureCandidates: (File | null)[] = [sourceFile];

      if (destinationFile) {
        try {
          sourceFile.move(destinationFile);
          forgetSubmissionFile(uri);
          trackSubmissionFile(destinationFile);
          captureCandidates = [sourceFile, destinationFile];
        } catch (error) {
          onWarn('Move recording failed, falling back to copy', error);
          try {
            sourceFile.copy(destinationFile);
            trackSubmissionFile(destinationFile);
            captureCandidates = [destinationFile, sourceFile];
            const copiedDestination = selectExistingCaptureFile([destinationFile]);
            if (copiedDestination) {
              safeDeleteFile(sourceFile, 'recording_copy_cleanup');
              forgetSubmissionFile(uri);
            }
          } catch (copyError) {
            onWarn('Copy recording failed, using original file', copyError);
            captureCandidates = [sourceFile];
          }
        }
      }

      const verifiedCapture = selectExistingCaptureFile(captureCandidates);
      if (!verifiedCapture) {
        throw new Error(`Recording file missing after save: ${captureCandidates.map((file) => file?.uri ?? '').filter(Boolean).join(', ')}`);
      }
      const finalFile = verifiedCapture.file;
      trackSubmissionFile(finalFile);
      const fileInfo = verifiedCapture.info;
      const nowIso = now.toISOString();
      const displayTitle = `${t('quickAdd.audioNoteTitle')} ${safeFormatDate(now, 'Pp')}`;
      const currentSettings = selectQuickCaptureSettings(settings, useTaskStore.getState().settings);
      const speech = currentSettings.ai?.speechToText;
      const speechRuntime = resolveSpeechToTextRuntimeSettings(speech);
      const { provider, model, modelPath } = speechRuntime;
      const apiKey = provider === 'whisper' ? '' : await loadAIKey(provider).catch(() => '');
      const whisperResolved = provider === 'whisper'
        ? await resolveWhisperModelAsync(model, modelPath, () => (
          isSubmissionCurrent() && isSpeechSettingsLeaseCurrent(provider, model, modelPath)
        ))
        : null;
      const whisperModelReady = provider === 'whisper' ? Boolean(whisperResolved?.exists) : false;
      const resolvedModelPath = provider === 'whisper'
        ? (whisperResolved?.exists ? whisperResolved.path : modelPath)
        : undefined;
      if (!isSubmissionCurrent()) return;

      const speechReady = isQuickCaptureSpeechReady({
        speechEnabled: speechRuntime.enabled,
        provider,
        apiKey,
        baseUrl: speechRuntime.baseUrl,
        whisperModelReady,
        whisperModelPath: modelPath,
      });
      const audioUri = finalFile.uri;
      const localWhisperInput = speechReady && provider === 'whisper'
        ? await prepareAudioForLocalWhisper({
          uri: audioUri,
          platform: getWhisperCapturePlatform(),
          source: 'expo-recorder',
          extension,
        })
        : null;
      if (!isSubmissionCurrent()) return;
      const canTranscribeSpeech = provider === 'whisper' ? Boolean(localWhisperInput) : speechReady;
      const saveAudioAttachments = currentSettings.gtd?.saveAudioAttachments !== false || !canTranscribeSpeech;

      let attachment: Attachment | null = saveAudioAttachments ? {
        id: generateUUID(),
        kind: 'file',
        title: displayTitle,
        uri: audioUri,
        mimeType: getCaptureMimeType(extension),
        size: fileInfo?.exists && fileInfo.size ? fileInfo.size : undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
        localStatus: 'available',
      } : null;
      if (attachment) {
        try {
          attachment = await cacheAudioAttachmentOrThrow(attachment);
          trackSubmissionFile(new File(attachment.uri));
        } catch (error) {
          onWarn('Failed to persist audio attachment', error);
          throw error;
        }
      }
      if (!isSubmissionCurrent()) return;

      const attachments = [...(initialAttachments ?? [])];
      if (attachment) attachments.push(attachment);
      const { title, props, invalidDateCommands } = await buildTaskProps(displayTitle, { attachments });
      if (!isSubmissionCurrent()) return;
      if (invalidDateCommands && invalidDateCommands.length > 0) {
        showInvalidDateCommandToast(showToast, t, invalidDateCommands);
        return;
      }
      if (!title.trim()) return;

      const addTaskResult = await addTask(title, props);
      if (addTaskResult.success && addTaskResult.id) submissionFilesAdopted = true;
      if (!isSubmissionCurrent()) return;
      handleClose();

      if (!addTaskResult.success || !addTaskResult.id) return;
      const taskId = addTaskResult.id;

      if (canTranscribeSpeech) {
        const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : undefined;
        const speechConfig = {
          provider,
          apiKey,
          baseUrl: speechRuntime.baseUrl,
          model,
          modelPath: resolvedModelPath,
          isFossBuild: speechRuntime.isFossBuild,
          language: speechRuntime.language,
          mode: speechRuntime.mode,
          fieldStrategy: speechRuntime.fieldStrategy,
          parseModel: provider === 'openai' && currentSettings.ai?.provider === 'openai' ? currentSettings.ai?.model : undefined,
          now: new Date(),
          timeZone,
        } satisfies SpeechToTextConfig;
        const speechPromise = provider === 'whisper' && localWhisperInput
          ? runWhisperLocalTranscription(localWhisperInput, speechConfig)
          : processAudioCapture(audioUri, speechConfig);
        void speechPromise
          .then(async (result) => {
            const applyResult = await applySpeechResult(taskId, result);
            if (applyResult === 'empty') {
              await discardEmptySpeechTask(taskId, [
                finalFile,
                attachment?.uri ? new File(attachment.uri) : null,
              ], 'speech_empty_transcript');
            }
          })
          .catch((error) => onWarn('Speech-to-text failed', error))
          .finally(() => {
            if (!saveAudioAttachments) {
              safeDeleteFile(finalFile, 'expo_cleanup');
            }
          });
      } else {
        if (!saveAudioAttachments) {
          safeDeleteFile(finalFile, 'expo_skip_cleanup');
        }
      }
    } catch (error) {
      if (!isSubmissionCurrent()) return;
      onError('Failed to save recording', error);
      Alert.alert(t('quickAdd.audioErrorTitle'), t('quickAdd.audioErrorBody'));
    } finally {
      if (!submissionFilesAdopted && !isSubmissionCurrent()) {
        cleanupAbandonedSubmissionFiles('stale_audio_submission');
      }
      if (submissionSession === null) {
        if (captureSurfaceSession === null || submissionCoordinator.isCurrent(captureSurfaceSession)) {
          setRecordingBusy(false);
        }
      } else if (submissionCoordinator.finishSubmission(submissionSession)) {
        setRecordingBusy(false);
        onSubmissionBusyChange(false);
      }
    }
  }, [
    addTask,
    applySpeechResult,
    buildTaskProps,
    discardEmptySpeechTask,
    ensureAudioDirectory,
    getActiveSubmissionSession,
    handleClose,
    initialAttachments,
    isSpeechSettingsLeaseCurrent,
    onError,
    onSubmissionBusyChange,
    onWarn,
    recording,
    recordingBusy,
    resolveWhisperModelAsync,
    safeDeleteFile,
    settings,
    showToast,
    stripFileScheme,
    submissionCoordinator,
    t,
  ]);

  useEffect(() => {
    if (visible && autoRecord && !recording && !recordingBusy) {
      const handle = setTimeout(() => {
        void startRecording();
      }, 150);
      return () => clearTimeout(handle);
    }
    return undefined;
  }, [autoRecord, recording, recordingBusy, startRecording, visible]);

  return {
    recording,
    recordingBusy,
    recordingReady,
    startRecording,
    stopRecording,
  };
}
