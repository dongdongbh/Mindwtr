import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  TextInput,
  useWindowDimensions,
} from 'react-native';

import {
  DEFAULT_PROJECT_COLOR,
  getUsedTaskTokens,
  parseQuickAdd,
  safeFormatDate,
  safeParseDate,
  type Task,
  type TaskPriority,
  useTaskStore,
} from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useToast } from '@/contexts/toast-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logError, logWarn } from '../lib/app-log';
import {
  buildCaptureExtra,
  normalizeContextToken,
  parseContextQueryTokens,
} from './quick-capture-sheet.utils';
import { QuickCaptureSheetBody } from './quick-capture-sheet/QuickCaptureSheetBody';
import { QuickCaptureSheetPickers } from './quick-capture-sheet/QuickCaptureSheetPickers';
import { useQuickCaptureAudio } from './use-quick-capture-audio';

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

const logCaptureWarn = (message: string, error?: unknown) => {
  void logWarn(message, { scope: 'capture', extra: buildCaptureExtra(undefined, error) });
};

const logCaptureError = (message: string, error?: unknown) => {
  const err = error instanceof Error ? error : new Error(message);
  void logError(err, { scope: 'capture', extra: buildCaptureExtra(message, error) });
};

export function QuickCaptureSheet({
  visible,
  onClose,
  initialProps,
  initialValue,
  autoRecord,
}: {
  visible: boolean;
  onClose: () => void;
  initialProps?: Partial<Task>;
  initialValue?: string;
  autoRecord?: boolean;
}) {
  const { addTask, addProject, updateSettings, projects, settings, tasks, areas } = useTaskStore();
  const { t } = useLanguage();
  const tc = useThemeColors();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const inputRef = useRef<TextInput>(null);
  const contextInputRef = useRef<TextInput>(null);
  const prioritiesEnabled = settings?.features?.priorities !== false;
  const { selectedAreaIdForNewTasks } = useMobileAreaFilter();

  const updateSpeechSettings = useCallback(
    (next: Partial<NonNullable<NonNullable<typeof settings.ai>['speechToText']>>) => {
      updateSettings({
        ai: {
          ...(settings.ai ?? {}),
          speechToText: {
            ...(settings.ai?.speechToText ?? {}),
            ...next,
          },
        },
      }).catch((error) => logCaptureWarn('Failed to update speech settings', error));
    },
    [settings, updateSettings]
  );

  const [value, setValue] = useState('');
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [startPickerMode, setStartPickerMode] = useState<'date' | 'time' | null>(null);
  const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
  const [contextTags, setContextTags] = useState<string[]>([]);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextQuery, setContextQuery] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [priority, setPriority] = useState<TaskPriority | null>(null);
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);
  const [addAnother, setAddAnother] = useState(false);

  const filteredProjects = useMemo(() => {
    const visibleProjects = projects.filter((project) => !project.deletedAt);
    const areaFilteredProjects = selectedAreaId
      ? visibleProjects.filter((project) => project.areaId === selectedAreaId)
      : visibleProjects;
    const query = projectQuery.trim().toLowerCase();
    if (!query) return areaFilteredProjects;
    return areaFilteredProjects.filter((project) => project.title.toLowerCase().includes(query));
  }, [projectQuery, projects, selectedAreaId]);

  const contextOptions = useMemo(() => {
    const initialContexts = initialProps?.contexts ?? [];
    return Array.from(
      new Set(
        [...getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' }), ...initialContexts]
          .map((item) => normalizeContextToken(String(item || '')))
          .filter(Boolean)
      )
    );
  }, [initialProps?.contexts, tasks]);

  const queryContextTokens = useMemo(() => parseContextQueryTokens(contextQuery), [contextQuery]);

  const filteredContexts = useMemo(() => {
    const query = queryContextTokens[0]?.toLowerCase() ?? '';
    if (!query) return contextOptions;
    return contextOptions.filter((token) => token.toLowerCase().includes(query));
  }, [contextOptions, queryContextTokens]);

  const hasAddableContextTokens = useMemo(() => {
    if (queryContextTokens.length === 0) return false;
    return queryContextTokens.some(
      (token) => !contextTags.some((selected) => selected.toLowerCase() === token.toLowerCase())
    );
  }, [contextTags, queryContextTokens]);

  const addContextFromQuery = useCallback(() => {
    const pendingTokens = parseContextQueryTokens(contextQuery);
    if (pendingTokens.length === 0) return 0;
    const resolvedTokens = pendingTokens.map((token) =>
      contextOptions.find((item) => item.toLowerCase() === token.toLowerCase()) ?? token
    );
    let addedCount = 0;
    setContextTags((prev) => {
      const next = [...prev];
      for (const token of resolvedTokens) {
        const exists = next.some((item) => item.toLowerCase() === token.toLowerCase());
        if (exists) continue;
        next.push(token);
        addedCount += 1;
      }
      return next;
    });
    setContextQuery('');
    return addedCount;
  }, [contextOptions, contextQuery]);

  const handleContextSubmit = useCallback(() => {
    addContextFromQuery();
    requestAnimationFrame(() => {
      contextInputRef.current?.focus();
    });
  }, [addContextFromQuery]);

  const submitProjectQuery = useCallback(async () => {
    const title = projectQuery.trim();
    if (!title) return;
    const match = projects.find((project) => project.title.toLowerCase() === title.toLowerCase());
    if (match) {
      setProjectId(match.id);
      setSelectedAreaId(null);
      setShowProjectPicker(false);
      setProjectQuery('');
      Keyboard.dismiss();
      return;
    }
    const created = await addProject(title, DEFAULT_PROJECT_COLOR);
    if (!created) return;
    setProjectId(created.id);
    setSelectedAreaId(null);
    setShowProjectPicker(false);
    setProjectQuery('');
    Keyboard.dismiss();
  }, [addProject, projectQuery, projects]);

  const hasExactProjectMatch = useMemo(() => {
    if (!projectQuery.trim()) return false;
    const query = projectQuery.trim().toLowerCase();
    return projects.some((project) => project.title.toLowerCase() === query);
  }, [projectQuery, projects]);

  useEffect(() => {
    if (!visible) return;
    setValue(initialValue ?? '');
    setDueDate(initialProps?.dueDate ? safeParseDate(initialProps.dueDate) : null);
    setStartTime(initialProps?.startTime ? safeParseDate(initialProps.startTime) : null);
    const initialContextTokens = Array.from(
      new Set(
        (initialProps?.contexts ?? [])
          .map((item) => normalizeContextToken(String(item || '')))
          .filter(Boolean)
      )
    );
    setContextTags(initialContextTokens);
    setProjectId(initialProps?.projectId ?? null);
    setSelectedAreaId(initialProps?.projectId ? null : (initialProps?.areaId ?? selectedAreaIdForNewTasks ?? null));
    setPriority((initialProps?.priority as TaskPriority) ?? null);
    if (autoRecord) return;
    const handle = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(handle);
  }, [autoRecord, visible, initialProps, initialValue, selectedAreaIdForNewTasks]);

  useEffect(() => {
    if (prioritiesEnabled) return;
    setPriority(null);
    setShowPriorityPicker(false);
  }, [prioritiesEnabled]);

  const buildTaskProps = useCallback(async (fallbackTitle: string, extraProps?: Partial<Task>) => {
    const trimmed = value.trim();
    let finalTitle = trimmed || fallbackTitle;
    let projectTitle: string | undefined;
    let parsedProps: Partial<Task> = {};
    let invalidDateCommands: string[] | undefined;
    let detectedDate:
      | {
          date: string;
          matchedText: string;
          titleWithoutDate: string;
        }
      | undefined;

    if (trimmed) {
      const parsed = parseQuickAdd(trimmed, projects, new Date(), areas);
      finalTitle = parsed.title || trimmed;
      parsedProps = parsed.props;
      projectTitle = parsed.projectTitle;
      invalidDateCommands = parsed.invalidDateCommands;
      detectedDate = parsed.detectedDate;
    }

    const initialPropsMerged: Partial<Task> = { status: 'inbox', ...initialProps, ...parsedProps, ...extraProps };
    if (!initialPropsMerged.status) initialPropsMerged.status = 'inbox';
    const shouldApplyDetectedDate = Boolean(detectedDate?.date && !initialPropsMerged.dueDate && !dueDate);
    if (shouldApplyDetectedDate && detectedDate) {
      initialPropsMerged.dueDate = detectedDate.date;
      finalTitle = detectedDate.titleWithoutDate;
    }

    if (!initialPropsMerged.projectId && projectTitle) {
      const created = await addProject(projectTitle, DEFAULT_PROJECT_COLOR);
      if (!created) return { title: finalTitle, props: initialPropsMerged, invalidDateCommands };
      initialPropsMerged.projectId = created.id;
    }

    if (projectId) initialPropsMerged.projectId = projectId;
    if (!initialPropsMerged.projectId && selectedAreaId) initialPropsMerged.areaId = selectedAreaId;
    if (initialPropsMerged.projectId) initialPropsMerged.areaId = undefined;
    if (contextTags.length > 0) {
      initialPropsMerged.contexts = Array.from(new Set([...(initialPropsMerged.contexts ?? []), ...contextTags]));
    }
    if (prioritiesEnabled && priority) initialPropsMerged.priority = priority;
    if (dueDate) initialPropsMerged.dueDate = dueDate.toISOString();
    if (startTime) initialPropsMerged.startTime = startTime.toISOString();

    return { title: finalTitle, props: initialPropsMerged, invalidDateCommands };
  }, [addProject, areas, contextTags, dueDate, initialProps, prioritiesEnabled, priority, projectId, projects, selectedAreaId, startTime, value]);

  const resetState = useCallback(() => {
    setValue('');
    setDueDate(null);
    setStartTime(null);
    setContextTags([]);
    setContextQuery('');
    setShowContextPicker(false);
    setProjectId(null);
    setSelectedAreaId(selectedAreaIdForNewTasks ?? null);
    setPriority(null);
    setProjectQuery('');
    setShowProjectPicker(false);
    setShowAreaPicker(false);
    setShowPriorityPicker(false);
    setShowDatePicker(false);
    setStartPickerMode(null);
    setPendingStartDate(null);
  }, [selectedAreaIdForNewTasks]);

  const finalizeClose = useCallback(() => {
    resetState();
    onClose();
  }, [onClose, resetState]);

  const {
    recording,
    recordingBusy,
    recordingReady,
    startRecording,
    stopRecording,
  } = useQuickCaptureAudio({
    addTask,
    autoRecord,
    buildTaskProps,
    handleClose: finalizeClose,
    initialAttachments: initialProps?.attachments,
    onError: logCaptureError,
    onWarn: logCaptureWarn,
    settings,
    t,
    updateSpeechSettings,
    visible,
  });

  const handleClose = useCallback(() => {
    if (recording && !recordingBusy) {
      void stopRecording({ saveTask: false });
    }
    finalizeClose();
  }, [finalizeClose, recording, recordingBusy, stopRecording]);

  const handleSave = useCallback(async () => {
    if (!value.trim()) return;
    const { title, props, invalidDateCommands } = await buildTaskProps(value.trim());
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

    await addTask(title, props);

    if (addAnother) {
      setValue('');
      setTimeout(() => inputRef.current?.focus(), 80);
      return;
    }

    finalizeClose();
  }, [addAnother, addTask, buildTaskProps, finalizeClose, showToast, t, value]);

  const selectedProject = projectId ? projects.find((project) => project.id === projectId) : null;
  const dueLabel = dueDate ? safeFormatDate(dueDate, 'P') : t('taskEdit.dueDateLabel');
  const contextLabel = contextTags.length === 0
    ? t('taskEdit.contextsLabel')
    : `${contextTags[0].replace(/^@+/, '')}${contextTags.length > 1 ? ` +${contextTags.length - 1}` : ''}`;
  const projectLabel = selectedProject ? selectedProject.title : t('taskEdit.projectLabel');
  const areaLabel = selectedAreaId
    ? areas.find((area) => area.id === selectedAreaId)?.name || t('taskEdit.noAreaOption')
    : t('taskEdit.noAreaOption');
  const priorityLabel = priority ? t(`priority.${priority}`) : t('taskEdit.priorityLabel');
  const sheetMaxHeight = Math.max(260, windowHeight - Math.max(insets.top, 12) - 8);

  const openDueDatePicker = useCallback(() => {
    inputRef.current?.blur();
    Keyboard.dismiss();
    if (Platform.OS === 'ios') {
      setTimeout(() => setShowDatePicker(true), 120);
      return;
    }
    setShowDatePicker(true);
  }, []);

  const handleDueDateChange = useCallback((event: { type: string }, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setShowDatePicker(false);
      return;
    }
    if (Platform.OS !== 'ios') {
      setShowDatePicker(false);
    }
    if (selectedDate) setDueDate(selectedDate);
  }, []);

  const handleStartTimeChange = useCallback((event: { type: string }, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setStartPickerMode(null);
      setPendingStartDate(null);
      return;
    }
    if (!selectedDate) return;
    if (Platform.OS === 'ios') {
      setStartTime(selectedDate);
      return;
    }
    if (startPickerMode === 'date') {
      const base = new Date(selectedDate);
      const existing = startTime ?? pendingStartDate;
      if (existing) {
        base.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
      }
      setPendingStartDate(base);
      setStartPickerMode('time');
      return;
    }
    const base = pendingStartDate ?? startTime ?? new Date();
    const combined = new Date(base);
    combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
    setStartTime(combined);
    setPendingStartDate(null);
    setStartPickerMode(null);
  }, [pendingStartDate, startPickerMode, startTime]);

  const handleToggleContext = useCallback((token: string) => {
    setContextTags((prev) => {
      const exists = prev.some((item) => item.toLowerCase() === token.toLowerCase());
      if (exists) {
        return prev.filter((item) => item.toLowerCase() !== token.toLowerCase());
      }
      return [...prev, token];
    });
    setContextQuery('');
  }, []);

  const handleRemoveContext = useCallback((token: string) => {
    setContextTags((prev) => prev.filter((item) => item.toLowerCase() !== token.toLowerCase()));
  }, []);

  const handleClearContexts = useCallback(() => {
    setContextTags([]);
    setContextQuery('');
  }, []);

  const handleSelectArea = useCallback((areaId: string | null) => {
    setSelectedAreaId(areaId);
    if (areaId) {
      setProjectId(null);
    }
    setShowAreaPicker(false);
  }, []);

  const handleSelectProject = useCallback((nextProjectId: string | null) => {
    setProjectId(nextProjectId);
    if (nextProjectId) {
      setSelectedAreaId(null);
    }
    setShowProjectPicker(false);
  }, []);

  const handleSelectPriority = useCallback((nextPriority: TaskPriority | null) => {
    setPriority(nextPriority);
    setShowPriorityPicker(false);
  }, []);

  const handleToggleRecording = useCallback(() => {
    if (recording) {
      void stopRecording({ saveTask: true });
      return;
    }
    void startRecording();
  }, [recording, startRecording, stopRecording]);

  return (
    <>
      <QuickCaptureSheetBody
        addAnother={addAnother}
        areaLabel={areaLabel}
        contextLabel={contextLabel}
        dueLabel={dueLabel}
        handleClose={handleClose}
        handleSave={() => {
          void handleSave();
        }}
        insetsBottom={insets.bottom}
        inputRef={inputRef}
        onOpenAreaPicker={() => setShowAreaPicker(true)}
        onOpenContextPicker={() => setShowContextPicker(true)}
        onOpenDueDatePicker={openDueDatePicker}
        onOpenPriorityPicker={() => setShowPriorityPicker(true)}
        onOpenProjectPicker={() => setShowProjectPicker(true)}
        onResetArea={() => setSelectedAreaId(null)}
        onResetContexts={handleClearContexts}
        onResetDueDate={() => setDueDate(null)}
        onResetPriority={() => setPriority(null)}
        onResetProject={() => {
          setProjectId(null);
          setSelectedAreaId(selectedAreaIdForNewTasks ?? null);
        }}
        onToggleAddAnother={setAddAnother}
        onToggleRecording={handleToggleRecording}
        onValueChange={setValue}
        prioritiesEnabled={prioritiesEnabled}
        priorityLabel={priorityLabel}
        projectLabel={projectLabel}
        recording={Boolean(recording)}
        recordingBusy={recordingBusy}
        recordingReady={recordingReady}
        sheetMaxHeight={sheetMaxHeight}
        t={t}
        tc={tc}
        value={value}
        visible={visible}
      />
      <QuickCaptureSheetPickers
        areas={areas}
        contextInputRef={contextInputRef}
        contextQuery={contextQuery}
        contextTags={contextTags}
        dueDate={dueDate}
        filteredContexts={filteredContexts}
        filteredProjects={filteredProjects}
        hasAddableContextTokens={hasAddableContextTokens}
        hasExactProjectMatch={hasExactProjectMatch}
        onAddContextFromQuery={addContextFromQuery}
        onClearContexts={handleClearContexts}
        onCloseAreaPicker={() => setShowAreaPicker(false)}
        onCloseContextPicker={() => setShowContextPicker(false)}
        onClosePriorityPicker={() => setShowPriorityPicker(false)}
        onCloseProjectPicker={() => setShowProjectPicker(false)}
        onContextQueryChange={setContextQuery}
        onDueDateChange={handleDueDateChange}
        onProjectQueryChange={setProjectQuery}
        onRemoveContext={handleRemoveContext}
        onSelectArea={handleSelectArea}
        onSelectContext={handleToggleContext}
        onSelectPriority={handleSelectPriority}
        onSelectProject={handleSelectProject}
        onStartTimeChange={handleStartTimeChange}
        onSubmitContextQuery={handleContextSubmit}
        onSubmitProjectQuery={() => {
          void submitProjectQuery();
        }}
        pendingStartDate={pendingStartDate}
        prioritiesEnabled={prioritiesEnabled}
        priorityOptions={PRIORITY_OPTIONS}
        projectQuery={projectQuery}
        selectedAreaId={selectedAreaId}
        selectedPriority={priority}
        showAreaPicker={showAreaPicker}
        showContextPicker={showContextPicker}
        showDatePicker={showDatePicker}
        showPriorityPicker={showPriorityPicker}
        showProjectPicker={showProjectPicker}
        startPickerMode={startPickerMode}
        startTime={startTime}
        t={t}
        tc={tc}
      />
    </>
  );
}
