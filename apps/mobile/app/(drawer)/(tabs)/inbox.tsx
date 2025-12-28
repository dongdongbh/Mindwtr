import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView, TextInput, Platform, Alert } from 'react-native';

import { useTaskStore, PRESET_CONTEXTS, createAIProvider, safeFormatDate, safeParseDate, type Task } from '@mindwtr/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { TaskList } from '../../../components/task-list';
import { AIResponseModal, type AIResponseAction } from '../../../components/ai-response-modal';

import { useLanguage } from '../../../contexts/language-context';
import { useTheme } from '../../../contexts/theme-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { buildAIConfig, loadAIKey } from '../../../lib/ai-config';


export default function InboxScreen() {

  const { tasks, projects, settings, updateTask, deleteTask } = useTaskStore();
  const { t } = useLanguage();
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [processingStep, setProcessingStep] = useState<'actionable' | 'twomin' | 'decide' | 'context' | 'project' | 'waiting-note'>('actionable');
  const [newContext, setNewContext] = useState('');
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [waitingNote, setWaitingNote] = useState('');
  const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
  const [isAIWorking, setIsAIWorking] = useState(false);
  const [aiModal, setAiModal] = useState<{ title: string; message?: string; actions: AIResponseAction[] } | null>(null);

  const { isDark } = useTheme();
  const tc = useThemeColors();
  const aiEnabled = settings.ai?.enabled === true;
  const closeAIModal = () => setAiModal(null);

  const inboxTasks = tasks.filter(t => {
    if (t.deletedAt) return false;
    if (t.status !== 'inbox') return false;
    const start = safeParseDate(t.startTime);
    if (start && start > new Date()) return false;
    return true;
  });
  const processingQueue = inboxTasks.filter(t => !skippedIds.has(t.id));
  const currentTask = processingQueue[currentIndex] || null;
  const totalCount = inboxTasks.length;
  const processedCount = totalCount - processingQueue.length + currentIndex;

  const startProcessing = () => {
    setIsProcessing(true);
    setCurrentIndex(0);
    setProcessingStep('actionable');
    setSkippedIds(new Set());
    setPendingStartDate(null);
  };

  const processButton = inboxTasks.length > 0 ? (
    <TouchableOpacity
      style={[styles.processHeaderButton, { backgroundColor: tc.tint }]}
      onPress={startProcessing}
      accessibilityRole="button"
      accessibilityLabel={t('inbox.processButton')}
    >
      <Text style={styles.processHeaderButtonText}>
        ▷ {t('inbox.processButton')} ({inboxTasks.length})
      </Text>
    </TouchableOpacity>
  ) : null;

  const moveToNext = () => {
    if (currentIndex + 1 < processingQueue.length) {
      setCurrentIndex(currentIndex + 1);
      setProcessingStep('actionable');
      setPendingStartDate(null);
    } else {
      // Done processing
      setIsProcessing(false);
      setCurrentIndex(0);
      setSkippedIds(new Set());
      setPendingStartDate(null);
    }
  };

  const handleSkip = () => {
    if (currentTask) {
      setSkippedIds(prev => new Set([...prev, currentTask.id]));
    }
    moveToNext();
  };

  const [selectedContexts, setSelectedContexts] = useState<string[]>([]);

  const handleNotActionable = (action: 'trash' | 'someday' | 'reference') => {
    if (!currentTask) return;

    if (action === 'trash') {
      deleteTask(currentTask.id);
    } else if (action === 'someday') {
      updateTask(currentTask.id, { status: 'someday' });
    }
    moveToNext();
  };

  const handleActionable = () => {
    setProcessingStep('twomin');
  };

  const handleTwoMinYes = () => {
    // Do it now - mark done
    if (currentTask) {
      updateTask(currentTask.id, { status: 'done' });
    }
    moveToNext();
  };

  const handleTwoMinNo = () => {
    setProcessingStep('decide');
  };

  const handleDecision = (decision: 'delegate' | 'defer') => {
    if (!currentTask) return;

    if (decision === 'delegate') {
      setWaitingNote('');
      setProcessingStep('waiting-note');
    } else {
      setProcessingStep('context');
    }
  };

  const handleConfirmWaitingMobile = () => {
    if (currentTask) {
      const updates: Partial<Task> = {
        status: 'waiting',
        description: waitingNote || currentTask.description,
      };
      if (pendingStartDate) {
        updates.startTime = pendingStartDate.toISOString();
      }
      updateTask(currentTask.id, updates);
    }
    setWaitingNote('');
    moveToNext();
  };

  const toggleContext = (ctx: string) => {
    setSelectedContexts(prev =>
      prev.includes(ctx) ? prev.filter(c => c !== ctx) : [...prev, ctx]
    );
  };

  const addCustomContextMobile = () => {
    if (newContext.trim()) {
      const ctx = `@${newContext.trim().replace(/^@/, '')}`;
      if (!selectedContexts.includes(ctx)) {
        setSelectedContexts(prev => [...prev, ctx]);
      }
      setNewContext('');
    }
  };

  const handleConfirmContextsMobile = () => {
    setProcessingStep('project');
  };

  const handleSetProject = (projectId: string | null) => {
    if (!currentTask) return;

    const updates: Partial<Task> = {
      status: 'next',
      contexts: selectedContexts,
      projectId: projectId || undefined,
    };
    if (pendingStartDate) {
      updates.startTime = pendingStartDate.toISOString();
    }
    updateTask(currentTask.id, updates);
    setSelectedContexts([]);
    moveToNext();
  };

  const getAIProvider = async () => {
    if (!aiEnabled) {
      Alert.alert(t('ai.disabledTitle'), t('ai.disabledBody'));
      return null;
    }
    const provider = (settings.ai?.provider ?? 'openai') as 'openai' | 'gemini';
    const apiKey = await loadAIKey(provider);
    if (!apiKey) {
      Alert.alert(t('ai.missingKeyTitle'), t('ai.missingKeyBody'));
      return null;
    }
    return createAIProvider(buildAIConfig(settings, apiKey));
  };

  const applyAISuggestion = (taskId: string, suggested: { title?: string; context?: string; timeEstimate?: Task['timeEstimate'] }) => {
    const nextContexts = suggested.context
      ? Array.from(new Set([...(currentTask?.contexts ?? []), suggested.context]))
      : currentTask?.contexts;
    updateTask(taskId, {
      title: suggested.title ?? currentTask?.title,
      timeEstimate: suggested.timeEstimate ?? currentTask?.timeEstimate,
      contexts: nextContexts,
    });
  };

  const handleAIClarifyInbox = async () => {
    if (!currentTask || isAIWorking) return;
    const title = currentTask.title?.trim();
    if (!title) return;
    setIsAIWorking(true);
    try {
      const provider = await getAIProvider();
      if (!provider) return;
      const contextOptions = Array.from(new Set([
        ...PRESET_CONTEXTS,
        ...(currentTask.contexts ?? []),
      ]));
      const projectContext = currentTask.projectId
        ? {
            projectTitle: projects.find((p) => p.id === currentTask.projectId)?.title || '',
            projectTasks: tasks
              .filter((task) => task.projectId === currentTask.projectId && task.id !== currentTask.id && !task.deletedAt)
              .map((task) => `${task.title}${task.status ? ` (${task.status})` : ''}`)
              .filter(Boolean)
              .slice(0, 20),
          }
        : null;
      const response = await provider.clarifyTask({
        title,
        contexts: contextOptions,
        ...(projectContext ?? {}),
      });
      const actions: AIResponseAction[] = response.options.slice(0, 3).map((option) => ({
        label: option.label,
        onPress: () => {
          updateTask(currentTask.id, { title: option.action });
          closeAIModal();
        },
      }));
      if (response.suggestedAction?.title) {
        actions.push({
          label: t('ai.applySuggestion'),
          variant: 'primary',
          onPress: () => {
            applyAISuggestion(currentTask.id, response.suggestedAction!);
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
      console.warn(error);
      Alert.alert(t('ai.errorTitle'), t('ai.errorBody'));
    } finally {
      setIsAIWorking(false);
    }
  };

  const renderProcessingView = () => {
    if (!isProcessing || !currentTask) return null;

    const projectTitle = currentTask.projectId
      ? projects.find((p) => p.id === currentTask.projectId)?.title
      : null;

    return (
      <Modal
        visible={isProcessing}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setIsProcessing(false)}
      >
        <View style={[styles.fullScreenContainer, { backgroundColor: tc.bg }]}>
          {/* Header with progress */}
          <View style={[styles.processingHeader, { borderBottomColor: tc.border }]}>
            <TouchableOpacity onPress={() => setIsProcessing(false)}>
              <Text style={[styles.headerClose, { color: tc.text }]}>✕</Text>
            </TouchableOpacity>
            <View style={styles.progressContainer}>
              <Text style={[styles.progressText, { color: tc.secondaryText }]}>
                {processedCount + 1}/{totalCount}
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
            <TouchableOpacity onPress={handleSkip}>
              <Text style={styles.skipBtn}>{t('inbox.skip')} →</Text>
            </TouchableOpacity>
          </View>

          {/* Task title prominently displayed */}
          <View style={styles.taskDisplay}>
            <Text style={[styles.taskTitle, { color: tc.text }]}>
              {currentTask.title}
            </Text>
            {currentTask.description && (
              <Text style={[styles.taskDescription, { color: tc.secondaryText }]}>
                {currentTask.description}
              </Text>
            )}
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

          {/* Step content */}
          <View style={styles.stepContainer}>
            {processingStep === 'actionable' && (
              <View style={styles.stepContent}>
                <Text style={[styles.stepQuestion, { color: tc.text }]}>
                  {t('inbox.isActionable')}
                </Text>
                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                  {t('inbox.actionableHint')}
                </Text>

                <View style={styles.buttonColumn}>
                  <TouchableOpacity
                    style={[styles.bigButton, styles.buttonPrimary]}
                    onPress={handleActionable}
                  >
                    <Text style={styles.bigButtonText}>✅ {t('inbox.yesActionable')}</Text>
                  </TouchableOpacity>

                  <View style={styles.buttonRow}>
                    <TouchableOpacity
                      style={[styles.button, { backgroundColor: '#EF4444' }]}
                      onPress={() => handleNotActionable('trash')}
                    >
                      <Text style={styles.buttonPrimaryText}>🗑️ {t('inbox.trash')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.button, { backgroundColor: '#8B5CF6' }]}
                      onPress={() => handleNotActionable('someday')}
                    >
                      <Text style={styles.buttonPrimaryText}>💭 {t('inbox.someday')}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            )}

            {processingStep === 'twomin' && (
              <View style={styles.stepContent}>
                <Text style={[styles.stepQuestion, { color: tc.text }]}>
                  ⏱️ {t('inbox.twoMinRule')}
                </Text>
                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                  {t('inbox.twoMinHint')}
                </Text>

                <View style={styles.buttonColumn}>
                  <TouchableOpacity
                    style={[styles.bigButton, styles.buttonSuccess]}
                    onPress={handleTwoMinYes}
                  >
                    <Text style={styles.bigButtonText}>✅ {t('inbox.doneIt')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bigButton, { backgroundColor: tc.border }]}
                    onPress={handleTwoMinNo}
                  >
                    <Text style={[styles.bigButtonText, { color: tc.text }]}>
                      {t('inbox.takesLonger')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {processingStep === 'decide' && (
              <View style={styles.stepContent}>
                <Text style={[styles.stepQuestion, { color: tc.text }]}>
                  {t('inbox.whatNext')}
                </Text>

                <View style={styles.startDateRow}>
                  <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                    {t('taskEdit.startDateLabel')} ({t('common.notSet')})
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

                <View style={styles.buttonColumn}>
                  <TouchableOpacity
		                    style={[styles.bigButton, styles.buttonPrimary]}
		                    onPress={() => handleDecision('defer')}
		                  >
	                    <Text style={styles.bigButtonText}>📋 {t('inbox.illDoIt')}</Text>
	                  </TouchableOpacity>
	                  <TouchableOpacity
	                    style={[styles.bigButton, { backgroundColor: '#F59E0B' }]}
	                    onPress={() => handleDecision('delegate')}
	                  >
	                    <Text style={styles.bigButtonText}>👤 {t('inbox.delegate')}</Text>
	                  </TouchableOpacity>
                </View>
              </View>
            )}

            {showStartDatePicker && (
              <DateTimePicker
                value={pendingStartDate ?? new Date()}
                mode="date"
                display="default"
                onChange={(event, date) => {
                  if (Platform.OS === 'android') {
                    if (event.type === 'dismissed') {
                      setShowStartDatePicker(false);
                      return;
                    }
                  }
                  setShowStartDatePicker(false);
                  if (!date) return;
                  const next = new Date(date);
                  next.setHours(9, 0, 0, 0);
                  setPendingStartDate(next);
                }}
              />
            )}

	            {processingStep === 'waiting-note' && (
	              <View style={styles.stepContent}>
	                <Text style={[styles.stepQuestion, { color: tc.text }]}>
	                  👤 {t('inbox.waitingQuestion')}
	                </Text>
	                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
	                  {t('inbox.waitingHint')}
	                </Text>

	                <TextInput
	                  style={[styles.waitingInput, { borderColor: tc.border, color: tc.text }]}
	                  placeholder={t('inbox.waitingPlaceholder')}
	                  placeholderTextColor={tc.secondaryText}
	                  value={waitingNote}
	                  onChangeText={setWaitingNote}
                  multiline
                  numberOfLines={3}
                />

                <View style={styles.buttonRow}>
                  <TouchableOpacity
                    style={[styles.button, { backgroundColor: tc.border }]}
                    onPress={handleConfirmWaitingMobile}
	                  >
	                    <Text style={[styles.buttonText, { color: tc.text }]}>{t('inbox.skip')}</Text>
	                  </TouchableOpacity>
	                  <TouchableOpacity
	                    style={[styles.button, { backgroundColor: '#F59E0B' }]}
	                    onPress={handleConfirmWaitingMobile}
	                  >
	                    <Text style={styles.buttonPrimaryText}>✓ {t('common.done')}</Text>
	                  </TouchableOpacity>
                </View>
              </View>
            )}

	            {processingStep === 'context' && (
	              <View style={styles.stepContent}>
	                <Text style={[styles.stepQuestion, { color: tc.text }]}>
	                  {t('inbox.whereDoIt')} {t('inbox.selectMultipleHint')}
	                </Text>

                {/* Selected contexts display */}
	                {selectedContexts.length > 0 && (
	                  <View style={[styles.selectedContextsContainer, { backgroundColor: '#3B82F620' }]}>
	                    <Text style={{ fontSize: 12, color: '#3B82F6', marginBottom: 4 }}>{t('inbox.selectedLabel')}</Text>
	                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
	                      {selectedContexts.map(ctx => (
                        <View key={ctx} style={{ backgroundColor: '#3B82F6', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 }}>
                          <Text style={{ color: '#FFF', fontSize: 12 }}>{ctx}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}

                {/* Custom context input */}
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

                {/* Preset contexts - toggle selection */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.contextScroll}>
                  {PRESET_CONTEXTS.map(ctx => (
                    <TouchableOpacity
                      key={ctx}
                      style={[
                        styles.contextChip,
                        selectedContexts.includes(ctx)
                          ? { backgroundColor: '#3B82F6' }
                          : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border }
                      ]}
                      onPress={() => toggleContext(ctx)}
                    >
                      <Text style={[
                        styles.contextChipText,
                        { color: selectedContexts.includes(ctx) ? '#FFF' : tc.text }
                      ]}>{ctx}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                {/* Done button */}
                <TouchableOpacity
                  style={[styles.bigButton, styles.buttonPrimary, { marginTop: 16 }]}
                  onPress={handleConfirmContextsMobile}
                >
	                  <Text style={styles.bigButtonText}>
	                    {selectedContexts.length > 0
	                      ? `${t('common.done')} (${selectedContexts.length})`
	                      : t('common.done')}
	                  </Text>
                </TouchableOpacity>
              </View>
            )}

	            {processingStep === 'project' && (
	              <View style={styles.stepContent}>
	                <Text style={[styles.stepQuestion, { color: tc.text }]}>
	                  📁 {t('inbox.assignProjectQuestion')}
	                </Text>

                <ScrollView style={{ maxHeight: 300 }}>
                  <TouchableOpacity
                    style={[styles.projectChip, { backgroundColor: '#10B981' }]}
                    onPress={() => handleSetProject(null)}
	                  >
	                    <Text style={styles.projectChipText}>✓ {t('inbox.noProject')}</Text>
	                  </TouchableOpacity>
                  {projects.map(proj => (
                    <TouchableOpacity
                      key={proj.id}
                      style={[styles.projectChip, { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border }]}
                      onPress={() => handleSetProject(proj.id)}
                    >
                      <View style={[styles.projectDot, { backgroundColor: proj.color || '#6B7280' }]} />
                      <Text style={[styles.projectChipText, { color: tc.text }]}>{proj.title}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
          </View>
        </View>
      </Modal>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <TaskList
        statusFilter="inbox"
        title={t('inbox.title')}
        showHeader={false}
        enableBulkActions={false}
        showSort={false}
        showQuickAddHelp={false}
        emptyText={t('inbox.empty')}
        headerAccessory={processButton}
        defaultEditTab="task"
      />
      {aiModal && (
        <AIResponseModal
          visible={Boolean(aiModal)}
          title={aiModal.title}
          message={aiModal.message}
          actions={aiModal.actions}
          onClose={closeAIModal}
        />
      )}
      {renderProcessingView()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  processHeaderButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  processHeaderButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 16,
  },
  taskPreview: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
  },
  taskPreviewText: {
    fontSize: 16,
    fontWeight: '500',
  },
  stepContent: {
    gap: 16,
  },
  stepQuestion: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  stepHint: {
    fontSize: 14,
    textAlign: 'center',
  },
  startDateRow: {
    gap: 8,
    alignItems: 'center',
  },
  startDateActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  startDateButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  startDateButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  startDateClear: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  startDateClearText: {
    fontSize: 12,
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonPrimary: {
    backgroundColor: '#3B82F6',
  },
  buttonSuccess: {
    backgroundColor: '#10B981',
  },
  buttonPrimaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  subLabel: {
    fontSize: 12,
    marginTop: 16,
    marginBottom: 4,
  },
  smallButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  smallButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
  contextScroll: {
    marginTop: 8,
  },
  contextChip: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 20,
    marginRight: 10,
  },
  contextChipText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
  cancelButton: {
    marginTop: 24,
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 16,
  },
  customContextContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    gap: 8,
  },
  contextInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  addContextButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#3B82F6',
  },
  addContextButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 20,
  },
  // New full-screen processing styles
  fullScreenContainer: {
    flex: 1,
    paddingTop: 50,
  },
  processingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  headerClose: {
    fontSize: 24,
    fontWeight: '300',
  },
  progressContainer: {
    flex: 1,
    alignItems: 'center',
    marginHorizontal: 20,
  },
  progressText: {
    fontSize: 14,
    marginBottom: 8,
  },
  progressBar: {
    width: '100%',
    height: 4,
    borderRadius: 2,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#3B82F6',
    borderRadius: 2,
  },
  skipBtn: {
    color: '#3B82F6',
    fontSize: 16,
    fontWeight: '600',
  },
  taskDisplay: {
    padding: 32,
    alignItems: 'center',
  },
  taskTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 12,
  },
	  taskDescription: {
	    fontSize: 16,
	    textAlign: 'center',
	    lineHeight: 24,
	  },
	  taskMetaRow: {
	    marginTop: 12,
	    flexDirection: 'row',
	    flexWrap: 'wrap',
	    justifyContent: 'center',
	    gap: 8,
	  },
	  metaPill: {
	    borderWidth: 1,
	    paddingHorizontal: 10,
	    paddingVertical: 4,
	    borderRadius: 999,
	    fontSize: 12,
	    overflow: 'hidden',
	  },
	  metaPillContextLight: {
	    backgroundColor: '#EFF6FF',
	    color: '#1D4ED8',
	  },
	  metaPillContextDark: {
	    backgroundColor: 'rgba(59,130,246,0.18)',
	    color: '#93C5FD',
	  },
	  metaPillTagLight: {
	    backgroundColor: '#F5F3FF',
	    color: '#6D28D9',
	  },
  metaPillTagDark: {
    backgroundColor: 'rgba(139,92,246,0.18)',
    color: '#C4B5FD',
  },
  aiActionRow: {
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  aiActionButton: {
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
  },
  aiActionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  stepContainer: {
    flex: 1,
    paddingHorizontal: 24,
  },
  buttonColumn: {
    gap: 12,
    marginTop: 20,
  },
  bigButton: {
    paddingVertical: 20,
    paddingHorizontal: 24,
    borderRadius: 16,
    alignItems: 'center',
  },
  bigButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  projectChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginBottom: 10,
  },
  projectChipText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
  },
  projectDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 12,
  },
  selectedContextsContainer: {
    padding: 12,
    borderRadius: 12,
    marginVertical: 8,
  },
  waitingInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    minHeight: 80,
    textAlignVertical: 'top',
    marginVertical: 8,
  },
});
