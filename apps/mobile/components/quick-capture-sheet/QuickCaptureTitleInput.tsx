import React, { useState, type RefObject } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CompactText, CompactTextInput } from '../compact-text';
import { acceptCaptureSuggestion, captureAutocompleteSuggestions, captureAutocompleteTrigger, type CaptureSuggestion, type Project } from '@mindwtr/core';
import { styles } from './quick-capture-sheet.styles';

type Props = TextInputProps & {
  inputRef: RefObject<TextInput | null>;
  projects: readonly Project[];
  contexts: readonly string[];
  tags: readonly string[];
  onSelectProject?: (id: string) => void;
  tc: Pick<ThemeColors, 'cardBg' | 'border' | 'text'>;
};

export function QuickCaptureTitleInput({ inputRef, projects, contexts, tags, onSelectProject, tc, value = '', onChangeText, onFocus, onBlur, style, ...props }: Props) {
  const [selection, setSelection] = useState({ start: value.length, end: value.length });
  const [focused, setFocused] = useState(false);
  const trigger = focused && selection.start === selection.end ? captureAutocompleteTrigger(value, selection.start) : null;
  const suggestions = captureAutocompleteSuggestions(trigger, projects, contexts, tags);
  const choose = (suggestion: CaptureSuggestion) => {
    if (!trigger || props.editable === false) return;
    const next = acceptCaptureSuggestion(value, trigger, suggestion);
    if (suggestion.kind === 'project') onSelectProject?.(suggestion.id);
    onChangeText?.(next.text);
    setSelection({ start: next.caret, end: next.caret });
    requestAnimationFrame(() => inputRef.current?.setNativeProps({ selection: { start: next.caret, end: next.caret } }));
  };
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <CompactTextInput {...props} ref={inputRef} value={value} style={style}
        onChangeText={(next) => {
          const caret = Math.max(0, Math.min(next.length, selection.end + next.length - value.length));
          setSelection({ start: caret, end: caret });
          onChangeText?.(next);
        }}
        onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
        onFocus={(event) => { setFocused(true); onFocus?.(event); }}
        onBlur={(event) => { setFocused(false); onBlur?.(event); }} />
      {suggestions.length > 0 ? <View accessibilityRole="list" style={{ backgroundColor: tc.cardBg, borderColor: tc.border, borderWidth: 1, borderRadius: 8 }}>
        {suggestions.map((suggestion) => <Pressable key={suggestion.kind === 'project' ? suggestion.id : suggestion.label}
          accessibilityRole="button" accessibilityLabel={suggestion.label} onPress={() => choose(suggestion)} style={styles.pickerRow}>
          <CompactText style={{ color: tc.text }}>{suggestion.label}</CompactText>
        </Pressable>)}
      </View> : null}
    </View>
  );
}
