import React from 'react';
import { Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { AIProviderId, AIReasoningEffort } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { AiSettingsAssistantAnthropicPanel } from './ai-settings-assistant-anthropic-panel';
import { AiSettingsAssistantGeminiPanel } from './ai-settings-assistant-gemini-panel';
import { AiSettingsAssistantOpenAiPanel } from './ai-settings-assistant-openai-panel';
import { styles } from './settings.styles';

type Localize = (english: string, chinese: string) => string;
type ModelPickerKind = null | 'model' | 'copilot' | 'speech';
type Translate = (key: string) => string;

type AiSettingsAssistantCardProps = {
    aiApiKey: string;
    aiAssistantOpen: boolean;
    aiBaseUrl: string;
    aiCopilotModel: string;
    aiCopilotOptions: string[];
    aiEnabled: boolean;
    aiModel: string;
    aiModelOptions: string[];
    aiProvider: AIProviderId;
    aiReasoningEffort: AIReasoningEffort;
    aiThinkingBudget: number;
    anthropicThinkingEnabled: boolean;
    getAIProviderLabel: (provider: AIProviderId) => string;
    isFossBuild: boolean;
    localize: Localize;
    onAiApiKeyChange: (value: string) => void;
    onAiBaseUrlChange: (value: string) => void;
    onAiCopilotModelChange: (value: string) => void;
    onAiEnabledChange: (value: boolean) => void;
    onAiModelChange: (value: string) => void;
    onAiProviderChange: (provider: AIProviderId) => void;
    onAiReasoningEffortChange: (value: AIReasoningEffort) => void;
    onAiThinkingBudgetChange: (value: number) => void;
    onAnthropicThinkingEnabledChange: (value: boolean) => void;
    onModelPickerChange: (value: ModelPickerKind) => void;
    onToggleOpen: () => void;
    t: Translate;
    tc: ThemeColors;
};

export function AiSettingsAssistantCard({
    aiApiKey,
    aiAssistantOpen,
    aiBaseUrl,
    aiCopilotModel,
    aiCopilotOptions,
    aiEnabled,
    aiModel,
    aiModelOptions,
    aiProvider,
    aiReasoningEffort,
    aiThinkingBudget,
    anthropicThinkingEnabled,
    getAIProviderLabel,
    isFossBuild,
    localize,
    onAiApiKeyChange,
    onAiBaseUrlChange,
    onAiCopilotModelChange,
    onAiEnabledChange,
    onAiModelChange,
    onAiProviderChange,
    onAiReasoningEffortChange,
    onAiThinkingBudgetChange,
    onAnthropicThinkingEnabledChange,
    onModelPickerChange,
    onToggleOpen,
    t,
    tc,
}: AiSettingsAssistantCardProps) {
    return (
        <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
            <TouchableOpacity style={styles.settingRow} onPress={onToggleOpen}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.ai')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiDesc')}</Text>
                </View>
                <Text style={[styles.chevron, { color: tc.secondaryText }]}>{aiAssistantOpen ? '▾' : '▸'}</Text>
            </TouchableOpacity>

            {aiAssistantOpen && (
                <>
                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiEnable')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {localize(
                                    `When enabled, task text is sent directly to ${getAIProviderLabel(aiProvider)} using your API key.`,
                                    `启用后，任务文本将通过你的 API Key 直接发送到 ${getAIProviderLabel(aiProvider)}。`
                                )}
                            </Text>
                        </View>
                        <Switch
                            value={aiEnabled}
                            onValueChange={onAiEnabledChange}
                            trackColor={{ false: '#767577', true: '#3B82F6' }}
                        />
                    </View>

                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiProvider')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{getAIProviderLabel(aiProvider)}</Text>
                        </View>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                        <View style={styles.backendToggle}>
                            <TouchableOpacity
                                style={[
                                    styles.backendOption,
                                    { borderColor: tc.border, backgroundColor: aiProvider === 'openai' ? tc.filterBg : 'transparent' },
                                ]}
                                onPress={() => onAiProviderChange('openai')}
                            >
                                <Text style={[styles.backendOptionText, { color: aiProvider === 'openai' ? tc.tint : tc.secondaryText }]}>
                                    {getAIProviderLabel('openai')}
                                </Text>
                            </TouchableOpacity>
                            {!isFossBuild && (
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: aiProvider === 'gemini' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => onAiProviderChange('gemini')}
                                >
                                    <Text style={[styles.backendOptionText, { color: aiProvider === 'gemini' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.aiProviderGemini')}
                                    </Text>
                                </TouchableOpacity>
                            )}
                            {!isFossBuild && (
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: aiProvider === 'anthropic' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => onAiProviderChange('anthropic')}
                                >
                                    <Text style={[styles.backendOptionText, { color: aiProvider === 'anthropic' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.aiProviderAnthropic')}
                                    </Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>

                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiModel')}</Text>
                        </View>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                        <View style={styles.modelInputRow}>
                            <TextInput
                                value={aiModel}
                                onChangeText={onAiModelChange}
                                placeholder={aiModelOptions[0]}
                                placeholderTextColor={tc.secondaryText}
                                autoCapitalize="none"
                                autoCorrect={false}
                                style={[styles.modelTextInput, { borderColor: tc.border, color: tc.text }]}
                            />
                            <TouchableOpacity
                                style={[styles.modelSuggestButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                onPress={() => onModelPickerChange('model')}
                            >
                                <Text style={[styles.modelSuggestButtonText, { color: tc.secondaryText }]}>
                                    {localize('Suggestions', '建议')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    </View>

                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiCopilotModel')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiCopilotHint')}</Text>
                        </View>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                        <View style={styles.modelInputRow}>
                            <TextInput
                                value={aiCopilotModel}
                                onChangeText={onAiCopilotModelChange}
                                placeholder={aiCopilotOptions[0]}
                                placeholderTextColor={tc.secondaryText}
                                autoCapitalize="none"
                                autoCorrect={false}
                                style={[styles.modelTextInput, { borderColor: tc.border, color: tc.text }]}
                            />
                            <TouchableOpacity
                                style={[styles.modelSuggestButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                onPress={() => onModelPickerChange('copilot')}
                            >
                                <Text style={[styles.modelSuggestButtonText, { color: tc.secondaryText }]}>
                                    {localize('Suggestions', '建议')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    </View>

                    {aiProvider === 'openai' ? (
                        <AiSettingsAssistantOpenAiPanel
                            aiApiKey={aiApiKey}
                            aiBaseUrl={aiBaseUrl}
                            aiReasoningEffort={aiReasoningEffort}
                            isFossBuild={isFossBuild}
                            localize={localize}
                            onAiApiKeyChange={onAiApiKeyChange}
                            onAiBaseUrlChange={onAiBaseUrlChange}
                            onAiReasoningEffortChange={onAiReasoningEffortChange}
                            t={t}
                            tc={tc}
                        />
                    ) : aiProvider === 'gemini' ? (
                        <AiSettingsAssistantGeminiPanel
                            aiApiKey={aiApiKey}
                            aiThinkingBudget={aiThinkingBudget}
                            onAiApiKeyChange={onAiApiKeyChange}
                            onAiThinkingBudgetChange={onAiThinkingBudgetChange}
                            t={t}
                            tc={tc}
                        />
                    ) : (
                        <AiSettingsAssistantAnthropicPanel
                            aiApiKey={aiApiKey}
                            aiThinkingBudget={aiThinkingBudget}
                            anthropicThinkingEnabled={anthropicThinkingEnabled}
                            onAiApiKeyChange={onAiApiKeyChange}
                            onAiThinkingBudgetChange={onAiThinkingBudgetChange}
                            onAnthropicThinkingEnabledChange={onAnthropicThinkingEnabledChange}
                            t={t}
                            tc={tc}
                        />
                    )}
                </>
            )}
        </View>
    );
}
