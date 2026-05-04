import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type Props = {
  suggestions: string[];
  onSelect: (value: string) => void;
  tc: ThemeColors;
};

export function InboxSuggestionList({ suggestions, onSelect, tc }: Props) {
  if (suggestions.length === 0) return null;

  return (
    <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
      {suggestions.map((name) => (
        <TouchableOpacity
          key={name}
          style={styles.tokenSuggestionChip}
          onPress={() => onSelect(name)}
        >
          <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{name}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}
