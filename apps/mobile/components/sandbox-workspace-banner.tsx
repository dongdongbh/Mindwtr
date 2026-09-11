import React from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { RotateCcw } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isSandboxMode } from '@mindwtr/core';

import { useLanguage } from '@/contexts/language-context';
import {
    getWorkspaceSwitching,
    reloadIntoMobileSandbox,
    reloadIntoPersonalWorkspace,
    subscribeWorkspaceSwitching,
} from '@/lib/sandbox-workspace';

export function MobileWorkspaceSwitchOverlay() {
    const { t } = useLanguage();
    const switching = React.useSyncExternalStore(
        subscribeWorkspaceSwitching,
        getWorkspaceSwitching,
        getWorkspaceSwitching,
    );
    return (
        <Modal visible={switching} transparent statusBarTranslucent animationType="fade">
            <View style={styles.overlay} accessibilityViewIsModal accessibilityRole="progressbar">
                <View style={styles.overlayCard}>
                    <ActivityIndicator size="small" color="#713F12" />
                    {isSandboxMode() ? <Text style={styles.cueText}>{t('sandbox.title')}</Text> : null}
                    <Text style={styles.switchingText}>{t('sandbox.switching')}</Text>
                </View>
            </View>
        </Modal>
    );
}

export function SandboxWorkspaceBanner() {
    const { t } = useLanguage();
    const insets = useSafeAreaInsets();
    const [busy, setBusy] = React.useState<'reset' | 'exit' | null>(null);
    const [error, setError] = React.useState(false);

    if (!isSandboxMode()) return null;

    const run = (action: 'reset' | 'exit') => {
        if (busy) return;
        setBusy(action);
        setError(false);
        const operation = action === 'reset' ? reloadIntoMobileSandbox() : reloadIntoPersonalWorkspace();
        void operation.catch(() => {
            setBusy(null);
            setError(true);
        });
    };

    return (
        <View
            style={[styles.banner, { paddingTop: insets.top, marginBottom: -insets.top }]}
            accessibilityRole="summary"
            testID="sandbox-workspace-banner"
        >
            <View style={styles.content} testID="sandbox-workspace-banner-content">
                <Text style={styles.label} numberOfLines={2}>{t('sandbox.label')}</Text>
                {busy ? (
                    <View style={styles.switching}>
                        <ActivityIndicator size="small" color="#713F12" />
                        <Text style={styles.switchingText} numberOfLines={2}>{t('sandbox.switching')}</Text>
                    </View>
                ) : (
                    <View style={styles.actions}>
                        <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel={t('sandbox.reset')}
                            onPress={() => run('reset')}
                            style={styles.button}
                            testID="sandbox-reset-button"
                        >
                            <RotateCcw size={16} color="#713F12" />
                            <Text style={styles.buttonText} numberOfLines={2}>{t('sandbox.resetShort')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel={t('sandbox.exit')}
                            onPress={() => run('exit')}
                            style={styles.button}
                            testID="sandbox-exit-button"
                        >
                            <Text style={styles.buttonText} numberOfLines={2}>{t('sandbox.exitShort')}</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>
            {error ? <Text style={styles.error} numberOfLines={2}>{t('sandbox.switchFailed')}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    cueText: {
        color: '#713F12',
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '700',
        textAlign: 'center',
    },
    overlay: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backgroundColor: 'rgba(15, 23, 42, 0.42)',
    },
    overlayCard: {
        minWidth: 210,
        paddingHorizontal: 20,
        paddingVertical: 18,
        borderRadius: 14,
        alignItems: 'center',
        gap: 8,
        backgroundColor: '#FEF3C7',
    },
    banner: {
        paddingHorizontal: 8,
        paddingBottom: 2,
        backgroundColor: '#FEF3C7',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#D97706',
        zIndex: 100,
    },
    content: {
        width: '100%',
        minHeight: 44,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        columnGap: 4,
    },
    label: {
        color: '#713F12',
        fontSize: 13,
        lineHeight: 18,
        fontWeight: '700',
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 72,
    },
    error: {
        color: '#991B1B',
        fontSize: 11,
        lineHeight: 14,
        textAlign: 'center',
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 1,
        columnGap: 2,
    },
    button: {
        minWidth: 44,
        minHeight: 44,
        paddingHorizontal: 8,
        borderRadius: 8,
        flexDirection: 'row',
        flexShrink: 1,
        alignItems: 'center',
        gap: 4,
    },
    buttonText: {
        color: '#713F12',
        fontSize: 12,
        fontWeight: '700',
        flexShrink: 1,
    },
    switching: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    switchingText: {
        color: '#713F12',
        fontSize: 12,
        fontWeight: '600',
    },
});
