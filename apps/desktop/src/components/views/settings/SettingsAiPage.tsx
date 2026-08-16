import type { AIProviderId, AIReasoningEffort, AiSettings } from '@mindwtr/core';
import { formatOpenAIExtraBodyParams, parseOpenAIExtraBodyParamsInput } from '@mindwtr/core';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useConfirmDialog } from '../../../hooks/useConfirmDialog';
import { cn } from '../../../lib/utils';
import { Switch } from '../../ui/Switch';
import { SettingField, SettingRow } from './SettingRow';

type Labels = {
    aiEnable: string;
    aiDesc: string;
    aiUsageTitle: string;
    aiUsageClarify: string;
    aiUsageBreakdown: string;
    aiUsageSuggestions: string;
    aiUsageReview: string;
    aiProvider: string;
    aiProviderOpenAI: string;
    aiProviderGemini: string;
    aiProviderAnthropic: string;
    aiProviderOrcaRouter: string;
    aiModel: string;
    aiBaseUrl: string;
    aiBaseUrlHint: string;
    aiBaseUrlModelHint: string;
    aiExtraBodyParams: string;
    aiExtraBodyParamsDesc: string;
    aiExtraBodyParamsHint: string;
    aiExtraBodyParamsInvalid: string;
    aiExtraBodyParamsSave: string;
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
    speechProviderParakeet: string;
    speechModel: string;
    speechBaseUrl: string;
    speechBaseUrlHint: string;
    speechOfflineModel: string;
    speechOfflineModelDesc: string;
    speechParakeetModelDesc: string;
    speechParakeetModelPath: string;
    speechParakeetModelPathPlaceholder: string;
    speechOfflineReady: string;
    speechOfflineNotDownloaded: string;
    speechOfflineEstimatedSize: string;
    speechOfflinePathSet: string;
    speechOfflineDownload: string;
    speechOfflineDownloadSuccess: string;
    speechOfflineDelete: string;
    speechOfflineDownloadRuntime: string;
    speechOfflineDownloadModel: string;
    speechOfflineInstalling: string;
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

type SpeechToTextSettings = NonNullable<AiSettings['speechToText']>;
type SpeechProvider = NonNullable<SpeechToTextSettings['provider']>;
type SpeechDownloadProgress = {
    stage: string;
    loaded: number;
    total?: number | null;
    percent?: number | null;
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
    aiOpenAIExtraBodyParams?: Record<string, unknown>;
    aiCopilotModel: string;
    aiCopilotOptions: string[];
    aiReasoningEffort: AIReasoningEffort;
    aiThinkingBudget: number;
    anthropicThinkingEnabled: boolean;
    anthropicThinkingOptions: ThinkingOption[];
    aiApiKey: string;
    speechEnabled: boolean;
    speechProvider: SpeechProvider;
    speechModel: string;
    speechModelOptions: string[];
    speechBaseUrl: string;
    speechLanguage: string;
    speechMode: 'smart_parse' | 'transcribe_only';
    speechFieldStrategy: 'smart' | 'title_only' | 'description_only';
    speechApiKey: string;
    speechOfflineReady: boolean;
    speechOfflineModelPath: string;
    speechOfflineEstimatedSize: number | null;
    speechOfflineSize: number | null;
    speechDownloadState: 'idle' | 'downloading' | 'success' | 'error';
    speechDownloadError: string | null;
    speechDownloadProgress: SpeechDownloadProgress | null;
    onUpdateAISettings: (next: Partial<AiSettings>) => void;
    onUpdateSpeechSettings: (next: Partial<SpeechToTextSettings>) => void;
    onProviderChange: (provider: AIProviderId) => void;
    onSpeechProviderChange: (provider: SpeechProvider) => void;
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
    aiOpenAIExtraBodyParams,
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
    speechBaseUrl,
    speechLanguage,
    speechMode,
    speechFieldStrategy,
    speechApiKey,
    speechOfflineReady,
    speechOfflineModelPath,
    speechOfflineEstimatedSize,
    speechOfflineSize,
    speechDownloadState,
    speechDownloadError,
    speechDownloadProgress,
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
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const [aiOpen, setAiOpen] = useState(false);
    const [speechOpen, setSpeechOpen] = useState(false);
    const [openAIExtraOpen, setOpenAIExtraOpen] = useState(false);
    const [openAIExtraDraft, setOpenAIExtraDraft] = useState(() => formatOpenAIExtraBodyParams(aiOpenAIExtraBodyParams));
    const [openAIExtraError, setOpenAIExtraError] = useState<string | null>(null);
    const selectedProviderLabel = aiProvider === 'gemini'
        ? t.aiProviderGemini
        : aiProvider === 'anthropic'
            ? t.aiProviderAnthropic
            : t.aiProviderOpenAI;
    const aiConsentDescription = t.aiConsentDescription.replace('{provider}', selectedProviderLabel);
    const showCustomBaseUrlModelHint = aiProvider === 'openai'
        && !aiBaseUrl.trim()
        && !looksLikeOfficialOpenAIModel(aiModel, aiModelOptions);
    const speechDownloadPercent = speechDownloadProgress?.percent == null
        ? null
        : Math.max(0, Math.min(100, Math.round(speechDownloadProgress.percent)));
    const speechDownloadProgressLabel = speechDownloadProgress?.stage === 'runtime_download'
        ? t.speechOfflineDownloadRuntime
        : speechDownloadProgress?.stage === 'model_download'
            ? t.speechOfflineDownloadModel
            : speechDownloadProgress?.stage === 'install'
                ? t.speechOfflineInstalling
                : null;
    const speechDownloadProgressView = speechDownloadState === 'downloading' && speechDownloadProgressLabel ? (
        <div className="space-y-1">
            <div className="text-xs text-muted-foreground">
                {speechDownloadProgressLabel}{speechDownloadPercent == null ? '' : ` ${speechDownloadPercent}%`}
            </div>
            <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={speechDownloadPercent ?? undefined}
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
                <div
                    className="h-full w-full origin-left bg-primary transition-transform duration-300 ease-out motion-reduce:transition-none"
                    style={{ transform: `scaleX(${(speechDownloadPercent ?? 12) / 100})` }}
                />
            </div>
        </div>
    ) : null;

    useEffect(() => {
        setOpenAIExtraDraft(formatOpenAIExtraBodyParams(aiOpenAIExtraBodyParams));
        setOpenAIExtraError(null);
    }, [aiOpenAIExtraBodyParams]);

    const handleSaveOpenAIExtraBodyParams = () => {
        const result = parseOpenAIExtraBodyParamsInput(openAIExtraDraft);
        if (!result.ok) {
            setOpenAIExtraError(t.aiExtraBodyParamsInvalid);
            return;
        }
        setOpenAIExtraError(null);
        setOpenAIExtraDraft(formatOpenAIExtraBodyParams(result.value));
        onUpdateAISettings({ openAIExtraBodyParams: result.value });
    };

    const handleAiToggle = () => {
        if (aiEnabled) {
            onUpdateAISettings({ enabled: false });
            return;
        }
        void requestConfirmation({
            title: t.aiConsentTitle,
            description: aiConsentDescription,
            confirmLabel: t.aiConsentAgree,
            cancelLabel: t.aiConsentCancel,
        }).then((confirmed) => {
            if (confirmed) {
                onUpdateAISettings({ enabled: true });
            }
        });
    };

    return (
        <>
            <div className="space-y-6">
                <div className="bg-card border border-border rounded-lg">
                <div className="p-4 flex items-center justify-between gap-4">
                    <button data-settings-key="aiEnable" data-settings-section="aiEnable"
                        type="button"
                        onClick={() => setAiOpen((prev) => !prev)}
                        aria-expanded={aiOpen}
                        className="flex-1 text-left flex items-center justify-between gap-4"
                    >
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.aiEnable}</div>
                            <div className="text-xs text-muted-foreground mt-1">{t.aiDesc}</div>
                        </div>
                        {aiOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                    </button>
                    <Switch
                        aria-label={t.aiEnable}
                        checked={aiEnabled}
                        onCheckedChange={handleAiToggle}
                    />
                </div>

                {aiOpen && (
                    <>
                        <div className="border-t border-border p-4">
                            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                                <div className="text-sm font-medium">{t.aiUsageTitle}</div>
                                <ul className="list-disc pl-4 space-y-1 text-xs text-muted-foreground">
                                    <li>{t.aiUsageClarify}</li>
                                    <li>{t.aiUsageBreakdown}</li>
                                    <li>{t.aiUsageSuggestions}</li>
                                    <li>{t.aiUsageReview}</li>
                                </ul>
                            </div>
                        </div>

                        <div className="border-t border-border p-4 space-y-3">
                            <SettingRow settingsKey="aiProvider" title={t.aiProvider}>
                                <select
                                    aria-label={t.aiProvider}
                                    value={aiProvider}
                                    onChange={(e) => onProviderChange(e.target.value as AIProviderId)}
                                    className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                                >
                                    <option value="openai">{t.aiProviderOpenAI}</option>
                                    <option value="gemini">{t.aiProviderGemini}</option>
                                    <option value="anthropic">{t.aiProviderAnthropic}</option>
                                    <option value="orcarouter">{t.aiProviderOrcaRouter}</option>
                                </select>
                            </SettingRow>

                            <SettingRow settingsKey="aiModel" title={t.aiModel}>
                                <input
                                    type="text"
                                    aria-label={t.aiModel}
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
                            </SettingRow>

                            <SettingRow settingsKey="aiCopilotModel" title={t.aiCopilotModel} description={t.aiCopilotHint}>
                                <input
                                    type="text"
                                    aria-label={t.aiCopilotModel}
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
                            </SettingRow>

                            {aiProvider === 'openai' && (
                                <SettingRow settingsKey="aiReasoning" title={t.aiReasoning} description={t.aiReasoningHint}>
                                    <select
                                        aria-label={t.aiReasoning}
                                        value={aiReasoningEffort}
                                        onChange={(e) => onUpdateAISettings({ reasoningEffort: e.target.value as AIReasoningEffort })}
                                        className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    >
                                        <option value="low">{t.aiEffortLow}</option>
                                        <option value="medium">{t.aiEffortMedium}</option>
                                        <option value="high">{t.aiEffortHigh}</option>
                                    </select>
                                </SettingRow>
                            )}

                            {aiProvider === 'openai' && (
                                <SettingField
                                    settingsKey="aiBaseUrl"
                                    title={t.aiBaseUrl}
                                    className="rounded-lg border border-border bg-muted/30 p-3"
                                >
                                    <input
                                        type="text"
                                        aria-label={t.aiBaseUrl}
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
                                        <div className="text-xs text-warning">{t.aiBaseUrlModelHint}</div>
                                    )}
                                </SettingField>
                            )}

                            {aiProvider === 'openai' && (
                                <div className="rounded-lg border border-border bg-muted/30">
                                    <button data-settings-key="aiExtraBodyParams"
                                        type="button"
                                        onClick={() => setOpenAIExtraOpen((open) => !open)}
                                        aria-expanded={openAIExtraOpen}
                                        className="flex w-full items-center justify-between gap-4 p-3 text-left"
                                    >
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium">{t.aiExtraBodyParams}</div>
                                            <div className="text-xs text-muted-foreground">{t.aiExtraBodyParamsDesc}</div>
                                        </div>
                                        {openAIExtraOpen ? (
                                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        ) : (
                                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        )}
                                    </button>
                                    {openAIExtraOpen && (
                                        <div className="space-y-2 border-t border-border p-3">
                                            <textarea
                                                value={openAIExtraDraft}
                                                onChange={(event) => setOpenAIExtraDraft(event.target.value)}
                                                placeholder={'{\n  "thinking": { "type": "disabled" }\n}'}
                                                className="min-h-[120px] w-full resize-y rounded border border-border bg-muted/50 px-2 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                                spellCheck={false}
                                            />
                                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                                <div className={cn('text-xs', openAIExtraError ? 'text-destructive' : 'text-muted-foreground')}>
                                                    {openAIExtraError ?? t.aiExtraBodyParamsHint}
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={handleSaveOpenAIExtraBodyParams}
                                                    className="rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/90"
                                                >
                                                    {t.aiExtraBodyParamsSave}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {aiProvider === 'anthropic' && (
                                <div className="space-y-3">
                                    <SettingRow settingsKey="aiThinkingEnable" title={t.aiThinkingEnable} description={t.aiThinkingEnableDesc}>
                                        <Switch
                                            aria-label={t.aiThinkingEnable}
                                            checked={anthropicThinkingEnabled}
                                            onCheckedChange={onToggleAnthropicThinking}
                                        />
                                    </SettingRow>
                                    {anthropicThinkingEnabled && (
                                        <SettingRow settingsKey="aiThinkingBudget" title={t.aiThinkingBudget} description={t.aiThinkingHint}>
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
                                        </SettingRow>
                                    )}
                                </div>
                            )}

                            {aiProvider === 'gemini' && (
                                // Gemini's own budget row; the indexed
                                // `aiThinkingBudget` key is on the Anthropic one.
                                <SettingRow
                                    settingsKey={null}
                                    title={t.aiThinkingBudget}
                                    description={t.aiThinkingHint}
                                >
                                    <select
                                        aria-label={t.aiThinkingBudget}
                                        value={String(aiThinkingBudget)}
                                        onChange={(e) => onUpdateAISettings({ thinkingBudget: Number(e.target.value) })}
                                        className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    >
                                        <option value="0">{t.aiThinkingOff}</option>
                                        <option value="128">{t.aiThinkingLow}</option>
                                        <option value="256">{t.aiThinkingMedium}</option>
                                        <option value="512">{t.aiThinkingHigh}</option>
                                    </select>
                                </SettingRow>
                            )}
                        </div>

                        <SettingField
                            settingsKey="aiApiKey"
                            title={t.aiApiKey}
                            className="border-t border-border p-4"
                        >
                            <input
                                type="password"
                                aria-label={t.aiApiKey}
                                value={aiApiKey}
                                onChange={(e) => onAiApiKeyChange(e.target.value)}
                                placeholder={t.aiApiKey}
                                className="w-full text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                            />
                            <div className="text-xs text-muted-foreground">{t.aiApiKeyHint}</div>
                        </SettingField>
                    </>
                )}
            </div>

            <div className="bg-card border border-border rounded-lg">
                <div className="p-4 flex items-center justify-between gap-4">
                    <button data-settings-key="speechTitle" data-settings-section="speechTitle"
                        type="button"
                        onClick={() => setSpeechOpen((prev) => !prev)}
                        aria-expanded={speechOpen}
                        className="flex-1 text-left flex items-center justify-between gap-4"
                    >
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.speechTitle}</div>
                            <div className="text-xs text-muted-foreground mt-1">{t.speechDesc}</div>
                        </div>
                        {speechOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                    </button>
                    <Switch
                        aria-label={t.speechTitle}
                        checked={speechEnabled}
                        onCheckedChange={(checked) => onUpdateSpeechSettings({ enabled: checked })}
                    />
                </div>

                {speechOpen && (
                    <div className="border-t border-border p-4 space-y-3">
                        <SettingRow settingsKey="speechProvider" title={t.speechProvider}>
                            <select
                                value={speechProvider}
                                onChange={(e) => onSpeechProviderChange(e.target.value as SpeechProvider)}
                                className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                            >
                                <option value="openai">{t.aiProviderOpenAI}</option>
                                <option value="gemini">{t.aiProviderGemini}</option>
                                <option value="whisper">{t.speechProviderOffline}</option>
                                <option value="parakeet">{t.speechProviderParakeet}</option>
                            </select>
                        </SettingRow>

                        <SettingRow settingsKey="speechModel" title={t.speechModel}>
                            {speechProvider === 'openai' ? (
                                <>
                                    <input
                                        type="text"
                                        aria-label={t.speechModel}
                                        value={speechModel}
                                        onChange={(e) => onUpdateSpeechSettings({ model: e.target.value })}
                                        list="speech-model-options"
                                        className="min-w-[200px] text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    />
                                    <datalist id="speech-model-options">
                                        {speechModelOptions.map((option) => (
                                            <option key={option} value={option} />
                                        ))}
                                    </datalist>
                                </>
                            ) : (
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
                            )}
                        </SettingRow>

                        {speechProvider === 'openai' && (
                            <SettingField
                                settingsKey="speechBaseUrl"
                                title={t.speechBaseUrl}
                                className="rounded-lg border border-border bg-muted/30 p-3"
                            >
                                <input
                                    type="text"
                                    aria-label={t.speechBaseUrl}
                                    value={speechBaseUrl}
                                    onChange={(e) => onUpdateSpeechSettings({ baseUrl: e.target.value })}
                                    // Not the chat field's Ollama URL — that serves LLMs, not
                                    // transcription. 8000 is where the common ASR servers land.
                                    placeholder="http://localhost:8000/v1"
                                    className="w-full text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                />
                                <div className="text-xs text-muted-foreground">{t.speechBaseUrlHint}</div>
                            </SettingField>
                        )}

                        {speechProvider === 'whisper' ? (
                            <SettingField
                                settingsKey="speechOfflineModel"
                                title={t.speechOfflineModel}
                                description={t.speechOfflineModelDesc}
                                className="rounded-lg border border-border bg-muted/30 p-3"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div className="text-xs text-muted-foreground">
                                        {speechOfflineReady ? t.speechOfflineReady : t.speechOfflineNotDownloaded}
                                        {speechOfflineSize
                                            ? ` · ${(speechOfflineSize / (1024 * 1024)).toFixed(1)} MB`
                                            : speechOfflineEstimatedSize
                                                ? ` · ${t.speechOfflineEstimatedSize}: ${(speechOfflineEstimatedSize / (1024 * 1024)).toFixed(1)} MB`
                                                : ''}
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
                                    <div className="text-xs text-destructive">{t.speechOfflineDownloadError}: {speechDownloadError}</div>
                                ) : null}
                                {speechDownloadProgressView}
                            </SettingField>
                        ) : speechProvider === 'parakeet' ? (
                            // Parakeet's variant of the offline-model card above,
                            // which carries the indexed `speechOfflineModel` key.
                            <SettingField
                                settingsKey={null}
                                title={t.speechOfflineModel}
                                description={t.speechParakeetModelDesc}
                                className="rounded-lg border border-border bg-muted/30 p-3"
                            >
                                <label className="block space-y-1">
                                    <span className="text-xs font-medium text-muted-foreground">{t.speechParakeetModelPath}</span>
                                    <input
                                        type="text"
                                        value={speechOfflineModelPath}
                                        readOnly
                                        placeholder={t.speechParakeetModelPathPlaceholder}
                                        className="w-full cursor-default text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    />
                                </label>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="text-xs text-muted-foreground">
                                        {speechOfflineReady ? t.speechOfflineReady : t.speechOfflineNotDownloaded}
                                        {speechOfflineSize
                                            ? ` · ${(speechOfflineSize / (1024 * 1024)).toFixed(1)} MB`
                                            : speechOfflineEstimatedSize
                                                ? ` · ${t.speechOfflineEstimatedSize}: ${(speechOfflineEstimatedSize / (1024 * 1024)).toFixed(1)} MB`
                                                : ''}
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
                                    <div className="text-xs text-destructive">{t.speechOfflineDownloadError}: {speechDownloadError}</div>
                                ) : null}
                                {speechDownloadProgressView}
                            </SettingField>
                        ) : (
                            // The speech provider's key, separate from the
                            // assistant's indexed `aiApiKey` field above.
                            <SettingField settingsKey={null} title={t.aiApiKey}>
                                <input
                                    type="password"
                                    aria-label={t.aiApiKey}
                                    value={speechApiKey}
                                    onChange={(e) => onSpeechApiKeyChange(e.target.value)}
                                    placeholder={t.aiApiKey}
                                    className="w-full text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                />
                                <div className="text-xs text-muted-foreground">{t.aiApiKeyHint}</div>
                            </SettingField>
                        )}

                        <SettingRow settingsKey="speechLanguage" title={t.speechLanguage} description={t.speechLanguageHint}>
                            <input
                                aria-label={t.speechLanguage}
                                value={speechLanguage}
                                onChange={(e) => onUpdateSpeechSettings({ language: e.target.value })}
                                placeholder={t.speechLanguageAuto}
                                className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                            />
                        </SettingRow>

                        <SettingRow settingsKey="speechMode" title={t.speechMode} description={t.speechModeHint}>
                            <select
                                value={speechMode}
                                onChange={(e) => onUpdateSpeechSettings({ mode: e.target.value as 'smart_parse' | 'transcribe_only' })}
                                className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                            >
                                <option value="smart_parse">{t.speechModeSmart}</option>
                                <option value="transcribe_only">{t.speechModeTranscript}</option>
                            </select>
                        </SettingRow>

                        <SettingRow settingsKey="speechFieldStrategy" title={t.speechFieldStrategy} description={t.speechFieldStrategyHint}>
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
                        </SettingRow>
                    </div>
                )}
            </div>
            </div>
            {confirmModal}
        </>
    );
}
