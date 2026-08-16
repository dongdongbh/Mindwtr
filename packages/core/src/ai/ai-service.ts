import type { AIProvider, AIProviderConfig } from './types';
import { createGeminiProvider } from './providers/gemini';
import { createOpenAIProvider } from './providers/openai';
import { createAnthropicProvider } from './providers/anthropic';

export function createAIProvider(config: AIProviderConfig): AIProvider {
    switch (config.provider) {
        case 'gemini':
            return createGeminiProvider(config);
        case 'openai':
            return createOpenAIProvider(config);
        case 'anthropic':
            return createAnthropicProvider(config);
        case 'orcarouter':
            // OrcaRouter is an OpenAI-compatible gateway; the OpenAI provider's
            // requestOpenAI uses config.endpoint when set, so the fixed
            // OrcaRouter URL from buildAIConfig flows through here.
            return createOpenAIProvider(config);
        default:
            throw new Error(`Unsupported AI provider: ${config.provider}`);
    }
}
