import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { X } from 'lucide-react-native';
import { safeFormatDate, tFallback } from '@mindwtr/core';

import { AIResponseModal } from './ai-response-modal';
import { styles } from './inbox-processing-modal.styles';
import { useInboxProcessingController } from './inbox-processing/useInboxProcessingController';
import { formatTimeEstimateChipLabel } from './time-estimate-filter-utils';

type InboxProcessingModalProps = {
  visible: boolean;
  onClose: () => void;
};

export function InboxProcessingModal({ visible, onClose }: InboxProcessingModalProps) {
  const {
    actionabilityChoice,
    addCustomContextMobile,
    aiEnabled,
    aiModal,
    applyTokenSuggestion,
    areaById,
    closeAIModal,
    contextCopilotSuggestions,
    currentArea,
    currentProject,
    currentTask,
    defaultScheduleTime,
    delegateFollowUpDate,
    delegateFollowUpDateOnly,
    delegateWho,
    executionChoice,
    filteredProjects,
    formatProgressLabel,
    handleAIClarifyInbox,
    handleClose,
    handleCreateProjectEarly,
    handleNextTask,
    handleSendDelegateRequest,
    handleSkipTask,
    hasExactProjectMatch,
    headerStyle,
    insets,
    isAIWorking,
    isDelegateConfirmationDisabled,
    newContext,
    pendingDueDate,
    pendingDueDateOnly,
    pendingReviewDate,
    pendingReviewDateOnly,
    pendingStartDate,
    pendingStartDateOnly,
    processingDescription,
    processingScrollRef,
    processingTitle,
    processingTitleFocused,
    projectFirst,
    projectSearch,
    referenceEnabled,
    selectedAreaId,
    selectedAssignedTo,
    selectedContexts,
    selectedEnergyLevel,
    selectedPriority,
    selectedProjectId,
    selectedTags,
    selectedTimeEstimate,
    setSelectedAreaId,
    setSelectedAssignedTo,
    setActionabilityChoice,
    setDelegateFollowUpDate,
    setDelegateFollowUpDateOnly,
    setDelegateWho,
    setExecutionChoice,
    setNewContext,
    setPendingDueDate,
    setPendingDueDateOnly,
    setPendingReviewDate,
    setPendingReviewDateOnly,
    setPendingStartDate,
    setPendingStartDateOnly,
    setProcessingDescription,
    setProcessingTitle,
    setProcessingTitleFocused,
    setSelectedEnergyLevel,
    setProjectSearch,
    setSelectedPriority,
    setSelectedTimeEstimate,
    setShowDelegateDatePicker,
    setShowDueDatePicker,
    setShowReviewDatePicker,
    setShowStartDatePicker,
    setTwoMinuteChoice,
    showDelegateDatePicker,
    showAreaField,
    showAssignedToField,
    showContextSection,
    showContextsField,
    showEnergyLevelField,
    showExecutionSection,
    showDueDateField,
    showDueDatePicker,
    showOrganizationSection,
    showPriorityField,
    showProjectField,
    showProjectSection,
    showReviewDateField,
    showReviewDatePicker,
    showSchedulingSection,
    showStartDatePicker,
    showStartDateField,
    showTagsField,
    showTimeEstimateField,
    t,
    tagCopilotSuggestions,
    tc,
    timeEstimateOptions,
    titleDirectionStyle,
    titleInputRef,
    tokenSuggestions,
    totalCount,
    twoMinuteChoice,
    twoMinuteEnabled,
    selectProjectEarly,
    toggleContext,
    toggleTag,
    ENERGY_LEVEL_OPTIONS,
    PRIORITY_OPTIONS,
    processedCount,
  } = useInboxProcessingController({ visible, onClose });
  const aiWorkingLabel = t('ai.working');
  const aiWorkingText = aiWorkingLabel === 'ai.working' ? 'Working...' : aiWorkingLabel;
  const laterLabel = tFallback(t, 'process.later', 'Later');
  const laterHint = tFallback(t, 'process.laterHint', 'Set a start date and move this to Next.');
  const dateOnlyLabel = tFallback(t, 'taskEdit.dateOnly', 'Date only');

  if (!visible) return null;

  if (!currentTask) {
    const loadingLabel = t('common.loading') !== 'common.loading'
      ? t('common.loading')
      : 'Loading next item...';

    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        allowSwipeDismissal
        onRequestClose={handleClose}
      >
        <View style={[styles.fullScreenContainer, { backgroundColor: tc.bg }]}>
          <View style={headerStyle}>
            <TouchableOpacity
              style={[styles.headerActionButton, styles.headerActionButtonLeft]}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              hitSlop={8}
            >
              <X size={22} color={tc.text} strokeWidth={2} />
            </TouchableOpacity>
            <View style={styles.progressContainer}>
              <Text style={[styles.progressText, { color: tc.secondaryText }]}>
                {formatProgressLabel(processedCount, totalCount)}
              </Text>
              <View style={[styles.progressBar, { backgroundColor: tc.border }]}>
                <View
                  style={[
                    styles.progressFill,
                    { width: totalCount > 0 ? `${(processedCount / totalCount) * 100}%` : '0%' },
                  ]}
                />
              </View>
            </View>
            <View style={styles.headerActionSpacer} />
          </View>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={tc.tint} />
            <Text style={[styles.loadingText, { color: tc.secondaryText }]}>
              {loadingLabel}
            </Text>
          </View>
        </View>
      </Modal>
    );
  }

  const renderDateSelector = (
    label: string,
    value: Date | null,
    onOpen: () => void,
    onClear: () => void,
    options: {
      dateOnly?: boolean;
      onDateOnly?: () => void;
      onUseDefaultTime?: () => void;
    } = {},
  ) => (
    <View style={styles.startDateRow}>
      <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>{label}</Text>
      <View style={styles.startDateActions}>
        <TouchableOpacity
          style={[styles.startDateButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
          onPress={onOpen}
        >
          <Text style={[styles.startDateButtonText, { color: tc.text }]}>
            {value ? safeFormatDate(value.toISOString(), 'P') : t('common.notSet')}
          </Text>
        </TouchableOpacity>
        {value && (
          <TouchableOpacity
            style={[styles.startDateClear, { borderColor: tc.border }]}
            onPress={onClear}
          >
            <Text style={[styles.startDateClearText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
          </TouchableOpacity>
        )}
        {value && defaultScheduleTime && options.onDateOnly && options.onUseDefaultTime && (
          <TouchableOpacity
            style={[styles.startDateClear, { borderColor: tc.border }]}
            onPress={options.dateOnly ? options.onUseDefaultTime : options.onDateOnly}
          >
            <Text style={[styles.startDateClearText, { color: tc.secondaryText }]}>
              {options.dateOnly ? defaultScheduleTime : dateOnlyLabel}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  const renderContextSection = () => {
    if (!showContextSection) return null;

    const visibleTokenSuggestions = tokenSuggestions.filter((token) => (
      token.startsWith('#') ? showTagsField : showContextsField
    ));
    const tokenPlaceholder = showContextsField && !showTagsField
      ? '@home'
      : showTagsField && !showContextsField
        ? '#deep-work'
        : t('inbox.addContextPlaceholder');

    return (
      <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
        <Text style={[styles.stepQuestion, { color: tc.text }]}>
          {showContextsField ? t('inbox.whereDoIt') : t('taskEdit.tagsLabel')}
          {showContextsField && showTagsField ? ` ${t('inbox.selectMultipleHint')}` : ''}
        </Text>
        {showContextsField && selectedContexts.length > 0 && (
          <View style={[styles.selectedContextsContainer, { backgroundColor: '#3B82F620' }]}>
            <Text style={{ fontSize: 12, color: '#3B82F6', marginBottom: 4 }}>{t('inbox.selectedLabel')}</Text>
            <View style={styles.selectedTokensRow}>
              {selectedContexts.map((ctx) => (
                <TouchableOpacity
                  key={ctx}
                  onPress={() => toggleContext(ctx)}
                  style={[styles.selectedTokenChip, styles.selectedContextChip]}
                >
                  <Text style={styles.selectedTokenText}>{ctx} x</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        {showTagsField && selectedTags.length > 0 && (
          <View style={[styles.selectedContextsContainer, { backgroundColor: '#8B5CF620' }]}>
            <Text style={{ fontSize: 12, color: '#8B5CF6', marginBottom: 4 }}>{t('taskEdit.tagsLabel')}</Text>
            <View style={styles.selectedTokensRow}>
              {selectedTags.map((tag) => (
                <TouchableOpacity
                  key={tag}
                  onPress={() => toggleTag(tag)}
                  style={[styles.selectedTokenChip, styles.selectedTagChip]}
                >
                  <Text style={styles.selectedTokenText}>{tag} x</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        <View style={styles.customContextContainer}>
          <TextInput
            style={[styles.contextInput, { borderColor: tc.border, color: tc.text }]}
            placeholder={tokenPlaceholder}
            placeholderTextColor={tc.secondaryText}
            value={newContext}
            onChangeText={setNewContext}
            onSubmitEditing={addCustomContextMobile}
          />
          <TouchableOpacity
            style={styles.addContextButton}
            onPress={addCustomContextMobile}
            disabled={!newContext.trim()}
          >
            <Text style={styles.addContextButtonText}>+</Text>
          </TouchableOpacity>
        </View>
        {visibleTokenSuggestions.length > 0 && (
          <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            {visibleTokenSuggestions.map((token) => (
              <TouchableOpacity
                key={token}
                style={styles.tokenSuggestionChip}
                onPress={() => applyTokenSuggestion(token)}
              >
                <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {showContextsField && contextCopilotSuggestions.length > 0 && (
          <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>Suggested contexts</Text>
            <View style={styles.tokenChipWrap}>
              {contextCopilotSuggestions.map((token) => (
                <TouchableOpacity
                  key={`ctx-${token}`}
                  style={[styles.suggestionChip, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                  onPress={() => applyTokenSuggestion(token)}
                >
                  <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        {showTagsField && tagCopilotSuggestions.length > 0 && (
          <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>Suggested tags</Text>
            <View style={styles.tokenChipWrap}>
              {tagCopilotSuggestions.map((token) => (
                <TouchableOpacity
                  key={`tag-${token}`}
                  style={[styles.suggestionChip, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                  onPress={() => applyTokenSuggestion(token)}
                >
                  <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
      </View>
    );
  };

  const renderOrganizationSection = () => {
    if (!showOrganizationSection) return null;

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
          </View>
        )}
      </View>
    );
  };

  const renderSchedulingSection = () => {
    if (!showSchedulingSection) return null;

    return (
      <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
        <Text style={[styles.stepQuestion, { color: tc.text }]}>
          {t('taskEdit.scheduling')}
        </Text>
        {showStartDateField && renderDateSelector(
          t('taskEdit.startDateLabel'),
          pendingStartDate,
          () => setShowStartDatePicker(true),
          () => {
            setPendingStartDate(null);
            setPendingStartDateOnly(false);
          },
          {
            dateOnly: pendingStartDateOnly,
            onDateOnly: () => setPendingStartDateOnly(true),
            onUseDefaultTime: () => setPendingStartDateOnly(false),
          },
        )}
        {showDueDateField && renderDateSelector(
          t('taskEdit.dueDateLabel'),
          pendingDueDate,
          () => setShowDueDatePicker(true),
          () => {
            setPendingDueDate(null);
            setPendingDueDateOnly(false);
          },
          {
            dateOnly: pendingDueDateOnly,
            onDateOnly: () => setPendingDueDateOnly(true),
            onUseDefaultTime: () => setPendingDueDateOnly(false),
          },
        )}
        {showReviewDateField && renderDateSelector(
          t('taskEdit.reviewDateLabel'),
          pendingReviewDate,
          () => setShowReviewDatePicker(true),
          () => {
            setPendingReviewDate(null);
            setPendingReviewDateOnly(false);
          },
          {
            dateOnly: pendingReviewDateOnly,
            onDateOnly: () => setPendingReviewDateOnly(true),
            onUseDefaultTime: () => setPendingReviewDateOnly(false),
          },
        )}
      </View>
    );
  };

  const renderProjectSection = () => {
    if (!showProjectSection) return null;

    const areaOptions = Array.from(areaById.values());

    return (
      <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
        <Text style={[styles.stepQuestion, { color: tc.text }]}>
          📁 {t('inbox.assignProjectQuestion')}
        </Text>
        {showProjectField && currentProject && (
          <TouchableOpacity
            style={[styles.projectChip, { backgroundColor: tc.tint }]}
            onPress={() => selectProjectEarly(currentProject.id)}
          >
            <Text style={styles.projectChipText}>✓ {currentProject.title}</Text>
          </TouchableOpacity>
        )}
        {showAreaField && !selectedProjectId && currentArea && (
          <TouchableOpacity
            style={[styles.projectChip, { backgroundColor: currentArea.color || tc.tint }]}
            onPress={() => setSelectedAreaId(currentArea.id)}
          >
            <Text style={styles.projectChipText}>✓ {currentArea.name}</Text>
          </TouchableOpacity>
        )}
        {showAreaField && !selectedProjectId && (
          <View style={styles.projectListContainer}>
            <TouchableOpacity
              style={[styles.projectChip, { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.border }]}
              onPress={() => setSelectedAreaId(null)}
            >
              <Text style={[styles.projectChipText, { color: tc.text }]}>✓ {t('projects.noArea')}</Text>
            </TouchableOpacity>
            {areaOptions.map((area) => {
              const isSelected = selectedAreaId === area.id;
              return (
                <TouchableOpacity
                  key={area.id}
                  style={[
                    styles.projectChip,
                    isSelected
                      ? { backgroundColor: '#3B82F620', borderWidth: 1, borderColor: tc.tint }
                      : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
                  ]}
                  onPress={() => setSelectedAreaId(area.id)}
                >
                  <View style={[styles.projectDot, { backgroundColor: area.color || '#6B7280' }]} />
                  <Text style={[styles.projectChipText, { color: tc.text }]}>{area.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        {showProjectField && (
          <>
            <View style={styles.projectSearchRow}>
              <TextInput
                value={projectSearch}
                onChangeText={setProjectSearch}
                placeholder={t('projects.addPlaceholder')}
                placeholderTextColor={tc.secondaryText}
                style={[styles.projectSearchInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                onSubmitEditing={handleCreateProjectEarly}
                returnKeyType="done"
              />
              {!hasExactProjectMatch && projectSearch.trim() && (
                <TouchableOpacity
                  style={[styles.createProjectButton, { backgroundColor: tc.tint }]}
                  onPress={handleCreateProjectEarly}
                >
                  <Text style={styles.createProjectButtonText}>{t('projects.create')}</Text>
                </TouchableOpacity>
              )}
            </View>
            <View style={styles.projectListContainer}>
              <TouchableOpacity
                style={[styles.projectChip, { backgroundColor: '#10B981' }]}
                onPress={() => selectProjectEarly(null)}
              >
                <Text style={styles.projectChipText}>✓ {t('inbox.noProject')}</Text>
              </TouchableOpacity>
              {filteredProjects.map((project) => {
                const projectColor = project.areaId ? areaById.get(project.areaId)?.color : undefined;
                const isSelected = selectedProjectId === project.id;
                return (
                  <TouchableOpacity
                    key={project.id}
                    style={[
                      styles.projectChip,
                      isSelected
                        ? { backgroundColor: '#3B82F620', borderWidth: 1, borderColor: tc.tint }
                        : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
                    ]}
                    onPress={() => selectProjectEarly(project.id)}
                  >
                    <View style={[styles.projectDot, { backgroundColor: projectColor || '#6B7280' }]} />
                    <Text style={[styles.projectChipText, { color: tc.text }]}>{project.title}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}
      </View>
    );
  };

  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        allowSwipeDismissal
        onRequestClose={handleClose}
      >
        <View style={[styles.fullScreenContainer, { backgroundColor: tc.bg }]}>
          <View style={headerStyle}>
            <TouchableOpacity
              style={[styles.headerActionButton, styles.headerActionButtonLeft]}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              hitSlop={8}
            >
              <X size={22} color={tc.text} strokeWidth={2} />
            </TouchableOpacity>
            <View style={styles.progressContainer}>
              <Text style={[styles.progressText, { color: tc.secondaryText }]}>
                {formatProgressLabel(processedCount + 1, totalCount)}
              </Text>
              <View style={[styles.progressBar, { backgroundColor: tc.border }]}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${((processedCount + 1) / totalCount) * 100}%` },
                  ]}
                />
              </View>
            </View>
            <TouchableOpacity
              style={[styles.headerActionButton, styles.headerActionButtonRight]}
              onPress={handleSkipTask}
            >
              <Text style={styles.skipBtn}>
                {tFallback(t, 'inbox.skip', 'Skip')}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.stepContainer}>
            <ScrollView
              ref={processingScrollRef}
              style={styles.singlePageScroll}
              contentContainerStyle={styles.singlePageContent}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
            >
              <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                <Text style={[styles.stepQuestion, { color: tc.text }]}>
                  {t('inbox.refineTitle')}
                </Text>
                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                  {t('inbox.refineHint')}
                </Text>
                {aiEnabled && (
                  <View style={styles.aiActionRow}>
                    <TouchableOpacity
                      style={[styles.aiActionButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                      onPress={handleAIClarifyInbox}
                      disabled={isAIWorking}
                      accessibilityState={{ disabled: isAIWorking, busy: isAIWorking }}
                    >
                      {isAIWorking && <ActivityIndicator size="small" color={tc.tint} />}
                      <Text style={[styles.aiActionText, { color: tc.tint }]}>
                        {isAIWorking ? aiWorkingText : t('taskEdit.aiClarify')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
                <Text style={[styles.refineLabel, { color: tc.secondaryText }]}>{t('taskEdit.titleLabel')}</Text>
                <TextInput
                  ref={titleInputRef}
                  style={[styles.refineTitleInput, titleDirectionStyle, { borderColor: tc.border, color: tc.text, backgroundColor: tc.cardBg }]}
                  value={processingTitle}
                  onChangeText={setProcessingTitle}
                  placeholder={t('taskEdit.titleLabel')}
                  placeholderTextColor={tc.secondaryText}
                  onFocus={() => setProcessingTitleFocused(true)}
                  onBlur={() => setProcessingTitleFocused(false)}
                  selection={processingTitleFocused ? undefined : { start: 0, end: 0 }}
                />
                <Text style={[styles.refineLabel, { color: tc.secondaryText }]}>{t('taskEdit.descriptionLabel')}</Text>
                <TextInput
                  style={[styles.refineDescriptionInput, { borderColor: tc.border, color: tc.text, backgroundColor: tc.cardBg }]}
                  value={processingDescription}
                  onChangeText={setProcessingDescription}
                  placeholder={t('taskEdit.descriptionPlaceholder')}
                  placeholderTextColor={tc.secondaryText}
                  multiline
                  numberOfLines={4}
                />
              </View>

              <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                <Text style={[styles.stepQuestion, { color: tc.text }]}>
                  {t('inbox.isActionable')}
                </Text>
                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                  {t('inbox.actionableHint')}
                </Text>
                <View style={styles.buttonColumn}>
                  <TouchableOpacity
                    style={[
                      styles.bigButton,
                      actionabilityChoice === 'actionable' ? styles.buttonPrimary : { backgroundColor: tc.border },
                    ]}
                    onPress={() => setActionabilityChoice('actionable')}
                  >
                    <Text style={[styles.bigButtonText, actionabilityChoice !== 'actionable' && { color: tc.text }]}>
                      ✅ {t('inbox.yesActionable')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.bigButton,
                      actionabilityChoice === 'later' ? styles.buttonPrimary : { backgroundColor: tc.border },
                    ]}
                    onPress={() => setActionabilityChoice('later')}
                  >
                    <Text style={[styles.bigButtonText, actionabilityChoice !== 'later' && { color: tc.text }]}>
                      🕒 {laterLabel}
                    </Text>
                  </TouchableOpacity>
                  <View style={styles.buttonRow}>
                    <TouchableOpacity
                      style={[styles.button, { backgroundColor: actionabilityChoice === 'trash' ? '#EF4444' : tc.border }]}
                      onPress={() => setActionabilityChoice('trash')}
                    >
                      <Text style={[styles.buttonPrimaryText, actionabilityChoice !== 'trash' && { color: tc.text }]}>🗑️ {t('inbox.trash')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.button, { backgroundColor: actionabilityChoice === 'someday' ? '#8B5CF6' : tc.border }]}
                      onPress={() => setActionabilityChoice('someday')}
                    >
                      <Text style={[styles.buttonPrimaryText, actionabilityChoice !== 'someday' && { color: tc.text }]}>💭 {t('inbox.someday')}</Text>
                    </TouchableOpacity>
                    {referenceEnabled && (
                      <TouchableOpacity
                        style={[styles.button, { backgroundColor: actionabilityChoice === 'reference' ? '#3B82F6' : tc.border }]}
                        onPress={() => setActionabilityChoice('reference')}
                      >
                        <Text style={[styles.buttonPrimaryText, actionabilityChoice !== 'reference' && { color: tc.text }]}>📚 {t('nav.reference')}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              </View>

              {actionabilityChoice === 'later' && (
                <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                  <Text style={[styles.stepQuestion, { color: tc.text }]}>
                    {laterLabel}
                  </Text>
                  <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                    {laterHint}
                  </Text>
                  {renderDateSelector(
                    t('taskEdit.startDateLabel'),
                    pendingStartDate,
                    () => setShowStartDatePicker(true),
                    () => {
                      setPendingStartDate(null);
                      setPendingStartDateOnly(false);
                    },
                    {
                      dateOnly: pendingStartDateOnly,
                      onDateOnly: () => setPendingStartDateOnly(true),
                      onUseDefaultTime: () => setPendingStartDateOnly(false),
                    },
                  )}
                </View>
              )}

              {actionabilityChoice === 'actionable' && twoMinuteEnabled && (
                <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                  <Text style={[styles.stepQuestion, { color: tc.text }]}>
                    ⏱️ {t('inbox.twoMinRule')}
                  </Text>
                  <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                    {t('inbox.twoMinHint')}
                  </Text>
                  <View style={styles.buttonColumn}>
                    <TouchableOpacity
                      style={[styles.bigButton, twoMinuteChoice === 'yes' ? styles.buttonSuccess : { backgroundColor: tc.border }]}
                      onPress={() => setTwoMinuteChoice('yes')}
                    >
                      <Text style={[styles.bigButtonText, twoMinuteChoice !== 'yes' && { color: tc.text }]}>✅ {t('inbox.doneIt')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.bigButton, twoMinuteChoice === 'no' ? styles.buttonPrimary : { backgroundColor: tc.border }]}
                      onPress={() => setTwoMinuteChoice('no')}
                    >
                      <Text style={[styles.bigButtonText, twoMinuteChoice !== 'no' && { color: tc.text }]}>
                        {t('inbox.takesLonger')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {showExecutionSection && (
                <>
                  {renderSchedulingSection()}
                  {renderOrganizationSection()}

                  <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                    <Text style={[styles.stepQuestion, { color: tc.text }]}>
                      {t('inbox.whoShouldDoIt')}
                    </Text>
                    <View style={styles.buttonColumn}>
                      <TouchableOpacity
                        style={[styles.bigButton, executionChoice === 'defer' ? styles.buttonPrimary : { backgroundColor: tc.border }]}
                        onPress={() => setExecutionChoice('defer')}
                      >
                        <Text style={[styles.bigButtonText, executionChoice !== 'defer' && { color: tc.text }]}>
                          📋 {t('inbox.illDoIt')}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.bigButton, executionChoice === 'delegate' ? { backgroundColor: '#F59E0B' } : { backgroundColor: tc.border }]}
                        onPress={() => setExecutionChoice('delegate')}
                      >
                        <Text style={[styles.bigButtonText, executionChoice !== 'delegate' && { color: tc.text }]}>
                          👤 {t('inbox.delegate')}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {executionChoice === 'delegate' ? (
                    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                      <Text style={[styles.stepQuestion, { color: tc.text }]}>
                        👤 {t('process.delegateTitle')}
                      </Text>
                      <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                        {t('process.delegateDesc')}
                      </Text>
                      <Text style={[styles.refineLabel, { color: tc.secondaryText }]}>{t('process.delegateWhoLabel')}</Text>
                      <TextInput
                        style={[styles.waitingInput, { borderColor: tc.border, color: tc.text }]}
                        placeholder={t('process.delegateWhoPlaceholder')}
                        placeholderTextColor={tc.secondaryText}
                        value={delegateWho}
                        onChangeText={setDelegateWho}
                      />
                      {!showReviewDateField && renderDateSelector(
                        t('process.delegateFollowUpLabel'),
                        delegateFollowUpDate,
                        () => setShowDelegateDatePicker(true),
                        () => {
                          setDelegateFollowUpDate(null);
                          setDelegateFollowUpDateOnly(false);
                        },
                        {
                          dateOnly: delegateFollowUpDateOnly,
                          onDateOnly: () => setDelegateFollowUpDateOnly(true),
                          onUseDefaultTime: () => setDelegateFollowUpDateOnly(false),
                        },
                      )}
                      <TouchableOpacity
                        style={[styles.buttonSecondary, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                        onPress={handleSendDelegateRequest}
                      >
                        <Text style={[styles.buttonText, { color: tc.text }]}>{t('process.delegateSendRequest')}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <>
                      {projectFirst ? renderProjectSection() : renderContextSection()}
                      {projectFirst ? renderContextSection() : renderProjectSection()}
                    </>
                  )}
                </>
              )}

              {(showStartDateField || actionabilityChoice === 'later') && showStartDatePicker && (
                <DateTimePicker
                  value={pendingStartDate ?? new Date()}
                  mode="date"
                  display="default"
                  onChange={(event, date) => {
                    if (event.type === 'dismissed') {
                      setShowStartDatePicker(false);
                      return;
                    }
                    if (Platform.OS !== 'ios') setShowStartDatePicker(false);
                    if (!date) return;
                    const next = new Date(date);
                    next.setHours(9, 0, 0, 0);
                    setPendingStartDate(next);
                    setPendingStartDateOnly(false);
                  }}
                />
              )}

              {showDueDateField && showDueDatePicker && (
                <DateTimePicker
                  value={pendingDueDate ?? new Date()}
                  mode="date"
                  display="default"
                  onChange={(event, date) => {
                    if (event.type === 'dismissed') {
                      setShowDueDatePicker(false);
                      return;
                    }
                    if (Platform.OS !== 'ios') setShowDueDatePicker(false);
                    if (!date) return;
                    const next = new Date(date);
                    next.setHours(9, 0, 0, 0);
                    setPendingDueDate(next);
                    setPendingDueDateOnly(false);
                  }}
                />
              )}

              {showReviewDateField && showReviewDatePicker && (
                <DateTimePicker
                  value={pendingReviewDate ?? new Date()}
                  mode="date"
                  display="default"
                  onChange={(event, date) => {
                    if (event.type === 'dismissed') {
                      setShowReviewDatePicker(false);
                      return;
                    }
                    if (Platform.OS !== 'ios') setShowReviewDatePicker(false);
                    if (!date) return;
                    const next = new Date(date);
                    next.setHours(9, 0, 0, 0);
                    setPendingReviewDate(next);
                    setPendingReviewDateOnly(false);
                  }}
                />
              )}

              {showDelegateDatePicker && (
                <DateTimePicker
                  value={delegateFollowUpDate ?? new Date()}
                  mode="date"
                  display="default"
                  onChange={(event, date) => {
                    if (event.type === 'dismissed') {
                      setShowDelegateDatePicker(false);
                      return;
                    }
                    if (Platform.OS !== 'ios') setShowDelegateDatePicker(false);
                    if (!date) return;
                    const next = new Date(date);
                    next.setHours(9, 0, 0, 0);
                    setDelegateFollowUpDate(next);
                    setDelegateFollowUpDateOnly(false);
                  }}
                />
              )}

              <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                  {tFallback(t, 'inbox.tapNextHint', 'Tap "Next task" at the bottom to apply your choices and move on.')}
                </Text>
              </View>
            </ScrollView>

            <View style={[styles.bottomActionBar, { borderTopColor: tc.border, paddingBottom: Math.max(insets.bottom, 10) }]}>
              <TouchableOpacity
                style={[
                  styles.bottomNextButton,
                  { backgroundColor: tc.tint },
                  isDelegateConfirmationDisabled && { opacity: 0.5 },
                ]}
                disabled={isDelegateConfirmationDisabled}
                onPress={handleNextTask}
              >
                <Text style={styles.bottomNextButtonText}>
                  {tFallback(t, 'inbox.nextTask', 'Next task →')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      {aiModal && (
        <AIResponseModal
          visible={Boolean(aiModal)}
          title={aiModal.title}
          message={aiModal.message}
          actions={aiModal.actions}
          onClose={closeAIModal}
        />
      )}
    </>
  );
}
