import React from 'react';
import { Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { DEFAULT_ANTHROPIC_THINKING_BUDGET } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';

type Translate = (key: string) => string;

type AiSettingsAssistantAnthropicPanelProps = {
    aiApiKey: string;
    aiThinkingBudget: number;
    anthropicThinkingEnabled: boolean;
    onAiApiKeyChange: (value: string) => void;
    onAiThinkingBudgetChange: (value: number) => void;
    onAnthropicThinkingEnabledChange: (value: boolean) => void;
    t: Translate;
    tc: ThemeColors;
};

export function AiSettingsAssistantAnthropicPanel({
    aiApiKey,
    aiThinkingBudget,
    anthropicThinkingEnabled,
    onAiApiKeyChange,
    onAiThinkingBudgetChange,
    onAnthropicThinkingEnabledChange,
    t,
    tc,
}: AiSettingsAssistantAnthropicPanelProps) {
    return (
        <>
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiThinkingEnable')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiThinkingEnableDesc')}</Text>
                </View>
                <Switch
                    value={anthropicThinkingEnabled}
                    onValueChange={onAnthropicThinkingEnabledChange}
                    trackColor={{ false: '#767577', true: '#3B82F6' }}
                />
            </View>
            {anthropicThinkingEnabled && (
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
                                { value: DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024, label: t('settings.aiThinkingLow') },
                                { value: 2048, label: t('settings.aiThinkingMedium') },
                                { value: 4096, label: t('settings.aiThinkingHigh') },
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
                </>
            )}
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
