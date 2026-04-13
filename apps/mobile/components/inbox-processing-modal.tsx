import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, TextInput, Platform, Alert, Share, ActivityIndicator, Dimensions, type TextStyle } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { X } from 'lucide-react-native';

import { addBreadcrumb, DEFAULT_PROJECT_COLOR, collectTaskTokenUsage, useTaskStore, createAIProvider, safeFormatDate, safeParseDate, resolveAutoTextDirection, type Task, type AIProviderId, type TaskPriority } from '@mindwtr/core';

import { AIResponseModal, type AIResponseAction } from './ai-response-modal';
import { useLanguage } from '../contexts/language-context';
import { useTheme } from '../contexts/theme-context';
import { useToast } from '../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../lib/ai-config';
import { logWarn } from '../lib/app-log';
import { styles } from './inbox-processing-modal.styles';

type InboxProcessingModalProps = {
  visible: boolean;
  onClose: () => void;
};

const MAX_TOKEN_SUGGESTIONS = 6;
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

export function InboxProcessingModal({ visible, onClose }: InboxProcessingModalProps) {
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
  const titleInputRef = useRef<TextInput | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
  const [isAIWorking, setIsAIWorking] = useState(false);
  const [aiModal, setAiModal] = useState<{ title: string; message?: string; actions: AIResponseAction[] } | null>(null);
  const processingScrollRef = useRef<ScrollView | null>(null);

  const inboxProcessing = settings?.gtd?.inboxProcessing ?? {};
  const twoMinuteEnabled = inboxProcessing.twoMinuteEnabled !== false;
  const projectFirst = inboxProcessing.projectFirst === true;
  const contextStepEnabled = inboxProcessing.contextStepEnabled !== false;
  const scheduleEnabled = inboxProcessing.scheduleEnabled === true;
  const referenceEnabled = inboxProcessing.referenceEnabled === true;
  const prioritiesEnabled = settings?.features?.priorities !== false;

  const aiEnabled = settings?.ai?.enabled === true;
  const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
  const closeAIModal = () => setAiModal(null);

  const inboxTasks = useMemo(() => {
    const now = new Date();
    return tasks.filter(t => {
      if (t.deletedAt) return false;
      if (t.status !== 'inbox') return false;
      const start = safeParseDate(t.startTime);
      if (start && start > now) return false;
      return true;
    });
  }, [tasks]);

  const processingQueue = useMemo(() => inboxTasks.filter(t => !skippedIds.has(t.id)), [inboxTasks, skippedIds]);
  const currentTask = useMemo(() => processingQueue[currentIndex] || null, [processingQueue, currentIndex]);
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
  const headerStyle = [styles.processingHeader, {
    borderBottomColor: tc.border,
    paddingTop: Math.max(insets.top, 10),
    paddingBottom: 10,
  }];

  const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedPriority, setSelectedPriority] = useState<TaskPriority | undefined>(undefined);
  const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
  const contextSuggestionPool = useMemo(() => {
    return collectTaskTokenUsage(tasks, (task) => task.contexts, { prefix: '@' })
      .sort((a, b) => {
        return b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.token.localeCompare(b.token);
      })
      .map((entry) => entry.token);
  }, [tasks]);
  const tagSuggestionPool = useMemo(() => {
    return collectTaskTokenUsage(tasks, (task) => task.tags, { prefix: '#' })
      .sort((a, b) => {
        return b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.token.localeCompare(b.token);
      })
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

  const resetTitleFocus = () => {
    setProcessingTitleFocused(false);
    titleInputRef.current?.blur();
  };

  const resetProcessingState = () => {
    resetTitleFocus();
    setCurrentIndex(0);
    setActionabilityChoice('actionable');
    setTwoMinuteChoice('no');
    setExecutionChoice('defer');
    setSkippedIds(new Set());
    setPendingStartDate(null);
    setShowStartDatePicker(false);
    setDelegateWho('');
    setDelegateFollowUpDate(null);
    setShowDelegateDatePicker(false);
    setSelectedContexts([]);
    setSelectedTags([]);
    setSelectedPriority(undefined);
    setNewContext('');
    setProjectSearch('');
    setSelectedProjectId(null);
    setProcessingTitle('');
    setProcessingDescription('');
    setAiModal(null);
  };
  const scrollProcessingToTop = useCallback((animated: boolean = false) => {
    requestAnimationFrame(() => {
      processingScrollRef.current?.scrollTo({ y: 0, animated });
    });
  }, []);

  const hasInitialized = useRef(false);

  const handleClose = () => {
    resetProcessingState();
    onClose();
  };
  const isDelegateConfirmationDisabled = executionChoice === 'delegate' && delegateWho.trim().length === 0;

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
    const firstTask = inboxTasks[0];
    setCurrentIndex(0);
    setActionabilityChoice('actionable');
    setTwoMinuteChoice('no');
    setExecutionChoice('defer');
    setSkippedIds(new Set());
    setPendingStartDate(null);
    setShowStartDatePicker(false);
    setDelegateWho('');
    setDelegateFollowUpDate(null);
    setShowDelegateDatePicker(false);
    setSelectedContexts(firstTask?.contexts ?? []);
    setSelectedTags(firstTask?.tags ?? []);
    setSelectedPriority(firstTask?.priority);
    setNewContext('');
    setProjectSearch('');
    setSelectedProjectId(firstTask?.projectId ?? null);
    resetTitleFocus();
    setProcessingTitle(firstTask?.title ?? '');
    setProcessingDescription(firstTask?.description ?? '');
  }, [visible, inboxTasks]);

  useEffect(() => {
    if (!visible) return;
    if (!currentTask && inboxTasks.length === 0) {
      handleClose();
    }
  }, [currentTask, inboxTasks.length, visible]);

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
      setActionabilityChoice('actionable');
      setTwoMinuteChoice('no');
      setExecutionChoice('defer');
      setPendingStartDate(null);
      setShowStartDatePicker(false);
      setDelegateWho('');
      setDelegateFollowUpDate(null);
      setShowDelegateDatePicker(false);
      setSelectedContexts(nextTask?.contexts ?? []);
      setSelectedTags(nextTask?.tags ?? []);
      setSelectedPriority(nextTask?.priority);
      setNewContext('');
      setProjectSearch('');
      setSelectedProjectId(nextTask?.projectId ?? null);
      resetTitleFocus();
      setProcessingTitle(nextTask?.title ?? '');
      setProcessingDescription(nextTask?.description ?? '');
    }
  }, [visible, processingQueue, currentIndex]);

  const moveToNext = () => {
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
    // Keep the same index since the current task will be removed from the queue.
    setCurrentIndex(currentIndex);
    setActionabilityChoice('actionable');
    setTwoMinuteChoice('no');
    setExecutionChoice('defer');
    setPendingStartDate(null);
    setShowDelegateDatePicker(false);
    setDelegateWho('');
    setDelegateFollowUpDate(null);
    setSelectedContexts(nextTask?.contexts ?? []);
    setSelectedTags(nextTask?.tags ?? []);
    setSelectedPriority(nextTask?.priority);
    setNewContext('');
    setProjectSearch('');
    setSelectedProjectId(nextTask?.projectId ?? null);
    resetTitleFocus();
    setProcessingTitle(nextTask?.title ?? '');
    setProcessingDescription(nextTask?.description ?? '');
  };

  useEffect(() => {
    if (!visible || !currentTask) return;
    scrollProcessingToTop(false);
  }, [visible, currentTask, scrollProcessingToTop]);

  const handleNextTask = () => {
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
  };

  const handleSkipTask = () => {
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
  };

  const applyProcessingEdits = (updates?: Partial<Task>) => {
    if (!currentTask) return;
    const title = processingTitle.trim() || currentTask.title;
    const description = processingDescription.trim();
    updateTask(currentTask.id, {
      title,
      description: description.length > 0 ? description : undefined,
      ...(updates ?? {}),
    });
  };

  const handleNotActionable = (action: 'trash' | 'someday' | 'reference') => {
    if (!currentTask) return;
    if (action === 'trash') {
      deleteTask(currentTask.id);
    } else if (action === 'someday') {
      applyProcessingEdits({ status: 'someday' });
    } else if (action === 'reference') {
      applyProcessingEdits({ status: 'reference' });
    }
    moveToNext();
  };

  const handleTwoMinYes = () => {
    if (currentTask) {
      applyProcessingEdits({ status: 'done' });
    }
    moveToNext();
  };

  const handleConfirmWaitingMobile = () => {
    if (currentTask) {
      const who = delegateWho.trim();
      if (!who) {
        return;
      }
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
  };

  const handleSendDelegateRequest = async () => {
    if (!currentTask) return;
    const title = processingTitle.trim() || currentTask.title;
    const baseDescription = processingDescription.trim() || currentTask.description || '';
    const who = delegateWho.trim();
    const greeting = who ? `Hi ${who},` : 'Hi,';
    const bodyParts = [
      greeting,
      '',
      `Could you please handle: ${title}`,
      baseDescription ? `\nDetails:\n${baseDescription}` : '',
      '',
      'Thanks!',
    ];
    const body = bodyParts.join('\n');
    const subject = `Delegation: ${title}`;
    await Share.share({ message: body, title: subject }).catch(() => {
      showToast({
        title: t('common.notice'),
        message: t('process.delegateSendError'),
        tone: 'warning',
      });
    });
  };

  const toggleContext = (ctx: string) => {
    setSelectedContexts((prev) =>
      prev.includes(ctx) ? prev.filter((item) => item !== ctx) : [...prev, ctx]
    );
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]
    );
  };

  const addCustomContextMobile = () => {
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
  };

  const applyTokenSuggestion = (token: string) => {
    if (token.startsWith('#')) {
      if (!selectedTags.includes(token)) {
        setSelectedTags((prev) => [...prev, token]);
      }
    } else if (!selectedContexts.includes(token)) {
      setSelectedContexts((prev) => [...prev, token]);
    }
    setNewContext('');
  };

  const selectProjectEarly = (projectId: string | null) => {
    setSelectedProjectId(projectId);
    setProjectSearch('');
  };

  const handleCreateProjectEarly = async () => {
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
  };

  const finalizeNextAction = (projectId: string | null) => {
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
  };

  const handleAIClarifyInbox = async () => {
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
  };

  if (!visible) return null;
  if (!currentTask) {
    const loadingLabel = t('common.loading') !== 'common.loading'
      ? t('common.loading')
      : 'Loading next item...';
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        allowSwipeDismissal
        onRequestClose={handleClose}
      >
        <View
          style={[styles.fullScreenContainer, { backgroundColor: tc.bg }]}
        >
          <View style={headerStyle}>
            <TouchableOpacity
              style={[styles.headerActionButton, styles.headerActionButtonLeft]}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              hitSlop={8}
            >
              <X size={22} color={tc.text} strokeWidth={2} />
            </TouchableOpacity>
            <View style={styles.progressContainer}>
              <Text style={[styles.progressText, { color: tc.secondaryText }]}>
                {formatProgressLabel(processedCount, totalCount)}
              </Text>
              <View style={[styles.progressBar, { backgroundColor: tc.border }]}>
                <View
                  style={[
                    styles.progressFill,
                    { width: totalCount > 0 ? `${(processedCount / totalCount) * 100}%` : '0%' }
                  ]}
                />
              </View>
            </View>
            <View style={styles.headerActionSpacer} />
          </View>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={tc.tint} />
            <Text style={[styles.loadingText, { color: tc.secondaryText }]}>
              {loadingLabel}
            </Text>
          </View>
        </View>
      </Modal>
    );
  }

  const projectTitle = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId)?.title
    : null;
  const currentProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;
  const displayDescription = processingDescription || currentTask.description || '';
  const windowHeight = Dimensions.get('window').height;
  const taskDisplayMaxHeight = Math.max(220, Math.floor(windowHeight * 0.44));
  const descriptionMaxHeight = Math.max(120, Math.floor(windowHeight * 0.28));
  const showExecutionSection = actionabilityChoice === 'actionable' && (!twoMinuteEnabled || twoMinuteChoice === 'no');

  const renderContextSection = () => {
    if (!contextStepEnabled) return null;
    return (
      <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
        <Text style={[styles.stepQuestion, { color: tc.text }]}>
          {t('inbox.whereDoIt')} {t('inbox.selectMultipleHint')}
        </Text>
        {selectedContexts.length > 0 && (
          <View style={[styles.selectedContextsContainer, { backgroundColor: '#3B82F620' }]}>
            <Text style={{ fontSize: 12, color: '#3B82F6', marginBottom: 4 }}>{t('inbox.selectedLabel')}</Text>
            <View style={styles.selectedTokensRow}>
              {selectedContexts.map(ctx => (
                <TouchableOpacity
                  key={ctx}
                  onPress={() => toggleContext(ctx)}
                  style={[styles.selectedTokenChip, styles.selectedContextChip]}
                >
                  <Text style={styles.selectedTokenText}>{ctx} x</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        {selectedTags.length > 0 && (
          <View style={[styles.selectedContextsContainer, { backgroundColor: '#8B5CF620' }]}>
            <Text style={{ fontSize: 12, color: '#8B5CF6', marginBottom: 4 }}>{t('taskEdit.tagsLabel')}</Text>
            <View style={styles.selectedTokensRow}>
              {selectedTags.map(tag => (
                <TouchableOpacity
                  key={tag}
                  onPress={() => toggleTag(tag)}
                  style={[styles.selectedTokenChip, styles.selectedTagChip]}
                >
                  <Text style={styles.selectedTokenText}>{tag} x</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        {prioritiesEnabled && (
          <View style={styles.prioritySection}>
            <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>{t('taskEdit.priorityLabel')}</Text>
            <View style={styles.tokenChipWrap}>
              {PRIORITY_OPTIONS.map((priority) => {
                const isSelected = selectedPriority === priority;
                return (
                  <TouchableOpacity
                    key={priority}
                    style={[
                      styles.priorityChip,
                      {
                        borderColor: isSelected ? tc.tint : tc.border,
                        backgroundColor: isSelected ? tc.tint : tc.filterBg,
                      },
                    ]}
                    onPress={() => setSelectedPriority(isSelected ? undefined : priority)}
                  >
                    <Text
                      style={[
                        styles.priorityChipText,
                        { color: isSelected ? tc.onTint : tc.text },
                      ]}
                    >
                      {t(`priority.${priority}`)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}
        <View style={styles.customContextContainer}>
          <TextInput
            style={[styles.contextInput, { borderColor: tc.border, color: tc.text }]}
            placeholder={t('inbox.addContextPlaceholder')}
            placeholderTextColor={tc.secondaryText}
            value={newContext}
            onChangeText={setNewContext}
            onSubmitEditing={addCustomContextMobile}
          />
          <TouchableOpacity
            style={styles.addContextButton}
            onPress={addCustomContextMobile}
            disabled={!newContext.trim()}
          >
            <Text style={styles.addContextButtonText}>+</Text>
          </TouchableOpacity>
        </View>
        {tokenSuggestions.length > 0 && (
          <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            {tokenSuggestions.map((token) => (
              <TouchableOpacity
                key={token}
                style={styles.tokenSuggestionChip}
                onPress={() => applyTokenSuggestion(token)}
              >
                <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {contextCopilotSuggestions.length > 0 && (
          <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>Suggested contexts</Text>
            <View style={styles.tokenChipWrap}>
              {contextCopilotSuggestions.map((token) => (
                <TouchableOpacity
                  key={`ctx-${token}`}
                  style={[styles.suggestionChip, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                  onPress={() => applyTokenSuggestion(token)}
                >
                  <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        {tagCopilotSuggestions.length > 0 && (
          <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>Suggested tags</Text>
            <View style={styles.tokenChipWrap}>
              {tagCopilotSuggestions.map((token) => (
                <TouchableOpacity
                  key={`tag-${token}`}
                  style={[styles.suggestionChip, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                  onPress={() => applyTokenSuggestion(token)}
                >
                  <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
      </View>
    );
  };

  const renderProjectSection = () => (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <Text style={[styles.stepQuestion, { color: tc.text }]}>
        📁 {t('inbox.assignProjectQuestion')}
      </Text>
      {currentProject && (
        <TouchableOpacity
          style={[styles.projectChip, { backgroundColor: tc.tint }]}
          onPress={() => selectProjectEarly(currentProject.id)}
        >
          <Text style={styles.projectChipText}>✓ {currentProject.title}</Text>
        </TouchableOpacity>
      )}
      <View style={styles.projectSearchRow}>
        <TextInput
          value={projectSearch}
          onChangeText={setProjectSearch}
          placeholder={t('projects.addPlaceholder')}
          placeholderTextColor={tc.secondaryText}
          style={[styles.projectSearchInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
          onSubmitEditing={handleCreateProjectEarly}
          returnKeyType="done"
        />
        {!hasExactProjectMatch && projectSearch.trim() && (
          <TouchableOpacity
            style={[styles.createProjectButton, { backgroundColor: tc.tint }]}
            onPress={handleCreateProjectEarly}
          >
            <Text style={styles.createProjectButtonText}>{t('projects.create')}</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={styles.projectListContainer}>
        <TouchableOpacity
          style={[styles.projectChip, { backgroundColor: '#10B981' }]}
          onPress={() => selectProjectEarly(null)}
        >
          <Text style={styles.projectChipText}>✓ {t('inbox.noProject')}</Text>
        </TouchableOpacity>
        {filteredProjects.map((proj) => {
          const projectColor = proj.areaId ? areaById.get(proj.areaId)?.color : undefined;
          const isSelected = selectedProjectId === proj.id;
          return (
            <TouchableOpacity
              key={proj.id}
              style={[
                styles.projectChip,
                isSelected
                  ? { backgroundColor: '#3B82F620', borderWidth: 1, borderColor: tc.tint }
                  : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
              ]}
              onPress={() => selectProjectEarly(proj.id)}
            >
              <View style={[styles.projectDot, { backgroundColor: projectColor || '#6B7280' }]} />
              <Text style={[styles.projectChipText, { color: tc.text }]}>{proj.title}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        allowSwipeDismissal
        onRequestClose={handleClose}
      >
        <View
          style={[styles.fullScreenContainer, { backgroundColor: tc.bg }]}
        >
          <View style={headerStyle}>
            <TouchableOpacity
              style={[styles.headerActionButton, styles.headerActionButtonLeft]}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              hitSlop={8}
            >
              <X size={22} color={tc.text} strokeWidth={2} />
            </TouchableOpacity>
            <View style={styles.progressContainer}>
              <Text style={[styles.progressText, { color: tc.secondaryText }]}>
                {formatProgressLabel(processedCount + 1, totalCount)}
              </Text>
              <View style={[styles.progressBar, { backgroundColor: tc.border }]}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${((processedCount + 1) / totalCount) * 100}%` }
                  ]}
                />
              </View>
            </View>
            <TouchableOpacity
              style={[styles.headerActionButton, styles.headerActionButtonRight]}
              onPress={handleSkipTask}
            >
              <Text style={styles.skipBtn}>
                {(() => {
                  const translated = t('inbox.skip');
                  return translated === 'inbox.skip' ? 'Skip' : translated;
                })()}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.taskDisplay, { maxHeight: taskDisplayMaxHeight }]}>
            <Text style={[styles.taskTitle, titleDirectionStyle, { color: tc.text }]}>
              {processingTitle || currentTask.title}
            </Text>
            {displayDescription ? (
              <ScrollView
                nestedScrollEnabled
                style={[styles.descriptionScroll, { maxHeight: descriptionMaxHeight }]}
                contentContainerStyle={styles.descriptionScrollContent}
              >
                <Text style={[styles.taskDescription, { color: tc.secondaryText }]}>
                  {displayDescription}
                </Text>
              </ScrollView>
            ) : null}
            <View style={styles.taskMetaRow}>
              {projectTitle && (
                <Text
                  style={[
                    styles.metaPill,
                    { backgroundColor: tc.filterBg, borderColor: tc.border, color: tc.text }
                  ]}
                >
                  📁 {projectTitle}
                </Text>
              )}
              {currentTask.startTime && (
                <Text
                  style={[
                    styles.metaPill,
                    { backgroundColor: tc.filterBg, borderColor: tc.border, color: tc.text }
                  ]}
                >
                  ⏱ {safeFormatDate(currentTask.startTime, 'P')}
                </Text>
              )}
              {currentTask.dueDate && (
                <Text
                  style={[
                    styles.metaPill,
                    { backgroundColor: tc.filterBg, borderColor: tc.border, color: tc.text }
                  ]}
                >
                  📅 {safeFormatDate(currentTask.dueDate, 'P')}
                </Text>
              )}
              {currentTask.reviewAt && (
                <Text
                  style={[
                    styles.metaPill,
                    { backgroundColor: tc.filterBg, borderColor: tc.border, color: tc.text }
                  ]}
                >
                  🔁 {safeFormatDate(currentTask.reviewAt, 'P')}
                </Text>
              )}
            </View>
            {(currentTask.contexts.length > 0 || currentTask.tags.length > 0) && (
              <View style={styles.taskMetaRow}>
                {currentTask.contexts.slice(0, 6).map((ctx) => (
                  <Text
                    key={ctx}
                    style={[
                      styles.metaPill,
                      isDark ? styles.metaPillContextDark : styles.metaPillContextLight,
                      { borderColor: tc.border }
                    ]}
                  >
                    {ctx}
                  </Text>
                ))}
                {currentTask.tags.slice(0, 6).map((tag) => (
                  <Text
                    key={tag}
                    style={[
                      styles.metaPill,
                      isDark ? styles.metaPillTagDark : styles.metaPillTagLight,
                      { borderColor: tc.border }
                    ]}
                  >
                    {tag}
                  </Text>
                ))}
              </View>
            )}
            {aiEnabled && (
              <View style={styles.aiActionRow}>
                <TouchableOpacity
                  style={[styles.aiActionButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                  onPress={handleAIClarifyInbox}
                  disabled={isAIWorking}
                >
                  <Text style={[styles.aiActionText, { color: tc.tint }]}>
                    {t('taskEdit.aiClarify')}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          <View style={styles.stepContainer}>
            <ScrollView
              ref={processingScrollRef}
              style={styles.singlePageScroll}
              contentContainerStyle={styles.singlePageContent}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
            >
              <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                <Text style={[styles.stepQuestion, { color: tc.text }]}>
                  {t('inbox.refineTitle')}
                </Text>
                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                  {t('inbox.refineHint')}
                </Text>
                <Text style={[styles.refineLabel, { color: tc.secondaryText }]}>{t('taskEdit.titleLabel')}</Text>
                <TextInput
                  ref={titleInputRef}
                  style={[styles.refineTitleInput, titleDirectionStyle, { borderColor: tc.border, color: tc.text, backgroundColor: tc.cardBg }]}
                  value={processingTitle}
                  onChangeText={setProcessingTitle}
                  placeholder={t('taskEdit.titleLabel')}
                  placeholderTextColor={tc.secondaryText}
                  onFocus={() => setProcessingTitleFocused(true)}
                  onBlur={() => setProcessingTitleFocused(false)}
                  selection={processingTitleFocused ? undefined : { start: 0, end: 0 }}
                />
                <Text style={[styles.refineLabel, { color: tc.secondaryText }]}>{t('taskEdit.descriptionLabel')}</Text>
                <TextInput
                  style={[styles.refineDescriptionInput, { borderColor: tc.border, color: tc.text, backgroundColor: tc.cardBg }]}
                  value={processingDescription}
                  onChangeText={setProcessingDescription}
                  placeholder={t('taskEdit.descriptionPlaceholder')}
                  placeholderTextColor={tc.secondaryText}
                  multiline
                  numberOfLines={4}
                />
              </View>

              <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                <Text style={[styles.stepQuestion, { color: tc.text }]}>
                  {t('inbox.isActionable')}
                </Text>
                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                  {t('inbox.actionableHint')}
                </Text>
                <View style={styles.buttonColumn}>
                  <TouchableOpacity
                    style={[
                      styles.bigButton,
                      actionabilityChoice === 'actionable' ? styles.buttonPrimary : { backgroundColor: tc.border },
                    ]}
                    onPress={() => setActionabilityChoice('actionable')}
                  >
                    <Text style={[styles.bigButtonText, actionabilityChoice !== 'actionable' && { color: tc.text }]}>
                      ✅ {t('inbox.yesActionable')}
                    </Text>
                  </TouchableOpacity>
                  <View style={styles.buttonRow}>
                    <TouchableOpacity
                      style={[styles.button, { backgroundColor: actionabilityChoice === 'trash' ? '#EF4444' : tc.border }]}
                      onPress={() => setActionabilityChoice('trash')}
                    >
                      <Text style={[styles.buttonPrimaryText, actionabilityChoice !== 'trash' && { color: tc.text }]}>🗑️ {t('inbox.trash')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.button, { backgroundColor: actionabilityChoice === 'someday' ? '#8B5CF6' : tc.border }]}
                      onPress={() => setActionabilityChoice('someday')}
                    >
                      <Text style={[styles.buttonPrimaryText, actionabilityChoice !== 'someday' && { color: tc.text }]}>💭 {t('inbox.someday')}</Text>
                    </TouchableOpacity>
                    {referenceEnabled && (
                      <TouchableOpacity
                        style={[styles.button, { backgroundColor: actionabilityChoice === 'reference' ? '#3B82F6' : tc.border }]}
                        onPress={() => setActionabilityChoice('reference')}
                      >
                        <Text style={[styles.buttonPrimaryText, actionabilityChoice !== 'reference' && { color: tc.text }]}>📚 {t('nav.reference')}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              </View>

              {actionabilityChoice === 'actionable' && twoMinuteEnabled && (
                <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                  <Text style={[styles.stepQuestion, { color: tc.text }]}>
                    ⏱️ {t('inbox.twoMinRule')}
                  </Text>
                  <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                    {t('inbox.twoMinHint')}
                  </Text>
                  <View style={styles.buttonColumn}>
                    <TouchableOpacity
                      style={[styles.bigButton, twoMinuteChoice === 'yes' ? styles.buttonSuccess : { backgroundColor: tc.border }]}
                      onPress={() => setTwoMinuteChoice('yes')}
                    >
                      <Text style={[styles.bigButtonText, twoMinuteChoice !== 'yes' && { color: tc.text }]}>✅ {t('inbox.doneIt')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.bigButton, twoMinuteChoice === 'no' ? styles.buttonPrimary : { backgroundColor: tc.border }]}
                      onPress={() => setTwoMinuteChoice('no')}
                    >
                      <Text style={[styles.bigButtonText, twoMinuteChoice !== 'no' && { color: tc.text }]}>
                        {t('inbox.takesLonger')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {showExecutionSection && (
                <>
                  {scheduleEnabled && (
                    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                      <Text style={[styles.stepQuestion, { color: tc.text }]}>
                        {t('taskEdit.startDateLabel')}
                      </Text>
                      <View style={styles.startDateActions}>
                        <TouchableOpacity
                          style={[styles.startDateButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                          onPress={() => setShowStartDatePicker(true)}
                        >
                          <Text style={[styles.startDateButtonText, { color: tc.text }]}>
                            {pendingStartDate ? safeFormatDate(pendingStartDate.toISOString(), 'P') : t('common.notSet')}
                          </Text>
                        </TouchableOpacity>
                        {pendingStartDate && (
                          <TouchableOpacity
                            style={[styles.startDateClear, { borderColor: tc.border }]}
                            onPress={() => setPendingStartDate(null)}
                          >
                            <Text style={[styles.startDateClearText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  )}

                  <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                    <Text style={[styles.stepQuestion, { color: tc.text }]}>
                      {t('inbox.whatNext')}
                    </Text>
                    <View style={styles.buttonColumn}>
                      <TouchableOpacity
                        style={[styles.bigButton, executionChoice === 'defer' ? styles.buttonPrimary : { backgroundColor: tc.border }]}
                        onPress={() => setExecutionChoice('defer')}
                      >
                        <Text style={[styles.bigButtonText, executionChoice !== 'defer' && { color: tc.text }]}>
                          📋 {t('inbox.illDoIt')}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.bigButton, executionChoice === 'delegate' ? { backgroundColor: '#F59E0B' } : { backgroundColor: tc.border }]}
                        onPress={() => setExecutionChoice('delegate')}
                      >
                        <Text style={[styles.bigButtonText, executionChoice !== 'delegate' && { color: tc.text }]}>
                          👤 {t('inbox.delegate')}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {executionChoice === 'delegate' ? (
                    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                      <Text style={[styles.stepQuestion, { color: tc.text }]}>
                        👤 {t('process.delegateTitle')}
                      </Text>
                      <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                        {t('process.delegateDesc')}
                      </Text>
                      <Text style={[styles.refineLabel, { color: tc.secondaryText }]}>{t('process.delegateWhoLabel')}</Text>
                      <TextInput
                        style={[styles.waitingInput, { borderColor: tc.border, color: tc.text }]}
                        placeholder={t('process.delegateWhoPlaceholder')}
                        placeholderTextColor={tc.secondaryText}
                        value={delegateWho}
                        onChangeText={setDelegateWho}
                      />
                      <View style={styles.startDateRow}>
                        <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                          {t('process.delegateFollowUpLabel')}
                        </Text>
                        <View style={styles.startDateActions}>
                          <TouchableOpacity
                            style={[styles.startDateButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                            onPress={() => setShowDelegateDatePicker(true)}
                          >
                            <Text style={[styles.startDateButtonText, { color: tc.text }]}>
                              {delegateFollowUpDate ? safeFormatDate(delegateFollowUpDate.toISOString(), 'P') : t('common.notSet')}
                            </Text>
                          </TouchableOpacity>
                          {delegateFollowUpDate && (
                            <TouchableOpacity
                              style={[styles.startDateClear, { borderColor: tc.border }]}
                              onPress={() => setDelegateFollowUpDate(null)}
                            >
                              <Text style={[styles.startDateClearText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                      <TouchableOpacity
                        style={[styles.buttonSecondary, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                        onPress={handleSendDelegateRequest}
                      >
                        <Text style={[styles.buttonText, { color: tc.text }]}>{t('process.delegateSendRequest')}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <>
                      {projectFirst ? renderProjectSection() : renderContextSection()}
                      {projectFirst ? renderContextSection() : renderProjectSection()}
                    </>
                  )}
                </>
              )}

              {scheduleEnabled && showStartDatePicker && (
                <DateTimePicker
                  value={pendingStartDate ?? new Date()}
                  mode="date"
                  display="default"
                  onChange={(event, date) => {
                    if (event.type === 'dismissed') {
                      setShowStartDatePicker(false);
                      return;
                    }
                    if (Platform.OS !== 'ios') setShowStartDatePicker(false);
                    if (!date) return;
                    const next = new Date(date);
                    next.setHours(9, 0, 0, 0);
                    setPendingStartDate(next);
                  }}
                />
              )}

              {showDelegateDatePicker && (
                <DateTimePicker
                  value={delegateFollowUpDate ?? new Date()}
                  mode="date"
                  display="default"
                  onChange={(event, date) => {
                    if (event.type === 'dismissed') {
                      setShowDelegateDatePicker(false);
                      return;
                    }
                    if (Platform.OS !== 'ios') setShowDelegateDatePicker(false);
                    if (!date) return;
                    const next = new Date(date);
                    next.setHours(9, 0, 0, 0);
                    setDelegateFollowUpDate(next);
                  }}
                />
              )}

              <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                  {t('inbox.tapNextHint') === 'inbox.tapNextHint'
                    ? 'Tap "Next task" at the bottom to apply your choices and move on.'
                    : t('inbox.tapNextHint')}
                </Text>
              </View>
            </ScrollView>
            <View style={[styles.bottomActionBar, { borderTopColor: tc.border, paddingBottom: Math.max(insets.bottom, 10) }]}>
              <TouchableOpacity
                style={[
                  styles.bottomNextButton,
                  { backgroundColor: tc.tint },
                  isDelegateConfirmationDisabled && { opacity: 0.5 },
                ]}
                disabled={isDelegateConfirmationDisabled}
                onPress={handleNextTask}
              >
                <Text style={styles.bottomNextButtonText}>
                  {(() => {
                    const translated = t('inbox.nextTask');
                    return translated === 'inbox.nextTask' ? 'Next task →' : translated;
                  })()}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      {aiModal && (
        <AIResponseModal
          visible={Boolean(aiModal)}
          title={aiModal.title}
          message={aiModal.message}
          actions={aiModal.actions}
          onClose={closeAIModal}
        />
      )}
    </>
  );
}
