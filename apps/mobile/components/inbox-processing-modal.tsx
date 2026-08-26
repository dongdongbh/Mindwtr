import React, { useRef } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import { LayoutList, Layers, X } from 'lucide-react-native';
import { tFallback } from '@mindwtr/core';

import { AIResponseModal } from './ai-response-modal';
import { ToastViewport } from '@/contexts/toast-context';
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
    processedCount,
    t,
    tc,
    totalCount,
  } = controller;
  const androidKeyboardInset = useAndroidKeyboardInset(visible);

  // The controller's counts both shrink as items leave the Inbox, so the raw
  // pair reads "0/3" then "0/2". Latch the session's starting size and count up
  // against it instead: filed and skipped items are both progress.
  const sessionTotalRef = useRef(0);
  const remaining = totalCount - processedCount;
  if (!visible) sessionTotalRef.current = 0;
  else if (remaining > sessionTotalRef.current) sessionTotalRef.current = remaining;
  const sessionTotal = sessionTotalRef.current;
  const sessionProcessed = Math.max(0, sessionTotal - remaining);

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
    const loadingLabel = t('common.loading') !== 'common.loading'
      ? t('common.loading')
      : 'Loading next item...';

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
        <ToastViewport />
        {/* The AI failure alert fires while this modal is up (#940). */}
        <ThemedAlertHost />
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
