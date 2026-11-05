import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { AppAnnouncementModal } from './app-announcement-modal';

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/contexts/language-context', () => ({
    useLanguage: () => ({ t: (key: string) => ({ 'common.notNow': 'Nicht jetzt', 'announcement.dismiss': 'Hinweis schließen' }[key] ?? key) }),
}));
vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({ cardBg: '#fff', border: '#ddd', tint: '#06c', text: '#111', secondaryText: '#555', onTint: '#fff' }),
}));
vi.mock('@/hooks/use-filled-button-colors', () => ({
    useFilledButtonColors: () => ({ background: '#06c', text: '#fff' }),
}));

describe('AppAnnouncementModal', () => {
    it('labels its close and default dismiss buttons in the app language', async () => {
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AppAnnouncementModal
                    announcement={{ id: 'update-reminder-1.3.8', title: 'T', body: 'B' }}
                    onAction={vi.fn()}
                    onDismiss={vi.fn()}
                    visible
                />,
            );
        });
        expect(tree.root.findAllByType(TouchableOpacity).map((node) => node.props.accessibilityLabel)).toContain('Hinweis schließen');
        expect(tree.root.findAllByType(Text).map((node) => node.props.children)).toContain('Nicht jetzt');
        act(() => tree.unmount());
    });
});
