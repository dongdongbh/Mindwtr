import { describe, expect, it } from 'vitest';
import { initializeSandboxRuntime } from '@mindwtr/core';
import { getWorkspaceCache } from './workspace-cache';

describe('sandbox workspace cache', () => {
    it('keeps session UI state out of personal local storage', () => {
        window.localStorage.setItem('mindwtr:test:private-draft', 'personal');
        initializeSandboxRuntime(true);

        const cache = getWorkspaceCache();
        expect(cache?.getItem('mindwtr:test:private-draft')).toBeNull();
        cache?.setItem('mindwtr:test:private-draft', 'sample');

        expect(cache?.getItem('mindwtr:test:private-draft')).toBe('sample');
        expect(window.localStorage.getItem('mindwtr:test:private-draft')).toBe('personal');
    });
});
