import type { ReactNode } from 'react';
import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';

type Localize = (english: string, chinese: string) => string;
type Translate = (key: string) => string;

type SyncCloudKitBackendPanelProps = {
    helpText: string;
    isSyncEnabled: boolean;
    isSyncing: boolean;
    lastSyncCard: ReactNode;
    localize: Localize;
    onSync: () => void;
    statusLabel: string;
    t: Translate;
    tc: ThemeColors;
};

export function SyncCloudKitBackendPanel({
    helpText,
    isSyncEnabled,
    isSyncing,
    lastSyncCard,
    localize,
    onSync,
    statusLabel,
    t,
    tc,
}: SyncCloudKitBackendPanelProps) {
    return (
        <>
            <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border, marginTop: 12 }]}>
                <Text style={[styles.helpTitle, { color: tc.text }]}>iCloud Sync</Text>
                <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                    {helpText}
                </Text>
                <Text style={[styles.helpText, { color: tc.secondaryText, marginTop: 8 }]}>
                    {localize('Account status', '账户状态')}: {statusLabel}
                </Text>
            </View>

            <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                <TouchableOpacity
                    style={styles.settingRow}
                    onPress={onSync}
                    disabled={isSyncing || !isSyncEnabled}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: isSyncEnabled ? tc.tint : tc.secondaryText }]}>
                            {t('settings.syncNow')}
                        </Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {localize(
                                'Read and merge the latest CloudKit data now.',
                                '立即读取并合并最新的 CloudKit 数据。'
                            )}
                        </Text>
                    </View>
                    {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                </TouchableOpacity>
            </View>
            {lastSyncCard}
        </>
    );
}
