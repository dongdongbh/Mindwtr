import { isSandboxMode } from '@mindwtr/core';
import { StyleSheet, Text, View } from 'react-native';

import { useLanguage } from '@/contexts/language-context';

export function SandboxWorkspaceCue() {
    if (!isSandboxMode()) return null;
    return <SandboxWorkspaceCueContent />;
}

function SandboxWorkspaceCueContent() {
    const { t } = useLanguage();
    return (
        <View style={styles.cue} accessibilityRole="summary" testID="sandbox-workspace-modal-cue">
            <Text style={styles.cueText} numberOfLines={1}>{t('sandbox.title')}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    cue: {
        minHeight: 28,
        paddingHorizontal: 12,
        justifyContent: 'center',
        backgroundColor: '#FEF3C7',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#D97706',
    },
    cueText: {
        color: '#713F12',
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '700',
        textAlign: 'center',
    },
});
