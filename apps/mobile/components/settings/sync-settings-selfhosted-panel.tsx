import type { ReactNode } from 'react';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { isValidHttpUrl } from './settings.constants';
import { styles } from './settings.styles';

type Translate = (key: string) => string;

export type SelfHostedSyncSettings = {
    token: string;
    url: string;
};

type SyncSelfHostedBackendPanelProps = {
    initialToken: string;
    initialUrl: string;
    isSyncing: boolean;
    isTestingConnection: boolean;
    lastSyncCard: ReactNode;
    onSave: (settings: SelfHostedSyncSettings) => void;
    onSync: (settings: SelfHostedSyncSettings) => void;
    onTestConnection: (settings: SelfHostedSyncSettings) => void;
    t: Translate;
    tc: ThemeColors;
};

export function SyncSelfHostedBackendPanel({
    initialToken,
    initialUrl,
    isSyncing,
    isTestingConnection,
    lastSyncCard,
    onSave,
    onSync,
    onTestConnection,
    t,
    tc,
}: SyncSelfHostedBackendPanelProps) {
    const [token, setToken] = useState(initialToken);
    const [url, setUrl] = useState(initialUrl);

    useEffect(() => {
        setUrl(initialUrl);
    }, [initialUrl]);

    useEffect(() => {
        setToken(initialToken);
    }, [initialToken]);

    const urlError = url.trim() ? !isValidHttpUrl(url.trim()) : false;
    const settings = { token, url };
    const canUseActions = url.trim().length > 0 && !urlError;

    return (
        <>
            <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                <View style={styles.inputGroup}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.cloudUrl')}</Text>
                    <TextInput
                        value={url}
                        onChangeText={setUrl}
                        placeholder={t('settings.cloudUrlPlaceholder')}
                        placeholderTextColor={tc.secondaryText}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                    />
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.cloudHint')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.cloudBaseUrlHint')}</Text>
                    {urlError && (
                        <Text style={[styles.settingDescription, { color: '#EF4444' }]}>{t('settings.invalidUrlHttp')}</Text>
                    )}
                </View>
                <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.cloudToken')}</Text>
                    <TextInput
                        value={token}
                        onChangeText={setToken}
                        placeholder="••••••••"
                        placeholderTextColor={tc.secondaryText}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                    />
                </View>
                <TouchableOpacity
                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                    onPress={() => onSave(settings)}
                    disabled={!canUseActions}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: canUseActions ? tc.tint : tc.secondaryText }]}>
                            {t('settings.cloudSave')}
                        </Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.cloudUrl')}</Text>
                    </View>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                    onPress={() => onSync(settings)}
                    disabled={isSyncing || !canUseActions}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: canUseActions ? tc.tint : tc.secondaryText }]}>
                            {t('settings.syncNow')}
                        </Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.syncReadMergeSelfHosted')}</Text>
                    </View>
                    {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                    onPress={() => onTestConnection(settings)}
                    disabled={isSyncing || isTestingConnection || !canUseActions}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: canUseActions ? tc.tint : tc.secondaryText }]}>
                            {t('settings.testConnection')}
                        </Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.cloudTestHint')}</Text>
                    </View>
                    {isTestingConnection && <ActivityIndicator size="small" color={tc.tint} />}
                </TouchableOpacity>
            </View>
            {lastSyncCard}
        </>
    );
}
