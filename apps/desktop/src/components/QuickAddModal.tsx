import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    shallow,
    useTaskStore,
    buildTaskUpdatesFromSpeechResult,
    parseQuickAdd,
    safeFormatDate,
    generateUUID,
    DEFAULT_PROJECT_COLOR,
    tFallback,
    type Attachment,
    type Task,
} from '@mindwtr/core';
import { BaseDirectory, mkdir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import { dataDir, join } from '@tauri-apps/api/path';
import { useLanguage } from '../contexts/language-context';
import { cn } from '../lib/utils';
import { isFlatpakRuntime, isTauriRuntime } from '../lib/runtime';
import { reportError } from '../lib/report-error';
import { logWarn } from '../lib/app-log';
import { loadAIKey } from '../lib/ai-config';
import { encodeWav, resampleAudio } from '../lib/audio-utils';
import { getPreferredDesktopAudioCaptureBackend } from '../lib/audio-capture-backend';
import { processAudioCapture, type SpeechToTextResult } from '../lib/speech-to-text';
import { DEFAULT_WHISPER_MODEL } from '../lib/speech-models';
import { TaskInput } from './Task/TaskInput';
import { AreaSelector } from './ui/AreaSelector';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, resolveAreaFilter } from '../lib/area-filter';

const AUDIO_CAPTURE_DIR = 'mindwtr/audio-captures';
const TARGET_SAMPLE_RATE = 16_000;

export function QuickAddModal() {
    const getDerivedState = useTaskStore((state) => state.getDerivedState);
    const { addTask, addProject, projects, areas, settings } = useTaskStore(
        (state) => ({
            addTask: state.addTask,
            addProject: state.addProject,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
        }),
        shallow
    );
    const { allContexts, allTags } = getDerivedState();
    const suggestionTokens = useMemo(
        () => Array.from(new Set([...allContexts, ...allTags])).sort(),
        [allContexts, allTags]
    );
    const { t } = useLanguage();
    const [isOpen, setIsOpen] = useState(false);
    const [value, setValue] = useState('');
    const [selectedAreaId, setSelectedAreaId] = useState('');
    const [initialProps, setInitialProps] = useState<Partial<Task> | null>(null);
    const [forcedCaptureMode, setForcedCaptureMode] = useState<'text' | 'audio' | null>(null);
    const [captureMode, setCaptureMode] = useState<'text' | 'audio'>(
        settings?.gtd?.defaultCaptureMethod === 'audio' ? 'audio' : 'text'
    );
    const [isRecording, setIsRecording] = useState(false);
    const [recordingBusy, setRecordingBusy] = useState(false);
    const [recordingError, setRecordingError] = useState<string | null>(null);
    const [recordingBackend, setRecordingBackend] = useState<'web' | 'native' | null>(null);
    const lastActiveElementRef = useRef<HTMLElement | null>(null);
    const modalRef = useRef<HTMLDivElement | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const audioStreamRef = useRef<MediaStream | null>(null);
    const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const audioChunksRef = useRef<Float32Array[]>([]);
    const inputSampleRateRef = useRef<number>(16_000);
    const sortedAreas = useMemo(() => [...areas].sort((a, b) => a.order - b.order), [areas]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );
    const defaultAreaId = resolvedAreaFilter !== AREA_FILTER_ALL && resolvedAreaFilter !== AREA_FILTER_NONE
        ? resolvedAreaFilter
        : '';
    const parsedInput = useMemo(
        () => parseQuickAdd(value, projects, new Date(), areas),
        [value, projects, areas],
    );
    const hasProjectOverride = Boolean(initialProps?.projectId || parsedInput.props.projectId || parsedInput.projectTitle);
    const showAreaSelector = !hasProjectOverride;

    useEffect(() => {
        if (!isTauriRuntime()) return;

        let unlisten: (() => void) | undefined;
        const openFromTauri = async () => {
            setIsOpen(true);
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke<boolean>('consume_quick_add_pending');
            } catch (e) {
                reportError('Failed to open quick add', e);
            }
        };

        const setup = async () => {
            const [{ listen }, { invoke }] = await Promise.all([
                import('@tauri-apps/api/event'),
                import('@tauri-apps/api/core'),
            ]);

            unlisten = await listen('quick-add', () => {
                openFromTauri().catch((error) => reportError('Failed to open quick add', error));
            });

            const pending = await invoke<boolean>('consume_quick_add_pending');
            if (pending) {
                setIsOpen(true);
            }
        };

        setup().catch((error) => reportError('Failed to initialize quick add', error));

        return () => {
            if (unlisten) unlisten();
        };
    }, []);

    useEffect(() => {
        type QuickAddDetail = { initialProps?: Partial<Task>; initialValue?: string; captureMode?: 'text' | 'audio' };
        const handler: EventListener = (event) => {
            const detail = (event as CustomEvent<QuickAddDetail>).detail;
            setInitialProps(detail?.initialProps ?? null);
            setValue(detail?.initialValue ?? '');
            setForcedCaptureMode(detail?.captureMode ?? null);
            setIsOpen(true);
        };
        window.addEventListener('mindwtr:quick-add', handler);
        return () => window.removeEventListener('mindwtr:quick-add', handler);
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        lastActiveElementRef.current = document.activeElement as HTMLElement | null;
        if (!value) setValue('');
    }, [isOpen, value]);

    useEffect(() => {
        if (!isOpen) return;
        const nextArea = initialProps?.areaId ?? (initialProps?.projectId ? '' : defaultAreaId);
        setSelectedAreaId(nextArea ?? '');
    }, [defaultAreaId, initialProps?.areaId, initialProps?.projectId, isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        if (parsedInput.props.areaId) {
            setSelectedAreaId(parsedInput.props.areaId);
        }
    }, [isOpen, parsedInput.props.areaId]);


    useEffect(() => {
        if (!isOpen) return;
        const nextMode = forcedCaptureMode ?? (settings?.gtd?.defaultCaptureMethod === 'audio' ? 'audio' : 'text');
        setCaptureMode(nextMode);
        setRecordingError(null);
    }, [forcedCaptureMode, isOpen, settings?.gtd?.defaultCaptureMethod]);

    const applySpeechResult = useCallback(async (taskId: string, result: SpeechToTextResult) => {
        const {
            tasks: currentTasks,
            projects: currentProjects,
            addProject: addProjectNow,
            updateTask: updateTaskNow,
            settings: currentSettings,
        } = useTaskStore.getState();
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

    const close = () => {
        setIsOpen(false);
        setInitialProps(null);
        setValue('');
        setSelectedAreaId('');
        setForcedCaptureMode(null);
        lastActiveElementRef.current?.focus();
    };

    const startRecording = useCallback(async () => {
        if (recordingBusy || isRecording) return;
        setRecordingError(null);
        try {
            const preferredBackend = getPreferredDesktopAudioCaptureBackend({
                isTauriRuntime: isTauriRuntime(),
                isFlatpakRuntime: isFlatpakRuntime(),
            });

            if (preferredBackend === 'native') {
                try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('start_audio_recording');
                    setRecordingBackend('native');
                    setIsRecording(true);
                    return;
                } catch (error) {
                    void logWarn('Native audio recording failed, falling back to web capture', {
                        scope: 'audio',
                        extra: {
                            error: error instanceof Error ? error.message : String(error),
                            preferredBackend,
                        },
                    });
                }
            }
            if (!navigator.mediaDevices?.getUserMedia) {
                setRecordingError(t('quickAdd.audioErrorBody'));
                return;
            }
            if (navigator.mediaDevices.enumerateDevices) {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const hasInput = devices.some((device) => device.kind === 'audioinput');
                if (!hasInput) {
                    setRecordingError(`${t('quickAdd.audioErrorBody')} (No microphone detected)`);
                    return;
                }
            }
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const AudioContextConstructor =
                window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AudioContextConstructor) {
                throw new Error('AudioContext unavailable');
            }
            const context = new AudioContextConstructor();
            await context.resume();
            const source = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(4096, 1, 1);
            const zeroGain = context.createGain();
            zeroGain.gain.value = 0;
            audioChunksRef.current = [];
            inputSampleRateRef.current = context.sampleRate;
            processor.onaudioprocess = (event) => {
                const channel = event.inputBuffer.getChannelData(0);
                audioChunksRef.current.push(new Float32Array(channel));
            };
            source.connect(processor);
            processor.connect(zeroGain);
            zeroGain.connect(context.destination);
            audioContextRef.current = context;
            audioStreamRef.current = stream;
            audioSourceRef.current = source;
            audioProcessorRef.current = processor;
            setRecordingBackend('web');
            setIsRecording(true);
        } catch (error) {
            reportError('Audio recording failed', error);
            const message = error instanceof Error ? error.message : String(error);
            setRecordingError(`${t('quickAdd.audioErrorBody')} (${message})`);
        }
    }, [isRecording, recordingBusy, t]);

    const stopRecording = useCallback(async ({ saveTask }: { saveTask: boolean }) => {
        if (recordingBusy) return;
        if (!isRecording) return;
        setRecordingBusy(true);
        setIsRecording(false);
        try {
            type NativeResult = {
                path: string;
                relativePath: string;
                sampleRate: number;
                channels: number;
                size: number;
            };

            let wavBytes: Uint8Array | null = null;
            let fileName: string;
            let relativePath: string;
            let absolutePath: string;
            let audioByteSize: number | undefined;

            const now = new Date();
            if (recordingBackend === 'native' && isTauriRuntime()) {
                const { invoke } = await import('@tauri-apps/api/core');
                const result = await invoke<NativeResult>('stop_audio_recording');
                relativePath = result.relativePath;
                absolutePath = result.path;
                const parts = absolutePath.split(/[\\/]/);
                fileName = parts[parts.length - 1] || 'mindwtr-audio.wav';
                audioByteSize = result.size;
            } else {
                const currentAudioContext = audioContextRef.current;
                if (currentAudioContext?.state === 'running') {
                    // Suspending the graph gives ScriptProcessorNode one stable stop point before teardown.
                    await currentAudioContext.suspend();
                }
                audioProcessorRef.current?.disconnect();
                audioSourceRef.current?.disconnect();
                audioProcessorRef.current = null;
                audioSourceRef.current = null;
                audioStreamRef.current?.getTracks().forEach((track) => track.stop());
                audioStreamRef.current = null;
                if (currentAudioContext && currentAudioContext.state !== 'closed') {
                    await currentAudioContext.close();
                }
                audioContextRef.current = null;

                const chunks = audioChunksRef.current;
                audioChunksRef.current = [];
                if (!saveTask) return;
                if (!chunks.length) {
                    throw new Error('No audio data captured');
                }

                const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const buffer = new Float32Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) {
                    buffer.set(chunk, offset);
                    offset += chunk.length;
                }
                const resampled = resampleAudio(buffer, inputSampleRateRef.current, TARGET_SAMPLE_RATE);
                wavBytes = encodeWav(resampled, TARGET_SAMPLE_RATE);
                audioByteSize = wavBytes.length;

                const timestamp = safeFormatDate(now, 'yyyyMMdd-HHmmss');
                fileName = `mindwtr-audio-${timestamp}.wav`;
                await mkdir(AUDIO_CAPTURE_DIR, { baseDir: BaseDirectory.Data, recursive: true });
                relativePath = `${AUDIO_CAPTURE_DIR}/${fileName}`;
                await writeFile(relativePath, wavBytes, { baseDir: BaseDirectory.Data });
                const baseDir = await dataDir();
                absolutePath = await join(baseDir, AUDIO_CAPTURE_DIR, fileName);
            }

            if (!saveTask) {
                remove(relativePath, { baseDir: BaseDirectory.Data }).catch((error) => {
                    void logWarn('Audio cleanup failed', {
                        scope: 'audio',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                });
                return;
            }

            const nowIso = now.toISOString();
            const displayTitle = `${t('quickAdd.audioNoteTitle')} ${safeFormatDate(now, 'Pp')}`;
            const speech = settings.ai?.speechToText;
            const provider = speech?.provider ?? 'gemini';
            const model = speech?.model ?? (
                provider === 'openai' ? 'gpt-4o-transcribe'
                    : provider === 'gemini' ? 'gemini-2.5-flash'
                        : DEFAULT_WHISPER_MODEL
            );
            const apiKey = provider === 'whisper' ? '' : await loadAIKey(provider).catch(() => '');
            const modelPath = provider === 'whisper' ? speech?.offlineModelPath : undefined;
            const speechReady = speech?.enabled
                ? provider === 'whisper'
                    ? Boolean(modelPath)
                    : Boolean(apiKey)
                : false;
            const saveAudioAttachments = settings.gtd?.saveAudioAttachments !== false || !speechReady;

            const attachment: Attachment | null = saveAudioAttachments
                ? {
                    id: generateUUID(),
                    kind: 'file',
                    title: displayTitle,
                    uri: absolutePath,
                    mimeType: 'audio/wav',
                    size: audioByteSize,
                    createdAt: nowIso,
                    updatedAt: nowIso,
                }
                : null;

            const attachments = [...(initialProps?.attachments ?? [])];
            if (attachment) attachments.push(attachment);
            const props: Partial<Task> = {
                status: 'inbox',
                ...initialProps,
                attachments,
            };
            if (!props.status) props.status = 'inbox';

            const addTaskResult = await addTask(displayTitle, props);
            close();

            if (!addTaskResult.success || !addTaskResult.id) return;
            const taskId = addTaskResult.id;

            const runSpeech = async (bytes: Uint8Array) => {
                const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
                    ? Intl.DateTimeFormat().resolvedOptions().timeZone
                    : undefined;
                void processAudioCapture(
                    { bytes, mimeType: 'audio/wav', name: fileName, path: absolutePath },
                    {
                        provider,
                        apiKey,
                        model,
                        modelPath,
                        language: speech?.language,
                        mode: speech?.mode ?? 'smart_parse',
                        fieldStrategy: speech?.fieldStrategy ?? 'smart',
                        parseModel: provider === 'openai' && settings.ai?.provider === 'openai' ? settings.ai?.model : undefined,
                        now: new Date(),
                        timeZone,
                    }
                )
                    .then((result) => applySpeechResult(taskId, result))
                    .catch((error) => void logWarn('Speech-to-text failed', {
                        scope: 'audio',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    }))
                    .finally(() => {
                        if (!saveAudioAttachments) {
                            remove(relativePath, { baseDir: BaseDirectory.Data }).catch((error) => {
                                void logWarn('Audio cleanup failed', {
                                    scope: 'audio',
                                    extra: { error: error instanceof Error ? error.message : String(error) },
                                });
                            });
                        }
                    });
            };

            if (speechReady) {
                if (wavBytes) {
                    void runSpeech(wavBytes);
                } else {
                    void readFile(relativePath, { baseDir: BaseDirectory.Data })
                        .then((bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))
                        .then((bytes) => runSpeech(bytes))
                        .catch((error) => {
                            void logWarn('Failed to load audio for transcription', {
                                scope: 'audio',
                                extra: { error: error instanceof Error ? error.message : String(error) },
                            });
                            if (!saveAudioAttachments) {
                                remove(relativePath, { baseDir: BaseDirectory.Data }).catch((cleanupError) => {
                                    void logWarn('Audio cleanup failed', {
                                        scope: 'audio',
                                        extra: {
                                            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                                        },
                                    });
                                });
                            }
                        });
                }
            } else if (!saveAudioAttachments) {
                remove(relativePath, { baseDir: BaseDirectory.Data }).catch((error) => {
                    void logWarn('Audio cleanup failed', {
                        scope: 'audio',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                });
            }
        } catch (error) {
            reportError('Failed to save recording', error);
            const message = error instanceof Error ? error.message : String(error);
            setRecordingError(`${t('quickAdd.audioErrorBody')} (${message})`);
        } finally {
            setRecordingBusy(false);
            setRecordingBackend(null);
        }
    }, [
        addTask,
        applySpeechResult,
        close,
        initialProps,
        isRecording,
        recordingBusy,
        recordingBackend,
        settings.ai?.model,
        settings.ai?.provider,
        settings.ai?.speechToText,
        settings.gtd?.saveAudioAttachments,
        t,
    ]);

    const handleClose = () => {
        if (isRecording && !recordingBusy) {
            void stopRecording({ saveTask: false });
        }
        close();
    };

    useEffect(() => {
        if (!isOpen) return;
        const handler = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            handleClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [handleClose, isOpen]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!value.trim()) return;
        const { title, props, projectTitle, invalidDateCommands, detectedDate } = parseQuickAdd(value, projects, new Date(), areas);
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            return;
        }
        const baseProps: Partial<Task> = { ...initialProps, ...props };
        const shouldApplyDetectedDate = Boolean(detectedDate?.date && !baseProps.dueDate);
        if (shouldApplyDetectedDate && detectedDate) {
            baseProps.dueDate = detectedDate.date;
        }
        const finalTitle = shouldApplyDetectedDate && detectedDate ? detectedDate.titleWithoutDate : (title || value);
        if (!finalTitle.trim()) return;
        if (!baseProps.areaId && selectedAreaId) {
            baseProps.areaId = selectedAreaId;
        }
        let projectId = baseProps.projectId;
        if (!projectId && projectTitle) {
            const created = await addProject(projectTitle, DEFAULT_PROJECT_COLOR);
            if (!created) return;
            projectId = created.id;
        }
        const mergedProps: Partial<Task> = { status: 'inbox', ...baseProps, projectId };
        if (projectId) mergedProps.areaId = undefined;
        if (!baseProps.status) mergedProps.status = 'inbox';
        addTask(finalTitle, mergedProps);
        close();
    };

    const scheduledLabel = initialProps?.startTime
        ? safeFormatDate(initialProps.startTime, 'Pp')
        : null;
    const loadingLabel = tFallback(t, 'common.loading', 'Loading...');
    const audioButtonLabel = recordingBusy
        ? loadingLabel
        : isRecording
            ? t('quickAdd.audioStop')
            : t('quickAdd.audioRecord');
    const audioStatusLabel = recordingBusy
        ? 'Processing audio capture...'
        : isRecording
            ? t('quickAdd.audioRecording')
            : t('quickAdd.audioCaptureLabel');

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh] z-50"
            role="button"
            tabIndex={0}
            aria-label={t('common.close')}
            onClick={handleClose}
            onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                if (event.currentTarget !== event.target) return;
                event.preventDefault();
                handleClose();
            }}
        >
            <div
                ref={modalRef}
                className="w-full max-w-lg bg-popover text-popover-foreground rounded-xl border shadow-2xl overflow-visible flex flex-col"
                role="dialog"
                aria-modal="true"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(event) => {
                    if (event.key !== 'Tab') return;
                    const container = modalRef.current;
                    if (!container) return;
                    const focusable = Array.from(
                        container.querySelectorAll<HTMLElement>(
                            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                        )
                    ).filter((el) => !el.hasAttribute('disabled'));
                    if (focusable.length === 0) return;
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus();
                    } else if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    }
                }}
            >
                <div className="px-4 py-3 border-b flex items-center justify-between">
                    <h3 className="font-semibold">{t('nav.addTask')}</h3>
                    <button onClick={handleClose} className="text-sm text-muted-foreground hover:text-foreground">Esc</button>
                </div>
                <div className="px-4 pt-4">
                    <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
                        <button
                            type="button"
                            onClick={() => setCaptureMode('text')}
                            className={cn(
                                'px-3 py-1 text-xs rounded-md transition-colors',
                                captureMode === 'text' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t('settings.captureDefaultText')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setCaptureMode('audio')}
                            className={cn(
                                'px-3 py-1 text-xs rounded-md transition-colors',
                                captureMode === 'audio' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t('settings.captureDefaultAudio')}
                        </button>
                    </div>
                </div>
                {captureMode === 'text' ? (
                    <form onSubmit={handleSubmit} className="p-4 space-y-2">
                        <TaskInput
                            value={value}
                            autoFocus={captureMode === 'text'}
                            projects={projects}
                            contexts={suggestionTokens}
                            areas={areas}
                            onCreateProject={async (title) => {
                                const created = await addProject(title, DEFAULT_PROJECT_COLOR);
                                return created?.id ?? null;
                            }}
                            onChange={(next) => setValue(next)}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    handleClose();
                                }
                            }}
                            placeholder={t('nav.addTask')}
                            className={cn(
                                "w-full bg-card border border-border rounded-lg py-3 px-4 shadow-sm focus:ring-2 focus:ring-primary focus:border-transparent transition-all",
                            )}
                        />
                        {showAreaSelector && (
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.areaLabel')}</label>
                                <AreaSelector
                                    areas={sortedAreas}
                                    value={selectedAreaId}
                                    onChange={setSelectedAreaId}
                                    placeholder={t('taskEdit.noAreaOption')}
                                    noAreaLabel={t('taskEdit.noAreaOption')}
                                    searchPlaceholder={t('areas.search')}
                                    noMatchesLabel={t('common.noMatches')}
                                    createAreaLabel={t('areas.create')}
                                    className="w-full"
                                />
                            </div>
                        )}
                        <p className="text-xs text-muted-foreground">{t('quickAdd.help')}</p>
                        {parsedInput.invalidDateCommands && parsedInput.invalidDateCommands.length > 0 ? (
                            <p className="text-xs text-destructive">
                                {t('quickAdd.invalidDateCommand')}: {parsedInput.invalidDateCommands.join(', ')}
                            </p>
                        ) : null}
                        {scheduledLabel && (
                            <p className="text-xs text-muted-foreground">
                                {t('calendar.scheduleAction')}: {scheduledLabel}
                            </p>
                        )}
                        <div className="flex justify-end gap-2 pt-1">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="px-3 py-1.5 rounded-md text-sm bg-muted hover:bg-muted/80"
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                type="submit"
                                className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90"
                            >
                                {t('common.save')}
                            </button>
                        </div>
                    </form>
                ) : (
                    <div className="p-4 space-y-4">
                        <div className="flex flex-col items-center justify-center gap-3">
                            <button
                                type="button"
                                onClick={() => {
                                    if (recordingBusy) return;
                                    if (isRecording) {
                                        void stopRecording({ saveTask: true });
                                    } else {
                                        void startRecording();
                                    }
                                }}
                                className={cn(
                                    'h-16 w-16 rounded-full flex items-center justify-center text-sm font-medium transition-colors',
                                    isRecording ? 'bg-red-500 text-white' : 'bg-primary text-primary-foreground',
                                    recordingBusy ? 'opacity-70 cursor-not-allowed' : 'hover:opacity-90'
                                )}
                                aria-label={audioButtonLabel}
                                disabled={recordingBusy}
                            >
                                {audioButtonLabel}
                            </button>
                            <div className="text-xs text-muted-foreground" aria-live="polite">
                                {audioStatusLabel}
                            </div>
                            {recordingBusy ? (
                                <div className="text-xs text-muted-foreground text-center" aria-live="polite">
                                    Saving the recording and applying speech-to-text.
                                </div>
                            ) : null}
                            {recordingError ? (
                                <div className="text-xs text-red-500 text-center">{recordingError}</div>
                            ) : null}
                        </div>
                        <div className="flex justify-end gap-2 pt-1">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="px-3 py-1.5 rounded-md text-sm bg-muted hover:bg-muted/80"
                            >
                                {t('common.cancel')}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
