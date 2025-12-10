import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView, TextInput } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTaskStore, Task, TaskStatus, PRESET_CONTEXTS } from '@focus-gtd/core';
import { TaskList } from '../../../components/task-list';
import { useTheme } from '../../../contexts/theme-context';
import { useLanguage } from '../../../contexts/language-context';
import { Colors } from '@/constants/theme';


export default function InboxScreen() {
  const router = useRouter();
  const { tasks, updateTask, deleteTask } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [processingStep, setProcessingStep] = useState<'actionable' | 'twomin' | 'decide' | 'context' | 'project' | 'waiting-note'>('actionable');
  const [newContext, setNewContext] = useState('');
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [waitingNote, setWaitingNote] = useState('');

  const tc = {
    bg: isDark ? Colors.dark.background : Colors.light.background,
    cardBg: isDark ? '#1F2937' : '#FFFFFF',
    text: isDark ? Colors.dark.text : Colors.light.text,
    secondaryText: isDark ? '#9CA3AF' : '#6B7280',
    border: isDark ? '#374151' : '#E5E7EB',
  };

  const inboxTasks = tasks.filter(t => t.status === 'inbox' && !t.deletedAt);
  const processingQueue = inboxTasks.filter(t => !skippedIds.has(t.id));
  const currentTask = processingQueue[currentIndex] || null;
  const totalCount = inboxTasks.length;
  const processedCount = totalCount - processingQueue.length + currentIndex;

  const startProcessing = () => {
    setIsProcessing(true);
    setCurrentIndex(0);
    setProcessingStep('actionable');
    setSkippedIds(new Set());
  };

  const moveToNext = () => {
    if (currentIndex + 1 < processingQueue.length) {
      setCurrentIndex(currentIndex + 1);
      setProcessingStep('actionable');
    } else {
      // Done processing
      setIsProcessing(false);
      setCurrentIndex(0);
      setSkippedIds(new Set());
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
      updateTask(currentTask.id, {
        status: 'waiting',
        description: waitingNote || currentTask.description
      });
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

    updateTask(currentTask.id, {
      status: 'todo',
      contexts: selectedContexts,
      projectId: projectId || undefined
    });
    setSelectedContexts([]);
    moveToNext();
  };

  const { projects } = useTaskStore();

  const renderProcessingView = () => {
    if (!isProcessing || !currentTask) return null;

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
                {processedCount + 1} of {totalCount}
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
              <Text style={styles.skipBtn}>Skip →</Text>
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
                    <Text style={styles.bigButtonText}>✅ Yes, it's actionable</Text>
                  </TouchableOpacity>

                  <View style={styles.buttonRow}>
                    <TouchableOpacity
                      style={[styles.button, { backgroundColor: '#EF4444' }]}
                      onPress={() => handleNotActionable('trash')}
                    >
                      <Text style={styles.buttonPrimaryText}>🗑️ Trash</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.button, { backgroundColor: '#8B5CF6' }]}
                      onPress={() => handleNotActionable('someday')}
                    >
                      <Text style={styles.buttonPrimaryText}>💭 Someday</Text>
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
                    <Text style={styles.bigButtonText}>✅ Done it!</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bigButton, { backgroundColor: tc.border }]}
                    onPress={handleTwoMinNo}
                  >
                    <Text style={[styles.bigButtonText, { color: tc.text }]}>
                      Takes longer than 2 min
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

                <View style={styles.buttonColumn}>
                  <TouchableOpacity
                    style={[styles.bigButton, styles.buttonPrimary]}
                    onPress={() => handleDecision('defer')}
                  >
                    <Text style={styles.bigButtonText}>📋 I'll do it (Add to Todo)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bigButton, { backgroundColor: '#F59E0B' }]}
                    onPress={() => handleDecision('delegate')}
                  >
                    <Text style={styles.bigButtonText}>👤 Someone else (Waiting)</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {processingStep === 'waiting-note' && (
              <View style={styles.stepContent}>
                <Text style={[styles.stepQuestion, { color: tc.text }]}>
                  👤 Who/what are you waiting for?
                </Text>
                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                  Add a note to remember what you're waiting on
                </Text>

                <TextInput
                  style={[styles.waitingInput, { borderColor: tc.border, color: tc.text }]}
                  placeholder="e.g., Waiting for John to review..."
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
                    <Text style={[styles.buttonText, { color: tc.text }]}>Skip</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.button, { backgroundColor: '#F59E0B' }]}
                    onPress={handleConfirmWaitingMobile}
                  >
                    <Text style={styles.buttonPrimaryText}>✓ Done</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {processingStep === 'context' && (
              <View style={styles.stepContent}>
                <Text style={[styles.stepQuestion, { color: tc.text }]}>
                  {t('inbox.whereDoIt')} (Select multiple or none)
                </Text>

                {/* Selected contexts display */}
                {selectedContexts.length > 0 && (
                  <View style={[styles.selectedContextsContainer, { backgroundColor: '#3B82F620' }]}>
                    <Text style={{ fontSize: 12, color: '#3B82F6', marginBottom: 4 }}>Selected:</Text>
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
                    placeholder="Add new context..."
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
                      ? `Done (${selectedContexts.length} context${selectedContexts.length > 1 ? 's' : ''} selected)`
                      : 'Done - No context needed'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {processingStep === 'project' && (
              <View style={styles.stepContent}>
                <Text style={[styles.stepQuestion, { color: tc.text }]}>
                  📁 Assign to a project? (Optional)
                </Text>

                <ScrollView style={{ maxHeight: 300 }}>
                  <TouchableOpacity
                    style={[styles.projectChip, { backgroundColor: '#10B981' }]}
                    onPress={() => handleSetProject(null)}
                  >
                    <Text style={styles.projectChipText}>✓ No project - Done!</Text>
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
      {inboxTasks.length > 0 && (
        <View style={[styles.processBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <TouchableOpacity
            style={styles.processButton}
            onPress={startProcessing}
          >
            <Text style={styles.processButtonText}>
              ▷ Process Inbox ({inboxTasks.length})
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <TaskList statusFilter="inbox" title={t('inbox.title')} />
      {renderProcessingView()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  processBar: {
    padding: 12,
    borderBottomWidth: 1,
  },
  processButton: {
    backgroundColor: '#3B82F6',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
  },
  processButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
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
