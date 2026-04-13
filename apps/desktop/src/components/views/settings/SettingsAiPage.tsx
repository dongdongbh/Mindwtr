import type { AIProviderId, AIReasoningEffort, AppData } from '@mindwtr/core';

import { useState } from 'react';
import { cn } from '../../../lib/utils';
import { ConfirmModal } from '../../ConfirmModal';

type Labels = {
    aiEnable: string;
    aiDesc: string;
    aiProvider: string;
    aiProviderOpenAI: string;
    aiProviderGemini: string;
    aiProviderAnthropic: string;
    aiModel: string;
    aiBaseUrl: string;
    aiBaseUrlHint: string;
    aiBaseUrlModelHint: string;
    aiCopilotModel: string;
    aiCopilotHint: string;
    aiConsentTitle: string;
    aiConsentDescription: string;
    aiConsentCancel: string;
    aiConsentAgree: string;
    aiReasoning: string;
    aiReasoningHint: string;
    aiEffortLow: string;
    aiEffortMedium: string;
    aiEffortHigh: string;
    aiThinkingEnable: string;
    aiThinkingEnableDesc: string;
    aiThinkingBudget: string;
    aiThinkingHint: string;
    aiThinkingOff: string;
    aiThinkingLow: string;
    aiThinkingMedium: string;
    aiThinkingHigh: string;
    aiApiKey: string;
    aiApiKeyHint: string;
    speechTitle: string;
    speechDesc: string;
    speechEnable: string;
    speechProvider: string;
    speechProviderOffline: string;
    speechModel: string;
    speechOfflineModel: string;
    speechOfflineModelDesc: string;
    speechOfflineReady: string;
    speechOfflineNotDownloaded: string;
    speechOfflineDownload: string;
    speechOfflineDownloadSuccess: string;
    speechOfflineDelete: string;
    speechOfflineDownloadError: string;
    speechLanguage: string;
    speechLanguageHint: string;
    speechLanguageAuto: string;
    speechMode: string;
    speechModeHint: string;
    speechModeSmart: string;
    speechModeTranscript: string;
    speechFieldStrategy: string;
    speechFieldStrategyHint: string;
    speechFieldSmart: string;
    speechFieldTitle: string;
    speechFieldDescription: string;
};

const looksLikeOfficialOpenAIModel = (model: string, knownModels: string[]): boolean => {
    const trimmed = model.trim();
    if (!trimmed) return true;
    const lower = trimmed.toLowerCase();
    if (knownModels.some((option) => option.toLowerCase() === lower)) return true;
    return lower.startsWith('gpt-')
        || lower.startsWith('chatgpt-')
        || /^o[134](?:$|-)/.test(lower)
        || lower.startsWith('omni-moderation-')
        || lower.startsWith('text-embedding-')
        || lower.startsWith('text-moderation-')
        || lower.startsWith('tts-')
        || lower.startsWith('whisper-');
};

type ThinkingOption = { value: number; label: string };

type SettingsAiPageProps = {
    t: Labels;
    aiEnabled: boolean;
    aiProvider: AIProviderId;
    aiModel: string;
    aiModelOptions: string[];
    aiBaseUrl: string;
    aiCopilotModel: string;
    aiCopilotOptions: string[];
    aiReasoningEffort: AIReasoningEffort;
    aiThinkingBudget: number;
    anthropicThinkingEnabled: boolean;
    anthropicThinkingOptions: ThinkingOption[];
    aiApiKey: string;
    speechEnabled: boolean;
    speechProvider: 'openai' | 'gemini' | 'whisper';
    speechModel: string;
    speechModelOptions: string[];
    speechLanguage: string;
    speechMode: 'smart_parse' | 'transcribe_only';
    speechFieldStrategy: 'smart' | 'title_only' | 'description_only';
    speechApiKey: string;
    speechOfflineReady: boolean;
    speechOfflineSize: number | null;
    speechDownloadState: 'idle' | 'downloading' | 'success' | 'error';
    speechDownloadError: string | null;
    onUpdateAISettings: (next: Partial<NonNullable<AppData['settings']['ai']>>) => void;
    onUpdateSpeechSettings: (next: Partial<NonNullable<NonNullable<AppData['settings']['ai']>['speechToText']>>) => void;
    onProviderChange: (provider: AIProviderId) => void;
    onSpeechProviderChange: (provider: 'openai' | 'gemini' | 'whisper') => void;
    onToggleAnthropicThinking: () => void;
    onAiApiKeyChange: (value: string) => void;
    onSpeechApiKeyChange: (value: string) => void;
    onDownloadWhisperModel: () => void;
    onDeleteWhisperModel: () => void;
};

export function SettingsAiPage({
    t,
    aiEnabled,
    aiProvider,
    aiModel,
    aiModelOptions,
    aiBaseUrl,
    aiCopilotModel,
    aiCopilotOptions,
    aiReasoningEffort,
    aiThinkingBudget,
    anthropicThinkingEnabled,
    anthropicThinkingOptions,
    aiApiKey,
    speechEnabled,
    speechProvider,
    speechModel,
    speechModelOptions,
    speechLanguage,
    speechMode,
    speechFieldStrategy,
    speechApiKey,
    speechOfflineReady,
    speechOfflineSize,
    speechDownloadState,
    speechDownloadError,
    onUpdateAISettings,
    onUpdateSpeechSettings,
    onProviderChange,
    onSpeechProviderChange,
    onToggleAnthropicThinking,
    onAiApiKeyChange,
    onSpeechApiKeyChange,
    onDownloadWhisperModel,
    onDeleteWhisperModel,
}: SettingsAiPageProps) {
    const [aiOpen, setAiOpen] = useState(false);
    const [speechOpen, setSpeechOpen] = useState(false);
    const [showAiConsentModal, setShowAiConsentModal] = useState(false);
    const selectedProviderLabel = aiProvider === 'gemini'
        ? t.aiProviderGemini
        : aiProvider === 'anthropic'
            ? t.aiProviderAnthropic
            : t.aiProviderOpenAI;
    const aiConsentDescription = t.aiConsentDescription.replace('{provider}', selectedProviderLabel);
    const showCustomBaseUrlModelHint = aiProvider === 'openai'
        && !aiBaseUrl.trim()
        && !looksLikeOfficialOpenAIModel(aiModel, aiModelOptions);
    const handleAiToggle = () => {
        if (aiEnabled) {
            onUpdateAISettings({ enabled: false });
            return;
        }
        setShowAiConsentModal(true);
    };

    return (
        <>
            <div className="space-y-6">
                <div className="bg-card border border-border rounded-lg">
                <div className="p-4 flex items-center justify-between gap-4">
                    <button
                        type="button"
                        onClick={() => setAiOpen((prev) => !prev)}
                        aria-expanded={aiOpen}
                        className="flex-1 text-left flex items-center justify-between gap-4"
                    >
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.aiEnable}</div>
                            <div className="text-xs text-muted-foreground mt-1">{t.aiDesc}</div>
                        </div>
                        <span className="text-xs text-muted-foreground">{aiOpen ? '▾' : '▸'}</span>
                    </button>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={aiEnabled}
                        onClick={handleAiToggle}
                        className={cn(
                            "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors",
                            aiEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                        )}
                    >
                        <span
                            className={cn(
                                "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                                aiEnabled ? "translate-x-4" : "translate-x-1"
                            )}
                        />
                    </button>
                </div>

                {aiOpen && (
                    <>
                        <div className="border-t border-border p-4 space-y-3">
                            <div className="flex items-center justify-between gap-4">
                                <div className="text-sm font-medium">{t.aiProvider}</div>
                                <select
                                    value={aiProvider}
                                    onChange={(e) => onProviderChange(e.target.value as AIProviderId)}
                                    className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                                >
                                    <option value="openai">{t.aiProviderOpenAI}</option>
                                    <option value="gemini">{t.aiProviderGemini}</option>
                                    <option value="anthropic">{t.aiProviderAnthropic}</option>
                                </select>
                            </div>

                            <div className="flex items-center justify-between gap-4">
                                <div className="text-sm font-medium">{t.aiModel}</div>
                                <input
                                    type="text"
                                    value={aiModel}
                                    onChange={(e) => onUpdateAISettings({ model: e.target.value })}
                                    list="ai-model-options"
                                    className="min-w-[200px] text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                >
                                </input>
                                <datalist id="ai-model-options">
                                    {aiModelOptions.map((option) => (
                                        <option key={option} value={option} />
                                    ))}
                                </datalist>
                            </div>

                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <div className="text-sm font-medium">{t.aiCopilotModel}</div>
                                    <div className="text-xs text-muted-foreground">{t.aiCopilotHint}</div>
                                </div>
                                <input
                                    type="text"
                                    value={aiCopilotModel}
                                    onChange={(e) => onUpdateAISettings({ copilotModel: e.target.value })}
                                    list="ai-copilot-model-options"
                                    className="min-w-[200px] text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                >
                                </input>
                                <datalist id="ai-copilot-model-options">
                                    {aiCopilotOptions.map((option) => (
                                        <option key={option} value={option} />
                                    ))}
                                </datalist>
                            </div>

                            {aiProvider === 'openai' && (
                                <div className="flex items-center justify-between gap-4">
                                    <div>
                                        <div className="text-sm font-medium">{t.aiReasoning}</div>
                                        <div className="text-xs text-muted-foreground">{t.aiReasoningHint}</div>
                                    </div>
                                    <select
                                        value={aiReasoningEffort}
                                        onChange={(e) => onUpdateAISettings({ reasoningEffort: e.target.value as AIReasoningEffort })}
                                        className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    >
                                        <option value="low">{t.aiEffortLow}</option>
                                        <option value="medium">{t.aiEffortMedium}</option>
                                        <option value="high">{t.aiEffortHigh}</option>
                                    </select>
                                </div>
                            )}

                            {aiProvider === 'openai' && (
                                <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                                    <div className="text-sm font-medium">{t.aiBaseUrl}</div>
                                    <input
                                        type="text"
                                        value={aiBaseUrl}
                                        onChange={(e) => onUpdateAISettings({ baseUrl: e.target.value })}
                                        placeholder="http://localhost:11434/v1"
                                        className="w-full text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                        autoCapitalize="off"
                                        autoCorrect="off"
                                        spellCheck={false}
                                    />
                                    <div className="text-xs text-muted-foreground">{t.aiBaseUrlHint}</div>
                                    {showCustomBaseUrlModelHint && (
                                        <div className="text-xs text-amber-600">{t.aiBaseUrlModelHint}</div>
                                    )}
                                </div>
                            )}

                            {aiProvider === 'anthropic' && (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between gap-4">
                                        <div>
                                            <div className="text-sm font-medium">{t.aiThinkingEnable}</div>
                                            <div className="text-xs text-muted-foreground">{t.aiThinkingEnableDesc}</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={anthropicThinkingEnabled}
                                            onClick={onToggleAnthropicThinking}
                                            className={cn(
                                                "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors",
                                                anthropicThinkingEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                                            )}
                                        >
                                            <span
                                                className={cn(
                                                    "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                                                    anthropicThinkingEnabled ? "translate-x-4" : "translate-x-1"
                                                )}
                                            />
                                        </button>
                                    </div>
                                    {anthropicThinkingEnabled && (
                                        <div className="flex items-center justify-between gap-4">
                                            <div>
                                                <div className="text-sm font-medium">{t.aiThinkingBudget}</div>
                                                <div className="text-xs text-muted-foreground">{t.aiThinkingHint}</div>
                                            </div>
                                            <select
                                                value={String(aiThinkingBudget)}
                                                onChange={(e) => onUpdateAISettings({ thinkingBudget: Number(e.target.value) })}
                                                className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                                            >
                                                {anthropicThinkingOptions.map((option) => (
                                                    <option key={option.value} value={String(option.value)}>
                                                        {option.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                </div>
                            )}

                            {aiProvider === 'gemini' && (
                                <div className="flex items-center justify-between gap-4">
                                    <div>
                                        <div className="text-sm font-medium">{t.aiThinkingBudget}</div>
                                        <div className="text-xs text-muted-foreground">{t.aiThinkingHint}</div>
                                    </div>
                                    <select
                                        value={String(aiThinkingBudget)}
                                        onChange={(e) => onUpdateAISettings({ thinkingBudget: Number(e.target.value) })}
                                        className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    >
                                        <option value="0">{t.aiThinkingOff}</option>
                                        <option value="128">{t.aiThinkingLow}</option>
                                        <option value="256">{t.aiThinkingMedium}</option>
                                        <option value="512">{t.aiThinkingHigh}</option>
                                    </select>
                                </div>
                            )}
                        </div>

                        <div className="border-t border-border p-4 space-y-2">
                            <div className="text-sm font-medium">{t.aiApiKey}</div>
                            <input
                                type="password"
                                value={aiApiKey}
                                onChange={(e) => onAiApiKeyChange(e.target.value)}
                                placeholder={t.aiApiKey}
                                className="w-full text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                            />
                            <div className="text-xs text-muted-foreground">{t.aiApiKeyHint}</div>
                        </div>
                    </>
                )}
            </div>

            <div className="bg-card border border-border rounded-lg">
                <div className="p-4 flex items-center justify-between gap-4">
                    <button
                        type="button"
                        onClick={() => setSpeechOpen((prev) => !prev)}
                        aria-expanded={speechOpen}
                        className="flex-1 text-left flex items-center justify-between gap-4"
                    >
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.speechTitle}</div>
                            <div className="text-xs text-muted-foreground mt-1">{t.speechDesc}</div>
                        </div>
                        <span className="text-xs text-muted-foreground">{speechOpen ? '▾' : '▸'}</span>
                    </button>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={speechEnabled}
                        onClick={() => onUpdateSpeechSettings({ enabled: !speechEnabled })}
                        className={cn(
                            "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors",
                            speechEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                        )}
                    >
                        <span
                            className={cn(
                                "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                                speechEnabled ? "translate-x-4" : "translate-x-1"
                            )}
                        />
                    </button>
                </div>

                {speechOpen && (
                    <div className="border-t border-border p-4 space-y-3">
                        <div className="flex items-center justify-between gap-4">
                            <div className="text-sm font-medium">{t.speechProvider}</div>
                            <select
                                value={speechProvider}
                                onChange={(e) => onSpeechProviderChange(e.target.value as 'openai' | 'gemini' | 'whisper')}
                                className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                            >
                                <option value="openai">{t.aiProviderOpenAI}</option>
                                <option value="gemini">{t.aiProviderGemini}</option>
                                <option value="whisper">{t.speechProviderOffline}</option>
                            </select>
                        </div>

                        <div className="flex items-center justify-between gap-4">
                            <div className="text-sm font-medium">{t.speechModel}</div>
                            <select
                                value={speechModel}
                                onChange={(e) => onUpdateSpeechSettings({ model: e.target.value })}
                                className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                            >
                                {speechModelOptions.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {speechProvider === 'whisper' ? (
                            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                                <div className="text-sm font-medium">{t.speechOfflineModel}</div>
                                <div className="text-xs text-muted-foreground">{t.speechOfflineModelDesc}</div>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="text-xs text-muted-foreground">
                                        {speechOfflineReady ? t.speechOfflineReady : t.speechOfflineNotDownloaded}
                                        {speechOfflineSize ? ` · ${(speechOfflineSize / (1024 * 1024)).toFixed(1)} MB` : ''}
                                        {speechDownloadState === 'success' ? ` · ${t.speechOfflineDownloadSuccess}` : ''}
                                    </div>
                                    {speechOfflineReady ? (
                                        <button
                                            type="button"
                                            onClick={onDeleteWhisperModel}
                                            className="px-2 py-1 text-xs rounded border border-border hover:bg-muted"
                                        >
                                            {t.speechOfflineDelete}
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={onDownloadWhisperModel}
                                            className="px-2 py-1 text-xs rounded border border-border hover:bg-muted disabled:opacity-60 disabled:cursor-not-allowed"
                                            disabled={speechDownloadState === 'downloading'}
                                        >
                                            {speechDownloadState === 'downloading'
                                                ? `${t.speechOfflineDownload}...`
                                                : t.speechOfflineDownload}
                                        </button>
                                    )}
                                </div>
                                {speechDownloadError ? (
                                    <div className="text-xs text-red-500">{t.speechOfflineDownloadError}: {speechDownloadError}</div>
                                ) : null}
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <div className="text-sm font-medium">{t.aiApiKey}</div>
                                <input
                                    type="password"
                                    value={speechApiKey}
                                    onChange={(e) => onSpeechApiKeyChange(e.target.value)}
                                    placeholder={t.aiApiKey}
                                    className="w-full text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                />
                                <div className="text-xs text-muted-foreground">{t.aiApiKeyHint}</div>
                            </div>
                        )}

                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <div className="text-sm font-medium">{t.speechLanguage}</div>
                                <div className="text-xs text-muted-foreground">{t.speechLanguageHint}</div>
                            </div>
                            <input
                                value={speechLanguage}
                                onChange={(e) => onUpdateSpeechSettings({ language: e.target.value })}
                                placeholder={t.speechLanguageAuto}
                                className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                            />
                        </div>

                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <div className="text-sm font-medium">{t.speechMode}</div>
                                <div className="text-xs text-muted-foreground">{t.speechModeHint}</div>
                            </div>
                            <select
                                value={speechMode}
                                onChange={(e) => onUpdateSpeechSettings({ mode: e.target.value as 'smart_parse' | 'transcribe_only' })}
                                className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                            >
                                <option value="smart_parse">{t.speechModeSmart}</option>
                                <option value="transcribe_only">{t.speechModeTranscript}</option>
                            </select>
                        </div>

                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <div className="text-sm font-medium">{t.speechFieldStrategy}</div>
                                <div className="text-xs text-muted-foreground">{t.speechFieldStrategyHint}</div>
                            </div>
                            <select
                                value={speechFieldStrategy}
                                onChange={(e) =>
                                    onUpdateSpeechSettings({
                                        fieldStrategy: e.target.value as 'smart' | 'title_only' | 'description_only',
                                    })
                                }
                                className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                            >
                                <option value="smart">{t.speechFieldSmart}</option>
                                <option value="title_only">{t.speechFieldTitle}</option>
                                <option value="description_only">{t.speechFieldDescription}</option>
                            </select>
                        </div>
                    </div>
                )}
            </div>
            </div>
            <ConfirmModal
                isOpen={showAiConsentModal}
                title={t.aiConsentTitle}
                description={aiConsentDescription}
                confirmLabel={t.aiConsentAgree}
                cancelLabel={t.aiConsentCancel}
                onConfirm={() => {
                    onUpdateAISettings({ enabled: true });
                    setShowAiConsentModal(false);
                }}
                onCancel={() => setShowAiConsentModal(false)}
            />
        </>
    );
}
