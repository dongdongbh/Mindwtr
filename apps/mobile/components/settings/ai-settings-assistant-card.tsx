import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { AI_REQUEST_TIMEOUT_OPTIONS, type AIProviderId, type AIReasoningEffort } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CompactText } from '@/components/compact-text';

import { AiSettingsAssistantAnthropicPanel } from './ai-settings-assistant-anthropic-panel';
import { AiSettingsAssistantGeminiPanel } from './ai-settings-assistant-gemini-panel';
import { AiSettingsAssistantOpenAiPanel } from './ai-settings-assistant-openai-panel';
import { styles } from './settings.styles';

type SettingsTranslator = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
type ModelPickerKind = null | 'model' | 'copilot' | 'speech';
type Translate = (key: string) => string;
type AIRequestTimeoutSeconds = (typeof AI_REQUEST_TIMEOUT_OPTIONS)[number];

type AiSettingsAssistantCardProps = {
    aiApiKey: string;
    aiAssistantOpen: boolean;
    aiBaseUrl: string;
    aiCopilotModel: string;
    aiCopilotOptions: string[];
    aiEnabled: boolean;
    aiExtraBodyParamsDraft: string;
    aiExtraBodyParamsError: string;
    aiModel: string;
    aiModelOptions: string[];
    aiProvider: AIProviderId;
    aiReasoningEffort: AIReasoningEffort;
    aiRequestTimeoutSeconds: number;
    aiThinkingBudget: number;
    anthropicThinkingEnabled: boolean;
    getAIProviderLabel: (provider: AIProviderId) => string;
    isFossBuild: boolean;
    tr: SettingsTranslator;
    onAiApiKeyChange: (value: string) => void;
    onAiBaseUrlChange: (value: string) => void;
    onAiCopilotModelChange: (value: string) => void;
    onAiEnabledChange: (value: boolean) => void;
    onAiExtraBodyParamsDraftChange: (value: string) => void;
    onAiExtraBodyParamsSave: () => void;
    onAiModelChange: (value: string) => void;
    onAiProviderChange: (provider: AIProviderId) => void;
    onAiReasoningEffortChange: (value: AIReasoningEffort) => void;
    onAiRequestTimeoutSecondsChange: (value: AIRequestTimeoutSeconds) => void;
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
    aiExtraBodyParamsDraft,
    aiExtraBodyParamsError,
    aiModel,
    aiModelOptions,
    aiProvider,
    aiReasoningEffort,
    aiRequestTimeoutSeconds,
    aiThinkingBudget,
    anthropicThinkingEnabled,
    getAIProviderLabel,
    isFossBuild,
    tr,
    onAiApiKeyChange,
    onAiBaseUrlChange,
    onAiCopilotModelChange,
    onAiEnabledChange,
    onAiExtraBodyParamsDraftChange,
    onAiExtraBodyParamsSave,
    onAiModelChange,
    onAiProviderChange,
    onAiReasoningEffortChange,
    onAiRequestTimeoutSecondsChange,
    onAiThinkingBudgetChange,
    onAnthropicThinkingEnabledChange,
    onModelPickerChange,
    onToggleOpen,
    t,
    tc,
}: AiSettingsAssistantCardProps) {
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [timeoutPickerOpen, setTimeoutPickerOpen] = useState(false);

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
                                {tr('settings.aiMobile.taskTextSentToProvider', { provider: getAIProviderLabel(aiProvider) })}
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
                                <CompactText
                                    style={[styles.backendOptionText, { color: aiProvider === 'openai' ? tc.tint : tc.secondaryText }]}
                                    numberOfLines={2}
                                >
                                    {getAIProviderLabel('openai')}
                                </CompactText>
                            </TouchableOpacity>
                            {!isFossBuild && (
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: aiProvider === 'gemini' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => onAiProviderChange('gemini')}
                                >
                                    <CompactText
                                        style={[styles.backendOptionText, { color: aiProvider === 'gemini' ? tc.tint : tc.secondaryText }]}
                                        numberOfLines={2}
                                    >
                                        {t('settings.aiProviderGemini')}
                                    </CompactText>
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
                                    <CompactText
                                        style={[styles.backendOptionText, { color: aiProvider === 'anthropic' ? tc.tint : tc.secondaryText }]}
                                        numberOfLines={2}
                                    >
                                        {t('settings.aiProviderAnthropic')}
                                    </CompactText>
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
                                <CompactText
                                    style={[styles.modelSuggestButtonText, { color: tc.secondaryText }]}
                                    numberOfLines={2}
                                >
                                    {tr('settings.aiMobile.suggestions')}
                                </CompactText>
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
                                <CompactText
                                    style={[styles.modelSuggestButtonText, { color: tc.secondaryText }]}
                                    numberOfLines={2}
                                >
                                    {tr('settings.aiMobile.suggestions')}
                                </CompactText>
                            </TouchableOpacity>
                        </View>
                    </View>

                    {aiProvider === 'openai' ? (
                        <AiSettingsAssistantOpenAiPanel
                            aiApiKey={aiApiKey}
                            aiBaseUrl={aiBaseUrl}
                            aiExtraBodyParamsDraft={aiExtraBodyParamsDraft}
                            aiExtraBodyParamsError={aiExtraBodyParamsError}
                            aiReasoningEffort={aiReasoningEffort}
                            isFossBuild={isFossBuild}
                            tr={tr}
                            onAiApiKeyChange={onAiApiKeyChange}
                            onAiBaseUrlChange={onAiBaseUrlChange}
                            onAiExtraBodyParamsDraftChange={onAiExtraBodyParamsDraftChange}
                            onAiExtraBodyParamsSave={onAiExtraBodyParamsSave}
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

                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => setAdvancedOpen((open) => !open)}
                        accessibilityRole="button"
                        accessibilityLabel={t('settings.aiAdvanced')}
                        accessibilityState={{ expanded: advancedOpen }}
                    >
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiAdvanced')}</Text>
                        </View>
                        <Text style={[styles.chevron, { color: tc.secondaryText }]}>{advancedOpen ? '▾' : '▸'}</Text>
                    </TouchableOpacity>

                    {advancedOpen && (
                        <>
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiRequestTimeout')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.aiRequestTimeoutDesc')}
                                    </Text>
                                </View>
                            </View>
                            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                <TouchableOpacity
                                    style={[styles.dropdownButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                    onPress={() => setTimeoutPickerOpen(true)}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('settings.aiRequestTimeout')}
                                >
                                    <Text style={[styles.dropdownValue, { color: tc.text }]}>
                                        {tr('settings.aiRequestTimeoutSeconds', { seconds: aiRequestTimeoutSeconds })}
                                    </Text>
                                    <Text style={[styles.dropdownChevron, { color: tc.secondaryText }]}>▾</Text>
                                </TouchableOpacity>
                            </View>

                            <Modal
                                transparent
                                visible={timeoutPickerOpen}
                                animationType="fade"
                                onRequestClose={() => setTimeoutPickerOpen(false)}
                            >
                                <Pressable style={styles.pickerOverlay} onPress={() => setTimeoutPickerOpen(false)}>
                                    <View
                                        style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                        onStartShouldSetResponder={() => true}
                                    >
                                        <Text style={[styles.pickerTitle, { color: tc.text }]}>
                                            {t('settings.aiRequestTimeout')}
                                        </Text>
                                        <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                            {AI_REQUEST_TIMEOUT_OPTIONS.map((seconds) => {
                                                const selected = aiRequestTimeoutSeconds === seconds;
                                                const label = tr('settings.aiRequestTimeoutSeconds', { seconds });
                                                return (
                                                    <TouchableOpacity
                                                        key={seconds}
                                                        style={[
                                                            styles.pickerOption,
                                                            {
                                                                borderColor: tc.border,
                                                                backgroundColor: selected ? tc.filterBg : 'transparent',
                                                            },
                                                        ]}
                                                        onPress={() => {
                                                            onAiRequestTimeoutSecondsChange(seconds);
                                                            setTimeoutPickerOpen(false);
                                                        }}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={label}
                                                        accessibilityState={{ selected }}
                                                    >
                                                        <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                            {label}
                                                        </Text>
                                                        {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                                    </TouchableOpacity>
                                                );
                                            })}
                                        </ScrollView>
                                    </View>
                                </Pressable>
                            </Modal>
                        </>
                    )}
                </>
            )}
        </View>
    );
}
