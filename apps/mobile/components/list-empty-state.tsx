import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export interface ListEmptyStateProps {
  message: string;
  hint?: string;
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  mutedTextColor?: string;
}

export function ListEmptyState({
  message,
  hint,
  backgroundColor,
  borderColor,
  textColor,
  mutedTextColor,
}: ListEmptyStateProps) {
  const accessibilityLabel = hint ? `${message}. ${hint}` : message;
  return (
    <View
      style={[styles.container, { backgroundColor, borderColor }]}
      accessible
      accessibilityLabel={accessibilityLabel}
    >
      <Text
        style={[styles.text, { color: textColor }]}
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
      >
        {message}
      </Text>
      {hint ? (
        <Text
          style={[styles.hint, { color: mutedTextColor ?? textColor }]}
          accessibilityRole="text"
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 36,
    paddingHorizontal: 20,
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
  },
  text: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  hint: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: '400',
    textAlign: 'center',
    opacity: 0.8,
  },
});
