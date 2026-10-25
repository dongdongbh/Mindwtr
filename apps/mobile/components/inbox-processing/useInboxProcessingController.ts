import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Share,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  advanceProcessInboxSession,
  addBreadcrumb,
  addProcessInboxToken,
  answerProcessInboxStep,
  applyProcessInboxTokenSuggestion,
  buildProcessInboxDelegateRequest,
  buildProcessInboxUndoRestoreUpdates,
  commitProcessInboxDecision,
  createProcessInboxSession,
  createProcessInboxTitleParser,
  createAIProvider,
  createTaskSimilarityIndex,
  formatAIErrorAlertBody,
  formatProcessInboxProgressLabel,
  getProcessInboxProgress,
  getProcessInboxCurrentCandidate,
  getProcessInboxDefaultScheduleTime,
  getProcessInboxPersonSuggestions,
  getProcessInboxProjectChoices,
  getProcessInboxRemainingCandidates,
  getProcessInboxSections,
  getProcessInboxSimilarTasks,
  getProcessInboxSuggestionTerms,
  getProcessInboxTaskDefaults,
  resolveDefaultNewTaskAreaId,
  getProcessInboxTokenPools,
  getProcessInboxTokenSuggestions,
  INITIAL_PROCESS_INBOX_ANSWERS,
  isProcessInboxReturningTask,
  isSelectableProjectForTaskAssignment,
  PROCESS_INBOX_ENERGY_LEVEL_OPTIONS,
  PROCESS_INBOX_PRIORITY_OPTIONS,
  PROCESS_INBOX_SUGGESTION_LIMIT,
  rankProcessInboxTokenSuggestions,
  resolveProcessInboxPlan,
  resolveProcessInboxProjectSearchSubmit,
  restoreTaskSnapshot,
  safeFormatDate,
  safeParseDate,
  selectProcessInboxProject,
  selectProcessInboxQueue,
  startProcessInboxSession,
  sortViewSectionDefinitions,
  tFallback,
  toggleProcessInboxToken,
  undoTaskCompletion,
  saveTaskDraftOntoLatest,
  runStoreCommand,
  resolveAutoTextDirection,
  useTaskStore,
  type AIProviderId,
  resolveTimeEstimateOptions,
  type ProcessInboxAnswers,
  type ProcessInboxChoiceOutcome,
  type ProcessInboxCommitKind,
  type ProcessInboxDateField,
  type ProcessInboxDraft,
  type ProcessInboxMode,
  type ProcessInboxSession,
  type Task,
  type TaskPriority,
  type TimeEstimate,
} from '@mindwtr/core';

import { buildInboxClarifyInput, getAIClarifyDialog, getAIErrorAlert, redactAIError } from '@mindwtr/core/ai-task-actions';
import type { AIResponseAction } from '../ai-response-modal';
import { useLanguage } from '../../contexts/language-context';
import { useTheme } from '../../contexts/theme-context';
import { useToast } from '../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logInfo, logWarn } from '../../lib/app-log';
import { readAppleClarificationBackend } from '../../lib/apple-clarification-preference';
import {
  APPLE_CLARIFICATION_RELEASE_CHECK,
  AppleClarificationCancelledError,
  areAppleClarificationAssociationsCurrent,
  buildAppleClarificationCandidates,
  consumeAppleClarificationApply,
  createAppleClarificationLease,
  describeAppleClarificationUnavailableReason,
  getAppleClarificationCapability,
  isAppleClarificationLeaseCurrent,
  isAppleClarificationPrototypeEnabled,
  reportAppleClarificationOutcome,
  requestAppleInboxClarification,
  type AppleClarificationDraftSnapshot,
  type AppleClarificationSuggestion,
} from '../../lib/apple-foundation-models';
import { createSomedaySection as persistSomedaySection } from '../../lib/someday-section-actions';
import {
  getActionFailureMessage,
  getUnknownErrorMessage,
  isActionFailure,
} from '../store-action-result';
import { styles } from '../inbox-processing-modal.styles';

type InboxDecisionUndoKind = 'discarded' | 'completed' | 'filed';
type InboxDecisionUndoReceipt = Readonly<{
  taskId: string;
  kind: InboxDecisionUndoKind;
  previousStatus: Task['status'];
  wasFocusedToday: boolean;
  restoreUpdates: Partial<Task>;
}>;

type InboxProcessingControllerParams = {
  visible: boolean;
  onClose: () => void;
};

const withoutPendingTime = (field: ProcessInboxDateField) => (
  (prev: Partial<Record<ProcessInboxDateField, string>>) => (prev[field] ? { ...prev, [field]: undefined } : prev)
);

export function useInboxProcessingController({
  visible,
  onClose,
}: InboxProcessingControllerParams) {
  const {
    tasks,
    _allTasks: allTasks,
    projects,
    areas,
    people,
    settings,
    updateTask,
    deleteTask,
    restoreTask,
    addProject,
    addTask,
  } = useTaskStore();
  const { t, language } = useLanguage();
  const { showToast } = useToast();
  const router = useRouter();
  const { isDark } = useTheme();
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();

  const [processingSession, setProcessingSession] = useState<ProcessInboxSession>(
    () => createProcessInboxSession(),
  );
  // The answers so far; core derives the step, its choices and the write from them.
  const [answers, setAnswers] = useState<ProcessInboxAnswers>(INITIAL_PROCESS_INBOX_ANSWERS);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [newContext, setNewContext] = useState('');
  const [delegateWho, setDelegateWho] = useState('');
  const [delegateFollowUpDate, setDelegateFollowUpDate] = useState<Date | null>(null);
  const [delegateFollowUpDateOnly, setDelegateFollowUpDateOnly] = useState(false);
  const [showDelegateDatePicker, setShowDelegateDatePicker] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [convertToProject, setConvertToProject] = useState(false);
  const [nextActionDraft, setNextActionDraft] = useState('');
  const [extraActionDrafts, setExtraActionDrafts] = useState<string[]>([]);
  const projectConversionInFlightRef = useRef(false);
  const [processingTitle, setProcessingTitle] = useState('');
  const [processingDescription, setProcessingDescription] = useState('');
  const [processingTitleFocused, setProcessingTitleFocused] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [selectedEnergyLevel, setSelectedEnergyLevel] = useState<Task['energyLevel']>(undefined);
  const [selectedAssignedTo, setSelectedAssignedTo] = useState('');
  const [selectedTimeEstimate, setSelectedTimeEstimate] = useState<TimeEstimate | undefined>(undefined);
  const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
  const [pendingStartDateOnly, setPendingStartDateOnly] = useState(false);
  const [pendingDueDate, setPendingDueDate] = useState<Date | null>(null);
  const [pendingDueDateOnly, setPendingDueDateOnly] = useState(false);
  const [pendingReviewDate, setPendingReviewDate] = useState<Date | null>(null);
  const [pendingReviewDateOnly, setPendingReviewDateOnly] = useState(false);
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
  const [showDueDatePicker, setShowDueDatePicker] = useState(false);
  const [showReviewDatePicker, setShowReviewDatePicker] = useState(false);
  // A clock time ("HH:mm") the user picked per date row; it wins over the default schedule time (#1445).
  const [pendingTimes, setPendingTimes] = useState<Partial<Record<ProcessInboxDateField, string>>>({});
  const [timePickerField, setTimePickerField] = useState<ProcessInboxDateField | null>(null);
  const [isAIWorking, setIsAIWorking] = useState(false);
  const [appleClarificationBackend, setAppleClarificationBackend] = useState<'configured' | 'on-device'>('configured');
  const [aiModal, setAiModal] = useState<{ title: string; message?: string; actions: AIResponseAction[] } | null>(null);
  const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedPriority, setSelectedPriority] = useState<TaskPriority | undefined>(undefined);
  const [selectedSomedaySectionId, setSelectedSomedaySectionId] = useState<string | undefined>(undefined);
  const dirtyScheduleFieldsRef = useRef(new Set<'startTime' | 'dueDate' | 'reviewAt'>());
  const useDefaultStartTimeRef = useRef(false);
  const activeAppleClarificationRef = useRef<AbortController | null>(null);
  const consumedAppleClarificationRequestsRef = useRef(new Set<string>());

  const titleInputRef = useRef<any>(null);
  const processingScrollRef = useRef<any>(null);
  const hasInitialized = useRef(false);
  const processInboxPlan = useMemo(() => resolveProcessInboxPlan(settings), [settings]);
  // Read at prime time only: a settings change must not re-prime (and reset) the open draft.
  const defaultAreaIdRef = useRef<string | null>(null);
  defaultAreaIdRef.current = resolveDefaultNewTaskAreaId(settings, areas) ?? null;
  const { projectFirst, referenceEnabled } = processInboxPlan;
  const {
    project: showProjectField,
    area: showAreaField,
    contexts: showContextsField,
    tags: showTagsField,
    priority: showPriorityField,
    energyLevel: showEnergyLevelField,
    assignedTo: showAssignedToField,
    timeEstimate: showTimeEstimateField,
    startTime: showStartDateField,
    dueDate: showDueDateField,
    reviewAt: showReviewDateField,
  } = processInboxPlan.visibleFields;
  const defaultScheduleTime = getProcessInboxDefaultScheduleTime(settings);
  const aiEnabled = settings?.ai?.enabled === true;
  const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
  const appleClarificationPrototypeEnabled = isAppleClarificationPrototypeEnabled();
  const aiClarifyEnabled = appleClarificationBackend === 'on-device'
    ? appleClarificationPrototypeEnabled
    : aiEnabled;
  const {
    project: showProjectSection,
    organization: showOrganizationSection,
    scheduling: showSchedulingSection,
  } = getProcessInboxSections(processInboxPlan);
  const somedaySections = useMemo(
    () => sortViewSectionDefinitions(settings?.gtd?.viewSections?.someday),
    [settings?.gtd?.viewSections?.someday],
  );
  const createSomedaySection = useCallback(async (title: string) => {
    try {
      return await persistSomedaySection(title);
    } catch {
      showToast({
        title: tFallback(t, 'common.error', 'Error'),
        message: tFallback(t, 'viewSections.updateFailed', 'Could not update Someday sections.'),
        tone: 'error',
      });
      return null;
    }
  }, [showToast, t]);
  const timeEstimateOptions = useMemo<TimeEstimate[]>(
    () => resolveTimeEstimateOptions(selectedTimeEstimate),
    [selectedTimeEstimate],
  );

  const { areaById } = useVisibleTaskContext();
  const inboxTasks = useMemo(
    // Not `visibleTasks`: the queue is the process-inbox candidate set, which
    // has its own status rule on top of the shared visibility predicate.
    () => selectProcessInboxQueue(tasks, projects),
    [projects, tasks],
  );

  const processingQueue = useMemo(
    () => getProcessInboxRemainingCandidates(processingSession, inboxTasks),
    [inboxTasks, processingSession],
  );
  const processingBaseRef = useRef<Task | null>(null);
  const currentTask = useMemo(
    () => getProcessInboxCurrentCandidate(processingSession, inboxTasks),
    [inboxTasks, processingSession],
  );
  const taskSimilarityIndex = useMemo(
    () => visible ? createTaskSimilarityIndex(allTasks) : null,
    [allTasks, visible],
  );
  const { tasks: similarTasks, projectTitles: similarTaskProjectTitles } = useMemo(
    () => (visible && currentTask
      ? getProcessInboxSimilarTasks(taskSimilarityIndex, processingTitle, currentTask.id, projects)
      : { tasks: [], projectTitles: new Map<string, string>() }),
    [currentTask, processingTitle, projects, taskSimilarityIndex, visible],
  );
  const isReturningItem = Boolean(currentTask && isProcessInboxReturningTask(currentTask));
  const totalCount = inboxTasks.length;
  const processedCount = totalCount - processingQueue.length;
  const progressRef = useRef({ total: 0, processed: 0 });
  const progress = getProcessInboxProgress(progressRef.current, processingQueue.length, processingSession);
  progressRef.current = visible ? progress : { total: 0, processed: 0 };
  const formatProgressLabel = useCallback(
    (current: number, total: number) => formatProcessInboxProgressLabel(t, current, total),
    [t],
  );

  const resolvedTitleDirection = useMemo(() => {
    if (!currentTask) return 'ltr';
    const text = (processingTitle || currentTask.title || '').trim();
    return resolveAutoTextDirection(text, language);
  }, [currentTask, language, processingTitle]);
  const titleDirectionStyle = useMemo<TextStyle>(() => ({
    writingDirection: resolvedTitleDirection,
    textAlign: resolvedTitleDirection === 'rtl' ? 'right' : 'left',
  }), [resolvedTitleDirection]);
  const openSettingsLabel = t('common.open');
  const headerStyle = useMemo(
    () => [styles.processingHeader, {
      borderBottomColor: tc.border,
      paddingTop: Math.max(insets.top, 10),
      paddingBottom: 10,
    }],
    [insets.top, tc.border],
  );

  const tokenPools = useMemo(() => getProcessInboxTokenPools(tasks), [tasks]);
  const contextSuggestionPool = tokenPools.contexts;
  const tagSuggestionPool = tokenPools.tags;
  const suggestionTerms = useMemo(
    () => getProcessInboxSuggestionTerms(processingTitle, processingDescription, newContext),
    [newContext, processingDescription, processingTitle],
  );
  const tokenSuggestions = useMemo(() => getProcessInboxTokenSuggestions({
    tokenInput: newContext,
    pools: tokenPools,
    visible: { contexts: showContextsField, tags: showTagsField },
    selectedContexts,
    selectedTags,
  }), [newContext, selectedContexts, selectedTags, showContextsField, showTagsField, tokenPools]);
  const assignedToSuggestions = useMemo(
    () => getProcessInboxPersonSuggestions(tasks, people ?? [], selectedAssignedTo),
    [people, selectedAssignedTo, tasks],
  );
  const delegateWhoSuggestions = useMemo(
    () => getProcessInboxPersonSuggestions(tasks, people ?? [], delegateWho),
    [delegateWho, people, tasks],
  );
  const contextCopilotSuggestions = useMemo(
    () => rankProcessInboxTokenSuggestions(contextSuggestionPool, selectedContexts, suggestionTerms, PROCESS_INBOX_SUGGESTION_LIMIT),
    [contextSuggestionPool, selectedContexts, suggestionTerms],
  );
  const tagCopilotSuggestions = useMemo(
    () => rankProcessInboxTokenSuggestions(tagSuggestionPool, selectedTags, suggestionTerms, PROCESS_INBOX_SUGGESTION_LIMIT),
    [selectedTags, suggestionTerms, tagSuggestionPool],
  );

  const appleClarificationDraft = useMemo<AppleClarificationDraftSnapshot | null>(() => currentTask ? ({
    taskId: currentTask.id,
    revision: `${currentTask.rev ?? ''}:${currentTask.revBy ?? ''}:${currentTask.updatedAt}`,
    title: processingTitle,
    description: processingDescription,
    projectId: selectedProjectId,
    areaId: selectedAreaId,
    contexts: selectedContexts,
    tags: selectedTags,
    startDate: pendingStartDate ? String(pendingStartDate.getTime()) : null,
    dueDate: pendingDueDate ? String(pendingDueDate.getTime()) : null,
    startDateOnly: pendingStartDateOnly,
    dueDateOnly: pendingDueDateOnly,
    workflowChoices: [answers.actionability, answers.twoMinute, answers.execution],
  }) : null, [
    answers,
    currentTask,
    pendingDueDate,
    pendingDueDateOnly,
    pendingStartDate,
    pendingStartDateOnly,
    processingDescription,
    processingTitle,
    selectedAreaId,
    selectedContexts,
    selectedProjectId,
    selectedTags,
  ]);
  const appleClarificationDraftRef = useRef<AppleClarificationDraftSnapshot | null>(null);
  appleClarificationDraftRef.current = appleClarificationDraft;

  const appleClarificationAssociations = useMemo(() => ({
    projectIds: new Set(projects.filter(isSelectableProjectForTaskAssignment).map((project) => project.id)),
    areaIds: new Set(areas.filter((area) => !area.deletedAt).map((area) => area.id)),
    contextIds: new Set([...contextSuggestionPool, ...selectedContexts]),
    tagIds: new Set([...tagSuggestionPool, ...selectedTags]),
  }), [areas, contextSuggestionPool, projects, selectedContexts, selectedTags, tagSuggestionPool]);
  const appleClarificationAssociationsRef = useRef(appleClarificationAssociations);
  appleClarificationAssociationsRef.current = appleClarificationAssociations;

  const { filteredProjects, exactMatch: exactProjectMatch } = useMemo(
    () => getProcessInboxProjectChoices(projects, selectedAreaId, projectSearch),
    [projectSearch, projects, selectedAreaId],
  );
  const hasExactProjectMatch = Boolean(exactProjectMatch);

  const currentProject = useMemo(
    () => (selectedProjectId ? projects.find((project) => project.id === selectedProjectId) ?? null : null),
    [projects, selectedProjectId],
  );
  const currentArea = useMemo(
    () => (selectedAreaId ? areas.find((area) => area.id === selectedAreaId) ?? null : null),
    [areas, selectedAreaId],
  );

  // Expanding More options appends fields below the current step.
  const scrollProcessingToRevealedStep = useCallback(() => {
    requestAnimationFrame(() => {
      processingScrollRef.current?.scrollToEnd?.({ animated: true });
    });
  }, []);

  const toggleAdvancedOptions = useCallback(() => {
    setShowAdvancedOptions((previous) => {
      if (!previous) scrollProcessingToRevealedStep();
      return !previous;
    });
  }, [scrollProcessingToRevealedStep]);

  const resetTitleFocus = useCallback(() => {
    setProcessingTitleFocused(false);
    titleInputRef.current?.blur?.();
  }, []);

  const scrollProcessingToTop = useCallback((animated: boolean = false) => {
    requestAnimationFrame(() => {
      const scroll = processingScrollRef.current;
      if (!scroll?.scrollTo) return;
      scroll.scrollTo({ y: 0, animated });
      if (animated) {
        void logInfo('Inbox processing step scroll reset', {
          scope: 'inbox', force: true, extra: { releaseCheck: 'v1.3.8/inbox-processing-step-scroll' },
        });
      }
    });
  }, []);

  const primeTaskState = useCallback((task: Task | null | undefined) => {
    // The task the draft is filled from: the base its save merges against. currentTask follows the live store, so a
    // sync that lands before the decision would read as the draft's own change.
    processingBaseRef.current = task ?? null;
    const defaults = getProcessInboxTaskDefaults(task, defaultAreaIdRef.current);
    const { startTime, dueDate, reviewAt } = defaults.dates;
    dirtyScheduleFieldsRef.current.clear();
    useDefaultStartTimeRef.current = false;
    setAnswers(INITIAL_PROCESS_INBOX_ANSWERS);
    setShowAdvancedOptions(defaults.showAdvancedOptions);
    setPendingStartDate(startTime.value ? safeParseDate(startTime.value) : null);
    setPendingStartDateOnly(startTime.dateOnly);
    setPendingDueDate(dueDate.value ? safeParseDate(dueDate.value) : null);
    setPendingDueDateOnly(dueDate.dateOnly);
    setPendingReviewDate(reviewAt.value ? safeParseDate(reviewAt.value) : null);
    setPendingReviewDateOnly(reviewAt.dateOnly);
    setShowStartDatePicker(false);
    setShowDueDatePicker(false);
    setShowReviewDatePicker(false);
    setPendingTimes({});
    setTimePickerField(null);
    setDelegateWho('');
    setDelegateFollowUpDate(null);
    setDelegateFollowUpDateOnly(false);
    setShowDelegateDatePicker(false);
    setConvertToProject(false);
    setNextActionDraft('');
    setExtraActionDrafts([]);
    setSelectedContexts(defaults.contexts);
    setSelectedTags(defaults.tags);
    setSelectedPriority(defaults.priority);
    setSelectedSomedaySectionId(defaults.somedaySectionId);
    setSelectedEnergyLevel(defaults.energyLevel);
    setSelectedAssignedTo(defaults.assignedTo);
    setSelectedTimeEstimate(defaults.timeEstimate);
    setNewContext('');
    setProjectSearch('');
    setSelectedProjectId(defaults.projectId);
    setSelectedAreaId(defaults.areaId);
    resetTitleFocus();
    setProcessingTitle(defaults.title);
    setProcessingDescription(defaults.description);
  }, [resetTitleFocus]);

  // Clearing a row or making it date-only drops its picked time, so the default time comes back.
  const setPendingStartDateFromControl = useCallback((value: Date | null) => {
    dirtyScheduleFieldsRef.current.add('startTime');
    useDefaultStartTimeRef.current = false;
    setPendingStartDate(value);
    if (!value) setPendingTimes(withoutPendingTime('startTime'));
  }, []);
  const setPendingStartDateOnlyFromControl = useCallback((value: boolean) => {
    dirtyScheduleFieldsRef.current.add('startTime');
    useDefaultStartTimeRef.current = false;
    setPendingStartDateOnly(value);
    if (value) setPendingTimes(withoutPendingTime('startTime'));
  }, []);
  const useDefaultStartTimeFromControl = useCallback(() => {
    dirtyScheduleFieldsRef.current.add('startTime');
    useDefaultStartTimeRef.current = true;
    setPendingStartDateOnly(false);
    setPendingTimes(withoutPendingTime('startTime'));
  }, []);
  const setPendingDueDateFromControl = useCallback((value: Date | null) => {
    dirtyScheduleFieldsRef.current.add('dueDate');
    setPendingDueDate(value);
    if (!value) setPendingTimes(withoutPendingTime('dueDate'));
  }, []);
  const setPendingDueDateOnlyFromControl = useCallback((value: boolean) => {
    dirtyScheduleFieldsRef.current.add('dueDate');
    setPendingDueDateOnly(value);
    if (value) setPendingTimes(withoutPendingTime('dueDate'));
  }, []);
  const setPendingReviewDateFromControl = useCallback((value: Date | null) => {
    dirtyScheduleFieldsRef.current.add('reviewAt');
    setPendingReviewDate(value);
    if (!value) setPendingTimes(withoutPendingTime('reviewAt'));
  }, []);
  const setPendingReviewDateOnlyFromControl = useCallback((value: boolean) => {
    dirtyScheduleFieldsRef.current.add('reviewAt');
    setPendingReviewDateOnly(value);
    if (value) setPendingTimes(withoutPendingTime('reviewAt'));
  }, []);
  const setDelegateFollowUpDateFromControl = useCallback((value: Date | null) => {
    setDelegateFollowUpDate(value);
    if (!value) setPendingTimes(withoutPendingTime('followUp'));
  }, []);
  const setDelegateFollowUpDateOnlyFromControl = useCallback((value: boolean) => {
    setDelegateFollowUpDateOnly(value);
    if (value) setPendingTimes(withoutPendingTime('followUp'));
  }, []);
  // A time from the time picker: the row stops being date-only and counts as user input, like a picked date.
  const setPendingTimeFromControl = useCallback((field: ProcessInboxDateField, picked: Date) => {
    if (field !== 'followUp') dirtyScheduleFieldsRef.current.add(field);
    if (field === 'startTime') useDefaultStartTimeRef.current = false;
    if (field === 'startTime') setPendingStartDateOnly(false);
    if (field === 'dueDate') setPendingDueDateOnly(false);
    if (field === 'reviewAt') setPendingReviewDateOnly(false);
    if (field === 'followUp') setDelegateFollowUpDateOnly(false);
    setPendingTimes((prev) => ({ ...prev, [field]: safeFormatDate(picked, 'HH:mm') }));
  }, []);

  const activateProcessingSession = useCallback((
    nextSession: ProcessInboxSession,
    scrollToTop: boolean = true,
  ) => {
    const nextTask = getProcessInboxCurrentCandidate(nextSession, inboxTasks);
    if (!nextTask) return false;
    setProcessingSession(nextSession);
    if (scrollToTop) scrollProcessingToTop(false);
    primeTaskState(nextTask);
    return true;
  }, [inboxTasks, primeTaskState, scrollProcessingToTop]);

  const resetProcessingState = useCallback(() => {
    progressRef.current = { total: 0, processed: 0 };
    setProcessingSession(createProcessInboxSession());
    setAiModal(null);
    primeTaskState(null);
  }, [primeTaskState]);

  const cancelAppleClarification = useCallback(() => {
    activeAppleClarificationRef.current?.abort();
    activeAppleClarificationRef.current = null;
    setIsAIWorking(false);
  }, []);

  const handleClose = useCallback(() => {
    cancelAppleClarification();
    resetProcessingState();
    onClose();
  }, [cancelAppleClarification, onClose, resetProcessingState]);

  const closeAIModal = useCallback(() => setAiModal(null), []);

  useEffect(() => {
    if (!visible || !appleClarificationPrototypeEnabled) {
      setAppleClarificationBackend('configured');
      return;
    }
    let active = true;
    void readAppleClarificationBackend().then((backend) => {
      if (active) setAppleClarificationBackend(backend);
    });
    return () => {
      active = false;
    };
  }, [appleClarificationPrototypeEnabled, visible]);

  useEffect(() => () => {
    cancelAppleClarification();
  }, [cancelAppleClarification, currentTask?.id, visible]);

  useEffect(() => {
    if (!visible) {
      hasInitialized.current = false;
      return;
    }
    if (inboxTasks.length > 0) {
      addBreadcrumb('inbox:start');
    }
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    progressRef.current = { total: 0, processed: 0 };
    if (inboxTasks.length === 0) {
      handleClose();
      return;
    }
    activateProcessingSession(startProcessInboxSession(inboxTasks), false);
  }, [activateProcessingSession, handleClose, inboxTasks, visible]);

  useEffect(() => {
    if (!visible) return;
    if (!currentTask && inboxTasks.length === 0) {
      handleClose();
    }
  }, [currentTask, handleClose, inboxTasks.length, visible]);

  useEffect(() => {
    if (!visible) return;
    if (processingQueue.length === 0) {
      addBreadcrumb('inbox:done');
      handleClose();
      return;
    }
    if (!currentTask) {
      const nextSession = advanceProcessInboxSession(processingSession, inboxTasks);
      if (!activateProcessingSession(nextSession)) handleClose();
    }
  }, [activateProcessingSession, currentTask, handleClose, inboxTasks, processingQueue.length, processingSession, visible]);

  useEffect(() => {
    if (!visible || !currentTask) return;
    scrollProcessingToTop(false);
  }, [currentTask, scrollProcessingToTop, visible]);

  const showProcessingError = useCallback((message?: string) => {
    showToast({
      title: tFallback(t, 'common.error', 'Error'),
      message: message || tFallback(t, 'task.updateFailed', 'Could not update task.'),
      tone: 'error',
      durationMs: 4200,
    });
  }, [showToast, t]);

  const parseProcessingTitle = useMemo(
    () => createProcessInboxTitleParser({ settings, tasks, people: people ?? [], projects, areas }),
    [areas, people, projects, settings, tasks],
  );

  /** The draft as plain values, the shape core commits. */
  const buildDraft = useCallback((): ProcessInboxDraft => {
    const dateValue = (date: Date | null, dateOnly: boolean, useDefaultTime = false, time?: string) => (
      date ? { date: safeFormatDate(date, 'yyyy-MM-dd'), dateOnly,
        ...(useDefaultTime ? { useDefaultTime: true } : {}),
        ...(time && !dateOnly ? { time } : {}) } : null
    );
    return {
      title: processingTitle,
      description: processingDescription,
      projectId: selectedProjectId,
      areaId: selectedAreaId,
      projectSearch,
      contexts: selectedContexts,
      tags: selectedTags,
      tokenInput: newContext,
      priority: selectedPriority ?? null,
      energyLevel: selectedEnergyLevel ?? null,
      assignedTo: selectedAssignedTo,
      timeEstimate: selectedTimeEstimate ?? null,
      startTime: dateValue(pendingStartDate, pendingStartDateOnly, useDefaultStartTimeRef.current, pendingTimes.startTime),
      dueDate: dateValue(pendingDueDate, pendingDueDateOnly, false, pendingTimes.dueDate),
      reviewAt: dateValue(pendingReviewDate, pendingReviewDateOnly, false, pendingTimes.reviewAt),
      delegateWho,
      followUp: dateValue(delegateFollowUpDate, delegateFollowUpDateOnly, false, pendingTimes.followUp),
      convertToProject,
      nextAction: nextActionDraft,
      extraActions: extraActionDrafts,
      somedaySectionId: selectedSomedaySectionId ?? null,
      showAdvancedOptions,
      dirtyScheduleFields: Array.from(dirtyScheduleFieldsRef.current),
    };
  }, [
    convertToProject,
    delegateFollowUpDate,
    delegateFollowUpDateOnly,
    delegateWho,
    extraActionDrafts,
    newContext,
    nextActionDraft,
    pendingDueDate,
    pendingDueDateOnly,
    pendingReviewDate,
    pendingReviewDateOnly,
    pendingStartDate,
    pendingStartDateOnly,
    pendingTimes,
    processingDescription,
    processingTitle,
    projectSearch,
    selectedAreaId,
    selectedAssignedTo,
    selectedContexts,
    selectedEnergyLevel,
    selectedPriority,
    selectedProjectId,
    selectedSomedaySectionId,
    selectedTags,
    selectedTimeEstimate,
    showAdvancedOptions,
  ]);

  /**
   * A step button. Moves between questions here; a destination comes back as a
   * `commit` outcome for the step flow to run through `runCommit`.
   */
  const answerStep = useCallback((choice: string, mode: ProcessInboxMode): ProcessInboxChoiceOutcome => {
    if (!currentTask) return { type: 'invalid' };
    const outcome = answerProcessInboxStep({
      choice,
      answers,
      draft: buildDraft(),
      mode,
      plan: processInboxPlan,
      task: currentTask,
      parseTitle: parseProcessingTitle,
    });
    if (outcome.type !== 'flow') return outcome;
    setAnswers(outcome.answers);
    setConvertToProject(outcome.draft.convertToProject);
    setNextActionDraft(outcome.draft.nextAction);
    setExtraActionDrafts(outcome.draft.extraActions);
    setSelectedProjectId(outcome.draft.projectId);
    setProjectSearch(outcome.draft.projectSearch);
    scrollProcessingToTop(true);
    return outcome;
  }, [answers, buildDraft, currentTask, parseProcessingTitle, processInboxPlan, scrollProcessingToTop]);

  // Returns whether the decision was committed, so the presentation can hold
  // its completion feedback (haptic, Undo toast) until it lands.
  const runCommit = useCallback(async (kind: ProcessInboxCommitKind | 'convert'): Promise<boolean> => {
    if (!currentTask) return false;
    if (kind === 'convert') {
      if (projectConversionInFlightRef.current) return false;
      projectConversionInFlightRef.current = true;
    }
    // The draft is saved field by field onto the row as stored when the write is admitted (base: the task the draft
    // was filled from), so a field, tag or context another device synced since stays. Attachments merge the same way,
    // which appends the title's /link: attachments to the latest list. Fields nobody changed are written as before.
    const base = processingBaseRef.current?.id === currentTask.id ? processingBaseRef.current : currentTask;
    const updateTaskKeepingAttachments: typeof updateTask = (id, updates) => saveTaskDraftOntoLatest(id, base, updates, {
      write: updateTask,
      read: (taskId) => (taskId === base.id ? useTaskStore.getState()._tasksById?.get(taskId) : undefined),
      keepUntouched: true,
    });
    try {
      const result = await commitProcessInboxDecision(kind, {
        task: currentTask,
        draft: buildDraft(),
        plan: processInboxPlan,
        settings,
        projects,
        parseTitle: parseProcessingTitle,
        session: processingSession,
        candidates: inboxTasks,
        actions: { updateTask: updateTaskKeepingAttachments, deleteTask, addTask, addProject },
        t,
      });
      if (!result.ok) {
        // Extra actions already added are dropped, so a retry cannot repeat them.
        setExtraActionDrafts(result.draft.extraActions);
        if (result.error !== undefined) {
          void logWarn('Failed to create project from mobile inbox processing', {
            scope: 'inbox',
            extra: { error: result.error instanceof Error ? result.error.message : String(result.error) },
          });
        }
        if (result.notice) {
          showToast({
            title: result.notice.title,
            message: result.notice.message,
            tone: result.notice.tone,
            ...(result.notice.durationMs ? { durationMs: result.notice.durationMs } : {}),
          });
        }
        return false;
      }
      // Opening the next item primes all of its state. Nothing may reset state
      // after this: it would clear the next item's dates, and filing that item
      // would then erase them.
      if (!activateProcessingSession(result.session)) {
        handleClose();
      }
      return true;
    } finally {
      if (kind === 'convert') projectConversionInFlightRef.current = false;
    }
  }, [
    activateProcessingSession,
    addProject,
    addTask,
    buildDraft,
    currentTask,
    deleteTask,
    handleClose,
    inboxTasks,
    parseProcessingTitle,
    processInboxPlan,
    processingSession,
    projects,
    settings,
    showToast,
    t,
    updateTask,
  ]);

  // Capture the task generation before a decision runs. Toasts keep this exact
  // receipt, so a later decision cannot redirect an older queued Undo action.
  const createDecisionUndoReceipt = useCallback((kind: InboxDecisionUndoKind): InboxDecisionUndoReceipt | null => {
    if (!currentTask) return null;
    return {
      taskId: currentTask.id,
      kind,
      previousStatus: currentTask.status,
      wasFocusedToday: currentTask.isFocusedToday === true,
      restoreUpdates: buildProcessInboxUndoRestoreUpdates(currentTask),
    };
  }, [currentTask]);

  const undoDecision = useCallback(async (receipt: InboxDecisionUndoReceipt) => {
    try {
      if (receipt.kind === 'completed') {
        await undoTaskCompletion(
          receipt.taskId,
          receipt.previousStatus,
          receipt.wasFocusedToday,
          { restoreUpdates: receipt.restoreUpdates },
        );
        return;
      }
      // Refused (STALE_REVISION) when another device changed the task since; the toast says so.
      const result = receipt.kind === 'discarded'
        ? await restoreTask(receipt.taskId)
        : await restoreTaskSnapshot(receipt.taskId, receipt.restoreUpdates);
      if (isActionFailure(result)) {
        showProcessingError(getActionFailureMessage(result));
      }
    } catch (error) {
      // undoTaskCompletion throws its STALE_REVISION refusal.
      showProcessingError(getUnknownErrorMessage(error));
    }
  }, [restoreTask, showProcessingError]);

  const handleSendDelegateRequest = useCallback(async () => {
    if (!currentTask) return;
    const { subject, message } = buildProcessInboxDelegateRequest({
      title: processingTitle,
      description: processingDescription,
      taskTitle: currentTask.title,
      taskDescription: currentTask.description,
      who: delegateWho,
    });
    await Share.share({ message, title: subject }).catch(() => {
      showToast({
        title: t('common.notice'),
        message: t('process.delegateSendError'),
        tone: 'warning',
      });
    });
  }, [currentTask, delegateWho, processingDescription, processingTitle, showToast, t]);

  const toggleContext = useCallback((ctx: string) => {
    setSelectedContexts((prev) => toggleProcessInboxToken(prev, ctx));
  }, []);

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) => toggleProcessInboxToken(prev, tag));
  }, []);

  const applyTokenLists = useCallback((next: { contexts: string[]; tags: string[] } | null) => {
    if (!next) return;
    if (next.contexts !== selectedContexts) setSelectedContexts(next.contexts);
    if (next.tags !== selectedTags) setSelectedTags(next.tags);
    setNewContext('');
  }, [selectedContexts, selectedTags]);

  // `kind` is how a surface that shows contexts and tags separately says which
  // one an unprefixed entry belongs to; without it the prefix decides.
  const addCustomContextMobile = useCallback((kind?: 'context' | 'tag') => {
    applyTokenLists(addProcessInboxToken({
      tokenInput: newContext,
      kind,
      visible: { contexts: showContextsField, tags: showTagsField },
      contexts: selectedContexts,
      tags: selectedTags,
    }));
  }, [applyTokenLists, newContext, selectedContexts, selectedTags, showContextsField, showTagsField]);

  const applyTokenSuggestion = useCallback((token: string) => {
    applyTokenLists(applyProcessInboxTokenSuggestion({
      token,
      visible: { contexts: showContextsField, tags: showTagsField },
      contexts: selectedContexts,
      tags: selectedTags,
    }));
  }, [applyTokenLists, selectedContexts, selectedTags, showContextsField, showTagsField]);

  const selectProjectEarly = useCallback((projectId: string | null) => {
    const next = selectProcessInboxProject(projectId);
    setConvertToProject(next.convertToProject);
    setSelectedProjectId(next.projectId);
    if (next.areaId === null) setSelectedAreaId(null);
    setProjectSearch(next.projectSearch);
  }, []);

  const handleCreateProjectEarly = useCallback(async () => {
    const submit = resolveProcessInboxProjectSearchSubmit(projectSearch, exactProjectMatch, selectedAreaId);
    if (submit.type === 'none') return;
    if (submit.type === 'select') {
      selectProjectEarly(submit.projectId);
      return;
    }
    const created = await addProject(submit.title, submit.color, submit.props);
    if (!created) return;
    selectProjectEarly(created.id);
  }, [addProject, exactProjectMatch, projectSearch, selectProjectEarly, selectedAreaId]);

  const handleConvertToProject = useCallback(() => runCommit('convert'), [runCommit]);

  const handleSkipTask = useCallback(async () => {
    await runCommit('skip');
  }, [runCommit]);

  // After the full task editor closes: refill the draft from the saved task, so the screen shows the editor's
  // changes and filing does not write the draft's older values back (#1445). The user stays on the step they
  // were on, with its own answers kept. A task that left the Inbox is dropped by the queue, which moves on to
  // the next item.
  const reloadEditedTask = useCallback(() => {
    const base = processingBaseRef.current;
    const latest = base ? useTaskStore.getState()._tasksById?.get(base.id) : undefined;
    if (!base || !latest || (latest.updatedAt === base.updatedAt && latest.rev === base.rev)) return;
    primeTaskState(latest);
    setAnswers(answers);
    setDelegateWho(delegateWho);
    setDelegateFollowUpDate(delegateFollowUpDate);
    setDelegateFollowUpDateOnly(delegateFollowUpDateOnly);
    setConvertToProject(convertToProject);
    setNextActionDraft(nextActionDraft);
    setExtraActionDrafts(extraActionDrafts);
    void logInfo('Inbox processing reloaded the edited task', {
      scope: 'inbox', force: true, extra: { releaseCheck: 'v1.3.8/inbox-processing-editor-reload' },
    });
  }, [
    answers, convertToProject, delegateFollowUpDate, delegateFollowUpDateOnly, delegateWho, extraActionDrafts,
    nextActionDraft, primeTaskState,
  ]);

  const applyAppleClarificationStatus = useCallback((status: AppleClarificationSuggestion['status']) => {
    if (!status) return;
    if (status === 'someday' || status === 'reference') {
      setAnswers((previous) => ({ ...previous, actionability: status, twoMinute: null, execution: null }));
      return;
    }
    setAnswers((previous) => ({
      ...previous,
      actionability: 'actionable',
      twoMinute: 'no',
      execution: status === 'waiting' ? 'delegate' : 'defer',
    }));
  }, []);

  const applyAppleClarificationSuggestion = useCallback((suggestion: AppleClarificationSuggestion) => {
    setProcessingTitle(suggestion.cleanedTitle);
    if (suggestion.projectId) {
      setSelectedProjectId(suggestion.projectId);
      setSelectedAreaId(null);
    } else if (suggestion.areaId) {
      setSelectedAreaId(suggestion.areaId);
      setSelectedProjectId(null);
    }
    if (suggestion.contextIds.length > 0) {
      setSelectedContexts((previous) => Array.from(new Set([...previous, ...suggestion.contextIds])));
    }
    if (suggestion.tagIds.length > 0) {
      setSelectedTags((previous) => Array.from(new Set([...previous, ...suggestion.tagIds])));
    }
    if (suggestion.startDate) {
      const value = safeParseDate(suggestion.startDate);
      if (value) {
        dirtyScheduleFieldsRef.current.add('startTime');
        setPendingStartDate(value);
        setPendingStartDateOnly(true);
      }
    }
    if (suggestion.dueDate) {
      const value = safeParseDate(suggestion.dueDate);
      if (value) {
        dirtyScheduleFieldsRef.current.add('dueDate');
        setPendingDueDate(value);
        setPendingDueDateOnly(true);
      }
    }
    if (
      suggestion.projectId
      || suggestion.areaId
      || suggestion.contextIds.length > 0
      || suggestion.tagIds.length > 0
      || suggestion.startDate
      || suggestion.dueDate
    ) {
      setShowAdvancedOptions(true);
    }
    applyAppleClarificationStatus(suggestion.status);
  }, [applyAppleClarificationStatus]);

  const formatAppleClarificationPreview = useCallback((suggestion: AppleClarificationSuggestion): string => {
    const labels = new Map<string, string>();
    for (const project of projects) labels.set(project.id, project.title);
    for (const area of areas) labels.set(area.id, area.name);
    for (const value of [...contextSuggestionPool, ...tagSuggestionPool]) labels.set(value, value);
    const lines = [`Title: ${suggestion.cleanedTitle}`];
    if (suggestion.status) lines.push(`GTD status: ${suggestion.status}`);
    if (suggestion.projectId) lines.push(`Project: ${labels.get(suggestion.projectId) ?? suggestion.projectId}`);
    if (suggestion.areaId) lines.push(`Area: ${labels.get(suggestion.areaId) ?? suggestion.areaId}`);
    if (suggestion.contextIds.length > 0) lines.push(`Contexts: ${suggestion.contextIds.map((id) => labels.get(id) ?? id).join(', ')}`);
    if (suggestion.tagIds.length > 0) lines.push(`Tags: ${suggestion.tagIds.map((id) => labels.get(id) ?? id).join(', ')}`);
    if (suggestion.startDate) lines.push(`Start: ${suggestion.startDate} (date only)`);
    if (suggestion.dueDate) lines.push(`Due: ${suggestion.dueDate} (date only)`);
    return lines.join('\n');
  }, [areas, contextSuggestionPool, projects, tagSuggestionPool]);

  const handleAppleClarifyInbox = useCallback(async () => {
    const initialDraft = appleClarificationDraftRef.current;
    if (!currentTask || !initialDraft) return;

    cancelAppleClarification();
    const controller = new AbortController();
    activeAppleClarificationRef.current = controller;
    const requestId = `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const lease = createAppleClarificationLease(requestId, initialDraft);
    setIsAIWorking(true);
    try {
      const capability = await getAppleClarificationCapability(language);
      if (controller.signal.aborted || activeAppleClarificationRef.current !== controller) {
        throw new AppleClarificationCancelledError();
      }
      const draftBeforeRequest = appleClarificationDraftRef.current;
      if (!draftBeforeRequest || !isAppleClarificationLeaseCurrent(lease, draftBeforeRequest)) {
        void reportAppleClarificationOutcome('stale_ignored');
        return;
      }
      if (!capability.available) {
        showToast({
          title: tFallback(t, 'taskEdit.aiClarify', 'Clarify with AI'),
          message: describeAppleClarificationUnavailableReason(capability.reason),
          tone: 'warning',
          durationMs: 6200,
        });
        void reportAppleClarificationOutcome('unavailable', { reason: capability.reason ?? 'unknown' });
        return;
      }
      const candidates = buildAppleClarificationCandidates({
        title: initialDraft.title,
        description: initialDraft.description,
        projects,
        areas,
        contexts: contextSuggestionPool,
        tags: tagSuggestionPool,
        selectedProjectId,
        selectedAreaId,
        selectedContexts,
        selectedTags,
      });
      const suggestion = await requestAppleInboxClarification({
        requestId,
        locale: language,
        title: initialDraft.title,
        description: initialDraft.description,
        candidates,
      }, { signal: controller.signal });
      if (controller.signal.aborted || activeAppleClarificationRef.current !== controller) {
        throw new AppleClarificationCancelledError();
      }
      const currentDraft = appleClarificationDraftRef.current;
      if (!currentDraft || !isAppleClarificationLeaseCurrent(lease, currentDraft)) {
        void reportAppleClarificationOutcome('stale_ignored');
        return;
      }

      const apply = () => {
        const latestDraft = appleClarificationDraftRef.current;
        if (
          !latestDraft
          || !areAppleClarificationAssociationsCurrent(suggestion, appleClarificationAssociationsRef.current)
          || !consumeAppleClarificationApply(lease, latestDraft, consumedAppleClarificationRequestsRef.current)
        ) {
          closeAIModal();
          showToast({
            title: tFallback(t, 'common.notice', 'Notice'),
            message: tFallback(
              t,
              'ai.appleClarification.stale',
              'The item or its available associations changed. Ask for a fresh suggestion.',
            ),
            tone: 'warning',
          });
          return;
        }
        applyAppleClarificationSuggestion(suggestion);
        closeAIModal();
        void reportAppleClarificationOutcome('applied_to_draft', {
          statusIncluded: Boolean(suggestion.status),
          associationCount: suggestion.contextIds.length + suggestion.tagIds.length
            + Number(Boolean(suggestion.projectId)) + Number(Boolean(suggestion.areaId)),
          dateCount: Number(Boolean(suggestion.startDate)) + Number(Boolean(suggestion.dueDate)),
        });
      };
      setAiModal({
        title: tFallback(t, 'ai.appleClarification.suggestionTitle', 'On-device suggestion'),
        message: formatAppleClarificationPreview(suggestion),
        actions: [
          { label: t('ai.applySuggestion'), variant: 'primary', onPress: apply },
          { label: t('common.cancel'), variant: 'secondary', onPress: closeAIModal },
        ],
      });
      void reportAppleClarificationOutcome('suggestion_ready');
    } catch (error) {
      if (!(error instanceof AppleClarificationCancelledError)) {
        void logWarn('Apple Inbox clarification path failed', {
          scope: 'inbox',
          extra: {
            releaseCheck: APPLE_CLARIFICATION_RELEASE_CHECK,
            backend: 'apple_on_device',
            outcome: 'failed',
            failureClass: error instanceof Error ? error.name : 'unknown',
          },
        });
        Alert.alert(t('ai.errorTitle'), formatAIErrorAlertBody(t('ai.errorBody'), error));
      }
    } finally {
      if (activeAppleClarificationRef.current === controller) {
        activeAppleClarificationRef.current = null;
        setIsAIWorking(false);
      }
    }
  }, [
    applyAppleClarificationSuggestion,
    areas,
    cancelAppleClarification,
    closeAIModal,
    contextSuggestionPool,
    currentTask,
    formatAppleClarificationPreview,
    language,
    projects,
    selectedAreaId,
    selectedContexts,
    selectedProjectId,
    selectedTags,
    showToast,
    t,
    tagSuggestionPool,
  ]);

  const handleAIClarifyInbox = useCallback(async () => {
    if (!currentTask) return;
    if (appleClarificationBackend === 'on-device') {
      await handleAppleClarifyInbox();
      return;
    }
    if (!aiEnabled) {
      showToast({
        title: t('ai.errorTitle'),
        message: t('ai.disabledBody'),
        tone: 'warning',
        durationMs: 5200,
        actionLabel: openSettingsLabel,
        onAction: () => {
          router.push({ pathname: '/settings', params: { settingsScreen: 'ai' } });
        },
      });
      return;
    }
    let apiKey: string;
    try {
      apiKey = await loadAIKey(aiProvider);
    } catch (error) {
      // An unreadable keystore fails like a request, never as an unhandled rejection.
      void logWarn('Inbox processing failed', {
        scope: 'inbox',
        extra: { error: redactAIError(error, '', settings).message },
      });
      const alert = getAIErrorAlert(error, t, '', settings);
      Alert.alert(alert.title, alert.message);
      return;
    }
    if (isAIKeyRequired(settings) && !apiKey) {
      showToast({
        title: t('ai.errorTitle'),
        message: t('ai.missingKeyBody'),
        tone: 'warning',
        durationMs: 5200,
        actionLabel: openSettingsLabel,
        onAction: () => {
          router.push({ pathname: '/settings', params: { settingsScreen: 'ai' } });
        },
      });
      return;
    }
    setIsAIWorking(true);
    try {
      const provider = createAIProvider(buildAIConfig(settings ?? {}, apiKey, language));
      const response = await provider.clarifyTask(buildInboxClarifyInput({
        title: processingTitle,
        task: currentTask,
        contextPool: contextSuggestionPool,
        selectedContexts,
      }));
      const dialog = getAIClarifyDialog(response, t);
      const actions: AIResponseAction[] = dialog.choices.map((choice) => {
        const { apply } = choice;
        return {
          label: choice.label,
          ...(choice.variant ? { variant: choice.variant } : {}),
          onPress: apply.type === 'title'
            ? () => {
              setProcessingTitle(apply.title);
              closeAIModal();
            }
            : apply.type === 'suggestion'
              ? () => {
                setProcessingTitle(apply.suggestion.title);
                if (apply.suggestion.context) {
                  setSelectedContexts((prev) => Array.from(new Set([...prev, apply.suggestion.context!])));
                }
                closeAIModal();
              }
              : closeAIModal,
        };
      });
      setAiModal({
        title: dialog.title,
        actions,
      });
    } catch (error) {
      void logWarn('Inbox processing failed', {
        scope: 'inbox',
        extra: { error: redactAIError(error, apiKey, settings).message },
      });
      const alert = getAIErrorAlert(error, t, apiKey, settings);
      Alert.alert(alert.title, alert.message);
    } finally {
      setIsAIWorking(false);
    }
  }, [
    aiEnabled,
    aiProvider,
    appleClarificationBackend,
    closeAIModal,
    contextSuggestionPool,
    currentTask,
    handleAppleClarifyInbox,
    language,
    openSettingsLabel,
    processingTitle,
    router,
    selectedContexts,
    settings,
    showToast,
    t,
  ]);

  return {
    addCustomContextMobile,
    aiEnabled: aiClarifyEnabled,
    aiModal,
    answers,
    answerStep,
    applyTokenSuggestion,
    areaById,
    assignedToSuggestions,
    closeAIModal,
    contextCopilotSuggestions,
    convertToProject,
    createDecisionUndoReceipt,
    createSomedaySection,
    currentArea,
    currentProject,
    currentTask,
    defaultScheduleTime,
    delegateFollowUpDate,
    delegateFollowUpDateOnly,
    delegateWho,
    delegateWhoSuggestions,
    filteredProjects,
    formatProgressLabel,
    handleAIClarifyInbox,
    handleAICancelInbox: cancelAppleClarification,
    handleClose,
    handleConvertToProject,
    handleCreateProjectEarly,
    isReturningItem,
    undoDecision,
    handleSendDelegateRequest,
    handleSkipTask,
    hasExactProjectMatch,
    headerStyle,
    insets,
    isAIWorking,
    isAICancellable: isAIWorking && appleClarificationBackend === 'on-device',
    isDark,
    newContext,
    nextActionDraft,
    pendingDueDate,
    pendingDueDateOnly,
    pendingReviewDate,
    pendingReviewDateOnly,
    pendingStartDate,
    pendingStartDateOnly,
    pendingTimes,
    setPendingTime: setPendingTimeFromControl,
    timePickerField,
    setTimePickerField,
    processInboxPlan,
    processingDescription,
    processingScrollRef,
    processingTitle,
    processingTitleFocused,
    projectFirst,
    projectSearch,
    referenceEnabled,
    reloadEditedTask,
    runCommit,
    selectedAreaId,
    selectedAssignedTo,
    selectedContexts,
    selectedEnergyLevel,
    selectedPriority,
    selectedProjectId,
    selectedSomedaySectionId,
    selectedTags,
    selectedTimeEstimate,
    setSelectedAreaId,
    setSelectedAssignedTo,
    setDelegateFollowUpDate: setDelegateFollowUpDateFromControl,
    setDelegateFollowUpDateOnly: setDelegateFollowUpDateOnlyFromControl,
    setDelegateWho,
    setNewContext,
    setPendingDueDate: setPendingDueDateFromControl,
    setPendingDueDateOnly: setPendingDueDateOnlyFromControl,
    setPendingReviewDate: setPendingReviewDateFromControl,
    setPendingReviewDateOnly: setPendingReviewDateOnlyFromControl,
    setProjectSearch,
    setPendingStartDate: setPendingStartDateFromControl,
    setPendingStartDateOnly: setPendingStartDateOnlyFromControl,
    useDefaultStartTime: useDefaultStartTimeFromControl,
    setProcessingDescription,
    setProcessingTitle,
    setProcessingTitleFocused,
    setNextActionDraft,
    extraActionDrafts,
    setExtraActionDrafts,
    setSelectedEnergyLevel,
    setSelectedPriority,
    setSelectedSomedaySectionId,
    setSelectedTimeEstimate,
    setShowDelegateDatePicker,
    setShowDueDatePicker,
    setShowReviewDatePicker,
    setShowStartDatePicker,
    setShowAdvancedOptions,
    similarTaskProjectTitles,
    similarTasks,
    toggleAdvancedOptions,
    showDelegateDatePicker,
    showAreaField,
    showAssignedToField,
    showContextsField,
    showEnergyLevelField,
    showAdvancedOptions,
    showDueDateField,
    showDueDatePicker,
    showOrganizationSection,
    showPriorityField,
    showProjectField,
    showProjectSection,
    showReviewDateField,
    showReviewDatePicker,
    showSchedulingSection,
    showStartDatePicker,
    showStartDateField,
    showTagsField,
    showTimeEstimateField,
    somedaySections,
    t,
    tagCopilotSuggestions,
    tc,
    timeEstimateOptions,
    titleDirectionStyle,
    titleInputRef,
    tokenSuggestions,
    totalCount,
    selectProjectEarly,
    toggleContext,
    toggleTag,
    ENERGY_LEVEL_OPTIONS: PROCESS_INBOX_ENERGY_LEVEL_OPTIONS,
    PRIORITY_OPTIONS: PROCESS_INBOX_PRIORITY_OPTIONS,
    processedCount,
    progress,
  };
}
