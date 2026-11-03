import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { flushPendingSave, generateUUID, shallow, useTaskStore } from '@mindwtr/core';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { logInfo, logWarn } from '@/lib/app-log';
import {
  APPLE_IMAGE_LIMITS,
  AppleImageEvaluationController,
  type AppleImageDiagnostic,
} from '@/lib/apple-image-evaluation';
import { appleImageNativeBridge } from '@/lib/apple-image-native';

function recordDiagnostic(event: AppleImageDiagnostic): void {
  const logger = event.outcome === 'failed' || event.outcome === 'rejected' ? logWarn : logInfo;
  void logger('Apple image capture evaluation event', {
    scope: 'capture',
    extra: {
      releaseCheck: 'v1.3.1/apple-image-capture-evaluation',
      stage: event.stage,
      outcome: event.outcome,
      kind: event.kind,
    },
  });
}


export const appleImageEvaluationController = new AppleImageEvaluationController(
  appleImageNativeBridge,
  generateUUID,
  recordDiagnostic,
);

export type AppleImageCaptureEvaluationProps = {
  onClose?: () => void;
  onSaved?: (taskId: string) => void;
  controller?: AppleImageEvaluationController;
};

export function AppleImageCaptureEvaluation({
  onClose,
  onSaved,
  controller = appleImageEvaluationController,
}: AppleImageCaptureEvaluationProps) {
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const { addTask, retryPersistence } = useTaskStore((state) => ({
    addTask: state.addTask,
    retryPersistence: state.retryPersistence,
  }), shallow);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') controller.cancelAnalysis('background');
    });
    return () => {
      mountedRef.current = false;
      subscription.remove();
      controller.cancelAnalysis('unmount');
    };
  }, [controller]);

  const pickImage = useCallback(async () => {
    setPickerError(null);
    try {
      const picker = await import('expo-image-picker');

      const result = await picker.launchImageLibraryAsync({
        mediaTypes: picker.MediaTypeOptions.Images,
        allowsMultipleSelection: false,
        quality: 1,
      });
      if (!mountedRef.current || result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const error = controller.selectImage({
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        ...(typeof asset.fileSize === 'number' ? { inputBytes: asset.fileSize } : {}),
        fileName: asset.fileName,
      });
      if (error && mountedRef.current) setPickerError(error);
    } catch {
      if (mountedRef.current) {
        setPickerError('The system image picker is unavailable in this development build.');
      }
    }
  }, [controller]);

  const analyze = useCallback(() => {
    setPickerError(null);
    void controller.analyze();
  }, [controller]);

  const save = useCallback(() => {
    void controller.save({
      addTask,
      flushPendingSave,
      retryPendingPersistence: retryPersistence,
    }).then((result) => {
      if (mountedRef.current && result.success && result.id) onSaved?.(result.id);
    });
  }, [addTask, controller, onSaved, retryPersistence]);

  const cancel = useCallback(() => {
    if (controller.discard()) onClose?.();
  }, [controller, onClose]);

  const proposalLocked = state.phase === 'saving' || state.saveNeedsFlush || state.phase === 'saved';
  const saveDisabled = !state.proposal?.title.trim() || state.phase === 'saving' || state.phase === 'saved';
  const selectedModel = state.proposalSource === 'model';
  const selectedOcr = state.proposalSource === 'ocr';

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { backgroundColor: tc.bg }]}
      keyboardShouldPersistTaps="handled"
      testID="apple-image-capture-evaluation"
    >
      <Text accessibilityRole="header" style={[styles.title, { color: tc.text }]}>Image to Inbox evaluation</Text>
      <Text style={[styles.help, { color: tc.secondaryText }]}>Select one image. Analysis stays on this device and never attaches or syncs the source image.</Text>

      <TouchableOpacity
        accessibilityRole="button"
        onPress={pickImage}
        disabled={proposalLocked}
        style={[styles.outlineButton, { borderColor: tc.tint }]}
        testID="apple-image-pick"
      >
        <Text style={[styles.outlineButtonText, { color: tc.tint }]}>{state.selection ? 'Choose another image' : 'Choose image'}</Text>
      </TouchableOpacity>

      {state.selection && (
        <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <Image
            accessibilityLabel="Selected source image preview"
            resizeMode="contain"
            source={{ uri: state.selection.uri }}
            style={[styles.preview, { backgroundColor: tc.inputBg }]}
          />
          <Text style={[styles.meta, { color: tc.secondaryText }]}>
            {state.selection.width} × {state.selection.height}
            {state.selection.inputBytes ? ` · ${(state.selection.inputBytes / 1_048_576).toFixed(1)} MB` : ''}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={state.phase === 'analyzing' || proposalLocked}
            onPress={analyze}
            style={[
              styles.filledButton,
              { backgroundColor: filledButton.backgroundColor, opacity: state.phase === 'analyzing' || proposalLocked ? 0.55 : 1 },
            ]}
            testID="apple-image-analyze"
          >
            {state.phase === 'analyzing'
              ? <ActivityIndicator color={filledButton.textColor ?? tc.onTint} />
              : <Text style={[styles.filledButtonText, { color: filledButton.textColor ?? tc.onTint }]}>Run local comparison</Text>}
          </TouchableOpacity>
          {state.phase === 'analyzing' && (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => controller.cancelAnalysis('user')}
              style={styles.textButton}
              testID="apple-image-cancel-analysis"
            >
              <Text style={{ color: tc.tint }}>Cancel analysis</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {state.comparison && (
        <View style={styles.comparisonRow}>
          <ProposalOption
            label="Foundation Model"
            durationMs={state.comparison.model.durationMs}
            status={state.comparison.model.status}
            proposal={state.comparison.model.proposal}
            selected={selectedModel}
            onSelect={() => controller.chooseProposal('model')}
            colors={tc}
          />
          <ProposalOption
            label="Vision OCR baseline"
            durationMs={state.comparison.ocr.durationMs}
            status={state.comparison.ocr.status}
            proposal={state.comparison.ocr.proposal}
            selected={selectedOcr}
            onSelect={() => controller.chooseProposal('ocr')}
            colors={tc}
          />
        </View>
      )}

      {state.proposal && (
        <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <Text style={[styles.sectionTitle, { color: tc.text }]}>Editable Inbox proposal</Text>
          <TextInput
            accessibilityLabel="Proposed task title"
            maxLength={APPLE_IMAGE_LIMITS.maxTitleLength}
            editable={!proposalLocked}
            onChangeText={(title) => controller.updateProposal({ title })}
            placeholder="Task title"
            placeholderTextColor={tc.secondaryText}
            style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
            value={state.proposal.title}
          />
          <TextInput
            accessibilityLabel="Proposed task notes"
            maxLength={APPLE_IMAGE_LIMITS.maxDescriptionLength}
            editable={!proposalLocked}
            multiline
            onChangeText={(description) => controller.updateProposal({ description })}
            placeholder="Notes (optional)"
            placeholderTextColor={tc.secondaryText}
            style={[styles.input, styles.notes, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
            textAlignVertical="top"
            value={state.proposal.description}
          />
          <Text style={[styles.help, { color: tc.secondaryText }]}>Creates an Inbox task without dates, reminders, projects, tags, or attachments.</Text>
        </View>
      )}

      {(pickerError || state.errorCode) && (
        <Text accessibilityRole="alert" style={[styles.error, { color: tc.danger }]} testID="apple-image-error">
          {pickerError ?? errorMessage(state.errorCode, state.saveNeedsFlush)}
        </Text>
      )}

      {state.phase === 'saved' ? (
        <View style={styles.actionRow}>
          <Text accessibilityLiveRegion="polite" style={[styles.saved, { color: tc.tint }]}>Saved durably to Inbox.</Text>
          <TouchableOpacity accessibilityRole="button" onPress={() => controller.startOver()} style={styles.textButton}>
            <Text style={{ color: tc.tint }}>Evaluate another image</Text>
          </TouchableOpacity>
          {onClose && (
            <TouchableOpacity accessibilityRole="button" onPress={onClose} style={styles.textButton}>
              <Text style={{ color: tc.tint }}>Close</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <View style={styles.actionRow}>
          {state.proposal && (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: saveDisabled }}
              disabled={saveDisabled}
              onPress={save}
              style={[styles.filledButton, { backgroundColor: filledButton.backgroundColor, opacity: saveDisabled ? 0.55 : 1 }]}
              testID="apple-image-save"
            >
              {state.phase === 'saving'
                ? <ActivityIndicator color={filledButton.textColor ?? tc.onTint} />
                : <Text style={[styles.filledButtonText, { color: filledButton.textColor ?? tc.onTint }]}>
                  {state.saveNeedsFlush ? 'Retry durable save' : 'Save to Inbox'}
                </Text>}
            </TouchableOpacity>
          )}
          {!state.saveNeedsFlush && state.phase !== 'saving' && (
            <TouchableOpacity accessibilityRole="button" onPress={cancel} style={styles.textButton} testID="apple-image-cancel">
              <Text style={{ color: tc.secondaryText }}>Cancel and forget image</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </ScrollView>
  );
}

type ProposalOptionProps = {
  label: string;
  durationMs?: number;
  status: string;
  proposal: { title: string; description: string } | null;
  selected: boolean;
  onSelect: () => void;
  colors: ReturnType<typeof useThemeColors>;
};

function ProposalOption({ label, durationMs, status, proposal, selected, onSelect, colors }: ProposalOptionProps) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled: !proposal, selected }}
      disabled={!proposal}
      onPress={onSelect}
      style={[
        styles.comparisonCard,
        { backgroundColor: colors.cardBg, borderColor: selected ? colors.tint : colors.border },
      ]}
    >
      <Text style={[styles.optionLabel, { color: colors.text }]}>{label}</Text>
      <Text style={[styles.meta, { color: colors.secondaryText }]}>
        {status}{durationMs === undefined ? '' : ` · ${Math.round(durationMs)} ms`}
      </Text>
      <Text numberOfLines={3} style={[styles.optionTitle, { color: proposal ? colors.text : colors.secondaryText }]}>
        {proposal?.title ?? 'No usable proposal'}
      </Text>
    </TouchableOpacity>
  );
}

function errorMessage(errorCode: string | null, saveNeedsFlush: boolean): string {
  if (saveNeedsFlush) return 'The task exists locally, but durable persistence did not finish. Retry without creating a duplicate.';
  switch (errorCode) {
    case 'invalidImage': return 'Choose a smaller valid image.';
    case 'bridgeUnavailable': return 'This development build does not include the Apple image evaluation bridge.';
    case 'analysisFailed': return 'Local analysis did not produce a usable task. Manual capture is still available.';
    case 'createFailed': return 'The task was not created. Your proposal is retained so you can retry.';
    case 'persistenceFailed': return 'Durable persistence failed. Retry without creating a duplicate.';
    default: return 'The evaluation could not continue.';
  }
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, padding: 20, gap: 16 },
  title: { fontSize: 24, fontWeight: '700' },
  sectionTitle: { fontSize: 17, fontWeight: '600' },
  help: { fontSize: 14, lineHeight: 20 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, gap: 12 },
  preview: { width: '100%', height: 220, borderRadius: 10 },
  meta: { fontSize: 12 },
  outlineButton: { minHeight: 44, borderWidth: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  outlineButtonText: { fontSize: 16, fontWeight: '600' },
  filledButton: { minHeight: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  filledButtonText: { fontSize: 16, fontWeight: '600' },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  comparisonRow: { flexDirection: 'row', gap: 10 },
  comparisonCard: { flex: 1, minHeight: 116, borderWidth: 1, borderRadius: 12, padding: 12, gap: 5 },
  optionLabel: { fontSize: 14, fontWeight: '600' },
  optionTitle: { fontSize: 14, lineHeight: 19 },
  input: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  notes: { minHeight: 110 },
  error: { fontSize: 14, lineHeight: 20 },
  saved: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
  actionRow: { gap: 6 },
});
