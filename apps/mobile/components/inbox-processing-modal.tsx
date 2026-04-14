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
import { safeFormatDate } from '@mindwtr/core';

import { AIResponseModal } from './ai-response-modal';
import { styles } from './inbox-processing-modal.styles';
import { useInboxProcessingController } from './inbox-processing/useInboxProcessingController';

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
    contextStepEnabled,
    currentProject,
    currentTask,
    delegateFollowUpDate,
    delegateWho,
    descriptionMaxHeight,
    displayDescription,
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
    isDark,
    isDelegateConfirmationDisabled,
    newContext,
    pendingStartDate,
    prioritiesEnabled,
    processingDescription,
    processingScrollRef,
    processingTitle,
    processingTitleFocused,
    projectFirst,
    projectSearch,
    projectTitle,
    referenceEnabled,
    scheduleEnabled,
    selectedContexts,
    selectedPriority,
    selectedProjectId,
    selectedTags,
    setActionabilityChoice,
    setDelegateFollowUpDate,
    setDelegateWho,
    setExecutionChoice,
    setNewContext,
    setPendingStartDate,
    setProcessingDescription,
    setProcessingTitle,
    setProcessingTitleFocused,
    setProjectSearch,
    setSelectedPriority,
    setShowDelegateDatePicker,
    setShowStartDatePicker,
    setTwoMinuteChoice,
    showDelegateDatePicker,
    showExecutionSection,
    showStartDatePicker,
    t,
    tagCopilotSuggestions,
    taskDisplayMaxHeight,
    tc,
    titleDirectionStyle,
    titleInputRef,
    tokenSuggestions,
    totalCount,
    twoMinuteChoice,
    twoMinuteEnabled,
    selectProjectEarly,
    toggleContext,
    toggleTag,
    PRIORITY_OPTIONS,
    processedCount,
  } = useInboxProcessingController({ visible, onClose });

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

  const renderContextSection = () => {
    if (!contextStepEnabled) return null;

    return (
      <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
        <Text style={[styles.stepQuestion, { color: tc.text }]}>
          {t('inbox.whereDoIt')} {t('inbox.selectMultipleHint')}
        </Text>
        {selectedContexts.length > 0 && (
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
        {selectedTags.length > 0 && (
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
        {prioritiesEnabled && (
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
                    <Text
                      style={[
                        styles.priorityChipText,
                        { color: isSelected ? tc.onTint : tc.text },
                      ]}
                    >
                      {t(`priority.${priority}`)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}
        <View style={styles.customContextContainer}>
          <TextInput
            style={[styles.contextInput, { borderColor: tc.border, color: tc.text }]}
            placeholder={t('inbox.addContextPlaceholder')}
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
        {tokenSuggestions.length > 0 && (
          <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            {tokenSuggestions.map((token) => (
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
        {contextCopilotSuggestions.length > 0 && (
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
        {tagCopilotSuggestions.length > 0 && (
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

  const renderProjectSection = () => (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <Text style={[styles.stepQuestion, { color: tc.text }]}>
        📁 {t('inbox.assignProjectQuestion')}
      </Text>
      {currentProject && (
        <TouchableOpacity
          style={[styles.projectChip, { backgroundColor: tc.tint }]}
          onPress={() => selectProjectEarly(currentProject.id)}
        >
          <Text style={styles.projectChipText}>✓ {currentProject.title}</Text>
        </TouchableOpacity>
      )}
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
    </View>
  );

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
                {(() => {
                  const translated = t('inbox.skip');
                  return translated === 'inbox.skip' ? 'Skip' : translated;
                })()}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.taskDisplay, { maxHeight: taskDisplayMaxHeight }]}>
            <Text style={[styles.taskTitle, titleDirectionStyle, { color: tc.text }]}>
              {processingTitle || currentTask.title}
            </Text>
            {displayDescription ? (
              <ScrollView
                nestedScrollEnabled
                style={[styles.descriptionScroll, { maxHeight: descriptionMaxHeight }]}
                contentContainerStyle={styles.descriptionScrollContent}
              >
                <Text style={[styles.taskDescription, { color: tc.secondaryText }]}>
                  {displayDescription}
                </Text>
              </ScrollView>
            ) : null}
            <View style={styles.taskMetaRow}>
              {projectTitle && (
                <Text
                  style={[
                    styles.metaPill,
                    { backgroundColor: tc.filterBg, borderColor: tc.border, color: tc.text },
                  ]}
                >
                  📁 {projectTitle}
                </Text>
              )}
              {currentTask.startTime && (
                <Text
                  style={[
                    styles.metaPill,
                    { backgroundColor: tc.filterBg, borderColor: tc.border, color: tc.text },
                  ]}
                >
                  ⏱ {safeFormatDate(currentTask.startTime, 'P')}
                </Text>
              )}
              {currentTask.dueDate && (
                <Text
                  style={[
                    styles.metaPill,
                    { backgroundColor: tc.filterBg, borderColor: tc.border, color: tc.text },
                  ]}
                >
                  📅 {safeFormatDate(currentTask.dueDate, 'P')}
                </Text>
              )}
              {currentTask.reviewAt && (
                <Text
                  style={[
                    styles.metaPill,
                    { backgroundColor: tc.filterBg, borderColor: tc.border, color: tc.text },
                  ]}
                >
                  🔁 {safeFormatDate(currentTask.reviewAt, 'P')}
                </Text>
              )}
            </View>
            {(currentTask.contexts.length > 0 || currentTask.tags.length > 0) && (
              <View style={styles.taskMetaRow}>
                {currentTask.contexts.slice(0, 6).map((context) => (
                  <Text
                    key={context}
                    style={[
                      styles.metaPill,
                      isDark ? styles.metaPillContextDark : styles.metaPillContextLight,
                      { borderColor: tc.border },
                    ]}
                  >
                    {context}
                  </Text>
                ))}
                {currentTask.tags.slice(0, 6).map((tag) => (
                  <Text
                    key={tag}
                    style={[
                      styles.metaPill,
                      isDark ? styles.metaPillTagDark : styles.metaPillTagLight,
                      { borderColor: tc.border },
                    ]}
                  >
                    {tag}
                  </Text>
                ))}
              </View>
            )}
            {aiEnabled && (
              <View style={styles.aiActionRow}>
                <TouchableOpacity
                  style={[styles.aiActionButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                  onPress={handleAIClarifyInbox}
                  disabled={isAIWorking}
                >
                  <Text style={[styles.aiActionText, { color: tc.tint }]}>
                    {t('taskEdit.aiClarify')}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
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
                  {scheduleEnabled && (
                    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                      <Text style={[styles.stepQuestion, { color: tc.text }]}>
                        {t('taskEdit.startDateLabel')}
                      </Text>
                      <View style={styles.startDateActions}>
                        <TouchableOpacity
                          style={[styles.startDateButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                          onPress={() => setShowStartDatePicker(true)}
                        >
                          <Text style={[styles.startDateButtonText, { color: tc.text }]}>
                            {pendingStartDate ? safeFormatDate(pendingStartDate.toISOString(), 'P') : t('common.notSet')}
                          </Text>
                        </TouchableOpacity>
                        {pendingStartDate && (
                          <TouchableOpacity
                            style={[styles.startDateClear, { borderColor: tc.border }]}
                            onPress={() => setPendingStartDate(null)}
                          >
                            <Text style={[styles.startDateClearText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  )}

                  <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                    <Text style={[styles.stepQuestion, { color: tc.text }]}>
                      {t('inbox.whatNext')}
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
                      <View style={styles.startDateRow}>
                        <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                          {t('process.delegateFollowUpLabel')}
                        </Text>
                        <View style={styles.startDateActions}>
                          <TouchableOpacity
                            style={[styles.startDateButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                            onPress={() => setShowDelegateDatePicker(true)}
                          >
                            <Text style={[styles.startDateButtonText, { color: tc.text }]}>
                              {delegateFollowUpDate ? safeFormatDate(delegateFollowUpDate.toISOString(), 'P') : t('common.notSet')}
                            </Text>
                          </TouchableOpacity>
                          {delegateFollowUpDate && (
                            <TouchableOpacity
                              style={[styles.startDateClear, { borderColor: tc.border }]}
                              onPress={() => setDelegateFollowUpDate(null)}
                            >
                              <Text style={[styles.startDateClearText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
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

              {scheduleEnabled && showStartDatePicker && (
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
                  }}
                />
              )}

              <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
                <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
                  {t('inbox.tapNextHint') === 'inbox.tapNextHint'
                    ? 'Tap "Next task" at the bottom to apply your choices and move on.'
                    : t('inbox.tapNextHint')}
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
                  {(() => {
                    const translated = t('inbox.nextTask');
                    return translated === 'inbox.nextTask' ? 'Next task →' : translated;
                  })()}
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
