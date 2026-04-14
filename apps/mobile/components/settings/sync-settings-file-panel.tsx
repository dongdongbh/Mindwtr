import type { ReactNode } from 'react';
import React from 'react';
import { ActivityIndicator, Platform, Text, TouchableOpacity, View } from 'react-native';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';

type Translate = (key: string) => string;
type Localize = (english: string, chinese: string) => string;

type SyncFileBackendPanelProps = {
    isSyncing: boolean;
    lastSyncCard: ReactNode;
    localize: Localize;
    onSelectFolder: () => void;
    onSync: () => void;
    syncPath: string | null;
    t: Translate;
    tc: ThemeColors;
};

export function SyncFileBackendPanel({
    isSyncing,
    lastSyncCard,
    localize,
    onSelectFolder,
    onSync,
    syncPath,
    t,
    tc,
}: SyncFileBackendPanelProps) {
    return (
        <>
            <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                <Text style={[styles.helpTitle, { color: tc.text }]}>{localize('How to Sync', '如何同步')}</Text>
                <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                    {Platform.OS === 'ios' ? t('settings.fileSyncHowToIos') : t('settings.fileSyncHowToAndroid')}
                </Text>
                <Text style={[styles.helpText, { color: tc.secondaryText, marginTop: 8 }]}>{t('settings.fileSyncTip')}</Text>
            </View>

            <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>{t('settings.syncSettings')}</Text>
            <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                <View style={styles.settingRow}>
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncFolderLocation')}</Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                            {syncPath ? syncPath.split('/').pop() : t('common.notSet')}
                        </Text>
                    </View>
                    <TouchableOpacity onPress={onSelectFolder}>
                        <Text style={styles.linkText}>{t('settings.selectFolder')}</Text>
                    </TouchableOpacity>
                </View>
                <TouchableOpacity
                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                    onPress={onSync}
                    disabled={isSyncing || !syncPath}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: syncPath ? '#3B82F6' : tc.secondaryText }]}>{t('settings.syncNow')}</Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.syncReadMergeFolder')}</Text>
                    </View>
                    {isSyncing && <ActivityIndicator size="small" color="#3B82F6" />}
                </TouchableOpacity>
                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                    <View style={styles.settingInfo}>{lastSyncCard}</View>
                </View>
            </View>
        </>
    );
}
