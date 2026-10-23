import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  updateSettingsFromLatest,
  CaptureSessionCoordinator,
  prepareCaptureTask,
  filterCaptureAreas,
  filterCaptureProjects,
  hasExactCaptureAreaMatch,
  hasExactCaptureProjectMatch,
  resolveCaptureAreaQuery,
  resolveCaptureProjectQuery,
  applyQuickCaptureEdit,
  buildQuickAddParseOptions,
  buildQuickCapturePreview,
  buildQuickCaptureRequest,
  createQuickCaptureOptions,
  getQuickCaptureBulkConfirm,
  getQuickCaptureBulkFailedNotice,
  getQuickCaptureContextChoices,
  getSavedTaxonomyTokens,
  getQuickCaptureContextPicker,
  getQuickCaptureLabels,
  isSelectableProjectForTaskAssignment,
  isSandboxMode,
  parseQuickCaptureContextQuery,
  planQuickCaptureSave,
  QUICK_CAPTURE_PRIORITY_OPTIONS,
  resolveFeatureFlags,
  resolveQuickCaptureDefaultAreaId,
  safeFormatDate,
  safeParseDate,
  saveQuickCapture,
  saveQuickCaptureBulk,
  shallow,
  splitQuickAddBulkLines,
  tFallback,
  type QuickCaptureContext,
  type QuickCaptureEdit,
  type QuickCaptureOptions,
  type CaptureSessionId,
  type Attachment,
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
import { useQuickCaptureKeyboardDiagnostics } from '../lib/use-quick-capture-keyboard-diagnostics';
import { logError, logWarn } from '../lib/app-log';
import { createMobileRecoverySnapshot } from '../lib/recovery-snapshot';
import { openTaskScreen } from '@/lib/task-meta-navigation';
import { buildCaptureExtra } from './quick-capture-sheet.utils';
import { styles } from './quick-capture-sheet/quick-capture-sheet.styles';
import { QuickAddPreview } from './QuickAddPreview';
import { QuickCaptureSheetBody } from './quick-capture-sheet/QuickCaptureSheetBody';
import { QuickCaptureSheetPickers } from './quick-capture-sheet/QuickCaptureSheetPickers';
import { useQuickCaptureAudio } from './use-quick-capture-audio';
import { useAndroidQuickCaptureExpand } from './quick-capture-sheet/useAndroidQuickCaptureExpand';
import { useAndroidActivitySession } from '@/hooks/use-android-activity-session';
import {
  ANDROID_ACTIVITY_SESSION_TTL_MS,
  isAndroidActivityChangingConfigurations,
} from '@/lib/android-activity-session';

const ANDROID_OPTIONS_EXPAND_FALLBACK_MS = 500;

type QuickCaptureActivityState = {
  value: string;
  noteValue: string;
  dueDate: string | null;
  dueDateHasTime: boolean;
  startTime: string | null;
  contextTags: string[];
  projectId: string | null;
  selectedAreaId: string | null;
  priority: TaskPriority | null;
  optionsExpanded: boolean;
  addAnother: boolean;
  focusNewTask: boolean;
  recoveryAttachments: Attachment[];
  recoveryOwnedAttachmentUris: string[];
};

type QuickCaptureActivitySubmission = {
  createdAt: number;
  draft: QuickCaptureActivityState;
  id: number;
  ownerId: string;
  status: 'pending' | 'failed';
};

const MAX_ACTIVITY_SUBMISSIONS = 16;
const activitySubmissions = new Map<number, QuickCaptureActivitySubmission>();
const activitySubmissionFailureListeners = new Map<string, Set<() => void>>();
let nextActivitySubmissionId = 1;

const cloneQuickCaptureActivityState = (
  draft: QuickCaptureActivityState,
): QuickCaptureActivityState => ({
  ...draft,
  contextTags: [...draft.contextTags],
  recoveryAttachments: draft.recoveryAttachments.map((attachment) => ({ ...attachment })),
  recoveryOwnedAttachmentUris: [...draft.recoveryOwnedAttachmentUris],
});

const cleanupOwnedRecoveryAttachments = (uris: string[]) => {
  for (const uri of new Set(uris)) {
    try {
      const file = new FileSystem.File(uri);
      const info = file.info() as { exists?: boolean; isDirectory?: boolean };
      if (info.exists && !info.isDirectory) file.delete();
    } catch (error) {
      logCaptureWarn('Failed to clean up discarded quick capture audio', error);
    }
  }
};

const pruneFailedActivitySubmissions = () => {
  const now = Date.now();
  for (const [id, submission] of activitySubmissions) {
    if (submission.status === 'failed'
        && now - submission.createdAt > ANDROID_ACTIVITY_SESSION_TTL_MS) {
      cleanupOwnedRecoveryAttachments(submission.draft.recoveryOwnedAttachmentUris);
      activitySubmissions.delete(id);
    }
  }
};

const hasFailedActivitySubmission = (ownerId: string) => {
  pruneFailedActivitySubmissions();
  return [...activitySubmissions.values()].some((submission) => (
    submission.ownerId === ownerId && submission.status === 'failed'
  ));
};

/**
 * Watches for a durable capture failure that settled after the Activity which
 * submitted it was destroyed. The replacement opens an editor, then the sheet
 * consumes the failed draft without replaying the write.
 */
export const subscribeQuickCaptureSubmissionFailure = (
  ownerId: string,
  listener: () => void,
) => {
  const listeners = activitySubmissionFailureListeners.get(ownerId) ?? new Set<() => void>();
  listeners.add(listener);
  activitySubmissionFailureListeners.set(ownerId, listeners);
  if (hasFailedActivitySubmission(ownerId)) listener();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) activitySubmissionFailureListeners.delete(ownerId);
  };
};

const beginQuickCaptureActivitySubmission = (
  ownerId: string,
  draft: QuickCaptureActivityState,
) => {
  pruneFailedActivitySubmissions();
  while (activitySubmissions.size >= MAX_ACTIVITY_SUBMISSIONS) {
    const oldestFailed = [...activitySubmissions.entries()].find(([, submission]) => (
      submission.status === 'failed'
    ));
    if (!oldestFailed) break;
    cleanupOwnedRecoveryAttachments(oldestFailed[1].draft.recoveryOwnedAttachmentUris);
    activitySubmissions.delete(oldestFailed[0]);
  }
  const id = nextActivitySubmissionId;
  nextActivitySubmissionId += 1;
  activitySubmissions.set(id, {
    createdAt: Date.now(),
    draft: cloneQuickCaptureActivityState(draft),
    id,
    ownerId,
    status: 'pending',
  });
  return id;
};

const updateQuickCaptureActivitySubmission = (
  id: number,
  draft: QuickCaptureActivityState,
) => {
  const submission = activitySubmissions.get(id);
  if (!submission || submission.status !== 'pending') return false;
  submission.draft = cloneQuickCaptureActivityState(draft);
  return true;
};

const settleQuickCaptureActivitySubmission = (
  id: number,
  outcome: 'discard' | 'editing' | 'failed' | 'succeeded',
) => {
  const submission = activitySubmissions.get(id);
  if (!submission) return null;
  const draft = cloneQuickCaptureActivityState(submission.draft);
  if (outcome !== 'failed') {
    if (outcome === 'discard') {
      cleanupOwnedRecoveryAttachments(draft.recoveryOwnedAttachmentUris);
    }
    activitySubmissions.delete(id);
    return { draft, retained: false };
  }
  submission.createdAt = Date.now();
  submission.status = 'failed';
  activitySubmissionFailureListeners.get(submission.ownerId)?.forEach((listener) => listener());
  return { draft, retained: true };
};

const takeFailedQuickCaptureActivitySubmission = (ownerId: string) => {
  pruneFailedActivitySubmissions();
  const failed = [...activitySubmissions.values()].find((submission) => (
    submission.ownerId === ownerId && submission.status === 'failed'
  ));
  if (!failed) return null;
  activitySubmissions.delete(failed.id);
  const draft = cloneQuickCaptureActivityState(failed.draft);
  if (hasFailedActivitySubmission(ownerId)) {
    activitySubmissionFailureListeners.get(ownerId)?.forEach((listener) => listener());
  }
  return draft;
};

const isNullableString = (value: unknown): value is string | null => (
  value === null || typeof value === 'string'
);

const isRecoverableAttachment = (value: unknown): value is Attachment => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && (candidate.kind === 'file' || candidate.kind === 'link')
    && typeof candidate.title === 'string'
    && typeof candidate.uri === 'string'
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string';
};

const isQuickCaptureActivityState = (value: unknown): value is QuickCaptureActivityState => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.value === 'string'
    && candidate.value.length <= 100_000
    && typeof candidate.noteValue === 'string'
    && candidate.noteValue.length <= 500_000
    && isNullableString(candidate.dueDate)
    && typeof candidate.dueDateHasTime === 'boolean'
    && isNullableString(candidate.startTime)
    && Array.isArray(candidate.contextTags)
    && candidate.contextTags.every((item) => typeof item === 'string')
    && isNullableString(candidate.projectId)
    && isNullableString(candidate.selectedAreaId)
    && (candidate.priority === null || QUICK_CAPTURE_PRIORITY_OPTIONS.includes(candidate.priority as TaskPriority))
    && typeof candidate.optionsExpanded === 'boolean'
    && typeof candidate.addAnother === 'boolean'
    && typeof candidate.focusNewTask === 'boolean'
    && Array.isArray(candidate.recoveryAttachments)
    && candidate.recoveryAttachments.length <= 100
    && candidate.recoveryAttachments.every(isRecoverableAttachment)
    && Array.isArray(candidate.recoveryOwnedAttachmentUris)
    && candidate.recoveryOwnedAttachmentUris.length <= 100
    && candidate.recoveryOwnedAttachmentUris.every((item) => typeof item === 'string');
};

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

const toInstant = (value: string | null) => (value ? safeParseDate(value)?.toISOString() ?? null : null);
// A native picker's pick as core's due date edits take it: the local day, or the local time of day.
const pad = (value: number) => String(value).padStart(2, '0');
const toLocalDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const toLocalTime = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

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
  activitySessionOwnerId = 'quick-capture:route-draft',
  onSubmissionStart,
  onSubmissionSettled,
}: {
  visible: boolean;
  openRequestId?: number;
  onClose: () => void;
  initialProps?: Partial<Task>;
  initialValue?: string;
  autoRecord?: boolean;
  activitySessionOwnerId?: string;
  onSubmissionStart?: () => void;
  onSubmissionSettled?: () => void;
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
  const activeActivitySubmissionRef = useRef<number | null>(null);
  const rearmAfterDraftResetRef = useRef(false);
  const { selectedAreaIdForNewTasks } = useMobileAreaFilter();
  const defaultAreaId = resolveQuickCaptureDefaultAreaId(settings, areas, { areaId: selectedAreaIdForNewTasks });

  const updateSpeechSettings = useCallback(
    (next: Partial<NonNullable<NonNullable<typeof settings.ai>['speechToText']>>) => {
      // Built from the latest stored settings, so an ai key another device changed stays.
      updateSettingsFromLatest((latest) => ({
        ai: {
          ...(latest.ai ?? {}),
          speechToText: {
            ...(latest.ai?.speechToText ?? {}),
            ...next,
          },
        },
      }), { write: updateSettings, read: () => useTaskStore.getState().settings }).catch((error) => logCaptureWarn('Failed to update speech settings', error));
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
  // Every chosen option (core's QuickCaptureOptions), including the description.
  // Changes go through editOptions below.
  const [options, setOptions] = useState<QuickCaptureOptions>(() => createQuickCaptureOptions({ projects: [], defaultAreaId: null }));
  const {
    note: noteValue,
    dueDateHasTime,
    contexts: contextTags,
    projectId,
    areaId: selectedAreaId,
    priority,
    focus: focusNewTask,
    addAnother,
  } = options;
  const dueDate = useMemo(() => (options.dueDate ? new Date(options.dueDate) : null), [options.dueDate]);
  const [recoveryAttachments, setRecoveryAttachments] = useState<Attachment[]>([]);
  const [recoveryOwnedAttachmentUris, setRecoveryOwnedAttachmentUris] = useState<string[]>([]);
  const [pendingBulkLines, setPendingBulkLines] = useState<string[] | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showDueTimePicker, setShowDueTimePicker] = useState(false);
  const [contextOptions, setContextOptions] = useState<string[]>([]);
  const [contextHistory, setContextHistory] = useState<string[]>([]);
  const [contextOptionsLoading, setContextOptionsLoading] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const contextSourceRevision = useTaskStore((state) => showContextPicker ? state._allTasks : null);
  const [contextQuery, setContextQuery] = useState('');
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [areaQuery, setAreaQuery] = useState('');
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [androidKeyboardAvoidingEnabled, setAndroidKeyboardAvoidingEnabled] = useState(true);
  const androidKeyboardInset = useAndroidKeyboardInset(visible);
  const { onModalShow, onAutoFocusRequest, onInputFocus, onInputBlur } = useQuickCaptureKeyboardDiagnostics({
    visible, openRequestId, inputRef,
    appliedInset: androidKeyboardAvoidingEnabled ? androidKeyboardInset : 0,
    avoidanceEnabled: androidKeyboardAvoidingEnabled, expanded: optionsExpanded, autoRecord: Boolean(autoRecord),
  });
  // The picker overlays render outside the KeyboardAvoidingView, so iOS needs
  // the measured inset too — only the sheet body is keyboard-avoided (#891).
  const overlayKeyboardInset = useKeyboardInset(visible);
  const projectsRef = useRef(projects);
  const restoredActivitySessionRef = useRef(false);
  const contextOptionsLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextOptionsRequestRef = useRef(0);
  const modalShownRef = useRef(false);
  const initialFocusPendingRef = useRef(false);
  const focusSessionRef = useRef({ visible, openRequestId });
  focusSessionRef.current = { visible, openRequestId };
  const initialFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedCount = getFocusedCount();
  const labels = getQuickCaptureLabels(options, { projects, areas, settings, focusedCount, t, formatDate: safeFormatDate });
  const { prioritiesEnabled, canFocus: canFocusNewTask, focusDisabledReason: focusNewTaskDisabledReason } = labels;
  // Every option change is core's edit. A refused edit (focus at the limit)
  // shows its notice, decided on the options this render shows.
  const editOptions = useCallback((edit: QuickCaptureEdit) => {
    const context = { settings, focusedCount, defaultAreaId, contextChoices: contextOptions, t, now: new Date() };
    const checked = applyQuickCaptureEdit(options, edit, context);
    if (checked?.notice) {
      showToast(checked.notice);
      return;
    }
    setOptions((current) => applyQuickCaptureEdit(current, edit, context)?.options ?? current);
  }, [contextOptions, defaultAreaId, focusedCount, options, settings, showToast, t]);
  const captureInitialAttachments = useMemo(() => {
    const merged = new Map<string, Attachment>();
    for (const attachment of initialProps?.attachments ?? []) {
      merged.set(attachment.id || attachment.uri, attachment);
    }
    for (const attachment of recoveryAttachments) {
      merged.set(attachment.id || attachment.uri, attachment);
    }
    return [...merged.values()];
  }, [initialProps?.attachments, recoveryAttachments]);
  const captureInitialProps = useMemo<Partial<Task> | undefined>(() => (
    recoveryAttachments.length > 0
      ? { ...initialProps, attachments: captureInitialAttachments }
      : initialProps
  ), [captureInitialAttachments, initialProps, recoveryAttachments.length]);

  const activitySessionValue = useMemo<QuickCaptureActivityState>(() => ({
    value,
    noteValue,
    dueDate: dueDate?.toISOString() ?? null,
    dueDateHasTime,
    startTime: options.startTime,
    contextTags,
    projectId,
    selectedAreaId,
    priority,
    optionsExpanded,
    addAnother,
    focusNewTask,
    recoveryAttachments,
    recoveryOwnedAttachmentUris,
  }), [
    addAnother,
    contextTags,
    dueDate,
    dueDateHasTime,
    focusNewTask,
    noteValue,
    optionsExpanded,
    priority,
    projectId,
    recoveryAttachments,
    recoveryOwnedAttachmentUris,
    options.startTime,
    selectedAreaId,
    value,
  ]);
  const restoreActivitySession = useCallback((recovered: QuickCaptureActivityState) => {
    restoredActivitySessionRef.current = true;
    setQuickAddParseOptions(readQuickAddParseOptions());
    setValue(recovered.value);
    const restoredProjectId = recovered.projectId && projectsRef.current.some((project) => (
      project.id === recovered.projectId && isSelectableProjectForTaskAssignment(project)
    )) ? recovered.projectId : null;
    setOptions({
      note: recovered.noteValue,
      dueDate: toInstant(recovered.dueDate),
      dueDateHasTime: recovered.dueDateHasTime,
      startTime: toInstant(recovered.startTime),
      contexts: recovered.contextTags,
      projectId: restoredProjectId,
      areaId: restoredProjectId ? null : recovered.selectedAreaId,
      priority: recovered.priority,
      focus: recovered.focusNewTask,
      addAnother: recovered.addAnother,
    });
    setContextOptions(recovered.contextTags);
    setOptionsExpanded(recovered.optionsExpanded);
    setRecoveryAttachments(recovered.recoveryAttachments);
    setRecoveryOwnedAttachmentUris(recovered.recoveryOwnedAttachmentUris);
    setAndroidKeyboardAvoidingEnabled(true);
  }, []);
  const {
    clear: clearActivitySession,
    rearm: rearmActivitySession,
    sourceActivityId,
  } = useAndroidActivitySession({
    ownerId: activitySessionOwnerId,
    value: visible ? activitySessionValue : null,
    validate: isQuickCaptureActivityState,
    onRestore: restoreActivitySession,
  });

  useLayoutEffect(() => {
    const failedDraft = takeFailedQuickCaptureActivitySubmission(activitySessionOwnerId);
    if (failedDraft) restoreActivitySession(failedDraft);
  }, [activitySessionOwnerId, openRequestId, restoreActivitySession]);

  const buildActivitySubmissionDraft = useCallback((
    attachments = captureInitialAttachments,
    fallbackValue?: string,
    additionalOwnedAttachmentUris: string[] = [],
  ): QuickCaptureActivityState => ({
    ...activitySessionValue,
    value: activitySessionValue.value.trim()
      ? activitySessionValue.value
      : (fallbackValue ?? activitySessionValue.value),
    recoveryAttachments: attachments.map((attachment) => ({ ...attachment })),
    recoveryOwnedAttachmentUris: Array.from(new Set([
      ...recoveryOwnedAttachmentUris,
      ...additionalOwnedAttachmentUris,
    ])),
  }), [activitySessionValue, captureInitialAttachments, recoveryOwnedAttachmentUris]);

  const beginActivitySubmission = useCallback((
    attachments = captureInitialAttachments,
    fallbackValue?: string,
    additionalOwnedAttachmentUris: string[] = [],
  ) => {
    clearActivitySession();
    onSubmissionStart?.();
    const submissionId = beginQuickCaptureActivitySubmission(
      activitySessionOwnerId,
      buildActivitySubmissionDraft(attachments, fallbackValue, additionalOwnedAttachmentUris),
    );
    activeActivitySubmissionRef.current = submissionId;
    return submissionId;
  }, [activitySessionOwnerId, buildActivitySubmissionDraft, captureInitialAttachments, clearActivitySession, onSubmissionStart]);

  const updateActivitySubmission = useCallback((
    submissionId: number,
    attachments: Attachment[],
    fallbackValue?: string,
    additionalOwnedAttachmentUris: string[] = [],
  ) => updateQuickCaptureActivitySubmission(
    submissionId,
    buildActivitySubmissionDraft(attachments, fallbackValue, additionalOwnedAttachmentUris),
  ), [buildActivitySubmissionDraft]);

  const settleActivitySubmission = useCallback((
    submissionId: number,
    options: { durableSucceeded: boolean; keepEditing: boolean; sessionCurrent: boolean },
  ) => {
    if (activeActivitySubmissionRef.current === submissionId) {
      activeActivitySubmissionRef.current = null;
    }
    const settled = settleQuickCaptureActivitySubmission(
      submissionId,
      options.durableSucceeded
        ? 'succeeded'
        : options.sessionCurrent
          ? 'editing'
          : Platform.OS === 'android'
              && sourceActivityId !== null
              && isAndroidActivityChangingConfigurations(sourceActivityId)
            ? 'failed'
            : 'discard',
    );
    if (options.sessionCurrent && options.keepEditing) {
      if (options.durableSucceeded) {
        // Add-another has already committed the previous draft. Wait until the
        // reset state renders so the hook cannot retain the stale saved value.
        rearmAfterDraftResetRef.current = true;
      } else {
        if (!value.trim() && settled?.draft.value) {
          setValue(settled.draft.value);
        }
        if (settled?.draft.recoveryAttachments.length) {
          setRecoveryAttachments(settled.draft.recoveryAttachments);
        }
        if (settled?.draft.recoveryOwnedAttachmentUris.length) {
          setRecoveryOwnedAttachmentUris(settled.draft.recoveryOwnedAttachmentUris);
        }
        rearmActivitySession();
        onSubmissionSettled?.();
      }
    }
    return Boolean(settled);
  }, [onSubmissionSettled, rearmActivitySession, sourceActivityId, value]);

  useLayoutEffect(() => {
    if (!rearmAfterDraftResetRef.current) return;
    rearmAfterDraftResetRef.current = false;
    rearmActivitySession();
    onSubmissionSettled?.();
  }, [activitySessionValue, onSubmissionSettled, rearmActivitySession]);

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
    initialFocusPendingRef.current = false;
    if (!initialFocusTimerRef.current) return;
    clearTimeout(initialFocusTimerRef.current);
    initialFocusTimerRef.current = null;
  }, []);

  const scheduleInitialFocus = useCallback(() => {
    clearInitialFocusTimer();
    initialFocusTimerRef.current = setTimeout(() => {
      initialFocusTimerRef.current = null;
      if (!focusSessionRef.current.visible || focusSessionRef.current.openRequestId !== openRequestId) return;
      onAutoFocusRequest(Platform.OS === 'android');
      inputRef.current?.focus();
    }, 120);
  }, [clearInitialFocusTimer, onAutoFocusRequest, openRequestId]);

  const handleModalShow = useCallback(() => {
    if (!visible || !focusSessionRef.current.visible || focusSessionRef.current.openRequestId !== openRequestId) return;
    onModalShow();
    modalShownRef.current = true;
    if (Platform.OS === 'android' && initialFocusPendingRef.current) scheduleInitialFocus();
  }, [onModalShow, openRequestId, scheduleInitialFocus, visible]);

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
        const state = useTaskStore.getState();
        const savedContexts = getSavedTaxonomyTokens(state.settings, 'context');
        const nextOptions = Array.from(new Set([...getQuickCaptureContextChoices(state.tasks, initialProps?.contexts), ...savedContexts]));
        const nextHistory = Array.from(new Set([...getQuickCaptureContextChoices(state._allTasks), ...savedContexts]));
        if (contextOptionsRequestRef.current === requestId) {
          setContextOptions(nextOptions);
          setContextHistory(nextHistory);
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

  useEffect(() => {
    if (showContextPicker) loadContextOptions();
  }, [contextSourceRevision, loadContextOptions, showContextPicker]);

  const contextPicker = useMemo(
    () => getQuickCaptureContextPicker(contextOptions, contextQuery, contextTags, contextHistory),
    [contextOptions, contextQuery, contextTags, contextHistory],
  );

  const addContextFromQuery = useCallback(() => {
    if (parseQuickCaptureContextQuery(contextQuery).length === 0) return;
    editOptions({ type: 'addContexts', query: contextQuery });
    setContextQuery('');
  }, [contextQuery, editOptions]);

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
    editOptions({ type: 'selectProject', projectId: nextProjectId });
    setShowProjectPicker(false);
    setProjectQuery('');
    Keyboard.dismiss();
  }, [addProject, editOptions, projectQuery, projects, selectedAreaId]);

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
    editOptions({ type: 'selectArea', areaId: nextAreaId });
    setShowAreaPicker(false);
    setAreaQuery('');
    Keyboard.dismiss();
  }, [addArea, areaQuery, areas, editOptions]);

  const hasExactProjectMatch = useMemo(() => (
    showProjectPicker && hasExactCaptureProjectMatch(projects, projectQuery)
  ), [projectQuery, projects, showProjectPicker]);

  const filteredAreas = useMemo(() => (
    showAreaPicker ? filterCaptureAreas(areas, areaQuery) : []
  ), [areaQuery, areas, showAreaPicker]);

  const hasExactAreaMatch = useMemo(() => (
    showAreaPicker && hasExactCaptureAreaMatch(areas, areaQuery)
  ), [areaQuery, areas, showAreaPicker]);

  const resetDraftState = useCallback((reset?: { keepAddAnother?: boolean; value?: string }) => {
    clearAndroidOptionsExpand();
    setQuickAddParseOptions(readQuickAddParseOptions());
    setValue(reset?.value ?? initialValue ?? '');
    setOptions(createQuickCaptureOptions({
      initialProps,
      projects: projectsRef.current,
      defaultAreaId,
      addAnother: Boolean(reset?.keepAddAnother),
    }));
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
    setContextOptions(getQuickCaptureContextChoices([], initialProps?.contexts));
    setContextHistory([]);
    setContextOptionsLoading(false);
    setContextQuery('');
    setShowContextPicker(false);
    setProjectQuery('');
    setShowProjectPicker(false);
    setShowAreaPicker(false);
    setAreaQuery('');
    setShowPriorityPicker(false);
    setOptionsExpanded(false);
    setAndroidKeyboardAvoidingEnabled(true);
    setShowDatePicker(false);
    setShowDueTimePicker(false);
    setRecoveryAttachments([]);
    setRecoveryOwnedAttachmentUris([]);
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
    if (!visible) {
      modalShownRef.current = false;
      return;
    }
    if (restoredActivitySessionRef.current) {
      restoredActivitySessionRef.current = false;
    } else {
      resetDraftState();
    }
    // The "Add another" switch is a sticky device preference: capture bursts
    // (Enter chains into the next task) should survive closing the sheet
    // instead of resetting to one-shot mode every open (#819).
    void readQuickCaptureAddAnother().then((stored) => {
      if (stored) setOptions((current) => (current.addAnother ? current : { ...current, addAnother: true }));
    });
    if (autoRecord) return;
    clearInitialFocusTimer();
    // Android can accept JS focus before its modal window is ready for the IME.
    initialFocusPendingRef.current = true;
    if (Platform.OS !== 'android' || modalShownRef.current) scheduleInitialFocus();
    return clearInitialFocusTimer;
  }, [autoRecord, scheduleInitialFocus, clearInitialFocusTimer, openRequestId, resetDraftState, visible]);

  useEffect(() => {
    if (prioritiesEnabled) return;
    setOptions((current) => (current.priority === null ? current : { ...current, priority: null }));
    setShowPriorityPicker(false);
  }, [prioritiesEnabled]);

  // The options the preview reads: only what the popup's own controls force
  // onto the saved task, so typing a note does not re-parse the title.
  const previewOptions = useMemo(() => ({
    projectId,
    dueDate: options.dueDate,
    dueDateHasTime,
    startTime: options.startTime,
  }), [dueDateHasTime, options.dueDate, options.startTime, projectId]);
  // The preview and the save read the same parse-options bag, so the strip
  // cannot promise what the save would not write.
  const previewEntries = useMemo(() => buildQuickCapturePreview(value, previewOptions, {
    projects,
    areas,
    parseOptions: quickAddParseOptions,
    t,
    formatDate: safeFormatDate,
    now: new Date(),
  }), [areas, previewOptions, projects, quickAddParseOptions, t, value]);

  const captureContext = useCallback((): QuickCaptureContext => ({
    settings,
    projects,
    areas,
    parseOptions: quickAddParseOptions,
    focusedCount,
    defaultAreaId,
    initialProps: captureInitialProps,
    t,
    formatDate: safeFormatDate,
    now: new Date(),
  }), [areas, captureInitialProps, defaultAreaId, focusedCount, projects, quickAddParseOptions, settings, t]);

  const buildCaptureRequestForInput = useCallback((
    inputValue: string,
    fallbackTitle: string,
    extraProps?: Partial<Task>,
    currentProjects = projects,
  ) => buildQuickCaptureRequest(
    { text: inputValue, fallbackTitle, options, extraProps, projects: currentProjects },
    captureContext(),
  ), [captureContext, options, projects]);

  const buildTaskPropsForInput = useCallback(async (inputValue: string, fallbackTitle: string, extraProps?: Partial<Task>) => {
    const request = buildCaptureRequestForInput(inputValue, fallbackTitle, extraProps);
    const prepared = await prepareCaptureTask(request.input, { addProject }, request.options);
    if (!prepared.success) {
      return {
        title: '',
        props: { status: 'inbox' as const, ...captureInitialProps, ...extraProps },
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
  }, [addProject, buildCaptureRequestForInput, captureInitialProps]);

  const buildTaskProps = useCallback((fallbackTitle: string, extraProps?: Partial<Task>) => (
    buildTaskPropsForInput(value, fallbackTitle, extraProps)
  ), [buildTaskPropsForInput, value]);

  const resetState = useCallback(() => {
    clearAndroidOptionsExpand();
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
    setValue('');
    // No preset: empty options in the default area.
    setOptions(createQuickCaptureOptions({ projects: projectsRef.current, defaultAreaId }));
    setContextOptions([]);
    setContextOptionsLoading(false);
    setContextQuery('');
    setShowContextPicker(false);
    setProjectQuery('');
    setShowProjectPicker(false);
    setShowAreaPicker(false);
    setAreaQuery('');
    setShowPriorityPicker(false);
    setOptionsExpanded(false);
    setAndroidKeyboardAvoidingEnabled(true);
    setShowDatePicker(false);
    setShowDueTimePicker(false);
    setRecoveryAttachments([]);
    setRecoveryOwnedAttachmentUris([]);
  }, [clearAndroidOptionsExpand, clearContextOptionsLoad, defaultAreaId]);

  const finalizeClose = useCallback((options?: { recoveryAttachmentsAdopted?: boolean }) => {
    clearActivitySession();
    if (!options?.recoveryAttachmentsAdopted) {
      cleanupOwnedRecoveryAttachments(recoveryOwnedAttachmentUris);
    }
    const session = activeSubmissionSessionRef.current;
    if (session !== null) submissionCoordinatorRef.current.invalidateSession(session);
    activeSubmissionSessionRef.current = null;
    setSaving(false);
    clearInitialFocusTimer();
    resetState();
    onClose();
  }, [clearActivitySession, clearInitialFocusTimer, onClose, recoveryOwnedAttachmentUris, resetState]);

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
    beginActivitySubmission,
    getActiveSubmissionSession,
    handleClose: () => finalizeClose({ recoveryAttachmentsAdopted: true }),
    initialAttachments: captureInitialAttachments,
    onError: logCaptureError,
    onSubmissionBusyChange: setSaving,
    onWarn: logCaptureWarn,
    settings,
    settleActivitySubmission,
    submissionCoordinator: submissionCoordinatorRef.current,
    submissionKey: openRequestId,
    t,
    updateActivitySubmission,
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

  const createBulkTasks = useCallback(async (lines: string[]) => {
    const session = activeSubmissionSessionRef.current;
    if (session === null || !submissionCoordinatorRef.current.tryBeginSubmission(session)) return;
    const activitySubmissionId = beginActivitySubmission();
    let durableSucceeded = false;
    setSaving(true);
    try {
      try {
        if (!isSandboxMode()) await createMobileRecoverySnapshot();
      } catch (error) {
        logCaptureError('Failed to create a recovery snapshot before bulk capture', error);
        showToast(getQuickCaptureBulkFailedNotice(t));
        return;
      }
      if (!submissionCoordinatorRef.current.isCurrent(session)) return;
      const outcome = await saveQuickCaptureBulk({
        lines,
        options,
        context: captureContext(),
        actions: { addProject, addTasks },
        isCurrent: () => submissionCoordinatorRef.current.isCurrent(session),
      });
      if (outcome.kind === 'refused') showToast(outcome.notice);
      durableSucceeded = outcome.kind === 'saved';
      if (!submissionCoordinatorRef.current.isCurrent(session)) return;
      if (!durableSucceeded) return;
      finalizeClose({ recoveryAttachmentsAdopted: true });
    } catch (error) {
      if (submissionCoordinatorRef.current.isCurrent(session)) {
        logCaptureError('Failed to create tasks from bulk capture', error);
        showToast(getQuickCaptureBulkFailedNotice(t));
      }
    } finally {
      const sessionCurrent = submissionCoordinatorRef.current.finishSubmission(session);
      settleActivitySubmission(activitySubmissionId, {
        durableSucceeded,
        keepEditing: !durableSucceeded,
        sessionCurrent,
      });
      if (sessionCurrent) {
        setSaving(false);
      }
    }
  }, [addProject, addTasks, beginActivitySubmission, captureContext, finalizeClose, options, settleActivitySubmission, showToast, t]);

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
    const plan = planQuickCaptureSave(value);
    if (plan.kind === 'empty') return;
    if (plan.kind === 'bulk') {
      confirmBulkQuickAdd(plan.lines);
      return;
    }
    const session = activeSubmissionSessionRef.current;
    if (session === null || !submissionCoordinatorRef.current.tryBeginSubmission(session)) return;
    const activitySubmissionId = beginActivitySubmission();
    let durableSucceeded = false;
    let keepEditing = false;
    setSaving(true);
    try {
      const outcome = await saveQuickCapture({
        text: plan.text,
        options,
        context: captureContext(),
        actions: { addProject, addTask },
        openAfterSave,
      });
      // The sheet has no error banner, so a refused capture says why in a toast
      // (capture-modal already says so on its own screen).
      if (outcome.kind === 'refused') showToast(outcome.notice);
      durableSucceeded = outcome.kind === 'saved';
      if (!submissionCoordinatorRef.current.isCurrent(session) || outcome.kind !== 'saved') return;

      if (outcome.next === 'open') {
        finalizeClose({ recoveryAttachmentsAdopted: true });
        if (outcome.taskId) {
          openTaskScreen(outcome.taskId, outcome.projectId, 'task');
        }
        return;
      }

      if (outcome.next === 'addAnother') {
        keepEditing = true;
        resetDraftState({ keepAddAnother: true, value: '' });
        setTimeout(() => inputRef.current?.focus(), 80);
        return;
      }

      // Project/section-preset capture (opened from ProjectDetailModal's add
      // button): flash + scroll the new row in the project list once the sheet
      // closes (#916); core decides when (saveQuickCapture's highlightTaskId).
      if (outcome.highlightTaskId) {
        setHighlightTask(outcome.highlightTaskId);
      }

      finalizeClose({ recoveryAttachmentsAdopted: true });
    } finally {
      const sessionCurrent = submissionCoordinatorRef.current.finishSubmission(session);
      settleActivitySubmission(activitySubmissionId, {
        durableSucceeded,
        keepEditing: keepEditing || !durableSucceeded,
        sessionCurrent,
      });
      if (sessionCurrent) {
        setSaving(false);
      }
    }
  }, [addProject, addTask, beginActivitySubmission, captureContext, confirmBulkQuickAdd, finalizeClose, options, resetDraftState, setHighlightTask, settleActivitySubmission, showToast, value]);

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
      editOptions({ type: 'setDueDay', day: toLocalDay(selectedDate) });
    }
  }, [editOptions]);

  const handleDueTimeChange = useCallback((event: { type: string }, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setShowDueTimePicker(false);
      return;
    }
    if (!selectedDate) return;
    if (Platform.OS !== 'ios') {
      setShowDueTimePicker(false);
    }
    editOptions({ type: 'setDueTime', time: toLocalTime(selectedDate) });
  }, [editOptions]);

  const resetDueDate = useCallback(() => {
    editOptions({ type: 'clearDueDate' });
    setShowDatePicker(false);
    setShowDueTimePicker(false);
  }, [editOptions]);

  const resetDueTime = useCallback(() => {
    editOptions({ type: 'clearDueTime' });
    setShowDueTimePicker(false);
  }, [editOptions]);

  const handleQuickDueDateSelect = useCallback((date: Date | null) => {
    if (!date) {
      resetDueDate();
      return;
    }
    editOptions({ type: 'setDueDay', day: toLocalDay(date) });
    setShowDatePicker(false);
    setShowDueTimePicker(false);
  }, [editOptions, resetDueDate]);

  const handleToggleContext = useCallback((token: string) => {
    editOptions({ type: 'toggleContext', value: token });
    setContextQuery('');
  }, [editOptions]);

  const handleRemoveContext = useCallback((token: string) => {
    editOptions({ type: 'removeContext', value: token });
  }, [editOptions]);

  const handleClearContexts = useCallback(() => {
    editOptions({ type: 'clearContexts' });
    setContextQuery('');
  }, [editOptions]);

  const handleSelectArea = useCallback((areaId: string | null) => {
    editOptions({ type: 'selectArea', areaId });
    setShowAreaPicker(false);
    setAreaQuery('');
  }, [editOptions]);

  const handleSelectProject = useCallback((nextProjectId: string | null) => {
    editOptions({ type: 'selectProject', projectId: nextProjectId });
    setShowProjectPicker(false);
  }, [editOptions]);

  const handleSelectPriority = useCallback((nextPriority: TaskPriority | null) => {
    editOptions({ type: 'setPriority', priority: nextPriority });
    setShowPriorityPicker(false);
  }, [editOptions]);

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
  }, []);

  const closeContextPicker = useCallback(() => {
    setShowContextPicker(false);
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
    setContextOptionsLoading(false);
  }, [clearContextOptionsLoad]);

  const handleImportTextFile = useCallback(async () => {
    if (isSandboxMode()) {
      showToast({
        title: t('common.notice'),
        message: t('sandbox.unavailable'),
        tone: 'warning',
        durationMs: 4200,
      });
      return;
    }
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

  const bulkConfirm = pendingBulkLines ? getQuickCaptureBulkConfirm(pendingBulkLines, t) : null;

  const pickerProps = {
    areaQuery,
    filteredAreas,
    contextInputRef,
    contextOptionsLoading,
    contextQuery,
    contextTags,
    dueDate,
    filteredContexts: contextPicker.items,
    filteredProjects,
    hasAddableContextTokens: contextPicker.addable,
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
    onSubmitContextQuery: handleContextSubmit,
    onSubmitAreaQuery: () => {
      void submitAreaQuery();
    },
    onSubmitProjectQuery: () => {
      void submitProjectQuery();
    },
    prioritiesEnabled,
    priorityOptions: QUICK_CAPTURE_PRIORITY_OPTIONS,
    projectQuery,
    selectedAreaId,
    selectedPriority: priority,
    showAreaPicker,
    showContextPicker,
    showDatePicker,
    showDueTimePicker,
    showPriorityPicker,
    showProjectPicker,
    t,
    tc,
  };

  return (
    <>
      <QuickCaptureSheetBody
        addAnother={addAnother}
        areaLabel={labels.area}
        contextLabel={labels.contexts}
        dueDate={dueDate}
        dueLabel={labels.due}
        dueTimeLabel={labels.dueTime}
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
        onModalShow={handleModalShow}
        onInputFocus={onInputFocus}
        onInputBlur={onInputBlur}
        keyboardAvoidingEnabled={androidKeyboardAvoidingEnabled}
        androidKeyboardInset={androidKeyboardInset}
        noteValue={noteValue}
        onNoteChange={(next) => editOptions({ type: 'setNote', value: next })}
        onOpenAreaPicker={() => setShowAreaPicker(true)}
        onOpenContextPicker={openContextPicker}
        onOpenDueDatePicker={openDueDatePicker}
        onOpenDueTimePicker={openDueTimePicker}
        onOpenPriorityPicker={() => setShowPriorityPicker(true)}
        onOpenProjectPicker={() => setShowProjectPicker(true)}
        onQuickDueDateSelect={handleQuickDueDateSelect}
        onResetArea={() => editOptions({ type: 'selectArea', areaId: null })}
        onResetContexts={handleClearContexts}
        onResetDueDate={resetDueDate}
        onResetDueTime={resetDueTime}
        onResetPriority={() => editOptions({ type: 'setPriority', priority: null })}
        onResetProject={() => editOptions({ type: 'resetProject' })}
        onToggleOptions={handleToggleOptions}
        onToggleAddAnother={(next) => {
          editOptions({ type: 'setAddAnother', value: next });
          void writeQuickCaptureAddAnother(next);
        }}
        // At the focus limit core refuses the star and explains why (a toast).
        onToggleFocusNewTask={() => editOptions({ type: 'toggleFocus' })}
        onToggleRecording={handleToggleRecording}
        onValueChange={setValue}
        optionsExpanded={optionsExpanded}
        preview={previewEntries.length > 0 ? <QuickAddPreview entries={previewEntries} tc={tc} /> : null}
        prioritiesEnabled={prioritiesEnabled}
        timeEstimatesEnabled={resolveFeatureFlags(settings).timeEstimates}
        priorityLabel={labels.priority}
        selectedPriority={priority}
        projectLabel={labels.project}
        projectSelected={labels.projectSelected}
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
        {bulkConfirm ? (
          <BulkQuickAddConfirm
            cancelLabel={bulkConfirm.cancelLabel}
            confirmLabel={bulkConfirm.confirmLabel}
            message={bulkConfirm.message}
            onCancel={cancelBulkQuickAdd}
            onConfirm={acceptBulkQuickAdd}
            tc={tc}
            title={bulkConfirm.title}
          />
        ) : null}
      </QuickCaptureSheetBody>
      <QuickCaptureSheetPickers {...pickerProps} pickerLayer="date" />
    </>
  );
}
