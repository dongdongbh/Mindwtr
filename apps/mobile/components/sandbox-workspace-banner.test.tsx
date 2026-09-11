import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SandboxWorkspaceBanner } from './sandbox-workspace-banner';

const workspace = vi.hoisted(() => ({
    reloadIntoMobileSandbox: vi.fn().mockResolvedValue(undefined),
    reloadIntoPersonalWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@mindwtr/core', () => ({ isSandboxMode: () => true }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('lucide-react-native', () => ({
    RotateCcw: () => null,
}));
vi.mock('@/contexts/language-context', () => ({
    useLanguage: () => ({
        t: (key: string) => ({
            'sandbox.label': 'Sandbox',
            'sandbox.title': 'Sandbox · Sample data',
            'sandbox.reset': 'Reset sample data',
            'sandbox.resetShort': 'Reset',
            'sandbox.exit': 'Exit sandbox',
            'sandbox.exitShort': 'Exit',
            'sandbox.switching': 'Switching workspace…',
            'sandbox.switchFailed': 'Could not switch workspaces.',
        }[key] ?? key),
    }),
}));
vi.mock('@/lib/sandbox-workspace', () => ({
    getWorkspaceSwitching: () => false,
    subscribeWorkspaceSwitching: () => () => undefined,
    reloadIntoMobileSandbox: workspace.reloadIntoMobileSandbox,
    reloadIntoPersonalWorkspace: workspace.reloadIntoPersonalWorkspace,
}));

const flattenStyle = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (result, item) => Object.assign(result, flattenStyle(item)),
            {},
        );
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
};

describe('SandboxWorkspaceBanner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses a wrapping single row with short visible copy and accessible touch targets', () => {
        let tree!: ReturnType<typeof create>;
        act(() => { tree = create(<SandboxWorkspaceBanner />); });

        const visibleText = tree.root.findAllByType(Text).map((node) => node.props.children);
        expect(visibleText).toEqual(['Sandbox', 'Reset', 'Exit']);
        expect(visibleText).not.toContain('Sandbox · Sample data');

        const content = tree.root.findByProps({ testID: 'sandbox-workspace-banner-content' });
        expect(flattenStyle(content.props.style)).toMatchObject({
            flexDirection: 'row',
            flexWrap: 'wrap',
            minHeight: 44,
        });

        const reset = tree.root.findByProps({ testID: 'sandbox-reset-button' });
        const exit = tree.root.findByProps({ testID: 'sandbox-exit-button' });
        expect(reset.props.accessibilityLabel).toBe('Reset sample data');
        expect(exit.props.accessibilityLabel).toBe('Exit sandbox');
        expect(flattenStyle(reset.props.style)).toMatchObject({ minHeight: 44, minWidth: 44 });
        expect(flattenStyle(exit.props.style)).toMatchObject({ minHeight: 44, minWidth: 44 });
        expect(tree.root.findAllByType(TouchableOpacity)).toHaveLength(2);
        expect(tree.root.findAllByType(View).length).toBeGreaterThan(0);
    });

    it('keeps Reset and Exit wired to their workspace reloads', () => {
        let tree!: ReturnType<typeof create>;
        act(() => { tree = create(<SandboxWorkspaceBanner />); });

        act(() => { tree.root.findByProps({ testID: 'sandbox-reset-button' }).props.onPress(); });
        expect(workspace.reloadIntoMobileSandbox).toHaveBeenCalledTimes(1);

        act(() => { tree.unmount(); });
        act(() => { tree = create(<SandboxWorkspaceBanner />); });
        act(() => { tree.root.findByProps({ testID: 'sandbox-exit-button' }).props.onPress(); });
        expect(workspace.reloadIntoPersonalWorkspace).toHaveBeenCalledTimes(1);
    });
});
