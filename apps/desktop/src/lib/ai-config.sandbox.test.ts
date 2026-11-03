import { describe, expect, it } from 'vitest';
import { initializeSandboxRuntime, isAIKeyRequired as isCoreAIKeyRequired } from '@mindwtr/core';
import { isAIKeyRequired } from './ai-config';


describe('isAIKeyRequired in sandbox mode', () => {
    it('follows core: the sandbox never asks for a key', () => {
        initializeSandboxRuntime(true);
        const settings = { ai: { provider: 'gemini' as const, model: 'gemini-2.5-flash' } };

        expect(isCoreAIKeyRequired(settings)).toBe(false);
        expect(isAIKeyRequired(settings)).toBe(false);
    });
});
