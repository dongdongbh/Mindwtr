import type { AIProviderId, AIReasoningEffort, AppData } from '@mindwtr/core';

import { cn } from '../../../lib/utils';

type Labels = {
    aiEnable: string;
    aiDesc: string;
    aiProvider: string;
    aiProviderOpenAI: string;
    aiProviderGemini: string;
    aiProviderAnthropic: string;
    aiModel: string;
    aiCopilotModel: string;
    aiCopilotHint: string;
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
};

type ThinkingOption = { value: number; label: string };

type SettingsAiPageProps = {
    t: Labels;
    aiEnabled: boolean;
    aiProvider: AIProviderId;
    aiModel: string;
    aiModelOptions: string[];
    aiCopilotModel: string;
    aiCopilotOptions: string[];
    aiReasoningEffort: AIReasoningEffort;
    aiThinkingBudget: number;
    anthropicThinkingEnabled: boolean;
    anthropicThinkingOptions: ThinkingOption[];
    aiApiKey: string;
    onUpdateAISettings: (next: Partial<NonNullable<AppData['settings']['ai']>>) => void;
    onProviderChange: (provider: AIProviderId) => void;
    onToggleAnthropicThinking: () => void;
    onAiApiKeyChange: (value: string) => void;
};

export function SettingsAiPage({
    t,
    aiEnabled,
    aiProvider,
    aiModel,
    aiModelOptions,
    aiCopilotModel,
    aiCopilotOptions,
    aiReasoningEffort,
    aiThinkingBudget,
    anthropicThinkingEnabled,
    anthropicThinkingOptions,
    aiApiKey,
    onUpdateAISettings,
    onProviderChange,
    onToggleAnthropicThinking,
    onAiApiKeyChange,
}: SettingsAiPageProps) {
    return (
        <div className="space-y-6">
            <div className="bg-card border border-border rounded-lg divide-y divide-border">
                <div className="p-4 flex items-center justify-between gap-6">
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.aiEnable}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.aiDesc}</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={aiEnabled}
                        onClick={() => onUpdateAISettings({ enabled: !aiEnabled })}
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

                <div className="p-4 space-y-3">
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
                        <select
                            value={aiModel}
                            onChange={(e) => onUpdateAISettings({ model: e.target.value })}
                            className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                            {aiModelOptions.map((option) => (
                                <option key={option} value={option}>
                                    {option}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <div className="text-sm font-medium">{t.aiCopilotModel}</div>
                            <div className="text-xs text-muted-foreground">{t.aiCopilotHint}</div>
                        </div>
                        <select
                            value={aiCopilotModel}
                            onChange={(e) => onUpdateAISettings({ copilotModel: e.target.value })}
                            className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                            {aiCopilotOptions.map((option) => (
                                <option key={option} value={option}>
                                    {option}
                                </option>
                            ))}
                        </select>
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

                <div className="p-4 space-y-2">
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
            </div>
        </div>
    );
}
