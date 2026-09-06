import React from 'react';
import { View, Text, TouchableOpacity, Animated, StyleSheet } from 'react-native';
import { Eye, Pencil } from 'lucide-react-native';

import { useLanguage } from '../../contexts/language-context';
import { useThemeColors } from '../../hooks/use-theme-colors';

type TaskEditTabsProps = {
  editTab: 'task' | 'view';
  onTabPress: (tab: 'task' | 'view') => void;
  scrollX: Animated.Value;
  containerWidth: number;
};

export function TaskEditTabs({ editTab, onTabPress, scrollX, containerWidth }: TaskEditTabsProps) {
  const { t } = useLanguage();
  const tc = useThemeColors();
  const canAnimateIndicator = containerWidth > 0 && typeof (scrollX as { interpolate?: unknown })?.interpolate === 'function';

  return (
    <View style={[styles.modeTabs, { borderBottomColor: tc.border, backgroundColor: tc.cardBg }]}>
      <View
        accessibilityRole="tablist"
        style={[styles.modeTabsTrack, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
      >
        {canAnimateIndicator && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.modeTabIndicator,
              {
                width: containerWidth / 2,
                backgroundColor: tc.tint,
                transform: [
                  {
                    translateX: scrollX.interpolate({
                      inputRange: [0, containerWidth],
                      outputRange: [0, containerWidth / 2],
                      extrapolate: 'clamp',
                    }),
                  },
                ],
              },
            ]}
          />
        )}
        <TouchableOpacity
          accessibilityRole="tab"
          accessibilityState={{ selected: editTab === 'task' }}
          style={styles.modeTab}
          onPress={() => onTabPress('task')}
          activeOpacity={0.85}
        >
          <View style={styles.modeTabLabel}>
            {editTab === 'task' ? <Pencil size={16} color={tc.onTint} accessible={false} /> : <Pencil size={16} color={tc.text} accessible={false} />}
            <Text style={[styles.modeTabText, { color: editTab === 'task' ? tc.onTint : tc.text }]}>
              {t('markdown.edit')}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="tab"
          accessibilityState={{ selected: editTab === 'view' }}
          style={styles.modeTab}
          onPress={() => onTabPress('view')}
          activeOpacity={0.85}
        >
          <View style={styles.modeTabLabel}>
            <Eye size={16} color={editTab === 'view' ? tc.onTint : tc.text} accessible={false} />
            <Text style={[styles.modeTabText, { color: editTab === 'view' ? tc.onTint : tc.text }]}>
              {t('markdown.preview')}
            </Text>
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  modeTabs: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  modeTabsTrack: {
    flex: 1,
    flexDirection: 'row',
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  modeTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  modeTabLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  modeTabIndicator: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 12,
  },
  modeTabText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
