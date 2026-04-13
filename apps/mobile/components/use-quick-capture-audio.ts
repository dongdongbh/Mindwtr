import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import {
  DEFAULT_PROJECT_COLOR,
  buildTaskUpdatesFromSpeechResult,
  generateUUID,
  safeFormatDate,
  type AppData,
  type Attachment,
  type Task,
  useTaskStore,
} from '@mindwtr/core';
import { loadAIKey } from '../lib/ai-config';
import { persistAttachmentLocally } from '../lib/attachment-sync';
import { useToast } from '../contexts/toast-context';
import {
  ensureWhisperModelPathForConfig,
  preloadWhisperContext,
  processAudioCapture,
  startWhisperRealtimeCapture,
  type SpeechToTextResult,
} from '../lib/speech-to-text';
import { getCaptureFileExtension, getCaptureMimeType } from './quick-capture-sheet.utils';

type SpeechSettings = NonNullable<NonNullable<NonNullable<AppData['settings']>['ai']>['speechToText']>;
type BuildTaskPropsResult = {
  title: string;
  props: Partial<Task>;
  invalidDateCommands?: string[];
};

export type RecordingState =
  | { kind: 'expo' }
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
  handleClose: () => void;
  initialAttachments?: Attachment[];
  onError: (message: string, error?: unknown) => void;
  onWarn: (message: string, error?: unknown) => void;
  settings: AppData['settings'];
  t: (key: string) => string;
  updateSpeechSettings: (next: Partial<SpeechSettings>) => void;
  visible: boolean;
};

export function useQuickCaptureAudio({
  addTask,
  autoRecord,
  buildTaskProps,
  handleClose,
  initialAttachments,
  onError,
  onWarn,
  settings,
  t,
  updateSpeechSettings,
  visible,
}: UseQuickCaptureAudioParams) {
  const { showToast } = useToast();
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingReady, setRecordingReady] = useState(false);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

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
        const dir = new Directory(root, 'audio-captures');
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

  const resolveWhisperModel = useCallback((modelId: string, storedPath?: string) => {
    const resolved = ensureWhisperModelPathForConfig(modelId, storedPath);
    if (resolved.exists) {
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
    if (!speech?.enabled || speech.provider !== 'whisper') return;
    const model = speech.model ?? 'whisper-tiny';
    const modelPath = speech.offlineModelPath;
    const resolved = resolveWhisperModel(model, modelPath);
    if (!resolved.exists) return;
    let cancelled = false;
    void preloadWhisperContext({ model, modelPath: resolved.path }).catch((error) => {
      if (cancelled) return;
      onWarn('Failed to preload whisper model', error);
    });
    return () => {
      cancelled = true;
    };
  }, [onWarn, resolveWhisperModel, settings.ai?.speechToText, visible]);

  const applySpeechResult = useCallback(async (taskId: string, result: SpeechToTextResult) => {
    const { tasks: currentTasks, projects: currentProjects, addProject: addProjectNow, updateTask: updateTaskNow, settings: currentSettings } = useTaskStore.getState();
    const existing = currentTasks.find((task) => task.id === taskId);
    if (!existing) return;

    const { updates, suggestedProjectTitle } = buildTaskUpdatesFromSpeechResult(existing, result, currentSettings);
    if (suggestedProjectTitle && !existing.projectId) {
      const match = currentProjects.find((project) => project.title.toLowerCase() === suggestedProjectTitle.toLowerCase());
      if (match) {
        updates.projectId = match.id;
      } else {
        const created = await addProjectNow(suggestedProjectTitle, DEFAULT_PROJECT_COLOR);
        if (!created) return;
        updates.projectId = created.id;
      }
    }

    if (Object.keys(updates).length) {
      await updateTaskNow(taskId, updates);
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (recording || recordingBusy) return;
    setRecordingBusy(true);
    setRecordingReady(false);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(t('quickAdd.audioPermissionTitle'), t('quickAdd.audioPermissionBody'));
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'duckOthers',
        interruptionModeAndroid: 'duckOthers',
      });
      const speech = settings.ai?.speechToText;
      const provider = speech?.provider ?? 'gemini';
      const model = speech?.model ?? (provider === 'openai' ? 'gpt-4o-transcribe' : provider === 'gemini' ? 'gemini-2.5-flash' : 'whisper-tiny');
      const modelPath = provider === 'whisper' ? speech?.offlineModelPath : undefined;
      const whisperResolved = provider === 'whisper'
        ? resolveWhisperModel(model, modelPath)
        : null;
      const whisperModelReady = provider === 'whisper' ? Boolean(whisperResolved?.exists) : false;
      const resolvedModelPath = provider === 'whisper'
        ? (whisperResolved?.exists ? whisperResolved.path : modelPath)
        : undefined;
      const useWhisperRealtime = speech?.enabled && provider === 'whisper' && whisperModelReady;
      if (useWhisperRealtime) {
        try {
          const now = new Date();
          const timestamp = safeFormatDate(now, 'yyyyMMdd-HHmmss');
          const directory = await ensureAudioDirectory();
          const fileName = `mindwtr-audio-${timestamp}.wav`;
          const buildOutputFile = (base?: Directory | null) => {
            if (!base?.uri) return null;
            const baseUri = base.uri.endsWith('/') ? base.uri : `${base.uri}/`;
            return new File(`${baseUri}${fileName}`);
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
          if (!outputFile) {
            throw new Error('Whisper audio output path unavailable');
          }
          const outputPath = stripFileScheme(outputFile.uri);
          const handle = await startWhisperRealtimeCapture(outputPath, {
            provider,
            model,
            modelPath: resolvedModelPath,
            language: speech?.language,
            mode: speech?.mode ?? 'smart_parse',
            fieldStrategy: speech?.fieldStrategy ?? 'smart',
          });
          setRecording({
            kind: 'whisper',
            stop: handle.stop,
            result: handle.result,
            file: outputFile,
            allowRealtimeFallback: handle.hasRealtimeTranscript,
          });
          setRecordingReady(true);
          return;
        } catch (error) {
          onWarn('Whisper realtime start failed, falling back to audio recording', error);
        }
      }

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setRecording({ kind: 'expo' });
      setRecordingReady(true);
    } catch (error) {
      onError('Failed to start recording', error);
      Alert.alert(t('quickAdd.audioErrorTitle'), t('quickAdd.audioErrorBody'));
      setRecordingReady(false);
    } finally {
      setRecordingBusy(false);
    }
  }, [
    audioRecorder,
    ensureAudioDirectory,
    onError,
    onWarn,
    recording,
    recordingBusy,
    resolveWhisperModel,
    settings.ai?.speechToText,
    stripFileScheme,
    t,
  ]);

  const stopRecording = useCallback(async ({ saveTask }: { saveTask: boolean }) => {
    if (recordingBusy) return;
    const currentRecording = recording;
    if (!currentRecording) return;
    setRecordingBusy(true);
    setRecordingReady(false);
    setRecording(null);
    try {
      if (currentRecording.kind === 'whisper') {
        try {
          await currentRecording.stop();
        } catch (error) {
          onWarn('Failed to stop whisper recording', error);
        }
        if (!saveTask) {
          if (currentRecording.allowRealtimeFallback) {
            void currentRecording.result.catch((error) => onWarn('Speech-to-text failed', error));
          }
          safeDeleteFile(currentRecording.file, 'whisper_cancel');
          return;
        }

        const finalFile = currentRecording.file;
        let fileInfo: { exists?: boolean; size?: number } | null = null;
        try {
          fileInfo = finalFile.info();
        } catch (error) {
          onWarn('Audio info lookup failed', error);
        }
        const now = new Date();
        const nowIso = now.toISOString();
        const displayTitle = `${t('quickAdd.audioNoteTitle')} ${safeFormatDate(now, 'Pp')}`;
        const speech = settings.ai?.speechToText;
        const provider = speech?.provider ?? 'gemini';
        const model = speech?.model ?? (provider === 'openai' ? 'gpt-4o-transcribe' : provider === 'gemini' ? 'gemini-2.5-flash' : 'whisper-tiny');
        const apiKey = provider === 'whisper' ? '' : await loadAIKey(provider).catch(() => '');
        const modelPath = provider === 'whisper' ? speech?.offlineModelPath : undefined;
        const whisperResolved = provider === 'whisper'
          ? resolveWhisperModel(model, modelPath)
          : null;
        const whisperModelReady = provider === 'whisper' ? Boolean(whisperResolved?.exists) : false;
        const resolvedModelPath = provider === 'whisper'
          ? (whisperResolved?.exists ? whisperResolved.path : modelPath)
          : undefined;

        const speechReady = speech?.enabled
          ? provider === 'whisper'
            ? whisperModelReady
            : Boolean(apiKey)
          : false;
        const saveAudioAttachments = settings.gtd?.saveAudioAttachments !== false || !speechReady;

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
            attachment = await persistAttachmentLocally(attachment);
          } catch (error) {
            onWarn('Failed to persist audio attachment', error);
          }
        }

        const attachments = [...(initialAttachments ?? [])];
        if (attachment) attachments.push(attachment);
        const { title, props, invalidDateCommands } = await buildTaskProps(displayTitle, { attachments });
        if (invalidDateCommands && invalidDateCommands.length > 0) {
          showToast({
            title: t('common.notice'),
            message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
            tone: 'warning',
            durationMs: 4200,
          });
          return;
        }
        if (!title.trim()) return;

        const addTaskResult = await addTask(title, props);
        handleClose();

        if (!addTaskResult.success || !addTaskResult.id) return;
        const taskId = addTaskResult.id;

        if (speechReady) {
          const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : undefined;
          const transcriptionUri = stripFileScheme(attachment?.uri ?? finalFile.uri);
          void processAudioCapture(transcriptionUri, {
            provider,
            apiKey,
            model,
            modelPath: resolvedModelPath,
            language: speech?.language,
            mode: speech?.mode ?? 'smart_parse',
            fieldStrategy: speech?.fieldStrategy ?? 'smart',
            parseModel: provider === 'openai' && settings.ai?.provider === 'openai' ? settings.ai?.model : undefined,
            now: new Date(),
            timeZone,
          })
            .then((result) => applySpeechResult(taskId, result))
            .catch((error) => {
              if (!currentRecording.allowRealtimeFallback) {
                onWarn('Whisper offline transcription failed', error);
                return undefined;
              }
              onWarn('Whisper offline transcription failed, using realtime result', error);
              return currentRecording.result
                .then((result) => applySpeechResult(taskId, result))
                .catch((realtimeError) => onWarn('Speech-to-text failed', realtimeError));
            })
            .finally(() => {
              if (!saveAudioAttachments) {
                safeDeleteFile(finalFile, 'whisper_cleanup');
              }
            });
        } else if (!saveAudioAttachments) {
          safeDeleteFile(finalFile, 'whisper_skip_cleanup');
        }
        return;
      }

      try {
        await audioRecorder.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('not recording') && !message.includes('already')) {
          throw error;
        }
      }
      const uri = audioRecorder.uri;
      if (!uri) {
        throw new Error('Recording URI missing');
      }
      if (!saveTask) return;

      const now = new Date();
      const timestamp = safeFormatDate(now, 'yyyyMMdd-HHmmss');
      const extension = getCaptureFileExtension(uri);
      const directory = await ensureAudioDirectory();
      const fileName = `mindwtr-audio-${timestamp}${extension}`;
      const sourceFile = new File(uri);
      const destinationFile = directory ? new File(directory, fileName) : null;
      let finalFile = sourceFile;

      if (destinationFile) {
        try {
          sourceFile.move(destinationFile);
          finalFile = destinationFile;
        } catch (error) {
          onWarn('Move recording failed, falling back to copy', error);
          try {
            sourceFile.copy(destinationFile);
            safeDeleteFile(sourceFile, 'recording_copy_cleanup');
            finalFile = destinationFile;
          } catch (copyError) {
            onWarn('Copy recording failed, using original file', copyError);
            finalFile = sourceFile;
          }
        }
      }

      let fileInfo: { exists?: boolean; size?: number } | null = null;
      try {
        fileInfo = finalFile.info();
      } catch (error) {
        onWarn('Audio info lookup failed', error);
      }
      const nowIso = now.toISOString();
      const displayTitle = `${t('quickAdd.audioNoteTitle')} ${safeFormatDate(now, 'Pp')}`;
      const speech = settings.ai?.speechToText;
      const provider = speech?.provider ?? 'gemini';
      const model = speech?.model ?? (provider === 'openai' ? 'gpt-4o-transcribe' : provider === 'gemini' ? 'gemini-2.5-flash' : 'whisper-tiny');
      const apiKey = provider === 'whisper' ? '' : await loadAIKey(provider).catch(() => '');
      const modelPath = provider === 'whisper' ? speech?.offlineModelPath : undefined;
      const whisperResolved = provider === 'whisper'
        ? resolveWhisperModel(model, modelPath)
        : null;
      const whisperModelReady = provider === 'whisper' ? Boolean(whisperResolved?.exists) : false;
      const resolvedModelPath = provider === 'whisper'
        ? (whisperResolved?.exists ? whisperResolved.path : modelPath)
        : undefined;

      const allowWhisperOffline = provider !== 'whisper';
      const speechReady = speech?.enabled
        ? provider === 'whisper'
          ? whisperModelReady && allowWhisperOffline
          : Boolean(apiKey)
        : false;
      const saveAudioAttachments = settings.gtd?.saveAudioAttachments !== false || !speechReady;

      const audioUri = finalFile.uri;
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
          attachment = await persistAttachmentLocally(attachment);
        } catch (error) {
          onWarn('Failed to persist audio attachment', error);
        }
      }

      const attachments = [...(initialAttachments ?? [])];
      if (attachment) attachments.push(attachment);
      const { title, props, invalidDateCommands } = await buildTaskProps(displayTitle, { attachments });
      if (invalidDateCommands && invalidDateCommands.length > 0) {
        showToast({
          title: t('common.notice'),
          message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
          tone: 'warning',
          durationMs: 4200,
        });
        return;
      }
      if (!title.trim()) return;

      const addTaskResult = await addTask(title, props);
      handleClose();

      if (!addTaskResult.success || !addTaskResult.id) return;
      const taskId = addTaskResult.id;

      if (speechReady) {
        const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : undefined;
        void processAudioCapture(audioUri, {
          provider,
          apiKey,
          model,
          modelPath: resolvedModelPath,
          language: speech?.language,
          mode: speech?.mode ?? 'smart_parse',
          fieldStrategy: speech?.fieldStrategy ?? 'smart',
          parseModel: provider === 'openai' && settings.ai?.provider === 'openai' ? settings.ai?.model : undefined,
          now: new Date(),
          timeZone,
        })
          .then((result) => applySpeechResult(taskId, result))
          .catch((error) => onWarn('Speech-to-text failed', error))
          .finally(() => {
            if (!saveAudioAttachments) {
              safeDeleteFile(finalFile, 'expo_cleanup');
            }
          });
      } else if (!saveAudioAttachments) {
        safeDeleteFile(finalFile, 'expo_skip_cleanup');
      }
    } catch (error) {
      onError('Failed to save recording', error);
      Alert.alert(t('quickAdd.audioErrorTitle'), t('quickAdd.audioErrorBody'));
    } finally {
      setRecordingBusy(false);
    }
  }, [
    addTask,
    applySpeechResult,
    audioRecorder,
    buildTaskProps,
    ensureAudioDirectory,
    handleClose,
    initialAttachments,
    onError,
    onWarn,
    recording,
    recordingBusy,
    resolveWhisperModel,
    safeDeleteFile,
    settings,
    showToast,
    stripFileScheme,
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
