import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
        borderBottomWidth: 1,
    },
    closeButton: {
        padding: 4,
        minWidth: 28,
        minHeight: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
    },
    headerTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
        justifyContent: 'center',
    },
    stepTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12,
    },
    stepTitleInline: {
        fontSize: 24,
        fontWeight: 'bold',
    },
    stepIndicator: {
        fontSize: 14,
    },
    progressContainer: {
        height: 4,
    },
    progressBar: {
        height: '100%',
        backgroundColor: '#3B82F6',
    },
    content: {
        flex: 1,
        padding: 20,
    },
    centerContent: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    bigIcon: {
        marginBottom: 20,
    },
    heading: {
        fontSize: 28,
        fontWeight: 'bold',
        marginBottom: 12,
        textAlign: 'center',
    },
    description: {
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 32,
        paddingHorizontal: 20,
    },
    primaryButton: {
        backgroundColor: '#3B82F6',
        paddingHorizontal: 32,
        paddingVertical: 14,
        borderRadius: 12,
    },
    primaryButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '600',
    },
    stepContent: {
        flex: 1,
    },
    calendarStepContent: {
        paddingBottom: 20,
    },
    hint: {
        fontSize: 14,
        marginBottom: 16,
    },
    infoBox: {
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        marginBottom: 16,
    },
    infoText: {
        fontSize: 16,
        marginBottom: 8,
    },
    guideText: {
        fontSize: 14,
        lineHeight: 20,
        marginTop: 4,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyIcon: {
        marginBottom: 12,
    },
    emptyText: {
        fontSize: 16,
    },
    taskList: {
        flex: 1,
    },
    aiItemRow: {
        flexDirection: 'row',
        gap: 12,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        marginBottom: 10,
    },
    aiCheckbox: {
        width: 18,
        height: 18,
        borderRadius: 4,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    aiCheckboxText: {
        color: '#FFFFFF',
        fontSize: 12,
        fontWeight: '700',
    },
    aiItemTitle: {
        fontSize: 15,
        fontWeight: '600',
    },
    aiItemMeta: {
        fontSize: 12,
        marginTop: 4,
    },
    calendarColumn: {
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        minHeight: 140,
    },
    calendarColumnTitle: {
        fontSize: 12,
        fontWeight: '700',
        textTransform: 'uppercase',
        marginBottom: 8,
        letterSpacing: 0.4,
    },
    calendarEventList: {
        gap: 8,
    },
    calendarDayCard: {
        borderWidth: 1,
        borderRadius: 8,
        padding: 8,
        gap: 6,
    },
    calendarDayTitle: {
        fontSize: 12,
        fontWeight: '700',
    },
    calendarEventRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    calendarEventTitle: {
        fontSize: 14,
        fontWeight: '600',
    },
    calendarEventMeta: {
        fontSize: 12,
    },
    loadingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    calendarToggleText: {
        textDecorationLine: 'underline',
        marginTop: 2,
    },
    reviewAddTaskButton: {
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        marginBottom: 10,
    },
    reviewAddTaskButtonText: {
        fontSize: 13,
        fontWeight: '600',
    },
    projectItem: {
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        marginBottom: 8,
    },
    projectHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    projectDot: {
        width: 12,
        height: 12,
        borderRadius: 6,
        marginRight: 8,
    },
    projectTitle: {
        fontSize: 16,
        fontWeight: '600',
        flex: 1,
    },
    reviewProjectAddTaskButton: {
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
        marginRight: 8,
    },
    reviewProjectAddTaskButtonText: {
        fontSize: 12,
        fontWeight: '600',
    },
    contextGroupCard: {
        borderWidth: 1,
        borderRadius: 10,
        marginBottom: 10,
        overflow: 'hidden',
    },
    contextGroupHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    contextGroupTitle: {
        fontSize: 14,
        fontWeight: '700',
    },
    contextGroupCount: {
        fontSize: 12,
        fontWeight: '600',
    },
    contextTaskRow: {
        borderTopWidth: 1,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    contextTaskTitle: {
        fontSize: 13,
        fontWeight: '500',
    },
    contextMoreText: {
        fontSize: 12,
        paddingHorizontal: 10,
        paddingBottom: 8,
        paddingTop: 2,
    },
    promptBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
    },
    promptCard: {
        width: '100%',
        borderRadius: 12,
        borderWidth: 1,
        padding: 16,
    },
    promptTitle: {
        fontSize: 18,
        fontWeight: '700',
    },
    promptProject: {
        marginTop: 4,
        fontSize: 13,
    },
    promptInput: {
        marginTop: 12,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 10,
        fontSize: 15,
    },
    promptActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        marginTop: 14,
    },
    promptButton: {
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    promptButtonText: {
        fontSize: 14,
        fontWeight: '600',
    },
    promptButtonPrimary: {
        backgroundColor: '#3B82F6',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    promptButtonPrimaryText: {
        color: '#FFFFFF',
        fontSize: 14,
        fontWeight: '600',
    },
    statusBadge: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
    },
    taskCount: {
        fontSize: 14,
        marginLeft: 20,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        borderTopWidth: 1,
    },
    backButton: {
        padding: 12,
    },
    backButtonText: {
        fontSize: 16,
    },
    projectMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    expandIcon: {
        fontSize: 12,
        marginLeft: 8,
    },
    projectTasks: {
        marginLeft: 12,
        marginBottom: 8,
        borderLeftWidth: 2,
        borderLeftColor: '#3B82F6',
        paddingLeft: 8,
    },
});
