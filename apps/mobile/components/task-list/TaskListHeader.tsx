import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { ArrowUpDown, Folder, SlidersHorizontal, X } from 'lucide-react-native';

import { formatListItemCount, getTaskListHeaderText } from '@mindwtr/core';

import { ListOverflowMenu } from '@/components/list-overflow-menu';
import { styles } from './task-list.styles';
import { TaskListSortButton } from './TaskListSortButton';

type ThemeColors = {
  border: string;
  cardBg: string;
  danger: string;
  filterBg: string;
  onTint: string;
  secondaryText: string;
  text: string;
  tint: string;
};

export type TaskListActiveFilterChip = {
  id: string;
  label: string;
  /** Excluded (subtracting) token — struck through and danger-colored. */
  excluded?: boolean;
  onPress: () => void;
};

type TaskListHeaderProps = {
  activeFilterChips: TaskListActiveFilterChip[];
  count: number;
  /** Inbox-only: keep Sort, Group, and Filters as direct compact controls. */
  directControls?: boolean;
  headerAccessory?: React.ReactNode;
  filterActiveCount: number;
  groupByLabel?: string;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  onOpenFilters: () => void;
  onOpenGroup?: () => void;
  onOpenSort: () => void;
  renderOverflowOnly?: boolean;
  showHeader: boolean;
  showFilterButton?: boolean;
  showOverflow?: boolean;
  showSort: boolean;
  sortByLabel: string;
  t: (key: string) => string;
  themeColors: ThemeColors;
  title: string;
};

export function TaskListHeader({
  activeFilterChips,
  count,
  directControls = false,
  headerAccessory,
  filterActiveCount,
  groupByLabel,
  hasActiveFilters,
  onClearFilters,
  onOpenFilters,
  onOpenGroup,
  onOpenSort,
  renderOverflowOnly = false,
  showHeader,
  showFilterButton = true,
  showOverflow = true,
  showSort,
  sortByLabel,
  t,
  themeColors,
  title,
}: TaskListHeaderProps) {
  // Every label comes from core, shared with the native host.
  const text = getTaskListHeaderText({ sortByLabel, groupByLabel, hasActiveFilters, filterActiveCount, t });
  const activeFilterControl = !directControls && showFilterButton && hasActiveFilters ? (
    <TouchableOpacity
      onPress={onOpenFilters}
      style={[
        styles.activeFiltersButton,
        { borderColor: themeColors.tint, backgroundColor: themeColors.filterBg },
      ]}
      accessibilityRole="button"
      accessibilityLabel={text.activeFilters}
      accessibilityState={{ selected: true }}
      hitSlop={8}
    >
      <SlidersHorizontal size={16} color={themeColors.tint} strokeWidth={2} />
      <Text style={[styles.activeFiltersButtonText, { color: themeColors.tint }]}>{text.activeFilters}</Text>
    </TouchableOpacity>
  ) : null;
  const directControlGroup = directControls ? (
    <View style={styles.headerAccessoryControls}>
      {showSort ? (
        <TaskListSortButton accessibilityLabel={text.sortAccessibilityLabel} onPress={onOpenSort} themeColors={themeColors} />
      ) : null}
      {onOpenGroup ? (
        <TouchableOpacity
          accessibilityLabel={text.groupAccessibilityLabel}
          accessibilityRole="button"
          onPress={onOpenGroup}
          style={styles.directControlButton}
        >
          <View style={[styles.directControlVisual, { borderColor: themeColors.border, backgroundColor: themeColors.filterBg }]}>
            <Folder size={16} color={themeColors.secondaryText} strokeWidth={2} />
          </View>
        </TouchableOpacity>
      ) : null}
      {showFilterButton ? (
        <TouchableOpacity
          accessibilityLabel={text.filtersAccessibilityLabel}
          accessibilityRole="button"
          accessibilityState={{ selected: hasActiveFilters }}
          onPress={onOpenFilters}
          style={[styles.directControlButton, hasActiveFilters ? styles.directControlButtonCounted : null]}
        >
          <View
            style={[
              styles.directControlVisual,
              hasActiveFilters ? styles.directControlVisualCounted : null,
              {
                borderColor: hasActiveFilters ? themeColors.tint : themeColors.border,
                backgroundColor: themeColors.filterBg,
              },
            ]}
          >
            <SlidersHorizontal
              size={16}
              color={hasActiveFilters ? themeColors.tint : themeColors.secondaryText}
              strokeWidth={2}
            />
            {/* How many filters are on, not just that some are. */}
            {hasActiveFilters ? (
              <Text style={[styles.activeFiltersButtonText, { color: themeColors.tint }]}>
                {filterActiveCount}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
      ) : null}
    </View>
  ) : null;
  const overflowControl = !directControls && showOverflow && (showFilterButton || showSort || onOpenGroup) ? (
    <ListOverflowMenu
      actions={[
        ...(showFilterButton ? [{
          id: 'filters',
          label: text.filters,
          icon: (color: string) => <SlidersHorizontal size={18} color={color} strokeWidth={2} />,
          onPress: onOpenFilters,
          selected: hasActiveFilters,
        }] : []),
        ...(showSort ? [{
          id: 'sort',
          label: text.sort,
          accessibilityLabel: text.sortAccessibilityLabel,
          icon: (color: string) => <ArrowUpDown size={18} color={color} strokeWidth={2} />,
          onPress: onOpenSort,
          value: sortByLabel,
        }] : []),
        ...(onOpenGroup ? [{
          id: 'group',
          label: text.group,
          accessibilityLabel: text.groupAccessibilityLabel,
          icon: (color: string) => <Folder size={18} color={color} strokeWidth={2} />,
          onPress: onOpenGroup,
          value: text.groupValue,
        }] : []),
      ]}
      backLabel={text.back}
      closeLabel={text.close}
      moreLabel={text.more}
      themeColors={themeColors}
      triggerStyle={renderOverflowOnly ? styles.navigationOverflowButton : undefined}
    />
  ) : null;
  if (renderOverflowOnly) return overflowControl;
  return (
    <>
      {showHeader ? (
        <View style={[styles.header, { borderBottomColor: themeColors.border, backgroundColor: themeColors.cardBg }]}>
          <View style={styles.headerTopRow}>
            <Text style={[styles.title, { color: themeColors.text }]} accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.count, { color: themeColors.secondaryText }]} accessibilityLabel={formatListItemCount(count, 'task', t)}>
              {formatListItemCount(count, 'task', t)}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {directControlGroup}
            {activeFilterControl}
            {headerAccessory}
            {overflowControl}
          </View>
        </View>
      ) : directControlGroup || overflowControl || activeFilterControl || headerAccessory ? (
        <View style={styles.headerAccessoryRow}>
          <View style={styles.headerAccessoryLeft}>
            {directControlGroup}
            {activeFilterControl}
          </View>
          <View style={styles.headerAccessoryRight}>
            {headerAccessory}
            {overflowControl}
          </View>
        </View>
      ) : null}

      {activeFilterChips.length > 0 ? (
        <View style={[styles.filterSection, { borderBottomColor: themeColors.border, backgroundColor: themeColors.cardBg }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChips}>
            {activeFilterChips.map((chip) => {
              const accent = chip.excluded ? themeColors.danger : themeColors.tint;
              return (
                <TouchableOpacity
                  key={chip.id}
                  accessibilityRole="button"
                  accessibilityLabel={text.chipAccessibilityLabel(chip)}
                  onPress={chip.onPress}
                  style={[
                    styles.filterChip,
                    {
                      borderColor: accent,
                      backgroundColor: themeColors.filterBg,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      { color: accent },
                      chip.excluded ? { textDecorationLine: 'line-through' } : null,
                    ]}
                  >
                    {chip.label}
                  </Text>
                  <X size={14} color={accent} />
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={text.clear}
              onPress={onClearFilters}
              style={[styles.filterChip, { borderColor: themeColors.border, backgroundColor: themeColors.filterBg }]}
            >
              <Text style={[styles.filterChipText, { color: themeColors.secondaryText }]}>
                {text.clear}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      ) : null}
    </>
  );
}
