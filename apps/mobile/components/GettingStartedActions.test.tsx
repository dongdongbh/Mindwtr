import React from 'react';
import { Linking, Pressable, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { getDocsGuideUrl } from '@mindwtr/core';
import { GettingStartedActions } from './GettingStartedActions';

vi.mock('@/contexts/language-context', () => ({
    useLanguage: () => ({ t: (key: string) => key, language: 'de' }),
}));
vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({ text: '#111', secondaryText: '#555', border: '#ddd', cardBg: '#fff', filterBg: '#eee', tint: '#2563eb' }),
}));
vi.mock('lucide-react-native', () => ({ ExternalLink: () => null, Inbox: () => null, Plus: () => null, Star: () => null }));
vi.mock('react-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native')>(),
    Linking: { openURL: vi.fn().mockResolvedValue(undefined) },
}));

describe('GettingStartedActions', () => {
    it('provides labelled, touch-sized actions for the real capture, Inbox, and Focus workflows', () => {
        const onAction = vi.fn();
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(<GettingStartedActions onAction={onAction} />); });
        const buttons = tree.root.findAllByType(Pressable).filter((node) => node.props.accessibilityRole === 'button');
        expect(buttons).toHaveLength(3);
        expect(buttons.map((button) => button.findByType(Text).props.children)).toEqual([
            'onboarding.captureAction', 'starter.processInbox.check1', 'starter.focus.check1',
        ]);
        for (const button of buttons) {
            expect(button.props.accessibilityRole).toBe('button');
            expect(Object.assign({}, ...button.props.style({ pressed: false })).minHeight).toBeGreaterThanOrEqual(44);
            act(() => button.props.onPress());
        }
        expect(onAction.mock.calls).toEqual([['capture'], ['inbox'], ['focus']]);
        act(() => tree.unmount());
    });


    it('links to the getting-started guide in the app language', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(<GettingStartedActions onAction={vi.fn()} />); });

        const link = tree.root.find((node) => node.props.accessibilityRole === 'link');
        expect(link.findByType(Text).props.children).toBe('onboarding.readGuide');

        act(() => link.props.onPress());
        expect(vi.mocked(Linking.openURL)).toHaveBeenCalledWith(
            getDocsGuideUrl('start/getting-started', 'de', 'basic-workflow'),
        );
        act(() => tree.unmount());
    });
});
