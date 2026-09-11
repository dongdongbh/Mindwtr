import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MenuItem, SettingsGuideLink } from './settings.shell';

const openURL = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        Linking: {
            ...(actual.Linking ?? {}),
            openURL,
        },
    };
});

vi.mock('lucide-react-native', async () => {
    const ReactModule = await vi.importActual<typeof import('react')>('react');
    const Icon = (props: Record<string, unknown>) => ReactModule.createElement('Icon', props);
    return {
        ChevronRight: Icon,
        ExternalLink: Icon,
    };
});

vi.mock('expo-router', () => ({
    useRouter: () => ({
        back: vi.fn(),
        canGoBack: () => false,
    }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({
        bg: '#0f172a',
        cardBg: '#111827',
        border: '#334155',
        text: '#f8fafc',
        secondaryText: '#94a3b8',
        tint: '#3b82f6',
    }),
}));

vi.mock('@/contexts/language-context', () => ({
    useLanguage: () => ({
        t: (key: string) => key,
    }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

describe('SettingsGuideLink', () => {
    it('opens the configured external guide URL', () => {
        let tree!: renderer.ReactTestRenderer;

        renderer.act(() => {
            tree = renderer.create(
                <SettingsGuideLink
                    title="Import guide"
                    description="Import setup details."
                    url="https://docs.mindwtr.app/import/"
                    testID="guide-link"
                />,
            );
        });

        renderer.act(() => {
            const link = tree.root.findAll((node) => (
                node.props.testID === 'guide-link' && typeof node.props.onPress === 'function'
            ))[0];
            link?.props.onPress();
        });

        expect(openURL).toHaveBeenCalledWith(
            'https://docs.mindwtr.app/import/',
        );
    });
});

describe('MenuItem', () => {
    it('exposes and visually reflects its disabled state', () => {
        let tree!: renderer.ReactTestRenderer;

        renderer.act(() => {
            tree = renderer.create(
                <MenuItem
                    disabled
                    onPress={vi.fn()}
                    title="Open sandbox"
                />,
            );
        });

        const button = tree.root.find((node) => node.props.accessibilityRole === 'button');
        expect(button.props.disabled).toBe(true);
        expect(button.props.accessibilityState).toEqual({ disabled: true });
        expect(button.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ opacity: 0.5 }),
        ]));
    });
});
