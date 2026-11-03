import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { QuickAddPreviewEntry } from '@mindwtr/core';

import { CompactText } from '@/components/compact-text';
import type { ThemeColors } from '@/hooks/use-theme-colors';


const MAX_VISIBLE_ENTRIES = 6;

type QuickAddPreviewProps = {
  entries: QuickAddPreviewEntry[];
  tc: ThemeColors;
};


export function QuickAddPreview({ entries, tc }: QuickAddPreviewProps) {
  if (entries.length === 0) return null;
  const visible = entries.slice(0, MAX_VISIBLE_ENTRIES);
  const overflow = entries.length - visible.length;

  return (
    <View
      style={styles.strip}


      accessibilityLiveRegion="polite"
      testID="quick-add-preview"
    >
      {visible.map((entry) => {
        const warning = entry.tone === 'warning';
        const isTitle = entry.kind === 'title';
        return (
          <View
            key={entry.id}
            style={[
              styles.chip,
              {
                backgroundColor: warning ? `${tc.danger}1A` : tc.filterBg,
                borderColor: warning ? tc.danger : tc.border,
              },
            ]}


            {...(isTitle ? { importantForAccessibility: 'no-hide-descendants' as const, accessibilityElementsHidden: true } : null)}
          >
            {entry.label ? (
              <CompactText
                style={[styles.chipLabel, { color: warning ? tc.danger : tc.secondaryText }]}
                numberOfLines={1}
              >
                {entry.label}
              </CompactText>
            ) : null}
            <CompactText
              style={[styles.chipValue, { color: warning ? tc.danger : tc.text }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {entry.value}
            </CompactText>
          </View>
        );
      })}
      {overflow > 0 ? (
        <View style={[styles.chip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}>
          <CompactText style={[styles.chipValue, { color: tc.secondaryText }]} numberOfLines={1}>
            {`+${overflow}`}
          </CompactText>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 6,
    rowGap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '100%',
    columnGap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipLabel: {
    fontSize: 11,
  },
  chipValue: {
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '600',
  },
});
