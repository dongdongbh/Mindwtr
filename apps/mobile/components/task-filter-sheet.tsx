import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  formatTimeEstimateLabel,
  tFallback,
  type TaskEnergyLevel,
  type TaskMetadataFilterVisibility,
  type TaskPriority,
  type TimeEstimate,
} from '@mindwtr/core';
import { X } from 'lucide-react-native';

import { CompactText } from '@/components/compact-text';
import { PriorityFlag } from '@/components/priority-flag';
import { ThemedAlertHost } from '@/components/themed-alert';
import type { TaskFilterSelections } from '@/hooks/use-task-filter-selections';

/**
 * The one filter sheet for Focus and the task list. Both views hold their
 * selections in useTaskFilterSelections and render them here, so a filter
 * concept only ever has one picker. View-specific chrome (Focus's sort,
 * group-by, and saved-filter controls) arrives through the header and top
 * slots rather than forking the sheet.
 */

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: TaskEnergyLevel[] = ['low', 'medium', 'high'];

export type TaskFilterSheetColors = {
  bg: string;
  border: string;
  cardBg: string;
  danger: string;
  filterBg: string;
  onTint: string;
  secondaryText: string;
  text: string;
  tint: string;
};

export type FilterChipVariant = 'advanced' | 'excluded';

type FilterChipProps = {
  label: string;
  /** Decorative node (priority dot) rendered before the label. */
  leading?: React.ReactNode;
  selected: boolean;
  themeColors: TaskFilterSheetColors;
  onPress?: () => void;
  variant?: FilterChipVariant;
  /** Accessible name for the advanced chip's remove button. */
  removeLabel?: string;
  excludedLabel?: string;
};

/**
 * One filter chip. `advanced` marks a saved-filter criterion no picker can
 * express (dashed, removable); `excluded` marks a token that subtracts and
 * relies on the strikethrough so the state survives E-ink/mono themes.
 */
export function FilterChip({
  label,
  selected,
  themeColors,
  onPress,
  variant,
  removeLabel,
  excludedLabel,
  leading,
}: FilterChipProps) {
  const isAdvanced = variant === 'advanced';
  const isExcluded = variant === 'excluded';
  const chipStyle = [
    styles.filterChip,
    isAdvanced ? styles.filterChipAdvanced : null,
    {
      backgroundColor: isAdvanced || isExcluded ? themeColors.filterBg : selected ? themeColors.tint : themeColors.filterBg,
      borderColor: isAdvanced ? themeColors.tint : isExcluded ? themeColors.danger : selected ? themeColors.tint : themeColors.border,
    },
  ];
  const textColor = isAdvanced
    ? themeColors.tint
    : isExcluded ? themeColors.danger : selected ? themeColors.onTint : themeColors.text;
  const chipText = (
    <CompactText
      style={[styles.filterChipText, { color: textColor }, isExcluded ? { textDecorationLine: 'line-through' as const } : null]}
      numberOfLines={2}
    >
      {label}
    </CompactText>
  );

  if (!onPress) {
    return <View style={chipStyle}>{leading}{chipText}</View>;
  }

  if (isAdvanced) {
    return (
      <View style={chipStyle}>
        {chipText}
        <TouchableOpacity
          accessibilityLabel={removeLabel}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onPress}
          style={styles.filterChipAction}
        >
          <X size={16} color={textColor} />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={isExcluded && excludedLabel ? `${label} (${excludedLabel})` : undefined}
      onPress={onPress}
      style={chipStyle}
    >
      {leading}
      {chipText}
    </TouchableOpacity>
  );
}

export type TaskFilterSheetOptions = {
  /** Context and tag chips offered by the visible tasks. */
  tokens: string[];
  /** Project chips, including the "no project" sentinel when it applies. */
  projects?: { id: string; title: string }[];
  timeEstimates: TimeEstimate[];
  visibility: TaskMetadataFilterVisibility;
};

type TaskFilterSheetProps = {
  visible: boolean;
  onClose: () => void;
  selections: TaskFilterSelections;
  options: TaskFilterSheetOptions;
  themeColors: TaskFilterSheetColors;
  t: (key: string) => string;
  /** Extra header buttons, left of Clear (Focus's save-filter action). */
  headerActions?: React.ReactNode;
  /** Content above the filter sections (Focus's sort, group-by, active chips). */
  topContent?: React.ReactNode;
  /**
   * Rendered in place of the sheet body inside the same modal (Focus's
   * save-filter dialog), so stepping into it does not remount the modal.
   */
  overlay?: React.ReactNode;
};

export function TaskFilterSheet({
  visible,
  onClose,
  selections,
  options,
  themeColors,
  t,
  headerActions,
  topContent,
  overlay,
}: TaskFilterSheetProps) {
  const resolveText = (key: string, fallback: string) => tFallback(t, key, fallback);
  const { visibility } = options;
  const projectOptions = options.projects ?? [];
  const excludedLabel = resolveText('filters.excluded', 'Excluded');

  const renderMatchMode = (
    kind: 'context' | 'tag',
    label: string,
    mode: typeof selections.contextMatchMode,
  ) => (
    <View style={styles.matchModeRow}>
      <Text style={[styles.matchModeLabel, { color: themeColors.secondaryText }]}>{label}</Text>
      <View style={[styles.matchModeControl, { borderColor: themeColors.border, backgroundColor: themeColors.filterBg }]}>
        {(['any', 'all'] as const).map((option) => (
          <TouchableOpacity
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === option }}
            onPress={() => selections.setMatchMode(kind, option)}
            style={[
              styles.matchModeButton,
              { backgroundColor: mode === option ? themeColors.tint : 'transparent' },
            ]}
          >
            <Text
              style={[
                styles.matchModeButtonText,
                { color: mode === option ? themeColors.onTint : themeColors.secondaryText },
              ]}
            >
              {option === 'any' ? resolveText('filters.matchAny', 'Any') : resolveText('common.all', 'All')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  return (
    <Modal
      animationType="fade"
      accessibilityViewIsModal
      transparent
      visible={visible}
      onRequestClose={onClose}
    >
      {overlay ?? (
      <View style={styles.sheetRoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={resolveText('common.close', 'Close')}
          onPress={onClose}
          style={styles.sheetBackdrop}
        />
        <View
          accessibilityLabel={resolveText('filters.label', 'Filters')}
          style={[styles.sheet, { backgroundColor: themeColors.cardBg, borderColor: themeColors.border }]}
        >
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: themeColors.text }]}>
              {resolveText('filters.label', 'Filters')}
            </Text>
            <View style={styles.sheetHeaderActions}>
              {headerActions}
              {selections.hasActive ? (
                <TouchableOpacity accessibilityRole="button" onPress={selections.clear} style={styles.sheetTextButton}>
                  <Text style={[styles.sheetTextButtonText, { color: themeColors.tint }]}>
                    {resolveText('filters.clear', 'Clear')}
                  </Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={resolveText('common.close', 'Close')}
                onPress={onClose}
                style={styles.sheetIconButton}
              >
                <X size={18} color={themeColors.secondaryText} />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetContent}
            showsVerticalScrollIndicator={false}
          >
            {selections.view === 'list' ? (
              <>
                <Text style={[styles.sheetSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText('common.search', 'Search')}
                </Text>
                <TextInput
                  accessibilityLabel={resolveText('common.search', 'Search')}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={selections.setSearchQuery}
                  placeholder={resolveText('search.placeholder', 'Search tasks')}
                  placeholderTextColor={themeColors.secondaryText}
                  returnKeyType="search"
                  style={[styles.sheetInput, { backgroundColor: themeColors.bg, borderColor: themeColors.border, color: themeColors.text }]}
                  value={selections.searchQuery}
                />
              </>
            ) : null}

            {topContent}

            {options.tokens.length > 0 ? (
              <>
                <Text style={[styles.sheetSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText('filters.contexts', 'Contexts & tags')}
                </Text>
                <View style={styles.sheetChipRow}>
                  {options.tokens.map((token) => (
                    <FilterChip
                      key={`token:${token}`}
                      label={token}
                      selected={selections.tokens.includes(token)}
                      themeColors={themeColors}
                      onPress={() => selections.toggleToken(token)}
                      variant={selections.excludedTokens.includes(token) ? 'excluded' : undefined}
                      excludedLabel={excludedLabel}
                    />
                  ))}
                </View>
                {selections.showContextMatchMode
                  ? renderMatchMode('context', resolveText('filters.contextMatchMode', 'Context match'), selections.contextMatchMode)
                  : null}
                {selections.showTagMatchMode
                  ? renderMatchMode('tag', resolveText('filters.tagMatchMode', 'Tag match'), selections.tagMatchMode)
                  : null}
              </>
            ) : null}

            {projectOptions.length > 0 ? (
              <>
                <Text style={[styles.sheetSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText('filters.projects', 'Projects')}
                </Text>
                <View style={styles.sheetChipRow}>
                  {projectOptions.map((project) => (
                    <FilterChip
                      key={`project:${project.id}`}
                      label={project.title}
                      selected={selections.projects.includes(project.id)}
                      themeColors={themeColors}
                      onPress={() => selections.toggleProject(project.id)}
                    />
                  ))}
                </View>
              </>
            ) : null}

            {visibility.location ? (
              <>
                <Text style={[styles.sheetSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText('taskEdit.locationLabel', 'Location')}
                </Text>
                <TextInput
                  accessibilityLabel={resolveText('taskEdit.locationLabel', 'Location')}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={selections.setLocation}
                  placeholder={resolveText('taskEdit.locationPlaceholder', 'e.g. Office')}
                  placeholderTextColor={themeColors.secondaryText}
                  returnKeyType="done"
                  style={[styles.sheetInput, { backgroundColor: themeColors.bg, borderColor: themeColors.border, color: themeColors.text }]}
                  value={selections.locationQuery}
                />
              </>
            ) : null}

            {visibility.priority ? (
              <>
                <Text style={[styles.sheetSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText('filters.priority', 'Priority')}
                </Text>
                <View style={styles.sheetChipRow}>
                  {PRIORITY_OPTIONS.map((priority) => (
                    <FilterChip
                      key={`priority:${priority}`}
                      label={t(`priority.${priority}`)}
                      leading={<PriorityFlag priority={priority} />}
                      selected={selections.priorities.includes(priority)}
                      themeColors={themeColors}
                      onPress={() => selections.togglePriority(priority)}
                    />
                  ))}
                </View>
              </>
            ) : null}

            {visibility.energyLevel ? (
              <>
                <Text style={[styles.sheetSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText('taskEdit.energyLevel', 'Energy level')}
                </Text>
                <View style={styles.sheetChipRow}>
                  {ENERGY_LEVEL_OPTIONS.map((energyLevel) => (
                    <FilterChip
                      key={`energy:${energyLevel}`}
                      label={t(`energyLevel.${energyLevel}`)}
                      selected={selections.energyLevels.includes(energyLevel)}
                      themeColors={themeColors}
                      onPress={() => selections.toggleEnergyLevel(energyLevel)}
                    />
                  ))}
                </View>
              </>
            ) : null}

            {visibility.timeEstimate && options.timeEstimates.length > 0 ? (
              <>
                <Text style={[styles.sheetSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText('filters.timeEstimate', 'Time estimate')}
                </Text>
                <View style={styles.sheetChipRow}>
                  {options.timeEstimates.map((estimate) => (
                    <FilterChip
                      key={`time:${estimate}`}
                      label={formatTimeEstimateLabel(estimate)}
                      selected={selections.timeEstimates.includes(estimate)}
                      themeColors={themeColors}
                      onPress={() => selections.toggleTimeEstimate(estimate)}
                    />
                  ))}
                </View>
              </>
            ) : null}
          </ScrollView>
        </View>
      </View>
      )}
      {/* Confirms raised by the host screen while this sheet is up would
          otherwise never reach the screen on iOS (#940). */}
      <ThemedAlertHost />
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 20,
    maxHeight: '82%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  sheetHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sheetTextButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sheetTextButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  sheetIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetScroll: {
    maxHeight: '100%',
  },
  sheetContent: {
    gap: 14,
    paddingBottom: 12,
  },
  sheetSectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  sheetChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sheetInput: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  matchModeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  matchModeLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  matchModeControl: {
    minHeight: 36,
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 18,
    padding: 2,
  },
  matchModeButton: {
    minWidth: 52,
    minHeight: 30,
    flexGrow: 1,
    flexShrink: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    paddingHorizontal: 10,
  },
  matchModeButtonText: {
    fontSize: 12,
    fontWeight: '700',
  },
  filterChip: {
    borderWidth: 1,
    borderRadius: 22,
    flexBasis: 104,
    flexGrow: 1,
    flexShrink: 1,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  filterChipAdvanced: {
    borderStyle: 'dashed',
  },
  filterChipAction: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
    minWidth: 0,
    textAlign: 'center',
  },
});
