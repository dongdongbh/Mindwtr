import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { translateWithFallback } from '@mindwtr/core';

import { styles } from './task-list.styles';

type ThemeColors = {
  border: string;
  inputBg: string;
  secondaryText: string;
  text: string;
  tint: string;
};

type TriggerState = { end: number; query: string; start: number; type: 'project' | 'context' };
type Option =
  | { kind: 'create'; label: string; value: string }
  | { kind: 'project'; label: string; value: string }
  | { kind: 'context'; label: string; value: string };

type TaskListQuickAddProps = {
  aiEnabled: boolean;
  applyTypeaheadOption: (option: Option) => void | Promise<void>;
  copilotApplied: boolean;
  copilotContext?: string;
  copilotSuggestion: { context?: string; tags?: string[] } | null;
  copilotTags: string[];
  copilotThinking: boolean;
  enableCopilot: boolean;
  handleAddTask: () => void | Promise<void>;
  newTaskTitle: string;
  onApplyCopilot: () => void;
  onChangeText: (text: string) => void;
  onSelectionChange: (selection: { end: number; start: number }) => void;
  projectId?: string;
  setTypeaheadIndex: (index: number) => void;
  showQuickAddHelp: boolean;
  t: (key: string) => string;
  themeColors: ThemeColors;
  title: string;
  trigger: TriggerState | null;
  typeaheadIndex: number;
  typeaheadOpen: boolean;
  typeaheadOptions: Option[];
};

export function TaskListQuickAdd({
  aiEnabled,
  applyTypeaheadOption,
  copilotApplied,
  copilotContext,
  copilotSuggestion,
  copilotTags,
  copilotThinking,
  enableCopilot,
  handleAddTask,
  newTaskTitle,
  onApplyCopilot,
  onChangeText,
  onSelectionChange,
  projectId,
  setTypeaheadIndex,
  showQuickAddHelp,
  t,
  themeColors,
  title,
  trigger,
  typeaheadIndex,
  typeaheadOpen,
  typeaheadOptions,
}: TaskListQuickAddProps) {
  const resolveText = (key: string, fallback: string) => {
    return translateWithFallback(t, key, fallback);
  };
  const addTaskLabel = resolveText('nav.addTask', 'Add Task');
  const inputLabel = title ? `${addTaskLabel}: ${title}` : resolveText('quickAdd.inputLabel', 'Task title');
  const inputHint = resolveText('quickAdd.inputHint', 'Type a task title, then press add or the return key.');

  return (
    <>
      <View style={[styles.inputContainer, { borderBottomColor: themeColors.border }]}>
        <TextInput
          style={[styles.input, { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text }]}
          autoCapitalize="sentences"
          autoCorrect={false}
          placeholder={t('inbox.addPlaceholder')}
          placeholderTextColor={themeColors.secondaryText}
          value={newTaskTitle}
          onChangeText={(text) => {
            onChangeText(text);
            setTypeaheadIndex(0);
          }}
          onSelectionChange={(event) => {
            const selection = event.nativeEvent.selection;
            onSelectionChange(selection);
          }}
          onSubmitEditing={handleAddTask}
          returnKeyType="done"
          accessibilityLabel={inputLabel}
          accessibilityHint={inputHint}
        />
        <TouchableOpacity
          onPress={handleAddTask}
          style={[
            styles.addButton,
            { backgroundColor: themeColors.tint },
            !newTaskTitle.trim() && styles.addButtonDisabled,
          ]}
          disabled={!newTaskTitle.trim()}
          accessibilityLabel={addTaskLabel}
          accessibilityRole="button"
          accessibilityState={{ disabled: !newTaskTitle.trim() }}
        >
          <Text style={styles.addButtonText}>+</Text>
        </TouchableOpacity>
      </View>
      {typeaheadOpen && trigger && typeaheadOptions.length > 0 && (
        <View style={[styles.typeaheadContainer, { backgroundColor: themeColors.inputBg, borderColor: themeColors.border }]}>
          {typeaheadOptions.map((option, index) => (
            <TouchableOpacity
              key={`${option.kind}:${option.value}`}
              onPress={() => applyTypeaheadOption(option)}
              style={[
                styles.typeaheadRow,
                index === typeaheadIndex && { backgroundColor: themeColors.border },
              ]}
            >
              <Text style={[styles.typeaheadText, { color: themeColors.text }]}>
                {option.kind === 'create' ? `✨ ${option.label}` : option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {enableCopilot && aiEnabled && copilotSuggestion && !copilotApplied && (
        <TouchableOpacity
          style={[styles.copilotPill, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}
          onPress={onApplyCopilot}
        >
          <Text style={[styles.copilotText, { color: themeColors.text }]}>
            ✨ {t('copilot.suggested')}{' '}
            {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
            {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
          </Text>
          <Text style={[styles.copilotHint, { color: themeColors.secondaryText }]}>
            {t('copilot.applyHint')}
          </Text>
        </TouchableOpacity>
      )}
      {enableCopilot && aiEnabled && copilotThinking && !copilotSuggestion && !copilotApplied && (
        <View style={[styles.copilotPill, styles.copilotLoadingRow, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}>
          <ActivityIndicator size="small" color={themeColors.tint} />
          <Text style={[styles.copilotHint, { color: themeColors.secondaryText, marginTop: 0 }]}>
            {t('common.loading')}
          </Text>
        </View>
      )}
      {enableCopilot && aiEnabled && copilotApplied && (
        <View style={[styles.copilotPill, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}>
          <Text style={[styles.copilotText, { color: themeColors.text }]}>
            ✅ {t('copilot.applied')}{' '}
            {copilotContext ? `${copilotContext} ` : ''}
            {copilotTags.length ? copilotTags.join(' ') : ''}
          </Text>
        </View>
      )}
      {showQuickAddHelp && !projectId && (
        <Text style={[styles.quickAddHelp, { color: themeColors.secondaryText }]}>
          {t('quickAdd.help')}
        </Text>
      )}
    </>
  );
}
