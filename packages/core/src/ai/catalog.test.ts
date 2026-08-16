import { describe, expect, it } from 'vitest';
import {
    ANTHROPIC_DEFAULT_MODEL,
    ANTHROPIC_MODEL_OPTIONS,
    GEMINI_COPILOT_DEFAULT_MODEL,
    GEMINI_DEFAULT_MODEL,
    OPENAI_COPILOT_DEFAULT_MODEL,
    OPENAI_DEFAULT_MODEL,
    OPENAI_MODEL_OPTIONS,
    ORCAROUTER_COPILOT_DEFAULT_MODEL,
    ORCAROUTER_DEFAULT_MODEL,
    ORCAROUTER_MODEL_OPTIONS,
    getDefaultAIConfig,
    getDefaultCopilotModel,
    getModelOptions,
    resolveAnthropicModel,
    resolveGeminiModel,
} from './catalog';

describe('current model lineup (#985)', () => {
    it('offers the GPT-5.6 tiers with terra as the default and luna as copilot', () => {
        expect(OPENAI_DEFAULT_MODEL).toBe('gpt-5.6-terra');
        expect(OPENAI_COPILOT_DEFAULT_MODEL).toBe('gpt-5.6-luna');
        expect(OPENAI_MODEL_OPTIONS).toEqual(['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    });

    it('offers claude-opus-5 alongside the existing Anthropic tiers', () => {
        expect(ANTHROPIC_MODEL_OPTIONS).toContain('claude-opus-5');
        expect(ANTHROPIC_MODEL_OPTIONS).toContain(ANTHROPIC_DEFAULT_MODEL);
        expect(ANTHROPIC_MODEL_OPTIONS).toContain('claude-haiku-4-5');
    });
});

describe('OrcaRouter provider', () => {
    it('defaults to the gateway fusion route with fusion-mini as the copilot tier', () => {
        expect(ORCAROUTER_DEFAULT_MODEL).toBe('orcarouter/fusion');
        expect(ORCAROUTER_COPILOT_DEFAULT_MODEL).toBe('orcarouter/fusion-mini');
        expect(ORCAROUTER_MODEL_OPTIONS).toContain(ORCAROUTER_DEFAULT_MODEL);
        expect(ORCAROUTER_MODEL_OPTIONS).toContain(ORCAROUTER_COPILOT_DEFAULT_MODEL);
    });

    it('resolves the orcarouter provider defaults and options through the catalog helpers', () => {
        expect(getDefaultAIConfig('orcarouter').model).toBe(ORCAROUTER_DEFAULT_MODEL);
        expect(getModelOptions('orcarouter')).toEqual(ORCAROUTER_MODEL_OPTIONS);
        expect(getDefaultCopilotModel('orcarouter')).toBe(ORCAROUTER_COPILOT_DEFAULT_MODEL);
    });
});

describe('retired model remaps', () => {
    it('remaps retired Gemini ids to the current tier', () => {
        expect(resolveGeminiModel('gemini-2.5-flash')).toBe(GEMINI_DEFAULT_MODEL);
        expect(resolveGeminiModel('gemini-2.0-flash-lite')).toBe(GEMINI_COPILOT_DEFAULT_MODEL);
        expect(resolveGeminiModel('gemini-1.5-flash')).toBe(GEMINI_DEFAULT_MODEL);
    });

    it('passes through current and custom Gemini ids untouched', () => {
        expect(resolveGeminiModel('gemini-3.6-flash')).toBe('gemini-3.6-flash');
        expect(resolveGeminiModel('my-custom-model')).toBe('my-custom-model');
        expect(resolveGeminiModel('')).toBe(GEMINI_DEFAULT_MODEL);
        expect(resolveGeminiModel(undefined)).toBe(GEMINI_DEFAULT_MODEL);
    });

    it('remaps retired Anthropic ids to the current tier', () => {
        expect(resolveAnthropicModel('claude-3-7-sonnet')).toBe(ANTHROPIC_DEFAULT_MODEL);
        expect(resolveAnthropicModel('claude-3-5-haiku-20241022')).toBe('claude-haiku-4-5');
        expect(resolveAnthropicModel('claude-opus-4-1')).toBe('claude-opus-4-8');
        expect(resolveAnthropicModel('claude-sonnet-4-20250514')).toBe(ANTHROPIC_DEFAULT_MODEL);
    });

    it('passes through current and legacy-but-active Anthropic ids untouched', () => {
        expect(resolveAnthropicModel('claude-sonnet-5')).toBe('claude-sonnet-5');
        expect(resolveAnthropicModel('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
        expect(resolveAnthropicModel('claude-opus-4-5')).toBe('claude-opus-4-5');
    });
});
