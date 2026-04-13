import { StyleSheet } from 'react-native';

export const projectsScreenStyles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    inputContainer: {
        padding: 16,
        gap: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#e5e5e5',
    },
    filterSection: {
        gap: 8,
    },
    filterHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    filterToggleText: {
        fontSize: 12,
        fontWeight: '600',
    },
    tagFilterLabel: {
        fontSize: 12,
        fontWeight: '600',
    },
    tagFilterChips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    tagFilterChip: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
    },
    tagFilterText: {
        fontSize: 12,
        fontWeight: '600',
    },
    input: {
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 16,
    },
    colorPicker: {
        flexDirection: 'row',
        gap: 8,
    },
    colorOption: {
        width: 32,
        height: 32,
        borderRadius: 16,
        borderWidth: 2,
        borderColor: 'transparent',
    },
    colorOptionSelected: {
        borderColor: '#000',
    },
    addButton: {
        borderRadius: 10,
        paddingVertical: 10,
        alignItems: 'center',
    },
    addButtonDisabled: {
        opacity: 0.5,
    },
    addButtonText: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '600',
    },
    projectItem: {
        flexDirection: 'row',
        backgroundColor: '#f9f9f9',
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
        alignItems: 'center',
    },
    projectTouchArea: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
    },
    projectColor: {
        width: 12,
        height: 12,
        borderRadius: 6,
        marginRight: 12,
    },
    projectDetailScroll: {
        paddingBottom: 24,
    },
    projectContent: {
        flex: 1,
    },
    sectionBlock: {
        marginBottom: 12,
    },
    projectTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    projectTagDots: {
        flexDirection: 'row',
        gap: 4,
        marginLeft: 6,
    },
    projectTagDot: {
        width: 6,
        height: 6,
        borderRadius: 999,
        opacity: 0.7,
    },
    projectTitle: {
        fontSize: 16,
        fontWeight: '500',
        marginBottom: 4,
    },
    projectMeta: {
        fontSize: 12,
        color: '#666',
    },
    deleteButton: {
        width: 32,
        height: 32,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyContainer: {
        padding: 48,
        alignItems: 'center',
    },
    emptyText: {
        color: '#999',
        fontSize: 16,
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#e5e5e5',
    },
    backButton: {
        padding: 8,
        width: 60,
    },
    backButtonText: {
        fontSize: 16,
        color: '#007AFF',
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: 'bold',
    },
    sequentialBadge: {
        backgroundColor: '#DBEAFE',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
    },
    sequentialBadgeText: {
        fontSize: 10,
        color: '#1D4ED8',
        fontWeight: '500',
    },
    sequentialToggle: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: '#F3F4F6',
    },
    sequentialToggleActive: {
        backgroundColor: '#3B82F6',
    },
    sequentialToggleText: {
        fontSize: 12,
        fontWeight: '600',
        color: '#6B7280',
    },
    sequentialToggleTextActive: {
        color: '#FFFFFF',
    },
    statusBlock: {
        borderBottomWidth: 1,
    },
    statusActionsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 8,
    },
    statusLabel: {
        fontSize: 12,
        fontWeight: '600',
    },
    statusPicker: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
    },
    statusPickerText: {
        fontSize: 12,
        fontWeight: '600',
    },
    statusMenu: {
        marginHorizontal: 16,
        marginBottom: 10,
        borderWidth: 1,
        borderRadius: 8,
        overflow: 'hidden',
    },
    statusMenuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    statusMenuText: {
        fontSize: 12,
        fontWeight: '600',
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 999,
    },
    statusButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        marginRight: 8,
    },
    statusButtonText: {
        fontSize: 12,
        fontWeight: '600',
    },
    completeButton: {
        backgroundColor: '#10B98120',
    },
    archiveButton: {
        backgroundColor: '#6B728020',
    },
    reactivateButton: {
        backgroundColor: '#3B82F620',
    },
    completeText: {
        color: '#10B981',
    },
    archiveText: {
        color: '#6B7280',
    },
    reactivateText: {
        color: '#3B82F6',
    },
    notesContainer: {
        borderBottomWidth: 1,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    notesHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    detailsToggle: {
        borderRadius: 10,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginTop: 8,
        marginBottom: 12,
    },
    detailsToggleButton: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    detailsToggleText: {
        fontSize: 14,
        fontWeight: '600',
    },
    notesHeader: {
        paddingVertical: 8,
    },
    notesTitle: {
        fontSize: 14,
        fontWeight: '600',
    },
    notesInput: {
        marginTop: 8,
        borderRadius: 8,
        padding: 10,
        minHeight: 100,
        textAlignVertical: 'top',
        fontSize: 14,
        borderWidth: 1,
    },
    smallButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
    },
    smallButtonText: {
        fontSize: 12,
        fontWeight: '700',
    },
    markdownPreview: {
        marginTop: 8,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
    },
    attachmentsContainer: {
        borderBottomWidth: 1,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    attachmentsHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    attachmentsTitle: {
        fontSize: 14,
        fontWeight: '700',
    },
    attachmentsActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    helperText: {
        marginTop: 8,
        fontSize: 13,
    },
    attachmentsList: {
        marginTop: 10,
        borderWidth: 1,
        borderRadius: 10,
        overflow: 'hidden',
    },
    attachmentRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderBottomWidth: 1,
    },
    attachmentTitleWrap: {
        flex: 1,
        paddingRight: 10,
    },
    attachmentTitle: {
        fontSize: 13,
        fontWeight: '600',
    },
    attachmentDownload: {
        fontSize: 12,
        fontWeight: '600',
        marginRight: 10,
    },
    attachmentStatus: {
        fontSize: 12,
        fontWeight: '500',
        marginRight: 10,
    },
    attachmentRemove: {
        fontSize: 12,
        fontWeight: '700',
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    linkModalCard: {
        width: '100%',
        maxWidth: 420,
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
    },
    linkModalTitle: {
        fontSize: 16,
        fontWeight: '700',
        marginBottom: 12,
    },
    linkModalInput: {
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 16,
    },
    linkModalHint: {
        fontSize: 12,
        marginTop: 8,
    },
    linkModalButtons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 12,
        marginTop: 14,
    },
    previewCard: {
        width: '100%',
        maxWidth: 520,
        borderRadius: 12,
        borderWidth: 1,
        overflow: 'hidden',
    },
    previewHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    previewTitle: {
        flex: 1,
        fontSize: 14,
        fontWeight: '700',
    },
    previewImage: {
        width: '100%',
        height: 360,
        backgroundColor: '#000',
    },
    areaManagerList: {
        paddingBottom: 8,
    },
    areaManagerHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    areaSortButtons: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    areaSortButton: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        borderWidth: 1,
    },
    areaSortText: {
        fontSize: 12,
        fontWeight: '600',
    },
    areaManagerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 8,
        borderBottomWidth: 1,
    },
    areaManagerItem: {
        flexDirection: 'column',
    },
    areaColorPickerRow: {
        flexDirection: 'row',
        paddingBottom: 8,
        paddingLeft: 28,
        gap: 10,
        flexWrap: 'wrap',
    },
    areaManagerInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    areaManagerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    areaManagerText: {
        fontSize: 14,
        fontWeight: '600',
    },
    areaOrderButtons: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginRight: 8,
    },
    colorToggleButton: {
        padding: 6,
        borderRadius: 8,
        borderWidth: 1,
    },
    areaOrderButton: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    areaOrderButtonDisabled: {
        opacity: 0.5,
    },
    areaOrderText: {
        fontSize: 12,
        fontWeight: '700',
    },
    areaDeleteButton: {
        paddingHorizontal: 6,
        paddingVertical: 4,
    },
    areaDeleteButtonDisabled: {
        opacity: 0.6,
    },
    areaDeleteText: {
        fontSize: 12,
        fontWeight: '700',
    },
    pickerCard: {
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        minWidth: 280,
        maxWidth: 360,
    },
    pickerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 10,
        borderBottomWidth: 1,
    },
    pickerRowText: {
        fontSize: 14,
        fontWeight: '600',
    },
    areaDot: {
        width: 10,
        height: 10,
        borderRadius: 999,
    },
    tagInputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 8,
        marginTop: 10,
    },
    tagInput: {
        flex: 1,
        paddingVertical: 8,
        fontSize: 14,
    },
    tagAddButton: {
        borderLeftWidth: 1,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    tagAddButtonText: {
        fontSize: 16,
        fontWeight: '700',
    },
    tagOptions: {
        marginTop: 12,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    tagOption: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
    },
    tagOptionText: {
        fontSize: 12,
        fontWeight: '600',
    },
    linkModalButton: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 10,
    },
    linkModalButtonText: {
        fontSize: 14,
        fontWeight: '700',
    },
    linkModalButtonDisabled: {
        opacity: 0.5,
    },
    reviewContainer: {
        borderBottomWidth: 1,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    reviewLabel: {
        fontSize: 14,
        fontWeight: '600',
        marginBottom: 6,
    },
    reviewButton: {
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
    },
    clearReviewBtn: {
        marginTop: 6,
        alignSelf: 'flex-start',
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: '#e5e5e5',
    },
    clearReviewText: {
        fontSize: 12,
        fontWeight: '600',
    },
    focusButton: {
        padding: 8,
    },
});
