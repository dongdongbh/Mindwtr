import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';

type Translate = (key: string) => string;

type AiSettingsAssistantGeminiPanelProps = {
    aiApiKey: string;
    aiThinkingBudget: number;
    onAiApiKeyChange: (value: string) => void;
    onAiThinkingBudgetChange: (value: number) => void;
    t: Translate;
    tc: ThemeColors;
};

export function AiSettingsAssistantGeminiPanel({
    aiApiKey,
    aiThinkingBudget,
    onAiApiKeyChange,
    onAiThinkingBudgetChange,
    t,
    tc,
}: AiSettingsAssistantGeminiPanelProps) {
    return (
        <>
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiThinkingBudget')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiThinkingHint')}</Text>
                </View>
            </View>
            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                <View style={styles.backendToggle}>
                    {[
                        { value: 0, label: t('settings.aiThinkingOff') },
                        { value: 128, label: t('settings.aiThinkingLow') },
                        { value: 256, label: t('settings.aiThinkingMedium') },
                        { value: 512, label: t('settings.aiThinkingHigh') },
                    ].map((option) => (
                        <TouchableOpacity
                            key={option.value}
                            style={[
                                styles.backendOption,
                                { borderColor: tc.border, backgroundColor: aiThinkingBudget === option.value ? tc.filterBg : 'transparent' },
                            ]}
                            onPress={() => onAiThinkingBudgetChange(option.value)}
                        >
                            <Text style={[styles.backendOptionText, { color: aiThinkingBudget === option.value ? tc.tint : tc.secondaryText }]}>
                                {option.label}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </View>
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
