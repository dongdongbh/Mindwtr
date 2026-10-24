import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  formatTimeEstimateLabel,
  tFallback,
  type TaskEnergyLevel,
  type TaskMetadataFilterVisibility,
  type TaskPriority,
  type TimeEstimate,
} from '@mindwtr/core';
import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CompactText } from '@/components/compact-text';
import { PriorityFlag } from '@/components/priority-flag';
import { ThemedAlertHost } from '@/components/themed-alert';
import type { TaskFilterSelections } from '@/hooks/use-task-filter-selections';
import { useKeyboardInset } from '@/lib/use-android-keyboard-inset';

/**
 * The one filter sheet for Focus and the task list. Both views hold their
 * selections in useTaskFilterSelections and render them here, so a filter
 * concept only ever has one picker. View-specific controls arrive through the
 * header, top-content, and advanced-chip slots rather than forking the sheet.
 */

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const DATE_PRESETS = ['today', 'next_7_days', 'overdue_next_7_days', 'next_14_days', 'next_30_days', 'upcoming'] as const;
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
  removable?: boolean;
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
  removable = false,
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

  if (isAdvanced || removable) {
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

export type TaskFilterSheetActiveChip = {
  id: string;
  label: string;
  onPress?: () => void;
  variant?: FilterChipVariant;
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
  /** View-local controls above the shared category rows. */
  topContent?: React.ReactNode;
  /**
   * Rendered in place of the sheet body inside the same modal (Focus's
   * save-filter dialog), so stepping into it does not remount the modal.
   */
  overlay?: React.ReactNode;
  /** View-local controls that participate in Clear without entering filter criteria. */
  hasAdditionalActiveFilters?: boolean;
  /** Focus-only saved criteria that no shared picker can express. */
  additionalActiveChips?: TaskFilterSheetActiveChip[];
};

type PickerPage = 'overview' | 'tokens' | 'projects';
type PickerItem = string | { id: string; title: string };

const joinSummary = (values: string[], fallback: string): string => (
  values.length > 0 ? values.join(', ') : fallback
);

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
  hasAdditionalActiveFilters = false,
  additionalActiveChips = [],
}: TaskFilterSheetProps) {
  const safeAreaInsets = useSafeAreaInsets();
  const keyboardInset = useKeyboardInset(visible);
  const [pickerPage, setPickerPage] = useState<PickerPage>('overview');
  const [pickerQuery, setPickerQuery] = useState('');
  const [datesExpanded, setDatesExpanded] = useState(false);
  const [timeExpanded, setTimeExpanded] = useState(false);
  const [energyExpanded, setEnergyExpanded] = useState(false);
  const [moreExpanded, setMoreExpanded] = useState(false);
  const resolveText = (key: string, fallback: string) => tFallback(t, key, fallback);
  const { visibility } = options;
  const projectOptions = useMemo(() => options.projects ?? [], [options.projects]);
  const excludedLabel = resolveText('filters.excluded', 'Excluded');
  const removeFilterLabel = resolveText('filters.remove', 'Remove filter');
  const allLabel = resolveText('common.all', 'All');

  const resetSheetNavigation = useCallback(() => {
    setPickerPage('overview');
    setPickerQuery('');
    setDatesExpanded(false);
    setTimeExpanded(false);
    setEnergyExpanded(false);
    setMoreExpanded(false);
  }, []);

  useEffect(() => {
    if (!visible) resetSheetNavigation();
  }, [resetSheetNavigation, visible]);

  const closeSheet = useCallback(() => {
    resetSheetNavigation();
    onClose();
  }, [onClose, resetSheetNavigation]);

  const openPicker = useCallback((page: Exclude<PickerPage, 'overview'>) => {
    setPickerQuery('');
    setPickerPage(page);
  }, []);

  const returnToOverview = useCallback(() => {
    setPickerPage('overview');
    setPickerQuery('');
  }, []);

  const handleRequestClose = useCallback(() => {
    if (overlay) {
      onClose();
      return;
    }
    if (pickerPage !== 'overview') {
      returnToOverview();
      return;
    }
    closeSheet();
  }, [closeSheet, onClose, overlay, pickerPage, returnToOverview]);

  const normalizedPickerQuery = pickerQuery.trim().toLocaleLowerCase();
  const visibleTokenOptions = useMemo(() => (
    normalizedPickerQuery
      ? options.tokens.filter((token) => token.toLocaleLowerCase().includes(normalizedPickerQuery))
      : options.tokens
  ), [normalizedPickerQuery, options.tokens]);
  const visibleProjectOptions = useMemo(() => (
    normalizedPickerQuery
      ? projectOptions.filter((project) => project.title.toLocaleLowerCase().includes(normalizedPickerQuery))
      : projectOptions
  ), [normalizedPickerQuery, projectOptions]);

  const tokenSummary = useMemo(() => joinSummary([
    ...selections.tokens,
    ...selections.excludedTokens.map((token) => `${excludedLabel}: ${token}`),
  ], allLabel), [allLabel, excludedLabel, selections.excludedTokens, selections.tokens]);
  const projectSummary = useMemo(() => joinSummary(
    projectOptions
      .filter((project) => selections.projects.includes(project.id))
      .map((project) => project.title),
    allLabel,
  ), [allLabel, projectOptions, selections.projects]);
  const timeSummary = joinSummary(
    selections.timeEstimates.map((estimate) => formatTimeEstimateLabel(estimate)),
    allLabel,
  );
  const energySummary = joinSummary(selections.energyLevels.map((level) => t(`energyLevel.${level}`)), allLabel);
  const moreSummary = joinSummary([
    ...selections.priorities.map((priority) => t(`priority.${priority}`)),
    ...(selections.locationQuery.trim()
      ? [`${resolveText('taskEdit.locationLabel', 'Location')}: ${selections.locationQuery.trim()}`]
      : []),
  ], allLabel);

  const removeSelectionChip = useCallback((chip: TaskFilterSelections['chips'][number]) => {
    chip.onPress();
  }, []);

  const hasActiveChips = selections.chips.length > 0 || additionalActiveChips.length > 0;

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

  const renderActiveFilters = () => (
    hasActiveChips ? (
      <View style={styles.activeFilters}>
        <Text style={[styles.sheetSectionLabel, { color: themeColors.secondaryText }]}>
          {resolveText('filters.active', 'Active filters')}
        </Text>
        <View style={styles.sheetChipRow}>
          {selections.chips.map((chip) => (
            <FilterChip
              key={chip.id}
              label={chip.label}
              selected
              themeColors={themeColors}
              onPress={() => removeSelectionChip(chip)}
              removable
              variant={chip.excluded ? 'excluded' : undefined}
              removeLabel={`${removeFilterLabel}: ${chip.label}`}
              excludedLabel={excludedLabel}
            />
          ))}
          {additionalActiveChips.map((chip) => (
            <FilterChip
              key={chip.id}
              label={chip.label}
              selected
              themeColors={themeColors}
              onPress={chip.onPress}
              removable
              variant={chip.variant}
              removeLabel={`${removeFilterLabel}: ${chip.label}`}
              excludedLabel={excludedLabel}
            />
          ))}
        </View>
      </View>
    ) : null
  );

  const renderOverviewRow = ({
    label,
    summary,
    onPress,
    expanded,
  }: {
    label: string;
    summary: string;
    onPress: () => void;
    expanded?: boolean;
  }) => (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      style={[styles.overviewRow, { borderColor: themeColors.border, backgroundColor: themeColors.bg }]}
    >
      <View style={styles.overviewRowText}>
        <Text style={[styles.overviewRowLabel, { color: themeColors.text }]}>{label}</Text>
        <Text
          numberOfLines={2}
          style={[styles.overviewRowSummary, { color: summary === allLabel ? themeColors.secondaryText : themeColors.tint }]}
        >
          {summary}
        </Text>
      </View>
      {expanded === undefined
        ? <ChevronRight size={18} color={themeColors.secondaryText} />
        : expanded
          ? <ChevronUp size={18} color={themeColors.secondaryText} />
          : <ChevronDown size={18} color={themeColors.secondaryText} />}
    </TouchableOpacity>
  );

  const renderPickerOption = (
    label: string,
    selected: boolean,
    excluded: boolean,
    onPress: () => void,
  ) => (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={excluded ? `${label} (${excludedLabel})` : undefined}
      onPress={onPress}
      style={[styles.pickerOption, { borderBottomColor: themeColors.border }]}
    >
      <Text
        numberOfLines={2}
        style={[
          styles.pickerOptionLabel,
          { color: excluded ? themeColors.danger : themeColors.text },
          excluded ? styles.excludedText : null,
        ]}
      >
        {label}
      </Text>
      {selected || excluded ? (
        <Text style={[styles.pickerOptionState, { color: excluded ? themeColors.danger : themeColors.tint }]}>
          {excluded ? excludedLabel : resolveText('bulk.selected', 'Selected')}
        </Text>
      ) : null}
    </TouchableOpacity>
  );

  const renderPicker = () => {
    const isTokenPicker = pickerPage === 'tokens';
    const title = isTokenPicker
      ? resolveText('filters.contexts', 'Contexts & tags')
      : resolveText('filters.projects', 'Projects');
    const data: PickerItem[] = isTokenPicker ? visibleTokenOptions : visibleProjectOptions;
    const renderItem = (item: PickerItem) => {
      if (typeof item === 'string') {
        const token = item;
        return renderPickerOption(
          token,
          selections.tokens.includes(token),
          selections.excludedTokens.includes(token),
          () => selections.toggleToken(token),
        );
      }
      return renderPickerOption(
        item.title,
        selections.projects.includes(item.id),
        false,
        () => selections.toggleProject(item.id),
      );
    };
    const matchModeFooter = isTokenPicker ? (
      <View style={styles.matchModeFooter}>
        {selections.showContextMatchMode
          ? renderMatchMode('context', resolveText('filters.contextMatchMode', 'Context match'), selections.contextMatchMode)
          : null}
        {selections.showTagMatchMode
          ? renderMatchMode('tag', resolveText('filters.tagMatchMode', 'Tag match'), selections.tagMatchMode)
          : null}
      </View>
    ) : null;

    return (
      <View style={styles.pickerBody}>
        <TextInput
          accessibilityLabel={`${resolveText('common.search', 'Search')} ${title}`}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setPickerQuery}
          placeholder={resolveText('common.search', 'Search')}
          placeholderTextColor={themeColors.secondaryText}
          returnKeyType="search"
          style={[styles.sheetInput, { backgroundColor: themeColors.bg, borderColor: themeColors.border, color: themeColors.text }]}
          value={pickerQuery}
        />
        {data.length === 0 ? (
          <View style={styles.pickerList}>
            <Text style={[styles.emptyPickerText, { color: themeColors.secondaryText }]}>
              {resolveText('search.noResults', 'No results')}
            </Text>
          </View>
        ) : data.length > 60 ? (
          <FlatList<PickerItem>
            data={data}
            keyExtractor={(item) => typeof item === 'string' ? `token:${item}` : `project:${item.id}`}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => renderItem(item)}
            ListFooterComponent={matchModeFooter}
            showsVerticalScrollIndicator={false}
            style={styles.pickerList}
          />
        ) : (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={styles.pickerList}
          >
            {data.map((item) => (
              <React.Fragment key={typeof item === 'string' ? `token:${item}` : `project:${item.id}`}>
                {renderItem(item)}
              </React.Fragment>
            ))}
            {matchModeFooter}
          </ScrollView>
        )}
      </View>
    );
  };

  return (
    <Modal
      animationType="fade"
      accessibilityViewIsModal
      transparent
      visible={visible}
      onRequestClose={handleRequestClose}
    >
      {overlay ?? (
      <View style={[styles.sheetRoot, keyboardInset > 0 ? { paddingBottom: keyboardInset } : null]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={resolveText('common.close', 'Close')}
          onPress={closeSheet}
          style={styles.sheetBackdrop}
        />
        <View
          accessibilityLabel={resolveText('filters.label', 'Filters')}
          style={[
            styles.sheet,
            pickerPage !== 'overview' ? styles.pickerSheet : null,
            {
              backgroundColor: themeColors.cardBg,
              borderColor: themeColors.border,
              paddingBottom: Math.max(12, safeAreaInsets.bottom),
            },
          ]}
        >
          <View style={styles.sheetHeader}>
            <View style={styles.sheetHeaderLeading}>
              {pickerPage !== 'overview' ? (
                <TouchableOpacity accessibilityRole="button" onPress={returnToOverview} style={styles.backButton}>
                  <Text style={[styles.backButtonText, { color: themeColors.tint }]}>
                    {resolveText('common.back', 'Back')}
                  </Text>
                </TouchableOpacity>
              ) : null}
              <Text accessibilityRole="header" style={[styles.sheetTitle, { color: themeColors.text }]}>
                {pickerPage === 'tokens'
                  ? resolveText('filters.contexts', 'Contexts & tags')
                  : pickerPage === 'projects'
                    ? resolveText('filters.projects', 'Projects')
                    : resolveText('filters.label', 'Filters')}
              </Text>
            </View>
            <View style={styles.sheetHeaderActions}>
              {pickerPage === 'overview' ? headerActions : null}
              {selections.hasActive || hasAdditionalActiveFilters || additionalActiveChips.length > 0 ? (
                <TouchableOpacity accessibilityRole="button" onPress={selections.clear} style={styles.sheetTextButton}>
                  <Text style={[styles.sheetTextButtonText, { color: themeColors.tint }]}>
                    {resolveText('filters.clear', 'Clear')}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          {pickerPage !== 'overview' ? renderPicker() : (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetContent}
              showsVerticalScrollIndicator={false}
            >
              {renderActiveFilters()}

              {selections.view === 'list' ? (
                <View style={styles.controlGroup}>
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
                </View>
              ) : null}

              {topContent}

              <View style={styles.overviewRows}>
                <View>
                  {renderOverviewRow({
                    label: t('filters.taskDates'),
                    summary: selections.anyDateRange && 'preset' in selections.anyDateRange
                      ? t(`filters.datePreset.${selections.anyDateRange.preset}`)
                      : t('filters.anyTime'),
                    expanded: datesExpanded,
                    onPress: () => setDatesExpanded((current) => !current),
                  })}
                  {datesExpanded ? (
                    <View style={styles.disclosureContent}>
                      <View style={styles.sheetChipRow}>
                        <FilterChip label={t('filters.anyTime')} selected={!selections.anyDateRange}
                          themeColors={themeColors} onPress={() => selections.setAnyDateRange(undefined)} />
                        {DATE_PRESETS.map((preset) => (
                          <FilterChip key={preset} label={t(`filters.datePreset.${preset}`)}
                            selected={Boolean(selections.anyDateRange && 'preset' in selections.anyDateRange && selections.anyDateRange.preset === preset)}
                            themeColors={themeColors} onPress={() => selections.setAnyDateRange({ preset })} />
                        ))}
                      </View>
                    </View>
                  ) : null}
                </View>

                {options.tokens.length > 0
                  ? renderOverviewRow({
                      label: resolveText('filters.contexts', 'Contexts & tags'),
                      summary: tokenSummary,
                      onPress: () => openPicker('tokens'),
                    })
                  : null}

                {projectOptions.length > 0
                  ? renderOverviewRow({
                      label: resolveText('filters.projects', 'Projects'),
                      summary: projectSummary,
                      onPress: () => openPicker('projects'),
                    })
                  : null}

                {visibility.timeEstimate && options.timeEstimates.length > 0 ? (
                  <View>
                    {renderOverviewRow({
                      label: resolveText('filters.timeEstimate', 'Time estimate'),
                      summary: timeSummary,
                      expanded: timeExpanded,
                      onPress: () => setTimeExpanded((current) => !current),
                    })}
                    {timeExpanded ? (
                      <View style={styles.disclosureContent}>
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
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {visibility.energyLevel ? (
                  <View>
                    {renderOverviewRow({
                      label: resolveText('taskEdit.energyLevel', 'Energy level'),
                      summary: energySummary,
                      expanded: energyExpanded,
                      onPress: () => setEnergyExpanded((current) => !current),
                    })}
                    {energyExpanded ? (
                      <View style={styles.disclosureContent}>
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
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {visibility.priority || visibility.location ? (
                  <View>
                    {renderOverviewRow({
                      label: resolveText('filters.more', 'More filters'),
                      summary: moreSummary,
                      expanded: moreExpanded,
                      onPress: () => setMoreExpanded((current) => !current),
                    })}
                    {moreExpanded ? (
                      <View style={styles.disclosureContent}>
                        {visibility.priority ? (
                          <View style={styles.controlGroup}>
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
                          </View>
                        ) : null}
                        {visibility.location ? (
                          <View style={styles.controlGroup}>
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
                          </View>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            </ScrollView>
          )}

          <View style={styles.sheetFooter}>
            <TouchableOpacity accessibilityRole="button" onPress={closeSheet} style={styles.doneButton}>
              <Text style={[styles.doneButtonText, { color: themeColors.tint }]}>
                {resolveText('common.done', 'Done')}
              </Text>
            </TouchableOpacity>
          </View>
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
  pickerSheet: {
    height: '82%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  sheetHeaderLeading: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
    minWidth: 0,
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
  backButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
    marginLeft: -8,
  },
  backButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  sheetScroll: {
    flexShrink: 1,
    maxHeight: '100%',
  },
  sheetContent: {
    gap: 14,
    paddingBottom: 12,
  },
  activeFilters: {
    gap: 8,
  },
  controlGroup: {
    gap: 8,
  },
  overviewRows: {
    gap: 8,
  },
  overviewRow: {
    minHeight: 60,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  overviewRowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  overviewRowLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  overviewRowSummary: {
    fontSize: 12,
    lineHeight: 17,
  },
  disclosureContent: {
    paddingHorizontal: 4,
    paddingTop: 10,
    gap: 12,
  },
  pickerBody: {
    flex: 1,
    minHeight: 0,
    gap: 10,
  },
  pickerList: {
    flex: 1,
  },
  pickerOption: {
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  pickerOptionLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    lineHeight: 19,
  },
  pickerOptionState: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '600',
  },
  excludedText: {
    textDecorationLine: 'line-through',
  },
  emptyPickerText: {
    paddingVertical: 28,
    textAlign: 'center',
    fontSize: 14,
  },
  matchModeFooter: {
    gap: 10,
    paddingVertical: 12,
  },
  sheetFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingTop: 8,
  },
  doneButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  doneButtonText: {
    fontSize: 14,
    fontWeight: '700',
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
