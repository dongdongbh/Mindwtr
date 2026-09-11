import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { RotateCcw, X } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useSettingsLocalization } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles as settingsStyles } from './settings.styles';
import { reloadIntoMobileSandbox, reloadIntoPersonalWorkspace } from '@/lib/sandbox-workspace';

export function SandboxSettingsScreen() {
    const tc = useThemeColors();
    const { t } = useSettingsLocalization();
    const [busy, setBusy] = React.useState<'reset' | 'exit' | null>(null);
    const [failed, setFailed] = React.useState(false);

    const run = (action: 'reset' | 'exit') => {
        if (busy) return;
        setBusy(action);
        setFailed(false);
        const operation = action === 'reset' ? reloadIntoMobileSandbox() : reloadIntoPersonalWorkspace();
        void operation.catch(() => {
            setBusy(null);
            setFailed(true);
        });
    };

    return (
        <SafeAreaView style={[settingsStyles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={t('sandbox.title')} />
            <View style={localStyles.content}>
                <View style={[localStyles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <Text style={[localStyles.title, { color: tc.text }]}>{t('sandbox.title')}</Text>
                    <Text style={[localStyles.description, { color: tc.secondaryText }]}>{t('sandbox.description')}</Text>
                    <Text style={[localStyles.notice, { color: tc.secondaryText, borderColor: tc.border }]}>{t('sandbox.notice')}</Text>
                    {failed ? <Text style={[localStyles.failure, { color: tc.danger }]}>{t('sandbox.switchFailed')}</Text> : null}
                    {busy ? (
                        <View style={localStyles.busy}>
                            <ActivityIndicator color={tc.tint} />
                            <Text style={{ color: tc.secondaryText }}>{t('sandbox.switching')}</Text>
                        </View>
                    ) : (
                        <View style={localStyles.actions}>
                            <TouchableOpacity
                                accessibilityRole="button"
                                onPress={() => run('reset')}
                                style={[localStyles.secondaryButton, { borderColor: tc.border }]}
                            >
                                <RotateCcw size={17} color={tc.tint} />
                                <Text style={[localStyles.secondaryButtonText, { color: tc.tint }]}>{t('sandbox.reset')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                accessibilityRole="button"
                                onPress={() => run('exit')}
                                style={[localStyles.primaryButton, { backgroundColor: tc.tint }]}
                            >
                                <X size={18} color={tc.onTint} />
                                <Text style={[localStyles.primaryButtonText, { color: tc.onTint }]}>{t('sandbox.exit')}</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
            </View>
        </SafeAreaView>
    );
}

const localStyles = StyleSheet.create({
    content: { padding: 16 },
    card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 10 },
    title: { fontSize: 18, fontWeight: '700' },
    description: { fontSize: 14, lineHeight: 20 },
    notice: { fontSize: 13, lineHeight: 18, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10 },
    failure: { fontSize: 13, lineHeight: 18 },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 4 },
    busy: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
    secondaryButton: { minHeight: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
    secondaryButtonText: { fontSize: 14, fontWeight: '700' },
    primaryButton: { minHeight: 44, borderRadius: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 7 },
    primaryButtonText: { fontSize: 14, fontWeight: '700' },
});
