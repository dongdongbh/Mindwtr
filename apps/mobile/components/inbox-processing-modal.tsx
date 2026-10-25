import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import { LayoutList, Layers, Pencil, X } from 'lucide-react-native';
import { tFallback, useTaskStore, type Task } from '@mindwtr/core';

import { AIResponseModal } from './ai-response-modal';
import { TaskEditModal } from './task-edit-modal';
import { ThemedAlertHost } from '@/components/themed-alert';
import { styles } from './inbox-processing-modal.styles';
import { InboxStepFlow } from './inbox-processing/InboxStepFlow';
import { useInboxProcessingMode } from '@/lib/view-state/inbox-processing-mode';
import { useInboxProcessingController } from './inbox-processing/useInboxProcessingController';
import { useAndroidKeyboardInset } from '../lib/use-android-keyboard-inset';

type InboxProcessingModalProps = {
  visible: boolean;
  onClose: () => void;
};

const IOS_KEYBOARD_FOOTER_OFFSET = 48;

/**
 * Chrome for Inbox processing: progress, Skip, close, and keyboard handling.
 * The decisions themselves live in InboxStepFlow, one question per screen.
 */
export function InboxProcessingModal({ visible, onClose }: InboxProcessingModalProps) {
  const [processingMode, setProcessingMode] = useInboxProcessingMode();
  const controller = useInboxProcessingController({ visible, onClose });
  const {
    aiModal,
    closeAIModal,
    currentTask,
    formatProgressLabel,
    handleClose,
    handleSkipTask,
    headerStyle,
    progress,
    reloadEditedTask,
    t,
    tc,
  } = controller;
  const updateTask = useTaskStore((state) => state.updateTask);
  // The full task editor for fields processing does not offer, such as a checklist (#1445).
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const closeEditor = useCallback(() => {
    setEditingTask(null);
    reloadEditedTask();
  }, [reloadEditedTask]);
  useEffect(() => {
    if (!visible) setEditingTask(null);
  }, [visible]);
  const androidKeyboardInset = useAndroidKeyboardInset(visible);

  const { total: sessionTotal, processed: sessionProcessed } = progress;

  const quick = processingMode === 'quick';
  // Presentation only — switching mid-queue keeps the same item on screen.
  const modeToggleLabel = quick
    ? tFallback(t, 'process.modeGuided', 'Guided')
    : tFallback(t, 'process.modeQuick', 'Quick');
  const ModeToggleIcon = quick ? LayoutList : Layers;

  if (!visible) return null;

  const progressHeader = (skipAction: React.ReactNode) => (
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
          {formatProgressLabel(sessionProcessed, sessionTotal)}
        </Text>
        <View style={[styles.progressBar, { backgroundColor: tc.border }]}>
          <View
            style={[
              styles.progressFill,
              {
                backgroundColor: tc.tint,
                width: sessionTotal > 0 ? `${(sessionProcessed / sessionTotal) * 100}%` : '0%',
              },
            ]}
          />
        </View>
      </View>
      {skipAction}
    </View>
  );

  if (!currentTask) {
    const loadingLabel = tFallback(t, 'common.loading', 'Loading next item...');

    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
        // Android renders this as a transparent full-cover window that paints
        // its own opaque background, matching the app's other sheets. A
        // non-transparent full-screen Modal window mishandles adjustResize on
        // some OEM Android 15 builds (OnePlus 13): the dialog surface is
        // letterboxed instead of resized, leaving a black band between the
        // lifted content and the keyboard while typing a note.
        transparent={Platform.OS === 'android'}
        statusBarTranslucent
        navigationBarTranslucent
        allowSwipeDismissal
        onRequestClose={handleClose}
      >
        <View style={[styles.fullScreenContainer, { backgroundColor: tc.bg }]}>
          {progressHeader(<View style={styles.headerActionSpacer} />)}
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

  const androidKeyboardLift = Platform.OS === 'android' && androidKeyboardInset > 0
    ? { paddingBottom: androidKeyboardInset }
    : null;

  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
        // See the loading-state Modal above: transparent-with-own-background on
        // Android avoids the OEM letterboxed-resize black band (OnePlus 13).
        transparent={Platform.OS === 'android'}
        statusBarTranslucent
        navigationBarTranslucent
        allowSwipeDismissal
        onRequestClose={handleClose}
      >
        <View style={[styles.fullScreenContainer, { backgroundColor: tc.bg }]}>
          {progressHeader(
            <>
            <TouchableOpacity
              style={styles.modeToggleButton}
              onPress={() => setEditingTask(currentTask)}
              accessibilityRole="button"
              accessibilityLabel={t('common.edit')}
              hitSlop={8}
            >
              <Pencil size={20} color={tc.tint} strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modeToggleButton}
              onPress={() => setProcessingMode(quick ? 'guided' : 'quick')}
              accessibilityRole="button"
              accessibilityLabel={modeToggleLabel}
              hitSlop={8}
            >
              <ModeToggleIcon size={20} color={tc.tint} strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.headerActionButton, styles.headerActionButtonRight]}
              onPress={handleSkipTask}
              accessibilityRole="button"
              accessibilityLabel={tFallback(t, 'inbox.skip', 'Skip')}
            >
              <Text style={[styles.skipBtn, { color: tc.tint }]}>
                {tFallback(t, 'inbox.skip', 'Skip')}
              </Text>
            </TouchableOpacity>
            </>,
          )}

          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? IOS_KEYBOARD_FOOTER_OFFSET : 0}
            style={[styles.keyboardAvoidingContainer, androidKeyboardLift]}
          >
            <InboxStepFlow controller={controller} mode={processingMode} />
          </KeyboardAvoidingView>
        </View>
        {/* The AI failure alert fires while this modal is up (#940). */}
        <ThemedAlertHost />
        {/* Mounted inside this modal so iOS presents the editor over the processing sheet. */}
        <TaskEditModal
          visible={Boolean(editingTask)}
          task={editingTask}
          onClose={closeEditor}
          onSave={updateTask}
          defaultTab="task"
        />
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
