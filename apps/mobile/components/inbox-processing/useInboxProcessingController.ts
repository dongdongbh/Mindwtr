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
  addBreadcrumb,
  DEFAULT_PROJECT_COLOR,
  collectTaskTokenUsage,
  createAIProvider,
  hasTimeComponent,
  normalizeClockTimeInput,
  safeFormatDate,
  safeParseDate,
  tFallback,
  resolveAutoTextDirection,
  useTaskStore,
  type AIProviderId,
  type Task,
  type TaskEditorFieldId,
  type TaskPriority,
  type TimeEstimate,
} from '@mindwtr/core';

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
import { getAssignedToSuggestions } from '../task-metadata-suggestions';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logWarn } from '../../lib/app-log';
import { styles } from '../inbox-processing-modal.styles';

const MAX_TOKEN_SUGGESTIONS = 6;
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: Array<NonNullable<Task['energyLevel']>> = ['low', 'medium', 'high'];

type InboxProcessingControllerParams = {
  visible: boolean;
  onClose: () => void;
};

export function useInboxProcessingController({
  visible,
  onClose,
}: InboxProcessingControllerParams) {
  const { tasks, projects, areas, settings, updateTask, deleteTask, addProject } = useTaskStore();
  const { t, language } = useLanguage();
  const { showToast } = useToast();
  const router = useRouter();
  const { isDark } = useTheme();
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();

  const [currentIndex, setCurrentIndex] = useState(0);
  const [actionabilityChoice, setActionabilityChoice] = useState<'actionable' | 'later' | 'trash' | 'someday' | 'reference'>('actionable');
  const [twoMinuteChoice, setTwoMinuteChoice] = useState<'yes' | 'no'>('no');
  const [executionChoice, setExecutionChoice] = useState<'defer' | 'delegate'>('defer');
  const [newContext, setNewContext] = useState('');
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [delegateWho, setDelegateWho] = useState('');
  const [delegateFollowUpDate, setDelegateFollowUpDate] = useState<Date | null>(null);
  const [delegateFollowUpDateOnly, setDelegateFollowUpDateOnly] = useState(false);
  const [showDelegateDatePicker, setShowDelegateDatePicker] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
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
  const [aiModal, setAiModal] = useState<{ title: string; message?: string; actions: AIResponseAction[] } | null>(null);
  const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedPriority, setSelectedPriority] = useState<TaskPriority | undefined>(undefined);

  const titleInputRef = useRef<any>(null);
  const processingScrollRef = useRef<any>(null);
  const hasInitialized = useRef(false);

  const inboxProcessing = settings?.gtd?.inboxProcessing ?? {};
  const twoMinuteEnabled = inboxProcessing.twoMinuteEnabled !== false;
  const projectFirst = inboxProcessing.projectFirst === true;
  const contextStepEnabled = inboxProcessing.contextStepEnabled !== false;
  const scheduleEnabled = inboxProcessing.scheduleEnabled === true;
  const defaultScheduleTime = normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || '';
  const referenceEnabled = true;
  const prioritiesEnabled = settings?.features?.priorities !== false;
  const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
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

  const inboxTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (task.deletedAt) return false;
      if (task.status !== 'inbox') return false;
      return true;
    });
  }, [tasks]);

  const processingQueue = useMemo(
    () => inboxTasks.filter((task) => !skippedIds.has(task.id)),
    [inboxTasks, skippedIds],
  );
  const currentTask = useMemo(
    () => processingQueue[currentIndex] || null,
    [processingQueue, currentIndex],
  );
  const totalCount = inboxTasks.length;
  const processedCount = totalCount - processingQueue.length + currentIndex;
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
  const openSettingsLabel = language.startsWith('zh') ? '打开' : 'Open';
  const headerStyle = useMemo(
    () => [styles.processingHeader, {
      borderBottomColor: tc.border,
      paddingTop: Math.max(insets.top, 10),
      paddingBottom: 10,
    }],
    [insets.top, tc.border],
  );

  const areaById = useMemo(
    () => new Map(areas.map((area) => [area.id, area])),
    [areas],
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
    () => getAssignedToSuggestions(tasks, selectedAssignedTo, MAX_TOKEN_SUGGESTIONS),
    [selectedAssignedTo, tasks],
  );
  const delegateWhoSuggestions = useMemo(
    () => getAssignedToSuggestions(tasks, delegateWho, MAX_TOKEN_SUGGESTIONS),
    [delegateWho, tasks],
  );
  const contextCopilotSuggestions = useMemo(() => {
    const selected = new Set(selectedContexts);
    const candidates = contextSuggestionPool.filter((token) => !selected.has(token));
    if (candidates.length === 0) return [];
    const fromInput = candidates.filter((token) => {
      const normalizedToken = token.slice(1).toLowerCase();
      return suggestionTerms.some((term) => normalizedToken.includes(term));
    });
    const merged = [...fromInput, ...candidates.filter((token) => !fromInput.includes(token))];
    return merged.slice(0, MAX_TOKEN_SUGGESTIONS);
  }, [contextSuggestionPool, selectedContexts, suggestionTerms]);
  const tagCopilotSuggestions = useMemo(() => {
    const selected = new Set(selectedTags);
    const candidates = tagSuggestionPool.filter((token) => !selected.has(token));
    if (candidates.length === 0) return [];
    const fromInput = candidates.filter((token) => {
      const normalizedToken = token.slice(1).toLowerCase();
      return suggestionTerms.some((term) => normalizedToken.includes(term));
    });
    const merged = [...fromInput, ...candidates.filter((token) => !fromInput.includes(token))];
    return merged.slice(0, MAX_TOKEN_SUGGESTIONS);
  }, [selectedTags, suggestionTerms, tagSuggestionPool]);

  const filteredProjects = useMemo(() => {
    if (!projectSearch.trim()) return projects;
    const query = projectSearch.trim().toLowerCase();
    return projects.filter((project) => project.title.toLowerCase().includes(query));
  }, [projects, projectSearch]);

  const hasExactProjectMatch = useMemo(() => {
    if (!projectSearch.trim()) return false;
    const query = projectSearch.trim().toLowerCase();
    return projects.some((project) => project.title.toLowerCase() === query);
  }, [projects, projectSearch]);

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
  const windowHeight = Dimensions.get('window').height;
  const taskDisplayMaxHeight = Math.max(220, Math.floor(windowHeight * 0.44));
  const descriptionMaxHeight = Math.max(120, Math.floor(windowHeight * 0.28));
  const isDelegateConfirmationDisabled = executionChoice === 'delegate'
    && delegateWho.trim().length === 0
    && selectedAssignedTo.trim().length === 0;

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
    setActionabilityChoice('actionable');
    setTwoMinuteChoice('no');
    setExecutionChoice('defer');
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
    setSelectedContexts(task?.contexts ?? []);
    setSelectedTags(task?.tags ?? []);
    setSelectedPriority(task?.priority);
    setSelectedEnergyLevel(task?.energyLevel);
    setSelectedAssignedTo(task?.assignedTo ?? '');
    setSelectedTimeEstimate(task?.timeEstimate);
    setNewContext('');
    setProjectSearch('');
    setSelectedProjectId(task?.projectId ?? null);
    setSelectedAreaId(task?.projectId ? null : (task?.areaId ?? null));
    resetTitleFocus();
    setProcessingTitle(task?.title ?? '');
    setProcessingDescription(task?.description ?? '');
  }, [resetTitleFocus]);

  const resetProcessingState = useCallback(() => {
    setCurrentIndex(0);
    setSkippedIds(new Set());
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
    setCurrentIndex(0);
    primeTaskState(inboxTasks[0]);
  }, [handleClose, inboxTasks, primeTaskState, visible]);

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
    if (currentIndex < 0 || currentIndex >= processingQueue.length) {
      const nextIndex = Math.max(0, processingQueue.length - 1);
      const nextTask = processingQueue[nextIndex];
      setCurrentIndex(nextIndex);
      primeTaskState(nextTask);
    }
  }, [currentIndex, handleClose, primeTaskState, processingQueue, visible]);

  useEffect(() => {
    if (!visible || !currentTask) return;
    scrollProcessingToTop(false);
  }, [currentTask, scrollProcessingToTop, visible]);

  const moveToNext = useCallback(() => {
    if (processingQueue.length === 0) {
      handleClose();
      return;
    }
    const nextTask = processingQueue[currentIndex + 1];
    if (!nextTask) {
      handleClose();
      return;
    }
    scrollProcessingToTop(false);
    setCurrentIndex(currentIndex);
    primeTaskState(nextTask);
  }, [currentIndex, handleClose, primeTaskState, processingQueue, scrollProcessingToTop]);

  const applyProcessingEdits = useCallback((updates?: Partial<Task>) => {
    if (!currentTask) return;
    const title = processingTitle.trim() || currentTask.title;
    const description = processingDescription.trim();
    updateTask(currentTask.id, {
      title,
      description: description.length > 0 ? description : undefined,
      ...(updates ?? {}),
    });
  }, [currentTask, processingDescription, processingTitle, updateTask]);

  const handleNotActionable = useCallback((action: 'trash' | 'someday' | 'reference') => {
    if (!currentTask) return;
    if (action === 'trash') {
      deleteTask(currentTask.id);
    } else if (action === 'someday') {
      applyProcessingEdits({ status: 'someday' });
    } else {
      applyProcessingEdits({ status: 'reference' });
    }
    moveToNext();
  }, [applyProcessingEdits, currentTask, deleteTask, moveToNext]);

  const handleLaterMobile = useCallback(() => {
    if (!currentTask) return;
    if (!pendingStartDate) {
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'process.laterStartRequired', 'Choose a start date for Later.'),
        tone: 'warning',
      });
      return;
    }
    applyProcessingEdits({
      status: 'next',
      ...(showProjectField ? { projectId: selectedProjectId ?? undefined } : {}),
      ...(showAreaField ? { areaId: selectedProjectId ? undefined : (selectedAreaId ?? undefined) } : {}),
      startTime: formatScheduledDateValue(pendingStartDate, pendingStartDateOnly),
    });
    setPendingStartDate(null);
    moveToNext();
  }, [
    applyProcessingEdits,
    currentTask,
    formatScheduledDateValue,
    moveToNext,
    pendingStartDate,
    pendingStartDateOnly,
    selectedAreaId,
    selectedProjectId,
    showAreaField,
    showProjectField,
    showToast,
    t,
  ]);

  const handleTwoMinYes = useCallback(() => {
    if (currentTask) {
      applyProcessingEdits({ status: 'done' });
    }
    moveToNext();
  }, [applyProcessingEdits, currentTask, moveToNext]);

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

  const handleConfirmWaitingMobile = useCallback(() => {
    if (currentTask) {
      const who = delegateWho.trim() || selectedAssignedTo.trim();
      if (!who) return;
      const updates: Partial<Task> = {
        status: 'waiting',
        assignedTo: who,
        ...(showPriorityField ? { priority: selectedPriority ?? undefined } : {}),
        ...(showEnergyLevelField ? { energyLevel: selectedEnergyLevel ?? undefined } : {}),
        ...(showTimeEstimateField ? { timeEstimate: selectedTimeEstimate ?? undefined } : {}),
        ...(showProjectField ? { projectId: selectedProjectId ?? undefined } : {}),
        ...(showAreaField ? { areaId: selectedProjectId ? undefined : (selectedAreaId ?? undefined) } : {}),
        ...(showContextsField ? { contexts: selectedContexts } : {}),
        ...(showTagsField ? { tags: selectedTags } : {}),
        ...buildScheduleUpdates(),
      };
      if (delegateFollowUpDate) {
        updates.reviewAt = formatScheduledDateValue(delegateFollowUpDate, delegateFollowUpDateOnly);
      }
      applyProcessingEdits(updates);
    }
    setDelegateWho('');
    setDelegateFollowUpDate(null);
    moveToNext();
  }, [
    applyProcessingEdits,
    buildScheduleUpdates,
    currentTask,
    delegateFollowUpDate,
    delegateFollowUpDateOnly,
    delegateWho,
    formatScheduledDateValue,
    moveToNext,
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

  const addCustomContextMobile = useCallback(() => {
    const trimmed = newContext.trim();
    if (!trimmed) return;
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
    setSelectedProjectId(projectId);
    if (projectId) {
      setSelectedAreaId(null);
    }
    setProjectSearch('');
  }, []);

  const handleCreateProjectEarly = useCallback(async () => {
    const title = projectSearch.trim();
    if (!title) return;
    const existing = projects.find((project) => project.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      selectProjectEarly(existing.id);
      return;
    }
    const created = await addProject(title, DEFAULT_PROJECT_COLOR);
    if (!created) return;
    selectProjectEarly(created.id);
  }, [addProject, projectSearch, projects, selectProjectEarly]);

  const finalizeNextAction = useCallback((projectId: string | null) => {
    applyProcessingEdits({
      status: 'next',
      ...(showProjectField ? { projectId: projectId ?? undefined } : {}),
      ...(showAreaField ? { areaId: projectId ? undefined : (selectedAreaId ?? undefined) } : {}),
      ...(showContextsField ? { contexts: selectedContexts } : {}),
      ...(showTagsField ? { tags: selectedTags } : {}),
      ...(showPriorityField ? { priority: selectedPriority ?? undefined } : {}),
      ...(showEnergyLevelField ? { energyLevel: selectedEnergyLevel ?? undefined } : {}),
      ...(showAssignedToField ? { assignedTo: selectedAssignedTo.trim() || undefined } : {}),
      ...(showTimeEstimateField ? { timeEstimate: selectedTimeEstimate ?? undefined } : {}),
      ...buildScheduleUpdates(),
    });
    setPendingStartDate(null);
    setPendingDueDate(null);
    setPendingReviewDate(null);
    moveToNext();
  }, [
    applyProcessingEdits,
    buildScheduleUpdates,
    moveToNext,
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

  const handleNextTask = useCallback(() => {
    if (!currentTask) return;
    if (actionabilityChoice === 'later') {
      handleLaterMobile();
      return;
    }
    if (actionabilityChoice === 'trash' || actionabilityChoice === 'someday' || actionabilityChoice === 'reference') {
      handleNotActionable(actionabilityChoice);
      return;
    }
    if (twoMinuteEnabled && twoMinuteChoice === 'yes') {
      handleTwoMinYes();
      return;
    }
    if (executionChoice === 'delegate') {
      handleConfirmWaitingMobile();
      return;
    }
    finalizeNextAction(selectedProjectId);
  }, [
    actionabilityChoice,
    currentTask,
    executionChoice,
    finalizeNextAction,
    handleConfirmWaitingMobile,
    handleLaterMobile,
    handleNotActionable,
    handleTwoMinYes,
    selectedProjectId,
    twoMinuteChoice,
    twoMinuteEnabled,
  ]);

  const handleSkipTask = useCallback(() => {
    if (!currentTask) return;
    applyProcessingEdits({
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
    setSkippedIds((prev) => {
      const next = new Set(prev);
      next.add(currentTask.id);
      return next;
    });
    moveToNext();
  }, [
    applyProcessingEdits,
    buildScheduleUpdates,
    currentTask,
    moveToNext,
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
      Alert.alert(t('ai.errorTitle'), t('ai.errorBody'));
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
    closeAIModal,
    contextCopilotSuggestions,
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
    handleCreateProjectEarly,
    handleNextTask,
    handleSendDelegateRequest,
    handleSkipTask,
    hasExactProjectMatch,
    headerStyle,
    insets,
    isAIWorking,
    isDark,
    isDelegateConfirmationDisabled,
    newContext,
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
    selectedTags,
    selectedTimeEstimate,
    setSelectedAreaId,
    setSelectedAssignedTo,
    setActionabilityChoice,
    setDelegateFollowUpDate,
    setDelegateFollowUpDateOnly,
    setDelegateWho,
    setExecutionChoice,
    setNewContext,
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
    setSelectedEnergyLevel,
    setSelectedPriority,
    setSelectedTimeEstimate,
    setShowDelegateDatePicker,
    setShowDueDatePicker,
    setShowReviewDatePicker,
    setShowStartDatePicker,
    showDelegateDatePicker,
    showAreaField,
    showAssignedToField,
    showContextSection,
    showContextsField,
    showEnergyLevelField,
    showExecutionSection,
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
    setTwoMinuteChoice,
    selectProjectEarly,
    toggleContext,
    toggleTag,
    ENERGY_LEVEL_OPTIONS,
    PRIORITY_OPTIONS,
    processedCount,
  };
}
