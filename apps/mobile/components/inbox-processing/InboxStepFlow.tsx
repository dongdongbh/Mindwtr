import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Platform, ScrollView, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Folder,
    Trash2,
    UserRound,
    type LucideIcon,
} from 'lucide-react-native';
import { INCUBATE_ICON, START_LATER_ICON, TASK_STATUS_ICONS } from '@/lib/task-status-icons';
import {
  formatProcessInboxCommitMessage,
  getProcessInboxEntryStep,
  getProcessInboxStepPrompt,
  isProcessInboxTerminalStep,
  QUICK_DATE_PRESETS,
  resolveProcessInboxStep,
  tFallback,
  type ProcessInboxCommitted,
  type ProcessInboxStepChoice,
} from '@mindwtr/core';

import { styles } from '../inbox-processing-modal.styles';
import { ToastViewport, useToast } from '../../contexts/toast-context';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { InboxContextSection } from './InboxContextSection';
import { InboxDatePickers } from './InboxDatePickers';
import { InboxDateSelectorRow } from './InboxDateSelectorRow';
import { InboxExecutionSection } from './InboxExecutionSection';
import { InboxOrganizationSection } from './InboxOrganizationSection';
import { InboxProjectSection } from './InboxProjectSection';
import { InboxSchedulingSection } from './InboxSchedulingSection';
import { InboxCaptureCard } from './InboxCaptureCard';
import { SomedaySectionPicker } from '../someday-section-picker';
import type { InboxProcessingMode } from '@/lib/view-state/inbox-processing-mode';
import type { useInboxProcessingController } from './useInboxProcessingController';

type Controller = ReturnType<typeof useInboxProcessingController>;

const CHOICE_ICONS: Record<string, LucideIcon> = {
  done: CheckCircle2,
  project: Folder,
  later: START_LATER_ICON,
  delegate: UserRound,
  someday: TASK_STATUS_ICONS.someday,
  incubate: INCUBATE_ICON,
  reference: TASK_STATUS_ICONS.reference,
};

const STEP_TRANSITION_MS = 200;
const STEP_TRANSITION_OFFSET = 24;
const DATED_QUICK_DATE_PRESETS = QUICK_DATE_PRESETS.filter((preset) => preset !== 'no_date');

function ChoiceButton({
  label,
  icon: Icon,
  tc,
  compact = false,
  onPress,
}: {
  label: string;
  icon?: LucideIcon;
  tc: ThemeColors;
  compact?: boolean;
  onPress: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  const button = (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[
        styles.stepChoiceButton,
        compact && styles.stepChoiceButtonCompact,
        { backgroundColor: tc.cardBg, borderColor: tc.border },
      ]}
      onPress={onPress}
    >
      {Icon ? <Icon size={18} color={tc.text} strokeWidth={2} /> : null}
      <Text style={[styles.stepChoiceButtonText, { color: tc.text }]}>{label}</Text>
    </TouchableOpacity>
  );

  return compact ? (
    <View style={[styles.stepChoiceCell, fontScale >= 1.3 && styles.stepChoiceCellLargeText]}>{button}</View>
  ) : button;
}

/**
 * One question per screen: the Inbox processor's decisions laid out as forward
 * steps instead of a form that expands downward. Owns no write paths — every
 * mutation is a controller handler, the same ones this flow has always used.
 */
export function InboxStepFlow({ controller, mode }: { controller: Controller; mode: InboxProcessingMode }) {
  const {
    answers,
    answerStep,
    convertToProject,
    createDecisionUndoReceipt,
    currentTask,
    pendingStartDate,
    pendingStartDateOnly,
    processInboxPlan,
    projectFirst,
    runCommit,
    setPendingStartDate,
    setPendingStartDateOnly,
    setShowStartDatePicker,
    showAdvancedOptions,
    showProjectField,
    showStartDatePicker,
    t,
    tc,
    toggleAdvancedOptions,
    undoDecision,
  } = controller;
  const { showToast } = useToast();
  const filledButton = useFilledButtonColors();
  const reducedMotion = useReducedMotion();
  const [notesOpen, setNotesOpen] = useState(false);
  const submittingRef = useRef(false);
  const fade = useRef(new Animated.Value(1)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const taskId = currentTask?.id;

  const dateOnlyLabel = t('taskEdit.dateOnly');
  // The time picker opens on the row's day at its picked time, else the default schedule time.
  const { timePickerField } = controller;
  const timePickerValue = (() => {
    if (!timePickerField) return null;
    const day = {
      startTime: pendingStartDate,
      dueDate: controller.pendingDueDate,
      reviewAt: controller.pendingReviewDate,
      followUp: controller.delegateFollowUpDate,
    }[timePickerField];
    if (!day) return null;
    const [hours, minutes] = (controller.pendingTimes[timePickerField] || controller.defaultScheduleTime || '09:00')
      .split(':').map(Number);
    const value = new Date(day);
    value.setHours(hours, minutes, 0, 0);
    return value;
  })();
  const aiWorkingLabel = t('ai.working');
  const aiWorkingText = aiWorkingLabel === 'ai.working' ? 'Working...' : aiWorkingLabel;
  const primaryForeground = filledButton.textColor ?? tc.onTint;

  // Quick mode answers the whole tree in one tap, so it shares every terminal
  // step and only replaces the entry screen with a flat row of decisions.
  const entryStep = getProcessInboxEntryStep(mode, processInboxPlan);
  const step = resolveProcessInboxStep(answers, mode, processInboxPlan);
  const isTerminal = isProcessInboxTerminalStep(step);
  const prompt = getProcessInboxStepPrompt(step, processInboxPlan, t);

  useEffect(() => {
    setNotesOpen(false);
  }, [taskId]);

  // Answering a question moves the next one in from the side; reduced motion
  // lands it flat. Two plain Values — the RN shim has no interpolate().
  // JS-driven on purpose: on iOS (new architecture) a re-render of a view whose
  // opacity the native driver animates re-applied a stale value, so the step
  // stayed faded or invisible until another re-render (#1317).
  useEffect(() => {
    if (reducedMotion) {
      fade.setValue(1);
      slide.setValue(0);
      return;
    }
    fade.setValue(0);
    slide.setValue(STEP_TRANSITION_OFFSET);
    Animated.timing(fade, { toValue: 1, duration: STEP_TRANSITION_MS, useNativeDriver: false }).start();
    Animated.timing(slide, { toValue: 0, duration: STEP_TRANSITION_MS, useNativeDriver: false }).start();
  }, [fade, reducedMotion, slide, step, taskId]);

  const commit = useCallback(async (committed: ProcessInboxCommitted, run: () => Promise<boolean>) => {
    if (submittingRef.current) return;
    const undoReceipt = createDecisionUndoReceipt(
      committed === 'trash' ? 'discarded' : committed === 'done' ? 'completed' : 'filed',
    );
    if (!undoReceipt) return;
    // Same title the write commits, not the raw capture — refining the title
    // mid-step must show up in the Undo toast.
    const title = controller.processingTitle.trim() || currentTask?.title || '';
    submittingRef.current = true;
    try {
      if (!await run()) return;
    } finally {
      submittingRef.current = false;
    }
    // Same completion feedback a task row's own done button gives.
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    showToast({
      message: formatProcessInboxCommitMessage(t, committed, title),
      tone: 'info',
      actionLabel: tFallback(t, 'common.undo', 'Undo'),
      onAction: () => { void undoDecision(undoReceipt); },
      durationMs: 5200,
    });
  }, [controller.processingTitle, createDecisionUndoReceipt, currentTask?.title, showToast, t, undoDecision]);

  /** A step button: move to the next question, or commit the destination. */
  const choose = useCallback((choice: string) => {
    const outcome = answerStep(choice, mode);
    if (outcome.type !== 'commit') return;
    const { kind, committed } = outcome;
    if (committed) void commit(committed, () => runCommit(kind));
    else void runCommit(kind);
  }, [answerStep, commit, mode, runCommit]);

  if (!currentTask) return null;

  const moreOptionsDisclosure = (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ expanded: showAdvancedOptions }}
        onPress={toggleAdvancedOptions}
        style={[styles.advancedOptionsButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
      >
        <Text style={[styles.advancedOptionsText, { color: tc.text }]}>
          {tFallback(t, 'common.more', 'More options')}
        </Text>
        {showAdvancedOptions
          ? <ChevronUp size={18} color={tc.secondaryText} />
          : <ChevronDown size={18} color={tc.secondaryText} />}
      </TouchableOpacity>
      {showAdvancedOptions && (
        <>
          <InboxSchedulingSection
            t={t}
            show={controller.showSchedulingSection}
            showStartDateField={controller.showStartDateField}
            showDueDateField={controller.showDueDateField}
            showReviewDateField={controller.showReviewDateField}
            pendingStartDate={pendingStartDate}
            setPendingStartDate={setPendingStartDate}
            pendingStartDateOnly={pendingStartDateOnly}
            setPendingStartDateOnly={setPendingStartDateOnly}
            useDefaultStartTime={controller.useDefaultStartTime}
            setShowStartDatePicker={setShowStartDatePicker}
            pendingDueDate={controller.pendingDueDate}
            setPendingDueDate={controller.setPendingDueDate}
            pendingDueDateOnly={controller.pendingDueDateOnly}
            setPendingDueDateOnly={controller.setPendingDueDateOnly}
            setShowDueDatePicker={controller.setShowDueDatePicker}
            pendingReviewDate={controller.pendingReviewDate}
            setPendingReviewDate={controller.setPendingReviewDate}
            pendingReviewDateOnly={controller.pendingReviewDateOnly}
            setPendingReviewDateOnly={controller.setPendingReviewDateOnly}
            setShowReviewDatePicker={controller.setShowReviewDatePicker}
            pendingTimes={controller.pendingTimes}
            openTimePicker={controller.setTimePickerField}
            tc={tc}
            defaultScheduleTime={controller.defaultScheduleTime}
            dateOnlyLabel={dateOnlyLabel}
          />
          <InboxOrganizationSection
            t={t}
            tc={tc}
            show={controller.showOrganizationSection}
            showPriorityField={controller.showPriorityField}
            selectedPriority={controller.selectedPriority}
            setSelectedPriority={controller.setSelectedPriority}
            showEnergyLevelField={controller.showEnergyLevelField}
            selectedEnergyLevel={controller.selectedEnergyLevel}
            setSelectedEnergyLevel={controller.setSelectedEnergyLevel}
            showTimeEstimateField={controller.showTimeEstimateField}
            selectedTimeEstimate={controller.selectedTimeEstimate}
            setSelectedTimeEstimate={controller.setSelectedTimeEstimate}
            showAssignedToField={controller.showAssignedToField}
            selectedAssignedTo={controller.selectedAssignedTo}
            setSelectedAssignedTo={controller.setSelectedAssignedTo}
            assignedToSuggestions={controller.assignedToSuggestions}
            PRIORITY_OPTIONS={controller.PRIORITY_OPTIONS}
            ENERGY_LEVEL_OPTIONS={controller.ENERGY_LEVEL_OPTIONS}
            timeEstimateOptions={controller.timeEstimateOptions}
          />
          {/* Contexts stay on the step itself; tags ride the disclosure. */}
          {step === 'file' && (
            <InboxContextSection
              t={t}
              tc={tc}
              show={controller.showTagsField}
              showContextsField={false}
              showTagsField={controller.showTagsField}
              selectedContexts={controller.selectedContexts}
              selectedTags={controller.selectedTags}
              toggleContext={controller.toggleContext}
              toggleTag={controller.toggleTag}
              newContext={controller.newContext}
              setNewContext={controller.setNewContext}
              addCustomContextMobile={controller.addCustomContextMobile}
              tokenSuggestions={controller.tokenSuggestions}
              applyTokenSuggestion={controller.applyTokenSuggestion}
              contextCopilotSuggestions={controller.contextCopilotSuggestions}
              tagCopilotSuggestions={controller.tagCopilotSuggestions}
            />
          )}
        </>
      )}
    </>
  );

  const renderContextRow = () => (
    <InboxContextSection
      t={t}
      tc={tc}
      show={controller.showContextsField}
      showContextsField={controller.showContextsField}
      showTagsField={false}
      selectedContexts={controller.selectedContexts}
      selectedTags={controller.selectedTags}
      toggleContext={controller.toggleContext}
      toggleTag={controller.toggleTag}
      newContext={controller.newContext}
      setNewContext={controller.setNewContext}
      addCustomContextMobile={controller.addCustomContextMobile}
      tokenSuggestions={controller.tokenSuggestions}
      applyTokenSuggestion={controller.applyTokenSuggestion}
      contextCopilotSuggestions={controller.contextCopilotSuggestions}
      tagCopilotSuggestions={controller.tagCopilotSuggestions}
    />
  );

  const renderProjectSection = (allowConversion: boolean) => (
    <InboxProjectSection
      t={t}
      tc={tc}
      show={controller.showProjectSection}
      showProjectField={showProjectField}
      showAreaField={controller.showAreaField}
      currentProject={controller.currentProject}
      currentArea={controller.currentArea}
      selectedProjectId={controller.selectedProjectId}
      selectedAreaId={controller.selectedAreaId}
      setSelectedAreaId={controller.setSelectedAreaId}
      projectSearch={controller.projectSearch}
      setProjectSearch={controller.setProjectSearch}
      convertToProject={allowConversion && convertToProject}
      nextActionDraft={controller.nextActionDraft}
      setNextActionDraft={controller.setNextActionDraft}
      extraActionDrafts={controller.extraActionDrafts}
      setExtraActionDrafts={controller.setExtraActionDrafts}
      filteredProjects={controller.filteredProjects}
      areaById={controller.areaById}
      hasExactProjectMatch={controller.hasExactProjectMatch}
      handleCreateProjectEarly={controller.handleCreateProjectEarly}
      handleConvertToProject={controller.handleConvertToProject}
      selectProjectEarly={controller.selectProjectEarly}
    />
  );

  const renderSomedaySection = () => (
    <View style={styles.stepChoiceSection}>
      <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
        {tFallback(t, 'viewSections.somedaySection', 'Someday section')}
      </Text>
      <SomedaySectionPicker
        sections={controller.somedaySections}
        selectedId={controller.selectedSomedaySectionId}
        onSelect={controller.setSelectedSomedaySectionId}
        onCreate={controller.createSomedaySection}
        t={t}
        themeColors={tc}
        optionsStyle={styles.stepSecondaryRow}
        optionStyle={styles.stepSecondaryButton}
        optionTextStyle={styles.stepSecondaryText}
      />
    </View>
  );

  /** A question step: its prompt, its choices, and Trash set apart. */
  const renderPrompt = () => {
    const grid = step === 'decisions' || step === 'actionable';
    const renderChoice = (choice: ProcessInboxStepChoice) => (
      <ChoiceButton
        key={choice.id}
        compact={grid}
        icon={choice.icon ? CHOICE_ICONS[choice.icon] : undefined}
        tc={tc}
        label={choice.label}
        onPress={() => choose(choice.id)}
      />
    );
    return (
      <View>
        {prompt.question ? <Text style={[styles.stepQuestion, { color: tc.text }]}>{prompt.question}</Text> : null}
        {prompt.hint ? <Text style={[styles.stepHint, { color: tc.secondaryText }]}>{prompt.hint}</Text> : null}
        <View style={grid ? styles.stepChoiceGrid : styles.stepChoiceColumn}>
          {prompt.choices.filter((choice) => !choice.danger).map(renderChoice)}
        </View>
        {prompt.choices.filter((choice) => choice.danger).map((choice) => (
          <TouchableOpacity
            key={choice.id}
            accessibilityRole="button"
            accessibilityLabel={choice.label}
            style={styles.stepTertiaryButton}
            onPress={() => choose(choice.id)}
          >
            <Trash2 size={16} color={tc.danger} strokeWidth={2} />
            <Text style={[styles.stepTertiaryText, { color: tc.danger }]}>{choice.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  const renderStep = () => {
    switch (step) {
      // Quick mode puts every destination on one screen. Terminal ones commit
      // on the tap; the rest drop straight into that decision's follow-up step.
      case 'decisions':
      case 'actionable':
      case 'twoMinute':
      case 'execution':
      case 'oneAction':
        return renderPrompt();

      case 'someday':
        return (
          <View>
            {renderProjectSection(false)}
            {renderSomedaySection()}
          </View>
        );

      case 'later':
        return (
          <View>
            <Text style={[styles.stepQuestion, { color: tc.text }]}>{prompt.question}</Text>
            <Text style={[styles.stepHint, { color: tc.secondaryText }]}>{prompt.hint}</Text>
            <InboxDateSelectorRow
              t={t}
              label={t('taskEdit.startDateLabel')}
              value={pendingStartDate}
              quickDatePresets={DATED_QUICK_DATE_PRESETS}
              onOpen={() => setShowStartDatePicker(true)}
              onClear={() => {
                setPendingStartDate(null);
                setPendingStartDateOnly(false);
              }}
              onQuickDateSelect={(date) => {
                setPendingStartDate(date);
                setPendingStartDateOnly(false);
              }}
              dateOnly={pendingStartDateOnly}
              onDateOnly={() => setPendingStartDateOnly(true)}
              onUseDefaultTime={controller.useDefaultStartTime}
              time={controller.pendingTimes.startTime}
              onOpenTime={() => controller.setTimePickerField('startTime')}
              defaultScheduleTime={controller.defaultScheduleTime}
              dateOnlyLabel={dateOnlyLabel}
              notSetLabel={t('common.notSet')}
              clearLabel={t('common.clear')}
              tc={tc}
            />
            {/* Start later lands in Next, where contexts decide when it shows (#1445). */}
            {renderContextRow()}
            {renderProjectSection(false)}
          </View>
        );

      case 'incubate':
        return (
          <View>
            <Text style={[styles.stepQuestion, { color: tc.text }]}>{prompt.question}</Text>
            <Text style={[styles.stepHint, { color: tc.secondaryText }]}>{prompt.hint}</Text>
            <InboxDateSelectorRow
              required
              t={t}
              label={t('taskEdit.reviewDateLabel')}
              value={controller.pendingReviewDate}
              selectedPreset={null}
              onOpen={() => controller.setShowReviewDatePicker(true)}
              onClear={() => {
                controller.setPendingReviewDate(null);
                controller.setPendingReviewDateOnly(false);
              }}
              onQuickDateSelect={(date) => {
                controller.setPendingReviewDate(date);
                controller.setPendingReviewDateOnly(false);
              }}
              dateOnly={controller.pendingReviewDateOnly}
              onDateOnly={() => controller.setPendingReviewDateOnly(true)}
              onUseDefaultTime={() => controller.setPendingReviewDateOnly(false)}
              time={controller.pendingTimes.reviewAt}
              onOpenTime={() => controller.setTimePickerField('reviewAt')}
              defaultScheduleTime={controller.defaultScheduleTime}
              dateOnlyLabel={dateOnlyLabel}
              notSetLabel={t('common.notSet')}
              clearLabel={t('common.clear')}
              tc={tc}
            />
            {renderProjectSection(false)}
            {renderSomedaySection()}
          </View>
        );

      case 'waiting':
        return (
          <View>
            <InboxExecutionSection
              t={t}
              tc={tc}
              delegateWho={controller.delegateWho}
              setDelegateWho={controller.setDelegateWho}
              delegateWhoSuggestions={controller.delegateWhoSuggestions}
              showReviewDateField={controller.showReviewDateField}
              delegateFollowUpDate={controller.delegateFollowUpDate}
              setDelegateFollowUpDate={controller.setDelegateFollowUpDate}
              delegateFollowUpDateOnly={controller.delegateFollowUpDateOnly}
              setDelegateFollowUpDateOnly={controller.setDelegateFollowUpDateOnly}
              setShowDelegateDatePicker={controller.setShowDelegateDatePicker}
              delegateFollowUpTime={controller.pendingTimes.followUp}
              openTimePicker={controller.setTimePickerField}
              handleSendDelegateRequest={controller.handleSendDelegateRequest}
              defaultScheduleTime={controller.defaultScheduleTime}
              dateOnlyLabel={dateOnlyLabel}
            />
            {moreOptionsDisclosure}
          </View>
        );

      case 'file': {
        const projectRow = renderProjectSection(true);
        const contextRow = renderContextRow();
        return (
          <View>
            {/* Same precedence the one-scroll form used: context first unless
                the user asked to be shown the project home first. */}
            {projectFirst ? projectRow : contextRow}
            {projectFirst ? contextRow : projectRow}
            {moreOptionsDisclosure}
          </View>
        );
      }
    }
  };

  // The conversion card carries its own "Create project" commit (#827), so the
  // step's own commit button would be a second way to finish the same step.
  const showFileItButton = isTerminal && !(step === 'file' && convertToProject);

  return (
    <View style={styles.stepContainer}>
      <ScrollView
        ref={controller.processingScrollRef}
        style={styles.singlePageScroll}
        contentContainerStyle={styles.singlePageContent}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
      >
        <InboxCaptureCard
          t={t}
          tc={tc}
          titleInputRef={controller.titleInputRef}
          processingTitle={controller.processingTitle}
          setProcessingTitle={controller.setProcessingTitle}
          similarTasks={controller.similarTasks}
          similarTaskProjectTitles={controller.similarTaskProjectTitles}
          convertToProject={step === 'file' && convertToProject}
          processingDescription={controller.processingDescription}
          setProcessingDescription={controller.setProcessingDescription}
          isReturningItem={controller.isReturningItem}
          processingTitleFocused={controller.processingTitleFocused}
          setProcessingTitleFocused={controller.setProcessingTitleFocused}
          titleDirectionStyle={controller.titleDirectionStyle}
          aiEnabled={controller.aiEnabled}
          isAIWorking={controller.isAIWorking}
          isAICancellable={controller.isAICancellable}
          handleAIClarifyInbox={controller.handleAIClarifyInbox}
          handleAICancelInbox={controller.handleAICancelInbox}
          aiWorkingText={aiWorkingText}
          notesOpen={notesOpen}
          setNotesOpen={setNotesOpen}
        />

        <Animated.View
          style={[styles.stepBody, { opacity: fade, transform: [{ translateX: slide }] }]}
        >
          {renderStep()}
        </Animated.View>

        {step !== entryStep && (
          <TouchableOpacity accessibilityRole="button" style={styles.stepBackButton} onPress={() => choose('back')}>
            <Text style={[styles.stepBackText, { color: tc.secondaryText }]}>
              {`‹ ${tFallback(t, 'common.back', 'Back')}`}
            </Text>
          </TouchableOpacity>
        )}

        <InboxDatePickers
          configs={[
            {
              show: (controller.showStartDateField || step === 'later') && showStartDatePicker,
              value: pendingStartDate,
              onClose: () => setShowStartDatePicker(false),
              onSelect: (date) => {
                setPendingStartDate(date);
                setPendingStartDateOnly(false);
              },
            },
            {
              show: controller.showDueDateField && controller.showDueDatePicker,
              value: controller.pendingDueDate,
              onClose: () => controller.setShowDueDatePicker(false),
              onSelect: (date) => { controller.setPendingDueDate(date); controller.setPendingDueDateOnly(false); },
            },
            {
              show: (controller.showReviewDateField || step === 'incubate') && controller.showReviewDatePicker,
              value: controller.pendingReviewDate,
              onClose: () => controller.setShowReviewDatePicker(false),
              onSelect: (date) => { controller.setPendingReviewDate(date); controller.setPendingReviewDateOnly(false); },
            },
            {
              show: controller.showDelegateDatePicker,
              value: controller.delegateFollowUpDate,
              onClose: () => controller.setShowDelegateDatePicker(false),
              onSelect: (date) => {
                controller.setDelegateFollowUpDate(date);
                controller.setDelegateFollowUpDateOnly(false);
              },
            },
            {
              mode: 'time',
              show: timePickerField !== null,
              value: timePickerValue,
              onClose: () => controller.setTimePickerField(null),
              onSelect: (date) => {
                if (timePickerField) controller.setPendingTime(timePickerField, date);
              },
            },
          ]}
        />
      </ScrollView>

      {/* Reserve space above the footer; feedback must not cover decisions. */}
      <ToastViewport inline />

      {showFileItButton && (
        <View
          style={[
            styles.bottomActionBar,
            { borderTopColor: tc.border, paddingBottom: Math.max(controller.insets.bottom, 10) },
          ]}
        >
          <TouchableOpacity
            style={[styles.bottomNextButton, { backgroundColor: filledButton.backgroundColor }]}
            accessibilityRole="button"
            onPress={() => choose('fileIt')}
          >
            <Text style={[styles.bottomNextButtonText, { color: primaryForeground }]}>
              {tFallback(t, 'inbox.fileIt', 'File it')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
