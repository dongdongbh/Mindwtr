import type React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import type { TimeEstimate } from '@mindwtr/core';

import { MOBILE_TIME_ESTIMATE_OPTIONS, formatTimeEstimateChipLabel } from '../time-estimate-filter-utils';
import { styles } from './task-list.styles';

type ThemeColors = {
  border: string;
  cardBg: string;
  filterBg: string;
  onTint: string;
  secondaryText: string;
  text: string;
  tint: string;
};

type TaskListHeaderProps = {
  count: number;
  enableBulkActions: boolean;
  hasActiveTimeEstimateFilters: boolean;
  headerAccessory?: React.ReactNode;
  onOpenSort: () => void;
  onToggleSelectionMode: () => void;
  selectedTimeEstimates: TimeEstimate[];
  selectionMode: boolean;
  setTimeEstimates: () => void;
  showHeader: boolean;
  showSort: boolean;
  showTimeEstimateFilters: boolean;
  sortByLabel: string;
  t: (key: string) => string;
  themeColors: ThemeColors;
  title: string;
  toggleTimeEstimate: (estimate: TimeEstimate) => void;
};

export function TaskListHeader({
  count,
  enableBulkActions,
  hasActiveTimeEstimateFilters,
  headerAccessory,
  onOpenSort,
  onToggleSelectionMode,
  selectedTimeEstimates,
  selectionMode,
  setTimeEstimates,
  showHeader,
  showSort,
  showTimeEstimateFilters,
  sortByLabel,
  t,
  themeColors,
  title,
  toggleTimeEstimate,
}: TaskListHeaderProps) {
  return (
    <>
      {showHeader ? (
        <View style={[styles.header, { borderBottomColor: themeColors.border, backgroundColor: themeColors.cardBg }]}>
          <View style={styles.headerTopRow}>
            <Text style={[styles.title, { color: themeColors.text }]} accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.count, { color: themeColors.secondaryText }]} accessibilityLabel={`${count} tasks`}>
              {count} {t('common.tasks')}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {showSort && (
              <TouchableOpacity
                onPress={onOpenSort}
                style={[styles.sortButton, { borderColor: themeColors.border }]}
                accessibilityRole="button"
                accessibilityLabel={t('sort.label')}
              >
                <Text style={[styles.sortButtonText, { color: themeColors.secondaryText }]}>
                  {sortByLabel}
                </Text>
              </TouchableOpacity>
            )}
            {headerAccessory}
            {enableBulkActions && (
              <TouchableOpacity
                onPress={onToggleSelectionMode}
                style={[
                  styles.selectButton,
                  { borderColor: themeColors.border, backgroundColor: selectionMode ? themeColors.filterBg : 'transparent' },
                ]}
                accessibilityRole="button"
                accessibilityLabel={selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
              >
                <Text style={[styles.selectButtonText, { color: themeColors.text }]}>
                  {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      ) : headerAccessory ? (
        <View style={styles.headerAccessoryRow}>{headerAccessory}</View>
      ) : null}

      {showTimeEstimateFilters && (
        <View style={[styles.filterSection, { borderBottomColor: themeColors.border, backgroundColor: themeColors.cardBg }]}>
          <Text style={[styles.filterLabel, { color: themeColors.secondaryText }]}>
            {t('filters.timeEstimate')}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChips}>
            <TouchableOpacity
              onPress={setTimeEstimates}
              style={[
                styles.filterChip,
                {
                  borderColor: themeColors.border,
                  backgroundColor: !hasActiveTimeEstimateFilters ? themeColors.tint : themeColors.filterBg,
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: !hasActiveTimeEstimateFilters }}
            >
              <Text style={[styles.filterChipText, { color: !hasActiveTimeEstimateFilters ? themeColors.onTint : themeColors.text }]}>
                {t('common.all')}
              </Text>
            </TouchableOpacity>
            {MOBILE_TIME_ESTIMATE_OPTIONS.map((estimate) => {
              const isActive = selectedTimeEstimates.includes(estimate);
              return (
                <TouchableOpacity
                  key={estimate}
                  onPress={() => toggleTimeEstimate(estimate)}
                  style={[
                    styles.filterChip,
                    {
                      borderColor: themeColors.border,
                      backgroundColor: isActive ? themeColors.tint : themeColors.filterBg,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                >
                  <Text style={[styles.filterChipText, { color: isActive ? themeColors.onTint : themeColors.text }]}>
                    {formatTimeEstimateChipLabel(estimate)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}
    </>
  );
}
