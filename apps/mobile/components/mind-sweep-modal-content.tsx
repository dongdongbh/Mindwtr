import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  addMindSweepCapture,
  buildMindSweepView,
  getMindSweepCaptureTitle,
  INITIAL_MIND_SWEEP_STATE,
  shallow,
  useTaskStore,
  type MindSweepScope,
} from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { CompactText } from '@/components/compact-text';

type MindSweepModalContentProps = {
  onClose: () => void;
};

export function MindSweepModalContent({ onClose }: MindSweepModalContentProps) {
  const { t } = useLanguage();
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const { addTask } = useTaskStore((state) => ({ addTask: state.addTask }), shallow);

  const [scope, setScope] = useState<MindSweepScope>(INITIAL_MIND_SWEEP_STATE.scope);
  const [stepIndex, setStepIndex] = useState(INITIAL_MIND_SWEEP_STATE.step);
  const [draft, setDraft] = useState('');
  const [capturedByGroup, setCapturedByGroup] = useState<Record<string, string[]>>({});
  const [addFailed, setAddFailed] = useState(false);


  const view = buildMindSweepView({ state: { scope, step: stepIndex, captured: capturedByGroup }, draft, addFailed, t });
  const { intro, group, summary } = view;

  const handleAdd = async () => {
    const submitted = draft;
    const title = getMindSweepCaptureTitle(submitted);
    if (!title || !group) return;
    try {


      const result = await addTask(title, { status: 'inbox' });
      if (!result?.success) {
        setAddFailed(true);
        return;
      }
      setCapturedByGroup((current) => addMindSweepCapture(current, group.id, title));

      setDraft((current) => (current === submitted ? '' : current));
      setAddFailed(false);
    } catch {

      setAddFailed(true);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: tc.text }]}>{view.title}</Text>
          <TouchableOpacity
            testID="mind-sweep-close"
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={view.closeLabel}
          >
            <Text style={[styles.closeLabel, { color: tc.tint }]}>{view.closeLabel}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {intro && (
            <>
              <Text style={[styles.bodyText, { color: tc.secondaryText }]}>{intro.text}</Text>
              <Text style={[styles.sectionLabel, { color: tc.text }]}>{intro.scopeLabel}</Text>
              <View style={styles.scopeRow}>
                {intro.scopes.map((option) => {
                  const { selected } = option;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      testID={`mind-sweep-scope-${option.value}`}
                      onPress={() => setScope(option.value)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      style={[
                        styles.scopeButton,
                        { borderColor: tc.border },
                        selected && { backgroundColor: tc.tint, borderColor: tc.tint },
                      ]}
                    >
                      <CompactText
                        style={[styles.scopeButtonText, { color: selected ? tc.onTint : tc.text }]}
                        numberOfLines={2}
                      >
                        {option.label}
                      </CompactText>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity
                testID="mind-sweep-start"
                onPress={() => setStepIndex(intro.start.step)}
                accessibilityRole="button"
                style={[styles.primaryButton, { backgroundColor: filledButton.backgroundColor }]}
              >
                <Text style={[styles.primaryButtonText, { color: filledButton.textColor ?? tc.onTint }]}>{intro.start.label}</Text>
              </TouchableOpacity>
            </>
          )}

          {group && (
            <>
              <View style={styles.groupHeader}>
                <Text testID="mind-sweep-group-title" style={[styles.groupTitle, { color: tc.text }]}>
                  {group.title}
                </Text>
                <Text style={[styles.progress, { color: tc.secondaryText }]}>
                  {group.progress}
                </Text>
              </View>
              {group.prompts.map((prompt, index) => (
                <Text key={`${prompt}-${index}`} style={[styles.prompt, { color: tc.secondaryText }]}>
                  {'•'} {prompt}
                </Text>
              ))}
              <View style={styles.inputRow}>
                <TextInput
                  testID="mind-sweep-input"
                  value={draft}
                  onChangeText={setDraft}
                  onSubmitEditing={() => void handleAdd()}
                  blurOnSubmit={false}
                  returnKeyType="done"
                  placeholder={group.placeholder}
                  placeholderTextColor={tc.secondaryText}
                  style={[styles.input, { borderColor: tc.border, color: tc.text }]}
                />
                <TouchableOpacity
                  testID="mind-sweep-add"
                  onPress={() => void handleAdd()}
                  disabled={group.add.disabled}
                  accessibilityRole="button"
                  style={[styles.addButton, { backgroundColor: filledButton.backgroundColor, opacity: group.add.disabled ? 0.5 : 1 }]}
                >
                  <Text style={[styles.primaryButtonText, { color: filledButton.textColor ?? tc.onTint }]}>{group.add.label}</Text>
                </TouchableOpacity>
              </View>
              {group.addFailed && (
                <Text testID="mind-sweep-add-failed" style={[styles.addFailed, { color: tc.danger }]}>
                  {group.addFailed}
                </Text>
              )}
              {group.captured && (
                <View style={styles.capturedBlock}>
                  <Text style={[styles.capturedLabel, { color: tc.secondaryText }]}>
                    {group.captured.label}
                  </Text>
                  {group.captured.items.map((item, index) => (
                    <Text testID="mind-sweep-captured-item" key={`${item}-${index}`} style={[styles.capturedItem, { color: tc.text }]} numberOfLines={1}>
                      {'•'} {item}
                    </Text>
                  ))}
                </View>
              )}
              <View style={styles.navRow}>
                <TouchableOpacity
                  testID="mind-sweep-back"
                  onPress={() => setStepIndex((index) => index - 1)}
                  disabled={group.back.disabled}
                  accessibilityRole="button"
                  style={[styles.secondaryButton, { borderColor: tc.border, opacity: group.back.disabled ? 0.5 : 1 }]}
                >
                  <Text style={[styles.secondaryButtonText, { color: tc.text }]}>{group.back.label}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="mind-sweep-next"
                  onPress={() => setStepIndex((index) => index + 1)}
                  accessibilityRole="button"
                  style={[styles.primaryButtonInline, { backgroundColor: filledButton.backgroundColor }]}
                >
                  <Text style={[styles.primaryButtonText, { color: filledButton.textColor ?? tc.onTint }]}>{group.next.label}</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {summary && (
            <View testID="mind-sweep-summary">
              <Text style={[styles.groupTitle, { color: tc.text }]}>{summary.title}</Text>
              <Text style={[styles.bodyText, { color: tc.secondaryText }]}>
                {summary.message}
              </Text>
              {summary.hint && (
                <Text style={[styles.bodyText, { color: tc.secondaryText }]}>{summary.hint}</Text>
              )}
              <TouchableOpacity
                testID="mind-sweep-finish"
                onPress={onClose}
                accessibilityRole="button"
                style={[styles.primaryButton, { backgroundColor: filledButton.backgroundColor }]}
              >
                <Text style={[styles.primaryButtonText, { color: filledButton.textColor ?? tc.onTint }]}>{summary.finishLabel}</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  closeLabel: { fontSize: 15, fontWeight: '600' },
  content: { paddingHorizontal: 16, paddingBottom: 24, gap: 10 },
  bodyText: { fontSize: 15, lineHeight: 21 },
  sectionLabel: { fontSize: 15, fontWeight: '600', marginTop: 8 },
  scopeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  scopeButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  scopeButtonText: { fontSize: 14, fontWeight: '600', lineHeight: 18, textAlign: 'center' },
  primaryButton: {
    marginTop: 16,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryButtonInline: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryButtonText: { fontSize: 15, fontWeight: '700' },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  groupTitle: { fontSize: 17, fontWeight: '700' },
  progress: { fontSize: 12 },
  prompt: { fontSize: 14, lineHeight: 20 },
  inputRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  addButton: {
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  capturedBlock: { marginTop: 8, gap: 2 },
  addFailed: { fontSize: 13, marginTop: 8 },
  capturedLabel: { fontSize: 12 },
  capturedItem: { fontSize: 14 },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  secondaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  secondaryButtonText: { fontSize: 15, fontWeight: '600' },
});
