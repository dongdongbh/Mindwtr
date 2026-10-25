import React from 'react';
import { Pressable, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ContextualHelpButton } from '../ContextualHelp';
import { CollapsibleSection } from './CollapsibleSection';

vi.mock('react-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native')>(),
    LayoutAnimation: { configureNext: vi.fn(), Presets: {} },
}));
vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({ border: '#333', secondaryText: '#aaa', text: '#fff', tint: '#06c', onTint: '#fff', filterBg: '#222', danger: '#b00' }),
}));
vi.mock('@/contexts/language-context', () => ({
    useLanguage: () => ({ language: 'en' }),
}));

const t = (key: string) => key;
const texts = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Text).map((node) => node.props.children);

describe('CollapsibleSection', () => {
    it('puts the (?) in the header row right after the title, and opening it does not collapse the section (#1450)', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <CollapsibleSection title="Details" defaultExpanded help={{ topic: 'details', t }}>
                    <Text>field</Text>
                </CollapsibleSection>,
            );
        });
        const pressables = tree.root.findAllByType(Pressable);
        const toggle = pressables[0];
        const help = pressables[1];
        expect(toggle.props.accessibilityLabel).toBe('Details');
        expect(help.props.accessibilityLabel).toBe('onboarding.help: taskEdit.details');
        expect(help.props.hitSlop).toBe(12);
        // Same header row: the (?) is the title toggle's next sibling, not a line in the section body.
        const headerRow = toggle.parent!;
        const helpButton = tree.root.findByType(ContextualHelpButton);
        expect(helpButton.parent).toBe(headerRow);
        expect(headerRow.children.indexOf(helpButton)).toBe(headerRow.children.indexOf(toggle) + 1);

        act(() => help.props.onPress());

        expect(texts(tree)).toContain('onboarding.detailsHint');
        expect(texts(tree)).toContain('field');
        expect(toggle.props.accessibilityState.expanded).toBe(true);
        expect(help.props.accessibilityState.expanded).toBe(true);

        act(() => help.props.onPress());
        expect(texts(tree)).not.toContain('onboarding.detailsHint');
        act(() => tree.unmount());
    });

    it('still collapses from the header and renders no (?) without help', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <CollapsibleSection title="Organization" defaultExpanded>
                    <Text>field</Text>
                </CollapsibleSection>,
            );
        });
        expect(tree.root.findAll((node) => typeof node.props.accessibilityLabel === 'string'
            && node.props.accessibilityLabel.startsWith('onboarding.help'))).toHaveLength(0);

        act(() => tree.root.findAllByType(Pressable)[0].props.onPress());

        expect(texts(tree)).not.toContain('field');
        act(() => tree.unmount());
    });
});
