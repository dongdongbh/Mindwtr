import React from 'react';
import { ActivityIndicator, Modal, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { X } from 'lucide-react-native';
import { tFallback } from '@mindwtr/core';

import { AIResponseModal } from './ai-response-modal';
import { styles } from './inbox-processing-modal.styles';
import { useInboxProcessingController } from './inbox-processing/useInboxProcessingController';
import { InboxActionabilitySection } from './inbox-processing/InboxActionabilitySection';
import { InboxContextSection } from './inbox-processing/InboxContextSection';
import { InboxDatePickers } from './inbox-processing/InboxDatePickers';
import { InboxExecutionSection } from './inbox-processing/InboxExecutionSection';
import { InboxOrganizationSection } from './inbox-processing/InboxOrganizationSection';
import { InboxProjectSection } from './inbox-processing/InboxProjectSection';
import { InboxSchedulingSection } from './inbox-processing/InboxSchedulingSection';
import { InboxTitleSection } from './inbox-processing/InboxTitleSection';
import { InboxTwoMinuteSection } from './inbox-processing/InboxTwoMinuteSection';

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
    assignedToSuggestions,
    closeAIModal,
    contextCopilotSuggestions,
    currentArea,
    currentProject,
    currentTask,
    defaultScheduleTime,
    delegateFollowUpDate,
    delegateFollowUpDateOnly,
    delegateWho,
    delegateWhoSuggestions,
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

  const sharedDateRowProps = { tc, defaultScheduleTime, dateOnlyLabel };

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
              <InboxTitleSection
                t={t}
                tc={tc}
                titleInputRef={titleInputRef}
                processingTitle={processingTitle}
                setProcessingTitle={setProcessingTitle}
                processingDescription={processingDescription}
                setProcessingDescription={setProcessingDescription}
                processingTitleFocused={processingTitleFocused}
                setProcessingTitleFocused={setProcessingTitleFocused}
                titleDirectionStyle={titleDirectionStyle}
                aiEnabled={aiEnabled}
                isAIWorking={isAIWorking}
                handleAIClarifyInbox={handleAIClarifyInbox}
                aiWorkingText={aiWorkingText}
              />

              <InboxActionabilitySection
                t={t}
                tc={tc}
                actionabilityChoice={actionabilityChoice}
                setActionabilityChoice={setActionabilityChoice}
                referenceEnabled={referenceEnabled}
                laterLabel={laterLabel}
                laterHint={laterHint}
                dateOnlyLabel={dateOnlyLabel}
                pendingStartDate={pendingStartDate}
                setPendingStartDate={setPendingStartDate}
                pendingStartDateOnly={pendingStartDateOnly}
                setPendingStartDateOnly={setPendingStartDateOnly}
                setShowStartDatePicker={setShowStartDatePicker}
                defaultScheduleTime={defaultScheduleTime}
              />

              {actionabilityChoice === 'actionable' && twoMinuteEnabled && (
                <InboxTwoMinuteSection
                  t={t}
                  tc={tc}
                  twoMinuteChoice={twoMinuteChoice}
                  setTwoMinuteChoice={setTwoMinuteChoice}
                />
              )}

              {showExecutionSection && (
                <>
                  <InboxSchedulingSection
                    t={t}
                    show={showSchedulingSection}
                    showStartDateField={showStartDateField}
                    showDueDateField={showDueDateField}
                    showReviewDateField={showReviewDateField}
                    pendingStartDate={pendingStartDate}
                    setPendingStartDate={setPendingStartDate}
                    pendingStartDateOnly={pendingStartDateOnly}
                    setPendingStartDateOnly={setPendingStartDateOnly}
                    setShowStartDatePicker={setShowStartDatePicker}
                    pendingDueDate={pendingDueDate}
                    setPendingDueDate={setPendingDueDate}
                    pendingDueDateOnly={pendingDueDateOnly}
                    setPendingDueDateOnly={setPendingDueDateOnly}
                    setShowDueDatePicker={setShowDueDatePicker}
                    pendingReviewDate={pendingReviewDate}
                    setPendingReviewDate={setPendingReviewDate}
                    pendingReviewDateOnly={pendingReviewDateOnly}
                    setPendingReviewDateOnly={setPendingReviewDateOnly}
                    setShowReviewDatePicker={setShowReviewDatePicker}
                    {...sharedDateRowProps}
                  />

                  <InboxOrganizationSection
                    t={t}
                    tc={tc}
                    show={showOrganizationSection}
                    showPriorityField={showPriorityField}
                    selectedPriority={selectedPriority}
                    setSelectedPriority={setSelectedPriority}
                    showEnergyLevelField={showEnergyLevelField}
                    selectedEnergyLevel={selectedEnergyLevel}
                    setSelectedEnergyLevel={setSelectedEnergyLevel}
                    showTimeEstimateField={showTimeEstimateField}
                    selectedTimeEstimate={selectedTimeEstimate}
                    setSelectedTimeEstimate={setSelectedTimeEstimate}
                    showAssignedToField={showAssignedToField}
                    selectedAssignedTo={selectedAssignedTo}
                    setSelectedAssignedTo={setSelectedAssignedTo}
                    assignedToSuggestions={assignedToSuggestions}
                    PRIORITY_OPTIONS={PRIORITY_OPTIONS}
                    ENERGY_LEVEL_OPTIONS={ENERGY_LEVEL_OPTIONS}
                    timeEstimateOptions={timeEstimateOptions}
                  />

                  <InboxExecutionSection
                    t={t}
                    executionChoice={executionChoice}
                    setExecutionChoice={setExecutionChoice}
                    delegateWho={delegateWho}
                    setDelegateWho={setDelegateWho}
                    delegateWhoSuggestions={delegateWhoSuggestions}
                    showReviewDateField={showReviewDateField}
                    delegateFollowUpDate={delegateFollowUpDate}
                    setDelegateFollowUpDate={setDelegateFollowUpDate}
                    delegateFollowUpDateOnly={delegateFollowUpDateOnly}
                    setDelegateFollowUpDateOnly={setDelegateFollowUpDateOnly}
                    setShowDelegateDatePicker={setShowDelegateDatePicker}
                    handleSendDelegateRequest={handleSendDelegateRequest}
                    {...sharedDateRowProps}
                  />

                  {executionChoice !== 'delegate' && (
                    projectFirst ? (
                      <>
                        <InboxProjectSection
                          t={t} tc={tc}
                          show={showProjectSection}
                          showProjectField={showProjectField}
                          showAreaField={showAreaField}
                          currentProject={currentProject}
                          currentArea={currentArea}
                          selectedProjectId={selectedProjectId}
                          selectedAreaId={selectedAreaId}
                          setSelectedAreaId={setSelectedAreaId}
                          projectSearch={projectSearch}
                          setProjectSearch={setProjectSearch}
                          filteredProjects={filteredProjects}
                          areaById={areaById}
                          hasExactProjectMatch={hasExactProjectMatch}
                          handleCreateProjectEarly={handleCreateProjectEarly}
                          selectProjectEarly={selectProjectEarly}
                        />
                        <InboxContextSection
                          t={t} tc={tc}
                          show={showContextSection}
                          showContextsField={showContextsField}
                          showTagsField={showTagsField}
                          selectedContexts={selectedContexts}
                          selectedTags={selectedTags}
                          toggleContext={toggleContext}
                          toggleTag={toggleTag}
                          newContext={newContext}
                          setNewContext={setNewContext}
                          addCustomContextMobile={addCustomContextMobile}
                          tokenSuggestions={tokenSuggestions}
                          applyTokenSuggestion={applyTokenSuggestion}
                          contextCopilotSuggestions={contextCopilotSuggestions}
                          tagCopilotSuggestions={tagCopilotSuggestions}
                        />
                      </>
                    ) : (
                      <>
                        <InboxContextSection
                          t={t} tc={tc}
                          show={showContextSection}
                          showContextsField={showContextsField}
                          showTagsField={showTagsField}
                          selectedContexts={selectedContexts}
                          selectedTags={selectedTags}
                          toggleContext={toggleContext}
                          toggleTag={toggleTag}
                          newContext={newContext}
                          setNewContext={setNewContext}
                          addCustomContextMobile={addCustomContextMobile}
                          tokenSuggestions={tokenSuggestions}
                          applyTokenSuggestion={applyTokenSuggestion}
                          contextCopilotSuggestions={contextCopilotSuggestions}
                          tagCopilotSuggestions={tagCopilotSuggestions}
                        />
                        <InboxProjectSection
                          t={t} tc={tc}
                          show={showProjectSection}
                          showProjectField={showProjectField}
                          showAreaField={showAreaField}
                          currentProject={currentProject}
                          currentArea={currentArea}
                          selectedProjectId={selectedProjectId}
                          selectedAreaId={selectedAreaId}
                          setSelectedAreaId={setSelectedAreaId}
                          projectSearch={projectSearch}
                          setProjectSearch={setProjectSearch}
                          filteredProjects={filteredProjects}
                          areaById={areaById}
                          hasExactProjectMatch={hasExactProjectMatch}
                          handleCreateProjectEarly={handleCreateProjectEarly}
                          selectProjectEarly={selectProjectEarly}
                        />
                      </>
                    )
                  )}
                </>
              )}

              <InboxDatePickers
                configs={[
                  {
                    show: (showStartDateField || actionabilityChoice === 'later') && showStartDatePicker,
                    value: pendingStartDate,
                    onClose: () => setShowStartDatePicker(false),
                    onSelect: (date) => { setPendingStartDate(date); setPendingStartDateOnly(false); },
                  },
                  {
                    show: showDueDateField && showDueDatePicker,
                    value: pendingDueDate,
                    onClose: () => setShowDueDatePicker(false),
                    onSelect: (date) => { setPendingDueDate(date); setPendingDueDateOnly(false); },
                  },
                  {
                    show: showReviewDateField && showReviewDatePicker,
                    value: pendingReviewDate,
                    onClose: () => setShowReviewDatePicker(false),
                    onSelect: (date) => { setPendingReviewDate(date); setPendingReviewDateOnly(false); },
                  },
                  {
                    show: showDelegateDatePicker,
                    value: delegateFollowUpDate,
                    onClose: () => setShowDelegateDatePicker(false),
                    onSelect: (date) => { setDelegateFollowUpDate(date); setDelegateFollowUpDateOnly(false); },
                  },
                ]}
              />

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
