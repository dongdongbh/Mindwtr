import React from 'react';
import { ActivityIndicator, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CompactText } from '@/components/compact-text';

import { DEFAULT_WHISPER_MODEL } from './settings.constants';
import { styles } from './settings.styles';

type SettingsTranslator = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
type SpeechProvider = 'openai' | 'gemini' | 'whisper';
type Translate = (key: string) => string;

type AiSettingsSpeechCardProps = {
    isExpoGo: boolean;
    isFossBuild: boolean;
    tr: SettingsTranslator;
    onDeleteWhisperModel: () => void;
    onDownloadWhisperModel: () => void;
    onOpenModelPicker: () => void;
    onSpeechApiKeyChange: (value: string) => void;
    onSpeechBaseUrlChange: (value: string) => void;
    onSpeechEnabledChange: (value: boolean) => void;
    onSpeechFieldStrategyChange: (value: 'smart' | 'title_only' | 'description_only') => void;
    onSpeechLanguageChange: (value: string) => void;
    onSpeechModeChange: (value: 'smart_parse' | 'transcribe_only') => void;
    onSpeechModelChange: (value: string) => void;
    onSpeechProviderChange: (provider: SpeechProvider) => void;
    onToggleOpen: () => void;
    speechApiKey: string;
    speechBaseUrl: string;
    speechEnabled: boolean;
    speechFieldStrategy: 'smart' | 'title_only' | 'description_only';
    speechLanguage: string;
    speechMode: 'smart_parse' | 'transcribe_only';
    speechModel: string;
    speechOpen: boolean;
    speechProvider: SpeechProvider;
    t: Translate;
    tc: ThemeColors;
    whisperDownloadError: string;
    whisperDownloadState: 'idle' | 'downloading' | 'success' | 'error';
    whisperDownloaded: boolean;
    whisperSizeLabel: string;
};

export function AiSettingsSpeechCard({
    isExpoGo,
    isFossBuild,
    tr,
    onDeleteWhisperModel,
    onDownloadWhisperModel,
    onOpenModelPicker,
    onSpeechApiKeyChange,
    onSpeechBaseUrlChange,
    onSpeechEnabledChange,
    onSpeechFieldStrategyChange,
    onSpeechLanguageChange,
    onSpeechModeChange,
    onSpeechModelChange,
    onSpeechProviderChange,
    onToggleOpen,
    speechApiKey,
    speechBaseUrl,
    speechEnabled,
    speechFieldStrategy,
    speechLanguage,
    speechMode,
    speechModel,
    speechOpen,
    speechProvider,
    t,
    tc,
    whisperDownloadError,
    whisperDownloadState,
    whisperDownloaded,
    whisperSizeLabel,
}: AiSettingsSpeechCardProps) {
    return (
        <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
            <TouchableOpacity style={styles.settingRow} onPress={onToggleOpen}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechTitle')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechDesc')}</Text>
                </View>
                <Text style={[styles.chevron, { color: tc.secondaryText }]}>{speechOpen ? '▾' : '▸'}</Text>
            </TouchableOpacity>

            {speechOpen && (
                <>
                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechEnable')}</Text>
                        </View>
                        <Switch
                            value={speechEnabled}
                            onValueChange={onSpeechEnabledChange}
                            trackColor={{ false: '#767577', true: '#3B82F6' }}
                        />
                    </View>
                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechProvider')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {speechProvider === 'openai'
                                    ? t('settings.aiProviderOpenAI')
                                    : speechProvider === 'gemini'
                                        ? t('settings.aiProviderGemini')
                                        : t('settings.speechProviderOffline')}
                            </Text>
                        </View>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                        <View style={styles.backendToggle}>
                            {!isFossBuild && (
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: speechProvider === 'openai' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => onSpeechProviderChange('openai')}
                                >
                                    <CompactText
                                        style={[styles.backendOptionText, { color: speechProvider === 'openai' ? tc.tint : tc.secondaryText }]}
                                        numberOfLines={2}
                                    >
                                        {t('settings.aiProviderOpenAI')}
                                    </CompactText>
                                </TouchableOpacity>
                            )}
                            {!isFossBuild && (
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: speechProvider === 'gemini' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => onSpeechProviderChange('gemini')}
                                >
                                    <CompactText
                                        style={[styles.backendOptionText, { color: speechProvider === 'gemini' ? tc.tint : tc.secondaryText }]}
                                        numberOfLines={2}
                                    >
                                        {t('settings.aiProviderGemini')}
                                    </CompactText>
                                </TouchableOpacity>
                            )}
                            <TouchableOpacity
                                style={[
                                    styles.backendOption,
                                    { borderColor: tc.border, backgroundColor: speechProvider === 'whisper' ? tc.filterBg : 'transparent' },
                                ]}
                                onPress={() => onSpeechProviderChange('whisper')}
                            >
                                <CompactText
                                    style={[styles.backendOptionText, { color: speechProvider === 'whisper' ? tc.tint : tc.secondaryText }]}
                                    numberOfLines={2}
                                >
                                    {isFossBuild ? tr('settings.aiMobile.localWhisper') : t('settings.speechProviderOffline')}
                                </CompactText>
                            </TouchableOpacity>
                        </View>
                    </View>

                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechModel')}</Text>
                        </View>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                        {speechProvider === 'openai' ? (
                            <View style={styles.modelInputRow}>
                                <TextInput
                                    value={speechModel}
                                    onChangeText={onSpeechModelChange}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    style={[styles.modelTextInput, { borderColor: tc.border, color: tc.text }]}
                                />
                                <TouchableOpacity
                                    style={[styles.modelSuggestButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                    onPress={onOpenModelPicker}
                                >
                                    <CompactText
                                        style={[styles.modelSuggestButtonText, { color: tc.secondaryText }]}
                                        numberOfLines={2}
                                    >
                                        {tr('settings.aiMobile.suggestions')}
                                    </CompactText>
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <TouchableOpacity
                                style={[styles.dropdownButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                onPress={onOpenModelPicker}
                            >
                                <CompactText
                                    style={[styles.dropdownValue, { color: tc.text }]}
                                    numberOfLines={2}
                                >
                                    {speechModel}
                                </CompactText>
                                <Text style={[styles.dropdownChevron, { color: tc.secondaryText }]}>▾</Text>
                            </TouchableOpacity>
                        )}
                    </View>

                    {speechProvider === 'whisper' ? (
                        <>
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechOfflineModel')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechOfflineModelDesc')}</Text>
                                    {isExpoGo ? (
                                        <Text style={[styles.settingDescription, { color: tc.danger, marginTop: 6 }]}>
                                            {tr('settings.aiMobile.whisperTranscriptionRequiresADevBuildOrProductionBuildNot')}
                                        </Text>
                                    ) : null}
                                </View>
                            </View>
                            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                    <View style={{ flex: 1 }}>
                                        <Text style={{ color: tc.secondaryText, fontSize: 12 }}>
                                            {whisperDownloaded ? t('settings.speechOfflineReady') : t('settings.speechOfflineNotDownloaded')}
                                            {whisperSizeLabel ? ` - ${whisperSizeLabel}` : ''}
                                        </Text>
                                        {whisperDownloadState === 'success' ? (
                                            <Text style={{ color: tc.tint, fontSize: 12, marginTop: 6 }}>
                                                {t('settings.speechOfflineDownloadSuccess')}
                                            </Text>
                                        ) : null}
                                        {whisperDownloadError ? (
                                            <Text style={{ color: tc.danger, fontSize: 12, marginTop: 6 }}>{whisperDownloadError}</Text>
                                        ) : null}
                                    </View>
                                    {whisperDownloadState === 'downloading' ? (
                                        <ActivityIndicator color={tc.tint} />
                                    ) : whisperDownloaded ? (
                                        <TouchableOpacity
                                            style={[styles.backendOption, { borderColor: tc.border }]}
                                            onPress={onDeleteWhisperModel}
                                        >
                                            <CompactText
                                                style={[styles.backendOptionText, { color: tc.text }]}
                                                numberOfLines={2}
                                            >
                                                {t('settings.speechOfflineDelete')}
                                            </CompactText>
                                        </TouchableOpacity>
                                    ) : (
                                        <TouchableOpacity
                                            style={[styles.backendOption, { borderColor: tc.border }]}
                                            onPress={onDownloadWhisperModel}
                                        >
                                            <CompactText
                                                style={[styles.backendOptionText, { color: tc.text }]}
                                                numberOfLines={2}
                                            >
                                                {t('settings.speechOfflineDownload')}
                                            </CompactText>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            </View>
                        </>
                    ) : (
                        <>
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiApiKey')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiApiKeyHint')}</Text>
                                </View>
                            </View>
                            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                <TextInput
                                    value={speechApiKey}
                                    onChangeText={onSpeechApiKeyChange}
                                    placeholder={t('settings.aiApiKeyPlaceholder')}
                                    placeholderTextColor={tc.secondaryText}
                                    autoCapitalize="none"
                                    secureTextEntry
                                    style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                                />
                            </View>
                            {speechProvider === 'openai' && (
                                <>
                                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechBaseUrl')}</Text>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechBaseUrlHint')}</Text>
                                        </View>
                                    </View>
                                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                        <TextInput
                                            value={speechBaseUrl}
                                            onChangeText={onSpeechBaseUrlChange}


                                            placeholder="http://localhost:8000/v1"
                                            placeholderTextColor={tc.secondaryText}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                            style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                                        />
                                    </View>
                                </>
                            )}
                        </>
                    )}

                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechLanguage')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechLanguageHint')}</Text>
                        </View>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                        <TextInput
                            value={speechLanguage === 'auto' ? '' : speechLanguage}
                            onChangeText={onSpeechLanguageChange}
                            placeholder={t('settings.speechLanguageAuto')}
                            placeholderTextColor={tc.secondaryText}
                            autoCapitalize="none"
                            style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                        />
                    </View>

                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechMode')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechModeHint')}</Text>
                        </View>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                        <View style={styles.backendToggle}>
                            <TouchableOpacity
                                style={[
                                    styles.backendOption,
                                    { borderColor: tc.border, backgroundColor: speechMode === 'smart_parse' ? tc.filterBg : 'transparent' },
                                ]}
                                onPress={() => onSpeechModeChange('smart_parse')}
                            >
                                <CompactText
                                    style={[styles.backendOptionText, { color: speechMode === 'smart_parse' ? tc.tint : tc.secondaryText }]}
                                    numberOfLines={2}
                                >
                                    {t('settings.speechModeSmart')}
                                </CompactText>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[
                                    styles.backendOption,
                                    { borderColor: tc.border, backgroundColor: speechMode === 'transcribe_only' ? tc.filterBg : 'transparent' },
                                ]}
                                onPress={() => onSpeechModeChange('transcribe_only')}
                            >
                                <CompactText
                                    style={[styles.backendOptionText, { color: speechMode === 'transcribe_only' ? tc.tint : tc.secondaryText }]}
                                    numberOfLines={2}
                                >
                                    {t('settings.speechModeTranscript')}
                                </CompactText>
                            </TouchableOpacity>
                        </View>
                    </View>

                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechFieldStrategy')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechFieldStrategyHint')}</Text>
                        </View>
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                        <View style={styles.backendToggle}>
                            {[
                                { value: 'smart', label: t('settings.speechFieldSmart') },
                                { value: 'title_only', label: t('settings.speechFieldTitle') },
                                { value: 'description_only', label: t('settings.speechFieldDescription') },
                            ].map((option) => (
                                <TouchableOpacity
                                    key={option.value}
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: speechFieldStrategy === option.value ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => onSpeechFieldStrategyChange(option.value as 'smart' | 'title_only' | 'description_only')}
                                >
                                    <CompactText
                                        style={[styles.backendOptionText, { color: speechFieldStrategy === option.value ? tc.tint : tc.secondaryText }]}
                                        numberOfLines={2}
                                    >
                                        {option.label}
                                    </CompactText>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                </>
            )}
        </View>
    );
}
