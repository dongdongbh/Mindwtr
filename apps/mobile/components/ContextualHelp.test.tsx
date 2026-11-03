import React from 'react';
import { Linking, Pressable, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextualHelpBody, ContextualHelpButton } from './ContextualHelp';

vi.mock('react-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native')>(),
    Linking: { openURL: vi.fn().mockResolvedValue(undefined) },
}));
let testLanguage = 'en';
vi.mock('@/contexts/language-context', () => ({
    useLanguage: () => ({ language: testLanguage }),
}));
const tc = { secondaryText: '#555', filterBg: '#eee', tint: '#06c', danger: '#b00' };
const t = (key: string) => key;
const openGuide = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Pressable)
    .find((node) => node.props.accessibilityRole === 'link')!.props.onPress();

describe('ContextualHelp', () => {
    beforeEach(() => { vi.clearAllMocks(); testLanguage = 'en'; });
    it('renders an icon-only button labelled with the topic', () => {
        const onPress = vi.fn();
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(<ContextualHelpButton topic="details" t={t} tc={tc} expanded={false} onPress={onPress} />); });
        expect(tree.root.findAllByType(Text)).toHaveLength(0);
        const help = tree.root.findByType(Pressable);
        expect(help.props.accessibilityLabel).toBe('onboarding.help: taskEdit.details');
        expect(help.props.accessibilityState.expanded).toBe(false);
        act(() => help.props.onPress());
        expect(onPress).toHaveBeenCalledTimes(1);
        act(() => tree.unmount());
    });
    it('shows a retry message when opening documentation fails', async () => {
        vi.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('unavailable'));
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(<ContextualHelpBody topic="scheduling" t={t} tc={tc} />); });
        expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'onboarding.schedulingHint')).toBe(true);
        await act(async () => openGuide(tree));
        expect(Linking.openURL).toHaveBeenCalledWith('https://docs.mindwtr.app/use/mobile#scheduling-tasks');
        expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'onboarding.guideError')).toBe(true);
        act(() => tree.unmount());
    });
    it('opens the current locale and corresponding section after a language switch', async () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(<ContextualHelpBody topic="inbox-project" t={t} tc={tc} />); });
        await act(async () => openGuide(tree));
        expect(Linking.openURL).toHaveBeenLastCalledWith('https://docs.mindwtr.app/use/mobile#processing-inbox');
        testLanguage = 'zh-Hant';
        act(() => tree.update(<ContextualHelpBody topic="scheduling" t={t} tc={tc} />));
        await act(async () => openGuide(tree));
        expect(Linking.openURL).toHaveBeenLastCalledWith(
            'https://docs.mindwtr.app/zh-Hant/use/mobile#%E6%8E%92%E7%A8%8B%E4%BB%BB%E5%8B%99',
        );
        act(() => tree.unmount());
    });
});
