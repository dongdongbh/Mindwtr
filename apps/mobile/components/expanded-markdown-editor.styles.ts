import { StyleSheet } from 'react-native';

export const expandedMarkdownEditorStyles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        position: 'relative',
        minHeight: 56,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    title: {
        fontSize: 15,
        fontWeight: '600',
        textAlign: 'center',
        paddingHorizontal: 76,
    },
    closeButton: {
        position: 'absolute',
        left: 16,
        top: 8,
        bottom: 8,
        width: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    modeButton: {
        position: 'absolute',
        right: 16,
        top: 11,
        bottom: 11,
        minWidth: 64,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    modeButtonText: {
        fontSize: 11,
        fontWeight: '600',
    },
    body: {
        flex: 1,
    },
    content: {
        flex: 1,
        padding: 16,
    },
    editorInput: {
        flex: 1,
        borderWidth: 1,
        borderRadius: 12,
        padding: 16,
        fontSize: 16,
        lineHeight: 24,
        textAlignVertical: 'top',
    },
    previewScroll: {
        flex: 1,
    },
    previewContent: {
        flexGrow: 1,
        padding: 16,
    },
    previewSurface: {
        flexGrow: 1,
        borderWidth: 1,
        borderRadius: 12,
        padding: 16,
    },
});
