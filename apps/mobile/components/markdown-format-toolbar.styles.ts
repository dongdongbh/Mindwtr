import { StyleSheet } from 'react-native';

export const markdownFormatToolbarStyles = StyleSheet.create({
    overlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
    },
    floatingBar: {
        position: 'absolute',
        left: 0,
        right: 0,
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 8,
        paddingTop: 4,
        paddingBottom: 4,
    },
    scroll: {
        flex: 1,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    content: {
        alignItems: 'center',
        gap: 4,
        paddingVertical: 1,
        paddingRight: 8,
    },
    trailingActions: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 4,
    },
    divider: {
        width: StyleSheet.hairlineWidth,
        height: 20,
        marginHorizontal: 4,
        opacity: 0.8,
    },
    button: {
        minWidth: 32,
        minHeight: 30,
        paddingHorizontal: 7,
        borderRadius: 7,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonDisabled: {
        opacity: 0.35,
    },
    buttonText: {
        fontSize: 11,
        fontWeight: '700',
    },
    buttonTextItalic: {
        fontStyle: 'italic',
    },
});
