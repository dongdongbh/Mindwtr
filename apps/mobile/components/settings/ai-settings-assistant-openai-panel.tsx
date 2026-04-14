import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { AIReasoningEffort } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';

type Localize = (english: string, chinese: string) => string;
type Translate = (key: string) => string;

type AiSettingsAssistantOpenAiPanelProps = {
    aiApiKey: string;
    aiBaseUrl: string;
    aiReasoningEffort: AIReasoningEffort;
    isFossBuild: boolean;
    localize: Localize;
    onAiApiKeyChange: (value: string) => void;
    onAiBaseUrlChange: (value: string) => void;
    onAiReasoningEffortChange: (value: AIReasoningEffort) => void;
    t: Translate;
    tc: ThemeColors;
};

export function AiSettingsAssistantOpenAiPanel({
    aiApiKey,
    aiBaseUrl,
    aiReasoningEffort,
    isFossBuild,
    localize,
    onAiApiKeyChange,
    onAiBaseUrlChange,
    onAiReasoningEffortChange,
    t,
    tc,
}: AiSettingsAssistantOpenAiPanelProps) {
    return (
        <>
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiReasoning')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                        {t(isFossBuild ? 'settings.aiReasoningHintFoss' : 'settings.aiReasoningHint')}
                    </Text>
                </View>
            </View>
            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                <View style={styles.backendToggle}>
                    {(['low', 'medium', 'high'] as AIReasoningEffort[]).map((effort) => (
                        <TouchableOpacity
                            key={effort}
                            style={[
                                styles.backendOption,
                                { borderColor: tc.border, backgroundColor: aiReasoningEffort === effort ? tc.filterBg : 'transparent' },
                            ]}
                            onPress={() => onAiReasoningEffortChange(effort)}
                        >
                            <Text style={[styles.backendOptionText, { color: aiReasoningEffort === effort ? tc.tint : tc.secondaryText }]}>
                                {effort === 'low'
                                    ? t('settings.aiEffortLow')
                                    : effort === 'medium'
                                        ? t('settings.aiEffortMedium')
                                        : t('settings.aiEffortHigh')}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </View>
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiBaseUrl')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiBaseUrlHint')}</Text>
                </View>
            </View>
            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                <TextInput
                    value={aiBaseUrl}
                    onChangeText={onAiBaseUrlChange}
                    placeholder={t('settings.aiBaseUrlPlaceholder')}
                    placeholderTextColor={tc.secondaryText}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                />
            </View>
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiApiKey')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiApiKeyHint')}</Text>
                    {isFossBuild && (
                        <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 6 }]}>
                            {localize(
                                'Use the API key for your local or self-hosted OpenAI-compatible server if it requires one.',
                                '如果你的本地或自托管 OpenAI 兼容服务需要 API Key，请在这里填写。'
                            )}
                        </Text>
                    )}
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
