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
  safeParseDate,
  resolveAutoTextDirection,
  useTaskStore,
  type AIProviderId,
  type Task,
  type TaskPriority,
} from '@mindwtr/core';

import type { AIResponseAction } from '../ai-response-modal';
import { useLanguage } from '../../contexts/language-context';
import { useTheme } from '../../contexts/theme-context';
import { useToast } from '../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logWarn } from '../../lib/app-log';
import { styles } from '../inbox-processing-modal.styles';

const MAX_TOKEN_SUGGESTIONS = 6;
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

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
  const [actionabilityChoice, setActionabilityChoice] = useState<'actionable' | 'trash' | 'someday' | 'reference'>('actionable');
  const [twoMinuteChoice, setTwoMinuteChoice] = useState<'yes' | 'no'>('no');
  const [executionChoice, setExecutionChoice] = useState<'defer' | 'delegate'>('defer');
  const [newContext, setNewContext] = useState('');
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [delegateWho, setDelegateWho] = useState('');
  const [delegateFollowUpDate, setDelegateFollowUpDate] = useState<Date | null>(null);
  const [showDelegateDatePicker, setShowDelegateDatePicker] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [processingTitle, setProcessingTitle] = useState('');
  const [processingDescription, setProcessingDescription] = useState('');
  const [processingTitleFocused, setProcessingTitleFocused] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
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
  const referenceEnabled = inboxProcessing.referenceEnabled === true;
  const prioritiesEnabled = settings?.features?.priorities !== false;
  const aiEnabled = settings?.ai?.enabled === true;
  const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;

  const inboxTasks = useMemo(() => {
    const now = new Date();
    return tasks.filter((task) => {
      if (task.deletedAt) return false;
      if (task.status !== 'inbox') return false;
      const start = safeParseDate(task.startTime);
      if (start && start > now) return false;
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
    if (total <= 0) return 'Task 0 of 0';
    return `Task ${Math.max(0, current)} of ${total}`;
  }, []);

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
  const tokenQuery = tokenPrefix ? tokenDraft.slice(1).toLowerCase() : '';
  const tokenSuggestions = useMemo(() => {
    if (!tokenPrefix || tokenQuery.length === 0) return [];
    const pool = tokenPrefix === '@' ? contextSuggestionPool : tagSuggestionPool;
    const selected = new Set(tokenPrefix === '@' ? selectedContexts : selectedTags);
    const normalizedQuery = tokenQuery.toLowerCase();
    return pool
      .filter((item) => !selected.has(item))
      .filter((item) => item.slice(1).toLowerCase().includes(normalizedQuery))
      .slice(0, MAX_TOKEN_SUGGESTIONS);
  }, [contextSuggestionPool, selectedContexts, selectedTags, tagSuggestionPool, tokenPrefix, tokenQuery]);
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
  const projectTitle = currentProject?.title ?? null;
  const displayDescription = processingDescription || currentTask?.description || '';
  const showExecutionSection = actionabilityChoice === 'actionable' && (!twoMinuteEnabled || twoMinuteChoice === 'no');
  const windowHeight = Dimensions.get('window').height;
  const taskDisplayMaxHeight = Math.max(220, Math.floor(windowHeight * 0.44));
  const descriptionMaxHeight = Math.max(120, Math.floor(windowHeight * 0.28));
  const isDelegateConfirmationDisabled = executionChoice === 'delegate' && delegateWho.trim().length === 0;

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
    setPendingStartDate(null);
    setShowStartDatePicker(false);
    setDelegateWho('');
    setDelegateFollowUpDate(null);
    setShowDelegateDatePicker(false);
    setSelectedContexts(task?.contexts ?? []);
    setSelectedTags(task?.tags ?? []);
    setSelectedPriority(task?.priority);
    setNewContext('');
    setProjectSearch('');
    setSelectedProjectId(task?.projectId ?? null);
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

  const handleTwoMinYes = useCallback(() => {
    if (currentTask) {
      applyProcessingEdits({ status: 'done' });
    }
    moveToNext();
  }, [applyProcessingEdits, currentTask, moveToNext]);

  const handleConfirmWaitingMobile = useCallback(() => {
    if (currentTask) {
      const who = delegateWho.trim();
      if (!who) return;
      const updates: Partial<Task> = {
        status: 'waiting',
        assignedTo: who,
        ...(prioritiesEnabled ? { priority: selectedPriority ?? undefined } : {}),
      };
      if (delegateFollowUpDate) {
        updates.reviewAt = delegateFollowUpDate.toISOString();
      }
      applyProcessingEdits(updates);
    }
    setDelegateWho('');
    setDelegateFollowUpDate(null);
    moveToNext();
  }, [
    applyProcessingEdits,
    currentTask,
    delegateFollowUpDate,
    delegateWho,
    moveToNext,
    prioritiesEnabled,
    selectedPriority,
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
    if (trimmed.startsWith('#')) {
      const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
      if (!selectedTags.includes(normalized)) {
        setSelectedTags((prev) => [...prev, normalized]);
      }
    } else {
      const normalized = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
      if (!selectedContexts.includes(normalized)) {
        setSelectedContexts((prev) => [...prev, normalized]);
      }
    }
    setNewContext('');
  }, [newContext, selectedContexts, selectedTags]);

  const applyTokenSuggestion = useCallback((token: string) => {
    if (token.startsWith('#')) {
      if (!selectedTags.includes(token)) {
        setSelectedTags((prev) => [...prev, token]);
      }
    } else if (!selectedContexts.includes(token)) {
      setSelectedContexts((prev) => [...prev, token]);
    }
    setNewContext('');
  }, [selectedContexts, selectedTags]);

  const selectProjectEarly = useCallback((projectId: string | null) => {
    setSelectedProjectId(projectId);
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
      projectId: projectId ?? undefined,
      contexts: selectedContexts,
      tags: selectedTags,
      ...(prioritiesEnabled ? { priority: selectedPriority ?? undefined } : {}),
      startTime: scheduleEnabled && pendingStartDate ? pendingStartDate.toISOString() : undefined,
    });
    setPendingStartDate(null);
    moveToNext();
  }, [
    applyProcessingEdits,
    moveToNext,
    pendingStartDate,
    prioritiesEnabled,
    scheduleEnabled,
    selectedContexts,
    selectedPriority,
    selectedTags,
  ]);

  const handleNextTask = useCallback(() => {
    if (!currentTask) return;
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
    handleNotActionable,
    handleTwoMinYes,
    selectedProjectId,
    twoMinuteChoice,
    twoMinuteEnabled,
  ]);

  const handleSkipTask = useCallback(() => {
    if (!currentTask) return;
    applyProcessingEdits({
      projectId: selectedProjectId ?? undefined,
      contexts: selectedContexts,
      tags: selectedTags,
      ...(prioritiesEnabled ? { priority: selectedPriority ?? undefined } : {}),
      ...(scheduleEnabled ? { startTime: pendingStartDate ? pendingStartDate.toISOString() : undefined } : {}),
    });
    setSkippedIds((prev) => {
      const next = new Set(prev);
      next.add(currentTask.id);
      return next;
    });
    moveToNext();
  }, [
    applyProcessingEdits,
    currentTask,
    moveToNext,
    pendingStartDate,
    prioritiesEnabled,
    scheduleEnabled,
    selectedContexts,
    selectedPriority,
    selectedProjectId,
    selectedTags,
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
    closeAIModal,
    contextCopilotSuggestions,
    contextStepEnabled,
    currentProject,
    currentTask,
    delegateFollowUpDate,
    delegateWho,
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
    pendingStartDate,
    prioritiesEnabled,
    processingDescription,
    processingScrollRef,
    processingTitle,
    processingTitleFocused,
    projectFirst,
    projectSearch,
    projectTitle,
    referenceEnabled,
    scheduleEnabled,
    selectedContexts,
    selectedPriority,
    selectedProjectId,
    selectedTags,
    setActionabilityChoice,
    setDelegateFollowUpDate,
    setDelegateWho,
    setExecutionChoice,
    setNewContext,
    setProjectSearch,
    setPendingStartDate,
    setProcessingDescription,
    setProcessingTitle,
    setProcessingTitleFocused,
    setSelectedPriority,
    setShowDelegateDatePicker,
    setShowStartDatePicker,
    showDelegateDatePicker,
    showExecutionSection,
    showStartDatePicker,
    t,
    tagCopilotSuggestions,
    taskDisplayMaxHeight,
    tc,
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
    PRIORITY_OPTIONS,
    processedCount,
  };
}
