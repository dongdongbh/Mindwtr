import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SettingsAiPage } from './SettingsAiPage';

const t = {
    aiEnable: 'Enable AI assistant',
    aiDesc: 'Optional help to clarify and break down tasks.',
    aiUsageTitle: 'Where and how to use AI',
    aiUsageClarify: 'Clarify: open a task, click the ✨ sparkle button in its editor, and choose Clarify to turn a vague task into a clear next action.',
    aiUsageBreakdown: 'Break down: in that same ✨ menu, choose Break down to split a task or project into concrete steps.',
    aiUsageSuggestions: 'Suggestions: as you type a task title or notes, a ✨ suggestion for context, time estimate, and tags appears below — click it to apply.',
    aiUsageReview: 'Weekly review: open the Weekly Review, go to the AI step, and click Run to get suggested actions for stale tasks.',
    aiProvider: 'Provider',
    aiProviderOpenAI: 'OpenAI',
    aiProviderGemini: 'Gemini',
    aiProviderAnthropic: 'Anthropic (Claude)',
    aiModel: 'Model',
    aiBaseUrl: 'Custom OpenAI-compatible base URL',
    aiBaseUrlHint: 'Leave blank for official OpenAI. Set this for local or third-party OpenAI-compatible APIs such as llama.cpp, Ollama, LM Studio, GLM, or vLLM.',
    aiBaseUrlModelHint: 'This model looks non-OpenAI. If you are using GLM or another OpenAI-compatible provider, set a custom base URL.',
    aiExtraBodyParams: 'Extra request parameters',
    aiExtraBodyParamsDesc: 'Optional JSON object merged into OpenAI-compatible requests.',
    aiExtraBodyParamsHint: 'Core fields such as model, messages, and response_format are protected. Example: { "thinking": { "type": "disabled" } }',
    aiExtraBodyParamsInvalid: 'Enter a valid JSON object.',
    aiExtraBodyParamsSave: 'Save parameters',
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
    speechProviderParakeet: 'Parakeet v3 experimental',
    speechModel: 'Speech model',
    speechOfflineModel: 'Offline model',
    speechOfflineModelDesc: 'Download once to transcribe fully offline.',
    speechParakeetModelDesc: 'Download once to install the Parakeet ASR model for local transcription. Model weights are not bundled with Mindwtr.',
    speechParakeetModelPath: 'Install folder',
    speechParakeetModelPathPlaceholder: 'App data folder',
    speechOfflineReady: 'Model downloaded',
    speechOfflineNotDownloaded: 'Model not downloaded',
    speechOfflineEstimatedSize: 'Estimated download size',
    speechOfflinePathSet: 'Model path set',
    speechOfflineDownload: 'Download',
    speechOfflineDownloadSuccess: 'Download complete',
    speechOfflineDelete: 'Delete',
    speechOfflineDownloadRuntime: 'Downloading runtime',
    speechOfflineDownloadModel: 'Downloading model',
    speechOfflineInstalling: 'Installing',
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
    aiOpenAIExtraBodyParams: undefined,
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
    speechOfflineModelPath: '',
    speechOfflineEstimatedSize: null,
    speechOfflineSize: null,
    speechDownloadState: 'idle',
    speechDownloadError: null,
    speechDownloadProgress: null,
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

    it('saves extra OpenAI-compatible request parameters from folded JSON input', () => {
        const onUpdateAISettings = vi.fn();
        const { getByPlaceholderText, getByRole, getByText } = render(
            <SettingsAiPage
                {...baseProps}
                onUpdateAISettings={onUpdateAISettings}
            />
        );

        fireEvent.click(getByRole('button', { name: /Enable AI assistant/i }));
        expect(getByText('Extra request parameters')).toBeInTheDocument();
        fireEvent.click(getByRole('button', { name: /Extra request parameters/i }));
        fireEvent.change(getByPlaceholderText(/thinking/), {
            target: { value: '{ "thinking": { "type": "disabled" } }' },
        });
        fireEvent.click(getByRole('button', { name: 'Save parameters' }));

        expect(onUpdateAISettings).toHaveBeenCalledWith({
            openAIExtraBodyParams: {
                thinking: { type: 'disabled' },
            },
        });
    });


    it('offers Parakeet as an experimental desktop speech provider', () => {
        const onSpeechProviderChange = vi.fn();
        const { getByRole, getByDisplayValue } = render(
            <SettingsAiPage
                {...baseProps}
                speechProvider="whisper"
                speechModel="whisper-tiny"
                speechModelOptions={["whisper-tiny"]}
                onSpeechProviderChange={onSpeechProviderChange}
            />
        );

        fireEvent.click(getByRole('button', { name: /Speech to text/i }));
        fireEvent.change(getByDisplayValue('On-device (Whisper)'), {
            target: { value: 'parakeet' },
        });

        expect(onSpeechProviderChange).toHaveBeenCalledWith('parakeet');
    });




    it('shows Parakeet download progress while installing the local model', () => {
        const { getByRole, getByText } = render(
            <SettingsAiPage
                {...baseProps}
                speechProvider="parakeet"
                speechModel="parakeet-tdt-0.6b-v3-int8"
                speechModelOptions={["parakeet-tdt-0.6b-v3-int8"]}
                speechOfflineModelPath="/home/dd/.local/share/mindwtr/parakeet-model"
                speechOfflineEstimatedSize={670478772}
                speechDownloadState="downloading"
                speechDownloadProgress={{ stage: 'model_download', loaded: 335239386, total: 670478772, percent: 50 }}
            />
        );

        fireEvent.click(getByRole('button', { name: /Speech to text/i }));

        expect(getByText('Downloading model 50%')).toBeInTheDocument();
        expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    });

    it('shows Whisper download progress while downloading the local model', () => {
        const { getByRole, getByText } = render(
            <SettingsAiPage
                {...baseProps}
                speechProvider="whisper"
                speechModel="whisper-tiny"
                speechModelOptions={["whisper-tiny"]}
                speechOfflineEstimatedSize={77691713}
                speechDownloadState="downloading"
                speechDownloadProgress={{ stage: 'model_download', loaded: 38845856, total: 77691713, percent: 50 }}
            />
        );

        fireEvent.click(getByRole('button', { name: /Speech to text/i }));

        expect(getByText('Downloading model 50%')).toBeInTheDocument();
        expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    });

    it('offers one-click Parakeet model download from the offline model card', () => {
        const onDownloadWhisperModel = vi.fn();
        const { getByDisplayValue, getByRole, getByText } = render(
            <SettingsAiPage
                {...baseProps}
                speechProvider="parakeet"
                speechModel="parakeet-tdt-0.6b-v3-int8"
                speechModelOptions={["parakeet-tdt-0.6b-v3-int8"]}
                speechOfflineModelPath="/home/dd/.local/share/mindwtr/parakeet-model"
                speechOfflineEstimatedSize={670478772}
                onDownloadWhisperModel={onDownloadWhisperModel}
            />
        );

        fireEvent.click(getByRole('button', { name: /Speech to text/i }));
        expect(getByDisplayValue('/home/dd/.local/share/mindwtr/parakeet-model')).toBeInTheDocument();
        expect(getByText(/Estimated download size: 639\.4 MB/)).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'Download' }));

        expect(onDownloadWhisperModel).toHaveBeenCalledTimes(1);
    });

    it('shows the selected local speech model estimated size before download', () => {
        const { getByRole, getByText } = render(
            <SettingsAiPage
                {...baseProps}
                speechProvider="whisper"
                speechModel="whisper-tiny"
                speechModelOptions={["whisper-tiny", "whisper-large-v3-turbo"]}
                speechOfflineEstimatedSize={77691713}
            />
        );

        fireEvent.click(getByRole('button', { name: /Speech to text/i }));

        expect(getByText(/Estimated download size: 74\.1 MB/)).toBeInTheDocument();
    });
});
