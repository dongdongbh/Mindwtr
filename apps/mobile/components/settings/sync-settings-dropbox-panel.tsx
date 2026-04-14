import type { ReactNode } from 'react';
import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';

type Translate = (key: string) => string;
type Localize = (english: string, chinese: string) => string;

type SyncDropboxBackendPanelProps = {
    dropboxBusy: boolean;
    dropboxConfigured: boolean;
    dropboxConnected: boolean;
    isExpoGo: boolean;
    isSyncing: boolean;
    isTestingConnection: boolean;
    lastSyncCard: ReactNode;
    localize: Localize;
    onConnectToggle: () => void;
    onSync: () => void;
    onTestConnection: () => void;
    redirectUri: string;
    t: Translate;
    tc: ThemeColors;
};

export function SyncDropboxBackendPanel({
    dropboxBusy,
    dropboxConfigured,
    dropboxConnected,
    isExpoGo,
    isSyncing,
    isTestingConnection,
    lastSyncCard,
    localize,
    onConnectToggle,
    onSync,
    onTestConnection,
    redirectUri,
    t,
    tc,
}: SyncDropboxBackendPanelProps) {
    return (
        <>
            <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                <View style={styles.settingRowColumn}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{localize('Dropbox account', 'Dropbox 账号')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 6 }]}>
                        {localize(
                            'OAuth with Dropbox App Folder access. Mindwtr syncs /Apps/Mindwtr/data.json and /Apps/Mindwtr/attachments/* in your Dropbox.',
                            '使用 Dropbox OAuth（应用文件夹权限）。Mindwtr 会同步 Dropbox 中 /Apps/Mindwtr/data.json 与 /Apps/Mindwtr/attachments/*。'
                        )}
                    </Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 6 }]}>
                        {localize('Redirect URI', '回调地址')}: {redirectUri}
                    </Text>
                    {!dropboxConfigured && (
                        <Text style={[styles.settingDescription, { color: '#EF4444', marginTop: 8 }]}>
                            {localize('Dropbox app key is not configured for this build.', '当前构建未配置 Dropbox App Key。')}
                        </Text>
                    )}
                    {isExpoGo && (
                        <Text style={[styles.settingDescription, { color: '#EF4444', marginTop: 8 }]}>
                            {localize('Expo Go is not supported for Dropbox OAuth. Use a development/release build.', 'Expo Go 不支持 Dropbox OAuth。请使用开发版或正式版应用。')}
                        </Text>
                    )}
                    <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                        {dropboxConnected ? localize('Status: Connected', '状态：已连接') : localize('Status: Not connected', '状态：未连接')}
                    </Text>
                </View>
                <TouchableOpacity
                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                    onPress={onConnectToggle}
                    disabled={dropboxBusy || !dropboxConfigured || isExpoGo}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: dropboxConfigured && !isExpoGo ? tc.tint : tc.secondaryText }]}>
                            {dropboxConnected ? localize('Disconnect Dropbox', '断开 Dropbox') : localize('Connect Dropbox', '连接 Dropbox')}
                        </Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {isExpoGo
                                ? localize('Requires development/release build (Expo Go unsupported).', '需要开发版/正式版应用（Expo Go 不支持）。')
                                : dropboxConnected
                                    ? localize('Revoke app token and remove local auth.', '撤销应用令牌并移除本地授权。')
                                    : localize('Open Dropbox OAuth sign-in in browser.', '在浏览器中打开 Dropbox OAuth 登录。')}
                        </Text>
                    </View>
                    {dropboxBusy && <ActivityIndicator size="small" color={tc.tint} />}
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                    onPress={onTestConnection}
                    disabled={isTestingConnection || !dropboxConfigured || !dropboxConnected}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: dropboxConnected ? tc.tint : tc.secondaryText }]}>
                            {t('settings.testConnection')}
                        </Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.dropboxTestHint')}</Text>
                    </View>
                    {isTestingConnection && <ActivityIndicator size="small" color={tc.tint} />}
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                    onPress={onSync}
                    disabled={isSyncing || !dropboxConfigured || !dropboxConnected}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: dropboxConnected ? tc.tint : tc.secondaryText }]}>
                            {t('settings.syncNow')}
                        </Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {localize('Read and merge Dropbox data.', '读取并合并 Dropbox 数据。')}
                        </Text>
                    </View>
                    {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                </TouchableOpacity>
            </View>
            {lastSyncCard}
        </>
    );
}
