import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  Share,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  advanceProcessInboxSession,
  addBreadcrumb,
  createProcessInboxSession,
  DEFAULT_PROJECT_COLOR,
  collectTaskTokenUsage,
  createAIProvider,
  filterProjectsBySelectedArea,
  formatAIErrorAlertBody,
  getProjectChoiceState,
  getProcessInboxCurrentCandidate,
  getProcessInboxRemainingCandidates,
  hasTimeComponent,
  normalizeClockTimeInput,
  resolveFeatureFlags,
  safeFormatDate,
  safeParseDate,
  isTaskVisibleInArea,
  selectProcessInboxCandidates,
  skipCurrentProcessInboxTask,
  startProcessInboxSession,
  tFallback,
  undoTaskCompletion,
  resolveAutoTextDirection,
  useTaskStore,
  type AIProviderId,
  type ProcessInboxSession,
  type Task,
  type TaskEditorFieldId,
  type TaskPriority,
  type TimeEstimate,
} from '@mindwtr/core';
import {
  commitProcessInboxWorkflowEvent,
  resolveProcessInboxContainerFields,
  type ProcessInboxWorkflowEvent,
  type ProcessInboxWorkflowFields,
} from '@mindwtr/core/process-inbox-workflow';

import type { AIResponseAction } from '../ai-response-modal';
import {
  DEFAULT_TASK_EDITOR_ORDER,
  DEFAULT_TASK_EDITOR_VISIBLE,
} from '../task-edit/task-edit-modal.utils';
import { MOBILE_TIME_ESTIMATE_OPTIONS } from '../time-estimate-filter-utils';
import { useLanguage } from '../../contexts/language-context';
import { useTheme } from '../../contexts/theme-context';
import { useToast } from '../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { getAssignedToSuggestions, rankTokenSuggestions } from '../task-metadata-suggestions';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logWarn } from '../../lib/app-log';
import {
  getActionFailureMessage,
  getUnknownErrorMessage,
  isActionFailure,
} from '../store-action-result';
import { styles } from '../inbox-processing-modal.styles';

const MAX_TOKEN_SUGGESTIONS = 6;
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: Array<NonNullable<Task['energyLevel']>> = ['low', 'medium', 'high'];
type ActionabilityChoice = 'actionable' | 'later' | 'trash' | 'someday' | 'reference' | null;
type TwoMinuteChoice = 'yes' | 'no' | null;
type ExecutionChoice = 'defer' | 'delegate' | null;

const buildInboxDecisionRestoreUpdates = (task: Task): Partial<Task> => ({
  title: task.title,
  description: task.description,
  status: task.status,
  projectId: task.projectId,
  sectionId: task.sectionId,
  areaId: task.areaId,
  contexts: [...task.contexts],
  tags: [...task.tags],
  priority: task.priority,
  energyLevel: task.energyLevel,
  assignedTo: task.assignedTo,
  timeEstimate: task.timeEstimate,
  startTime: task.startTime,
  dueDate: task.dueDate,
  reviewAt: task.reviewAt,
  recurrence: task.recurrence && typeof task.recurrence === 'object'
    ? { ...task.recurrence }
    : task.recurrence,
  relativeStartOffset: task.relativeStartOffset ? { ...task.relativeStartOffset } : undefined,
  suppressMindwtrReminders: task.suppressMindwtrReminders,
  repeatReminderMinutes: task.repeatReminderMinutes,
  showFutureRecurrence: task.showFutureRecurrence,
  isFocusedToday: task.isFocusedToday,
  focusOrder: task.focusOrder,
  boardOrder: task.boardOrder,
  pushCount: task.pushCount,
  completedAt: task.completedAt,
});

type InboxProcessingControllerParams = {
  visible: boolean;
  onClose: () => void;
};

export function useInboxProcessingController({
  visible,
  onClose,
}: InboxProcessingControllerParams) {
  const { tasks, projects, areas, people, settings, updateTask, deleteTask, restoreTask, addProject, addTask } = useTaskStore();
  const { t, language } = useLanguage();
  const { showToast } = useToast();
  const router = useRouter();
  const { isDark } = useTheme();
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();

  const [processingSession, setProcessingSession] = useState<ProcessInboxSession>(
    () => createProcessInboxSession(),
  );
  const [actionabilityChoice, setActionabilityChoice] = useState<ActionabilityChoice>(null);
  const [twoMinuteChoice, setTwoMinuteChoice] = useState<TwoMinuteChoice>(null);
  const [executionChoice, setExecutionChoice] = useState<ExecutionChoice>(null);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [newContext, setNewContext] = useState('');
  const [delegateWho, setDelegateWho] = useState('');
  const [delegateFollowUpDate, setDelegateFollowUpDate] = useState<Date | null>(null);
  const [delegateFollowUpDateOnly, setDelegateFollowUpDateOnly] = useState(false);
  const [showDelegateDatePicker, setShowDelegateDatePicker] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [convertToProject, setConvertToProject] = useState(false);
  const [projectTitleDraft, setProjectTitleDraft] = useState('');
  const [nextActionDraft, setNextActionDraft] = useState('');
  const [extraActionDrafts, setExtraActionDrafts] = useState<string[]>([]);
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
  const [laterNoDateSelected, setLaterNoDateSelected] = useState(false);
  const [pendingDueDate, setPendingDueDate] = useState<Date | null>(null);
  const [pendingDueDateOnly, setPendingDueDateOnly] = useState(false);
  const [pendingReviewDate, setPendingReviewDate] = useState<Date | null>(null);
  const [pendingReviewDateOnly, setPendingReviewDateOnly] = useState(false);
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
  const [showDueDatePicker, setShowDueDatePicker] = useState(false);
  const [showReviewDatePicker, setShowReviewDatePicker] = useState(false);
  const [isAIWorking, setIsAIWorking] = useState(false);
  const [aiModal, setAiModal] = useState<{ title: string; message?: string; actions: AIResponseAction[] } | null>(null);
  const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedPriority, setSelectedPriority] = useState<TaskPriority | undefined>(undefined);

  const titleInputRef = useRef<any>(null);
  const processingScrollRef = useRef<any>(null);
  const hasInitialized = useRef(false);
  // Last committed decision, kept so a presentation that auto-advances can
  // offer an Undo without re-deriving what it just did.
  const lastCommittedRef = useRef<{
    taskId: string;
    discarded: boolean;
    completed: boolean;
    previousStatus: Task['status'];
    wasFocusedToday: boolean;
    restoreUpdates: Partial<Task>;
  } | null>(null);

  const inboxProcessing = settings?.gtd?.inboxProcessing ?? {};
  const twoMinuteEnabled = inboxProcessing.twoMinuteEnabled !== false;
  const projectFirst = inboxProcessing.projectFirst === true;
  const contextStepEnabled = inboxProcessing.contextStepEnabled !== false;
  const scheduleEnabled = inboxProcessing.scheduleEnabled === true;
  const defaultScheduleTime = normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || '';
  const referenceEnabled = true;
  const { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled } = resolveFeatureFlags(settings);
  const aiEnabled = settings?.ai?.enabled === true;
  const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
  const defaultHiddenTaskEditorFields = useMemo(() => {
    const featureHiddenFields = new Set<TaskEditorFieldId>();
    if (!prioritiesEnabled) featureHiddenFields.add('priority');
    if (!timeEstimatesEnabled) featureHiddenFields.add('timeEstimate');
    return DEFAULT_TASK_EDITOR_ORDER.filter(
      (fieldId) => !DEFAULT_TASK_EDITOR_VISIBLE.includes(fieldId) || featureHiddenFields.has(fieldId)
    );
  }, [prioritiesEnabled, timeEstimatesEnabled]);
  const hiddenTaskEditorFields = useMemo(() => {
    const next = new Set<TaskEditorFieldId>(settings?.gtd?.taskEditor?.hidden ?? defaultHiddenTaskEditorFields);
    if (!prioritiesEnabled) next.add('priority');
    if (!timeEstimatesEnabled) next.add('timeEstimate');
    return next;
  }, [defaultHiddenTaskEditorFields, prioritiesEnabled, settings?.gtd?.taskEditor?.hidden, timeEstimatesEnabled]);
  const showProjectField = !hiddenTaskEditorFields.has('project');
  const showAreaField = !hiddenTaskEditorFields.has('area');
  const showContextsField = contextStepEnabled && !hiddenTaskEditorFields.has('contexts');
  const showTagsField = contextStepEnabled && !hiddenTaskEditorFields.has('tags');
  const showPriorityField = prioritiesEnabled && !hiddenTaskEditorFields.has('priority');
  const showEnergyLevelField = !hiddenTaskEditorFields.has('energyLevel');
  const showAssignedToField = !hiddenTaskEditorFields.has('assignedTo');
  const showTimeEstimateField = timeEstimatesEnabled && !hiddenTaskEditorFields.has('timeEstimate');
  const showStartDateField = scheduleEnabled && !hiddenTaskEditorFields.has('startTime');
  const showDueDateField = scheduleEnabled && !hiddenTaskEditorFields.has('dueDate');
  const showReviewDateField = scheduleEnabled && !hiddenTaskEditorFields.has('reviewAt');
  const showProjectSection = showProjectField || showAreaField;
  const showContextSection = showContextsField || showTagsField;
  const showOrganizationSection = showPriorityField || showEnergyLevelField || showAssignedToField || showTimeEstimateField;
  const showSchedulingSection = showStartDateField || showDueDateField || showReviewDateField;
  const timeEstimateOptions = useMemo<TimeEstimate[]>(() => {
    const savedPresets = settings?.gtd?.timeEstimatePresets ?? [];
    const normalizedPresets = MOBILE_TIME_ESTIMATE_OPTIONS.filter((value) => savedPresets.includes(value));
    if (normalizedPresets.length > 0) {
      return selectedTimeEstimate && !normalizedPresets.includes(selectedTimeEstimate)
        ? [...normalizedPresets, selectedTimeEstimate]
        : normalizedPresets;
    }
    return selectedTimeEstimate && !MOBILE_TIME_ESTIMATE_OPTIONS.includes(selectedTimeEstimate)
      ? [...MOBILE_TIME_ESTIMATE_OPTIONS, selectedTimeEstimate]
      : MOBILE_TIME_ESTIMATE_OPTIONS;
  }, [selectedTimeEstimate, settings?.gtd?.timeEstimatePresets]);

  const { areaById, visibility } = useVisibleTaskContext();
  const inboxTasks = useMemo(
    // Not `visibleTasks`: the queue is the process-inbox candidate set, which
    // has its own status rule on top of the shared visibility predicate.
    () => selectProcessInboxCandidates(tasks, (task) => isTaskVisibleInArea(task, visibility)),
    [tasks, visibility],
  );

  const processingQueue = useMemo(
    () => getProcessInboxRemainingCandidates(processingSession, inboxTasks),
    [inboxTasks, processingSession],
  );
  const currentTask = useMemo(
    () => getProcessInboxCurrentCandidate(processingSession, inboxTasks),
    [inboxTasks, processingSession],
  );
  const totalCount = inboxTasks.length;
  const processedCount = totalCount - processingQueue.length;
  const formatProgressLabel = useCallback((current: number, total: number) => {
    const taskLabel = t('common.tasks');
    if (total <= 0) return `0/0 ${taskLabel}`;
    return `${Math.max(0, current)}/${total} ${taskLabel}`;
  }, [t]);

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

  const contextSuggestionPool = useMemo(() => {
    return collectTaskTokenUsage(tasks, (task) => task.contexts, { prefix: '@' })
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.token.localeCompare(b.token))
      .map((entry) => entry.token);
  }, [tasks]);
  const tagSuggestionPool = useMemo(() => {
    return collectTaskTokenUsage(tasks, (task) => task.tags, { prefix: '#' })
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.token.localeCompare(b.token))
      .map((entry) => entry.token);
  }, [tasks]);
  const suggestionTerms = useMemo(() => {
    const raw = `${processingTitle} ${processingDescription} ${newContext}`.toLowerCase();
    const parts = raw
      .split(/[^a-z0-9@#]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .map((term) => term.replace(/^[@#]/, ''));
    return Array.from(new Set(parts)).slice(0, 10);
  }, [newContext, processingDescription, processingTitle]);
  const tokenDraft = newContext.trim();
  const tokenPrefix = tokenDraft.startsWith('#') ? '#' : tokenDraft.startsWith('@') ? '@' : '';
  const tokenQuery = tokenDraft.replace(/^[@#]+/, '').trim().toLowerCase();
  const tokenSuggestions = useMemo(() => {
    if (tokenQuery.length === 0) return [];
    const pool = [
      ...(tokenPrefix === '#' ? [] : showContextsField ? contextSuggestionPool : []),
      ...(tokenPrefix === '@' ? [] : showTagsField ? tagSuggestionPool : []),
    ];
    const selected = new Set([...selectedContexts, ...selectedTags]);
    const normalizedQuery = tokenQuery.toLowerCase();
    return pool
      .filter((item) => !selected.has(item))
      .filter((item) => item.slice(1).toLowerCase().includes(normalizedQuery))
      .slice(0, MAX_TOKEN_SUGGESTIONS);
  }, [
    contextSuggestionPool,
    selectedContexts,
    selectedTags,
    showContextsField,
    showTagsField,
    tagSuggestionPool,
    tokenPrefix,
    tokenQuery,
  ]);
  const assignedToSuggestions = useMemo(
    () => getAssignedToSuggestions(tasks, selectedAssignedTo, MAX_TOKEN_SUGGESTIONS, people),
    [people, selectedAssignedTo, tasks],
  );
  const delegateWhoSuggestions = useMemo(
    () => getAssignedToSuggestions(tasks, delegateWho, MAX_TOKEN_SUGGESTIONS, people),
    [delegateWho, people, tasks],
  );
  const contextCopilotSuggestions = useMemo(
    () => rankTokenSuggestions(contextSuggestionPool, selectedContexts, suggestionTerms, MAX_TOKEN_SUGGESTIONS),
    [contextSuggestionPool, selectedContexts, suggestionTerms],
  );
  const tagCopilotSuggestions = useMemo(
    () => rankTokenSuggestions(tagSuggestionPool, selectedTags, suggestionTerms, MAX_TOKEN_SUGGESTIONS),
    [selectedTags, suggestionTerms, tagSuggestionPool],
  );

  const projectFilterAreaId = selectedAreaId || undefined;
  const areaFilteredProjects = useMemo(
    () => filterProjectsBySelectedArea(projects, projectFilterAreaId),
    [projects, projectFilterAreaId],
  );
  const { filteredProjects, exactMatch: exactProjectMatch } = useMemo(
    () => getProjectChoiceState(areaFilteredProjects, projectSearch, projects),
    [areaFilteredProjects, projectSearch, projects],
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
  const projectTitle = currentProject?.title ?? null;
  const displayDescription = processingDescription || currentTask?.description || '';
  const showExecutionSection = actionabilityChoice === 'actionable' && (!twoMinuteEnabled || twoMinuteChoice === 'no');
  const showExecutionDetails = showExecutionSection && executionChoice !== null;
  const windowHeight = Dimensions.get('window').height;
  const taskDisplayMaxHeight = Math.max(220, Math.floor(windowHeight * 0.44));
  const descriptionMaxHeight = Math.max(120, Math.floor(windowHeight * 0.28));
  const isDecisionIncomplete = actionabilityChoice === null
    || (actionabilityChoice === 'actionable' && twoMinuteEnabled && twoMinuteChoice === null)
    || (actionabilityChoice === 'actionable' && (!twoMinuteEnabled || twoMinuteChoice === 'no') && executionChoice === null);
  const isNextTaskDisabled = isDecisionIncomplete;

  // Answering a question appends the next one below the fold, so on a phone the tap looks like it
  // did nothing until you scroll. Follow the reveal down instead.
  const scrollProcessingToRevealedStep = useCallback(() => {
    requestAnimationFrame(() => {
      processingScrollRef.current?.scrollToEnd?.({ animated: true });
    });
  }, []);

  const chooseActionability = useCallback((choice: Exclude<ActionabilityChoice, null>) => {
    setActionabilityChoice(choice);
    setTwoMinuteChoice(null);
    setExecutionChoice(null);
    scrollProcessingToRevealedStep();
  }, [scrollProcessingToRevealedStep]);

  const chooseTwoMinute = useCallback((choice: Exclude<TwoMinuteChoice, null>) => {
    setTwoMinuteChoice(choice);
    setExecutionChoice(null);
    scrollProcessingToRevealedStep();
  }, [scrollProcessingToRevealedStep]);

  const chooseExecution = useCallback((choice: ExecutionChoice) => {
    setExecutionChoice(choice);
    if (choice) scrollProcessingToRevealedStep();
  }, [scrollProcessingToRevealedStep]);

  // Step back to an earlier question: clearing one answer clears everything the
  // flow derived from it, so the next step can never be reached out of order.
  const clearDecision = useCallback((level: 'actionability' | 'twoMinute' | 'execution') => {
    if (level === 'actionability') setActionabilityChoice(null);
    if (level !== 'execution') setTwoMinuteChoice(null);
    setExecutionChoice(null);
  }, []);

  // "More options" reveals below the fold exactly like answering a question
  // does, so expanding follows the reveal down too; collapsing stays put.
  const toggleAdvancedOptions = useCallback(() => {
    setShowAdvancedOptions((previous) => {
      if (!previous) scrollProcessingToRevealedStep();
      return !previous;
    });
  }, [scrollProcessingToRevealedStep]);

  const formatScheduledDateValue = useCallback((date: Date, forceDateOnly: boolean = false): string => {
    const dateOnlyValue = safeFormatDate(date, 'yyyy-MM-dd');
    return defaultScheduleTime && !forceDateOnly ? `${dateOnlyValue}T${defaultScheduleTime}` : dateOnlyValue;
  }, [defaultScheduleTime]);

  const resetTitleFocus = useCallback(() => {
    setProcessingTitleFocused(false);
    titleInputRef.current?.blur?.();
  }, []);

  const scrollProcessingToTop = useCallback((animated: boolean = false) => {
    requestAnimationFrame(() => {
      processingScrollRef.current?.scrollTo?.({ y: 0, animated });
    });
  }, []);

  const primeTaskState = useCallback((task: Task | null | undefined) => {
    setActionabilityChoice(null);
    setTwoMinuteChoice(null);
    setExecutionChoice(null);
    setShowAdvancedOptions(Boolean(
      task?.projectId
      || task?.areaId
      || task?.contexts?.length
      || task?.tags?.length
      || task?.priority
      || task?.energyLevel
      || task?.assignedTo
      || task?.timeEstimate
      || task?.startTime
      || task?.dueDate
      || task?.reviewAt
    ));
    setPendingStartDate(task?.startTime ? safeParseDate(task.startTime) : null);
    setPendingStartDateOnly(Boolean(task?.startTime) && !hasTimeComponent(task?.startTime));
    setLaterNoDateSelected(false);
    setPendingDueDate(task?.dueDate ? safeParseDate(task.dueDate) : null);
    setPendingDueDateOnly(Boolean(task?.dueDate) && !hasTimeComponent(task?.dueDate));
    setPendingReviewDate(task?.reviewAt ? safeParseDate(task.reviewAt) : null);
    setPendingReviewDateOnly(Boolean(task?.reviewAt) && !hasTimeComponent(task?.reviewAt));
    setShowStartDatePicker(false);
    setShowDueDatePicker(false);
    setShowReviewDatePicker(false);
    setDelegateWho('');
    setDelegateFollowUpDate(null);
    setDelegateFollowUpDateOnly(false);
    setShowDelegateDatePicker(false);
    setConvertToProject(false);
    setProjectTitleDraft('');
    setNextActionDraft('');
    setExtraActionDrafts([]);
    setSelectedContexts(task?.contexts ?? []);
    setSelectedTags(task?.tags ?? []);
    setSelectedPriority(task?.priority);
    setSelectedEnergyLevel(task?.energyLevel);
    setSelectedAssignedTo(task?.assignedTo ?? '');
    setSelectedTimeEstimate(task?.timeEstimate);
    setNewContext('');
    setProjectSearch('');
    setSelectedProjectId(task?.projectId ?? null);
    // Keep an area assigned while the task sat in the inbox; a project home
    // outranks the direct area (container exclusivity).
    setSelectedAreaId(task?.projectId ? null : (task?.areaId ?? null));
    resetTitleFocus();
    setProcessingTitle(task?.title ?? '');
    setProcessingDescription(task?.description ?? '');
  }, [resetTitleFocus]);

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
    setProcessingSession(createProcessInboxSession());
    setAiModal(null);
    primeTaskState(null);
  }, [primeTaskState]);

  const handleClose = useCallback(() => {
    resetProcessingState();
    onClose();
  }, [onClose, resetProcessingState]);

  const closeAIModal = useCallback(() => setAiModal(null), []);

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

  const moveToNext = useCallback(() => {
    const nextSession = advanceProcessInboxSession(processingSession, inboxTasks);
    if (!activateProcessingSession(nextSession)) {
      handleClose();
    }
  }, [activateProcessingSession, handleClose, inboxTasks, processingSession]);

  const showProcessingError = useCallback((message?: string) => {
    showToast({
      title: tFallback(t, 'common.error', 'Error'),
      message: message || tFallback(t, 'task.updateFailed', 'Could not update task.'),
      tone: 'error',
      durationMs: 4200,
    });
  }, [showToast, t]);

  const prepareProcessingEdits = useCallback((titleOverride?: string, fallbackTitle?: string): Partial<Task> | null => {
    if (!currentTask) return null;
    const titleSource = titleOverride ?? processingTitle;
    const title = titleSource.trim() || fallbackTitle?.trim() || currentTask.title;
    const description = processingDescription.trim();
    return {
      title,
      description: description.length > 0 ? description : undefined,
    };
  }, [currentTask, processingDescription, processingTitle]);

  const applyWorkflowEvent = useCallback(async (
    event: ProcessInboxWorkflowEvent,
    titleOverride?: string,
    fallbackTitle?: string,
    options: { advance?: boolean } = {},
  ): Promise<boolean> => {
    if (!currentTask) return false;
    const taskUpdates = event.type === 'discard'
      ? undefined
      : prepareProcessingEdits(titleOverride, fallbackTitle);
    if (event.type !== 'discard' && !taskUpdates) return false;
    try {
      const outcome = await commitProcessInboxWorkflowEvent(
        processingSession,
        inboxTasks,
        event,
        { deleteTask, updateTask },
        { taskUpdates: taskUpdates ?? undefined, advance: options.advance },
      );
      if (isActionFailure(outcome.writeResult)) {
        showProcessingError(getActionFailureMessage(outcome.writeResult));
        return false;
      }
      lastCommittedRef.current = {
        taskId: currentTask.id,
        discarded: event.type === 'discard',
        completed: event.type === 'complete',
        previousStatus: currentTask.status,
        wasFocusedToday: currentTask.isFocusedToday === true,
        restoreUpdates: buildInboxDecisionRestoreUpdates(currentTask),
      };
      if (options.advance !== false && !activateProcessingSession(outcome.session)) {
        handleClose();
      }
      return true;
    } catch (error) {
      showProcessingError(getUnknownErrorMessage(error));
      return false;
    }
  }, [
    activateProcessingSession,
    currentTask,
    deleteTask,
    handleClose,
    inboxTasks,
    prepareProcessingEdits,
    processingSession,
    showProcessingError,
    updateTask,
  ]);

  // Terminal destinations that skip the project section still carry whatever
  // the user already picked; the state is hydrated from the task, so an
  // untouched selection writes back unchanged (#958).
  const buildSelectionFields = useCallback((): ProcessInboxWorkflowFields => ({
    ...resolveProcessInboxContainerFields(selectedProjectId, selectedAreaId),
    ...(showContextsField ? { contexts: selectedContexts } : {}),
    ...(showTagsField ? { tags: selectedTags } : {}),
  }), [selectedAreaId, selectedContexts, selectedProjectId, selectedTags, showContextsField, showTagsField]);

  // Undo the decision just committed: a discard is a soft delete that left the
  // task in the Inbox, everything else moved its status out of it.
  const undoLastDecision = useCallback(async () => {
    const committed = lastCommittedRef.current;
    if (!committed) return;
    try {
      if (committed.completed) {
        await undoTaskCompletion(
          committed.taskId,
          committed.previousStatus,
          committed.wasFocusedToday,
          { restoreUpdates: committed.restoreUpdates },
        );
        lastCommittedRef.current = null;
        return;
      }
      const result = committed.discarded
        ? await restoreTask(committed.taskId)
        : await updateTask(committed.taskId, committed.restoreUpdates);
      if (isActionFailure(result)) {
        showProcessingError(getActionFailureMessage(result));
        return;
      }
      lastCommittedRef.current = null;
    } catch (error) {
      showProcessingError(getUnknownErrorMessage(error));
    }
  }, [restoreTask, showProcessingError, updateTask]);

  const handleNotActionable = useCallback(async (action: 'trash' | 'someday' | 'reference') => {
    if (!currentTask) return false;
    if (action === 'trash') {
      return applyWorkflowEvent({ type: 'discard' });
    }
    if (action === 'someday') {
      return applyWorkflowEvent({ type: 'someday', fields: buildSelectionFields() });
    }
    return applyWorkflowEvent({ type: 'reference', fields: buildSelectionFields() });
  }, [applyWorkflowEvent, buildSelectionFields, currentTask]);

  const handleLaterMobile = useCallback(async () => {
    if (!currentTask) return false;
    const startDate = pendingStartDate;
    if (!startDate && !laterNoDateSelected) {
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'process.laterStartRequired', 'Choose a start date for Later.'),
        tone: 'warning',
      });
      return false;
    }
    const applied = await applyWorkflowEvent({
      type: 'later',
      fields: {
        ...(showProjectField ? { projectId: selectedProjectId ?? undefined } : {}),
        ...(showAreaField ? { areaId: selectedProjectId ? undefined : (selectedAreaId ?? undefined) } : {}),
        startTime: startDate ? formatScheduledDateValue(startDate, pendingStartDateOnly) : undefined,
      },
    });
    if (!applied) return false;
    setPendingStartDate(null);
    setLaterNoDateSelected(false);
    return true;
  }, [
    applyWorkflowEvent,
    currentTask,
    formatScheduledDateValue,
    laterNoDateSelected,
    pendingStartDate,
    pendingStartDateOnly,
    selectedAreaId,
    selectedProjectId,
    showAreaField,
    showProjectField,
    showToast,
    t,
  ]);

  const handleTwoMinYes = useCallback(async () => {
    if (!currentTask) return false;
    return applyWorkflowEvent({ type: 'complete', fields: buildSelectionFields() });
  }, [applyWorkflowEvent, buildSelectionFields, currentTask]);

  const buildScheduleUpdates = useCallback(() => {
    const updates: Partial<Task> = {};
    if (showStartDateField) {
      updates.startTime = pendingStartDate ? formatScheduledDateValue(pendingStartDate, pendingStartDateOnly) : undefined;
    }
    if (showDueDateField) {
      updates.dueDate = pendingDueDate ? formatScheduledDateValue(pendingDueDate, pendingDueDateOnly) : undefined;
    }
    if (showReviewDateField) {
      updates.reviewAt = pendingReviewDate ? formatScheduledDateValue(pendingReviewDate, pendingReviewDateOnly) : undefined;
    }
    return updates;
  }, [
    formatScheduledDateValue,
    pendingDueDate,
    pendingDueDateOnly,
    pendingReviewDate,
    pendingReviewDateOnly,
    pendingStartDate,
    pendingStartDateOnly,
    showDueDateField,
    showReviewDateField,
    showStartDateField,
  ]);

  const handleConfirmWaitingMobile = useCallback(async () => {
    if (!currentTask) return false;
    const who = delegateWho.trim() || selectedAssignedTo.trim();
    const fields: Partial<Task> = {
      assignedTo: who || undefined,
      ...(showPriorityField ? { priority: selectedPriority ?? undefined } : {}),
      ...(showEnergyLevelField ? { energyLevel: selectedEnergyLevel ?? undefined } : {}),
      ...(showTimeEstimateField ? { timeEstimate: selectedTimeEstimate ?? undefined } : {}),
      ...(showProjectField ? { projectId: selectedProjectId ?? undefined } : {}),
      ...(showAreaField ? { areaId: selectedProjectId ? undefined : (selectedAreaId ?? undefined) } : {}),
      ...(showContextsField ? { contexts: selectedContexts } : {}),
      ...(showTagsField ? { tags: selectedTags } : {}),
      ...buildScheduleUpdates(),
    };
    const applied = await applyWorkflowEvent({
      type: 'waiting',
      fields,
      followUpAt: delegateFollowUpDate
        ? formatScheduledDateValue(delegateFollowUpDate, delegateFollowUpDateOnly)
        : undefined,
    });
    if (!applied) return false;
    setDelegateWho('');
    setDelegateFollowUpDate(null);
    return true;
  }, [
    applyWorkflowEvent,
    buildScheduleUpdates,
    currentTask,
    delegateFollowUpDate,
    delegateFollowUpDateOnly,
    delegateWho,
    formatScheduledDateValue,
    selectedAreaId,
    selectedAssignedTo,
    selectedContexts,
    selectedEnergyLevel,
    selectedPriority,
    selectedProjectId,
    selectedTags,
    selectedTimeEstimate,
    showAreaField,
    showContextsField,
    showEnergyLevelField,
    showPriorityField,
    showProjectField,
    showTagsField,
    showTimeEstimateField,
  ]);

  const handleSendDelegateRequest = useCallback(async () => {
    if (!currentTask) return;
    const title = processingTitle.trim() || currentTask.title;
    const baseDescription = processingDescription.trim() || currentTask.description || '';
    const who = delegateWho.trim();
    const greeting = who ? `Hi ${who},` : 'Hi,';
    const body = [
      greeting,
      '',
      `Could you please handle: ${title}`,
      baseDescription ? `\nDetails:\n${baseDescription}` : '',
      '',
      'Thanks!',
    ].join('\n');
    const subject = `Delegation: ${title}`;
    await Share.share({ message: body, title: subject }).catch(() => {
      showToast({
        title: t('common.notice'),
        message: t('process.delegateSendError'),
        tone: 'warning',
      });
    });
  }, [currentTask, delegateWho, processingDescription, processingTitle, showToast, t]);

  const toggleContext = useCallback((ctx: string) => {
    setSelectedContexts((prev) =>
      prev.includes(ctx) ? prev.filter((item) => item !== ctx) : [...prev, ctx]
    );
  }, []);

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]
    );
  }, []);

  // `kind` is how a surface that shows contexts and tags separately says which
  // one an unprefixed entry belongs to; without it the prefix decides.
  const addCustomContextMobile = useCallback((kind?: 'context' | 'tag') => {
    const trimmed = newContext.trim();
    if (!trimmed) return;
    if (kind === 'tag' && showTagsField) {
      const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
      if (!selectedTags.includes(normalized)) {
        setSelectedTags((prev) => [...prev, normalized]);
      }
      setNewContext('');
      return;
    }
    if (kind === 'context' && showContextsField) {
      const normalized = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
      if (!selectedContexts.includes(normalized)) {
        setSelectedContexts((prev) => [...prev, normalized]);
      }
      setNewContext('');
      return;
    }
    if (showTagsField && (trimmed.startsWith('#') || !showContextsField)) {
      const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
      if (!selectedTags.includes(normalized)) {
        setSelectedTags((prev) => [...prev, normalized]);
      }
    } else if (showContextsField) {
      const normalized = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
      if (!selectedContexts.includes(normalized)) {
        setSelectedContexts((prev) => [...prev, normalized]);
      }
    }
    setNewContext('');
  }, [newContext, selectedContexts, selectedTags, showContextsField, showTagsField]);

  const applyTokenSuggestion = useCallback((token: string) => {
    if (token.startsWith('#')) {
      if (!showTagsField) return;
      if (!selectedTags.includes(token)) {
        setSelectedTags((prev) => [...prev, token]);
      }
    } else {
      if (!showContextsField || selectedContexts.includes(token)) return;
      setSelectedContexts((prev) => [...prev, token]);
    }
    setNewContext('');
  }, [selectedContexts, selectedTags, showContextsField, showTagsField]);

  const selectProjectEarly = useCallback((projectId: string | null) => {
    setConvertToProject(false);
    setSelectedProjectId(projectId);
    if (projectId) {
      setSelectedAreaId(null);
    }
    setProjectSearch('');
  }, []);

  const handleCreateProjectEarly = useCallback(async () => {
    const title = projectSearch.trim();
    if (!title) return;
    if (exactProjectMatch) {
      selectProjectEarly(exactProjectMatch.id);
      return;
    }
    const created = await addProject(
      title,
      DEFAULT_PROJECT_COLOR,
      projectFilterAreaId ? { areaId: projectFilterAreaId } : undefined,
    );
    if (!created) return;
    selectProjectEarly(created.id);
  }, [addProject, exactProjectMatch, projectFilterAreaId, projectSearch, selectProjectEarly]);

  const handleProjectConversionStart = useCallback(() => {
    const baseTitle = processingTitle.trim() || currentTask?.title || '';
    setConvertToProject(true);
    setProjectTitleDraft((prev) => prev.trim() || baseTitle);
    setNextActionDraft((prev) => prev.trim() || baseTitle);
    setSelectedProjectId(null);
    setProjectSearch('');
  }, [currentTask?.title, processingTitle]);

  const handleProjectConversionCancel = useCallback(() => {
    setConvertToProject(false);
    setProjectTitleDraft('');
    setNextActionDraft('');
    setExtraActionDrafts([]);
  }, []);

  const finalizeNextAction = useCallback(async (projectId: string | null) => {
    const applied = await applyWorkflowEvent({
      type: 'next',
      fields: {
        ...(showProjectField ? { projectId: projectId ?? undefined } : {}),
        ...(showAreaField ? { areaId: projectId ? undefined : (selectedAreaId ?? undefined) } : {}),
        ...(showContextsField ? { contexts: selectedContexts } : {}),
        ...(showTagsField ? { tags: selectedTags } : {}),
        ...(showPriorityField ? { priority: selectedPriority ?? undefined } : {}),
        ...(showEnergyLevelField ? { energyLevel: selectedEnergyLevel ?? undefined } : {}),
        ...(showAssignedToField ? { assignedTo: selectedAssignedTo.trim() || undefined } : {}),
        ...(showTimeEstimateField ? { timeEstimate: selectedTimeEstimate ?? undefined } : {}),
        ...buildScheduleUpdates(),
      },
    });
    if (!applied) return false;
    setPendingStartDate(null);
    setPendingDueDate(null);
    setPendingReviewDate(null);
    return true;
  }, [
    applyWorkflowEvent,
    buildScheduleUpdates,
    selectedAreaId,
    selectedAssignedTo,
    selectedContexts,
    selectedEnergyLevel,
    selectedPriority,
    selectedTimeEstimate,
    selectedTags,
    showAreaField,
    showAssignedToField,
    showContextsField,
    showEnergyLevelField,
    showPriorityField,
    showProjectField,
    showTagsField,
    showTimeEstimateField,
  ]);

  const handleConvertToProject = useCallback(async (): Promise<boolean> => {
    if (!currentTask) return false;
    const projectTitle = projectTitleDraft.trim() || processingTitle.trim() || currentTask.title;
    const nextAction = nextActionDraft.trim();
    if (!projectTitle) return false;
    if (!nextAction) {
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'process.nextActionRequired', 'Add a next action before creating the project.'),
        tone: 'warning',
      });
      return false;
    }

    try {
      const existing = projects.find((project) => project.title.toLowerCase() === projectTitle.toLowerCase());
      const project = existing ?? await addProject(
        projectTitle,
        DEFAULT_PROJECT_COLOR,
        showAreaField && selectedAreaId ? { areaId: selectedAreaId } : undefined,
      );
      if (!project) return false;

      const applied = await applyWorkflowEvent({
        type: 'next',
        fields: {
          projectId: project.id,
          ...(showAreaField ? { areaId: undefined } : {}),
          ...(showContextsField ? { contexts: selectedContexts } : {}),
          ...(showTagsField ? { tags: selectedTags } : {}),
          ...(showPriorityField ? { priority: selectedPriority ?? undefined } : {}),
          ...(showEnergyLevelField ? { energyLevel: selectedEnergyLevel ?? undefined } : {}),
          ...(showAssignedToField ? { assignedTo: selectedAssignedTo.trim() || undefined } : {}),
          ...(showTimeEstimateField ? { timeEstimate: selectedTimeEstimate ?? undefined } : {}),
          ...buildScheduleUpdates(),
        },
      }, nextAction, currentTask.title, { advance: false });
      if (!applied) return false;

      // The converted capture becomes the project's clarified next action.
      // Extra actions typed at the split step are raw captures, so they
      // return to the Inbox (project attached) for their own clarify pass —
      // same semantics as a quick-add with a +Project token (#827).
      const extraActions = extraActionDrafts.map((title) => title.trim()).filter(Boolean);
      for (const title of extraActions) {
        const result = await addTask(title, { status: 'inbox', projectId: project.id });
        if (isActionFailure(result)) {
          showProcessingError(getActionFailureMessage(result));
          return false;
        }
      }
      setExtraActionDrafts([]);
      setPendingStartDate(null);
      setPendingDueDate(null);
      setPendingReviewDate(null);
      setConvertToProject(false);
      moveToNext();
      return true;
    } catch (error) {
      void logWarn('Failed to create project from mobile inbox processing', {
        scope: 'inbox',
        extra: { error: error instanceof Error ? error.message : String(error) },
      });
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'projects.createFailed', 'Failed to create project.'),
        tone: 'error',
      });
      return false;
    }
  }, [
    addProject,
    addTask,
    applyWorkflowEvent,
    buildScheduleUpdates,
    currentTask,
    extraActionDrafts,
    moveToNext,
    nextActionDraft,
    processingTitle,
    projectTitleDraft,
    projects,
    selectedAreaId,
    selectedAssignedTo,
    selectedContexts,
    selectedEnergyLevel,
    selectedPriority,
    selectedTags,
    selectedTimeEstimate,
    showAreaField,
    showAssignedToField,
    showContextsField,
    showEnergyLevelField,
    showPriorityField,
    showProcessingError,
    showTagsField,
    showTimeEstimateField,
    showToast,
    t,
  ]);

  // Returns whether the decision was actually committed, so the presentation
  // can hold its completion feedback (haptic, Undo toast) until it lands.
  const handleNextTask = useCallback(async (): Promise<boolean> => {
    if (!currentTask) return false;
    if (!actionabilityChoice) return false;
    if (actionabilityChoice === 'later') {
      return handleLaterMobile();
    }
    if (actionabilityChoice === 'trash' || actionabilityChoice === 'someday' || actionabilityChoice === 'reference') {
      return handleNotActionable(actionabilityChoice);
    }
    if (twoMinuteEnabled && twoMinuteChoice === 'yes') {
      return handleTwoMinYes();
    }
    if (!executionChoice) return false;
    if (executionChoice === 'delegate') {
      return handleConfirmWaitingMobile();
    }
    if (convertToProject) {
      return handleConvertToProject();
    }
    return finalizeNextAction(selectedProjectId);
  }, [
    actionabilityChoice,
    convertToProject,
    currentTask,
    executionChoice,
    finalizeNextAction,
    handleConfirmWaitingMobile,
    handleConvertToProject,
    handleLaterMobile,
    handleNotActionable,
    handleTwoMinYes,
    selectedProjectId,
    twoMinuteChoice,
    twoMinuteEnabled,
  ]);

  const handleSkipTask = useCallback(async () => {
    if (!currentTask) return;
    const taskUpdates = prepareProcessingEdits();
    if (!taskUpdates) return;
    try {
      const result = await updateTask(currentTask.id, {
        ...taskUpdates,
        ...(showProjectField ? { projectId: selectedProjectId ?? undefined } : {}),
        ...(showAreaField ? { areaId: selectedProjectId ? undefined : (selectedAreaId ?? undefined) } : {}),
        ...(showContextsField ? { contexts: selectedContexts } : {}),
        ...(showTagsField ? { tags: selectedTags } : {}),
        ...(showPriorityField ? { priority: selectedPriority ?? undefined } : {}),
        ...(showEnergyLevelField ? { energyLevel: selectedEnergyLevel ?? undefined } : {}),
        ...(showAssignedToField ? { assignedTo: selectedAssignedTo.trim() || undefined } : {}),
        ...(showTimeEstimateField ? { timeEstimate: selectedTimeEstimate ?? undefined } : {}),
        ...buildScheduleUpdates(),
      });
      if (isActionFailure(result)) {
        showProcessingError(getActionFailureMessage(result));
        return;
      }
    } catch (error) {
      showProcessingError(getUnknownErrorMessage(error));
      return;
    }
    const nextSession = skipCurrentProcessInboxTask(processingSession, inboxTasks);
    if (!activateProcessingSession(nextSession)) handleClose();
  }, [
    activateProcessingSession,
    buildScheduleUpdates,
    currentTask,
    handleClose,
    inboxTasks,
    prepareProcessingEdits,
    processingSession,
    selectedAreaId,
    selectedAssignedTo,
    selectedContexts,
    selectedEnergyLevel,
    selectedPriority,
    selectedProjectId,
    selectedTimeEstimate,
    selectedTags,
    showAreaField,
    showAssignedToField,
    showContextsField,
    showEnergyLevelField,
    showPriorityField,
    showProjectField,
    showTagsField,
    showTimeEstimateField,
    showProcessingError,
    updateTask,
  ]);

  const handleAIClarifyInbox = useCallback(async () => {
    if (!currentTask) return;
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
    const apiKey = await loadAIKey(aiProvider);
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
      const provider = createAIProvider(buildAIConfig(settings ?? {}, apiKey));
      const contextOptions = Array.from(new Set([
        ...contextSuggestionPool,
        ...selectedContexts,
        ...(currentTask.contexts ?? []),
      ]));
      const response = await provider.clarifyTask({
        title: processingTitle || currentTask.title,
        contexts: contextOptions,
      });
      const actions: AIResponseAction[] = [];
      response.options.slice(0, 3).forEach((option) => {
        actions.push({
          label: option.label,
          onPress: () => {
            setProcessingTitle(option.action);
            closeAIModal();
          },
        });
      });
      if (response.suggestedAction?.title) {
        actions.push({
          label: t('ai.applySuggestion'),
          variant: 'primary',
          onPress: () => {
            setProcessingTitle(response.suggestedAction!.title);
            if (response.suggestedAction?.context) {
              setSelectedContexts((prev) => Array.from(new Set([...prev, response.suggestedAction!.context!])));
            }
            closeAIModal();
          },
        });
      }
      actions.push({
        label: t('common.cancel'),
        variant: 'secondary',
        onPress: closeAIModal,
      });
      setAiModal({
        title: response.question || t('taskEdit.aiClarify'),
        actions,
      });
    } catch (error) {
      void logWarn('Inbox processing failed', {
        scope: 'inbox',
        extra: { error: error instanceof Error ? error.message : String(error) },
      });
      Alert.alert(t('ai.errorTitle'), formatAIErrorAlertBody(t('ai.errorBody'), error));
    } finally {
      setIsAIWorking(false);
    }
  }, [
    aiEnabled,
    aiProvider,
    closeAIModal,
    contextSuggestionPool,
    currentTask,
    openSettingsLabel,
    processingTitle,
    router,
    selectedContexts,
    settings,
    showToast,
    t,
  ]);

  return {
    actionabilityChoice,
    addCustomContextMobile,
    aiEnabled,
    aiModal,
    applyTokenSuggestion,
    areaById,
    assignedToSuggestions,
    clearDecision,
    closeAIModal,
    contextCopilotSuggestions,
    convertToProject,
    currentArea,
    currentProject,
    currentTask,
    defaultScheduleTime,
    delegateFollowUpDate,
    delegateFollowUpDateOnly,
    delegateWho,
    delegateWhoSuggestions,
    descriptionMaxHeight,
    displayDescription,
    executionChoice,
    filteredProjects,
    formatProgressLabel,
    handleAIClarifyInbox,
    handleClose,
    handleConfirmWaitingMobile,
    handleConvertToProject,
    handleCreateProjectEarly,
    handleLaterMobile,
    handleNextTask,
    handleNotActionable,
    handleTwoMinYes,
    finalizeNextAction,
    undoLastDecision,
    handleProjectConversionCancel,
    handleProjectConversionStart,
    handleSendDelegateRequest,
    handleSkipTask,
    hasExactProjectMatch,
    headerStyle,
    insets,
    isAIWorking,
    isDark,
    isNextTaskDisabled,
    newContext,
    nextActionDraft,
    laterNoDateSelected,
    pendingDueDate,
    pendingDueDateOnly,
    pendingReviewDate,
    pendingReviewDateOnly,
    pendingStartDate,
    pendingStartDateOnly,
    processingDescription,
    processingScrollRef,
    processingTitle,
    processingTitleFocused,
    projectFirst,
    projectSearch,
    projectTitleDraft,
    projectTitle,
    referenceEnabled,
    selectedAreaId,
    selectedAssignedTo,
    selectedContexts,
    selectedEnergyLevel,
    selectedPriority,
    selectedProjectId,
    selectedTags,
    selectedTimeEstimate,
    setSelectedAreaId,
    setSelectedAssignedTo,
    setActionabilityChoice: chooseActionability,
    setDelegateFollowUpDate,
    setDelegateFollowUpDateOnly,
    setDelegateWho,
    setExecutionChoice: chooseExecution,
    setNewContext,
    setLaterNoDateSelected,
    setPendingDueDate,
    setPendingDueDateOnly,
    setPendingReviewDate,
    setPendingReviewDateOnly,
    setProjectSearch,
    setPendingStartDate,
    setPendingStartDateOnly,
    setProcessingDescription,
    setProcessingTitle,
    setProcessingTitleFocused,
    setProjectTitleDraft,
    setNextActionDraft,
    extraActionDrafts,
    setExtraActionDrafts,
    setSelectedEnergyLevel,
    setSelectedPriority,
    setSelectedTimeEstimate,
    setShowDelegateDatePicker,
    setShowDueDatePicker,
    setShowReviewDatePicker,
    setShowStartDatePicker,
    setShowAdvancedOptions,
    toggleAdvancedOptions,
    showDelegateDatePicker,
    showAreaField,
    showAssignedToField,
    showContextSection,
    showContextsField,
    showEnergyLevelField,
    showExecutionSection,
    showExecutionDetails,
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
    t,
    tagCopilotSuggestions,
    taskDisplayMaxHeight,
    tc,
    timeEstimateOptions,
    titleDirectionStyle,
    titleInputRef,
    tokenSuggestions,
    totalCount,
    twoMinuteChoice,
    twoMinuteEnabled,
    setTwoMinuteChoice: chooseTwoMinute,
    selectProjectEarly,
    toggleContext,
    toggleTag,
    ENERGY_LEVEL_OPTIONS,
    PRIORITY_OPTIONS,
    processedCount,
  };
}
