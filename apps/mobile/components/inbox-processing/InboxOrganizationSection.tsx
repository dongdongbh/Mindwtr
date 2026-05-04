import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import { formatTimeEstimateChipLabel } from '../time-estimate-filter-utils';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import type { TaskPriority, TaskEnergyLevel, TimeEstimate } from '@mindwtr/core';

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  show: boolean;
  showPriorityField: boolean;
  selectedPriority: TaskPriority | undefined;
  setSelectedPriority: (v: TaskPriority | undefined) => void;
  showEnergyLevelField: boolean;
  selectedEnergyLevel: TaskEnergyLevel | undefined;
  setSelectedEnergyLevel: (v: TaskEnergyLevel | undefined) => void;
  showTimeEstimateField: boolean;
  selectedTimeEstimate: TimeEstimate | undefined;
  setSelectedTimeEstimate: (v: TimeEstimate | undefined) => void;
  showAssignedToField: boolean;
  selectedAssignedTo: string;
  setSelectedAssignedTo: (v: string) => void;
  assignedToSuggestions: string[];
  PRIORITY_OPTIONS: TaskPriority[];
  ENERGY_LEVEL_OPTIONS: TaskEnergyLevel[];
  timeEstimateOptions: TimeEstimate[];
};

export function InboxOrganizationSection({
  t,
  tc,
  show,
  showPriorityField,
  selectedPriority,
  setSelectedPriority,
  showEnergyLevelField,
  selectedEnergyLevel,
  setSelectedEnergyLevel,
  showTimeEstimateField,
  selectedTimeEstimate,
  setSelectedTimeEstimate,
  showAssignedToField,
  selectedAssignedTo,
  setSelectedAssignedTo,
  assignedToSuggestions,
  PRIORITY_OPTIONS,
  ENERGY_LEVEL_OPTIONS,
  timeEstimateOptions,
}: Props) {
  if (!show) return null;

  return (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <Text style={[styles.stepQuestion, { color: tc.text }]}>
        {t('taskEdit.organization')}
      </Text>
      {showPriorityField && (
        <View style={styles.prioritySection}>
          <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>{t('taskEdit.priorityLabel')}</Text>
          <View style={styles.tokenChipWrap}>
            {PRIORITY_OPTIONS.map((priority) => {
              const isSelected = selectedPriority === priority;
              return (
                <TouchableOpacity
                  key={priority}
                  style={[
                    styles.priorityChip,
                    {
                      borderColor: isSelected ? tc.tint : tc.border,
                      backgroundColor: isSelected ? tc.tint : tc.filterBg,
                    },
                  ]}
                  onPress={() => setSelectedPriority(isSelected ? undefined : priority)}
                >
                  <Text style={[styles.priorityChipText, { color: isSelected ? tc.onTint : tc.text }]}>
                    {t(`priority.${priority}`)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}
      {showEnergyLevelField && (
        <View style={styles.prioritySection}>
          <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>{t('taskEdit.energyLevel')}</Text>
          <View style={styles.tokenChipWrap}>
            <TouchableOpacity
              style={[
                styles.priorityChip,
                {
                  borderColor: !selectedEnergyLevel ? tc.tint : tc.border,
                  backgroundColor: !selectedEnergyLevel ? tc.tint : tc.filterBg,
                },
              ]}
              onPress={() => setSelectedEnergyLevel(undefined)}
            >
              <Text style={[styles.priorityChipText, { color: !selectedEnergyLevel ? tc.onTint : tc.text }]}>
                {t('common.none')}
              </Text>
            </TouchableOpacity>
            {ENERGY_LEVEL_OPTIONS.map((energyLevel) => {
              const isSelected = selectedEnergyLevel === energyLevel;
              return (
                <TouchableOpacity
                  key={energyLevel}
                  style={[
                    styles.priorityChip,
                    {
                      borderColor: isSelected ? tc.tint : tc.border,
                      backgroundColor: isSelected ? tc.tint : tc.filterBg,
                    },
                  ]}
                  onPress={() => setSelectedEnergyLevel(isSelected ? undefined : energyLevel)}
                >
                  <Text style={[styles.priorityChipText, { color: isSelected ? tc.onTint : tc.text }]}>
                    {t(`energyLevel.${energyLevel}`)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}
      {showTimeEstimateField && (
        <View style={styles.prioritySection}>
          <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>{t('taskEdit.timeEstimateLabel')}</Text>
          <View style={styles.tokenChipWrap}>
            <TouchableOpacity
              style={[
                styles.priorityChip,
                {
                  borderColor: !selectedTimeEstimate ? tc.tint : tc.border,
                  backgroundColor: !selectedTimeEstimate ? tc.tint : tc.filterBg,
                },
              ]}
              onPress={() => setSelectedTimeEstimate(undefined)}
            >
              <Text style={[styles.priorityChipText, { color: !selectedTimeEstimate ? tc.onTint : tc.text }]}>
                {t('common.none')}
              </Text>
            </TouchableOpacity>
            {timeEstimateOptions.map((estimate) => {
              const isSelected = selectedTimeEstimate === estimate;
              return (
                <TouchableOpacity
                  key={estimate}
                  style={[
                    styles.priorityChip,
                    {
                      borderColor: isSelected ? tc.tint : tc.border,
                      backgroundColor: isSelected ? tc.tint : tc.filterBg,
                    },
                  ]}
                  onPress={() => setSelectedTimeEstimate(isSelected ? undefined : estimate)}
                >
                  <Text style={[styles.priorityChipText, { color: isSelected ? tc.onTint : tc.text }]}>
                    {formatTimeEstimateChipLabel(estimate)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}
      {showAssignedToField && (
        <View style={styles.prioritySection}>
          <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>{t('taskEdit.assignedTo')}</Text>
          <TextInput
            style={[styles.waitingInput, { borderColor: tc.border, color: tc.text }]}
            placeholder={t('taskEdit.assignedToPlaceholder')}
            placeholderTextColor={tc.secondaryText}
            value={selectedAssignedTo}
            onChangeText={setSelectedAssignedTo}
          />
          {assignedToSuggestions.length > 0 && (
            <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              {assignedToSuggestions.map((name) => (
                <TouchableOpacity
                  key={name}
                  style={styles.tokenSuggestionChip}
                  onPress={() => setSelectedAssignedTo(name)}
                >
                  <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
