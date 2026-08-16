import React from 'react';
import { Text, TextInput, View } from 'react-native';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';

type Translate = (key: string) => string;

type AiSettingsAssistantOrcaRouterPanelProps = {
    aiApiKey: string;
    onAiApiKeyChange: (value: string) => void;
    t: Translate;
    tc: ThemeColors;
};

// OrcaRouter is a named OpenAI-compatible gateway provider, so unlike the OpenAI
// panel there is no base-URL or extra-body-params to configure — only the key.
export function AiSettingsAssistantOrcaRouterPanel({
    aiApiKey,
    onAiApiKeyChange,
    t,
    tc,
}: AiSettingsAssistantOrcaRouterPanelProps) {
    return (
        <>
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiApiKey')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiApiKeyHint')}</Text>
                </View>
            </View>
            <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                <TextInput
                    value={aiApiKey}
                    onChangeText={onAiApiKeyChange}
                    placeholder={t('settings.aiApiKeyPlaceholder')}
                    placeholderTextColor={tc.secondaryText}
                    autoCapitalize="none"
                    secureTextEntry
                    style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                />
            </View>
        </>
    );
}
