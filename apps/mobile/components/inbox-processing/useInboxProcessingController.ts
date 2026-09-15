import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Dimensions,
  Platform,
  Share,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  advanceProcessInboxSession,
  addBreadcrumb,
  buildQuickAddParseOptions,
  createProcessInboxSession,
  DEFAULT_PROJECT_COLOR,
  collectTaskTokenUsage,
  createAIProvider,
  createTaskSimilarityIndex,
  filterProjectsBySelectedArea,
  findSimilarTasks,
  formatAIErrorAlertBody,
  getProjectChoiceState,
  getProcessInboxCurrentCandidate,
  getProcessInboxRemainingCandidates,
  hasTimeComponent,
  isProcessInboxReturningTask,
  isSelectableProjectForTaskAssignment,
  normalizeClockTimeInput,
  parseProcessInboxTitleInput,
  prepareProcessInboxDecision,
  resolveProcessInboxPlan,
  safeFormatDate,
  safeParseDate,
  setTaskViewSectionId,
  isTaskVisibleInInbox,
  selectProcessInboxCandidates,
  startProcessInboxSession,
  sortViewSectionDefinitions,
  tFallback,
  undoTaskCompletion,
  resolveAutoTextDirection,
  useTaskStore,
  type AIProviderId,
  type ProcessInboxDecision,
  type ProcessInboxSession,
  type Task,
  type TaskPriority,
  type TimeEstimate,
} from '@mindwtr/core';
import {
  commitProcessInboxWorkflowEvent,
  mergeParsedProcessInboxFields,
  type ProcessInboxWorkflowFields,
} from '@mindwtr/core/process-inbox-workflow';

import type { AIResponseAction } from '../ai-response-modal';
import { MOBILE_TIME_ESTIMATE_OPTIONS } from '../time-estimate-filter-utils';
import { useLanguage } from '../../contexts/language-context';
import { useTheme } from '../../contexts/theme-context';
import { useToast } from '../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { getAssignedToSuggestions, rankTokenSuggestions } from '../task-metadata-suggestions';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logWarn } from '../../lib/app-log';
import { readAppleClarificationBackend } from '../../lib/apple-clarification-preference';
import {
  APPLE_CLARIFICATION_RELEASE_CHECK,
  AppleClarificationCancelledError,
  describeAppleClarificationUnavailableReason,
  getAppleClarificationCapability,
  isAppleClarificationPrototypeEnabled,
  reportAppleClarificationOutcome,
  requestAppleInboxClarification,
} from '../../lib/apple-foundation-models';
import { readNanoClarificationBackend } from '../../lib/nano-clarification-preference';
import {
  NANO_CLARIFICATION_RELEASE_CHECK,
  NanoClarificationCancelledError,
  NanoClarificationError,
  describeNanoClarificationUnavailableReason,
  getNanoClarificationCapability,
  isNanoClarificationPrototypeEnabled,
  reportNanoClarificationOutcome,
  requestNanoInboxClarification,
} from '../../lib/nano-clarification';
import {
  OnDeviceClarificationInputError,
  OnDeviceClarificationOutputError,
  areOnDeviceClarificationAssociationsCurrent,
  buildOnDeviceClarificationCandidates,
  consumeOnDeviceClarificationApply,
  createOnDeviceClarificationLease,
  isOnDeviceClarificationLeaseCurrent,
  type OnDeviceClarificationDraftSnapshot,
  type OnDeviceClarificationSuggestion,
} from '../../lib/on-device-clarification';
import { createSomedaySection as persistSomedaySection } from '../../lib/someday-section-actions';
import {
  getActionFailureMessage,
  getUnknownErrorMessage,
  isActionFailure,
} from '../store-action-result';
import { styles } from '../inbox-processing-modal.styles';

const MAX_TOKEN_SUGGESTIONS = 6;
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: NonNullable<Task['energyLevel']>[] = ['low', 'medium', 'high'];
type ActionabilityChoice = 'actionable' | 'later' | 'incubate' | 'trash' | 'someday' | 'reference' | null;
type TwoMinuteChoice = 'yes' | 'no' | null;
type ExecutionChoice = 'defer' | 'delegate' | null;
type InboxDecisionUndoKind = 'discarded' | 'completed' | 'filed';
type InboxDecisionUndoReceipt = Readonly<{
  taskId: string;
  kind: InboxDecisionUndoKind;
  previousStatus: Task['status'];
  wasFocusedToday: boolean;
  restoreUpdates: Partial<Task>;
}>;

const buildInboxDecisionRestoreUpdates = (task: Task): Partial<Task> => ({
  title: task.title,
  description: task.description,
  status: task.status,
  projectId: task.projectId,
  sectionId: task.sectionId,
  viewSectionIds: task.viewSectionIds ? { ...task.viewSectionIds } : undefined,
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
  attachments: task.attachments?.map((attachment) => ({ ...attachment })),
});

type InboxProcessingControllerParams = {
  visible: boolean;
  onClose: () => void;
};

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
  const [isAIWorking, setIsAIWorking] = useState(false);
  const [onDeviceClarificationBackend, setOnDeviceClarificationBackend] = useState<'configured' | 'on-device'>('configured');
  const [aiModal, setAiModal] = useState<{ title: string; message?: string; actions: AIResponseAction[] } | null>(null);
  const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedPriority, setSelectedPriority] = useState<TaskPriority | undefined>(undefined);
  const [selectedSomedaySectionId, setSelectedSomedaySectionId] = useState<string | undefined>(undefined);
  const dirtyScheduleFieldsRef = useRef(new Set<'startTime' | 'dueDate' | 'reviewAt'>());
  const activeOnDeviceClarificationRef = useRef<AbortController | null>(null);
  const readyOnDeviceClarificationRequestRef = useRef<string | null>(null);
  const consumedOnDeviceClarificationRequestsRef = useRef(new Set<string>());

  const titleInputRef = useRef<any>(null);
  const processingScrollRef = useRef<any>(null);
  const hasInitialized = useRef(false);
  const processInboxPlan = useMemo(() => resolveProcessInboxPlan(settings), [settings]);
  const {
    twoMinuteEnabled,
    twoMinuteFirst,
    projectFirst,
    referenceEnabled,
  } = processInboxPlan;
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
  const defaultScheduleTime = normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || '';
  const aiEnabled = settings?.ai?.enabled === true;
  const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
  const appleClarificationPrototypeEnabled = isAppleClarificationPrototypeEnabled();
  const nanoClarificationPrototypeEnabled = isNanoClarificationPrototypeEnabled();
  const onDeviceClarificationKind = Platform.OS === 'ios' && appleClarificationPrototypeEnabled
    ? 'apple'
    : Platform.OS === 'android' && nanoClarificationPrototypeEnabled
      ? 'nano'
      : null;
  const aiClarifyEnabled = onDeviceClarificationBackend === 'on-device'
    ? onDeviceClarificationKind !== null
    : aiEnabled;
  const showProjectSection = processInboxPlan.showProjectStep;
  const showContextSection = showContextsField || showTagsField;
  const showOrganizationSection = showPriorityField || showEnergyLevelField || showAssignedToField || showTimeEstimateField;
  const showSchedulingSection = processInboxPlan.showScheduleFields;
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

  const { areaById, projectById } = useVisibleTaskContext();
  const inboxTasks = useMemo(
    // Not `visibleTasks`: the queue is the process-inbox candidate set, which
    // has its own status rule on top of the shared visibility predicate.
    () => selectProcessInboxCandidates(tasks, (task) => isTaskVisibleInInbox(task, { projectById })),
    [projectById, tasks],
  );

  const processingQueue = useMemo(
    () => getProcessInboxRemainingCandidates(processingSession, inboxTasks),
    [inboxTasks, processingSession],
  );
  const currentTask = useMemo(
    () => getProcessInboxCurrentCandidate(processingSession, inboxTasks),
    [inboxTasks, processingSession],
  );
  const taskSimilarityIndex = useMemo(
    () => visible ? createTaskSimilarityIndex(allTasks) : null,
    [allTasks, visible],
  );
  const similarTasks = useMemo(
    () => visible && currentTask && taskSimilarityIndex
      ? findSimilarTasks(taskSimilarityIndex, processingTitle, currentTask.id)
      : [],
    [currentTask, processingTitle, taskSimilarityIndex, visible],
  );
  const similarTaskProjectTitles = useMemo(() => {
    if (!visible || similarTasks.length === 0) return new Map<string, string>();
    const projectIds = new Set(similarTasks.map((task) => task.projectId).filter(Boolean));
    const titles = new Map<string, string>();
    for (const project of projects) {
      if (projectIds.has(project.id)) titles.set(project.id, project.title);
    }
    return titles;
  }, [projects, similarTasks, visible]);
  const isReturningItem = Boolean(currentTask && isProcessInboxReturningTask(currentTask));
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

  const onDeviceClarificationDraft = useMemo<OnDeviceClarificationDraftSnapshot | null>(() => currentTask ? ({
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
    workflowChoices: [actionabilityChoice, twoMinuteChoice, executionChoice],
  }) : null, [
    actionabilityChoice,
    currentTask,
    executionChoice,
    pendingDueDate,
    pendingDueDateOnly,
    pendingStartDate,
    pendingStartDateOnly,
    twoMinuteChoice,
    processingDescription,
    processingTitle,
    selectedAreaId,
    selectedContexts,
    selectedProjectId,
    selectedTags,
  ]);
  const onDeviceClarificationDraftRef = useRef<OnDeviceClarificationDraftSnapshot | null>(null);
  onDeviceClarificationDraftRef.current = onDeviceClarificationDraft;
  const onDeviceClarificationDraftFingerprint = useMemo(
    () => onDeviceClarificationDraft
      ? createOnDeviceClarificationLease('draft', onDeviceClarificationDraft).fingerprint
      : null,
    [onDeviceClarificationDraft],
  );

  const onDeviceClarificationAssociations = useMemo(() => ({
    projectIds: new Set(projects.filter(isSelectableProjectForTaskAssignment).map((project) => project.id)),
    areaIds: new Set(areas.filter((area) => !area.deletedAt).map((area) => area.id)),
    contextIds: new Set([...contextSuggestionPool, ...selectedContexts]),
    tagIds: new Set([...tagSuggestionPool, ...selectedTags]),
  }), [areas, contextSuggestionPool, projects, selectedContexts, selectedTags, tagSuggestionPool]);
  const onDeviceClarificationAssociationsRef = useRef(onDeviceClarificationAssociations);
  onDeviceClarificationAssociationsRef.current = onDeviceClarificationAssociations;

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
    if (!twoMinuteFirst) setTwoMinuteChoice(null);
    setExecutionChoice(null);
    scrollProcessingToRevealedStep();
  }, [scrollProcessingToRevealedStep, twoMinuteFirst]);

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
    if (level === 'twoMinute' || (level === 'actionability' && !twoMinuteFirst)) setTwoMinuteChoice(null);
    setExecutionChoice(null);
  }, [twoMinuteFirst]);

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
    dirtyScheduleFieldsRef.current.clear();
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
    setNextActionDraft('');
    setExtraActionDrafts([]);
    setSelectedContexts(task?.contexts ?? []);
    setSelectedTags(task?.tags ?? []);
    setSelectedPriority(task?.priority);
    setSelectedSomedaySectionId(task?.viewSectionIds?.someday);
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

  const setPendingStartDateFromControl = useCallback((value: Date | null) => {
    dirtyScheduleFieldsRef.current.add('startTime');
    setPendingStartDate(value);
  }, []);
  const setPendingStartDateOnlyFromControl = useCallback((value: boolean) => {
    dirtyScheduleFieldsRef.current.add('startTime');
    setPendingStartDateOnly(value);
  }, []);
  const setPendingDueDateFromControl = useCallback((value: Date | null) => {
    dirtyScheduleFieldsRef.current.add('dueDate');
    setPendingDueDate(value);
  }, []);
  const setPendingDueDateOnlyFromControl = useCallback((value: boolean) => {
    dirtyScheduleFieldsRef.current.add('dueDate');
    setPendingDueDateOnly(value);
  }, []);
  const setPendingReviewDateFromControl = useCallback((value: Date | null) => {
    dirtyScheduleFieldsRef.current.add('reviewAt');
    setPendingReviewDate(value);
  }, []);
  const setPendingReviewDateOnlyFromControl = useCallback((value: boolean) => {
    dirtyScheduleFieldsRef.current.add('reviewAt');
    setPendingReviewDateOnly(value);
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

  const poisonReadyOnDeviceClarification = useCallback((): boolean => {
    const requestId = readyOnDeviceClarificationRequestRef.current;
    if (!requestId) return false;
    readyOnDeviceClarificationRequestRef.current = null;
    consumedOnDeviceClarificationRequestsRef.current.add(requestId);
    return true;
  }, []);

  const resetProcessingState = useCallback(() => {
    poisonReadyOnDeviceClarification();
    setProcessingSession(createProcessInboxSession());
    setAiModal(null);
    primeTaskState(null);
  }, [poisonReadyOnDeviceClarification, primeTaskState]);

  const cancelOnDeviceClarification = useCallback((): boolean => {
    const cancelledActiveRequest = activeOnDeviceClarificationRef.current !== null;
    activeOnDeviceClarificationRef.current?.abort();
    activeOnDeviceClarificationRef.current = null;
    const invalidatedReadyProposal = poisonReadyOnDeviceClarification();
    if (invalidatedReadyProposal) setAiModal(null);
    setIsAIWorking(false);
    return cancelledActiveRequest || invalidatedReadyProposal;
  }, [poisonReadyOnDeviceClarification]);

  const handleClose = useCallback(() => {
    cancelOnDeviceClarification();
    resetProcessingState();
    onClose();
  }, [cancelOnDeviceClarification, onClose, resetProcessingState]);

  const closeAIModal = useCallback(() => {
    poisonReadyOnDeviceClarification();
    setAiModal(null);
  }, [poisonReadyOnDeviceClarification]);

  useEffect(() => {
    if (!visible || !onDeviceClarificationKind) {
      setOnDeviceClarificationBackend('configured');
      return;
    }
    let active = true;
    const readBackend = onDeviceClarificationKind === 'nano'
      ? readNanoClarificationBackend
      : readAppleClarificationBackend;
    void readBackend().then((backend) => {
      if (active) setOnDeviceClarificationBackend(backend);
    });
    return () => {
      active = false;
    };
  }, [onDeviceClarificationKind, visible]);

  useEffect(() => () => {
    if (cancelOnDeviceClarification()) {
      if (onDeviceClarificationKind === 'nano') {
        void reportNanoClarificationOutcome('stale_ignored');
      } else if (onDeviceClarificationKind === 'apple') {
        void reportAppleClarificationOutcome('stale_ignored');
      }
    }
  }, [
    cancelOnDeviceClarification,
    currentTask?.id,
    onDeviceClarificationDraftFingerprint,
    onDeviceClarificationKind,
    visible,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' || !cancelOnDeviceClarification()) return;
      if (onDeviceClarificationKind === 'nano') {
        void reportNanoClarificationOutcome('stale_ignored');
      } else if (onDeviceClarificationKind === 'apple') {
        void reportAppleClarificationOutcome('stale_ignored');
      }
    });
    return () => subscription.remove();
  }, [cancelOnDeviceClarification, onDeviceClarificationKind]);

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

  const quickAddParseOptions = useMemo(
    () => buildQuickAddParseOptions(settings, { tasks, people }),
    [people, settings, tasks],
  );
  const parseProcessingTitle = useCallback(
    (input: string) => parseProcessInboxTitleInput(input, {
      projects,
      areas,
      parseOptions: quickAddParseOptions,
    }),
    [areas, projects, quickAddParseOptions],
  );
  const parsedTitle = useMemo(
    () => parseProcessingTitle(processingTitle),
    [parseProcessingTitle, processingTitle],
  );

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

  const prepareProcessingEdits = useCallback((titleOverride?: string, fallbackTitle?: string): {
    taskUpdates: Partial<Task>;
    parsedFields: ProcessInboxWorkflowFields;
    explicitDateFields: Partial<Pick<ProcessInboxWorkflowFields, 'startTime' | 'dueDate' | 'reviewAt'>>;
  } | null => {
    if (!currentTask) return null;
    const titleSource = titleOverride ?? processingTitle;
    const parsed = titleSource === processingTitle ? parsedTitle : parseProcessingTitle(titleSource);
    if (parsed.invalidDateCommands && parsed.invalidDateCommands.length > 0) {
      showProcessingError(
        `${tFallback(t, 'quickAdd.invalidDateCommand', 'Invalid date command')}: ${parsed.invalidDateCommands.join(', ')}`,
      );
      return null;
    }
    const title = parsed.title.trim() || fallbackTitle?.trim() || currentTask.title;
    const description = [processingDescription.trim(), parsed.props.description?.trim()]
      .filter(Boolean)
      .join('\n');
    return {
      taskUpdates: {
        title,
        description: description.length > 0 ? description : undefined,
        ...(parsed.props.attachments
          ? { attachments: [...(currentTask.attachments ?? []), ...parsed.props.attachments] }
          : {}),
        ...(parsed.props.isFocusedToday ? { isFocusedToday: true } : {}),
      },
      parsedFields: parsed.props,
      explicitDateFields: {
        ...(parsed.props.startTime ? { startTime: parsed.props.startTime } : {}),
        ...(parsed.props.dueDate ? { dueDate: parsed.props.dueDate } : {}),
        ...(parsed.props.reviewAt ? { reviewAt: parsed.props.reviewAt } : {}),
      },
    };
  }, [currentTask, parseProcessingTitle, parsedTitle, processingDescription, processingTitle, showProcessingError, t]);

  const buildDecisionFields = useCallback((
    overrides: ProcessInboxWorkflowFields = {},
  ): ProcessInboxWorkflowFields => ({
    projectId: selectedProjectId ?? undefined,
    areaId: selectedAreaId ?? undefined,
    contexts: selectedContexts,
    tags: selectedTags,
    priority: selectedPriority,
    energyLevel: selectedEnergyLevel,
    assignedTo: selectedAssignedTo.trim() || undefined,
    timeEstimate: selectedTimeEstimate,
    ...buildScheduleUpdates(),
    ...overrides,
  }), [
    buildScheduleUpdates,
    selectedAreaId,
    selectedAssignedTo,
    selectedContexts,
    selectedEnergyLevel,
    selectedPriority,
    selectedProjectId,
    selectedTags,
    selectedTimeEstimate,
  ]);

  const applyWorkflowDecision = useCallback(async (
    decision: ProcessInboxDecision,
    options: {
      fields?: ProcessInboxWorkflowFields;
      titleOverride?: string;
      fallbackTitle?: string;
      explicitDateFields?: Partial<Pick<ProcessInboxWorkflowFields, 'startTime' | 'dueDate' | 'reviewAt'>>;
      advance?: boolean;
    } = {},
  ): Promise<boolean> => {
    if (!currentTask) return false;
    const edits = decision.type === 'discard'
      ? undefined
      : prepareProcessingEdits(options.titleOverride, options.fallbackTitle);
    if (decision.type !== 'discard' && !edits) return false;
    const fields = mergeParsedProcessInboxFields(
      buildDecisionFields(options.fields),
      edits?.parsedFields ?? {},
    );
    const dateControlFields = {
      ...(dirtyScheduleFieldsRef.current.has('startTime') ? { startTime: fields.startTime } : {}),
      ...(dirtyScheduleFieldsRef.current.has('dueDate') ? { dueDate: fields.dueDate } : {}),
      ...(dirtyScheduleFieldsRef.current.has('reviewAt') ? { reviewAt: fields.reviewAt } : {}),
    };
    const prepared = prepareProcessInboxDecision({
      task: currentTask,
      draft: {
        fields,
        explicitDateFields: { ...edits?.explicitDateFields, ...options.explicitDateFields },
        dateControlFields,
        taskUpdates: edits?.taskUpdates,
      },
      decision,
      plan: processInboxPlan,
    });
    if (!prepared.ok) {
      if (prepared.reason === 'later-start-required') {
        showToast({
          title: t('common.notice'),
          message: tFallback(t, 'process.laterStartRequired', 'Choose a start date for Later.'),
          tone: 'warning',
        });
      }
      return false;
    }
    try {
      const outcome = await commitProcessInboxWorkflowEvent(
        processingSession,
        inboxTasks,
        prepared.event,
        { deleteTask, updateTask },
        { taskUpdates: prepared.taskUpdates, advance: options.advance },
      );
      if (isActionFailure(outcome.writeResult)) {
        showProcessingError(getActionFailureMessage(outcome.writeResult));
        return false;
      }
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
    buildDecisionFields,
    currentTask,
    deleteTask,
    handleClose,
    inboxTasks,
    processInboxPlan,
    prepareProcessingEdits,
    processingSession,
    showProcessingError,
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
      restoreUpdates: buildInboxDecisionRestoreUpdates(currentTask),
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
      const result = receipt.kind === 'discarded'
        ? await restoreTask(receipt.taskId)
        : await updateTask(receipt.taskId, receipt.restoreUpdates);
      if (isActionFailure(result)) {
        showProcessingError(getActionFailureMessage(result));
      }
    } catch (error) {
      showProcessingError(getUnknownErrorMessage(error));
    }
  }, [restoreTask, showProcessingError, updateTask]);

  const buildSomedayFields = useCallback((): ProcessInboxWorkflowFields => ({
    viewSectionIds: setTaskViewSectionId(
      currentTask?.viewSectionIds,
      'someday',
      selectedSomedaySectionId,
    ),
  }), [currentTask?.viewSectionIds, selectedSomedaySectionId]);

  const handleNotActionable = useCallback(async (action: 'trash' | 'someday' | 'reference') => {
    if (!currentTask) return false;
    if (action === 'trash') {
      return applyWorkflowDecision({ type: 'discard' });
    }
    if (action === 'someday') {
      return applyWorkflowDecision({ type: 'someday' }, { fields: buildSomedayFields() });
    }
    return applyWorkflowDecision({ type: 'reference' });
  }, [applyWorkflowDecision, buildSomedayFields, currentTask]);

  const handleLaterMobile = useCallback(async () => {
    if (!currentTask) return false;
    const startDate = pendingStartDate;
    const applied = await applyWorkflowDecision({ type: 'later' }, {
      fields: {
        startTime: startDate ? formatScheduledDateValue(startDate, pendingStartDateOnly) : undefined,
      },
    });
    if (!applied) return false;
    setPendingStartDate(null);
    return true;
  }, [
    applyWorkflowDecision,
    currentTask,
    formatScheduledDateValue,
    pendingStartDate,
    pendingStartDateOnly,
  ]);

  const handleIncubate = useCallback(async () => {
    if (!currentTask) return false;
    if (!pendingReviewDate) {
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'process.incubateDateRequired', 'Choose a date to bring this back.'),
        tone: 'warning',
      });
      return false;
    }
    const reviewAt = formatScheduledDateValue(pendingReviewDate, pendingReviewDateOnly);
    const applied = await applyWorkflowDecision({ type: 'someday' }, {
      fields: { ...buildSomedayFields(), reviewAt },
      explicitDateFields: { reviewAt },
    });
    if (!applied) return false;
    setPendingReviewDate(null);
    return true;
  }, [
    applyWorkflowDecision,
    buildSomedayFields,
    currentTask,
    formatScheduledDateValue,
    pendingReviewDate,
    pendingReviewDateOnly,
    showToast,
    t,
  ]);

  const handleTwoMinYes = useCallback(async () => {
    if (!currentTask) return false;
    return applyWorkflowDecision({ type: 'complete' });
  }, [applyWorkflowDecision, currentTask]);

  const handleConfirmWaitingMobile = useCallback(async () => {
    if (!currentTask) return false;
    const who = delegateWho.trim() || selectedAssignedTo.trim();
    const applied = await applyWorkflowDecision({
      type: 'waiting',
      followUpAt: delegateFollowUpDate
        ? formatScheduledDateValue(delegateFollowUpDate, delegateFollowUpDateOnly)
        : undefined,
    }, {
      fields: { assignedTo: who || undefined },
    });
    if (!applied) return false;
    setDelegateWho('');
    setDelegateFollowUpDate(null);
    return true;
  }, [
    applyWorkflowDecision,
    currentTask,
    delegateFollowUpDate,
    delegateFollowUpDateOnly,
    delegateWho,
    formatScheduledDateValue,
    selectedAssignedTo,
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
    const baseTitle = parsedTitle.title.trim() || processingTitle.trim() || currentTask?.title || '';
    setConvertToProject(true);
    setNextActionDraft((prev) => prev.trim() || baseTitle);
    setSelectedProjectId(null);
    setProjectSearch('');
  }, [currentTask?.title, parsedTitle.title, processingTitle]);

  const handleProjectConversionCancel = useCallback(() => {
    setConvertToProject(false);
    setNextActionDraft('');
    setExtraActionDrafts([]);
  }, []);

  const finalizeNextAction = useCallback(async (projectId: string | null) => {
    const applied = await applyWorkflowDecision({ type: 'next' }, {
      fields: { projectId: projectId ?? undefined },
    });
    if (!applied) return false;
    setPendingStartDate(null);
    setPendingDueDate(null);
    setPendingReviewDate(null);
    return true;
  }, [
    applyWorkflowDecision,
  ]);

  const handleConvertToProject = useCallback(async (): Promise<boolean> => {
    if (!currentTask || projectConversionInFlightRef.current) return false;
    const projectTitle = parsedTitle.title.trim() || processingTitle.trim() || currentTask.title;
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

    projectConversionInFlightRef.current = true;
    try {
      const existing = projects.find((project) => (
        isSelectableProjectForTaskAssignment(project)
        && project.title.toLowerCase() === projectTitle.toLowerCase()
      ));
      const project = existing ?? await addProject(
        projectTitle,
        DEFAULT_PROJECT_COLOR,
        showAreaField && selectedAreaId ? { areaId: selectedAreaId } : undefined,
      );
      if (!project) return false;

      // Extra actions are independent durable writes. Commit and remove each
      // one before moving the original Inbox task, so retry cannot lose or
      // duplicate actions already saved.
      const extraActions = extraActionDrafts
        .map((draftValue) => ({ draftValue, title: draftValue.trim() }))
        .filter(({ title }) => Boolean(title));
      for (const { draftValue, title } of extraActions) {
        const result = await addTask(title, { status: 'inbox', projectId: project.id });
        if (isActionFailure(result)) {
          showProcessingError(getActionFailureMessage(result));
          return false;
        }
        setExtraActionDrafts((currentDrafts) => {
          const committedIndex = currentDrafts.indexOf(draftValue);
          return committedIndex < 0
            ? currentDrafts
            : currentDrafts.filter((_, index) => index !== committedIndex);
        });
      }

      const applied = await applyWorkflowDecision({ type: 'next' }, {
        fields: { projectId: project.id, areaId: undefined },
        titleOverride: nextAction,
        fallbackTitle: currentTask.title,
        advance: false,
      });
      if (!applied) return false;
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
    } finally {
      projectConversionInFlightRef.current = false;
    }
  }, [
    addProject,
    addTask,
    applyWorkflowDecision,
    currentTask,
    extraActionDrafts,
    moveToNext,
    nextActionDraft,
    parsedTitle.title,
    processingTitle,
    projects,
    selectedAreaId,
    showAreaField,
    showProcessingError,
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
    if (actionabilityChoice === 'incubate') {
      return handleIncubate();
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
    handleIncubate,
    handleLaterMobile,
    handleNotActionable,
    handleTwoMinYes,
    selectedProjectId,
    twoMinuteChoice,
    twoMinuteEnabled,
  ]);

  const handleSkipTask = useCallback(async () => {
    await applyWorkflowDecision({ type: 'skip' });
  }, [applyWorkflowDecision]);

  const applyOnDeviceClarificationStatus = useCallback((status: OnDeviceClarificationSuggestion['status']) => {
    if (!status) return;
    if (status === 'someday' || status === 'reference') {
      setActionabilityChoice(status);
      setTwoMinuteChoice(null);
      setExecutionChoice(null);
      return;
    }
    setActionabilityChoice('actionable');
    setTwoMinuteChoice('no');
    setExecutionChoice(status === 'waiting' ? 'delegate' : 'defer');
  }, []);

  const applyOnDeviceClarificationSuggestion = useCallback((suggestion: OnDeviceClarificationSuggestion) => {
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
    applyOnDeviceClarificationStatus(suggestion.status);
  }, [applyOnDeviceClarificationStatus]);

  const formatOnDeviceClarificationPreview = useCallback((suggestion: OnDeviceClarificationSuggestion): string => {
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

  const handleOnDeviceClarifyInbox = useCallback(async () => {
    const initialDraft = onDeviceClarificationDraftRef.current;
    const kind = onDeviceClarificationKind;
    if (!currentTask || !initialDraft || !kind) return;

    cancelOnDeviceClarification();
    const controller = new AbortController();
    activeOnDeviceClarificationRef.current = controller;
    const requestId = `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const lease = createOnDeviceClarificationLease(requestId, initialDraft);
    const reportOutcome = kind === 'nano'
      ? reportNanoClarificationOutcome
      : reportAppleClarificationOutcome;
    setIsAIWorking(true);
    try {
      const capability = kind === 'nano'
        ? await getNanoClarificationCapability(language)
        : await getAppleClarificationCapability(language);
      if (controller.signal.aborted || activeOnDeviceClarificationRef.current !== controller) {
        throw kind === 'nano'
          ? new NanoClarificationCancelledError()
          : new AppleClarificationCancelledError();
      }
      const draftBeforeRequest = onDeviceClarificationDraftRef.current;
      if (!draftBeforeRequest || !isOnDeviceClarificationLeaseCurrent(lease, draftBeforeRequest)) {
        void reportOutcome('stale_ignored');
        return;
      }
      if (!capability.available) {
        const reason = capability.reason ?? 'unknown';
        showToast({
          title: tFallback(t, 'taskEdit.aiClarify', 'Clarify with AI'),
          message: kind === 'nano'
            ? describeNanoClarificationUnavailableReason(reason)
            : describeAppleClarificationUnavailableReason(reason),
          tone: 'warning',
          durationMs: 6200,
        });
        void reportOutcome('unavailable', { reason });
        return;
      }
      const candidates = buildOnDeviceClarificationCandidates({
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
      const request = {
        requestId,
        locale: language,
        title: initialDraft.title,
        description: initialDraft.description,
        candidates,
      };
      const suggestion = kind === 'nano'
        ? await requestNanoInboxClarification(request, { signal: controller.signal })
        : await requestAppleInboxClarification(request, { signal: controller.signal });
      if (controller.signal.aborted || activeOnDeviceClarificationRef.current !== controller) {
        throw kind === 'nano'
          ? new NanoClarificationCancelledError()
          : new AppleClarificationCancelledError();
      }
      const currentDraft = onDeviceClarificationDraftRef.current;
      if (!currentDraft || !isOnDeviceClarificationLeaseCurrent(lease, currentDraft)) {
        void reportOutcome('stale_ignored');
        return;
      }

      const closeProposal = () => {
        if (readyOnDeviceClarificationRequestRef.current !== requestId) return;
        poisonReadyOnDeviceClarification();
        setAiModal(null);
      };
      const apply = () => {
        const latestDraft = onDeviceClarificationDraftRef.current;
        if (
          !latestDraft
          || readyOnDeviceClarificationRequestRef.current !== requestId
          || !areOnDeviceClarificationAssociationsCurrent(
            suggestion,
            onDeviceClarificationAssociationsRef.current,
          )
          || !consumeOnDeviceClarificationApply(
            lease,
            latestDraft,
            consumedOnDeviceClarificationRequestsRef.current,
          )
        ) {
          closeProposal();
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
        readyOnDeviceClarificationRequestRef.current = null;
        applyOnDeviceClarificationSuggestion(suggestion);
        setAiModal(null);
        void reportOutcome('applied_to_draft', {
          statusIncluded: Boolean(suggestion.status),
          associationCount: suggestion.contextIds.length + suggestion.tagIds.length
            + Number(Boolean(suggestion.projectId)) + Number(Boolean(suggestion.areaId)),
          dateCount: Number(Boolean(suggestion.startDate)) + Number(Boolean(suggestion.dueDate)),
        });
      };
      readyOnDeviceClarificationRequestRef.current = requestId;
      setAiModal({
        title: tFallback(t, 'ai.appleClarification.suggestionTitle', 'On-device suggestion'),
        message: formatOnDeviceClarificationPreview(suggestion),
        actions: [
          { label: t('ai.applySuggestion'), variant: 'primary', onPress: apply },
          { label: t('common.cancel'), variant: 'secondary', onPress: closeProposal },
        ],
      });
      void reportOutcome('suggestion_ready');
    } catch (error) {
      const cancelled = error instanceof AppleClarificationCancelledError
        || error instanceof NanoClarificationCancelledError;
      if (!cancelled) {
        const nanoReason = kind === 'nano'
          ? error instanceof NanoClarificationError
            || error instanceof OnDeviceClarificationInputError
            || error instanceof OnDeviceClarificationOutputError
            ? error.code
            : 'unknown'
          : undefined;
        void logWarn(`${kind === 'nano' ? 'Nano' : 'Apple'} Inbox clarification path failed`, {
          scope: 'inbox',
          extra: {
            releaseCheck: kind === 'nano'
              ? NANO_CLARIFICATION_RELEASE_CHECK
              : APPLE_CLARIFICATION_RELEASE_CHECK,
            backend: kind === 'nano' ? 'nano_on_device' : 'apple_on_device',
            outcome: 'failed',
            ...(nanoReason ? { reason: nanoReason } : {}),
            failureClass: error instanceof Error ? error.name : 'unknown',
          },
        });
        if (kind === 'nano') {
          showToast({
            title: t('ai.errorTitle'),
            message: error instanceof OnDeviceClarificationInputError
              || error instanceof OnDeviceClarificationOutputError
              ? error.message
              : nanoReason
              ? describeNanoClarificationUnavailableReason(nanoReason)
              : t('ai.errorBody'),
            tone: 'warning',
            durationMs: 6200,
          });
        } else {
          Alert.alert(t('ai.errorTitle'), formatAIErrorAlertBody(t('ai.errorBody'), error));
        }
      }
    } finally {
      if (activeOnDeviceClarificationRef.current === controller) {
        activeOnDeviceClarificationRef.current = null;
        setIsAIWorking(false);
      }
    }
  }, [
    applyOnDeviceClarificationSuggestion,
    areas,
    cancelOnDeviceClarification,
    contextSuggestionPool,
    currentTask,
    formatOnDeviceClarificationPreview,
    language,
    onDeviceClarificationKind,
    poisonReadyOnDeviceClarification,
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
    if (onDeviceClarificationBackend === 'on-device') {
      await handleOnDeviceClarifyInbox();
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
    onDeviceClarificationBackend,
    closeAIModal,
    contextSuggestionPool,
    currentTask,
    handleOnDeviceClarifyInbox,
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
    aiEnabled: aiClarifyEnabled,
    aiModal,
    applyTokenSuggestion,
    areaById,
    assignedToSuggestions,
    clearDecision,
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
    descriptionMaxHeight,
    displayDescription,
    executionChoice,
    filteredProjects,
    formatProgressLabel,
    handleAIClarifyInbox,
    handleAICancelInbox: cancelOnDeviceClarification,
    handleClose,
    handleConfirmWaitingMobile,
    handleConvertToProject,
    handleCreateProjectEarly,
    handleIncubate,
    handleLaterMobile,
    handleNextTask,
    handleNotActionable,
    isReturningItem,
    handleTwoMinYes,
    finalizeNextAction,
    undoDecision,
    handleProjectConversionCancel,
    handleProjectConversionStart,
    handleSendDelegateRequest,
    handleSkipTask,
    hasExactProjectMatch,
    headerStyle,
    insets,
    isAIWorking,
    isAICancellable: isAIWorking && onDeviceClarificationBackend === 'on-device',
    isDark,
    isNextTaskDisabled,
    newContext,
    nextActionDraft,
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
    projectTitle,
    referenceEnabled,
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
    setActionabilityChoice: chooseActionability,
    setDelegateFollowUpDate,
    setDelegateFollowUpDateOnly,
    setDelegateWho,
    setExecutionChoice: chooseExecution,
    setNewContext,
    setPendingDueDate: setPendingDueDateFromControl,
    setPendingDueDateOnly: setPendingDueDateOnlyFromControl,
    setPendingReviewDate: setPendingReviewDateFromControl,
    setPendingReviewDateOnly: setPendingReviewDateOnlyFromControl,
    setProjectSearch,
    setPendingStartDate: setPendingStartDateFromControl,
    setPendingStartDateOnly: setPendingStartDateOnlyFromControl,
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
    somedaySections,
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
    twoMinuteFirst,
    setTwoMinuteChoice: chooseTwoMinute,
    selectProjectEarly,
    toggleContext,
    toggleTag,
    ENERGY_LEVEL_OPTIONS,
    PRIORITY_OPTIONS,
    processedCount,
  };
}
