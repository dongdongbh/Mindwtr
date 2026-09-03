import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

import {
  CaptureSessionCoordinator,
  executeCaptureTransaction,
  prepareCaptureTask,
  filterCaptureAreas,
  filterCaptureProjects,
  hasExactCaptureAreaMatch,
  hasExactCaptureProjectMatch,
  resolveCaptureAreaQuery,
  resolveCaptureProjectQuery,
  buildQuickAddParseOptions,
  buildQuickAddPreviewEntries,
  canStarNewCapture,
  formatFocusTaskLimitText,
  getDefaultTaskAreaMode,
  getUsedTaskTokens,
  hasTimeComponent,
  isSelectableProjectForTaskAssignment,
  parseQuickAdd,
  normalizeFocusTaskLimit,
  resolveDefaultNewTaskAreaId,
  resolveFeatureFlags,
  safeFormatDate,
  safeParseDate,
  shallow,
  splitQuickAddBulkLines,
  tFallback,
  type CaptureAssemblyInput,
  type CaptureSessionId,
  type CaptureTransactionOptions,
  type Task,
  type TaskPriority,
  useTaskStore,
} from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { readQuickCaptureAddAnother, writeQuickCaptureAddAnother } from '../lib/quick-capture-preferences';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useThemeTokens } from '@/hooks/use-theme-tokens';
import { useToast } from '@/contexts/toast-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAndroidKeyboardInset, useKeyboardInset } from '../lib/use-android-keyboard-inset';
import { logError, logWarn } from '../lib/app-log';
import { showInvalidDateCommandToast } from '@/lib/quick-add-toast';
import { createMobileRecoverySnapshot } from '../lib/recovery-snapshot';
import { openTaskScreen } from '@/lib/task-meta-navigation';
import {
  buildCaptureExtra,
  normalizeContextToken,
  parseContextQueryTokens,
} from './quick-capture-sheet.utils';
import { styles } from './quick-capture-sheet/quick-capture-sheet.styles';
import { QuickAddPreview } from './QuickAddPreview';
import { QuickCaptureSheetBody } from './quick-capture-sheet/QuickCaptureSheetBody';
import { QuickCaptureSheetPickers } from './quick-capture-sheet/QuickCaptureSheetPickers';
import { useQuickCaptureAudio } from './use-quick-capture-audio';
import { useAndroidQuickCaptureExpand } from './quick-capture-sheet/useAndroidQuickCaptureExpand';

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ANDROID_OPTIONS_EXPAND_FALLBACK_MS = 500;
const BULK_PREVIEW_LINE_LIMIT = 5;

const logCaptureWarn = (message: string, error?: unknown) => {
  void logWarn(message, { scope: 'capture', extra: buildCaptureExtra(undefined, error) });
};

const logCaptureError = (message: string, error?: unknown) => {
  const err = error instanceof Error ? error : new Error(message);
  void logError(err, { scope: 'capture', extra: buildCaptureExtra(message, error) });
};

// Settings come off the store too, so refreshing takes no component state and
// cannot re-identify the callbacks that call it.
const readQuickAddParseOptions = () => {
  const state = useTaskStore.getState();
  return buildQuickAddParseOptions(state.settings, state);
};

const resolveInitialContextTokens = (contexts?: string[]): string[] => (
  Array.from(
    new Set(
      (contexts ?? [])
        .map((item) => normalizeContextToken(String(item || '')))
        .filter(Boolean)
    )
  )
);

// Rendered in the sheet's own overlay layer, alongside the pickers, so the
// confirm is plain React inside the already-presented modal rather than a
// second native presentation stacked on top of it (#940).
function BulkQuickAddConfirm({
  cancelLabel,
  confirmLabel,
  message,
  onCancel,
  onConfirm,
  tc,
  title,
}: {
  cancelLabel: string;
  confirmLabel: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  tc: { border: string; cardBg: string; secondaryText: string; text: string; tint: string };
  title: string;
}) {
  return (
    <View
      style={styles.overlay}
      accessibilityViewIsModal
      importantForAccessibility="yes"
    >
      <Pressable
        style={styles.overlayBackdrop}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={cancelLabel}
      />
      <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
        <Text style={[styles.pickerTitle, { color: tc.text }]} accessibilityRole="header">{title}</Text>
        <Text style={[styles.bulkConfirmMessage, { color: tc.secondaryText }]}>{message}</Text>
        <View style={styles.bulkConfirmActions}>
          <TouchableOpacity onPress={onCancel} style={styles.bulkConfirmButton} accessibilityRole="button">
            <Text style={[styles.pickerRowText, { color: tc.secondaryText }]}>{cancelLabel}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onConfirm} style={styles.bulkConfirmButton} accessibilityRole="button">
            <Text style={[styles.pickerRowText, { color: tc.tint }]}>{confirmLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

export function QuickCaptureSheet({
  visible,
  openRequestId,
  onClose,
  initialProps,
  initialValue,
  autoRecord,
}: {
  visible: boolean;
  openRequestId?: number;
  onClose: () => void;
  initialProps?: Partial<Task>;
  initialValue?: string;
  autoRecord?: boolean;
}) {
  const { addTask, addTasks, addProject, addArea, updateSettings, projects, settings, areas, getFocusedCount, setHighlightTask } = useTaskStore((state) => ({
    addTask: state.addTask,
    addTasks: state.addTasks,
    addProject: state.addProject,
    addArea: state.addArea,
    updateSettings: state.updateSettings,
    projects: state.projects,
    settings: state.settings,
    areas: state.areas,
    getFocusedCount: state.getFocusedCount,
    setHighlightTask: state.setHighlightTask,
  }), shallow);
  const { t } = useLanguage();
  const tc = useThemeColors();
  const tokens = useThemeTokens();
  // Two-tier M3 emphasis: the capture FAB owns the high-emphasis `primary` role
  // (see tab _layout.tsx); secondary primary actions like Save sit one step below
  // it on the canonical `primaryContainer`, preserving the action hierarchy.
  const saveButtonBackgroundColor = tokens.isMaterial && tokens.roles
    ? tokens.roles.primaryContainer
    : tc.tint;
  const saveButtonTextColor = tokens.isMaterial && tokens.roles
    ? tokens.roles.onPrimaryContainer
    : tc.onTint;
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const inputRef = useRef<TextInput>(null);
  const contextInputRef = useRef<TextInput>(null);
  const submissionCoordinatorRef = useRef(new CaptureSessionCoordinator());
  const activeSubmissionSessionRef = useRef<CaptureSessionId | null>(null);
  const { priorities: prioritiesEnabled } = resolveFeatureFlags(settings);
  const { selectedAreaIdForNewTasks } = useMobileAreaFilter();
  const defaultAreaMode = getDefaultTaskAreaMode(settings);
  const defaultAreaId = defaultAreaMode === 'active'
    ? selectedAreaIdForNewTasks ?? null
    : resolveDefaultNewTaskAreaId(settings, areas) ?? null;

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
  const [saving, setSaving] = useState(false);
  // Refreshed by resetDraftState — which runs on open AND after each capture in
  // an "Add another" burst, so a context/tag/person created by one capture is
  // known to the next one's parse. Not subscribed and not rebuilt per render:
  // the bag is an O(tasks) scan and this sheet stays mounted for the whole
  // session (see loadContextOptions). The preview and the save read this one
  // object, so they cannot disagree. A background sync landing mid-draft leaves
  // it one capture stale — accepted, to keep the scan off the keystroke path.
  const [quickAddParseOptions, setQuickAddParseOptions] = useState(readQuickAddParseOptions);
  // Note (task description) captured from the expanded More panel (#1118).
  const [noteValue, setNoteValue] = useState('');
  const [pendingBulkLines, setPendingBulkLines] = useState<string[] | null>(null);
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [dueDateHasTime, setDueDateHasTime] = useState(false);
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showDueTimePicker, setShowDueTimePicker] = useState(false);
  const [startPickerMode, setStartPickerMode] = useState<'date' | 'time' | null>(null);
  const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
  const [contextTags, setContextTags] = useState<string[]>([]);
  const [contextOptions, setContextOptions] = useState<string[]>([]);
  const [contextOptionsLoading, setContextOptionsLoading] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextQuery, setContextQuery] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [areaQuery, setAreaQuery] = useState('');
  const [priority, setPriority] = useState<TaskPriority | null>(null);
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [androidKeyboardAvoidingEnabled, setAndroidKeyboardAvoidingEnabled] = useState(true);
  const androidKeyboardInset = useAndroidKeyboardInset(visible);
  // The picker overlays render outside the KeyboardAvoidingView, so iOS needs
  // the measured inset too — only the sheet body is keyboard-avoided (#891).
  const overlayKeyboardInset = useKeyboardInset(visible);
  const [addAnother, setAddAnother] = useState(false);
  const [focusNewTask, setFocusNewTask] = useState(false);
  const projectsRef = useRef(projects);
  const contextOptionsLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextOptionsRequestRef = useRef(0);
  const initialFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
  const canFocusNewTask = focusNewTask || canStarNewCapture({ focusedCount: getFocusedCount(), focusTaskLimit });
  const focusNewTaskDisabledReason = formatFocusTaskLimitText(
    tFallback(t, 'agenda.maxFocusItems', 'Max {{count}} focus item(s)'),
    focusTaskLimit,
  );

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const filteredProjects = useMemo(() => (
    showProjectPicker
      ? filterCaptureProjects(projects, { selectedAreaId, query: projectQuery })
      : []
  ), [projectQuery, projects, selectedAreaId, showProjectPicker]);

  const clearContextOptionsLoad = useCallback(() => {
    if (!contextOptionsLoadTimerRef.current) return;
    clearTimeout(contextOptionsLoadTimerRef.current);
    contextOptionsLoadTimerRef.current = null;
  }, []);

  const clearInitialFocusTimer = useCallback(() => {
    if (!initialFocusTimerRef.current) return;
    clearTimeout(initialFocusTimerRef.current);
    initialFocusTimerRef.current = null;
  }, []);

  const {
    clearAndroidOptionsExpand,
    collapseAndroidOptions,
    requestAndroidOptionsExpand,
  } = useAndroidQuickCaptureExpand({
    clearInitialFocusTimer,
    fallbackMs: ANDROID_OPTIONS_EXPAND_FALLBACK_MS,
    inputRef,
    setKeyboardAvoidingEnabled: setAndroidKeyboardAvoidingEnabled,
    setOptionsExpanded,
  });

  const loadContextOptions = useCallback(() => {
    clearContextOptionsLoad();
    const requestId = contextOptionsRequestRef.current + 1;
    contextOptionsRequestRef.current = requestId;
    setContextOptionsLoading(true);
    contextOptionsLoadTimerRef.current = setTimeout(() => {
      contextOptionsLoadTimerRef.current = null;
      try {
        const currentTasks = useTaskStore.getState().tasks;
        const nextOptions = Array.from(
          new Set(
            [...getUsedTaskTokens(currentTasks, (task) => task.contexts, { prefix: '@' }), ...resolveInitialContextTokens(initialProps?.contexts)]
              .map((item) => normalizeContextToken(String(item || '')))
              .filter(Boolean)
          )
        );
        if (contextOptionsRequestRef.current === requestId) {
          setContextOptions(nextOptions);
        }
      } catch (error) {
        logCaptureWarn('Failed to load quick capture context suggestions', error);
      } finally {
        if (contextOptionsRequestRef.current === requestId) {
          setContextOptionsLoading(false);
        }
      }
    }, 0);
  }, [clearContextOptionsLoad, initialProps?.contexts]);

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
    const resolution = resolveCaptureProjectQuery(projects, projectQuery, selectedAreaId);
    if (resolution.kind === 'empty') return;
    let nextProjectId: string | null = null;
    if (resolution.kind === 'select') {
      nextProjectId = resolution.project.id;
    } else {
      const created = await addProject(
        resolution.projectToCreate.title,
        resolution.projectToCreate.color,
        resolution.projectToCreate.initialProps,
      );
      if (!created) return;
      nextProjectId = created.id;
    }
    setProjectId(nextProjectId);
    setSelectedAreaId(null);
    setShowProjectPicker(false);
    setProjectQuery('');
    Keyboard.dismiss();
  }, [addProject, projectQuery, projects, selectedAreaId]);

  const submitAreaQuery = useCallback(async () => {
    const resolution = resolveCaptureAreaQuery(areas, areaQuery);
    if (resolution.kind === 'empty') return;
    let nextAreaId: string | null = null;
    if (resolution.kind === 'select') {
      nextAreaId = resolution.area.id;
    } else {
      const created = await addArea(resolution.areaToCreate.name, { color: resolution.areaToCreate.color });
      if (!created) return;
      nextAreaId = created.id;
    }
    setSelectedAreaId(nextAreaId);
    setProjectId(null);
    setShowAreaPicker(false);
    setAreaQuery('');
    Keyboard.dismiss();
  }, [addArea, areaQuery, areas]);

  const hasExactProjectMatch = useMemo(() => (
    showProjectPicker && hasExactCaptureProjectMatch(projects, projectQuery)
  ), [projectQuery, projects, showProjectPicker]);

  const filteredAreas = useMemo(() => (
    showAreaPicker ? filterCaptureAreas(areas, areaQuery) : []
  ), [areaQuery, areas, showAreaPicker]);

  const hasExactAreaMatch = useMemo(() => (
    showAreaPicker && hasExactCaptureAreaMatch(areas, areaQuery)
  ), [areaQuery, areas, showAreaPicker]);

  const resetDraftState = useCallback((options?: { keepAddAnother?: boolean; value?: string }) => {
    clearAndroidOptionsExpand();
    setQuickAddParseOptions(readQuickAddParseOptions());
    setValue(options?.value ?? initialValue ?? '');
    setNoteValue(initialProps?.description ?? '');
    setDueDate(initialProps?.dueDate ? safeParseDate(initialProps.dueDate) : null);
    setDueDateHasTime(Boolean(initialProps?.dueDate && hasTimeComponent(initialProps.dueDate)));
    setStartTime(initialProps?.startTime ? safeParseDate(initialProps.startTime) : null);
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
    const initialContextTokens = resolveInitialContextTokens(initialProps?.contexts);
    setContextTags(initialContextTokens);
    setContextOptions(initialContextTokens);
    setContextOptionsLoading(false);
    setContextQuery('');
    setShowContextPicker(false);
    const currentProjects = projectsRef.current;
    const initialProjectId = initialProps?.projectId && currentProjects.some((project) => (
      project.id === initialProps.projectId && isSelectableProjectForTaskAssignment(project)
    ))
      ? initialProps.projectId
      : null;
    setProjectId(initialProjectId);
    setSelectedAreaId(initialProjectId ? null : (initialProps?.areaId ?? defaultAreaId));
    setProjectQuery('');
    setShowProjectPicker(false);
    setShowAreaPicker(false);
    setAreaQuery('');
    setPriority((initialProps?.priority as TaskPriority) ?? null);
    setShowPriorityPicker(false);
    setOptionsExpanded(false);
    setAndroidKeyboardAvoidingEnabled(true);
    setShowDatePicker(false);
    setShowDueTimePicker(false);
    setStartPickerMode(null);
    setPendingStartDate(null);
    setFocusNewTask(Boolean(initialProps?.isFocusedToday));
    setAddAnother(Boolean(options?.keepAddAnother));
  }, [clearAndroidOptionsExpand, clearContextOptionsLoad, defaultAreaId, initialProps, initialValue]);

  useEffect(() => () => {
    const session = activeSubmissionSessionRef.current;
    if (session !== null) submissionCoordinatorRef.current.invalidateSession(session);
    activeSubmissionSessionRef.current = null;
    clearAndroidOptionsExpand();
    clearInitialFocusTimer();
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
  }, [clearAndroidOptionsExpand, clearContextOptionsLoad, clearInitialFocusTimer]);

  useEffect(() => {
    if (!visible) {
      const session = activeSubmissionSessionRef.current;
      if (session !== null) submissionCoordinatorRef.current.invalidateSession(session);
      activeSubmissionSessionRef.current = null;
      setSaving(false);
      return;
    }
    activeSubmissionSessionRef.current = submissionCoordinatorRef.current.beginSession();
    setSaving(false);
  }, [openRequestId, visible]);

  useEffect(() => {
    if (!visible) return;
    resetDraftState();
    // The "Add another" switch is a sticky device preference: capture bursts
    // (Enter chains into the next task) should survive closing the sheet
    // instead of resetting to one-shot mode every open (#819).
    void readQuickCaptureAddAnother().then((stored) => {
      if (stored) setAddAnother(true);
    });
    if (autoRecord) return;
    clearInitialFocusTimer();
    initialFocusTimerRef.current = setTimeout(() => {
      initialFocusTimerRef.current = null;
      inputRef.current?.focus();
    }, 120);
    return clearInitialFocusTimer;
  }, [autoRecord, clearInitialFocusTimer, openRequestId, resetDraftState, visible]);

  useEffect(() => {
    if (prioritiesEnabled) return;
    setPriority(null);
    setShowPriorityPicker(false);
  }, [prioritiesEnabled]);

  // The one expression both the preview and transformProps read, so the strip
  // cannot promise a due date the save would replace.
  const pickedDueDate = useMemo(() => {
    if (!dueDate) return undefined;
    const dateOnly = safeFormatDate(dueDate, 'yyyy-MM-dd');
    if (!dateOnly) return undefined;
    return dueDateHasTime ? dueDate.toISOString() : dateOnly;
  }, [dueDate, dueDateHasTime]);

  // Everything the sheet's own pickers force onto the saved task.
  const previewOverrides = useMemo(() => ({
    projectId: projectId || undefined,
    dueDate: pickedDueDate,
    startTime: startTime ? startTime.toISOString() : undefined,
  }), [pickedDueDate, projectId, startTime]);

  // A due date picked in the sheet outranks a trailing natural-language date
  // (see buildCaptureTaskProps).
  const suppressDetectedDate = Boolean(pickedDueDate);
  const previewEntries = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return buildQuickAddPreviewEntries(
      parseQuickAdd(trimmed, projects, new Date(), areas, quickAddParseOptions),
      { t, projects, areas, rawInput: trimmed, overrides: previewOverrides },
    );
  }, [areas, previewOverrides, projects, quickAddParseOptions, t, value]);

  const buildCaptureRequestForInput = useCallback((
    inputValue: string,
    fallbackTitle: string,
    extraProps?: Partial<Task>,
    currentProjects = projects,
  ): { input: CaptureAssemblyInput; options: CaptureTransactionOptions } => {
    const trimmed = inputValue.trim();
    const parsed = trimmed
      ? parseQuickAdd(trimmed, currentProjects, new Date(), areas, quickAddParseOptions)
      : { title: '', props: {}, projectTitle: undefined, detectedDate: undefined, invalidDateCommands: undefined };

    const input: CaptureAssemblyInput = {
      parsed,
      rawInput: trimmed,
      fallbackTitle,
      projects: currentProjects,
      initialProps,
      extraProps,
      selectedAreaId,
      starNewTask: focusNewTask && canFocusNewTask,
      suppressDetectedDate,
    };
    const options: CaptureTransactionOptions = {
      transformProps: (props) => {
        const taskProps = { ...props };
        // The typed field leads; a /note: token in the title is kept after it
        // (identical merge to app/capture-modal.tsx, so the two capture
        // surfaces cannot disagree about which note wins).
        const note = noteValue.trim();
        if (note) {
          const parsedNote = typeof taskProps.description === 'string' ? taskProps.description.trim() : '';
          taskProps.description = parsedNote && parsedNote !== note ? `${note}\n${parsedNote}` : note;
        }
        if (projectId) taskProps.projectId = projectId;
        if (contextTags.length > 0) {
          taskProps.contexts = Array.from(new Set([...(taskProps.contexts ?? []), ...contextTags]));
        }
        if (prioritiesEnabled && priority) taskProps.priority = priority;
        if (pickedDueDate) taskProps.dueDate = pickedDueDate;
        if (startTime) taskProps.startTime = startTime.toISOString();
        return taskProps;
      },
    };
    return { input, options };
  }, [areas, canFocusNewTask, contextTags, focusNewTask, initialProps, noteValue, pickedDueDate, prioritiesEnabled, priority, projectId, projects, quickAddParseOptions, selectedAreaId, startTime, suppressDetectedDate]);

  const buildTaskPropsForInput = useCallback(async (inputValue: string, fallbackTitle: string, extraProps?: Partial<Task>) => {
    const request = buildCaptureRequestForInput(inputValue, fallbackTitle, extraProps);
    const prepared = await prepareCaptureTask(request.input, { addProject }, request.options);
    if (!prepared.success) {
      return {
        title: '',
        props: { status: 'inbox' as const, ...initialProps, ...extraProps },
        invalidDateCommands: prepared.reason === 'invalid-date-command'
          ? prepared.invalidDateCommands
          : undefined,
      };
    }
    return {
      title: prepared.title,
      props: prepared.props,
      invalidDateCommands: prepared.invalidDateCommands,
    };
  }, [addProject, buildCaptureRequestForInput, initialProps]);

  const buildTaskProps = useCallback((fallbackTitle: string, extraProps?: Partial<Task>) => (
    buildTaskPropsForInput(value, fallbackTitle, extraProps)
  ), [buildTaskPropsForInput, value]);

  const resetState = useCallback(() => {
    clearAndroidOptionsExpand();
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
    setValue('');
    setNoteValue('');
    setDueDate(null);
    setDueDateHasTime(false);
    setStartTime(null);
    setContextTags([]);
    setContextOptions([]);
    setContextOptionsLoading(false);
    setContextQuery('');
    setShowContextPicker(false);
    setProjectId(null);
    setSelectedAreaId(defaultAreaId);
    setPriority(null);
    setProjectQuery('');
    setShowProjectPicker(false);
    setShowAreaPicker(false);
    setAreaQuery('');
    setShowPriorityPicker(false);
    setOptionsExpanded(false);
    setAndroidKeyboardAvoidingEnabled(true);
    setShowDatePicker(false);
    setShowDueTimePicker(false);
    setStartPickerMode(null);
    setPendingStartDate(null);
    setAddAnother(false);
    setFocusNewTask(false);
  }, [clearAndroidOptionsExpand, clearContextOptionsLoad, defaultAreaId]);

  const finalizeClose = useCallback(() => {
    const session = activeSubmissionSessionRef.current;
    if (session !== null) submissionCoordinatorRef.current.invalidateSession(session);
    activeSubmissionSessionRef.current = null;
    setSaving(false);
    clearInitialFocusTimer();
    resetState();
    onClose();
  }, [clearInitialFocusTimer, onClose, resetState]);

  const getActiveSubmissionSession = useCallback(
    () => activeSubmissionSessionRef.current,
    [],
  );

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
    getActiveSubmissionSession,
    handleClose: finalizeClose,
    initialAttachments: initialProps?.attachments,
    onError: logCaptureError,
    onSubmissionBusyChange: setSaving,
    onWarn: logCaptureWarn,
    settings,
    submissionCoordinator: submissionCoordinatorRef.current,
    submissionKey: openRequestId,
    t,
    updateSpeechSettings,
    visible,
  });

  const handleClose = useCallback(() => {
    const session = activeSubmissionSessionRef.current;
    if (session !== null && submissionCoordinatorRef.current.isSubmitting(session)) return;
    if (recording && !recordingBusy) {
      void stopRecording({ saveTask: false });
    }
    finalizeClose();
  }, [finalizeClose, recording, recordingBusy, stopRecording]);

  const formatBulkConfirmTitle = useCallback((count: number) => (
    tFallback(t, 'quickAdd.bulkConfirmTitle', 'Create {{count}} tasks?')
      .replace('{{count}}', String(count))
  ), [t]);

  const formatBulkConfirmMessage = useCallback((lines: string[]) => {
    const preview = lines.slice(0, BULK_PREVIEW_LINE_LIMIT).join('\n');
    const remaining = Math.max(0, lines.length - BULK_PREVIEW_LINE_LIMIT);
    const suffix = remaining > 0
      ? `\n${tFallback(t, 'quickAdd.bulkMoreLines', '+{{count}} more').replace('{{count}}', String(remaining))}`
      : '';
    return `${preview}${suffix}`;
  }, [t]);

  const createTaskFromInput = useCallback(async (inputValue: string) => {
    const request = buildCaptureRequestForInput(inputValue, inputValue.trim());
    const result = await executeCaptureTransaction(
      request.input,
      { addProject, addTask },
      request.options,
    );
    if (!result.success && result.reason === 'invalid-date-command') {
      showInvalidDateCommandToast(showToast, t, result.invalidDateCommands);
      return null;
    }
    if (!result.success) return null;
    return {
      createdTaskId: result.createdTaskId ?? null,
      props: result.props,
    };
  }, [addProject, addTask, buildCaptureRequestForInput, showToast, t]);

  const createBulkTasks = useCallback(async (lines: string[]) => {
    const session = activeSubmissionSessionRef.current;
    if (session === null || !submissionCoordinatorRef.current.tryBeginSubmission(session)) return;
    setSaving(true);
    try {
      try {
        await createMobileRecoverySnapshot();
      } catch (error) {
        logCaptureError('Failed to create a recovery snapshot before bulk capture', error);
        showToast({
          title: t('common.notice'),
          message: tFallback(t, 'quickAdd.bulkCreateError', 'Could not create all tasks.'),
          tone: 'warning',
          durationMs: 4200,
        });
        return;
      }
      if (!submissionCoordinatorRef.current.isCurrent(session)) return;
      const taskInputs: Array<{ title: string; initialProps: Partial<Task> }> = [];
      let currentProjects = projects;
      for (const line of lines) {
        const request = buildCaptureRequestForInput(line, line.trim(), undefined, currentProjects);
        const prepared = await prepareCaptureTask(request.input, { addProject }, request.options);
        if (!submissionCoordinatorRef.current.isCurrent(session)) return;
        if (!prepared.success && prepared.reason === 'invalid-date-command') {
          showInvalidDateCommandToast(showToast, t, prepared.invalidDateCommands);
          return;
        }
        if (!prepared.success) return;
        taskInputs.push({ title: prepared.title, initialProps: prepared.props });
        if (prepared.createdProject) currentProjects = [...currentProjects, prepared.createdProject];
      }
      const result = await addTasks(taskInputs);
      if (!submissionCoordinatorRef.current.isCurrent(session)) return;
      if (result && typeof result === 'object' && result.success === false) return;
      finalizeClose();
    } finally {
      if (submissionCoordinatorRef.current.finishSubmission(session)) {
        setSaving(false);
      }
    }
  }, [addProject, addTasks, buildCaptureRequestForInput, finalizeClose, projects, showToast, t]);

  // Confirm inside this sheet rather than through Alert. The sheet is a native
  // Modal, and an alert raised while it is presented is a second native
  // presentation stacked on the first — on iOS the confirm never became
  // visible, so a .txt import looked like it silently did nothing (#940).
  // Rendering it in the sheet's own overlay layer, next to the pickers, removes
  // the second presentation entirely instead of trying to time around it.
  const confirmBulkQuickAdd = useCallback((lines: string[]) => {
    setPendingBulkLines(lines);
  }, []);

  const cancelBulkQuickAdd = useCallback(() => {
    setPendingBulkLines(null);
  }, []);

  const acceptBulkQuickAdd = useCallback(() => {
    const lines = pendingBulkLines;
    setPendingBulkLines(null);
    if (lines && lines.length > 0) void createBulkTasks(lines);
  }, [createBulkTasks, pendingBulkLines]);

  const handleSave = useCallback(async ({ openAfterSave = false }: { openAfterSave?: boolean } = {}) => {
    if (!value.trim()) return;
    const bulkLines = splitQuickAddBulkLines(value);
    if (bulkLines.length > 1) {
      confirmBulkQuickAdd(bulkLines);
      return;
    }
    const session = activeSubmissionSessionRef.current;
    if (session === null || !submissionCoordinatorRef.current.tryBeginSubmission(session)) return;
    setSaving(true);
    try {
      const result = await createTaskFromInput(value.trim());
      if (!submissionCoordinatorRef.current.isCurrent(session) || !result) return;

      if (openAfterSave) {
        finalizeClose();
        if (result.createdTaskId) {
          openTaskScreen(result.createdTaskId, result.props.projectId, 'task');
        }
        return;
      }

      if (addAnother) {
        resetDraftState({ keepAddAnother: true, value: '' });
        setTimeout(() => inputRef.current?.focus(), 80);
        return;
      }

      // Project/section-preset capture (opened from ProjectDetailModal's add
      // button): flash + scroll the new row in the project list once the sheet
      // closes. Global captures with no project preset skip this, and "Add
      // another" bursts never highlight mid-typing under the open sheet — only
      // this final close does (#916).
      if (initialProps?.projectId && result.createdTaskId) {
        setHighlightTask(result.createdTaskId);
      }

      finalizeClose();
    } finally {
      if (submissionCoordinatorRef.current.finishSubmission(session)) {
        setSaving(false);
      }
    }
  }, [addAnother, confirmBulkQuickAdd, createTaskFromInput, finalizeClose, initialProps?.projectId, resetDraftState, setHighlightTask, value]);

  const selectedProject = projectId ? projects.find((project) => project.id === projectId) : null;
  const dueLabel = dueDate ? safeFormatDate(dueDate, dueDateHasTime ? 'Pp' : 'P') : t('taskEdit.dueDateLabel');
  const dueTimeLabel = dueDate && dueDateHasTime ? safeFormatDate(dueDate, 'p') : t('calendar.changeTime');
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
    setShowDueTimePicker(false);
    if (Platform.OS === 'ios') {
      setTimeout(() => setShowDatePicker(true), 120);
      return;
    }
    setShowDatePicker(true);
  }, []);

  const openDueTimePicker = useCallback(() => {
    if (!dueDate) return;
    inputRef.current?.blur();
    Keyboard.dismiss();
    setShowDatePicker(false);
    if (Platform.OS === 'ios') {
      setTimeout(() => setShowDueTimePicker(true), 120);
      return;
    }
    setShowDueTimePicker(true);
  }, [dueDate]);

  const handleDueDateChange = useCallback((event: { type: string }, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setShowDatePicker(false);
      return;
    }
    if (Platform.OS !== 'ios') {
      setShowDatePicker(false);
    }
    if (selectedDate) {
      const next = new Date(selectedDate);
      if (dueDateHasTime && dueDate) {
        next.setHours(dueDate.getHours(), dueDate.getMinutes(), 0, 0);
      } else {
        next.setHours(0, 0, 0, 0);
      }
      setDueDate(next);
    }
  }, [dueDate, dueDateHasTime]);

  const handleDueTimeChange = useCallback((event: { type: string }, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setShowDueTimePicker(false);
      return;
    }
    if (!selectedDate) return;
    if (Platform.OS !== 'ios') {
      setShowDueTimePicker(false);
    }
    const base = dueDate ?? new Date();
    const combined = new Date(base);
    combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
    setDueDate(combined);
    setDueDateHasTime(true);
  }, [dueDate]);

  const resetDueDate = useCallback(() => {
    setDueDate(null);
    setDueDateHasTime(false);
    setShowDatePicker(false);
    setShowDueTimePicker(false);
  }, []);

  const resetDueTime = useCallback(() => {
    setDueDateHasTime(false);
    setShowDueTimePicker(false);
    setDueDate((prev) => {
      if (!prev) return prev;
      const next = new Date(prev);
      next.setHours(0, 0, 0, 0);
      return next;
    });
  }, []);

  const handleQuickDueDateSelect = useCallback((date: Date | null) => {
    if (!date) {
      resetDueDate();
      return;
    }
    const next = new Date(date);
    if (dueDateHasTime && dueDate) {
      next.setHours(dueDate.getHours(), dueDate.getMinutes(), 0, 0);
    } else {
      next.setHours(0, 0, 0, 0);
    }
    setDueDate(next);
    setShowDatePicker(false);
    setShowDueTimePicker(false);
  }, [dueDate, dueDateHasTime, resetDueDate]);

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
    setAreaQuery('');
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

  const handleToggleOptions = useCallback(() => {
    clearAndroidOptionsExpand();
    if (!optionsExpanded) {
      clearInitialFocusTimer();
      if (Platform.OS === 'android') {
        requestAndroidOptionsExpand();
        return;
      }
      inputRef.current?.blur();
      Keyboard.dismiss();
    } else if (Platform.OS === 'android') {
      collapseAndroidOptions();
      return;
    }
    setOptionsExpanded((prev) => !prev);
  }, [clearAndroidOptionsExpand, clearInitialFocusTimer, collapseAndroidOptions, optionsExpanded, requestAndroidOptionsExpand]);

  const openContextPicker = useCallback(() => {
    setShowContextPicker(true);
    loadContextOptions();
  }, [loadContextOptions]);

  const closeContextPicker = useCallback(() => {
    setShowContextPicker(false);
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
    setContextOptionsLoading(false);
  }, [clearContextOptionsLoad]);

  const handleImportTextFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: 'text/plain',
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) return;
      const text = await FileSystem.readAsStringAsync(asset.uri);
      const lines = splitQuickAddBulkLines(text);
      if (lines.length > 1) {
        confirmBulkQuickAdd(lines);
      } else if (lines.length === 1) {
        setValue(lines[0]);
      }
    } catch (error) {
      logCaptureError('Failed to import quick capture text file', error);
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'quickAdd.bulkImportError', 'Could not read that text file.'),
        tone: 'warning',
        durationMs: 4200,
      });
    }
  }, [confirmBulkQuickAdd, showToast, t]);

  const pickerProps = {
    areaQuery,
    filteredAreas,
    contextInputRef,
    contextOptionsLoading,
    contextQuery,
    contextTags,
    dueDate,
    filteredContexts,
    filteredProjects,
    hasAddableContextTokens,
    hasExactAreaMatch,
    hasExactProjectMatch,
    onAddContextFromQuery: addContextFromQuery,
    onAreaQueryChange: setAreaQuery,
    onClearContexts: handleClearContexts,
    onCloseAreaPicker: () => {
      setShowAreaPicker(false);
      setAreaQuery('');
    },
    onCloseContextPicker: closeContextPicker,
    onClosePriorityPicker: () => setShowPriorityPicker(false),
    onCloseProjectPicker: () => setShowProjectPicker(false),
    onContextQueryChange: setContextQuery,
    onDueDateChange: handleDueDateChange,
    onDueTimeChange: handleDueTimeChange,
    onProjectQueryChange: setProjectQuery,
    onRemoveContext: handleRemoveContext,
    onSelectArea: handleSelectArea,
    onSelectContext: handleToggleContext,
    onSelectPriority: handleSelectPriority,
    onSelectProject: handleSelectProject,
    onStartTimeChange: handleStartTimeChange,
    onSubmitContextQuery: handleContextSubmit,
    onSubmitAreaQuery: () => {
      void submitAreaQuery();
    },
    onSubmitProjectQuery: () => {
      void submitProjectQuery();
    },
    pendingStartDate,
    prioritiesEnabled,
    priorityOptions: PRIORITY_OPTIONS,
    projectQuery,
    selectedAreaId,
    selectedPriority: priority,
    showAreaPicker,
    showContextPicker,
    showDatePicker,
    showDueTimePicker,
    showPriorityPicker,
    showProjectPicker,
    startPickerMode,
    startTime,
    t,
    tc,
  };

  return (
    <>
      <QuickCaptureSheetBody
        addAnother={addAnother}
        areaLabel={areaLabel}
        contextLabel={contextLabel}
        dueDate={dueDate}
        dueLabel={dueLabel}
        dueTimeLabel={dueTimeLabel}
        contentAccessibilityHidden={Boolean(pendingBulkLines)}
        handleClose={handleClose}
        handleRequestClose={pendingBulkLines ? cancelBulkQuickAdd : handleClose}
        handleImportTextFile={handleImportTextFile}
        handleSave={() => {
          void handleSave();
        }}
        focusNewTask={focusNewTask}
        canFocusNewTask={canFocusNewTask}
        focusNewTaskDisabledReason={focusNewTaskDisabledReason}
        handleSaveAndEdit={() => {
          void handleSave({ openAfterSave: true });
        }}
        insetsBottom={insets.bottom}
        inputRef={inputRef}
        keyboardAvoidingEnabled={androidKeyboardAvoidingEnabled}
        androidKeyboardInset={androidKeyboardInset}
        noteValue={noteValue}
        onNoteChange={setNoteValue}
        onOpenAreaPicker={() => setShowAreaPicker(true)}
        onOpenContextPicker={openContextPicker}
        onOpenDueDatePicker={openDueDatePicker}
        onOpenDueTimePicker={openDueTimePicker}
        onOpenPriorityPicker={() => setShowPriorityPicker(true)}
        onOpenProjectPicker={() => setShowProjectPicker(true)}
        onQuickDueDateSelect={handleQuickDueDateSelect}
        onResetArea={() => setSelectedAreaId(null)}
        onResetContexts={handleClearContexts}
        onResetDueDate={resetDueDate}
        onResetDueTime={resetDueTime}
        onResetPriority={() => setPriority(null)}
        onResetProject={() => {
          setProjectId(null);
          setSelectedAreaId(defaultAreaId);
        }}
        onToggleOptions={handleToggleOptions}
        onToggleAddAnother={(next) => {
          setAddAnother(next);
          void writeQuickCaptureAddAnother(next);
        }}
        onToggleFocusNewTask={() => {
          if (!focusNewTask && !canFocusNewTask) {
            // Keep the hard focus cap, but explain the block instead of silently
            // swallowing the tap (mirrors the task-list focus toggle).
            showToast({
              title: tFallback(t, 'digest.focus', 'Focus'),
              message: focusNewTaskDisabledReason,
              tone: 'warning',
            });
            return;
          }
          setFocusNewTask((current) => !current);
        }}
        onToggleRecording={handleToggleRecording}
        onValueChange={setValue}
        optionsExpanded={optionsExpanded}
        preview={previewEntries.length > 0 ? <QuickAddPreview entries={previewEntries} tc={tc} /> : null}
        prioritiesEnabled={prioritiesEnabled}
        priorityLabel={priorityLabel}
        projectLabel={projectLabel}
        projectSelected={Boolean(selectedProject)}
        recording={Boolean(recording)}
        recordingBusy={recordingBusy}
        recordingReady={recordingReady}
        saving={saving || recordingBusy}
        saveButtonBackgroundColor={saveButtonBackgroundColor}
        saveButtonTextColor={saveButtonTextColor}
        sheetMaxHeight={sheetMaxHeight}
        showDueTime={Boolean(dueDate)}
        t={t}
        tc={tc}
        value={value}
        visible={visible}
      >
        <QuickCaptureSheetPickers {...pickerProps} pickerLayer="overlay" overlayKeyboardInset={overlayKeyboardInset} />
        {pendingBulkLines ? (
          <BulkQuickAddConfirm
            cancelLabel={t('common.cancel')}
            confirmLabel={tFallback(t, 'quickAdd.bulkConfirmCreate', 'Create tasks')}
            message={formatBulkConfirmMessage(pendingBulkLines)}
            onCancel={cancelBulkQuickAdd}
            onConfirm={acceptBulkQuickAdd}
            tc={tc}
            title={formatBulkConfirmTitle(pendingBulkLines.length)}
          />
        ) : null}
      </QuickCaptureSheetBody>
      <QuickCaptureSheetPickers {...pickerProps} pickerLayer="date" />
    </>
  );
}
