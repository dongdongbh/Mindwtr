import React from 'react';
import { Linking, Pressable, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextualHelp } from './ContextualHelp';
import { dismissMobileHint, isMobileHintDismissed } from '@/lib/onboarding-hints';

vi.mock('react-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native')>(),
    Linking: { openURL: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/onboarding-hints', () => ({
    dismissMobileHint: vi.fn().mockResolvedValue(undefined),
    isMobileHintDismissed: vi.fn().mockResolvedValue(false),
}));
const tc = { secondaryText: '#555', filterBg: '#eee', tint: '#06c', danger: '#b00' };
const t = (key: string) => key;

describe('ContextualHelp', () => {
    beforeEach(() => vi.clearAllMocks());
    it('shows contextual guidance, dismisses it, and permits reopening', async () => {
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<ContextualHelp topic="focus" t={t} tc={tc} autoReveal />); });
        const text = () => tree.root.findAllByType(Text).map((node) => node.props.children);
        expect(text()).toContain('onboarding.focusHint');
        act(() => tree.root.findAllByType(Pressable).find((node) => node.props.accessibilityLabel === 'common.dismiss')!.props.onPress());
        expect(dismissMobileHint).toHaveBeenCalledWith('focus');
        expect(text()).not.toContain('onboarding.focusHint');
        act(() => tree.root.findAllByType(Pressable)[0].props.onPress());
        expect(text()).toContain('onboarding.focusHint');
        act(() => tree.unmount());
    });
    it('does not reopen after a late storage read when someone has already closed it', async () => {
        let resolve!: (value: boolean) => void;
        vi.mocked(isMobileHintDismissed).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(<ContextualHelp topic="focus" t={t} tc={tc} autoReveal />); });
        act(() => tree.root.findAllByType(Pressable)[0].props.onPress());
        act(() => tree.root.findAllByType(Pressable)[0].props.onPress());
        await act(async () => resolve(false));
        expect(tree.root.findAllByType(Pressable)[0].props.accessibilityState.expanded).toBe(false);
        act(() => tree.unmount());
    });
    it('shows a retry message when opening documentation fails', async () => {
        vi.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('unavailable'));
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<ContextualHelp topic="scheduling" t={t} tc={tc} />); });
        act(() => tree.root.findAllByType(Pressable)[0].props.onPress());
        await act(async () => tree.root.findAllByType(Pressable).find((node) => node.props.accessibilityRole === 'link')!.props.onPress());
        expect(Linking.openURL).toHaveBeenCalledWith('https://docs.mindwtr.app/use/mobile#scheduling-tasks');
        expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'onboarding.guideError')).toBe(true);
        act(() => tree.unmount());
    });
    it('defaults to an icon-only editor control and resets on remount', async () => {
        let tree!: renderer.ReactTestRenderer;
        const mount = async () => {
            await act(async () => { tree = renderer.create(<ContextualHelp topic="details" t={t} tc={tc} />); });
        };
        await mount();
        expect(tree.root.findAllByType(Text)).toHaveLength(0);
        const help = tree.root.findAllByType(Pressable)[0];
        expect(help.props.accessibilityLabel).toBe('onboarding.help: taskEdit.details');
        expect(help.props.accessibilityState.expanded).toBe(false);
        act(() => help.props.onPress());
        expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'onboarding.detailsHint')).toBe(true);
        act(() => tree.unmount());
        await mount();
        expect(tree.root.findAllByType(Text)).toHaveLength(0);
        act(() => tree.unmount());
    });
});
