import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Cloud,
  Folder,
  Hourglass,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react-native';
import {
  formatTaskMarkedDoneMessage,
  formatTaskMovedMessage,
  QUICK_DATE_PRESETS,
  tFallback,
  type TaskStatus,
} from '@mindwtr/core';

import { styles } from '../inbox-processing-modal.styles';
import { useToast } from '../../contexts/toast-context';
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

/** Which decision landed — picks the Undo toast wording. */
type Committed = 'trash' | Extract<TaskStatus, 'next' | 'waiting' | 'someday' | 'reference' | 'done'>;

type Step = 'actionable' | 'decisions' | 'someday' | 'later' | 'incubate' | 'twoMinute' | 'execution' | 'oneAction' | 'waiting' | 'file';

const STEP_TRANSITION_MS = 200;
const STEP_TRANSITION_OFFSET = 24;
const DATED_QUICK_DATE_PRESETS = QUICK_DATE_PRESETS.filter((preset) => preset !== 'no_date');

function PrimaryButton({
  label,
  background,
  foreground,
  onPress,
}: {
  label: string;
  background: string;
  foreground: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.stepPrimaryButton, { backgroundColor: background }]}
      onPress={onPress}
    >
      <Text style={[styles.stepPrimaryText, { color: foreground }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function SecondaryButton({
  label,
  icon: Icon,
  tc,
  onPress,
}: {
  label: string;
  icon?: LucideIcon;
  tc: ThemeColors;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.stepSecondaryButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
      onPress={onPress}
    >
      {Icon ? <Icon size={18} color={tc.text} strokeWidth={2} /> : null}
      <Text style={[styles.stepSecondaryText, { color: tc.text }]} numberOfLines={2}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * One question per screen: the Inbox processor's decisions laid out as forward
 * steps instead of a form that expands downward. Owns no write paths — every
 * mutation is a controller handler, the same ones this flow has always used.
 */
export function InboxStepFlow({ controller, mode }: { controller: Controller; mode: InboxProcessingMode }) {
  const {
    actionabilityChoice,
    clearDecision,
    convertToProject,
    createDecisionUndoReceipt,
    currentTask,
    executionChoice,
    handleNextTask,
    handleNotActionable,
    handleProjectConversionCancel,
    handleProjectConversionStart,
    handleTwoMinYes,
    finalizeNextAction,
    pendingStartDate,
    pendingStartDateOnly,
    projectFirst,
    setActionabilityChoice,
    setExecutionChoice,
    setPendingStartDate,
    setPendingStartDateOnly,
    setShowStartDatePicker,
    setTwoMinuteChoice,
    showAdvancedOptions,
    showProjectField,
    showStartDatePicker,
    t,
    tc,
    toggleAdvancedOptions,
    twoMinuteChoice,
    twoMinuteEnabled,
    twoMinuteFirst,
    undoDecision,
  } = controller;
  const { showToast } = useToast();
  const filledButton = useFilledButtonColors();
  const reducedMotion = useReducedMotion();
  const [oneActionAnswered, setOneActionAnswered] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const submittingRef = useRef(false);
  const fade = useRef(new Animated.Value(1)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const taskId = currentTask?.id;

  const dateOnlyLabel = t('taskEdit.dateOnly');
  const aiWorkingLabel = t('ai.working');
  const aiWorkingText = aiWorkingLabel === 'ai.working' ? 'Working...' : aiWorkingLabel;
  const primaryForeground = filledButton.textColor ?? tc.onTint;

  // Quick mode answers the whole tree in one tap, so it shares every terminal
  // step and only replaces the entry screen with a flat row of decisions.
  const quick = mode === 'quick';
  const entryStep: Step = quick
    ? 'decisions'
    : twoMinuteEnabled && twoMinuteFirst ? 'twoMinute' : 'actionable';
  const step: Step = (() => {
    if (actionabilityChoice === 'someday') return 'someday';
    if (actionabilityChoice === 'later') return 'later';
    if (actionabilityChoice === 'incubate') return 'incubate';
    if (quick) {
      if (actionabilityChoice !== 'actionable') return 'decisions';
      if (twoMinuteEnabled && twoMinuteChoice === null) return 'decisions';
      if (executionChoice === null) return 'decisions';
    } else {
      if (twoMinuteEnabled && twoMinuteFirst && twoMinuteChoice === null) return 'twoMinute';
      if (actionabilityChoice !== 'actionable') return 'actionable';
      if (twoMinuteEnabled && !twoMinuteFirst && twoMinuteChoice === null) return 'twoMinute';
      if (executionChoice === null) return 'execution';
    }
    if (executionChoice === 'delegate') return 'waiting';
    if (showProjectField && !oneActionAnswered) return 'oneAction';
    return 'file';
  })();
  const isTerminal = step === 'someday' || step === 'later' || step === 'incubate' || step === 'waiting' || step === 'file';

  useEffect(() => {
    setOneActionAnswered(false);
    setNotesOpen(false);
  }, [taskId]);

  // Answering a question moves the next one in from the side; reduced motion
  // lands it flat. Two plain Values — the RN shim has no interpolate().
  useEffect(() => {
    if (reducedMotion) {
      fade.setValue(1);
      slide.setValue(0);
      return;
    }
    fade.setValue(0);
    slide.setValue(STEP_TRANSITION_OFFSET);
    Animated.timing(fade, { toValue: 1, duration: STEP_TRANSITION_MS, useNativeDriver: true }).start();
    Animated.timing(slide, { toValue: 0, duration: STEP_TRANSITION_MS, useNativeDriver: true }).start();
  }, [fade, reducedMotion, slide, step, taskId]);

  const commit = useCallback(async (committed: Committed, run: () => Promise<boolean>) => {
    if (submittingRef.current) return;
    const undoReceipt = createDecisionUndoReceipt(
      committed === 'trash' ? 'discarded' : committed === 'done' ? 'completed' : 'filed',
    );
    if (!undoReceipt) return;
    // Same title the write commits (prepareProcessingEdits), not the raw
    // capture — refining the title mid-step must show up in the Undo toast.
    const title = controller.processingTitle.trim() || currentTask?.title || '';
    submittingRef.current = true;
    try {
      if (!await run()) return;
    } finally {
      submittingRef.current = false;
    }
    // Same completion feedback a task row's own done button gives.
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    let message: string;
    if (committed === 'trash') {
      message = tFallback(t, 'inbox.movedToTrash', '{{title}} moved to Trash').replace('{{title}}', title);
    } else if (committed === 'done') {
      message = formatTaskMarkedDoneMessage(t, title);
    } else {
      message = formatTaskMovedMessage(t, title, committed);
    }
    showToast({
      message,
      tone: 'info',
      actionLabel: tFallback(t, 'common.undo', 'Undo'),
      onAction: () => { void undoDecision(undoReceipt); },
      durationMs: 5200,
    });
  }, [controller.processingTitle, createDecisionUndoReceipt, currentTask?.title, showToast, t, undoDecision]);

  const goBack = useCallback(() => {
    if (quick) {
      clearDecision('actionability');
      setOneActionAnswered(false);
      return;
    }
    if (step === 'file' && oneActionAnswered) {
      handleProjectConversionCancel();
      setOneActionAnswered(false);
      return;
    }
    if (step === 'file' || step === 'waiting' || step === 'oneAction') {
      clearDecision('execution');
      return;
    }
    if (step === 'execution' && twoMinuteEnabled && !twoMinuteFirst) {
      clearDecision('twoMinute');
      return;
    }
    if (step === 'actionable' && twoMinuteEnabled && twoMinuteFirst) {
      clearDecision('twoMinute');
      return;
    }
    clearDecision('actionability');
  }, [clearDecision, handleProjectConversionCancel, oneActionAnswered, quick, step, twoMinuteEnabled, twoMinuteFirst]);

  /** Quick mode: answer the whole tree at once and land on the follow-up (if any). */
  const chooseQuick = useCallback((destination: 'next' | 'project' | 'later' | 'delegate') => {
    if (destination === 'later') {
      setActionabilityChoice('later');
      return;
    }
    setActionabilityChoice('actionable');
    setTwoMinuteChoice('no');
    setExecutionChoice(destination === 'delegate' ? 'delegate' : 'defer');
    // 'project' falls through to the one-action question so quick mode can
    // still split a capture into a project; the rest skip straight past it.
    setOneActionAnswered(destination !== 'project');
  }, [setActionabilityChoice, setExecutionChoice, setTwoMinuteChoice]);

  if (!currentTask) return null;

  const terminalOutcome: Committed = step === 'waiting'
    ? 'waiting'
    : (step === 'incubate' || step === 'someday' ? 'someday' : 'next');

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

  const renderStep = () => {
    switch (step) {
      // Quick mode: every destination on one screen. Terminal ones commit on
      // the tap; the rest drop straight into that decision's follow-up step.
      case 'decisions':
        return (
          <View>
            <PrimaryButton
              label={t('inbox.illDoIt')}
              background={filledButton.backgroundColor}
              foreground={primaryForeground}
              onPress={() => { void commit('next', () => finalizeNextAction(controller.selectedProjectId)); }}
            />
            <View style={styles.stepSecondaryRow}>
              {twoMinuteEnabled && (
                <SecondaryButton
                  icon={CheckCircle2}
                  tc={tc}
                  label={t('inbox.doneIt')}
                  onPress={() => { void commit('done', handleTwoMinYes); }}
                />
              )}
              {showProjectField && (
                <SecondaryButton
                  icon={Folder}
                  tc={tc}
                  label={t('taskEdit.projectLabel')}
                  onPress={() => chooseQuick('project')}
                />
              )}
              <SecondaryButton
                icon={Clock3}
                tc={tc}
                label={tFallback(t, 'process.later', 'Start later')}
                onPress={() => chooseQuick('later')}
              />
              <SecondaryButton
                icon={UserRound}
                tc={tc}
                label={t('inbox.delegate')}
                onPress={() => chooseQuick('delegate')}
              />
              <SecondaryButton
                icon={Cloud}
                tc={tc}
                label={t('inbox.someday')}
                onPress={() => setActionabilityChoice('someday')}
              />
              <SecondaryButton
                icon={Hourglass}
                tc={tc}
                label={tFallback(t, 'process.incubate', 'Incubate')}
                onPress={() => setActionabilityChoice('incubate')}
              />
              <SecondaryButton
                icon={BookOpen}
                tc={tc}
                label={t('nav.reference')}
                onPress={() => { void commit('reference', () => handleNotActionable('reference')); }}
              />
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('inbox.trash')}
              style={styles.stepTertiaryButton}
              onPress={() => { void commit('trash', () => handleNotActionable('trash')); }}
            >
              <Trash2 size={16} color={tc.danger} strokeWidth={2} />
              <Text style={[styles.stepTertiaryText, { color: tc.danger }]}>{t('inbox.trash')}</Text>
            </TouchableOpacity>
          </View>
        );

      case 'actionable':
        return (
          <View>
            <Text style={[styles.stepQuestion, { color: tc.text }]}>{t('inbox.isActionable')}</Text>
            <Text style={[styles.stepHint, { color: tc.secondaryText }]}>{t('inbox.actionableHint')}</Text>
            <PrimaryButton
              label={t('inbox.yes')}
              background={filledButton.backgroundColor}
              foreground={primaryForeground}
              onPress={() => setActionabilityChoice('actionable')}
            />
            <View style={styles.stepSecondaryRow}>
              <SecondaryButton
                icon={Clock3}
                tc={tc}
                label={tFallback(t, 'process.later', 'Start later')}
                onPress={() => setActionabilityChoice('later')}
              />
              <SecondaryButton
                icon={Cloud}
                tc={tc}
                label={t('inbox.someday')}
                onPress={() => setActionabilityChoice('someday')}
              />
              <SecondaryButton
                icon={Hourglass}
                tc={tc}
                label={tFallback(t, 'process.incubate', 'Incubate')}
                onPress={() => setActionabilityChoice('incubate')}
              />
              <SecondaryButton
                icon={BookOpen}
                tc={tc}
                label={t('nav.reference')}
                onPress={() => { void commit('reference', () => handleNotActionable('reference')); }}
              />
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('inbox.trash')}
              style={styles.stepTertiaryButton}
              onPress={() => { void commit('trash', () => handleNotActionable('trash')); }}
            >
              <Trash2 size={16} color={tc.danger} strokeWidth={2} />
              <Text style={[styles.stepTertiaryText, { color: tc.danger }]}>{t('inbox.trash')}</Text>
            </TouchableOpacity>
          </View>
        );

      case 'twoMinute':
        return (
          <View>
            <Text style={[styles.stepQuestion, { color: tc.text }]}>{t('inbox.twoMinRule')}</Text>
            <Text style={[styles.stepHint, { color: tc.secondaryText }]}>{t('inbox.twoMinHint')}</Text>
            <PrimaryButton
              label={t('inbox.doneIt')}
              background={filledButton.backgroundColor}
              foreground={primaryForeground}
              onPress={() => { void commit('done', handleTwoMinYes); }}
            />
            <View style={styles.stepSecondaryRow}>
              <SecondaryButton tc={tc} label={t('inbox.takesLonger')} onPress={() => setTwoMinuteChoice('no')} />
            </View>
          </View>
        );

      case 'execution':
        return (
          <View>
            <Text style={[styles.stepQuestion, { color: tc.text }]}>{t('inbox.whoShouldDoIt')}</Text>
            <PrimaryButton
              label={t('inbox.illDoIt')}
              background={filledButton.backgroundColor}
              foreground={primaryForeground}
              onPress={() => setExecutionChoice('defer')}
            />
            <View style={styles.stepSecondaryRow}>
              <SecondaryButton
                icon={UserRound}
                tc={tc}
                label={t('inbox.delegate')}
                onPress={() => setExecutionChoice('delegate')}
              />
            </View>
          </View>
        );

      case 'oneAction':
        return (
          <View>
            <Text style={[styles.stepQuestion, { color: tc.text }]}>{t('process.moreThanOneStep')}</Text>
            <Text style={[styles.stepHint, { color: tc.secondaryText }]}>{t('process.moreThanOneStepDesc')}</Text>
            <PrimaryButton
              label={t('process.moreThanOneStepNo')}
              background={filledButton.backgroundColor}
              foreground={primaryForeground}
              onPress={() => { handleProjectConversionCancel(); setOneActionAnswered(true); }}
            />
            <View style={styles.stepSecondaryRow}>
              <SecondaryButton
                tc={tc}
                label={t('process.moreThanOneStepYes')}
                onPress={() => { handleProjectConversionStart(); setOneActionAnswered(true); }}
              />
            </View>
          </View>
        );

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
            <Text style={[styles.stepQuestion, { color: tc.text }]}>
              {tFallback(t, 'inbox.deferWhen', 'When should it start?')}
            </Text>
            <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
              {tFallback(t, 'process.laterHint', 'Set a start date and move this to Next Actions.')}
            </Text>
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
              onUseDefaultTime={() => setPendingStartDateOnly(false)}
              defaultScheduleTime={controller.defaultScheduleTime}
              dateOnlyLabel={dateOnlyLabel}
              notSetLabel={t('common.notSet')}
              clearLabel={t('common.clear')}
              tc={tc}
            />
          </View>
        );

      case 'incubate':
        return (
          <View>
            <Text style={[styles.stepQuestion, { color: tc.text }]}>
              {tFallback(t, 'inbox.deferWhen', 'When should it come back?')}
            </Text>
            <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
              {tFallback(t, 'process.incubateHint', 'Park this without deciding. It comes back to clarify on the date you choose.')}
            </Text>
            <InboxDateSelectorRow
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
              handleSendDelegateRequest={controller.handleSendDelegateRequest}
              defaultScheduleTime={controller.defaultScheduleTime}
              dateOnlyLabel={dateOnlyLabel}
            />
            {moreOptionsDisclosure}
          </View>
        );

      case 'file': {
        const projectRow = renderProjectSection(true);
        const contextRow = (
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
          convertToProject={step === 'file' && convertToProject}
          processingDescription={controller.processingDescription}
          setProcessingDescription={controller.setProcessingDescription}
          isReturningItem={controller.isReturningItem}
          processingTitleFocused={controller.processingTitleFocused}
          setProcessingTitleFocused={controller.setProcessingTitleFocused}
          titleDirectionStyle={controller.titleDirectionStyle}
          aiEnabled={controller.aiEnabled}
          isAIWorking={controller.isAIWorking}
          handleAIClarifyInbox={controller.handleAIClarifyInbox}
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
          <TouchableOpacity accessibilityRole="button" style={styles.stepBackButton} onPress={goBack}>
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
          ]}
        />
      </ScrollView>

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
            onPress={() => { void commit(terminalOutcome, handleNextTask); }}
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
