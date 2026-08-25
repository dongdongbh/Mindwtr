import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContainer: {
    width: '90%',
    height: '85%',
    borderRadius: 20,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerClose: {
    fontSize: 22,
    fontWeight: '700',
  },
  progressContainer: {
    flex: 1,
    alignItems: 'center',
  },
  progressText: {
    fontSize: 12,
    marginBottom: 4,
  },
  progressBar: {
    height: 4,
    borderRadius: 2,
    width: '70%',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  skipBtn: {
    fontSize: 16,
    fontWeight: '600',
  },
  taskDisplay: {
    padding: 20,
    borderBottomWidth: 0,
    flexShrink: 1,
    overflow: 'hidden',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  fullScreenContainer: {
    flex: 1,
  },
  processingHeader: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 60,
  },
  headerActionButton: {
    minWidth: 72,
    minHeight: 44,
    justifyContent: 'center',
  },
  headerActionButtonLeft: {
    alignItems: 'flex-start',
  },
  headerActionButtonRight: {
    alignItems: 'flex-end',
  },
  headerActionSpacer: {
    minWidth: 72,
  },
  loadingText: {
    fontSize: 14,
  },
  taskTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 6,
  },
  taskDescription: {
    fontSize: 14,
    marginBottom: 0,
  },
  descriptionScroll: {
    marginBottom: 6,
  },
  descriptionScrollContent: {
    paddingBottom: 4,
  },
  taskMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  metaPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    fontSize: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  aiActionRow: {
    marginTop: 10,
    flexDirection: 'row',
  },
  aiActionButton: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  aiActionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  stepContainer: {
    flex: 1,
  },
  keyboardAvoidingContainer: {
    flex: 1,
  },
  stepContent: {
    flex: 1,
  },
  stepQuestion: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  stepQuestionRow: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  stepQuestionInline: {
    flex: 1,
    marginBottom: 0,
  },
  stepHint: {
    fontSize: 13,
    marginBottom: 12,
  },
  buttonColumn: {
    gap: 12,
  },
  buttonSecondary: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  buttonText: {
    fontWeight: '600',
  },
  bigButton: {
    minHeight: 48,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 10,
  },
  bigButtonText: {
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  refineContainer: {
    gap: 8,
    paddingBottom: 8,
  },
  refineScroll: {
    maxHeight: '100%',
  },
  projectRefineSection: {
    marginTop: 12,
    gap: 8,
  },
  refineLabel: {
    fontSize: 12,
    marginBottom: 4,
  },
  refineTitleInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  refineDescriptionInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  waitingInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  startDateRow: {
    marginTop: 12,
    marginBottom: 12,
  },
  startDateActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 6,
    gap: 8,
  },
  startDateButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  startDateButtonText: {
    fontSize: 13,
  },
  startDateClear: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  startDateClearText: {
    fontSize: 12,
  },
  selectedContextsContainer: {
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
  },
  selectedTokensRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  selectedTokenChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  selectedContextChip: {
  },
  selectedTagChip: {
  },
  selectedTokenText: {
    fontSize: 12,
  },
  prioritySection: {
    marginBottom: 12,
    gap: 6,
  },
  priorityChip: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  priorityChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  customContextContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  contextInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  addContextButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addContextButtonText: {
    fontSize: 18,
    fontWeight: '700',
  },
  tokenSuggestionsContainer: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 8,
    marginBottom: 8,
    gap: 6,
  },
  tokenSuggestionChip: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tokenSuggestionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  tokenSectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  tokenChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  suggestionChip: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  contextWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  contextChip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
  },
  contextChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  projectSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  projectSearchInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  projectDecisionRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  projectDecisionButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectDecisionText: {
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  projectConversionCard: {
    gap: 10,
  },
  projectFieldGroup: {
    gap: 6,
  },
  projectFieldLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  projectConversionSubmit: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    paddingVertical: 12,
  },
  extraActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  extraActionInput: {
    flex: 1,
  },
  extraActionRemove: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  extraActionRemoveText: {
    fontSize: 16,
  },
  addActionButton: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  addActionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  createProjectButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  createProjectButtonText: {
    fontWeight: '700',
  },
  projectListContainer: {
    gap: 0,
  },
  projectChip: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  projectChipText: {
    fontWeight: '600',
  },
  projectDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  singlePageScroll: {
    flex: 1,
  },
  singlePageContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
  },
  bottomActionBar: {
    borderTopWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  bottomNextButton: {
    borderRadius: 12,
    minHeight: 48,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomNextButtonText: {
    fontSize: 16,
    fontWeight: '700',
  },
  advancedOptionsButton: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    marginBottom: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  advancedOptionsText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  singleSection: {
    borderBottomWidth: 1,
    paddingBottom: 18,
    marginBottom: 18,
  },
  // The item stays anchored above every step so the question always has its
  // subject in view.
  anchorCard: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 20,
    gap: 4,
  },
  anchorTitleInput: {
    fontSize: 17,
    fontWeight: '700',
    padding: 0,
    minHeight: 24,
  },
  anchorActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 16,
    marginTop: 8,
  },
  anchorActionButton: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  anchorActionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  anchorNote: {
    fontSize: 13,
    lineHeight: 18,
  },
  stepBody: {
    marginBottom: 8,
  },
  stepPrimaryButton: {
    minHeight: 56,
    borderRadius: 14,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepPrimaryText: {
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  stepSecondaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  stepSecondaryButton: {
    flexGrow: 1,
    flexBasis: 96,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  stepSecondaryText: {
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
  },
  stepTertiaryButton: {
    marginTop: 16,
    minHeight: 44,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
  stepTertiaryText: {
    fontSize: 14,
    fontWeight: '600',
  },
  stepBackButton: {
    marginTop: 18,
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingRight: 12,
  },
  modeToggleButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBackText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
