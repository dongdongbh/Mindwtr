import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 22,
    fontWeight: '700',
  },
  count: {
    fontSize: 13,
    fontWeight: '500',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 10,
  },
  headerAccessoryRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
    alignItems: 'flex-end',
  },
  sortButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sortButtonText: {
    fontSize: 12,
  },
  selectButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  selectButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  bulkBar: {
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  bulkCount: {
    fontSize: 12,
    fontWeight: '600',
  },
  bulkStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  bulkLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bulkLoadingText: {
    fontSize: 11,
    fontWeight: '500',
  },
  bulkMoveRow: {
    gap: 6,
    paddingVertical: 2,
  },
  bulkMoveButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  bulkMoveText: {
    fontSize: 12,
    fontWeight: '500',
  },
  bulkActions: {
    flexDirection: 'row',
    gap: 8,
  },
  bulkActionButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  bulkActionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  modalButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modalButtonDisabled: {
    opacity: 0.5,
  },
  modalButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  sortList: {
    gap: 6,
  },
  sortItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  sortItemText: {
    fontSize: 14,
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 16,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
  copilotPill: {
    marginTop: 8,
    marginHorizontal: 16,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  copilotText: {
    fontSize: 12,
    fontWeight: '600',
  },
  copilotHint: {
    fontSize: 11,
    marginTop: 2,
  },
  copilotLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addButton: {
    width: 44,
    height: 44,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addButtonDisabled: {
    opacity: 0.5,
  },
  typeaheadContainer: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  typeaheadRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  typeaheadText: {
    fontSize: 13,
  },
  addButtonText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  quickAddHelp: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  filterSection: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  filterChips: {
    gap: 8,
    alignItems: 'center',
  },
  filterChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  list: {
    flex: 1,
  },
  staticList: {
    flex: 1,
  },
  staticItem: {
    marginBottom: 0,
  },
  listContent: {
    padding: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingTop: 10,
    paddingBottom: 6,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionCount: {
    fontSize: 11,
    fontWeight: '600',
  },
  taskItem: {
    flexDirection: 'row',
    backgroundColor: '#f9f9f9',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    alignItems: 'center',
  },
  taskContent: {
    flex: 1,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  taskDescription: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  taskMeta: {
    fontSize: 12,
    color: '#666',
  },
  deleteButton: {
    display: 'none',
  },
  deleteAction: {
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
  },
  promoteAction: {
    backgroundColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
  },
  actionText: {
    color: '#fff',
    fontWeight: '600',
    padding: 20,
  },
  badgeContainer: {
    justifyContent: 'center',
    paddingLeft: 8,
  },
  searchInput: {
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    fontSize: 16,
    backgroundColor: '#f9f9f9',
  },
});
