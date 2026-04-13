import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SettingsAiPage } from './SettingsAiPage';

const t = {
    aiEnable: 'Enable AI assistant',
    aiDesc: 'Optional help to clarify and break down tasks.',
    aiProvider: 'Provider',
    aiProviderOpenAI: 'OpenAI',
    aiProviderGemini: 'Gemini',
    aiProviderAnthropic: 'Anthropic (Claude)',
    aiModel: 'Model',
    aiBaseUrl: 'Custom OpenAI-compatible base URL',
    aiBaseUrlHint: 'Leave blank for official OpenAI. Set this for local or third-party OpenAI-compatible APIs such as Ollama, LM Studio, GLM, or vLLM.',
    aiBaseUrlModelHint: 'This model looks non-OpenAI. If you are using GLM or another OpenAI-compatible provider, set a custom base URL.',
    aiCopilotModel: 'Copilot model',
    aiCopilotHint: 'Used for fast autocomplete suggestions.',
    aiConsentTitle: 'Enable AI Features?',
    aiConsentDescription: 'To use this feature, your task data will be sent to {provider} for processing.',
    aiConsentCancel: 'Cancel',
    aiConsentAgree: 'Agree',
    aiReasoning: 'Reasoning effort',
    aiReasoningHint: 'Used by GPT-5 models.',
    aiEffortLow: 'Low',
    aiEffortMedium: 'Medium',
    aiEffortHigh: 'High',
    aiThinkingEnable: 'Enable thinking',
    aiThinkingEnableDesc: 'Use extended reasoning for complex tasks.',
    aiThinkingBudget: 'Thinking budget',
    aiThinkingHint: 'Claude/Gemini only. 0 disables extended thinking.',
    aiThinkingOff: 'Off',
    aiThinkingLow: 'Low',
    aiThinkingMedium: 'Medium',
    aiThinkingHigh: 'High',
    aiApiKey: 'API key',
    aiApiKeyHint: 'Stored locally on this device. Never synced. Official OpenAI requires a key. Custom OpenAI-compatible endpoints may also require one; leave it blank only if your endpoint allows unauthenticated requests.',
    speechTitle: 'Speech to text',
    speechDesc: 'Transcribe voice captures and map them into task fields.',
    speechEnable: 'Enable speech to text',
    speechProvider: 'Speech provider',
    speechProviderOffline: 'On-device (Whisper)',
    speechModel: 'Speech model',
    speechOfflineModel: 'Offline model',
    speechOfflineModelDesc: 'Download once to transcribe fully offline.',
    speechOfflineReady: 'Model downloaded',
    speechOfflineNotDownloaded: 'Model not downloaded',
    speechOfflineDownload: 'Download',
    speechOfflineDownloadSuccess: 'Download complete',
    speechOfflineDelete: 'Delete',
    speechOfflineDownloadError: 'Offline model download failed',
    speechLanguage: 'Audio language',
    speechLanguageHint: 'Use a language name or code, or leave blank to auto-detect.',
    speechLanguageAuto: 'Auto (detect language)',
    speechMode: 'Processing mode',
    speechModeHint: 'Smart parse extracts dates and fields; transcript-only just transcribes.',
    speechModeSmart: 'Smart parse',
    speechModeTranscript: 'Transcript only',
    speechFieldStrategy: 'Field mapping',
    speechFieldStrategyHint: 'Choose where the transcript should land by default.',
    speechFieldSmart: 'Smart',
    speechFieldTitle: 'Title',
    speechFieldDescription: 'Description',
};

const baseProps: Parameters<typeof SettingsAiPage>[0] = {
    t,
    aiEnabled: true,
    aiProvider: 'openai',
    aiModel: 'GLM-4.7',
    aiModelOptions: ['gpt-4o-mini', 'gpt-5-mini'],
    aiBaseUrl: '',
    aiCopilotModel: 'gpt-4o-mini',
    aiCopilotOptions: ['gpt-4o-mini'],
    aiReasoningEffort: 'medium',
    aiThinkingBudget: 0,
    anthropicThinkingEnabled: false,
    anthropicThinkingOptions: [{ value: 0, label: 'Off' }],
    aiApiKey: '',
    speechEnabled: false,
    speechProvider: 'gemini',
    speechModel: 'gemini-2.5-flash',
    speechModelOptions: ['gemini-2.5-flash'],
    speechLanguage: '',
    speechMode: 'smart_parse',
    speechFieldStrategy: 'smart',
    speechApiKey: '',
    speechOfflineReady: false,
    speechOfflineSize: null,
    speechDownloadState: 'idle',
    speechDownloadError: null,
    onUpdateAISettings: vi.fn(),
    onUpdateSpeechSettings: vi.fn(),
    onProviderChange: vi.fn(),
    onSpeechProviderChange: vi.fn(),
    onToggleAnthropicThinking: vi.fn(),
    onAiApiKeyChange: vi.fn(),
    onSpeechApiKeyChange: vi.fn(),
    onDownloadWhisperModel: vi.fn(),
    onDeleteWhisperModel: vi.fn(),
};

describe('SettingsAiPage', () => {
    it('warns when a non-OpenAI model is configured without a custom endpoint', () => {
        const { getByRole, getByText } = render(<SettingsAiPage {...baseProps} />);

        fireEvent.click(getByRole('button', { name: /Enable AI assistant/i }));

        expect(getByText('Custom OpenAI-compatible base URL')).toBeInTheDocument();
        expect(getByText('This model looks non-OpenAI. If you are using GLM or another OpenAI-compatible provider, set a custom base URL.')).toBeInTheDocument();
        expect(getByText('Stored locally on this device. Never synced. Official OpenAI requires a key. Custom OpenAI-compatible endpoints may also require one; leave it blank only if your endpoint allows unauthenticated requests.')).toBeInTheDocument();
    });
});
