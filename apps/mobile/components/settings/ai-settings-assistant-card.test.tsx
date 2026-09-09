import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { AiSettingsAssistantCard } from './ai-settings-assistant-card';

vi.mock('./ai-settings-assistant-openai-panel', () => ({
    AiSettingsAssistantOpenAiPanel: () => null,
}));
vi.mock('./ai-settings-assistant-gemini-panel', () => ({
    AiSettingsAssistantGeminiPanel: () => null,
}));
vi.mock('./ai-settings-assistant-anthropic-panel', () => ({
    AiSettingsAssistantAnthropicPanel: () => null,
}));

const tc = {
    bg: '#0f172a',
    cardBg: '#111827',
    filterBg: '#1f2937',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    tint: '#3b82f6',
} as unknown as ThemeColors;

const tr = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => (
    key === 'settings.aiRequestTimeoutSeconds' ? `${values?.seconds} seconds` : key
);

const baseProps: Parameters<typeof AiSettingsAssistantCard>[0] = {
    aiApiKey: '',
    aiAssistantOpen: true,
    aiBaseUrl: '',
    aiCopilotModel: 'gpt-4o-mini',
    aiCopilotOptions: ['gpt-4o-mini'],
    aiEnabled: true,
    aiExtraBodyParamsDraft: '',
    aiExtraBodyParamsError: '',
    aiModel: 'gpt-5-mini',
    aiModelOptions: ['gpt-5-mini'],
    aiProvider: 'openai',
    aiReasoningEffort: 'medium',
    aiRequestTimeoutSeconds: 30,
    aiThinkingBudget: 0,
    anthropicThinkingEnabled: false,
    getAIProviderLabel: (provider) => provider,
    isFossBuild: false,
    tr,
    onAiApiKeyChange: vi.fn(),
    onAiBaseUrlChange: vi.fn(),
    onAiCopilotModelChange: vi.fn(),
    onAiEnabledChange: vi.fn(),
    onAiExtraBodyParamsDraftChange: vi.fn(),
    onAiExtraBodyParamsSave: vi.fn(),
    onAiModelChange: vi.fn(),
    onAiProviderChange: vi.fn(),
    onAiReasoningEffortChange: vi.fn(),
    onAiRequestTimeoutSecondsChange: vi.fn(),
    onAiThinkingBudgetChange: vi.fn(),
    onAnthropicThinkingEnabledChange: vi.fn(),
    onModelPickerChange: vi.fn(),
    onToggleOpen: vi.fn(),
    t: (key) => key,
    tc,
};

const texts = (tree: renderer.ReactTestRenderer): string[] => tree.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');

const press = async (tree: renderer.ReactTestRenderer, label: string) => {
    const target = tree.root
        .findAllByType(TouchableOpacity)
        .find((node) => node.findAllByType(Text).some((child) => child.props.children === label));
    if (!target) throw new Error(`No pressable containing "${label}"`);
    await act(async () => {
        target.props.onPress();
    });
};

const renderCard = async (props: Parameters<typeof AiSettingsAssistantCard>[0]) => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
        tree = renderer.create(<AiSettingsAssistantCard {...props} />);
    });
    return tree;
};

describe('AiSettingsAssistantCard request timeout', () => {
    it('keeps Advanced collapsed and offers every supported duration', async () => {
        const onChange = vi.fn();
        const tree = await renderCard({
            ...baseProps,
            onAiRequestTimeoutSecondsChange: onChange,
        });

        expect(texts(tree)).not.toContain('settings.aiRequestTimeout');
        await press(tree, 'settings.aiAdvanced');
        expect(texts(tree)).toContain('settings.aiRequestTimeout');
        expect(texts(tree)).toContain('30 seconds');

        await press(tree, '30 seconds');
        expect(texts(tree)).toEqual(expect.arrayContaining([
            '30 seconds',
            '60 seconds',
            '120 seconds',
            '300 seconds',
        ]));

        await press(tree, '120 seconds');
        expect(onChange).toHaveBeenCalledWith(120);
    });

    it('displays a persisted 120-second timeout', async () => {
        const tree = await renderCard({
            ...baseProps,
            aiRequestTimeoutSeconds: 120,
        });

        await press(tree, 'settings.aiAdvanced');
        expect(texts(tree)).toContain('120 seconds');
    });
});
