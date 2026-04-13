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
    backgroundColor: '#3B82F6',
    borderRadius: 2,
  },
  skipBtn: {
    fontSize: 16,
    fontWeight: '600',
    color: '#3B82F6',
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
  metaPillContextDark: {
    backgroundColor: '#0F172A',
    color: '#93C5FD',
  },
  metaPillContextLight: {
    backgroundColor: '#DBEAFE',
    color: '#1D4ED8',
  },
  metaPillTagDark: {
    backgroundColor: '#111827',
    color: '#FDE68A',
  },
  metaPillTagLight: {
    backgroundColor: '#FEF3C7',
    color: '#92400E',
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
  },
  aiActionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  stepContainer: {
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
  stepHint: {
    fontSize: 13,
    marginBottom: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  buttonColumn: {
    gap: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonPrimary: {
    backgroundColor: '#3B82F6',
  },
  buttonSuccess: {
    backgroundColor: '#22C55E',
  },
  buttonPrimaryText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  buttonSecondary: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonText: {
    fontWeight: '600',
  },
  bigButton: {
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  bigButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
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
    backgroundColor: '#3B82F6',
  },
  selectedTagChip: {
    backgroundColor: '#8B5CF6',
  },
  selectedTokenText: {
    color: '#FFFFFF',
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
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addContextButtonText: {
    color: '#FFFFFF',
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
  createProjectButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  createProjectButtonText: {
    color: '#FFFFFF',
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
    color: '#FFFFFF',
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
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomNextButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  singleSection: {
    borderBottomWidth: 1,
    paddingBottom: 18,
    marginBottom: 18,
  },
});
